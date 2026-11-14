import { randomUUID } from 'node:crypto';

const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_DIMENSION = 1000;
const ORIGINS = new Set(['Windows', 'WSL']);

/** Only the two systems this app distinguishes. Anything else, including a missing field, is "not reported". */
export function normalizeOrigin(value) {
  return ORIGINS.has(value) ? value : '';
}

export class HubError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const clampDimension = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION ? n : fallback;
};

/**
 * Keeps track of Bridges (one per Tabby window) and the Bridged Sessions they report,
 * and fans a session's output out to the browsers that are watching it.
 *
 * It never touches sockets directly: callers pass a "channel" with
 * `send(string)`, `bufferedAmount()` and `close(code, reason)`.
 */
export class SessionHub {
  constructor({
    now = Date.now,
    snapshotTimeoutMs = 3000,
    commandTimeoutMs = 5000,
    newSessionTimeoutMs = 3000,
    viewerBufferLimit = 512 * 1024,
    viewerSendLimit = 1024 * 1024,
    log = () => {}
  } = {}) {
    this.now = now;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.newSessionTimeoutMs = newSessionTimeoutMs;
    this.viewerBufferLimit = viewerBufferLimit;
    this.viewerSendLimit = viewerSendLimit;
    this.log = log;
    this.bridges = new Map();
    this.sessions = new Map();
    this.nextBridgeNo = 1;
  }

  // ---------------------------------------------------------------- bridges

  /** Returns a handle for one Bridge connection; the Bridge registers itself with a `hello` message. */
  addBridge(channel) {
    let bridge = null;
    return {
      onMessage: (raw) => {
        const msg = parseJson(raw);
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'hello') {
          if (bridge) return;
          if (typeof msg.bridgeId !== 'string' || !msg.bridgeId) return;
          bridge = this.#registerBridge(
            channel,
            msg.bridgeId,
            typeof msg.version === 'string' ? msg.version.slice(0, 40) : 'unknown',
            normalizeOrigin(msg.origin)
          );
          return;
        }
        if (bridge) this.#onBridgeMessage(bridge, msg);
      },
      onClose: () => {
        if (bridge) this.#dropBridge(bridge, channel);
      }
    };
  }

  #registerBridge(channel, id, version, origin) {
    const existing = this.bridges.get(id);
    if (existing) {
      this.#dropBridge(existing, existing.channel);
      try { existing.channel.close(4409, 'replaced by a newer connection'); } catch {}
    }
    const bridge = {
      id,
      no: this.nextBridgeNo++,
      version,
      origin,
      channel,
      focusedAt: this.now(),
      sessionIds: [],
      commands: new Map(),
      newSessionWaiters: new Set()
    };
    this.bridges.set(id, bridge);
    this.log(`[bridge] W${bridge.no} connected (${id}) version ${version} origin ${origin || 'unknown'}`);
    return bridge;
  }

  #dropBridge(bridge, channel) {
    if (this.bridges.get(bridge.id) !== bridge || bridge.channel !== channel) return;
    this.bridges.delete(bridge.id);
    for (const id of [...bridge.sessionIds]) this.#removeSession(id, 'bridge disconnected');
    for (const cmd of bridge.commands.values()) {
      clearTimeout(cmd.timer);
      cmd.reject(new HubError('Bridge disconnected', 503));
    }
    bridge.commands.clear();
    for (const waiter of bridge.newSessionWaiters) waiter.resolve(null);
    bridge.newSessionWaiters.clear();
    this.log(`[bridge] W${bridge.no} disconnected`);
  }

  #onBridgeMessage(bridge, msg) {
    switch (msg.type) {
      case 'focus':
        bridge.focusedAt = this.now();
        break;
      case 'sessions':
        this.#syncSessions(bridge, msg.sessions);
        break;
      case 'output': {
        const session = this.#ownedSession(bridge, msg.id);
        if (session && typeof msg.data === 'string') {
          this.#deliverOutput(session, Number(msg.seq) || 0, msg.data);
        }
        break;
      }
      case 'snapshot': {
        const session = this.#ownedSession(bridge, msg.id);
        if (session) this.#onSnapshot(session, msg);
        break;
      }
      case 'result': {
        const cmd = bridge.commands.get(msg.reqId);
        if (cmd) {
          bridge.commands.delete(msg.reqId);
          clearTimeout(cmd.timer);
          cmd.resolve(msg);
        }
        break;
      }
      default:
        break;
    }
  }

  #ownedSession(bridge, id) {
    const session = this.sessions.get(id);
    return session && session.bridge === bridge ? session : null;
  }

  // --------------------------------------------------------------- sessions

  #syncSessions(bridge, list) {
    if (!Array.isArray(list)) return;
    const seen = [];
    list.forEach((item, order) => {
      if (!item || typeof item.id !== 'string' || !item.id) return;
      const existing = this.sessions.get(item.id);
      if (existing && existing.bridge !== bridge) return; // ids are unique per Bridge
      const title = String(item.title ?? '').slice(0, MAX_TITLE_LENGTH);
      // The environment is the system the terminal itself runs in, which is not the same thing
      // as the Bridge's origin (the system Tabby runs on).
      const environment = item.environment === 'WSL' ? 'WSL' : item.environment === 'Windows' ? 'Windows' : '';
      if (existing) {
        const cols = clampDimension(item.cols, existing.cols);
        const rows = clampDimension(item.rows, existing.rows);
        const resized = cols !== existing.cols || rows !== existing.rows;
        Object.assign(existing, { title, cols, rows, order, environment, focused: item.focused === true });
        if (resized) {
          for (const viewer of existing.viewers) {
            if (!viewer.pending) sendJson(viewer.channel, { t: 'size', cols, rows });
          }
        }
      } else {
        this.sessions.set(item.id, {
          id: item.id,
          bridge,
          title,
          cols: clampDimension(item.cols, 80),
          rows: clampDimension(item.rows, 24),
          order,
          environment,
          focused: item.focused === true,
          viewers: new Set()
        });
        for (const waiter of bridge.newSessionWaiters) waiter.resolve(item.id);
        bridge.newSessionWaiters.clear();
      }
      seen.push(item.id);
    });
    const keep = new Set(seen);
    for (const id of [...bridge.sessionIds]) {
      if (!keep.has(id)) this.#removeSession(id, 'session closed');
    }
    bridge.sessionIds = seen;
  }

  #removeSession(id, reason) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const viewer of [...session.viewers]) {
      clearTimeout(viewer.snapshotTimer);
      sendJson(viewer.channel, { t: 'closed' });
      try { viewer.channel.close(4410, reason); } catch {}
    }
    session.viewers.clear();
    session.bridge.sessionIds = session.bridge.sessionIds.filter((x) => x !== id);
  }

  /** Snapshot of everything the browser needs to draw its tab bar. */
  list() {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => a.bridge.no - b.bridge.no || a.order - b.order)
      .map((s) => ({ id: s.id, title: s.title, cols: s.cols, rows: s.rows, windowNo: s.bridge.no, origin: s.bridge.origin, environment: s.environment }));
    const origins = new Set([...this.bridges.values()].map((b) => b.origin));
    return { bridges: this.bridges.size, sessions, focusedId: this.#focusedSessionId(), showOrigin: origins.size > 1 };
  }

  /** The session that has focus in the Tabby window focused most recently, or null if none reports focus. */
  #focusedSessionId() {
    const bridges = [...this.bridges.values()].sort((a, b) => b.focusedAt - a.focusedAt);
    for (const bridge of bridges) {
      const id = bridge.sessionIds.find((sid) => this.sessions.get(sid)?.focused);
      if (id) return id;
    }
    return null;
  }

  // ---------------------------------------------------------------- viewers

  /** Returns a handle for one browser connection, or null (after closing the channel) if the session is unknown. */
  addViewer(sessionId, channel) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      try { channel.close(4404, 'no such session'); } catch {}
      return null;
    }
    const viewer = { channel, pending: true, buffer: [], bufferBytes: 0, reqId: null, snapshotTimer: null };
    session.viewers.add(viewer);
    if (session.viewers.size === 1) this.#sendToBridge(session.bridge, { type: 'watch', id: session.id, on: true });
    this.#requestSnapshot(session, viewer);
    return {
      onMessage: (raw) => {
        const msg = parseJson(raw);
        if (msg && msg.t === 'input' && typeof msg.data === 'string' && msg.data.length <= MAX_INPUT_LENGTH) {
          this.#sendToBridge(session.bridge, { type: 'input', id: session.id, data: msg.data });
        } else if (msg && msg.t === 'resize') {
          // The page fills its screen at a normal font size, so the pane takes the browser's size while
          // someone is watching. With several browsers the last one to report wins.
          const cols = clampDimension(msg.cols, 0);
          const rows = clampDimension(msg.rows, 0);
          if (cols && rows && this.sessions.get(session.id) === session) {
            this.#sendToBridge(session.bridge, { type: 'resize', id: session.id, cols, rows });
          }
        }
      },
      onClose: () => this.#removeViewer(session, viewer)
    };
  }

  #removeViewer(session, viewer) {
    clearTimeout(viewer.snapshotTimer);
    if (!session.viewers.delete(viewer)) return;
    if (session.viewers.size === 0 && this.sessions.get(session.id) === session) {
      this.#sendToBridge(session.bridge, { type: 'watch', id: session.id, on: false });
    }
  }

  #requestSnapshot(session, viewer) {
    viewer.pending = true;
    viewer.reqId = randomUUID();
    clearTimeout(viewer.snapshotTimer);
    // If the Bridge never answers, fall back to live output only instead of freezing the tab.
    viewer.snapshotTimer = setTimeout(() => {
      this.#finishSnapshot(viewer, { data: '', seq: -1, cols: session.cols, rows: session.rows });
    }, this.snapshotTimeoutMs);
    this.#sendToBridge(session.bridge, { type: 'snapshot-request', id: session.id, reqId: viewer.reqId });
  }

  #onSnapshot(session, msg) {
    for (const viewer of session.viewers) {
      if (viewer.pending && viewer.reqId === msg.reqId) {
        clearTimeout(viewer.snapshotTimer);
        session.cols = clampDimension(msg.cols, session.cols);
        session.rows = clampDimension(msg.rows, session.rows);
        this.#finishSnapshot(viewer, {
          data: typeof msg.data === 'string' ? msg.data : '',
          seq: Number(msg.seq) || 0,
          cols: session.cols,
          rows: session.rows
        });
        return;
      }
    }
  }

  #finishSnapshot(viewer, { data, seq, cols, rows }) {
    clearTimeout(viewer.snapshotTimer);
    sendJson(viewer.channel, { t: 'snapshot', data, cols, rows });
    for (const entry of viewer.buffer) {
      if (entry.seq > seq) sendJson(viewer.channel, { t: 'output', data: entry.data });
    }
    viewer.buffer = [];
    viewer.bufferBytes = 0;
    viewer.pending = false;
  }

  #deliverOutput(session, seq, data) {
    for (const viewer of session.viewers) {
      if (viewer.pending) {
        viewer.buffer.push({ seq, data });
        viewer.bufferBytes += data.length;
        if (viewer.bufferBytes > this.viewerBufferLimit) {
          // Too much piled up while waiting: start over from a fresh snapshot.
          viewer.buffer = [];
          viewer.bufferBytes = 0;
          this.#requestSnapshot(session, viewer);
        }
      } else if (viewer.channel.bufferedAmount() > this.viewerSendLimit) {
        // Slow browser: drop what it has not received and let a new snapshot catch it up.
        this.#requestSnapshot(session, viewer);
      } else {
        sendJson(viewer.channel, { t: 'output', data });
      }
    }
  }

  // --------------------------------------------------------------- commands

  /**
   * Opens a new tab in the Tabby window that was focused most recently.
   *
   * `environment` picks what the new terminal runs: 'Windows' for a plain Windows shell,
   * 'WSL' for a wsl.exe pane. `cwd` is the working directory to start it in, in the flavour of
   * the chosen environment (a Windows path for 'Windows', a Linux path for 'WSL').
   */
  async createSession({ environment = 'Windows', cwd = '' } = {}) {
    const bridge = [...this.bridges.values()].sort((a, b) => b.focusedAt - a.focusedAt)[0];
    if (!bridge) throw new HubError('No Tabby window is connected', 503);
    const waiter = this.#waitForNewSession(bridge);
    const command = { type: 'create-in', environment, cwd };
    try {
      await this.#runCommand(bridge, command);
    } catch (err) {
      waiter.cancel();
      throw err;
    }
    const id = await waiter.promise;
    const session = id ? this.sessions.get(id) : null;
    return session
      ? { id: session.id, title: session.title, cols: session.cols, rows: session.rows, windowNo: bridge.no, environment: session.environment }
      : null;
  }

  /**
   * Lists a directory for the page's directory picker. The Bridge does the reading: it runs
   * inside Tabby and is the only side that can see WSL directories.
   */
  async listDirectory(path) {
    const bridge = [...this.bridges.values()].sort((a, b) => b.focusedAt - a.focusedAt)[0];
    if (!bridge) throw new HubError('No Tabby window is connected', 503);
    const result = await this.#runCommand(bridge, { type: 'list-dirs', path });
    return result.result || null;
  }

  /**
   * Checks whether a remembered directory still exists. A directory can be deleted after the page
   * remembered it, and a shell started in a missing directory would quietly land somewhere else.
   */
  async checkDirectory(path) {
    const bridge = [...this.bridges.values()].sort((a, b) => b.focusedAt - a.focusedAt)[0];
    if (!bridge) throw new HubError('No Tabby window is connected', 503);
    const result = await this.#runCommand(bridge, { type: 'check-dir', path });
    return !!(result.result && result.result.exists);
  }

  #waitForNewSession(bridge) {
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    const waiter = { resolve: (id) => { clearTimeout(timer); bridge.newSessionWaiters.delete(waiter); resolveFn(id); } };
    const timer = setTimeout(() => waiter.resolve(null), this.newSessionTimeoutMs);
    bridge.newSessionWaiters.add(waiter);
    return { promise, cancel: () => waiter.resolve(null) };
  }

  async renameSession(id, name) {
    const title = typeof name === 'string' ? name.trim().slice(0, MAX_TITLE_LENGTH) : '';
    if (!title) throw new HubError('name required', 400);
    const session = this.#requireSession(id);
    await this.#runCommand(session.bridge, { type: 'rename', id, name: title });
  }

  async closeSession(id) {
    const session = this.#requireSession(id);
    await this.#runCommand(session.bridge, { type: 'close', id });
  }

  #requireSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new HubError('No such session', 404);
    return session;
  }

  #runCommand(bridge, command) {
    return new Promise((resolve, reject) => {
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        bridge.commands.delete(reqId);
        reject(new HubError('Tabby did not respond in time', 504));
      }, this.commandTimeoutMs);
      bridge.commands.set(reqId, {
        timer,
        reject,
        resolve: (result) => (result.ok
          ? resolve(result)
          : reject(new HubError(result.error || 'Tabby refused the request', 502)))
      });
      this.#sendToBridge(bridge, { ...command, reqId });
    });
  }

  #sendToBridge(bridge, message) {
    sendJson(bridge.channel, message);
  }
}

function parseJson(raw) {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function sendJson(channel, message) {
  try {
    channel.send(JSON.stringify(message));
  } catch {
    // The socket is going away; its close handler cleans up.
  }
}
