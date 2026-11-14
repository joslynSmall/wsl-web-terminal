import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const installScript = new URL('../bridge/scripts/install.mjs', import.meta.url);

function runInstall(args, cwd) {
  return execFileSync(process.execPath, [installScript.pathname, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** Runs the installer and returns the message it printed on stderr, or null when it succeeded. */
function runInstallExpectingFailure(args, cwd) {
  try {
    runInstall(args, cwd);
    return null;
  } catch (err) {
    return String(err.stderr || err.message || '');
  }
}

test('MIRROR-B20 installing puts the Bridge into the given plugin folder, with its new files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsl-web-terminal-install-'));
  try {
    const pluginsDir = path.join(root, 'plugins', 'node_modules');
    mkdirSync(pluginsDir, { recursive: true }); // Tabby creates its plugin folder itself
    runInstall(['--dir', pluginsDir], root);
    const installed = path.join(pluginsDir, 'tabby-wsl-web-bridge');
    assert.ok(existsSync(path.join(installed, 'package.json')));
    assert.ok(existsSync(path.join(installed, 'src', 'index.js')));
    assert.ok(existsSync(path.join(installed, 'src', 'bridge-core.js')));
    assert.ok(existsSync(path.join(installed, 'src', 'paths.js')));
    assert.ok(existsSync(path.join(installed, 'src', 'directories.js')));
    const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.match(manifest.name, /^tabby-/);
    assert.ok(manifest.keywords.includes('tabby-plugin'));
    assert.ok(manifest.author, 'Tabby skips plugins without an author');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Windows path given from a non-Windows system is mapped onto the mounted drive', (t) => {
  if (process.platform === 'win32') return t.skip('this is about running the script off Windows');
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsl-web-terminal-install-'));
  try {
    // A Windows path whose folder does not exist must be refused, not resolved against the cwd
    // and not created from scratch.
    const message = runInstallExpectingFailure(['--dir', 'C:\\no-such-folder\\plugins\\node_modules'], root);
    assert.match(message, /Could not use the path/);
    assert.deepEqual(
      existsSync(path.join(root, 'C:\\no-such-folder\\plugins\\node_modules')),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MIRROR-B20 a Windows path from a non-Windows system lands in the mounted drive, not in the cwd', (t) => {
  if (process.platform === 'win32') return t.skip('this is about running the script off Windows');
  const drive = 'c';
  const mount = `/mnt/${drive}`;
  if (!existsSync(mount)) return t.skip('no C drive mounted here');
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsl-web-terminal-install-'));
  try {
    const pluginsDir = path.join(mount, 'Users', 'Administrator', 'AppData', 'Roaming', 'tabby', 'plugins', 'node_modules');
    if (!existsSync(pluginsDir)) return t.skip('no Tabby plugin folder on this machine');
    const output = runInstall(['--dir', 'C:\\Users\\Administrator\\AppData\\Roaming\\tabby\\plugins\\node_modules'], root);
    assert.match(output, /Installed tabby-wsl-web-bridge to \/mnt\/c\//);
    // Nothing may be created in the current directory.
    assert.equal(
      existsSync(path.join(root, 'C:\\Users\\Administrator')),
      false,
      'a Windows path must not be resolved against the current directory'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MIRROR-B20 a path that does not exist is refused instead of being created', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsl-web-terminal-install-'));
  try {
    const message = runInstallExpectingFailure(['--dir', path.join(root, 'nowhere', 'node_modules')], root);
    assert.match(message, /Could not use the path|does not exist/);
    assert.equal(existsSync(path.join(root, 'nowhere')), false, 'no folder may be created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
