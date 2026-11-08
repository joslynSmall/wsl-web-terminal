import express from 'express';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocketServer } from 'ws';
import { SessionHub, HubError } from './session-hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const HEARTBEAT_MS = 30000;

/** Hosts we answer to: IP literals, localhost, this machine's name, plus ALLOWED_HOSTS (comma separated). Blocks DNS rebinding. */
export function createHostCheck(extraHosts = process.env.ALLOWED_HOSTS || '') {
  const allowed = new Set(
    ['localhost', os.hostname(), ...extraHosts.split(',')]
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
  return (hostHeader) => {
    if (!hostHeader) return false;
    const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim());
    if (!match) return false;
    const host = match[1].replace(/^\[|\]$/g, '').toLowerCase();
    return net.isIP(host) !== 0 || allowed.has(host);
  };
}

/** Browsers must be same-origin; the Bridge runs inside Electron, which sends no Origin or a non-http one. */
function originMatchesHost(origin, hostHeader) {
  try {
    return new URL(origin).host.toLowerCase() === String(hostHeader || '').toLowerCase();
  } catch {
    return false;
  }
}

function isBridgeOrigin(origin) {
  return !origin || !/^https?:/i.test(origin);
}

export function createServer({ hub = new SessionHub({ log: (m) => console.log(m) }), allowedHosts, heartbeatMs = HEARTBEAT_MS } = {}) {
  const hostAllowed = createHostCheck(allowedHosts);
  const app = express();
  const server = http.createServer(app);
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host)) {
      return res.status(403).json({ success: false, error: 'Host not allowed' });
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !originMatchesHost(origin, req.headers.host)) {
      return res.status(403).json({ success: false, error: 'Cross-origin request refused' });
    }
    next();
  });

  app.use(express.json());
  app.use(express.static(path.join(projectRoot, 'public')));
  app.use('/vendor/xterm', express.static(path.join(projectRoot, 'node_modules/@xterm/xterm')));
  app.use('/vendor/addon-web-links', express.static(path.join(projectRoot, 'node_modules/@xterm/addon-web-links')));

  const handle = (fn) => async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req, res)) });
    } catch (err) {
      const status = err instanceof HubError ? err.status : 500;
      res.status(status).json({ success: false, error: err.message });
    }
  };

  app.get('/api/sessions', handle(() => hub.list()));

  app.post('/api/sessions', async (_req, res) => {
    try {
      const session = await hub.createSession();
      res.status(201).json({ success: true, session });
    } catch (err) {
      res.status(err instanceof HubError ? err.status : 500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/sessions/:id/rename', handle(async (req) => {
    await hub.renameSession(req.params.id, req.body?.name);
    return {};
  }));

  app.delete('/api/sessions/:id', handle(async (req) => {
    await hub.closeSession(req.params.id);
    return {};
  }));

  // handleUpgrade's callback does not emit 'connection', so liveness tracking is set up here.
  const accept = (wss, request, socket, head, onConnection) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      onConnection(ws);
    });
  };

  server.on('upgrade', (request, socket, head) => {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!hostAllowed(request.headers.host)) return reject(403, 'Forbidden');
    let url;
    try {
      url = new URL(request.url, 'http://placeholder');
    } catch {
      return reject(400, 'Bad Request');
    }
    const origin = request.headers.origin;

    if (url.pathname === '/ws/terminal') {
      if (origin && !originMatchesHost(origin, request.headers.host)) return reject(403, 'Forbidden');
      const sessionId = url.searchParams.get('session') || '';
      accept(browserWss, request, socket, head, (ws) => {
        const handle = hub.addViewer(sessionId, wrapSocket(ws));
        if (!handle) return;
        ws.on('message', (data) => handle.onMessage(data));
        ws.on('close', () => handle.onClose());
        ws.on('error', () => {});
      });
    } else if (url.pathname === '/ws/bridge') {
      if (!isBridgeOrigin(origin)) return reject(403, 'Forbidden');
      accept(bridgeWss, request, socket, head, (ws) => {
        const handle = hub.addBridge(wrapSocket(ws));
        ws.on('message', (data) => handle.onMessage(data));
        ws.on('close', () => handle.onClose());
        ws.on('error', () => {});
      });
    } else {
      socket.destroy();
    }
  });

  // Drop connections that stopped answering pings (sleeping phones, dead NAT entries).
  const heartbeat = setInterval(() => {
    for (const wss of [browserWss, bridgeWss]) {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  server.on('close', () => clearInterval(heartbeat));

  return { app, server, hub };
}

function wrapSocket(ws) {
  return {
    send: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    bufferedAmount: () => ws.bufferedAmount,
    close: (code, reason) => ws.close(code, reason)
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const PORT = Number(process.env.PORT) || 7890;
  const HOST = process.env.HOST || '0.0.0.0';
  const { server } = createServer();
  server.listen(PORT, HOST, () => {
    console.log('=======================================================');
    console.log('WSL Web Terminal Server is running (Tabby mirror)');
    console.log(`URL: http://localhost:${PORT}   Bridge endpoint: ws://localhost:${PORT}/ws/bridge`);
    console.log(`Listening on ${HOST}; there is no authentication.`);
    console.log('=======================================================');
  });
}
