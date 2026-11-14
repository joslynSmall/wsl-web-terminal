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
    style: {},
    set innerHTML(value) { this.children = []; this._html = value; },
    get innerHTML() { return this._html || ''; },
    children: [],
    listeners: new Map(),
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      }
    },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, callback) { this.listeners.set(name, callback); }
  };
}

async function createApp({ sessions = [first], bridges = 1, mobile, focusedId = null, showOrigin = false } = {}) {
  const elements = new Map();
  const sockets = [];
  const errors = [];
  const requests = [];
  const timers = [];
  let nextTimerId = 1;
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

  const listResponse = (list = sessions, count = bridges, focus = focusedId, originVisible = showOrigin) => ({
    json: async () => ({ success: true, bridges: count, sessions: list, focusedId: focus, showOrigin: originVisible })
  });
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
      visibilityState: 'visible',
      listeners: new Map(),
      addEventListener(name, callback) { this.listeners.set(name, callback); }
    },
    window: {
      Terminal,
      innerHeight: 844,
      visualViewport: {
        height: 844,
        listeners: new Map(),
        addEventListener(name, callback) { this.listeners.set(name, callback); }
      },
      matchMedia: mobile === undefined ? undefined : (query) => ({ matches: mobile && /max-width/.test(query) }),
      listeners: new Map(),
      scrollTo() {},
      addEventListener(name, callback) { this.listeners.set(name, callback); }
    },
    WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost:7891' },
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); }
    },
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push([url, options?.method || 'GET']);
      return listResponse();
    },
    confirm: () => confirmAnswer,
    prompt: () => 'renamed',
    setInterval() {},
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.push({ id, fn, delay, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find(item => item.id === id);
      if (t) t.cancelled = true;
    },
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
    timers,
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
const newTermState = app => vm.runInContext('newTerm', app.context);

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

  const creation = app.context.submitNewTerminal();
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

test('a refused creation is shown in the panel and does not change the selection', async () => {
  const app = await createApp();
  app.context.fetch = async () => ({ json: async () => ({ success: false, error: 'No Tabby window is connected' }) });
  app.elements.get('btn-new-window').listeners.get('click')();
  await app.context.submitNewTerminal();
  assert.equal(app.elements.get('new-terminal-panel').classList.contains('hidden'), false, 'the panel stays open');
  assert.equal(app.elements.get('new-term-browse-error').textContent, 'No Tabby window is connected');
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

test('MIRROR-B02 origin is shown only while the server says more than one origin is connected', async () => {
  const windows = { ...first, origin: 'Windows' };
  const wsl = { ...second, windowNo: 2, origin: 'WSL' };
  const app = await createApp({ sessions: [windows, wsl], bridges: 2, showOrigin: true });
  const labels = () => app.elements.get('tabs-list').children.map(tab => tab.children[0].textContent);
  assert.deepEqual(labels(), ['[Windows] [W1] first', '[WSL] [W2] second']);

  app.context.fetch = async () => app.listResponse([windows], 1, null, false);
  await app.context.fetchSessions();
  assert.deepEqual(labels(), ['first'], 'MIRROR-B04 the label goes away when only one origin remains');
});

test('MIRROR-B03 a session without an origin is labelled 未知 when origins are shown', async () => {  const app = await createApp({
    sessions: [{ ...first, origin: '' }, { ...second, windowNo: 2, origin: 'WSL' }],
    bridges: 2,
    showOrigin: true
  });
  const labels = () => app.elements.get('tabs-list').children.map(tab => tab.children[0].textContent);
  assert.deepEqual(labels(), ['[未知] [W1] first', '[WSL] [W2] second']);
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
    term.screenBox.offsetWidth = term.cols * Math.round(size * 0.6);
    term.screenBox.offsetHeight = term.rows * Math.ceil(size * 1.15);
  };
  measure();
  const resize = term.resize.bind(term);
  term.resize = (c, r) => { resize(c, r); measure(); };
  Object.defineProperty(term.options, 'fontSize', {
    get: () => size,
    set: (value) => { size = value; measure(); },
    configurable: true
  });
  return () => term.screenBox;
}

// 网页打开着的窗格按网页大小排版：字号保持正常，按单元格尺寸算出可视区放得下的行列，发给服务
function sizedApp(app, { cols = 140, rows = 44, width = 1600, height = 900 } = {}) {
  fontAwareTerminal(app, cols, rows);
  const container = app.elements.get('terminal-container');
  Object.assign(container, { clientWidth: width, clientHeight: height });
  const socket = app.sockets.at(-1);
  socket.emit('open');
  const resizes = () => socket.sent.map(s => JSON.parse(s)).filter(m => m.t === 'resize');
  return { container, socket, resizes };
}

test('MIRROR-B07 on connect the page asks Tabby for the size that fills it at the normal font', async () => {
  const app = await createApp({ mobile: false });
  const { socket, resizes } = sizedApp(app, { cols: 140, rows: 44, width: 1600, height: 900 });
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  // 14px font: cell 8 x 17 px -> 1600/8 = 200 columns, 900/17 = 52 rows
  assert.deepEqual(resizes(), [{ t: 'resize', cols: 200, rows: 52 }]);
  assert.equal(app.terminal.options.fontSize, 14, 'the font is never scaled to fit');
});

test('MIRROR-B07 a phone-sized page asks for a phone-sized terminal at the 12px font', async () => {
  const app = await createApp({ mobile: true });
  const { socket, resizes } = sizedApp(app, { cols: 140, rows: 44, width: 360, height: 640 });
  app.terminal.options.fontSize = 12;
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  // 12px font: cell 7 x 14 px -> 360/7 = 51 columns, 640/14 = 45 rows
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 51, rows: 45 });
  assert.equal(app.terminal.options.fontSize, 12);
});

test('MIRROR-B07 resizing the page or changing the font sends the new size once', async () => {
  const app = await createApp({ mobile: false });
  const { container, socket, resizes } = sizedApp(app);
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  socket.receive({ t: 'size', cols: 200, rows: 52 });

  app.context.handleResize();
  assert.equal(resizes().length, 1, 'an unchanged page does not resend');

  container.clientWidth = 800;
  app.context.handleResize();
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 100, rows: 52 });

  app.elements.get('btn-font-inc').listeners.get('click')();
  assert.equal(app.terminal.options.fontSize, 15);
  // 15px font: cell 9 x 18 px -> 800/9 = 88 columns, 900/18 = 50 rows
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 88, rows: 50 });
});

test('MIRROR-B09 a size reported by Tabby is shown as is and not fought over', async () => {
  const app = await createApp({ mobile: false });
  const { socket, resizes } = sizedApp(app);
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  socket.receive({ t: 'size', cols: 200, rows: 52 });
  const sent = resizes().length;

  // the user resizes the Tabby window by hand
  socket.receive({ t: 'size', cols: 120, rows: 30 });
  assert.equal(app.terminal.cols, 120);
  assert.equal(app.terminal.rows, 30);
  assert.equal(resizes().length, sent, 'the page does not immediately take the size back');
});

test('MIRROR-B09 coming back to the page after using Tabby takes the page size back', async () => {
  const app = await createApp({ mobile: false });
  const { socket, resizes } = sizedApp(app);
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  const pageSize = resizes().at(-1);
  socket.receive({ t: 'size', cols: pageSize.cols, rows: pageSize.rows });

  // the user works in Tabby, which refits the pane to its own window
  socket.receive({ t: 'size', cols: 120, rows: 30 });
  const before = resizes().length;

  // switching back to the browser window
  app.context.window.listeners.get('focus')();
  assert.equal(resizes().length, before + 1);
  assert.deepEqual(resizes().at(-1), pageSize);

  // a hidden tab becoming visible again does the same
  socket.receive({ t: 'size', cols: 120, rows: 30 });
  app.context.document.visibilityState = 'hidden';
  app.context.document.listeners.get('visibilitychange')();
  assert.equal(resizes().length, before + 1, 'nothing is sent while the tab is hidden');
  app.context.document.visibilityState = 'visible';
  app.context.document.listeners.get('visibilitychange')();
  assert.deepEqual(resizes().at(-1), pageSize);
  assert.equal(resizes().length, before + 2);
});

test('full screen keeps the normal font; the extra room becomes more columns and rows', async () => {
  const app = await createApp({ mobile: false });
  const { container, socket, resizes } = sizedApp(app, { width: 1600, height: 900 });
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  Object.assign(container, { clientWidth: 1920, clientHeight: 1080 });
  app.context.document.fullscreenElement = {};
  app.context.onFullscreenChange();
  assert.equal(app.terminal.options.fontSize, 14);
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 240, rows: 63 });
});

test('MIRROR-B11 nothing is sent while the socket is not open; a page too small still asks for a usable minimum', async () => {
  const app = await createApp({ mobile: false });
  fontAwareTerminal(app, 140, 44);
  const container = app.elements.get('terminal-container');
  Object.assign(container, { clientWidth: 1600, clientHeight: 900 });
  const socket = app.sockets.at(-1);
  app.context.handleResize();
  assert.equal(socket.sent.length, 0, 'not connected yet');

  socket.emit('open');
  Object.assign(container, { clientWidth: 50, clientHeight: 40 });
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  const last = socket.sent.map(s => JSON.parse(s)).filter(m => m.t === 'resize').at(-1);
  assert.deepEqual(last, { t: 'resize', cols: 20, rows: 5 });
});

test('MIRROR-B07 measures #terminal-wrapper so temporary scrollbars on #terminal-container do not steal columns', async () => {
  const app = await createApp({ mobile: false });
  const { container, socket, resizes } = sizedApp(app, { cols: 180, rows: 62, width: 1584, height: 900 });
  const wrapper = app.elements.get('terminal-wrapper');
  Object.assign(wrapper, { clientWidth: 1600, clientHeight: 900 });
  socket.receive({ t: 'snapshot', data: '', cols: 180, rows: 62 });
  // wrapper 1600/8 = 200 cols (even though container lost 16px to a temporary vertical scrollbar)
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 200, rows: 52 });
  assert.equal(container.clientWidth, 1584);
});

test('MIRROR-B07 mobile keyboard open and close settles to full screen even after 120ms animation', async () => {
  const app = await createApp({ mobile: true });
  const { container, socket, resizes } = sizedApp(app, { cols: 140, rows: 44, width: 360, height: 640 });
  app.terminal.options.fontSize = 12;
  socket.receive({ t: 'snapshot', data: '', cols: 140, rows: 44 });
  socket.receive({ t: 'size', cols: 51, rows: 45 });

  const vv = app.context.window.visualViewport;
  // Soft keyboard opens: visualViewport shrinks
  vv.height = 460;
  Object.assign(container, { clientWidth: 360, clientHeight: 310 });
  vv.listeners.get('resize')();
  assert.equal(app.elements.get('app-root').style.height, '460px');
  for (const t of app.timers.filter(item => !item.cancelled)) { t.cancelled = true; t.fn(); }
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 51, rows: 22 });
  socket.receive({ t: 'size', cols: 51, rows: 22 });

  // Soft keyboard closes: at 120ms container is still animating (540px), at 360ms it reaches full height (640px)
  vv.height = 844;
  Object.assign(container, { clientWidth: 360, clientHeight: 540 });
  vv.listeners.get('resize')();
  assert.equal(app.elements.get('app-root').style.height, '');
  const t120 = app.timers.filter(item => !item.cancelled && item.delay === 120).at(-1);
  t120.cancelled = true;
  t120.fn();
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 51, rows: 38 });
  socket.receive({ t: 'size', cols: 51, rows: 38 });

  Object.assign(container, { clientWidth: 360, clientHeight: 640 });
  const t360 = app.timers.filter(item => !item.cancelled && item.delay === 360).at(-1);
  t360.cancelled = true;
  t360.fn();
  assert.deepEqual(resizes().at(-1), { t: 'resize', cols: 51, rows: 45 });
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

test('MIRROR-B17 a WSL pane is marked in the tab label, a Windows pane is not', async () => {
  const win = { ...first, environment: 'Windows' };
  const wsl = { ...second, windowNo: 2, environment: 'WSL' };
  const app = await createApp({ sessions: [win, wsl], bridges: 1 });
  const labels = () => app.elements.get('tabs-list').children.map(tab => tab.children[0].textContent);
  assert.deepEqual(labels(), ['first', '[WSL] second']);
});

test('MIRROR-B12 and MIRROR-B13 the new-terminal panel sends the chosen environment and directory', async () => {
  const app = await createApp();
  const posts = [];
  app.context.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      posts.push([url, JSON.parse(options.body)]);
      return { json: async () => ({ success: true, session: second }) };
    }
    return app.listResponse();
  };

  app.elements.get('btn-new-window').listeners.get('click')();
  assert.equal(app.elements.get('new-terminal-panel').classList.contains('hidden'), false);

  // pick the WSL environment
  const envOptions = app.elements.get('new-term-env-list').children;
  assert.equal(envOptions.length, 2);
  envOptions[1].listeners.get('click')();
  assert.equal(newTermState(app).environment, 'WSL');

  // choose a directory
  vm.runInContext("newTerm.cwd = '/home/joslyn/code'", app.context);
  await app.context.submitNewTerminal();

  assert.deepEqual(posts, [['/api/sessions', { environment: 'WSL', cwd: '/home/joslyn/code' }]]);
  assert.equal(app.elements.get('new-terminal-panel').classList.contains('hidden'), true);
});

test('MIRROR-B14 creating without a directory sends an empty one', async () => {
  const app = await createApp();
  const posts = [];
  app.context.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { json: async () => ({ success: true, session: second }) };
    }
    return app.listResponse();
  };
  await app.context.submitNewTerminal();
  assert.deepEqual(posts, [{ environment: 'Windows', cwd: '' }]);
});

test('MIRROR-B15 the directory browser lists what the service reports and can go up one level', async () => {
  const app = await createApp();
  const requested = [];
  app.context.fetch = async (url) => {
    requested.push(url);
    return {
      json: async () => ({
        success: true,
        listing: { path: '/home/joslyn', parent: '/home', name: 'joslyn', directories: ['code', 'docs'], files: ['notes.txt'] }
      })
    };
  };

  await app.context.openDirectoryBrowser();
  assert.deepEqual(requested, ['/api/directories?path=C%3A%5C'], 'the browser starts at the root of the chosen environment');
  const list = app.elements.get('new-term-browse-list');
  const labels = list.children.map(el => el.textContent);
  assert.deepEqual(labels, ['..', 'code', 'docs']);

  await app.context.goToParentDirectory();
  assert.equal(requested[1], '/api/directories?path=%2Fhome');
});

test('MIRROR-B16 a directory the service cannot read is shown as an error', async () => {
  const app = await createApp();
  app.context.fetch = async () => ({ json: async () => ({ success: false, error: '无法访问目录：/nope' }) });
  await app.context.openDirectoryBrowser();
  const error = app.elements.get('new-term-browse-error');
  assert.equal(error.classList.contains('hidden'), false);
  assert.match(error.textContent, /无法访问目录/);
  assert.equal(app.elements.get('new-term-browse-list').children.length, 0);
});

test('switching the environment clears the directory, because the browser is filtered by environment', async () => {
  const app = await createApp();
  vm.runInContext("newTerm.cwd = '/home/joslyn'", app.context);
  app.context.selectEnvironment('WSL');
  assert.equal(newTermState(app).cwd, '');
  vm.runInContext("newTerm.cwd = 'C:\\\\Users'", app.context);
  app.context.selectEnvironment('Windows');
  assert.equal(newTermState(app).cwd, '');
});

test('MIRROR-B15 choosing the directory the browser is showing fills in the working directory', async () => {
  const app = await createApp();
  app.context.fetch = async () => ({
    json: async () => ({
      success: true,
      listing: { path: '/home/joslyn/code', parent: '/home/joslyn', name: 'code', directories: ['app'], files: [] }
    })
  });
  await app.context.openDirectoryBrowser();
  app.elements.get('new-term-browse-use').listeners.get('click')();
  assert.equal(newTermState(app).cwd, '/home/joslyn/code');
  assert.equal(app.elements.get('new-term-browse-list').classList.contains('hidden'), false, 'the browser stays until it is closed');
  assert.equal(app.elements.get('new-term-browser').classList.contains('hidden'), true, 'the browser closes after choosing');
  assert.equal(app.elements.get('new-term-cwd-value').textContent, '/home/joslyn/code');
});

test('MIRROR-B15 a path typed into the panel is used as the working directory', async () => {
  const app = await createApp();
  const posts = [];
  app.context.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { json: async () => ({ success: true, session: second }) };
    }
    return app.listResponse();
  };
  const input = app.elements.get('new-term-cwd-input');
  input.value = '/home/joslyn/code';
  input.listeners.get('change')();
  await app.context.submitNewTerminal();
  assert.deepEqual(posts, [{ environment: 'Windows', cwd: '/home/joslyn/code' }]);
});

test('MIRROR-B19 a chosen directory is remembered and offered next time', async () => {
  const app = await createApp();
  const posts = [];
  app.context.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { json: async () => ({ success: true, session: second }) };
    }
    if (url.startsWith('/api/directories/exists')) {
      return { json: async () => ({ success: true, exists: true }) };
    }
    return app.listResponse();
  };

  app.elements.get('btn-new-window').listeners.get('click')();
  await app.context.submitNewTerminal();
  assert.deepEqual(posts.at(-1), { environment: 'Windows', cwd: '' });

  // now pick a directory and create again
  app.elements.get('btn-new-window').listeners.get('click')();
  await app.context.submitNewTerminal();
  vm.runInContext("newTerm.cwd = 'C:\\\\Users\\\\joslyn\\\\code'", app.context);
  await app.context.submitNewTerminal();
  assert.deepEqual(posts.at(-1), { environment: 'Windows', cwd: 'C:\\Users\\joslyn\\code' });

  const stored = JSON.parse(app.context.localStorage.getItem('wsl_term_recent_dirs'));
  assert.deepEqual(stored.Windows, ['C:\\Users\\joslyn\\code']);
});

test('MIRROR-B19 the recent list is shown for the current environment and picks a directory', async () => {
  const app = await createApp();
  app.context.localStorage.setItem('wsl_term_recent_dirs', JSON.stringify({
    Windows: ['C:\\Users\\joslyn\\code'],
    WSL: ['/home/joslyn/code']
  }));
  app.context.fetch = async (url) => {
    if (url.startsWith('/api/directories/exists')) {
      return { json: async () => ({ success: true, exists: true }) };
    }
    return app.listResponse();
  };

  app.elements.get('btn-new-window').listeners.get('click')();
  await new Promise((r) => setTimeout(r, 10));
  const items = () => app.elements.get('new-term-recent-list').children;
  assert.equal(items().length, 1);
  assert.equal(items()[0].children[1].textContent, 'C:\\Users\\joslyn\\code');

  // switching to WSL shows the WSL entries instead
  app.elements.get('new-term-env-list').children[1].listeners.get('click')();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(items().length, 1);
  assert.equal(items()[0].children[1].textContent, '/home/joslyn/code');

  // clicking one fills in the working directory
  items()[0].listeners.get('click')();
  assert.equal(newTermState(app).cwd, '/home/joslyn/code');
});

test('MIRROR-B19 a remembered directory that is gone is dropped from the list', async () => {
  const app = await createApp();
  app.context.localStorage.setItem('wsl_term_recent_dirs', JSON.stringify({
    Windows: ['C:\\gone', 'C:\\Users\\joslyn\\code'],
    WSL: []
  }));
  app.context.fetch = async (url) => {
    if (url.startsWith('/api/directories/exists')) {
      const path = decodeURIComponent(url.split('path=')[1]);
      return { json: async () => ({ success: true, exists: path !== 'C:\\gone' }) };
    }
    return app.listResponse();
  };
  app.elements.get('btn-new-window').listeners.get('click')();
  await new Promise((r) => setTimeout(r, 30));
  const stored = JSON.parse(app.context.localStorage.getItem('wsl_term_recent_dirs'));
  assert.deepEqual(stored.Windows, ['C:\\Users\\joslyn\\code']);
  assert.equal(app.elements.get('new-term-recent-list').children.length, 1);
});
