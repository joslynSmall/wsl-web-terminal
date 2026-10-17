import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { TmuxService } from './tmux-service.js';
import { ShellScanner } from './shell-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const tmuxService = new TmuxService();
const shellScanner = new ShellScanner();

app.use(express.json());

app.use(express.static(path.join(projectRoot, 'public')));
app.use('/vendor/xterm', express.static(path.join(projectRoot, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(projectRoot, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(projectRoot, 'node_modules/@xterm/addon-web-links')));

app.get('/api/windows', async (req, res) => {
  try {
    const windows = await tmuxService.listWindows();
    const systemShells = await shellScanner.scanSystemShells();
    res.json({ success: true, windows, systemShells });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/system-shells', async (req, res) => {
  try {
    const systemShells = await shellScanner.scanSystemShells();
    res.json({ success: true, systemShells });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/windows', async (req, res) => {
  try {
    const { name, session } = req.body || {};
    const window = await tmuxService.createWindow(name, session);
    res.status(201).json({ success: true, window });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/attach-shell', async (req, res) => {
  try {
    const { pid, tty, cwd, comm, name } = req.body || {};
    const window = await tmuxService.attachOrCloneShell({ pid, tty, cwd, comm, name });
    res.status(200).json({ success: true, window, target: window.target });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/windows/:target', async (req, res) => {
  try {
    const { target } = req.params;
    await tmuxService.killWindow(target);
    res.json({ success: true, message: `Window ${target} closed` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/system-shells/:pid', async (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || isNaN(pid) || pid <= 1) {
      return res.status(400).json({ success: false, error: 'Invalid PID' });
    }
    if (pid === process.pid || pid === process.ppid) {
      return res.status(403).json({ success: false, error: 'Cannot terminate server process' });
    }

    // Check if process is alive
    try {
      process.kill(pid, 0);
    } catch {
      return res.status(404).json({ success: false, error: 'Process not found or already exited' });
    }

    // Try graceful termination first (SIGHUP to shell)
    try {
      process.kill(pid, 'SIGHUP');
    } catch {}

    // Allow process a brief moment to exit cleanly
    await new Promise((r) => setTimeout(r, 150));

    // If still alive, escalate to SIGKILL
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {}

    res.json({ success: true, message: `Shell process ${pid} terminated` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/windows/rename', async (req, res) => {
  try {
    const { target, name } = req.body;
    if (!target || !name) {
      return res.status(400).json({ success: false, error: 'target and name required' });
    }
    await tmuxService.renameWindow(target, name);
    res.json({ success: true, message: 'Window renamed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/ws/terminal') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, request, url) => {
  const target = url.searchParams.get('target') || 'wsl-web:0';
  const cols = parseInt(url.searchParams.get('cols') || '120', 10);
  const rows = parseInt(url.searchParams.get('rows') || '35', 10);

  const parts = target.split(':');
  const session = parts[0] || 'wsl-web';
  const winIndex = parts[1] || '0';
  const webClientSession = `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  console.log(`[WS] Client attached to isolated session: ${webClientSession} -> ${target} (${cols}x${rows})`);

  let ptyProcess = null;
  try {
    ptyProcess = pty.spawn('tmux', [
      'new-session',
      '-t',
      target,
      '-s',
      webClientSession
    ], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || '/home/joslyn',
      env: {
        ...process.env,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TERM: 'xterm-256color'
      }
    });
  } catch (err) {
    console.error(`[PTY Error] Failed to spawn PTY for ${target}:`, err);
    ws.close(1011, `PTY spawn error: ${err.message}`);
    return;
  }

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ws.on('message', (message) => {
    try {
      const str = message.toString();
      if (str.startsWith('{') && str.endsWith('}')) {
        const parsed = JSON.parse(str);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          ptyProcess.resize(parsed.cols, parsed.rows);
          return;
        }
      }
      ptyProcess.write(str);
    } catch {
      ptyProcess.write(message.toString());
    }
  });

  const cleanupSession = () => {
    try {
      ptyProcess.kill();
    } catch {}
    execFile('tmux', ['kill-session', '-t', webClientSession], () => {});
  };

  ws.on('close', () => {
    console.log(`[WS] Disconnected from ${webClientSession}`);
    cleanupSession();
  });

  ptyProcess.onExit(() => {
    console.log(`[PTY] Process exited for ${webClientSession}`);
    cleanupSession();
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });
});

const PORT = process.env.PORT || 7890;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 WSL Web Terminal Server is running!`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});

export { app, server, tmuxService };
