import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { BridgeCore } = require('../bridge/src/bridge-core.js');

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  types() { return this.sent.map((m) => m.type); }
  last(type) { return [...this.sent].reverse().find((m) => m.type === type); }
}

function fakeTerminal(overrides = {}) {
  const subscribers = new Set();
  const terminal = {
    title: 'PowerShell',
    customTitle: '',
    size: { columns: 120, rows: 30 },
    inputs: [],
    writes: [],
    destroyed: false,
    frontend: { saveState: () => 'SCREEN-STATE' },
    output$: { subscribe(fn) { subscribers.add(fn); return { unsubscribe: () => subscribers.delete(fn) }; } },
    emit(data) { for (const fn of subscribers) fn(data); },
    subscriberCount: () => subscribers.size,
    sendInput(data) { terminal.inputs.push(data); },
    async write(data) { terminal.writes.push(data); },
    setCustomTitle(name) { terminal.customTitle = name; },
    destroy() { terminal.destroyed = true; },
    ...overrides
  };
  return terminal;
}

function setup(options = {}) {
  FakeSocket.instances = [];
  const focusListeners = new Set();
  const core = new BridgeCore({
    WebSocketImpl: FakeSocket,
    getServerUrl: () => 'ws://server:7890/',
    openDefaultTab: async () => {},
    bridgeId: 'B',
    version: '9.9.9',
    focusTarget: { addEventListener: (_n, fn) => focusListeners.add(fn), removeEventListener: (_n, fn) => focusListeners.delete(fn) },
    hasFocus: () => false,
    syncIntervalMs: 1e9,
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    ...options
  });
  core.start();
  const socket = () => FakeSocket.instances.at(-1);
  return { core, socket, focusListeners };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('connects to /ws/bridge, says hello, then reports the panes with their title and size', () => {
  const { core, socket } = setup();
  const term = fakeTerminal();
  core.attach(term);
  assert.equal(socket().url, 'ws://server:7890/ws/bridge');
  socket().open();
  assert.deepEqual(socket().sent[0], { type: 'hello', protocol: 1, bridgeId: 'B', version: '9.9.9' });
  assert.deepEqual(socket().last('sessions').sessions, [{ id: 'B.1', title: 'PowerShell', cols: 120, rows: 30, focused: false }]);
  core.stop();
});

test('the pane Tabby marks as focused is reported as focused, right when focus moves', () => {
  const { core, socket } = setup();
  const focusSubs = new Set();
  const withFocus = () => fakeTerminal({
    hasFocus: false,
    focused$: { subscribe(fn) { focusSubs.add(fn); return { unsubscribe: () => focusSubs.delete(fn) }; } }
  });
  const a = withFocus();
  const b = withFocus();
  core.attach(a);
  core.attach(b);
  socket().open();
  assert.deepEqual(socket().last('sessions').sessions.map((s) => s.focused), [false, false]);

  b.hasFocus = true;
  for (const fn of focusSubs) fn();
  assert.deepEqual(socket().last('sessions').sessions.map((s) => s.focused), [false, true]);

  core.detach(b);
  core.stop();
  assert.equal(focusSubs.size, 0, 'focus subscriptions are released');
});

test('a renamed title or new size is reported on the next sync, an unchanged list is not repeated', () => {
  const { core, socket } = setup();
  const term = fakeTerminal();
  core.attach(term);
  socket().open();
  core.sync();
  assert.equal(socket().sent.filter((m) => m.type === 'sessions').length, 1);

  term.customTitle = 'build';
  term.size = { columns: 90, rows: 20 };
  core.sync();
  assert.deepEqual(socket().last('sessions').sessions[0], { id: 'B.1', title: 'build', cols: 90, rows: 20, focused: false });
  core.stop();
});

test('detaching a pane removes it from the report and stops listening to its output', () => {
  const { core, socket } = setup();
  const term = fakeTerminal();
  core.attach(term);
  socket().open();
  core.detach(term);
  assert.deepEqual(socket().last('sessions').sessions, []);
  assert.equal(term.subscriberCount(), 0);
  core.stop();
});

test('output is forwarded, numbered, only while a browser is watching', () => {
  const { core, socket } = setup();
  const term = fakeTerminal();
  core.attach(term);
  socket().open();

  term.emit('unseen');
  assert.equal(socket().last('output'), undefined);

  socket().receive({ type: 'watch', id: 'B.1', on: true });
  term.emit('a');
  term.emit('b');
  assert.deepEqual(socket().sent.filter((m) => m.type === 'output'), [
    { type: 'output', id: 'B.1', seq: 2, data: 'a' },
    { type: 'output', id: 'B.1', seq: 3, data: 'b' }
  ]);

  socket().receive({ type: 'watch', id: 'B.1', on: false });
  term.emit('c');
  assert.equal(socket().sent.filter((m) => m.type === 'output').length, 2);
  core.stop();
});

test('a snapshot request flushes Tabby\'s write queue and reports the sequence it covers', async () => {
  const { core, socket } = setup();
  const term = fakeTerminal();
  core.attach(term);
  socket().open();
  socket().receive({ type: 'watch', id: 'B.1', on: true });
  term.emit('one');
  term.emit('two');

  socket().receive({ type: 'snapshot-request', id: 'B.1', reqId: 'R' });
  await flush();
  assert.deepEqual(term.writes, ['']);
  assert.deepEqual(socket().last('snapshot'), {
    type: 'snapshot', id: 'B.1', reqId: 'R', seq: 2, data: 'SCREEN-STATE', cols: 120, rows: 30
  });
  core.stop();
});

test('a snapshot still goes out when the frontend is not ready', async () => {
  const { core, socket } = setup();
  const term = fakeTerminal({ frontend: undefined, write: async () => { throw new Error('Frontend not ready'); } });
  core.attach(term);
  socket().open();
  socket().receive({ type: 'snapshot-request', id: 'B.1', reqId: 'R' });
  await flush();
  assert.equal(socket().last('snapshot').data, '');
  core.stop();
});

test('input goes to the right pane; unknown ids and non-string input are ignored', () => {
  const { core, socket } = setup();
  const a = fakeTerminal();
  const b = fakeTerminal();
  core.attach(a);
  core.attach(b);
  socket().open();
  socket().receive({ type: 'input', id: 'B.2', data: 'ls\r' });
  socket().receive({ type: 'input', id: 'B.9', data: 'x' });
  socket().receive({ type: 'input', id: 'B.1', data: 5 });
  assert.deepEqual(a.inputs, []);
  assert.deepEqual(b.inputs, ['ls\r']);
  core.stop();
});

test('create, rename and close are performed in Tabby and answered', async () => {
  let opened = 0;
  const { core, socket } = setup({ openDefaultTab: async () => { opened++; } });
  const term = fakeTerminal();
  core.attach(term);
  socket().open();

  socket().receive({ type: 'create', reqId: '1' });
  socket().receive({ type: 'rename', reqId: '2', id: 'B.1', name: 'logs' });
  socket().receive({ type: 'close', reqId: '3', id: 'B.1' });
  socket().receive({ type: 'close', reqId: '4', id: 'B.9' });
  await flush();

  assert.equal(opened, 1);
  assert.equal(term.destroyed, true);
  const results = Object.fromEntries(socket().sent.filter((m) => m.type === 'result').map((m) => [m.reqId, m]));
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
  assert.equal(results[3].ok, true);
  assert.equal(results[4].ok, false);
  assert.match(results[4].error, /No such session/);
  assert.equal(term.customTitle, 'logs');
  core.stop();
});

test('a failing Tabby action is reported instead of thrown', async () => {
  const { core, socket } = setup({ openDefaultTab: async () => { throw new Error('no profile'); } });
  socket().open();
  socket().receive({ type: 'create', reqId: '1' });
  await flush();
  assert.deepEqual(socket().last('result'), { type: 'result', reqId: '1', ok: false, error: 'no profile' });
  core.stop();
});

test('window focus is reported', () => {
  const { core, socket, focusListeners } = setup();
  socket().open();
  for (const fn of focusListeners) fn();
  assert.equal(socket().last('focus').type, 'focus');
  core.stop();
  assert.equal(focusListeners.size, 0);
});

test('after the connection drops it reconnects with the same id and re-reports everything', async () => {
  const { core, socket } = setup();
  const term = fakeTerminal();
  core.attach(term);
  socket().open();
  socket().receive({ type: 'watch', id: 'B.1', on: true });
  const first = socket();

  first.readyState = 3;
  first.onclose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = socket();
  assert.notEqual(second, first);
  second.open();
  assert.deepEqual(second.sent[0], { type: 'hello', protocol: 1, bridgeId: 'B', version: '9.9.9' });
  assert.equal(second.last('sessions').sessions.length, 1);

  term.emit('x');
  assert.equal(second.last('output'), undefined, 'watching is per connection and starts over');
  core.stop();
});

test('garbage from the server is ignored', () => {
  const { core, socket } = setup();
  socket().open();
  socket().onmessage({ data: 'not json' });
  socket().onmessage({ data: 'null' });
  socket().receive({ type: 'nonsense' });
  core.stop();
});

test('index.js wires the Bridge into Tabby\'s DI as a terminal decorator and a config provider', () => {
  const injected = [];
  const metadata = [];
  class ConfigProvider {}
  class TerminalDecorator {}
  class ConfigService {}
  class ProfilesService {}
  const fakes = {
    '@angular/core': {
      NgModule: (meta) => (cls) => { metadata.push({ cls, meta }); },
      Injectable: () => () => {},
      Inject: (token) => (cls, _key, index) => { injected.push({ cls: cls.name, index, token }); }
    },
    'tabby-core': { ConfigProvider, ConfigService, ProfilesService },
    'tabby-terminal': { TerminalDecorator }
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return fakes[request] || originalLoad.call(this, request, ...rest);
  };
  let loaded;
  try {
    delete require.cache[require.resolve('../bridge/src/index.js')];
    loaded = require('../bridge/src/index.js');
  } finally {
    Module._load = originalLoad;
  }

  assert.equal(typeof loaded.default, 'function');
  assert.equal(metadata.length, 1);
  const providers = metadata[0].meta.providers;
  assert.deepEqual(providers.map((p) => [p.provide, p.multi]), [[ConfigProvider, true], [TerminalDecorator, true]]);
  assert.deepEqual(injected.map((i) => [i.cls, i.index, i.token]), [
    ['WebBridgeDecorator', 0, ConfigService],
    ['WebBridgeDecorator', 1, ProfilesService]
  ]);
  assert.equal(new providers[0].useClass().defaults.wslWebBridge.serverUrl, 'ws://localhost:7890');
});

test('the plugin manifest satisfies the Tabby plugin finder', () => {
  // Tabby (app/src/plugins.ts) silently skips a plugin whose package.json lacks any of these;
  // in particular `info.author.name` throws when `author` is missing.
  const manifest = require('../bridge/package.json');
  assert.match(manifest.name, /^tabby-/);
  assert.ok(manifest.keywords.includes('tabby-plugin'));
  assert.ok(manifest.author, 'author is required');
  assert.equal(typeof manifest.version, 'string');
  assert.doesNotThrow(() => require.resolve(`../bridge/${manifest.main}`));
});

test('the snapshot includes the alternate screen: full-screen programs are not lost', async () => {
  // Verified against the real xterm serialize addon: Tabby's saveState() restores only the shell
  // underneath (excludeAltBuffer: true), serialize() with defaults restores the program's screen and modes.
  const calls = [];
  const { core, socket } = setup();
  const term = fakeTerminal({
    frontend: {
      saveState: () => 'ONLY-THE-SHELL',
      serializeAddon: { serialize: (options) => { calls.push(options); return 'FULL-SCREEN-PROGRAM'; } }
    }
  });
  core.attach(term);
  socket().open();
  socket().receive({ type: 'snapshot-request', id: 'B.1', reqId: 'R' });
  await flush();

  assert.equal(socket().last('snapshot').data, 'FULL-SCREEN-PROGRAM');
  assert.deepEqual(calls, [{ scrollback: 1000 }], 'no excludeAltBuffer / excludeModes');
  core.stop();
});

test('if the serialize addon is missing or throws, the snapshot falls back to Tabby\'s saveState', async () => {
  const { core, socket } = setup();
  const broken = fakeTerminal({
    frontend: { saveState: () => 'FALLBACK', serializeAddon: { serialize: () => { throw new Error('boom'); } } }
  });
  const plain = fakeTerminal({ frontend: { saveState: () => 'PLAIN' } });
  core.attach(broken);
  core.attach(plain);
  socket().open();
  socket().receive({ type: 'snapshot-request', id: 'B.1', reqId: 'R1' });
  socket().receive({ type: 'snapshot-request', id: 'B.2', reqId: 'R2' });
  await flush();

  assert.equal(socket().sent.find((m) => m.reqId === 'R1').data, 'FALLBACK');
  assert.equal(socket().sent.find((m) => m.reqId === 'R2').data, 'PLAIN');
  core.stop();
});
