'use strict';

/**
 * Path and directory helpers for the Bridge.
 *
 * The Bridge runs inside Tabby, which on Windows can open both Windows shells and WSL panes.
 * Two path flavours are involved:
 *
 *  - Windows paths (`C:\Users\...`) are used as-is.
 *  - WSL paths have two spellings: the Linux one the user thinks in (`/home/joslyn`) and the
 *    UNC one Windows can actually read (`\\wsl$\Ubuntu\home\joslyn`). WSL directories are only
 *    reachable through the UNC form, so listing them means reading the UNC path.
 *
 * Everything here is pure string handling plus directory reads, so it can be tested without Tabby.
 */

const WSL_DISTRO = 'Ubuntu';
const WSL_UNC_ROOTS = [`\\\\wsl$\\${WSL_DISTRO}`, `\\\\wsl.localhost\\${WSL_DISTRO}`];

const WSL_ROOTS = {
  wsl: '/',
  windows: 'C:\\'
};

function isWindowsAbsolutePath(path) {
  return /^[a-zA-Z]:[\\/]/.test(String(path || ''));
}

function isUncPath(path) {
  return /^\\\\/.test(String(path || ''));
}

function isWslUncPath(path) {
  const p = String(path || '').toLowerCase();
  return WSL_UNC_ROOTS.some((root) => p === root.toLowerCase() || p.startsWith(`${root.toLowerCase()}\\`));
}

/** True when the path points inside the WSL distro we manage. */
function isWslPath(path) {
  const p = String(path || '');
  return p.startsWith('/') || isWslUncPath(p);
}

/**
 * The Windows path that can be read for a WSL path: `\\wsl$\Ubuntu\home\joslyn`.
 * A Linux path is converted; an UNC path is returned unchanged.
 */
function wslPathToUnc(path) {
  const p = String(path || '');
  if (!p) return '';
  if (isWslUncPath(p)) return p;
  if (!p.startsWith('/')) return '';
  const tail = p.replace(/\/+$/, '').replace(/\//g, '\\');
  return `${WSL_UNC_ROOTS[0]}${tail}`;
}

/** The Linux path for a WSL path: `/home/joslyn`. An UNC path is converted back. */
function wslPathToLinux(path) {
  const p = String(path || '');
  if (!p) return '';
  if (!isWslUncPath(p)) return p;
  // Strip the `\\wsl$\Ubuntu` (or `\\wsl.localhost\Ubuntu`) prefix, keeping what follows it.
  const root = WSL_UNC_ROOTS.find((r) => p.toLowerCase().startsWith(r.toLowerCase()));
  const rest = p.slice(root.length).replace(/^\\/, '');
  const tail = rest.replace(/\\/g, '/');
  return tail.startsWith('/') ? tail : `/${tail}`;
}

/** The parent of a path, or '' when it is already a root. */
function parentPath(path) {
  const p = String(path || '');
  if (!p) return '';
  if (isWslUncPath(p)) {
    const linux = wslPathToLinux(p);
    if (linux === '/' || linux === '') return '';
    const parent = linux.slice(0, Math.max(0, linux.lastIndexOf('/')));
    return parent === '' ? '/' : parent;
  }
  if (isWindowsAbsolutePath(p)) {
    const trimmed = p.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (idx <= 2) return trimmed.slice(0, 3);
    return trimmed.slice(0, idx);
  }
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return '';
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** The last segment of a path, used as the display name in the directory browser. */
function baseName(path) {
  const p = String(path || '');
  if (!p) return '';
  if (isWslUncPath(p)) {
    const linux = wslPathToLinux(p);
    return linux.split('/').filter(Boolean).pop() || '/';
  }
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.pop() || trimmed;
}

/** Where the browser starts when the user opens the directory picker for a given environment. */
function defaultBrowsePath(environment) {
  if (environment === 'WSL') return WSL_ROOTS.wsl;
  return WSL_ROOTS.windows;
}

/**
 * The path actually handed to the shell. A WSL pane gets a Linux path (wsl.exe --cd wants one),
 * a Windows shell gets a Windows path.
 */
function shellCwd(environment, path) {
  const p = String(path || '');
  if (!p) return '';
  if (environment === 'WSL') return wslPathToLinux(p);
  return p;
}

module.exports = {
  WSL_DISTRO,
  WSL_ROOTS,
  baseName,
  defaultBrowsePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWslPath,
  isWslUncPath,
  parentPath,
  shellCwd,
  wslPathToLinux,
  wslPathToUnc
};
