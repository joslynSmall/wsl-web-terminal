// Copies the Bridge into Tabby's plugin folder. Restart Tabby afterwards.
// Usage: npm run install-bridge [-- --dir <tabby plugins node_modules folder>]
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'tabby-wsl-web-bridge';

function defaultPluginsDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'tabby', 'plugins', 'node_modules');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'tabby', 'plugins', 'node_modules');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tabby', 'plugins', 'node_modules');
}

/**
 * Resolves the target plugin folder.
 *
 * The Bridge has to end up in the plugin folder of the system Tabby runs on, which is not
 * necessarily the system this script runs on: the service may live in WSL while Tabby runs on
 * Windows. A Windows path given from WSL (`C:\Users\...`) therefore has to be mapped onto the
 * mounted drive instead of being resolved against the current directory.
 *
 * The folder has to exist already: Tabby creates its own plugin folder when it first runs, so a
 * missing folder means the path is wrong (or Tabby has not run yet), not "create it here".
 */
function resolvePluginsDir(raw) {
  if (!raw) return null;
  const windowsPath = /^([a-zA-Z]):[\\/]/.exec(raw);
  let resolved;
  if (windowsPath) {
    if (process.platform === 'win32') {
      resolved = path.resolve(raw);
    } else {
      const drive = windowsPath[1].toLowerCase();
      const mount = `/mnt/${drive}`;
      if (!existsSync(mount)) return null; // the drive is not mounted here
      resolved = path.resolve(mount, raw.slice(3).replace(/\\/g, '/'));
    }
  } else {
    resolved = path.resolve(raw);
  }
  return existsSync(resolved) ? resolved : null;
}

const dirFlag = process.argv.indexOf('--dir');
const rawDir = dirFlag > -1 ? process.argv[dirFlag + 1] : undefined;

if (dirFlag > -1 && !rawDir) {
  console.error('--dir needs a path');
  process.exit(1);
}

let pluginsDir;
if (dirFlag > -1) {
  pluginsDir = resolvePluginsDir(rawDir);
  if (!pluginsDir) {
    console.error(`Could not use the path "${rawDir}".`);
    if (/^[a-zA-Z]:[\\/]/.test(rawDir) && process.platform !== 'win32') {
      console.error('It looks like a Windows path, but this is not Windows. Run this on the machine');
      console.error('where Tabby runs, or give a path that exists here (for example /mnt/c/Users/...).');
    } else {
      console.error('The folder does not exist. Tabby creates its plugin folder when it first runs,');
      console.error('so start Tabby once, or point --dir at the folder that already exists.');
    }
    process.exit(1);
  }
} else {
  pluginsDir = defaultPluginsDir();
  if (!existsSync(path.dirname(pluginsDir))) {
    console.error(`Tabby's plugin folder was not found at ${path.dirname(pluginsDir)}. Start Tabby once, or pass --dir.`);
    process.exit(1);
  }
}

const target = path.join(pluginsDir, NAME);
mkdirSync(pluginsDir, { recursive: true });
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(path.join(bridgeRoot, 'package.json'), path.join(target, 'package.json'));
cpSync(path.join(bridgeRoot, 'src'), path.join(target, 'src'), { recursive: true });

console.log(`Installed ${NAME} to ${target}`);
console.log('Restart Tabby to load it. The server address is wslWebBridge.serverUrl in Tabby -> Settings -> Config file.');
