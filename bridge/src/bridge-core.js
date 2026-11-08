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

class BridgeCore {
  /**
   * @param {object} options
   * @param {function} options.WebSocketImpl      WebSocket constructor
   * @param {function} options.getServerUrl       returns e.g. "ws://localhost:7890"
   * @param {function} options.openDefaultTab     opens a tab with Tabby's default profile
   * @param {string}   options.bridgeId           unique per Tabby window / page load
   * @param {object}   [options.focusTarget]      object with addEventListener('focus'), usually `window`
   * @param {function} [options.hasFocus]
   */
  constructor({
    WebSocketImpl,
    getServerUrl,
    openDefaultTab,
    bridgeId,
    version = 'unknown',
    focusTarget = null,
    hasFocus = () => false,
    log = () => {},
    syncIntervalMs = 1000,
    reconnectMinMs = 1000,
    reconnectMaxMs = 10000
  }) {
    this.WebSocketImpl = WebSocketImpl;
    this.getServerUrl = getServerUrl;
    this.openDefaultTab = openDefaultTab;
    this.bridgeId = bridgeId;
    this.version = version;
    this.focusTarget = focusTarget;
    this.hasFocus = hasFocus;
    this.log = log;
    this.syncIntervalMs = syncIntervalMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;

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
      entry.sub.unsubscribe();
      if (entry.focusSub) entry.focusSub.unsubscribe();
    }
    this.entries.clear();
  }

  // ------------------------------------------------------------ terminals

  attach(terminal) {
    if (this.entries.has(terminal)) return;
    const entry = { id: `${this.bridgeId}.${this.nextId++}`, terminal, seq: 0, watched: false, sub: null };
    entry.sub = terminal.output$.subscribe((data) => {
      entry.seq += 1;
      if (entry.watched) this.send({ type: 'output', id: entry.id, seq: entry.seq, data });
    });
    // Report focus changes right away instead of waiting for the next periodic sync.
    const focusedStream = terminal.focused$;
    if (focusedStream && typeof focusedStream.subscribe === 'function') {
      entry.focusSub = focusedStream.subscribe(() => this.sync());
    }
    this.entries.set(terminal, entry);
    this.sync();
  }

  detach(terminal) {
    const entry = this.entries.get(terminal);
    if (!entry) return;
    entry.sub.unsubscribe();
    if (entry.focusSub) entry.focusSub.unsubscribe();
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
    return {
      id: entry.id,
      title: terminal.customTitle || terminal.title || 'Terminal',
      cols: (terminal.size && terminal.size.columns) || 80,
      rows: (terminal.size && terminal.size.rows) || 24,
      // Tabby keeps `hasFocus` true only on the pane that has focus in the window's active tab.
      focused: !!terminal.hasFocus
    };
  }

  /** Reports the session list when it changed since the last report. */
  sync() {
    if (!this.isOpen()) return;
    const sessions = [...this.entries.values()].map((entry) => this.sessionInfo(entry));
    const json = JSON.stringify(sessions);
    if (json === this.lastSessionsJson) return;
    this.lastSessionsJson = json;
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
      this.send({ type: 'hello', protocol: 1, bridgeId: this.bridgeId, version: this.version });
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
      for (const entry of this.entries.values()) entry.watched = false;
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
        if (entry) entry.watched = !!msg.on;
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

  requireEntry(id) {
    const entry = this.entryById(id);
    if (!entry) throw new Error('No such session');
    return entry;
  }

  async reply(reqId, action) {
    try {
      await action();
      this.send({ type: 'result', reqId, ok: true });
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
  serializeFrontend(frontend) {
    if (!frontend) return '';
    const addon = frontend.serializeAddon;
    if (addon && typeof addon.serialize === 'function') {
      try {
        const full = addon.serialize({ scrollback: SNAPSHOT_SCROLLBACK });
        if (typeof full === 'string') return full;
      } catch (err) {
        this.log('serialize with alt screen failed, falling back to saveState', err);
      }
    }
    const state = typeof frontend.saveState === 'function' ? frontend.saveState() : '';
    return typeof state === 'string' ? state : '';
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
    let data = '';
    try {
      data = this.serializeFrontend(terminal.frontend);
    } catch (err) {
      this.log('snapshot failed', err);
    }
    const info = this.sessionInfo(entry);
    this.send({ type: 'snapshot', id, reqId, seq, data, cols: info.cols, rows: info.rows });
  }
}

module.exports = { BridgeCore };
