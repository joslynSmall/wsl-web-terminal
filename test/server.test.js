import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { createServer, createHostCheck, reachableBridgeUrls } from '../src/server.js';
import { SessionHub } from '../src/session-hub.js';

async function start(t, { heartbeatMs } = {}) {
  const { server, hub } = createServer({ heartbeatMs, hub: new SessionHub({ commandTimeoutMs: 500, newSessionTimeoutMs: 500, snapshotTimeoutMs: 500 }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const sockets = new Set();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  });

  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  const connect = (path, headers = {}, options = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, ...options });
    sockets.add(ws);
    ws.messages = [];
    ws.on('message', (data) => ws.messages.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', reject);
  });

  const until = async (predicate, what) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  return { port, hub, request, connect, until };
}

async function connectBridge(s, id = 'b', sessions = [{ id: `${id}.1`, title: 'PowerShell', cols: 100, rows: 30 }]) {
  const bridge = await s.connect('/ws/bridge');
  bridge.send(JSON.stringify({ type: 'hello', bridgeId: id }));
  bridge.send(JSON.stringify({ type: 'sessions', sessions }));
  await s.until(() => s.hub.list().sessions.length === sessions.length, 'sessions to register');
  return bridge;
}

test('a browser sees what the Bridge reports, gets the screen first, then live output, and its typing reaches Tabby', async (t) => {
  const s = await start(t);
  const bridge = await connectBridge(s);

  const list = await s.request('/api/sessions');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.sessions, [{ id: 'b.1', title: 'PowerShell', cols: 100, rows: 30, windowNo: 1, origin: '', environment: '' }]);
  assert.equal(list.json.showOrigin, false);
  assert.equal(list.json.bridges, 1);

  const browser = await s.connect('/ws/terminal?session=b.1');
  await s.until(() => bridge.messages.some((m) => m.type === 'snapshot-request'), 'snapshot request');
  const { reqId } = bridge.messages.find((m) => m.type === 'snapshot-request');
  bridge.send(JSON.stringify({ type: 'output', id: 'b.1', seq: 2, data: 'during' }));
  bridge.send(JSON.stringify({ type: 'snapshot', id: 'b.1', reqId, seq: 1, data: 'SCREEN', cols: 100, rows: 30 }));
  bridge.send(JSON.stringify({ type: 'output', id: 'b.1', seq: 3, data: 'live' }));
  await s.until(() => browser.messages.length === 3, 'snapshot and output');
  assert.deepEqual(browser.messages, [
    { t: 'snapshot', data: 'SCREEN', cols: 100, rows: 30 },
    { t: 'output', data: 'during' },
    { t: 'output', data: 'live' }
  ]);

  browser.send(JSON.stringify({ t: 'input', data: 'dir\r' }));
  await s.until(() => bridge.messages.some((m) => m.type === 'input'), 'input');
  assert.deepEqual(bridge.messages.find((m) => m.type === 'input'), { type: 'input', id: 'b.1', data: 'dir\r' });

  browser.close();
  await s.until(() => bridge.messages.some((m) => m.type === 'watch' && m.on === false), 'unwatch');
});

test('creating, renaming and closing go through the Bridge', async (t) => {
  const s = await start(t);
  const bridge = await connectBridge(s);

  const created = s.request('/api/sessions', { method: 'POST' });
  await s.until(() => bridge.messages.some((m) => m.type === 'create-in'), 'create command');
  const create = bridge.messages.find((m) => m.type === 'create-in');
  bridge.send(JSON.stringify({ type: 'sessions', sessions: [
    { id: 'b.1', title: 'PowerShell', cols: 100, rows: 30 },
    { id: 'b.2', title: 'New tab', cols: 100, rows: 30 }
  ] }));
  bridge.send(JSON.stringify({ type: 'result', reqId: create.reqId, ok: true }));
  const result = await created;
  assert.equal(result.status, 201);
  assert.equal(result.json.session.id, 'b.2');

  const renamed = s.request('/api/sessions/b.2/rename', { method: 'POST', body: { name: 'logs' } });
  await s.until(() => bridge.messages.some((m) => m.type === 'rename'), 'rename command');
  const rename = bridge.messages.find((m) => m.type === 'rename');
  assert.equal(rename.name, 'logs');
  bridge.send(JSON.stringify({ type: 'result', reqId: rename.reqId, ok: true }));
  assert.equal((await renamed).status, 200);

  const closing = s.request('/api/sessions/b.2', { method: 'DELETE' });
  await s.until(() => bridge.messages.some((m) => m.type === 'close'), 'close command');
  bridge.send(JSON.stringify({ type: 'result', reqId: bridge.messages.find((m) => m.type === 'close').reqId, ok: false, error: 'pinned tab' }));
  const refused = await closing;
  assert.equal(refused.status, 502);
  assert.match(refused.json.error, /pinned tab/);
});

test('API errors carry sensible statuses', async (t) => {
  const s = await start(t);
  assert.equal((await s.request('/api/sessions', { method: 'POST' })).status, 503, 'no Bridge connected');
  assert.equal((await s.request('/api/sessions/nope', { method: 'DELETE' })).status, 404);
  await connectBridge(s);
  assert.equal((await s.request('/api/sessions/b.1/rename', { method: 'POST', body: { name: '  ' } })).status, 400);
  const unknown = await s.connect('/ws/terminal?session=nope');
  assert.equal(await new Promise((resolve) => unknown.on('close', resolve)), 4404, 'unknown session closes the socket with 4404');
});

test('when the Bridge goes away the session list empties and viewers are closed', async (t) => {
  const s = await start(t);
  const bridge = await connectBridge(s);
  const browser = await s.connect('/ws/terminal?session=b.1');
  const closed = new Promise((resolve) => browser.on('close', (code) => resolve(code)));
  bridge.close();
  assert.equal(await closed, 4410);
  await s.until(() => s.hub.list().bridges === 0, 'bridge removal');
  assert.deepEqual((await s.request('/api/sessions')).json.sessions, []);
});

test('malformed websocket frames cannot crash the server', async (t) => {
  const s = await start(t);
  const bridge = await connectBridge(s);
  const browser = await s.connect('/ws/terminal?session=b.1');
  for (const ws of [bridge, browser]) {
    ws.send('not json');
    ws.send('{"type":');
    ws.send(JSON.stringify({ t: 'resize', cols: 'x' }));
    ws.send(Buffer.from([0xff, 0xfe, 0x00]));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await s.request('/api/sessions')).status, 200);
});

test('another website cannot drive the terminals through the browser', async (t) => {
  const s = await start(t);
  await connectBridge(s);

  const evil = { Origin: 'http://evil.example' };
  await assert.rejects(s.connect('/ws/terminal?session=b.1', evil), (err) => err.status === 403);
  await assert.rejects(s.connect('/ws/bridge', evil), (err) => err.status === 403, 'a web page cannot pose as a Bridge either');
  assert.equal((await s.request('/api/sessions', { method: 'POST', headers: evil })).status, 403);
  assert.equal((await s.request('/api/sessions/b.1', { method: 'DELETE', headers: evil })).status, 403);

  const same = { Origin: `http://127.0.0.1:${s.port}` };
  assert.equal((await s.request('/api/sessions', { headers: same })).status, 200);
  const browser = await s.connect('/ws/terminal?session=b.1', same);
  assert.equal(browser.readyState, WebSocket.OPEN);
  const bridge = await s.connect('/ws/bridge', { Origin: 'file://' });
  assert.equal(bridge.readyState, WebSocket.OPEN, 'Electron pages send a non-http origin');
});

test('requests with a host name we do not serve are refused (DNS rebinding)', async (t) => {
  const s = await start(t);
  assert.equal((await s.request('/api/sessions', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await s.request('/', { headers: { Host: 'evil.example:7890' } })).status, 403);
  await assert.rejects(s.connect('/ws/terminal?session=b.1', { Host: 'evil.example' }), (err) => err.status === 403);
  assert.equal((await s.request('/api/sessions', { headers: { Host: `localhost:${s.port}` } })).status, 200);
  assert.equal((await s.request('/api/sessions', { headers: { Host: '192.168.1.20:7890' } })).status, 200);
});

test('host check accepts IPs, localhost and configured names only', () => {
  const allowed = createHostCheck('my-pc.lan, Other');
  for (const host of ['localhost', 'localhost:7890', '127.0.0.1', '192.168.1.5:80', '[::1]:7890', 'my-pc.lan', 'OTHER:1']) {
    assert.equal(allowed(host), true, host);
  }
  for (const host of ['evil.example', 'evil.example:7890', '', undefined, 'localhost.evil.example']) {
    assert.equal(allowed(host), false, String(host));
  }
});

test('the web page and xterm are served', async (t) => {
  const s = await start(t);
  const index = await s.request('/');
  assert.equal(index.status, 200);
  assert.match(index.text, /WSL Web Terminal Hub/);
  assert.equal((await s.request('/app.js')).status, 200);
  assert.equal((await s.request('/vendor/xterm/css/xterm.css')).status, 200);
  assert.equal((await s.request('/vendor/xterm/lib/xterm.js')).status, 200);
  assert.equal((await s.request('/vendor/addon-web-links/lib/addon-web-links.js')).status, 200);
});

test('heartbeat keeps healthy connections open and drops the ones that stop answering pings', async (t) => {
  const s = await start(t, { heartbeatMs: 40 });
  const bridge = await connectBridge(s);
  const browser = await s.connect('/ws/terminal?session=b.1');
  const mute = await s.connect('/ws/terminal?session=b.1', {}, { autoPong: false });
  const muteClosed = new Promise((resolve) => mute.on('close', resolve));

  await muteClosed;
  await new Promise((resolve) => setTimeout(resolve, 200)); // several more heartbeat rounds
  assert.equal(bridge.readyState, WebSocket.OPEN, 'a Bridge that answers pings must stay connected');
  assert.equal(browser.readyState, WebSocket.OPEN);
  assert.equal(s.hub.list().bridges, 1);
});

test('MIRROR-B06 the addresses offered to the other side are the non-loopback IPv4 ones', () => {
  const urls = reachableBridgeUrls(7890, {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.15.188', family: 'IPv4', internal: false }],
    eth1: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.77.1', family: 4, internal: false }
    ]
  });
  assert.deepEqual(urls, ['ws://192.168.15.188:7890', 'ws://192.168.77.1:7890']);
  assert.deepEqual(reachableBridgeUrls(7890, { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), []);
});
