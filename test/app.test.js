import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const first = { id: 'b.1', title: 'first', cols: 120, rows: 30, windowNo: 1 };
const second = { id: 'b.2', title: 'second', cols: 80, rows: 24, windowNo: 1 };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function element() {
  const classes = new Set();
  return {
    textContent: '',
    className: '',
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ''; },
    children: [],
    listeners: new Map(),
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name)
    },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, callback) { this.listeners.set(name, callback); }
  };
}

async function createApp({ sessions = [first], bridges = 1, mobile, focusedId = null } = {}) {
  const elements = new Map();
  const sockets = [];
  const errors = [];
  const requests = [];
  let terminal;
  let confirmAnswer = true;

  class Terminal {
    constructor() {
      terminal = this;
      this.cols = 80;
      this.rows = 24;
      this.output = [];
      this.focusCalls = 0;
      this.scrolled = [];
      this.options = {};
      this.modes = { mouseTrackingMode: 'none' };
      this.screenBox = { offsetWidth: 0, offsetHeight: 0 };
      this.element = { querySelector: () => this.screenBox };
      this.buffer = { active: { cursorX: 0, cursorY: 0 } };
      this.parser = {
        csi: [],
        osc: new Map(),
        dcs: [],
        registerCsiHandler: (id, fn) => this.parser.csi.push({ id, fn }),
        registerOscHandler: (ident, fn) => this.parser.osc.set(ident, fn),
        registerDcsHandler: (id, fn) => this.parser.dcs.push({ id, fn })
      };
    }
    loadAddon() {}
    open() {}
    reset() { this.output = []; }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    scrollLines(n) { this.scrolled.push(n); }
    write(data, callback) { this.output.push(data); callback?.(); }
    focus() { this.focusCalls++; }
    onData(callback) { this.input = callback; }
  }

  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = Socket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = Socket.CLOSED; }
    emit(name, data) {
      if (name === 'open') this.readyState = Socket.OPEN;
      if (name === 'close') this.readyState = Socket.CLOSED;
      this[`on${name}`]?.(data);
    }
    receive(message) { this.emit('message', { data: JSON.stringify(message) }); }
    inputs() { return this.sent.map(s => JSON.parse(s)).filter(m => m.t === 'input').map(m => m.data); }
  }

  const listResponse = (list = sessions, count = bridges, focus = focusedId) => ({
    json: async () => ({ success: true, bridges: count, sessions: list, focusedId: focus })
  });
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
      addEventListener() {}
    },
    window: {
      Terminal,
      matchMedia: mobile === undefined ? undefined : (query) => ({ matches: mobile && /max-width/.test(query) }),
      addEventListener() {}
    },
    WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost:7891' },
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push([url, options?.method || 'GET']);
      return listResponse();
    },
    confirm: () => confirmAnswer,
    prompt: () => 'renamed',
    setInterval() {},
    setTimeout() {},
    alert(message) { assert.fail(message); }
  });

  vm.runInContext(source, context);
  await context.fetchSessions();

  const badge = elements.get('connection-badge');
  return {
    context,
    elements,
    sockets,
    terminal,
    errors,
    requests,
    badge,
    listResponse,
    setConfirm: value => { confirmAnswer = value; },
    snapshot: () => ({
      output: [...terminal.output],
      focusCalls: terminal.focusCalls,
      badge: [badge.className, badge.textContent],
      dimensions: elements.get('status-dim').textContent,
      sent: sockets.map(socket => [...socket.sent]),
      errors: [...errors]
    })
  };
}

const activeId = app => vm.runInContext('activeId', app.context);

test('the first session is selected and connected by session id, without sending a size', async () => {
  const app = await createApp();
  assert.equal(app.sockets.length, 1);
  const url = new URL(app.sockets[0].url);
  assert.equal(url.pathname, '/ws/terminal');
  assert.equal(url.searchParams.get('session'), first.id);
  assert.equal(url.searchParams.has('cols'), false);
  assert.equal(activeId(app), first.id);
});

test('creating a session connects before the session list refresh completes', { timeout: 1000 }, async () => {
  const app = await createApp();
  const oldSocket = app.sockets[0];
  oldSocket.emit('open');
  const refresh = deferred();
  const refreshStarted = deferred();
  app.context.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      assert.equal(url, '/api/sessions');
      return { json: async () => ({ success: true, session: second }) };
    }
    refreshStarted.resolve();
    return refresh.promise;
  };

  const creation = app.elements.get('btn-new-window').listeners.get('click')();
  await refreshStarted.promise;
  assert.equal(app.sockets.length, 2);
  assert.equal(oldSocket.readyState, 3);
  assert.equal(new URL(app.sockets[1].url).searchParams.get('session'), second.id);
  assert.match(app.badge.textContent, /连接中/);

  refresh.resolve(app.listResponse([first, second]));
  await creation;
  assert.equal(app.sockets.length, 2, 'refresh must not create another connection');
  assert.equal(activeId(app), second.id);
});

test('a refused creation is shown to the user and does not change the selection', async () => {
  const app = await createApp();
  const alerts = [];
  app.context.alert = message => alerts.push(message);
  app.context.fetch = async () => ({ json: async () => ({ success: false, error: 'No Tabby window is connected' }) });
  await app.elements.get('btn-new-window').listeners.get('click')();
  assert.match(alerts[0], /No Tabby window is connected/);
  assert.equal(activeId(app), first.id);
  assert.equal(app.sockets.length, 1);
});

for (const currentState of ['connecting', 'open']) {
  for (const staleEvent of ['open', 'message', 'close', 'error']) {
    test(`stale ${staleEvent} cannot affect a ${currentState} replacement`, async () => {
      const app = await createApp();
      const oldSocket = app.sockets[0];
      oldSocket.emit('open');
      app.context.connectToSession(second.id);
      const currentSocket = app.sockets[1];
      if (currentState === 'open') currentSocket.emit('open');
      const before = app.snapshot();

      oldSocket.emit(staleEvent, staleEvent === 'message'
        ? { data: JSON.stringify({ t: 'output', data: 'stale terminal output' }) }
        : new Error('stale socket error'));

      assert.deepEqual(app.snapshot(), before);
      assert.equal(vm.runInContext('currentSocket', app.context), currentSocket);
    });
  }
}

test('the old socket is invalidated before close can dispatch events', async () => {
  const app = await createApp();
  const oldSocket = app.sockets[0];
  oldSocket.emit('open');
  const before = app.snapshot();
  oldSocket.close = () => {
    for (const name of ['open', 'message', 'close', 'error']) {
      oldSocket.emit(name, { data: JSON.stringify({ t: 'output', data: 'stale output during close' }) });
    }
    assert.deepEqual(app.snapshot(), before);
  };

  app.context.connectToSession(second.id);
  assert.equal(app.sockets.length, 2);
  assert.match(app.badge.textContent, /连接中/);
});

test('a snapshot restores the screen at Tabby\'s size, then output and size changes follow', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  assert.equal(app.badge.className, 'badge badge-connected');
  assert.equal(app.terminal.focusCalls, 1);
  assert.deepEqual(socket.sent, [], 'the browser never tells Tabby what size to use');

  socket.receive({ t: 'output', data: 'too early' });
  socket.receive({ t: 'snapshot', data: 'SCREEN', cols: 120, rows: 30 });
  assert.deepEqual([app.terminal.cols, app.terminal.rows], [120, 30]);
  assert.deepEqual(app.terminal.output, ['SCREEN']);
  assert.equal(app.elements.get('status-dim').textContent, '尺寸: 120x30');

  socket.receive({ t: 'output', data: 'live' });
  assert.deepEqual(app.terminal.output, ['SCREEN', 'live']);

  socket.receive({ t: 'size', cols: 100, rows: 40 });
  assert.deepEqual([app.terminal.cols, app.terminal.rows], [100, 40]);
  assert.deepEqual(app.terminal.output, ['SCREEN', 'live'], 'a size change keeps the screen');

  socket.emit('message', { data: 'not json' });
  socket.receive({ t: 'size', cols: 'x', rows: -1 });
  assert.deepEqual([app.terminal.cols, app.terminal.rows], [100, 40]);
});

test('typing and the virtual keys are sent as JSON input', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  app.terminal.input('echo current\r');
  assert.deepEqual(socket.inputs(), ['echo current\r']);

  app.elements.get('btn-toggle-accessory');
  const bar = app.elements.get('terminal-accessory-bar');
  const press = key => bar.listeners.get('click')({ target: { getAttribute: () => key, id: '' } });
  press('ESC');
  press('CTRL_C');
  assert.deepEqual(socket.inputs(), ['echo current\r', '\x1b', '\x03']);
});

test('input is dropped while the socket is not open', async () => {
  const app = await createApp();
  app.terminal.input('lost');
  assert.deepEqual(app.sockets[0].sent, []);
});

test('socket errors and closes update the badge', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  socket.emit('error', new Error('current error'));
  assert.match(app.badge.textContent, /连接异常/);
  assert.equal(app.errors.length, 1);
  socket.emit('close');
  assert.match(app.badge.textContent, /已断开/);
});

test('with no Bridge connected the page says it is waiting for Tabby and drops the connection', async () => {
  const app = await createApp({ sessions: [], bridges: 0 });
  assert.equal(app.sockets.length, 0);
  assert.match(app.elements.get('empty-state').textContent, /等待 Tabby 连接/);
  assert.equal(app.elements.get('empty-state').classList.contains('hidden'), false);
});

test('when the Bridge disappears the tabs are cleared and the open connection is closed', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  app.context.fetch = async () => app.listResponse([], 0);
  await app.context.fetchSessions();
  assert.equal(socket.readyState, 3);
  assert.equal(activeId(app), null);
  assert.equal(app.elements.get('tabs-list').children.length, 0);
  assert.match(app.elements.get('empty-state').textContent, /等待 Tabby 连接/);

  app.context.fetch = async () => app.listResponse([first], 1);
  await app.context.fetchSessions();
  assert.equal(app.sockets.length, 2, 'reconnects on its own once Tabby is back');
  assert.equal(app.elements.get('empty-state').classList.contains('hidden'), true);
});

test('after a refresh the page selects the terminal that has focus in Tabby, not the first one', async () => {
  const app = await createApp({ sessions: [first, second], bridges: 1, focusedId: second.id });
  assert.equal(activeId(app), second.id);
});

test('switching the focused terminal in Tabby switches the page, once per change', async () => {
  const both = [first, second];
  const app = await createApp({ sessions: both, bridges: 1, focusedId: first.id });
  assert.equal(activeId(app), first.id);
  const socketsBefore = app.sockets.length;

  app.context.fetch = async () => app.listResponse(both, 1, second.id);
  await app.context.fetchSessions();
  assert.equal(activeId(app), second.id, 'followed Tabby');
  assert.equal(app.sockets.length, socketsBefore + 1, 'connected to the newly focused terminal');

  // the user picks the other tab in the page; Tabby focus has not changed, so the next poll leaves it alone
  vm.runInContext(`activeId = ${JSON.stringify(first.id)}`, app.context);
  await app.context.fetchSessions();
  assert.equal(activeId(app), first.id, 'a manual choice is not undone by polling');

  // Tabby focus moves again: follow it
  app.context.fetch = async () => app.listResponse(both, 1, first.id);
  await app.context.fetchSessions();
  app.context.fetch = async () => app.listResponse(both, 1, second.id);
  await app.context.fetchSessions();
  assert.equal(activeId(app), second.id);
});

test('without a focused terminal the page falls back to the first one', async () => {
  const app = await createApp({ sessions: [first, second], bridges: 1, focusedId: 'gone' });
  assert.equal(activeId(app), first.id);
});

test('a Bridge with no terminal tabs says so instead of waiting', async () => {
  const app = await createApp({ sessions: [], bridges: 1 });
  assert.match(app.elements.get('empty-state').textContent, /还没有终端标签页/);
});

test('tab titles carry the Tabby window only when more than one window is connected', async () => {
  const app = await createApp({ sessions: [first, { ...second, windowNo: 2 }], bridges: 2 });
  const labels = () => app.elements.get('tabs-list').children.map(tab => tab.children[0].textContent);
  assert.deepEqual(labels(), ['[W1] first', '[W2] second']);

  app.context.fetch = async () => app.listResponse([first], 1);
  await app.context.fetchSessions();
  assert.deepEqual(labels(), ['first']);
});

test('a dropped connection is retried with backoff instead of every second', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  socket.emit('close');

  await app.context.fetchSessions();
  assert.equal(app.sockets.length, 1, 'too soon to retry');

  vm.runInContext('nextReconnectAt = 0', app.context);
  await app.context.fetchSessions();
  assert.equal(app.sockets.length, 2);
});

test('closing a tab asks first, then deletes the session in Tabby', async () => {
  const app = await createApp({ sessions: [first, second] });
  app.setConfirm(false);
  await app.context.closeSession(first);
  assert.equal(app.requests.some(([, method]) => method === 'DELETE'), false);

  app.setConfirm(true);
  await app.context.closeSession(first);
  assert.ok(app.requests.some(([url, method]) => method === 'DELETE' && url === `/api/sessions/${encodeURIComponent(first.id)}`));
});

test('swiping scrolls the local history, or sends wheel events once a program asks for the mouse', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  const container = app.elements.get('terminal-container');
  const swipe = () => {
    container.listeners.get('touchstart')({ touches: [{ clientX: 10, clientY: 100 }] });
    container.listeners.get('touchmove')({ touches: [{ clientX: 10, clientY: 140 }] });
  };

  swipe();
  assert.deepEqual(app.terminal.scrolled, [-2]);
  assert.deepEqual(socket.inputs(), [], 'no duplicate wheel events when the history is scrolled locally');

  app.terminal.modes.mouseTrackingMode = 'any';
  swipe();
  assert.deepEqual(app.terminal.scrolled, [-2], 'local scrolling stops');
  assert.match(socket.inputs()[0], /^(\x1b\[<64;\d+;\d+M){2}$/);
});

test('terminal queries are swallowed in the page so only Tabby answers them', async () => {
  const app = await createApp();
  const { csi, osc, dcs } = app.terminal.parser;
  const swallowed = (final, prefix) => csi.some(h => h.id.final === final && h.id.prefix === prefix && h.fn() === true);
  assert.ok(swallowed('c', undefined), 'DA1');
  assert.ok(swallowed('c', '>'), 'DA2');
  assert.ok(swallowed('n', undefined), 'cursor position / status report');
  assert.ok(csi.some(h => h.id.final === 'p' && h.id.intermediates === '$'), 'DECRQM');
  assert.equal(dcs.length, 1, 'DECRQSS');

  assert.equal(osc.get(11)('?'), true, 'background colour query is swallowed');
  assert.equal(osc.get(4)('1;?'), true);
  assert.equal(osc.get(11)('rgb:11/11/1b'), false, 'setting a colour is left to xterm');
});

test('the font is a normal page size and is never shrunk to fit a big Tabby terminal', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  socket.receive({ t: 'snapshot', data: 'x', cols: 154, rows: 60 });
  assert.equal(app.terminal.options.fontSize, 14);
  socket.receive({ t: 'size', cols: 300, rows: 100 });
  assert.equal(app.terminal.options.fontSize, 14);
});

test('phones start with a smaller, still readable font', async () => {
  assert.equal((await createApp({ mobile: true })).terminal.options.fontSize ?? 12, 12);
  const phone = await createApp({ mobile: true });
  phone.sockets[0].receive({ t: 'snapshot', data: '', cols: 80, rows: 24 });
  assert.equal(phone.terminal.options.fontSize, 12);
  const desktop = await createApp({ mobile: false });
  desktop.sockets[0].receive({ t: 'snapshot', data: '', cols: 80, rows: 24 });
  assert.equal(desktop.terminal.options.fontSize, 14);
});

test('A- and A+ change the font within sensible limits', async () => {
  const app = await createApp();
  const click = id => app.elements.get(id).listeners.get('click')();
  click('btn-font-inc');
  assert.equal(app.terminal.options.fontSize, 15);
  for (let i = 0; i < 40; i++) click('btn-font-dec');
  assert.equal(app.terminal.options.fontSize, 8);
  for (let i = 0; i < 40; i++) click('btn-font-inc');
  assert.equal(app.terminal.options.fontSize, 26);
});

// 让假终端的像素尺寸随字号变化(宽 0.6em，高 1.15em 且取整)，像真的 xterm 那样
function fontAwareTerminal(app, cols, rows) {
  const term = app.terminal;
  term.cols = cols;
  term.rows = rows;
  let size = 14;
  term.screenBox = { offsetWidth: 0, offsetHeight: 0 }; // 同一个对象，像真实的 .xterm-screen 元素一样原地改尺寸
  const measure = () => {
    term.screenBox.offsetWidth = cols * Math.round(size * 0.6);
    term.screenBox.offsetHeight = rows * Math.ceil(size * 1.15);
  };
  measure();
  Object.defineProperty(term.options, 'fontSize', {
    get: () => size,
    set: (value) => { size = value; measure(); },
    configurable: true
  });
  return () => term.screenBox;
}

test('in full screen the font grows until the whole terminal fits, and goes back on exit', async () => {
  const app = await createApp({ mobile: false });
  const box = fontAwareTerminal(app, 154, 60);
  const wrapper = app.elements.get('terminal-wrapper');
  Object.assign(wrapper, { clientWidth: 1896, clientHeight: 1100 });
  const doc = app.context.document;

  doc.fullscreenElement = {};
  app.context.onFullscreenChange();
  const size = app.terminal.options.fontSize;
  assert.ok(size > 14, `expected a bigger font than the default, got ${size}`);
  assert.ok(box().offsetWidth <= 1896 && box().offsetHeight <= 1100, 'the whole terminal fits');
  app.terminal.options.fontSize = size + 1;
  assert.ok(box().offsetWidth > 1896 || box().offsetHeight > 1100, 'one size bigger would not fit');
  app.terminal.options.fontSize = size;

  // the window changes size while in full screen: refit (1040 still fits the base font's 1020px;
  // below that the font would have to shrink past the base size, which is not allowed)
  wrapper.clientHeight = 1040;
  app.context.handleResize();
  assert.ok(app.terminal.options.fontSize < size);
  assert.ok(box().offsetHeight <= 1040);

  doc.fullscreenElement = null;
  app.context.onFullscreenChange();
  assert.equal(app.terminal.options.fontSize, 14);
});

test('in full screen a terminal bigger than the screen keeps the normal font and scrolls, never shrinks', async () => {
  const app = await createApp({ mobile: false });
  fontAwareTerminal(app, 154, 60);
  Object.assign(app.elements.get('terminal-wrapper'), { clientWidth: 400, clientHeight: 300 });
  app.context.document.fullscreenElement = {};
  app.context.onFullscreenChange();
  assert.equal(app.terminal.options.fontSize, 14);
});

test('A+/A- in full screen starts from the fitted size and stops auto-fitting', async () => {
  const app = await createApp({ mobile: false });
  fontAwareTerminal(app, 154, 60);
  const wrapper = app.elements.get('terminal-wrapper');
  Object.assign(wrapper, { clientWidth: 1896, clientHeight: 1100 });
  app.context.document.fullscreenElement = {};
  app.context.onFullscreenChange();
  const fitted = app.terminal.options.fontSize;

  app.elements.get('btn-font-dec').listeners.get('click')();
  assert.equal(app.terminal.options.fontSize, fitted - 1);
  wrapper.clientHeight = 2000; // a resize no longer re-fits
  app.context.handleResize();
  assert.equal(app.terminal.options.fontSize, fitted - 1);
});

function pannableApp(app, { scrollHeight = 960, clientHeight = 300, clientWidth = 400, scrollWidth = 1232 } = {}) {
  const container = app.elements.get('terminal-container');
  Object.assign(container, { scrollTop: 0, scrollLeft: 0, scrollHeight, clientHeight, clientWidth, scrollWidth });
  return container;
}
const touch = (container, from, to) => {
  container.listeners.get('touchstart')({ touches: [{ clientX: from[0], clientY: from[1] }] });
  container.listeners.get('touchmove')({ touches: [{ clientX: to[0], clientY: to[1] }] });
};

test('dragging sideways pans a terminal that is wider than the screen', async () => {
  const app = await createApp();
  const container = pannableApp(app);
  touch(container, [200, 100], [120, 104]);
  assert.equal(container.scrollLeft, 80);
  assert.deepEqual(app.terminal.scrolled, [], 'history is not scrolled by a sideways drag');
});

test('dragging up and down pans a terminal taller than the screen before scrolling the history', async () => {
  const app = await createApp();
  const container = pannableApp(app);
  container.scrollTop = 100;

  touch(container, [50, 200], [50, 260]); // finger down 60px: reveal content above
  assert.equal(container.scrollTop, 40);
  assert.deepEqual(app.terminal.scrolled, []);

  touch(container, [50, 200], [50, 320]); // 120px down, only 40px left to pan, the rest scrolls history
  assert.equal(container.scrollTop, 0);
  assert.deepEqual(app.terminal.scrolled, [-5], '80px / 16 per line');
});

test('after a manual pan the page does not jump back to the cursor, typing makes it follow again', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  const container = pannableApp(app);
  app.terminal.screenBox = { offsetWidth: 154 * 8, offsetHeight: 60 * 16 };
  app.terminal.buffer.active.cursorY = 59;
  app.terminal.buffer.active.cursorX = 3;

  socket.receive({ t: 'snapshot', data: 'screen', cols: 154, rows: 60 });
  assert.equal(container.scrollTop, 60 * 16 - 300, 'the prompt line is brought into view');
  assert.equal(container.scrollLeft, 0);

  touch(container, [50, 100], [50, 130]);
  const panned = container.scrollTop;
  app.terminal.buffer.active.cursorY = 10;
  socket.receive({ t: 'output', data: 'more' });
  assert.equal(container.scrollTop, panned, 'reading position is kept for a few seconds');

  app.terminal.input('l');
  socket.receive({ t: 'output', data: 'l' });
  assert.equal(container.scrollTop, 10 * 16, 'follows the cursor again once the user types');
});

function terminalWithLines(app, { rows, cursorY, filledRows }) {
  // filledRows: how many rows from the top have text (a TUI with a status bar fills up to the last row)
  app.terminal.screenBox = { offsetWidth: 154 * 8, offsetHeight: rows * 16 };
  app.terminal.buffer.active = {
    cursorX: 3,
    cursorY,
    baseY: 0,
    getLine: row => ({ translateToString: () => (filledRows.includes(row) ? 'text' : '   ') })
  };
}

test('status lines below the prompt are scrolled into view, like in Tabby', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  const container = pannableApp(app, { scrollHeight: 960, clientHeight: 300 });
  // Claude Code style: prompt on row 56, three status rows below it (57-59)
  terminalWithLines(app, { rows: 60, cursorY: 56, filledRows: [0, 1, 2, 55, 56, 57, 58, 59] });

  socket.receive({ t: 'snapshot', data: 'screen', cols: 154, rows: 60 });
  assert.equal(container.scrollTop, 960 - 300, 'the last row (a status line) is visible, not just the prompt');
});

test('a short terminal is not scrolled down into its blank rows', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  const container = pannableApp(app, { scrollHeight: 960, clientHeight: 300 });
  terminalWithLines(app, { rows: 60, cursorY: 12, filledRows: [...Array(13).keys()] });

  socket.receive({ t: 'snapshot', data: 'screen', cols: 154, rows: 60 });
  assert.equal(container.scrollTop, 0, 'content ends at row 12, which already fits');
});

test('when the cursor and the last line cannot both fit, the cursor wins', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  const container = pannableApp(app, { scrollHeight: 960, clientHeight: 300 });
  terminalWithLines(app, { rows: 60, cursorY: 5, filledRows: [0, 5, 59] });

  socket.receive({ t: 'snapshot', data: 'screen', cols: 154, rows: 60 });
  assert.equal(container.scrollTop, 5 * 16, 'cursor row is at the top edge of the view');
});

test('a terminal only a character or two wider than the screen is not pushed sideways for the cursor', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  // 154 columns of 8px = 1232px in a 1224px wide view: 8px of overflow, cursor on the last column
  const container = pannableApp(app, { scrollWidth: 1232, clientWidth: 1224, scrollHeight: 300, clientHeight: 300 });
  container.scrollLeft = 8;
  terminalWithLines(app, { rows: 60, cursorY: 5, filledRows: [0, 5] });
  app.terminal.buffer.active.cursorX = 153;
  app.terminal.screenBox = { offsetWidth: 1232, offsetHeight: 300 };

  socket.receive({ t: 'snapshot', data: 'screen', cols: 154, rows: 60 });
  assert.equal(container.scrollLeft, 0, 'the first column stays visible');
});

test('a really wide terminal still follows the cursor sideways', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  const container = pannableApp(app, { scrollWidth: 1232, clientWidth: 400, scrollHeight: 300, clientHeight: 300 });
  terminalWithLines(app, { rows: 60, cursorY: 5, filledRows: [0, 5] });
  app.terminal.buffer.active.cursorX = 100;
  app.terminal.screenBox = { offsetWidth: 1232, offsetHeight: 300 };

  socket.receive({ t: 'snapshot', data: 'screen', cols: 154, rows: 60 });
  assert.equal(container.scrollLeft, 101 * 8 - 400, 'cursor column is brought into view');
});
