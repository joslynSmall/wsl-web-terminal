import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionHub, HubError } from '../src/session-hub.js';

function channel() {
  const ch = {
    sent: [],
    closed: null,
    buffered: 0,
    send(text) { ch.sent.push(JSON.parse(text)); },
    bufferedAmount() { return ch.buffered; },
    close(code, reason) { ch.closed = { code, reason }; },
    types(key = 'type') { return ch.sent.map((m) => m[key]); },
    last(type, key = 'type') { return [...ch.sent].reverse().find((m) => m[key] === type); }
  };
  return ch;
}

function connectBridge(hub, bridgeId, sessions = [], origin) {
  const ch = channel();
  const handle = hub.addBridge(ch);
  const hello = { type: 'hello', bridgeId };
  if (origin !== undefined) hello.origin = origin;
  handle.onMessage(JSON.stringify(hello));
  if (sessions.length) handle.onMessage(JSON.stringify({ type: 'sessions', sessions }));
  const send = (message) => handle.onMessage(JSON.stringify(message));
  return { ch, handle, send };
}

const tab = (id, title = id, cols = 80, rows = 24) => ({ id, title, cols, rows });

test('sessions from several Bridges are listed by window, then by Tabby order', () => {
  const hub = new SessionHub();
  connectBridge(hub, 'b1', [tab('b1.2', 'two'), tab('b1.1', 'one')]);
  connectBridge(hub, 'b2', [tab('b2.1', 'other')]);
  const { bridges, sessions } = hub.list();
  assert.equal(bridges, 2);
  assert.deepEqual(sessions.map((s) => [s.id, s.windowNo]), [['b1.2', 1], ['b1.1', 1], ['b2.1', 2]]);
});

test('messages before hello are ignored and malformed input never throws', () => {
  const hub = new SessionHub();
  const handle = hub.addBridge(channel());
  handle.onMessage(JSON.stringify({ type: 'sessions', sessions: [tab('x')] }));
  handle.onMessage('not json');
  handle.onMessage('null');
  handle.onMessage(JSON.stringify({ type: 'hello' }));
  assert.deepEqual(hub.list(), { bridges: 0, sessions: [], focusedId: null, showOrigin: false });
});

test('list() names the session that has focus in the most recently focused Tabby window', () => {
  let t = 0;
  const hub = new SessionHub({ now: () => ++t });
  const b1 = connectBridge(hub, 'b1', [tab('b1.1'), { ...tab('b1.2'), focused: true }]);
  const b2 = connectBridge(hub, 'b2', [{ ...tab('b2.1'), focused: true }]);
  assert.equal(hub.list().focusedId, 'b2.1', 'b2 connected last, so it is the most recently focused window');
  b1.send({ type: 'focus' });
  assert.equal(hub.list().focusedId, 'b1.2');
  b1.send({ type: 'sessions', sessions: [{ ...tab('b1.1'), focused: true }, tab('b1.2')] });
  assert.equal(hub.list().focusedId, 'b1.1', 'focus moved inside the window');
  b1.send({ type: 'sessions', sessions: [tab('b1.1'), tab('b1.2')] });
  assert.equal(hub.list().focusedId, 'b2.1', 'a window with no focused pane falls back to the next window');
  b2.send({ type: 'sessions', sessions: [tab('b2.1')] });
  assert.equal(hub.list().focusedId, null);
  assert.ok(!('focused' in hub.list().sessions[0]), 'the per-session focus flag is not exposed');
});

test('a session id owned by another Bridge cannot be hijacked', () => {
  const hub = new SessionHub();
  connectBridge(hub, 'b1', [tab('shared', 'mine')]);
  connectBridge(hub, 'b2', [tab('shared', 'stolen')]);
  assert.equal(hub.list().sessions.length, 1);
  assert.equal(hub.list().sessions[0].title, 'mine');
});

test('a viewer receives the snapshot first, then only output newer than the snapshot', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const view = channel();
  const viewer = hub.addViewer('b1.1', view);

  assert.deepEqual(bridge.ch.types(), ['watch', 'snapshot-request']);
  const { reqId } = bridge.ch.last('snapshot-request');

  // Output racing with the snapshot: seq 4 is already inside it, seq 5 and 6 are not.
  bridge.send({ type: 'output', id: 'b1.1', seq: 4, data: 'old' });
  bridge.send({ type: 'output', id: 'b1.1', seq: 5, data: 'new1' });
  bridge.send({ type: 'output', id: 'b1.1', seq: 6, data: 'new2' });
  assert.deepEqual(view.sent, [], 'nothing is shown before the snapshot');

  bridge.send({ type: 'snapshot', id: 'b1.1', reqId, seq: 4, data: 'SCREEN', cols: 100, rows: 30 });
  assert.deepEqual(view.sent, [
    { t: 'snapshot', data: 'SCREEN', cols: 100, rows: 30 },
    { t: 'output', data: 'new1' },
    { t: 'output', data: 'new2' }
  ]);

  bridge.send({ type: 'output', id: 'b1.1', seq: 7, data: 'live' });
  assert.deepEqual(view.sent.at(-1), { t: 'output', data: 'live' });
  assert.ok(viewer);
});

test('a snapshot answering an older request is ignored', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const view = channel();
  hub.addViewer('b1.1', view);
  bridge.send({ type: 'snapshot', id: 'b1.1', reqId: 'stale', seq: 1, data: 'X', cols: 80, rows: 24 });
  assert.deepEqual(view.sent, []);
});

test('the Bridge is told to watch only while someone is viewing', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const a = hub.addViewer('b1.1', channel());
  const b = hub.addViewer('b1.1', channel());
  assert.equal(bridge.ch.sent.filter((m) => m.type === 'watch').length, 1);
  a.onClose();
  assert.equal(bridge.ch.sent.filter((m) => m.type === 'watch').length, 1);
  b.onClose();
  assert.deepEqual(bridge.ch.last('watch'), { type: 'watch', id: 'b1.1', on: false });
});

test('viewer input is forwarded to the owning Bridge; oversized or malformed input is dropped', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const viewer = hub.addViewer('b1.1', channel());
  viewer.onMessage(JSON.stringify({ t: 'input', data: 'ls\r' }));
  viewer.onMessage(JSON.stringify({ t: 'input', data: 'x'.repeat(70000) }));
  viewer.onMessage('ls\r');
  viewer.onMessage(JSON.stringify({ t: 'input', data: 5 }));
  assert.deepEqual(bridge.ch.sent.filter((m) => m.type === 'input'), [{ type: 'input', id: 'b1.1', data: 'ls\r' }]);
});

test('an unknown session closes the viewer with 4404', () => {
  const hub = new SessionHub();
  const view = channel();
  assert.equal(hub.addViewer('nope', view), null);
  assert.equal(view.closed.code, 4404);
});

test('a size change reaches settled viewers', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const view = channel();
  hub.addViewer('b1.1', view);
  const { reqId } = bridge.ch.last('snapshot-request');
  bridge.send({ type: 'snapshot', id: 'b1.1', reqId, seq: 0, data: '', cols: 80, rows: 24 });
  bridge.send({ type: 'sessions', sessions: [tab('b1.1', 'b1.1', 120, 40)] });
  assert.deepEqual(view.sent.at(-1), { t: 'size', cols: 120, rows: 40 });
});

test('closing a session in Tabby closes its viewers; losing the Bridge removes everything', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1'), tab('b1.2')]);
  const v1 = channel();
  const v2 = channel();
  hub.addViewer('b1.1', v1);
  hub.addViewer('b1.2', v2);

  bridge.send({ type: 'sessions', sessions: [tab('b1.2')] });
  assert.equal(v1.closed.code, 4410);
  assert.equal(v2.closed, null);

  bridge.handle.onClose();
  assert.equal(v2.closed.code, 4410);
  assert.deepEqual(hub.list(), { bridges: 0, sessions: [], focusedId: null, showOrigin: false });
});

test('a slow viewer is caught up with a fresh snapshot instead of being buffered without limit', () => {
  const hub = new SessionHub({ viewerSendLimit: 100 });
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const view = channel();
  hub.addViewer('b1.1', view);
  const first = bridge.ch.last('snapshot-request');
  bridge.send({ type: 'snapshot', id: 'b1.1', reqId: first.reqId, seq: 0, data: '', cols: 80, rows: 24 });

  view.buffered = 5000;
  bridge.send({ type: 'output', id: 'b1.1', seq: 1, data: 'dropped' });
  const second = bridge.ch.last('snapshot-request');
  assert.notEqual(second.reqId, first.reqId);
  assert.ok(!view.sent.some((m) => m.data === 'dropped'));

  bridge.send({ type: 'output', id: 'b1.1', seq: 2, data: 'kept' });
  bridge.send({ type: 'snapshot', id: 'b1.1', reqId: second.reqId, seq: 1, data: 'RESYNC', cols: 80, rows: 24 });
  view.buffered = 0;
  assert.deepEqual(view.sent.slice(-2), [
    { t: 'snapshot', data: 'RESYNC', cols: 80, rows: 24 },
    { t: 'output', data: 'kept' }
  ]);
});

test('output piling up while waiting for a snapshot restarts the snapshot', () => {
  const hub = new SessionHub({ viewerBufferLimit: 10 });
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  hub.addViewer('b1.1', channel());
  const first = bridge.ch.last('snapshot-request');
  bridge.send({ type: 'output', id: 'b1.1', seq: 1, data: 'x'.repeat(50) });
  assert.notEqual(bridge.ch.last('snapshot-request').reqId, first.reqId);
});

test('a missing snapshot falls back to live output after the timeout', async () => {
  const hub = new SessionHub({ snapshotTimeoutMs: 20 });
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const view = channel();
  hub.addViewer('b1.1', view);
  bridge.send({ type: 'output', id: 'b1.1', seq: 1, data: 'buffered' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(view.sent, [
    { t: 'snapshot', data: '', cols: 80, rows: 24 },
    { t: 'output', data: 'buffered' }
  ]);
});

test('creating a session targets the most recently focused window and returns the new session', async () => {
  let clock = 0;
  const hub = new SessionHub({ now: () => ++clock });
  const a = connectBridge(hub, 'a', [tab('a.1')]);
  const b = connectBridge(hub, 'b', [tab('b.1')]);
  a.send({ type: 'focus' });

  const creating = hub.createSession();
  const command = a.ch.last('create-in');
  assert.ok(command, 'window A was focused last');
  assert.equal(b.ch.last('create-in'), undefined);
  assert.equal(command.environment, 'Windows');
  assert.equal(command.cwd, '');
  a.send({ type: 'sessions', sessions: [tab('a.1'), tab('a.2', 'fresh')] });
  a.send({ type: 'result', reqId: command.reqId, ok: true });
  const created = await creating;
  assert.equal(created.id, 'a.2');
  assert.equal(created.windowNo, 1);
});

test('creating without a connected Bridge fails with 503', async () => {
  await assert.rejects(new SessionHub().createSession(), (err) => err instanceof HubError && err.status === 503);
});

test('a refused command surfaces Tabby\'s error; a silent Bridge times out', async () => {
  const hub = new SessionHub({ commandTimeoutMs: 30 });
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);

  const renaming = hub.renameSession('b1.1', ' new name ');
  const command = bridge.ch.last('rename');
  assert.equal(command.name, 'new name');
  bridge.send({ type: 'result', reqId: command.reqId, ok: false, error: 'boom' });
  await assert.rejects(renaming, /boom/);

  await assert.rejects(hub.closeSession('b1.1'), (err) => err.status === 504);
  await assert.rejects(hub.closeSession('missing'), (err) => err.status === 404);
  await assert.rejects(hub.renameSession('b1.1', '  '), (err) => err.status === 400);
});

test('reconnecting with the same bridgeId replaces the old connection', () => {
  const hub = new SessionHub();
  const first = connectBridge(hub, 'same', [tab('same.1')]);
  const second = connectBridge(hub, 'same', [tab('same.1')]);
  assert.equal(first.ch.closed.code, 4409);
  first.handle.onClose();
  assert.equal(hub.list().sessions.length, 1, 'the old socket closing must not remove the new one\'s sessions');
  assert.equal(hub.list().bridges, 1);
  assert.ok(second);
});

test('the Bridge version from hello is logged so a stale plugin is easy to spot', () => {
  const lines = [];
  const hub = new SessionHub({ log: (line) => lines.push(line) });
  const ch = channel();
  hub.addBridge(ch).onMessage(JSON.stringify({ type: 'hello', bridgeId: 'x', version: '0.1.1' }));
  assert.match(lines[0], /W1 connected .* version 0\.1\.1/);

  const old = channel();
  hub.addBridge(old).onMessage(JSON.stringify({ type: 'hello', bridgeId: 'y' }));
  assert.match(lines[1], /version unknown/, 'an older Bridge that does not report a version');
});

test('MIRROR-B01 one origin does not ask the page to show it, even across two windows', () => {
  const hub = new SessionHub();
  connectBridge(hub, 'a', [tab('a.1', 'one')], 'Windows');
  connectBridge(hub, 'b', [tab('b.1', 'two')], 'Windows');
  const list = hub.list();
  assert.equal(list.showOrigin, false);
  assert.deepEqual(list.sessions.map((s) => s.origin), ['Windows', 'Windows']);
});

test('MIRROR-B02 a second origin is listed on every session and the page is told to show it', () => {
  const hub = new SessionHub();
  connectBridge(hub, 'win', [tab('win.1')], 'Windows');
  connectBridge(hub, 'wsl', [tab('wsl.1')], 'WSL');
  const list = hub.list();
  assert.equal(list.showOrigin, true);
  assert.deepEqual(list.sessions.map((s) => [s.id, s.origin]), [['win.1', 'Windows'], ['wsl.1', 'WSL']]);
});

test('MIRROR-B03 a Bridge that reports no origin, or an unrecognised one, is listed with an empty origin', () => {
  const hub = new SessionHub();
  connectBridge(hub, 'old', [tab('old.1')]);
  connectBridge(hub, 'odd', [tab('odd.1')], 'linux');
  connectBridge(hub, 'wsl', [tab('wsl.1')], 'WSL');
  const list = hub.list();
  assert.equal(list.showOrigin, true);
  assert.equal(list.sessions.find((s) => s.id === 'old.1').origin, '');
  assert.equal(list.sessions.find((s) => s.id === 'odd.1').origin, '');
  assert.equal(list.sessions.find((s) => s.id === 'wsl.1').origin, 'WSL');
});

test('MIRROR-B04 dropping one origin removes only its sessions and hides the origin label', () => {
  const hub = new SessionHub();
  const win = connectBridge(hub, 'win', [tab('win.1')], 'Windows');
  connectBridge(hub, 'wsl', [tab('wsl.1')], 'WSL');
  assert.equal(hub.list().showOrigin, true);
  win.handle.onClose();
  const list = hub.list();
  assert.deepEqual(list.sessions.map((s) => s.id), ['wsl.1']);
  assert.equal(list.showOrigin, false);
});

test('MIRROR-B05 creating a session still targets the most recently focused Bridge when origins differ', async () => {
  let clock = 0;
  const hub = new SessionHub({ now: () => ++clock });
  const win = connectBridge(hub, 'win', [tab('win.1')], 'Windows');
  const wsl = connectBridge(hub, 'wsl', [tab('wsl.1')], 'WSL');
  wsl.send({ type: 'focus' });
  const creating = hub.createSession();
  const command = wsl.ch.last('create-in');
  assert.ok(command);
  assert.equal(win.ch.last('create-in'), undefined);
  wsl.send({ type: 'sessions', sessions: [tab('wsl.1'), tab('wsl.2', 'fresh')] });
  wsl.send({ type: 'result', reqId: command.reqId, ok: true });
  assert.equal((await creating).id, 'wsl.2');
});

test('MIRROR-B07 a viewer resize is forwarded to the owning Bridge; invalid sizes are dropped', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const viewer = hub.addViewer('b1.1', channel());
  viewer.onMessage(JSON.stringify({ t: 'resize', cols: 200, rows: 52 }));
  viewer.onMessage(JSON.stringify({ t: 'resize', cols: 0, rows: 52 }));
  viewer.onMessage(JSON.stringify({ t: 'resize', cols: 'x', rows: 52 }));
  viewer.onMessage(JSON.stringify({ t: 'resize', cols: 5000, rows: 52 }));
  assert.deepEqual(bridge.ch.sent.filter((m) => m.type === 'resize'), [{ type: 'resize', id: 'b1.1', cols: 200, rows: 52 }]);
});

test('MIRROR-B10 with two viewers on one pane every resize is forwarded, so the last one wins', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const desktop = hub.addViewer('b1.1', channel());
  const phone = hub.addViewer('b1.1', channel());
  desktop.onMessage(JSON.stringify({ t: 'resize', cols: 200, rows: 52 }));
  phone.onMessage(JSON.stringify({ t: 'resize', cols: 51, rows: 45 }));
  assert.deepEqual(bridge.ch.last('resize'), { type: 'resize', id: 'b1.1', cols: 51, rows: 45 });
});

test('MIRROR-B08 the Bridge is told to stop watching only when the last viewer of a pane leaves', () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const a = hub.addViewer('b1.1', channel());
  const b = hub.addViewer('b1.1', channel());
  a.onClose();
  assert.equal(bridge.ch.sent.filter((m) => m.type === 'watch' && m.on === false).length, 0);
  b.onClose();
  assert.deepEqual(bridge.ch.last('watch'), { type: 'watch', id: 'b1.1', on: false });
});

test('MIRROR-B12 creating a Windows terminal forwards the environment and working directory', async () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const creating = hub.createSession({ environment: 'Windows', cwd: 'C:\\Users\\joslyn\\code' });
  const command = bridge.ch.last('create-in');
  assert.equal(command.environment, 'Windows');
  assert.equal(command.cwd, 'C:\\Users\\joslyn\\code');
  bridge.send({ type: 'sessions', sessions: [tab('b1.1'), tab('b1.2', 'fresh')] });
  bridge.send({ type: 'result', reqId: command.reqId, ok: true });
  assert.equal((await creating).id, 'b1.2');
});

test('MIRROR-B13 creating a WSL terminal forwards the environment and the Linux working directory', async () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const creating = hub.createSession({ environment: 'WSL', cwd: '/home/joslyn/code' });
  const command = bridge.ch.last('create-in');
  assert.equal(command.environment, 'WSL');
  assert.equal(command.cwd, '/home/joslyn/code');
  bridge.send({ type: 'sessions', sessions: [tab('b1.1'), tab('b1.2', 'fresh')] });
  bridge.send({ type: 'result', reqId: command.reqId, ok: true });
  assert.equal((await creating).id, 'b1.2');
});

test('MIRROR-B15 listing a directory asks the Bridge and returns what it reported', async () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const listing = hub.listDirectory('/home/joslyn');
  const command = bridge.ch.last('list-dirs');
  assert.equal(command.path, '/home/joslyn');
  bridge.send({
    type: 'result',
    reqId: command.reqId,
    ok: true,
    result: { path: '/home/joslyn', parent: '/', name: 'joslyn', directories: ['code'], files: [] }
  });
  assert.deepEqual(await listing, {
    path: '/home/joslyn', parent: '/', name: 'joslyn', directories: ['code'], files: []
  });
});

test('MIRROR-B16 a directory the Bridge cannot read surfaces as an error', async () => {
  const hub = new SessionHub();
  const bridge = connectBridge(hub, 'b1', [tab('b1.1')]);
  const listing = hub.listDirectory('/nope');
  const command = bridge.ch.last('list-dirs');
  bridge.send({ type: 'result', reqId: command.reqId, ok: false, error: '无法访问目录：/nope' });
  await assert.rejects(listing, (err) => err instanceof HubError && /无法访问目录/.test(err.message));
});

test('MIRROR-B17 a session reports the environment it runs in, next to the Bridge origin', () => {
  const hub = new SessionHub();
  connectBridge(hub, 'win', [{ id: 'win.1', title: 'PowerShell', cols: 80, rows: 24, environment: 'Windows' }], 'Windows');
  connectBridge(hub, 'wsl', [{ id: 'wsl.1', title: 'wsl', cols: 80, rows: 24, environment: 'WSL' }], 'Windows');
  const list = hub.list();
  assert.deepEqual(list.sessions.map((s) => [s.id, s.origin, s.environment]), [
    ['win.1', 'Windows', 'Windows'],
    ['wsl.1', 'Windows', 'WSL']
  ]);
});
