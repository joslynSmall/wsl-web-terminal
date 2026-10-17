import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DEFAULT_SESSION = 'wsl-web';

export class TmuxService {
  constructor(defaultSession = DEFAULT_SESSION) {
    this.defaultSession = defaultSession;
  }

  async ensureSession() {
    try {
      await execFileAsync('tmux', ['has-session', '-t', this.defaultSession]);
    } catch {
      await execFileAsync('tmux', [
        'new-session',
        '-d',
        '-s',
        this.defaultSession,
        '-n',
        'shell-1'
      ]);
    }

    await execFileAsync('tmux', [
      'set-option', '-t', this.defaultSession, 'terminal-overrides', ',xterm*:smcup@:rmcup@'
    ]).catch(() => {});
    await execFileAsync('tmux', [
      'set-option', '-t', this.defaultSession, 'mouse', 'on'
    ]).catch(() => {});

    const { stdout } = await execFileAsync('tmux', [
      'list-sessions', '-F', '#{session_name}:::#{session_attached}'
    ]);
    for (const line of stdout.trim().split('\n')) {
      const [name, attached] = line.split(':::');
      const match = /^term-client-([1-9]\d*)$/.exec(name);
      if (!match || attached !== '0') continue;
      try {
        process.kill(Number(match[1]), 0);
      } catch (err) {
        if (err.code !== 'ESRCH') continue;
        await execFileAsync('tmux', [
          'if-shell', '-F', '-t', name, '#{==:#{session_attached},0}',
          `kill-session -t '${name}'`
        ]).catch(() => {});
      }
    }
  }

  async listWindows() {
    await this.ensureSession();
    const format = '#{session_name}:::#{window_id}:::#{window_index}:::#{window_name}:::#{window_active}:::#{window_width}:::#{window_height}:::#{pane_current_command}:::#{pane_current_path}';
    const { stdout } = await execFileAsync('tmux', ['list-windows', '-t', this.defaultSession, '-F', format]);

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const [session, id, index, name, active, width, height, command, path] = line.split(':::');
      return {
        id,
        target: `${session}:${index}`,
        session,
        index: parseInt(index, 10),
        name,
        active: active === '1',
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        command: command || 'shell',
        path: path || ''
      };
    });
  }

  async createWindow(name, session = this.defaultSession) {
    await this.ensureSession();
    const args = ['new-window', '-d', '-P', '-F', '#{session_name}:#{window_index}', '-t', session];
    if (name) {
      args.push('-n', name);
    }
    const { stdout } = await execFileAsync('tmux', args);
    const target = stdout.trim();
    const windows = await this.listWindows();
    return windows.find((w) => w.target === target) || { target, name: name || 'shell' };
  }

  async attachOrCloneShell({ pid, tty, cwd, comm, name }) {
    await this.ensureSession();
    const shortTty = (tty || '').replace('/dev/', '');
    const windowName = name || `${comm || 'shell'}-${shortTty || pid}`;
    const targetCwd = (cwd && cwd !== 'unknown') ? cwd : process.env.HOME || '/home/joslyn';

    const windows = await this.listWindows();
    const existing = windows.find(w => w.name === windowName && w.session === this.defaultSession);
    if (existing) {
      return existing;
    }

    const args = ['new-window', '-d', '-P', '-F', '#{session_name}:#{window_index}', '-t', this.defaultSession, '-n', windowName, '-c', targetCwd];
    const { stdout } = await execFileAsync('tmux', args);
    const target = stdout.trim();
    const updatedWindows = await this.listWindows();
    return updatedWindows.find(w => w.target === target) || { target, name: windowName, session: this.defaultSession, path: targetCwd };
  }

  async killWindow(target) {
    const parts = target.split(':');
    const winIndex = parts[1];

    try {
      const { stdout } = await execFileAsync('tmux', [
        'list-clients',
        '-F',
        '#{client_name}:::#{session_name}:::#{window_index}'
      ]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const [cname, sname, windex] = line.split(':::');
        if (windex === winIndex) {
          await execFileAsync('tmux', ['detach-client', '-t', cname]).catch(() => {});
        }
      }
    } catch {}

    await execFileAsync('tmux', ['kill-window', '-t', target]).catch(() => {});
    try {
      const windows = await this.listWindows();
      if (windows.length === 0) {
        await this.ensureSession();
      }
    } catch {
      await this.ensureSession();
    }
  }

  async renameWindow(target, newName) {
    await execFileAsync('tmux', ['rename-window', '-t', target, newName]);
  }
}
