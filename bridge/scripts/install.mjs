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

const dirFlag = process.argv.indexOf('--dir');
const pluginsDir = dirFlag > -1 ? path.resolve(process.argv[dirFlag + 1] || '') : defaultPluginsDir();

if (dirFlag > -1 && !process.argv[dirFlag + 1]) {
  console.error('--dir needs a path');
  process.exit(1);
}
if (!existsSync(path.dirname(pluginsDir)) && dirFlag === -1) {
  console.error(`Tabby's plugin folder was not found at ${path.dirname(pluginsDir)}. Start Tabby once, or pass --dir.`);
  process.exit(1);
}

const target = path.join(pluginsDir, NAME);
mkdirSync(pluginsDir, { recursive: true });
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(path.join(bridgeRoot, 'package.json'), path.join(target, 'package.json'));
cpSync(path.join(bridgeRoot, 'src'), path.join(target, 'src'), { recursive: true });

console.log(`Installed ${NAME} to ${target}`);
console.log('Restart Tabby to load it. The server address is wslWebBridge.serverUrl in Tabby -> Settings -> Config file.');
