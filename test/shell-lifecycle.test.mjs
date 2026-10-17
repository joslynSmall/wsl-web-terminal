import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import pty from 'node-pty';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url).pathname;
const bashrc = process.env.TEST_BASHRC || '/home/joslyn/.bashrc';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shell-tmux-'));
  const socket = join(dir, 'socket');
  const clients = [];
  const env = { ...process.env, TERM: 'xterm-256color', TMUX: '',
    WSL_NO_TMUX: '', VSCODE_INJECTION: '', INTELLIJ_ENVIRONMENT_READER: '',
    TEST_SOCKET: socket, TEST_LOG: join(dir, 'commands'), PATH: `${dir}:${process.env.PATH}` };
  const tmux = async (...args) => (await exec('/usr/bin/tmux',
    ['-S', socket, '-f', '/dev/null', ...args], { timeout: 10000 })).stdout.trim();
  t.after(async () => {
    for (const client of clients) {
      try { client.kill(); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await tmux('kill-server').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, 'tmux'), `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$FAIL_STAGE:$1" in
  base:new-session) [[ " $* " == *" -t "* ]] || exit 1 ;;
  client:new-session) [[ " $* " != *" -t "* ]] || exit 1 ;;
  window:new-window|select:select-window|hook:set-hook|attach:attach-session) exit 1 ;;
  empty:new-window) exit 0 ;;
esac
exec /usr/bin/tmux -S "$TEST_SOCKET" -f /dev/null "$@"
`);
  await chmod(join(dir, 'tmux'), 0o700);
  const source = await readFile(bashrc, 'utf8');
  const start = source.lastIndexOf('if [[ -z "$TMUX"');
  assert.ok(start >= 0, 'automatic tmux startup block exists');
  const startup = join(dir, 'startup.bash');
  await writeFile(startup, source.slice(start));
  await tmux('new-session', '-d', '-s', 'fixture', '/bin/bash --noprofile --norc');
  await tmux('set-option', '-g', 'default-command', '/bin/bash --noprofile --norc');
  await tmux('set-option', '-g', 'base-index', '7');
  await tmux('set-hook', '-g', 'client-attached',
    "if-shell -F '#{session_attached}' 'wait-for -S attached'");

  function shell(entry, stage = '') {
    let output = '';
    const listeners = new Set();
    const terminal = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-ic',
      'source "$1"; status=$?; printf "\\nFALLBACK:%s\\n" "$status"; read -r hold',
      'test-shell', entry === 'bashrc' ? startup : join(root, 'join.sh')],
    { env: { ...env, FAIL_STAGE: stage }, cwd: root, cols: 100, rows: 30 });
    clients.push(terminal);
    const exited = new Promise(resolve => terminal.onExit(resolve));
    terminal.onData(data => { output += data; for (const notify of listeners) notify(); });
    const fallback = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No shell fallback: ${output}`)), 10000);
      const check = () => {
        if (/FALLBACK:\d+/.test(output)) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(output);
        }
      };
      listeners.add(check);
      check();
    });
    return { terminal, exited, fallback, output: () => output, session: `term-client-${terminal.pid}` };
  }
  async function attach(entry) {
    // Register the tmux event before starting the client; no timing sleeps.
    const attached = tmux('wait-for', 'attached');
    const client = shell(entry);
    await attached;
    return client;
  }
  return { dir, env, tmux, shell, attach };
}

test('detaching either real client preserves shared windows and independent selection',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    // Given two real terminals on grouped sessions, with a nonzero base index.
    const first = await f.attach('bashrc');
    assert.equal(await f.tmux('display-message', '-p', '-t', `${first.session}:`, '#{window_index}'), '7',
      `${await f.tmux('list-sessions', '-F', '#{session_name}:#{window_index}')} ${first.session} ${first.output()}`);
    const second = await f.attach('join');
    const secondIndex = await f.tmux('display-message', '-p', '-t', second.session, '#{window_index}');
    assert.notEqual(secondIndex, '7');
    assert.equal(await f.tmux('display-message', '-p', '-t', first.session, '#{window_index}'), '7');
    const windows = await f.tmux('list-windows', '-t', 'wsl-web', '-F', '#{window_id}');
    const secondClient = await f.tmux('list-clients', '-t', second.session, '-F', '#{client_name}');
    const firstClient = await f.tmux('list-clients', '-t', first.session, '-F', '#{client_name}');
    // When one terminal detaches, its peer remains attached to its own window.
    await f.tmux('detach-client', '-t', firstClient);
    await first.exited;
    assert.equal(await f.tmux('list-windows', '-t', 'wsl-web', '-F', '#{window_id}'), windows);
    assert.equal(await f.tmux('list-clients', '-t', second.session, '-F', '#{client_name}'), secondClient);
    assert.equal(await f.tmux('display-message', '-p', '-t', second.session, '#{window_index}'), secondIndex);
    // Then detaching join also returns to the shell without deleting windows.
    await f.tmux('detach-client', '-t', secondClient);
    await second.fallback();
    assert.equal(await f.tmux('list-windows', '-t', 'wsl-web', '-F', '#{window_id}'), windows);
    assert.equal(await f.tmux('list-sessions', '-F', '#{session_name}'), 'fixture\nwsl-web');
  });

for (const entry of ['bashrc', 'join']) {
  for (const stage of ['base', 'window', 'empty', 'client', 'select', 'hook', 'attach']) {
    test(`${entry} preserves the shell when ${stage} fails`, { timeout: 20000 }, async t => {
      const f = await fixture(t);
      // Given real tmux state and exactly one injected command failure.
      if (stage !== 'base') await f.tmux('new-session', '-d', '-s', 'wsl-web');
      const client = f.shell(entry, stage);
      // When startup fails, the same shell executes the fallback sentinel.
      const output = await client.fallback();
      assert.match(output, entry === 'bashrc' ? /FALLBACK:0/ : /FALLBACK:[1-9]\d*/);
      const sessions = await f.tmux('list-sessions', '-F', '#{session_name}');
      assert.doesNotMatch(sessions, /term-client-/);
      if (stage !== 'base') await f.tmux('has-session', '-t', '=wsl-web');
      // Then earlier failures never install a hook or attach a client.
      const commands = await readFile(join(f.dir, 'commands'), 'utf8');
      if (!['hook', 'attach'].includes(stage)) assert.doesNotMatch(commands, /^set-hook /m);
      if (stage !== 'attach') assert.doesNotMatch(commands, /^attach-session /m);
      assert.doesNotMatch(commands, /kill-window/);
      assert.doesNotMatch(commands, /kill-session -t =wsl-web/);
    });
  }
}

test('existing service strategy reaps a crashed join orphan and preserves live sessions',
  { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const live = await f.attach('bashrc');
    const orphan = await f.attach('join');
    const windows = await f.tmux('list-windows', '-t', 'wsl-web', '-F', '#{window_id}');
    const client = await f.tmux('list-clients', '-t', orphan.session, '-F', '#{client_name}');
    // Given a crash that bypasses shell cleanup and a missing detach hook.
    await f.tmux('set-hook', '-u', '-t', orphan.session, 'client-detached');
    process.kill(orphan.terminal.pid, 'SIGKILL');
    await orphan.exited;
    await f.tmux('detach-client', '-t', client);
    assert.equal(await f.tmux('display-message', '-p', '-t', orphan.session, '#{session_attached}'), '0');
    // When the unchanged service runs its existing cleanup.
    await exec(process.execPath, ['--input-type=module', '-e',
      "import { TmuxService } from './src/tmux-service.js'; await new TmuxService().ensureSession();"],
    { cwd: root, env: f.env, timeout: 10000 });
    // Then the dead PID session is gone and its windows and live peer survive.
    const sessions = (await f.tmux('list-sessions', '-F', '#{session_name}')).split('\n');
    assert.ok(!sessions.includes(orphan.session));
    assert.ok(sessions.includes(live.session));
    assert.equal(await f.tmux('list-windows', '-t', 'wsl-web', '-F', '#{window_id}'), windows);
  });
