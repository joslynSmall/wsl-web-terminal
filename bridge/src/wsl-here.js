'use strict';

/**
 * "Open Tabby here" for a WSL directory, when Tabby is already running.
 *
 * open-tabby-here.ps1 starts `Tabby.exe run cmd.exe /c <launcher>.cmd`. The launcher is a
 * one-line batch file: `wsl.exe --distribution <distro> --cd "<linux path>"`. That works
 * when Tabby is not running. When it is, Electron treats `/c` as a Chromium switch and moves
 * it to the front of the argument list, so Tabby no longer sees a `run` command. A later
 * handler then treats `/c` as a directory, the lookup throws, and no tab opens.
 *
 * The launcher path itself survives that reordering. Reading it is also the only reliable
 * source of the Linux directory: the second process does not always keep the Explorer
 * folder as its working directory. The batch file is not executed. Only the distro and
 * the --cd path are taken from it, and only from the file name the script writes.
 */

const fs = require('fs');

const LAUNCHER_RE = /[/\\]Tabby[/\\]launchers[/\\]wsl-[0-9a-f]{32}\.cmd$/i;
const LAUNCHER_BODY_RE = /^@?(?:"([^"]*wsl\.exe)"|(\S*wsl\.exe))\s+--distribution\s+([A-Za-z0-9._-]+)\s+--cd\s+"([^"]*)"\s*$/i;

function argumentValues(argv) {
  if (!argv || typeof argv !== 'object') return [];
  const values = [];
  for (const key of ['_', 'command']) {
    const value = argv[key];
    if (Array.isArray(value)) values.push(...value);
    else if (typeof value === 'string') values.push(value);
  }
  return values;
}

/** The launcher path carried in either argv shape, or null when this is not one. */
function launcherPathFromArgv(argv) {
  for (const raw of argumentValues(argv)) {
    const value = String(raw ?? '').trim().replace(/^"+|"+$/g, '');
    if (LAUNCHER_RE.test(value)) return value;
  }
  return null;
}

/**
 * The script writes the batch file in the ANSI code page, because cmd.exe reads it that way.
 * On the Windows install this project runs on, that code page is GBK, so a Chinese directory
 * is not valid UTF-8. ASCII and a future UTF-8 file still decode on the first attempt.
 */
function decodeLauncher(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('gbk').decode(buffer);
  }
}

/** `{ distro, cwd }` from the one line the script writes, or null when it is not that line. */
function parseLauncher(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return null;
  const match = LAUNCHER_BODY_RE.exec(line);
  if (!match) return null;
  return { distro: match[3], cwd: match[4] || '~' };
}

function readWslHere(argv, { fsImpl = fs } = {}) {
  const launcher = launcherPathFromArgv(argv);
  if (!launcher) return null;
  let bytes;
  try {
    bytes = fsImpl.readFileSync(launcher);
  } catch {
    return null; // already cleaned up, or not actually there; let Tabby keep the command
  }
  return parseLauncher(decodeLauncher(bytes));
}

/**
 * A local profile that runs wsl.exe directly.
 *
 * `options.cwd` stays empty. Tabby's local provider otherwise fills it from the previous
 * tab, and that Windows directory would override --cd. --cd is what puts the shell in the
 * Linux directory (or in ~ when the user clicked the distro root).
 */
function wslProfile({ command, distro, cwd }) {
  return {
    id: 'local:wsl-web-bridge-wsl',
    type: 'local',
    name: 'WSL',
    options: {
      command,
      args: ['--distribution', distro, '--cd', cwd || '~'],
      homeDirArgs: [],
      cwd: null,
      env: {},
      shellType: null,
      fsBase: null
    }
  };
}

/**
 * Opens the WSL pane named by a "Open Tabby here" launcher.
 * Returns false when `argv` is not such a launcher, so Tabby's own handlers still run.
 */
async function handleWslHere(argv, { profiles, hostWindow, fsImpl, command } = {}) {
  const parsed = readWslHere(argv, { fsImpl });
  if (!parsed) return false;
  if (!profiles || typeof profiles.openNewTabForProfile !== 'function') {
    throw new Error('No Tabby profile service');
  }
  await profiles.openNewTabForProfile(wslProfile({
    command,
    distro: parsed.distro,
    cwd: parsed.cwd
  }));
  if (hostWindow && typeof hostWindow.bringToFront === 'function') hostWindow.bringToFront();
  return true;
}

module.exports = {
  LAUNCHER_RE,
  decodeLauncher,
  handleWslHere,
  launcherPathFromArgv,
  parseLauncher,
  readWslHere,
  wslProfile
};
