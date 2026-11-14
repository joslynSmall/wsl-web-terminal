'use strict';

/**
 * The Bridge's logic, independent of Tabby's classes so it can be tested with fakes.
 *
 * It keeps one websocket open to the web server and reports every terminal pane it is
 * handed (see `attach`) as a Bridged Session. Output is only forwarded while a browser is
 * watching that session, and every output chunk carries a per-session sequence number so the
 * server can line a screen snapshot up with the output that follows it.
 */

const OPEN = 1;
const SNAPSHOT_SCROLLBACK = 1000;
const MIN_COLS = 20;
const MIN_ROWS = 5;
const MAX_DIMENSION = 1000;

function isZeroWidthCodePoint(cp) {
  return cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff
    || (cp >= 0x0300 && cp <= 0x036f)
    || (cp >= 0x1ab0 && cp <= 0x1aff)
    || (cp >= 0x1dc0 && cp <= 0x1dff)
    || (cp >= 0x20d0 && cp <= 0x20ff)
    || (cp >= 0xfe00 && cp <= 0xfe0f)
    || (cp >= 0xfe20 && cp <= 0xfe2f)
    || (cp >= 0xe0100 && cp <= 0xe01ef);
}

function isWideCodePoint(cp) {
  return cp >= 0x1100 && (
    cp <= 0x115f
    || cp === 0x2329 || cp === 0x232a
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe19)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function clipLineToCols(line, maxCols) {
  let out = '';
  let col = 0;
  let clipped = false;
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      const rest = line.slice(i);
      const match = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]*[@-~])/.exec(rest);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const cp = line.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp < 0x20 || cp === 0x7f) {
      out += ch;
      continue;
    }
    if (isZeroWidthCodePoint(cp)) {
      if (!clipped) out += ch;
      continue;
    }
    const w = isWideCodePoint(cp) ? 2 : 1;
    if (!clipped && col + w <= maxCols) {
      out += ch;
      col += w;
    } else {
      clipped = true;
    }
  }
  return out;
}

/**
 * xterm.js keeps BufferLine.length from the widest earlier width after shrinking cols, and
 * SerializeAddon dumps up to line.length on rows 0..rows-2. Clipping alternate-screen rows to
 * current `cols` prevents wide off-screen ghost columns from wrapping when replayed on a phone.
 */
function clipAltScreenToCols(data, maxCols) {
  if (typeof data !== 'string' || !(maxCols > 0)) return data;
  const marker = '\x1b[?1049h';
  const idx = data.lastIndexOf(marker);
  if (idx === -1) return data;
  const prefix = data.slice(0, idx);
  const alt = data.slice(idx);
  return prefix + alt.split('\r\n').map((line) => clipLineToCols(line, maxCols)).join('\r\n');
}

class BridgeCore {
  /**
   * @param {object} options
   * @param {function} options.WebSocketImpl      WebSocket constructor
   * @param {function} options.getServerUrl       returns e.g. "ws://localhost:7890"
   * @param {function} options.openDefaultTab     opens a tab with Tabby's default profile
   * @param {string}   options.bridgeId           unique per Tabby window / page load
   * @param {string}   [options.origin]           system this Bridge runs on: "Windows" or "WSL"
   * @param {object}   [options.focusTarget]      object with addEventListener('focus'), usually `window`
   * @param {function} [options.hasFocus]
   */
  constructor({
    WebSocketImpl,
    getServerUrl,
    openDefaultTab,
    bridgeId,
    version = 'unknown',
    origin = '',
    focusTarget = null,
    hasFocus = () => false,
    log = () => {},
    syncIntervalMs = 1000,
    reconnectMinMs = 1000,
    reconnectMaxMs = 10000,
    releaseDelayMs = 250,
    openTabForRequest = null,
    listDirectories = null,
    directoryExists = null,
    environmentOf = null
  }) {
    this.WebSocketImpl = WebSocketImpl;
    this.getServerUrl = getServerUrl;
    this.openDefaultTab = openDefaultTab;
    this.bridgeId = bridgeId;
    this.version = version;
    this.origin = origin === 'Windows' || origin === 'WSL' ? origin : '';
    this.focusTarget = focusTarget;
    this.hasFocus = hasFocus;
    this.log = log;
    this.syncIntervalMs = syncIntervalMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.releaseDelayMs = releaseDelayMs;
    // Opening a tab with a chosen environment and working directory, and listing directories
    // for the page's picker. Both are optional: without them the commands are refused.
    this.openTabForRequest = openTabForRequest;
    this.listDirectories = listDirectories;
    this.directoryExists = directoryExists;
    this.environmentOf = environmentOf;

    this.entries = new Map();
    this.nextId = 1;
    this.ws = null;
    this.started = false;
    this.lastSessionsJson = null;
    this.reconnectDelay = reconnectMinMs;
    this.reconnectTimer = null;
    this.syncTimer = null;
    this.onFocus = () => this.send({ type: 'focus' });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.syncTimer = setInterval(() => this.sync(), this.syncIntervalMs);
    if (this.focusTarget) this.focusTarget.addEventListener('focus', this.onFocus);
    this.connect();
  }

  stop() {
    this.started = false;
    clearInterval(this.syncTimer);
    clearTimeout(this.reconnectTimer);
    if (this.focusTarget) this.focusTarget.removeEventListener('focus', this.onFocus);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
    }
    for (const entry of this.entries.values()) {
      this.cancelPendingRelease(entry);
      entry.sub.unsubscribe();
      if (entry.focusSub) entry.focusSub.unsubscribe();
      if (entry.resizeSub) entry.resizeSub.unsubscribe();
    }
    this.entries.clear();
  }

  // ------------------------------------------------------------ terminals

  attach(terminal) {
    if (this.entries.has(terminal)) return;
    const entry = {
      id: `${this.bridgeId}.${this.nextId++}`,
      terminal,
      seq: 0,
      watched: false,
      viewerSized: false,
      releaseTimer: null,
      lastCols: 0,
      lastRows: 0,
      sub: null,
      focusSub: null,
      resizeSub: null
    };
    entry.sub = terminal.output$.subscribe((data) => {
      entry.seq += 1;
      if (entry.watched) {
        // 保证浏览器总是先收到新尺寸，再收到该尺寸下的终端输出，避免新帧被旧尺寸 xterm 截断/折行
        const info = this.sessionInfo(entry);
        if (info.cols !== entry.lastCols || info.rows !== entry.lastRows) {
          this.sync();
        }
        this.send({ type: 'output', id: entry.id, seq: entry.seq, data });
      }
    });
    // Report focus changes right away instead of waiting for the next periodic sync.
    const focusedStream = terminal.focused$;
    if (focusedStream && typeof focusedStream.subscribe === 'function') {
      entry.focusSub = focusedStream.subscribe(() => this.sync());
    }
    const resizeStream = terminal.frontend && terminal.frontend.resize$;
    if (resizeStream && typeof resizeStream.subscribe === 'function') {
      entry.resizeSub = resizeStream.subscribe(() => this.sync());
    }
    this.entries.set(terminal, entry);
    this.sync();
  }

  detach(terminal) {
    const entry = this.entries.get(terminal);
    if (!entry) return;
    this.cancelPendingRelease(entry);
    entry.sub.unsubscribe();
    if (entry.focusSub) entry.focusSub.unsubscribe();
    if (entry.resizeSub) entry.resizeSub.unsubscribe();
    this.entries.delete(terminal);
    this.sync();
  }

  entryById(id) {
    for (const entry of this.entries.values()) {
      if (entry.id === id) return entry;
    }
    return null;
  }

  sessionInfo(entry) {
    const terminal = entry.terminal;
    // Tabby 通过 auditTime(100) 延迟更新 terminal.size，因此优先读取实时更新的 frontend.xterm 尺寸
    const xterm = terminal.frontend && terminal.frontend.xterm;
    const cols = (xterm && xterm.cols > 0 ? xterm.cols : 0) || (terminal.size && terminal.size.columns) || 80;
    const rows = (xterm && xterm.rows > 0 ? xterm.rows : 0) || (terminal.size && terminal.size.rows) || 24;
    return {
      id: entry.id,
      title: terminal.customTitle || terminal.title || 'Terminal',
      cols,
      rows,
      // 该终端实际跑在哪个系统，和桥接器所在系统是两个概念。
      environment: this.environmentOf ? this.environmentOf(terminal) : '',
      // Tabby keeps `hasFocus` true only on the pane that has focus in the window's active tab.
      focused: !!terminal.hasFocus
    };
  }

  /** Reports the session list when it changed since the last report. */
  sync() {
    if (!this.isOpen()) return;
    const entries = [...this.entries.values()];
    const sessions = entries.map((entry) => this.sessionInfo(entry));
    const json = JSON.stringify(sessions);
    if (json === this.lastSessionsJson) return;
    this.lastSessionsJson = json;
    entries.forEach((entry, i) => {
      entry.lastCols = sessions[i].cols;
      entry.lastRows = sessions[i].rows;
    });
    this.send({ type: 'sessions', sessions });
  }

  // ----------------------------------------------------------- connection

  isOpen() {
    return !!this.ws && this.ws.readyState === OPEN;
  }

  send(message) {
    if (!this.isOpen()) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      this.log('send failed', err);
    }
  }

  connect() {
    if (!this.started) return;
    const base = String(this.getServerUrl() || '').trim().replace(/\/+$/, '').replace(/^http/i, 'ws');
    if (!base) {
      this.scheduleReconnect();
      return;
    }
    let ws;
    try {
      ws = new this.WebSocketImpl(`${base}/ws/bridge`);
    } catch (err) {
      this.log('cannot create websocket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = this.reconnectMinMs;
      this.lastSessionsJson = null;
      this.send({ type: 'hello', protocol: 1, bridgeId: this.bridgeId, version: this.version, origin: this.origin });
      if (this.hasFocus()) this.send({ type: 'focus' });
      this.sync();
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) this.onMessage(event.data);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const entry of this.entries.values()) {
        entry.watched = false;
        this.cancelPendingRelease(entry);
        this.releaseSize(entry); // the server is gone, so no browser can be holding the size
      }
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (!this.started) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
  }

  // ------------------------------------------------------------- commands

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'watch': {
        const entry = this.entryById(msg.id);
        if (entry) {
          entry.watched = !!msg.on;
          // Delay handing the size back briefly so a browser refresh does not flash to Tabby's size
          // or queue an async Tabby resizeHandler() that fires after the refreshed page resizes.
          if (entry.watched) this.cancelPendingRelease(entry);
          else this.scheduleReleaseSize(entry);
        }
        break;
      }
      case 'resize': {
        const entry = this.entryById(msg.id);
        if (entry) this.resizeToViewer(entry, msg.cols, msg.rows);
        break;
      }
      case 'input': {
        const entry = this.entryById(msg.id);
        if (entry && typeof msg.data === 'string') entry.terminal.sendInput(msg.data);
        break;
      }
      case 'snapshot-request':
        this.sendSnapshot(msg.id, msg.reqId);
        break;
      case 'create':
        this.reply(msg.reqId, () => this.openDefaultTab());
        break;
      case 'create-in': {
        // 新建一个指定环境和工作目录的窗格（MIRROR-B12 / B13 / B14）
        const environment = msg.environment === 'WSL' ? 'WSL' : 'Windows';
        const cwd = typeof msg.cwd === 'string' ? msg.cwd.trim() : '';
        this.reply(msg.reqId, async () => {
          if (typeof this.openTabForRequest !== 'function') {
            throw new Error('This Bridge cannot open tabs with options');
          }
          await this.openTabForRequest({ environment, cwd });
        });
        break;
      }
      case 'list-dirs': {
        // 网页的目录选择器要列目录（MIRROR-B15 / B16）
        const dirPath = typeof msg.path === 'string' ? msg.path.trim() : '';
        this.reply(msg.reqId, async () => {
          if (typeof this.listDirectories !== 'function') {
            throw new Error('This Bridge cannot list directories');
          }
          return this.listDirectories(dirPath);
        });
        break;
      }
      case 'check-dir': {
        // 校验网页记住的最近目录是否还在（MIRROR-B19）
        const dirPath = typeof msg.path === 'string' ? msg.path.trim() : '';
        this.reply(msg.reqId, async () => {
          if (typeof this.directoryExists !== 'function') {
            throw new Error('This Bridge cannot check directories');
          }
          return { path: dirPath, exists: this.directoryExists(dirPath) };
        });
        break;
      }
      case 'rename':
        this.reply(msg.reqId, () => {
          const entry = this.requireEntry(msg.id);
          entry.terminal.setCustomTitle(String(msg.name));
          this.sync();
        });
        break;
      case 'close':
        this.reply(msg.reqId, () => {
          const entry = this.requireEntry(msg.id);
          entry.terminal.destroy();
          this.detach(entry.terminal);
        });
        break;
      default:
        break;
    }
  }

  cancelPendingRelease(entry) {
    if (entry && entry.releaseTimer) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
  }

  scheduleReleaseSize(entry) {
    if (!entry.viewerSized) return;
    if (!(this.releaseDelayMs > 0)) {
      this.releaseSize(entry);
      return;
    }
    this.cancelPendingRelease(entry);
    entry.releaseTimer = setTimeout(() => {
      entry.releaseTimer = null;
      if (!entry.watched) this.releaseSize(entry);
    }, this.releaseDelayMs);
    if (typeof entry.releaseTimer.unref === 'function') entry.releaseTimer.unref();
  }

  /**
   * While a browser is watching, the pane takes the browser's size so the page can fill the screen at
   * its normal font size. Resizing Tabby's own xterm is enough: Tabby forwards xterm's resize to the
   * shell (`frontend.resize$` -> `session.resize`), and snapshots are serialized from that xterm.
   * `frontend.xterm` is a private field; without it the request is ignored and the page scrolls instead.
   */
  resizeToViewer(entry, cols, rows) {
    const c = Number(cols);
    const r = Number(rows);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < MIN_COLS || r < MIN_ROWS || c > MAX_DIMENSION || r > MAX_DIMENSION) return;
    this.cancelPendingRelease(entry);
    const frontend = entry.terminal.frontend;
    // Tabby's resizeHandler() schedules setTimeout + requestAnimationFrame; cancel any pending one
    // from an earlier release so it does not fire later and overwrite the viewer's size.
    if (frontend) {
      if (frontend.resizeTimeout !== undefined) {
        clearTimeout(frontend.resizeTimeout);
        frontend.resizeTimeout = undefined;
      }
      if (frontend.resizeAnimationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frontend.resizeAnimationFrame);
        frontend.resizeAnimationFrame = undefined;
      }
      if ('resizePending' in frontend) frontend.resizePending = false;
    }
    const xterm = frontend && frontend.xterm;
    if (!xterm || typeof xterm.resize !== 'function') return;
    if (xterm.cols === c && xterm.rows === r) return;
    try {
      xterm.resize(c, r);
      entry.viewerSized = true;
    } catch (err) {
      this.log('resize to viewer size failed', err);
      return;
    }
    this.sync();
  }

  /** Hands the size back to Tabby: its own fit recomputes columns and rows from the pane's element. */
  releaseSize(entry) {
    this.cancelPendingRelease(entry);
    if (!entry.viewerSized) return;
    entry.viewerSized = false;
    const frontend = entry.terminal.frontend;
    try {
      if (frontend && typeof frontend.resizeHandler === 'function') frontend.resizeHandler();
      else if (frontend && frontend.fitAddon && typeof frontend.fitAddon.fit === 'function') frontend.fitAddon.fit();
    } catch (err) {
      this.log('handing the size back to Tabby failed', err);
    }
    this.sync();
  }

  requireEntry(id) {
    const entry = this.entryById(id);
    if (!entry) throw new Error('No such session');
    return entry;
  }

  async reply(reqId, action) {
    try {
      const result = await action();
      const message = { type: 'result', reqId, ok: true };
      if (result !== undefined && result !== null) message.result = result;
      this.send(message);
    } catch (err) {
      this.send({ type: 'result', reqId, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }

  /**
   * Tabby's own `saveState()` hard-codes `excludeAltBuffer: true`, so a full-screen program (Claude Code,
   * vim, htop…) would be missing from the snapshot and the browser would show the shell underneath it.
   * Its xterm serialize addon is a private field, so use it when present (alt screen and terminal modes
   * included) and fall back to `saveState()` otherwise.
   */
  serializeFrontend(frontend, cols = 0) {
    if (!frontend) return '';
    const maxCols = cols || (frontend.xterm && frontend.xterm.cols > 0 ? frontend.xterm.cols : 0);
    const addon = frontend.serializeAddon;
    if (addon && typeof addon.serialize === 'function') {
      try {
        const full = addon.serialize({ scrollback: SNAPSHOT_SCROLLBACK });
        if (typeof full === 'string') return clipAltScreenToCols(full, maxCols);
      } catch (err) {
        this.log('serialize with alt screen failed, falling back to saveState', err);
      }
    }
    const state = typeof frontend.saveState === 'function' ? frontend.saveState() : '';
    return typeof state === 'string' ? clipAltScreenToCols(state, maxCols) : '';
  }

  /**
   * `seq` is read before waiting for Tabby's write queue to drain: everything up to it is
   * guaranteed to be on screen, so the server only has to replay output numbered above it.
   * Output that lands during the wait may show up in both, which at worst repeats a chunk.
   */
  async sendSnapshot(id, reqId) {
    const entry = this.entryById(id);
    if (!entry) return;
    const seq = entry.seq;
    const terminal = entry.terminal;
    try {
      await terminal.write('');
    } catch { /* frontend not ready: fall through with whatever it has */ }
    const info = this.sessionInfo(entry);
    let data = '';
    try {
      data = this.serializeFrontend(terminal.frontend, info.cols);
    } catch (err) {
      this.log('snapshot failed', err);
    }
    this.send({ type: 'snapshot', id, reqId, seq, data, cols: info.cols, rows: info.rows });
  }
}

module.exports = { BridgeCore };
