import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const firstWindow = { target: 'web:0', index: 0, name: 'first', command: 'bash', path: '/tmp' };
const secondWindow = { target: 'web:1', index: 1, name: 'second', command: 'bash', path: '/tmp' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function element() {
  return {
    textContent: '',
    className: '',
    innerHTML: '',
    listeners: new Map(),
    classList: { add() {}, remove() {} },
    appendChild() {},
    addEventListener(name, callback) { this.listeners.set(name, callback); }
  };
}

async function createApp() {
  const elements = new Map();
  const sockets = [];
  const errors = [];
  let terminal;
  let fitCalls = 0;

  class Terminal {
    constructor() {
      terminal = this;
      this.cols = 80;
      this.rows = 24;
      this.output = [];
      this.focusCalls = 0;
      this.options = {};
    }
    loadAddon() {}
    open() {}
    reset() { this.output = []; }
    write(data) { this.output.push(data); }
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
  }

  const response = windows => ({
    json: async () => ({ success: true, windows })
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
      FitAddon: { FitAddon: class { fit() { fitCalls++; } } },
      addEventListener() {}
    },
    WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost:7891' },
    console: { error: (...args) => errors.push(args) },
    fetch: async () => response([firstWindow]),
    prompt: () => 'second',
    requestAnimationFrame: callback => callback(),
    setInterval() {},
    setTimeout() {},
    alert(message) { assert.fail(message); }
  });

  vm.runInContext(source, context);
  await context.fetchWindows();

  const badge = elements.get('connection-badge');
  return {
    context,
    elements,
    sockets,
    terminal,
    errors,
    badge,
    response,
    snapshot: () => ({
      output: [...terminal.output],
      focusCalls: terminal.focusCalls,
      fitCalls,
      badge: [badge.className, badge.textContent],
      dimensions: elements.get('status-dim').textContent,
      sent: sockets.map(socket => [...socket.sent]),
      errors: [...errors]
    })
  };
}

test('creating a window connects before the window list refresh completes', { timeout: 1000 }, async () => {
  const app = await createApp();
  const oldSocket = app.sockets[0];
  oldSocket.emit('open');
  const refresh = deferred();
  const refreshStarted = deferred();
  app.context.fetch = async (url, options) => {
    assert.equal(url, '/api/windows');
    if (options?.method === 'POST') {
      return { json: async () => ({ success: true, window: secondWindow }) };
    }
    refreshStarted.resolve();
    return refresh.promise;
  };

  const creation = app.elements.get('btn-new-window').listeners.get('click')();
  await refreshStarted.promise;
  assert.equal(app.sockets.length, 2);
  assert.equal(oldSocket.readyState, 3);
  assert.equal(new URL(app.sockets[1].url).searchParams.get('target'), secondWindow.target);
  assert.match(app.badge.textContent, /连接中/);

  refresh.resolve(app.response([firstWindow, secondWindow]));
  await creation;
  assert.equal(app.sockets.length, 2, 'refresh must not create another connection');
  assert.equal(vm.runInContext('activeTarget', app.context), secondWindow.target);
});

for (const currentState of ['connecting', 'open']) {
  for (const staleEvent of ['open', 'message', 'close', 'error']) {
    test(`stale ${staleEvent} cannot affect a ${currentState} replacement`, async () => {
      const app = await createApp();
      const oldSocket = app.sockets[0];
      oldSocket.emit('open');
      app.context.connectToWindow(secondWindow.target);
      const currentSocket = app.sockets[1];
      if (currentState === 'open') currentSocket.emit('open');
      const before = app.snapshot();

      oldSocket.emit(staleEvent, staleEvent === 'message'
        ? { data: 'stale terminal output' }
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
      oldSocket.emit(name, { data: 'stale output during close' });
    }
    assert.deepEqual(app.snapshot(), before);
  };

  app.context.connectToWindow(secondWindow.target);
  assert.equal(app.sockets.length, 2);
  assert.match(app.badge.textContent, /连接中/);
});

test('current socket events still update the terminal, badge, resize and input', async () => {
  const app = await createApp();
  const socket = app.sockets[0];
  socket.emit('open');
  assert.equal(app.badge.className, 'badge badge-connected');
  assert.equal(app.terminal.focusCalls, 1);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'resize', cols: 80, rows: 24 });
  app.terminal.input('echo current\r');
  assert.equal(socket.sent[1], 'echo current\r');
  socket.emit('message', { data: 'current output' });
  assert.deepEqual(app.terminal.output, ['current output']);

  socket.emit('error', new Error('current error'));
  assert.match(app.badge.textContent, /连接异常/);
  assert.equal(app.errors.length, 1);
  socket.emit('close');
  assert.match(app.badge.textContent, /已断开/);
});
