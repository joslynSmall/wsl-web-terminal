'use strict';

/**
 * Listing directories for the web page's directory picker.
 *
 * The Bridge runs inside Tabby, so it reads the filesystem with Node's `fs`. WSL directories
 * are reached through the `\\wsl$\Ubuntu\...` UNC path; Windows directories are read directly.
 */

const fs = require('fs');
const path = require('path');
const {
  baseName,
  isWslPath,
  isWslUncPath,
  parentPath,
  wslPathToUnc
} = require('./paths');

const MAX_ENTRIES = 500;

class DirectoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DirectoryError';
  }
}

/** The path Node reads for a directory the user picked. */
function readablePath(dirPath) {
  if (isWslUncPath(dirPath)) return dirPath;
  if (isWslPath(dirPath)) return wslPathToUnc(dirPath);
  return dirPath;
}

/** The path the page shows and passes back: WSL paths stay Linux, Windows paths stay Windows. */
function displayPath(dirPath) {
  return dirPath;
}

/**
 * Lists the subdirectories of a directory.
 *
 * Hidden entries are included: `.config` and `.ssh` are everyday targets in a working
 * directory picker. Directories come first, then files, each sorted case-insensitively by name.
 */
function listDirectory(dirPath, { fsImpl = fs } = {}) {
  const target = readablePath(dirPath);
  let stats;
  try {
    stats = fsImpl.statSync(target);
  } catch (err) {
    throw new DirectoryError(`无法访问目录：${dirPath}`);
  }
  if (!stats.isDirectory()) {
    throw new DirectoryError(`不是目录：${dirPath}`);
  }  let names;
  try {
    names = fsImpl.readdirSync(target);
  } catch (err) {
    throw new DirectoryError(`无法读取目录：${dirPath}`);
  }
  const dirs = [];
  const files = [];
  for (const name of names) {
    let isDir = false;
    try {
      isDir = fsImpl.statSync(path.join(target, name)).isDirectory();
    } catch {
      isDir = false; // a broken symlink or a file we cannot stat is listed as a file
    }
    (isDir ? dirs : files).push(name);
  }
  const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
  dirs.sort(byName);
  files.sort(byName);
  const truncated = dirs.length + files.length > MAX_ENTRIES;
  return {
    path: displayPath(dirPath),
    parent: parentPath(dirPath),
    name: baseName(dirPath) || dirPath,
    directories: dirs.slice(0, MAX_ENTRIES),
    files: files.slice(0, MAX_ENTRIES),
    truncated
  };
}

/**
 * Whether a path is a directory right now.
 *
 * Used to check the page's recent-directory list: a directory can be deleted after it was
 * remembered, and starting a shell in a missing directory would silently land somewhere else.
 */
function directoryExists(dirPath, { fsImpl = fs } = {}) {
  try {
    return fsImpl.statSync(readablePath(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { DirectoryError, listDirectory, directoryExists, readablePath, displayPath, MAX_ENTRIES };
