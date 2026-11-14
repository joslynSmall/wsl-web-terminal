import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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
    releaseDelayMs: 0,
    ...options
  });
  core.start();
  const socket = () => FakeSocket.instances.at(-1);
  return { core, socket, focusListeners };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('MIRROR-B13 creating a WSL pane asks Tabby for a wsl.exe profile with the Linux path', async () => {
  const requests = [];
  const { core, socket } = setup({
    openTabForRequest: async (request) => { requests.push(request); }
  });
  socket().open();
  socket().receive({ type: 'create-in', reqId: 'R1', environment: 'WSL', cwd: '/home/joslyn/code' });
  await flush();
  assert.deepEqual(requests, [{ environment: 'WSL', cwd: '/home/joslyn/code' }]);
  const result = socket().last('result');
  assert.equal(result.ok, true);
  core.stop();
});

test('MIRROR-B14 creating without a working directory leaves the profile default alone', async () => {
  const requests = [];
  const { core, socket } = setup({
    openTabForRequest: async (request) => { requests.push(request); }
  });
  socket().open();
  socket().receive({ type: 'create-in', reqId: 'R2', environment: 'Windows' });
  await flush();
  assert.deepEqual(requests, [{ environment: 'Windows', cwd: '' }]);
  core.stop();
});

test('MIRROR-B12 an unknown environment falls back to Windows', async () => {
  const requests = [];
  const { core, socket } = setup({
    openTabForRequest: async (request) => { requests.push(request); }
  });
  socket().open();
  socket().receive({ type: 'create-in', reqId: 'R3', environment: 'Solaris' });
  await flush();
  assert.deepEqual(requests, [{ environment: 'Windows', cwd: '' }]);
  core.stop();
});

test('MIRROR-B15 listing a directory returns the entries the Bridge read', async () => {
  const listed = [];
  const { core, socket } = setup({
    listDirectories: async (dirPath) => {
      listed.push(dirPath);
      return { path: dirPath, parent: '/', name: 'code', directories: ['a'], files: ['b.txt'] };
    }
  });
  socket().open();
  socket().receive({ type: 'list-dirs', reqId: 'R4', path: '/home/joslyn/code' });
  await flush();
  assert.deepEqual(listed, ['/home/joslyn/code']);
  assert.deepEqual(socket().last('result').result, {
    path: '/home/joslyn/code', parent: '/', name: 'code', directories: ['a'], files: ['b.txt']
  });
  core.stop();
});

test('MIRROR-B16 a directory that cannot be read is reported as an error, not as an empty directory', async () => {
  const { core, socket } = setup({
    listDirectories: async () => { throw new Error('无法访问目录：/nope'); }
  });
  socket().open();
  socket().receive({ type: 'list-dirs', reqId: 'R5', path: '/nope' });
  await flush();
  const result = socket().last('result');
  assert.equal(result.ok, false);
  assert.match(result.error, /无法访问目录/);
  core.stop();
});

test('MIRROR-B17 a pane reports the environment it actually runs in', () => {
  const { core, socket } = setup({
    environmentOf: (terminal) => (terminal.title === 'wsl' ? 'WSL' : 'Windows')
  });
  const wsl = fakeTerminal({ title: 'wsl' });
  const win = fakeTerminal({ title: 'PowerShell' });
  core.attach(wsl);
  core.attach(win);
  socket().open();
  assert.deepEqual(socket().last('sessions').sessions.map((s) => s.environment), ['WSL', 'Windows']);
  core.stop();
});

test('MIRROR-B11 the create-in and list-dirs commands are refused when the Bridge cannot do them', async () => {
  const { core, socket } = setup();
  socket().open();
  socket().receive({ type: 'create-in', reqId: 'R6', environment: 'WSL' });
  socket().receive({ type: 'list-dirs', reqId: 'R7', path: '/' });
  await flush();
  const results = socket().sent.filter((m) => m.type === 'result');
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok === false));
  core.stop();
});

test('connects to /ws/bridge, says hello, then reports the panes with their title and size', () => {
  const { core, socket } = setup();
  const term = fakeTerminal();
  core.attach(term);
  assert.equal(socket().url, 'ws://server:7890/ws/bridge');
  socket().open();
  assert.deepEqual(socket().sent[0], { type: 'hello', protocol: 1, bridgeId: 'B', version: '9.9.9', origin: '' });
  assert.deepEqual(socket().last('sessions').sessions, [{ id: 'B.1', title: 'PowerShell', cols: 120, rows: 30, environment: '', focused: false }]);
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
  assert.deepEqual(socket().last('sessions').sessions[0], { id: 'B.1', title: 'build', cols: 90, rows: 20, environment: '', focused: false });
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
  assert.deepEqual(second.sent[0], { type: 'hello', protocol: 1, bridgeId: 'B', version: '9.9.9', origin: '' });
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
  class CLIHandler {}
  class ConfigProvider {}
  class TerminalDecorator {}
  class ConfigService {}
  class HostWindowService {}
  class ProfilesService {}
  const fakes = {
    '@angular/core': {
      NgModule: (meta) => (cls) => { metadata.push({ cls, meta }); },
      Injectable: () => () => {},
      Inject: (token) => (cls, _key, index) => { injected.push({ cls: cls.name, index, token }); }
    },
    'tabby-core': { CLIHandler, ConfigProvider, ConfigService, HostWindowService, ProfilesService },
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
  assert.deepEqual(providers.map((p) => [p.provide, p.multi, p.useClass.name]), [
    [ConfigProvider, true, 'WebBridgeConfigProvider'],
    [TerminalDecorator, true, 'WebBridgeDecorator'],
    [CLIHandler, true, 'WslHereCLIHandler']
  ]);
  assert.deepEqual(injected.map((i) => [i.cls, i.index, i.token]), [
    ['WebBridgeDecorator', 0, ConfigService],
    ['WebBridgeDecorator', 1, ProfilesService],
    ['WslHereCLIHandler', 0, ProfilesService],
    ['WslHereCLIHandler', 1, HostWindowService]
  ]);
  const handler = new providers[2].useClass();
  assert.equal(handler.priority, 100, 'runs before Tabby\'s own CLI handlers');
  assert.equal(handler.firstMatchOnly, true);
  assert.equal(new providers[0].useClass().defaults.wslWebBridge.serverUrl, 'ws://localhost:7890');
  assert.equal(loaded.detectOrigin(), process.platform === 'win32' ? 'Windows' : 'WSL');
});

test('MIRROR-B02 hello reports the origin it was given', () => {
  const { core, socket } = setup({ origin: 'WSL' });
  socket().open();
  assert.equal(socket().sent[0].origin, 'WSL');
  core.stop();
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

// Tabby's frontend: a private xterm whose resize Tabby forwards to the shell, and a resizeHandler that refits to the window.
function sizableTerminal() {
  const xterm = { cols: 140, rows: 44, resizes: [], resize(c, r) { this.cols = c; this.rows = r; this.resizes.push([c, r]); } };
  const term = fakeTerminal({ frontend: { saveState: () => 'S', xterm, refits: 0, resizeHandler() { this.refits++; xterm.resize(140, 44); } } });
  Object.defineProperty(term, 'size', { get: () => ({ columns: xterm.cols, rows: xterm.rows }) });
  return { term, xterm };
}

test('MIRROR-B07 a resize from the server sizes Tabby\'s xterm and reports the new size', () => {
  const { core, socket } = setup();
  const { term, xterm } = sizableTerminal();
  core.attach(term);
  socket().open();
  socket().receive({ type: 'watch', id: 'B.1', on: true });
  socket().receive({ type: 'resize', id: 'B.1', cols: 200, rows: 52 });
  assert.deepEqual(xterm.resizes, [[200, 52]]);
  assert.deepEqual(socket().last('sessions').sessions.map((s) => [s.cols, s.rows]), [[200, 52]]);
  socket().receive({ type: 'resize', id: 'B.1', cols: 200, rows: 52 });
  assert.equal(xterm.resizes.length, 1, 'an unchanged size is not applied again');
  core.stop();
});

test('MIRROR-B08 when nobody watches any more, or the server goes away, Tabby refits the pane to its window', async () => {
  const { core, socket } = setup();
  const { term, xterm } = sizableTerminal();
  core.attach(term);
  socket().open();
  socket().receive({ type: 'watch', id: 'B.1', on: true });
  socket().receive({ type: 'resize', id: 'B.1', cols: 200, rows: 52 });
  socket().receive({ type: 'watch', id: 'B.1', on: false });
  assert.equal(term.frontend.refits, 1);
  assert.deepEqual([xterm.cols, xterm.rows], [140, 44]);
  assert.deepEqual(socket().last('sessions').sessions.map((s) => [s.cols, s.rows]), [[140, 44]]);

  socket().receive({ type: 'watch', id: 'B.1', on: false });
  assert.equal(term.frontend.refits, 1, 'a pane that was never resized by a browser is left alone');

  socket().receive({ type: 'watch', id: 'B.1', on: true });
  socket().receive({ type: 'resize', id: 'B.1', cols: 90, rows: 30 });
  const first = socket();
  first.readyState = 3;
  first.onclose();
  assert.equal(term.frontend.refits, 2, 'losing the server also hands the size back');
  core.stop();
});

test('MIRROR-B11 without Tabby\'s xterm, or with a nonsense size, a resize is ignored without throwing', () => {
  const { core, socket } = setup();
  const plain = fakeTerminal();
  core.attach(plain);
  const { term, xterm } = sizableTerminal();
  core.attach(term);
  socket().open();
  assert.doesNotThrow(() => socket().receive({ type: 'resize', id: 'B.1', cols: 200, rows: 52 }));
  for (const bad of [{ cols: 3, rows: 52 }, { cols: 200, rows: 1 }, { cols: 99999, rows: 52 }, { cols: '200', rows: 'x' }]) {
    socket().receive({ type: 'resize', id: 'B.2', ...bad });
  }
  assert.deepEqual(xterm.resizes, []);
  core.stop();
});

test('MIRROR-B11 an xterm that throws on resize is logged and the pane keeps its size', () => {
  const logs = [];
  const { core, socket } = setup({ log: (...a) => logs.push(a.join(' ')) });
  const { term, xterm } = sizableTerminal();
  xterm.resize = () => { throw new Error('boom'); };
  core.attach(term);
  socket().open();
  assert.doesNotThrow(() => socket().receive({ type: 'resize', id: 'B.1', cols: 200, rows: 52 }));
  assert.match(logs.join('\n'), /resize to viewer size failed/);
  socket().receive({ type: 'watch', id: 'B.1', on: false });
  assert.equal(term.frontend.refits, 0, 'nothing to hand back when the resize never happened');
  core.stop();
});

test('MIRROR-B08 a quick page refresh does not flash back to Tabby size, and resize cancels any queued Tabby refit', async () => {
  const { core, socket } = setup({ releaseDelayMs: 40 });
  const { term, xterm } = sizableTerminal();
  core.attach(term);
  socket().open();
  socket().receive({ type: 'watch', id: 'B.1', on: true });
  socket().receive({ type: 'resize', id: 'B.1', cols: 200, rows: 52 });

  // Page unloads and reloads quickly: watch=false then watch=true + resize before releaseDelayMs expires
  socket().receive({ type: 'watch', id: 'B.1', on: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  socket().receive({ type: 'watch', id: 'B.1', on: true });
  socket().receive({ type: 'resize', id: 'B.1', cols: 200, rows: 52 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(term.frontend.refits, 0, 'quick refresh keeps the viewer size without calling resizeHandler');
  assert.deepEqual([xterm.cols, xterm.rows], [200, 52]);

  // Simulate an already-queued async Tabby resizeHandler timer (e.g. from an earlier release)
  term.frontend.resizePending = true;
  let staleFired = false;
  term.frontend.resizeTimeout = setTimeout(() => { staleFired = true; xterm.resize(140, 44); }, 25);
  socket().receive({ type: 'resize', id: 'B.1', cols: 210, rows: 55 });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(staleFired, false, 'pending Tabby resizeTimeout was cancelled');
  assert.equal(term.frontend.resizePending, false);
  assert.deepEqual([xterm.cols, xterm.rows], [210, 55]);

  // Leaving for real waits releaseDelayMs and then hands size back
  socket().receive({ type: 'watch', id: 'B.1', on: false });
  assert.equal(term.frontend.refits, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(term.frontend.refits, 1);
  assert.deepEqual([xterm.cols, xterm.rows], [140, 44]);
  core.stop();
});

test('MIRROR-B07 reports live xterm size even while Tabby terminal.size lags behind auditTime, and syncs before output', () => {
  const { core, socket } = setup();
  const xterm = { cols: 180, rows: 62, resize(c, r) { this.cols = c; this.rows = r; } };
  // Mimic real Tabby: terminal.size stays stale until auditTime(100) runs later
  const term = fakeTerminal({
    size: { columns: 180, rows: 62 },
    frontend: { saveState: () => 'S', xterm, resizeHandler() { xterm.resize(180, 62); } }
  });
  core.attach(term);
  socket().open();
  socket().receive({ type: 'watch', id: 'B.1', on: true });

  // Viewer resizes pane to 311x73: Bridge must report 311x73 right away despite stale term.size
  socket().receive({ type: 'resize', id: 'B.1', cols: 311, rows: 73 });
  assert.deepEqual(socket().last('sessions').sessions.map((s) => [s.cols, s.rows]), [[311, 73]]);

  // If Tabby itself resizes xterm (e.g. fitAddon.fit) before output arrives, sessions is sent BEFORE output
  xterm.resize(180, 62);
  const beforeCount = socket().sent.length;
  term.emit('frame');
  const added = socket().sent.slice(beforeCount).map((m) => m.type);
  assert.deepEqual(added, ['sessions', 'output']);
  assert.deepEqual(socket().last('sessions').sessions.map((s) => [s.cols, s.rows]), [[180, 62]]);
  core.stop();
});

test('MIRROR-B07 snapshot clips alternate-screen rows to current cols so shrunk phones do not wrap stale wide columns', async () => {
  const { core, socket } = setup();
  // Normal buffer has a 70-col command line; alternate screen rows carry 311-col stale trailing columns
  // from an earlier desktop width while current xterm.cols is 49.
  const wideAltRow = '  ┃ Ask anything' + ' '.repeat(102) + '┃  Ask anything... "Fix broken tests"' + ' '.repeat(150);
  const lastRow = '  ⊙ 8 MCP' + ' '.repeat(40) + '\x1b[19A\x1b[44D\x1b[0m\x1b[?2004h';
  const raw = 'joslyn@host:~/very/long/normal/scrollback/path/that/exceeds/forty/nine/cols$ opencode'
    + '\x1b[?1049h\x1b[H'
    + `\x1b[34m${wideAltRow}\x1b[0m\r\n`
    + `  中文宽度测试${'x'.repeat(60)}\r\n`
    + lastRow;
  const term = fakeTerminal({
    frontend: {
      xterm: { cols: 49, rows: 43 },
      serializeAddon: { serialize: () => raw }
    }
  });
  core.attach(term);
  socket().open();
  socket().receive({ type: 'snapshot-request', id: 'B.1', reqId: 'R-CLIP' });
  await flush();

  const snap = socket().last('snapshot');
  assert.equal(snap.cols, 49);
  const [normalPart, altPart] = snap.data.split('\x1b[?1049h\x1b[H');
  assert.match(normalPart, /exceeds\/forty\/nine\/cols\$ opencode/, 'normal buffer scrollback is preserved');
  const rows = altPart.split('\r\n');
  assert.equal(rows[0], '\x1b[34m  ┃ Ask anything' + ' '.repeat(33) + '\x1b[0m');
  assert.equal(rows[1], '  中文宽度测试' + 'x'.repeat(35)); // 2 spaces + 6*2 CJK + 35 x = 49 cols
  assert.match(rows[2], /\x1b\[19A\x1b\[44D\x1b\[0m\x1b\[\?2004h$/, 'trailing cursor move and modes are preserved');
  core.stop();
});

const {
  decodeLauncher,
  handleWslHere,
  launcherPathFromArgv,
  parseLauncher
} = require('../bridge/src/wsl-here.js');

const WSL_LAUNCHER = `wsl-${'a'.repeat(32)}.cmd`;

function wslLauncherArgv(file, { alreadyRunning = true } = {}) {
  // Tabby is already running: Electron moves the /c switch to the front, so this is no longer a run command.
  if (alreadyRunning) return { _: ['/c', 'run', 'C:\\Windows\\System32\\cmd.exe', file] };
  return { _: ['run'], command: ['C:\\Windows\\System32\\cmd.exe', '/c', file] };
}

test('the WSL launcher is still recognisable after Tabby reorders a second start', () => {
  const file = `C:\\Users\\Administrator\\AppData\\Local\\Tabby\\launchers\\${WSL_LAUNCHER}`;
  assert.equal(launcherPathFromArgv(wslLauncherArgv(file)), file);
  assert.equal(launcherPathFromArgv(wslLauncherArgv(`"${file}"`)), file);
  assert.equal(launcherPathFromArgv(wslLauncherArgv(file, { alreadyRunning: false })), file);
  assert.equal(launcherPathFromArgv({ _: ['open'], directory: '\\\\wsl$\\Ubuntu\\home\\joslyn' }), null);
  assert.equal(launcherPathFromArgv({ _: ['run'], command: ['C:\\Windows\\System32\\wsl.exe', '--cd', '/home'] }), null);
});

test('only the one line the Shift+right-click script writes counts as a WSL launcher', () => {
  assert.deepEqual(
    parseLauncher('@C:\\Windows\\System32\\wsl.exe --distribution Ubuntu --cd "/home/joslyn/code/third"\r\n'),
    { distro: 'Ubuntu', cwd: '/home/joslyn/code/third' }
  );
  assert.deepEqual(
    parseLauncher('@"C:\\Windows\\System32\\wsl.exe" --distribution Ubuntu --cd "~"'),
    { distro: 'Ubuntu', cwd: '~' }
  );
  assert.equal(parseLauncher('@C:\\Windows\\System32\\wsl.exe --distribution Ubuntu & calc.exe'), null);
  assert.equal(parseLauncher(''), null);
});

test('a launcher saved in the ANSI code page still names a Chinese directory', () => {
  const bytes = Buffer.concat([
    Buffer.from('@C:\\Windows\\System32\\wsl.exe --distribution Ubuntu --cd "'),
    Buffer.from([0x2f, 0xb4, 0xf3, 0xc4, 0xa3, 0xd0, 0xcd]),
    Buffer.from('"\r\n')
  ]);
  assert.deepEqual(parseLauncher(decodeLauncher(bytes)), { distro: 'Ubuntu', cwd: '/\u5927\u6a21\u578b' });
});

test('Shift+right-click while Tabby is open opens a wsl.exe pane instead of running the batch file', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsl-here-'));
  try {
    const dir = path.join(root, 'Tabby', 'launchers');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, WSL_LAUNCHER);
    writeFileSync(file, '@C:\\Windows\\System32\\wsl.exe --distribution Ubuntu --cd "/home/joslyn/code/third"\r\n');
    const opened = [];
    let broughtToFront = 0;
    const handled = await handleWslHere(wslLauncherArgv(file), {
      profiles: { openNewTabForProfile: async (profile) => { opened.push(profile); } },
      hostWindow: { bringToFront() { broughtToFront += 1; } },
      command: 'C:\\Windows\\System32\\wsl.exe'
    });
    assert.equal(handled, true);
    assert.equal(broughtToFront, 1);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].type, 'local');
    assert.equal(opened[0].options.command, 'C:\\Windows\\System32\\wsl.exe');
    assert.deepEqual(opened[0].options.args, ['--distribution', 'Ubuntu', '--cd', '/home/joslyn/code/third']);
    assert.equal(opened[0].options.cwd, null, 'a Windows cwd would override --cd');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing launcher, or one that is not the script\'s line, is left to Tabby', async () => {
  const missing = path.join(os.tmpdir(), 'Tabby', 'launchers', `wsl-${'b'.repeat(32)}.cmd`);
  const refuse = { openNewTabForProfile: async () => { throw new Error('should not open'); } };
  assert.equal(await handleWslHere(wslLauncherArgv(missing), { profiles: refuse, command: 'wsl.exe' }), false);

  const root = mkdtempSync(path.join(os.tmpdir(), 'wsl-here-'));
  try {
    const dir = path.join(root, 'Tabby', 'launchers');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, WSL_LAUNCHER);
    writeFileSync(file, '@cmd.exe /c echo hi\r\n');
    assert.equal(await handleWslHere(wslLauncherArgv(file), { profiles: refuse, command: 'wsl.exe' }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
