import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const paths = require('../bridge/src/paths.js');
const directories = require('../bridge/src/directories.js');

const {
  baseName,
  defaultBrowsePath,
  isWslPath,
  isWslUncPath,
  parentPath,
  shellCwd,
  wslPathToLinux,
  wslPathToUnc
} = paths;

test('MIRROR-B15 a WSL path becomes the UNC path Windows can read', () => {
  assert.equal(wslPathToUnc('/home/joslyn/code'), '\\\\wsl$\\Ubuntu\\home\\joslyn\\code');
  assert.equal(wslPathToUnc('/'), '\\\\wsl$\\Ubuntu');
  assert.equal(wslPathToUnc('\\\\wsl$\\Ubuntu\\home'), '\\\\wsl$\\Ubuntu\\home');
  assert.equal(wslPathToUnc('C:\\Users'), '');
});

test('MIRROR-B13 the UNC path becomes the Linux path wsl.exe --cd wants', () => {
  assert.equal(wslPathToLinux('\\\\wsl$\\Ubuntu\\home\\joslyn\\code'), '/home/joslyn/code');
  assert.equal(wslPathToLinux('\\\\wsl.localhost\\Ubuntu\\home\\joslyn'), '/home/joslyn');
  assert.equal(wslPathToLinux('/home/joslyn'), '/home/joslyn');
});

test('a path is recognised as WSL only when it points inside the distro', () => {
  assert.equal(isWslPath('/home/joslyn'), true);
  assert.equal(isWslPath('\\\\wsl$\\Ubuntu\\home'), true);
  assert.equal(isWslPath('C:\\Users'), false);
  assert.equal(isWslUncPath('C:\\Users'), false);
});

test('the parent of a path stops at the root', () => {
  assert.equal(parentPath('/home/joslyn/code'), '/home/joslyn');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), '');
  assert.equal(parentPath('C:\\Users\\joslyn\\code'), 'C:\\Users\\joslyn');
  assert.equal(parentPath('C:\\Users'), 'C:\\');
  assert.equal(parentPath('\\\\wsl$\\Ubuntu\\home\\joslyn'), '/home');
});

test('the display name is the last segment of the path', () => {
  assert.equal(baseName('/home/joslyn/code'), 'code');
  assert.equal(baseName('/'), '');
  assert.equal(baseName('C:\\Users\\joslyn'), 'joslyn');
  assert.equal(baseName('\\\\wsl$\\Ubuntu\\home\\joslyn'), 'joslyn');
});

test('MIRROR-B12 and MIRROR-B13 the shell gets the path in its own flavour', () => {
  assert.equal(shellCwd('Windows', 'C:\\Users\\joslyn'), 'C:\\Users\\joslyn');
  assert.equal(shellCwd('WSL', '/home/joslyn'), '/home/joslyn');
  assert.equal(shellCwd('WSL', '\\\\wsl$\\Ubuntu\\home\\joslyn'), '/home/joslyn');
  assert.equal(shellCwd('Windows', ''), '');
});

test('the directory browser starts at the root of the chosen environment', () => {
  assert.equal(defaultBrowsePath('WSL'), '/');
  assert.equal(defaultBrowsePath('Windows'), 'C:\\');
});

// A tiny in-memory filesystem so the listing rules can be checked without touching the disk.
// It is keyed by Linux-style paths; the Bridge reads WSL paths through their UNC form, so the
// fake strips that prefix the same way Windows would.
function fakeFs(entries) {
  const dirs = new Set(Object.keys(entries).filter((p) => entries[p] === 'dir'));
  const key = (p) => String(p)
    .replace(/^\\\\wsl\$\\Ubuntu/i, '')
    .replace(/^\\\\wsl\.localhost\\Ubuntu/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '') || '/';
  return {
    statSync(p) {
      const k = key(p);
      if (dirs.has(k)) return { isDirectory: () => true };
      if (entries[k] === 'file') return { isDirectory: () => false };
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readdirSync(p) {
      const k = key(p);
      const prefix = k === '/' ? '/' : `${k}/`;
      const names = new Set();
      for (const candidate of Object.keys(entries)) {
        if (!candidate.startsWith(prefix) || candidate === k) continue;
        names.add(candidate.slice(prefix.length).split('/')[0]);
      }
      if (!dirs.has(k)) throw new Error('ENOTDIR');
      return [...names];
    }
  };
}
test('MIRROR-B15 the listing puts directories first, sorts them case-insensitively and keeps hidden entries', () => {
  const fsImpl = fakeFs({
    '/root': 'dir',
    '/root/Beta': 'dir',
    '/root/alpha': 'dir',
    '/root/.config': 'dir',
    '/root/notes.txt': 'file',
    '/root/README.md': 'file'
  });
  const listing = directories.listDirectory('/root', { fsImpl });
  assert.deepEqual(listing.directories, ['.config', 'alpha', 'Beta']);
  assert.deepEqual(listing.files, ['notes.txt', 'README.md']);
  assert.equal(listing.path, '/root');
  assert.equal(listing.parent, '/');
  assert.equal(listing.name, 'root');
});

test('MIRROR-B16 a directory that does not exist is an error, not an empty listing', () => {
  const fsImpl = fakeFs({ '/root': 'dir', '/root/notes.txt': 'file' });
  assert.throws(() => directories.listDirectory('/nope', { fsImpl }), /无法访问目录/);
  assert.throws(() => directories.listDirectory('/root/notes.txt', { fsImpl }), /不是目录/);
});

test('MIRROR-B15 a WSL path is read through its UNC form', () => {
  const seen = [];
  const fsImpl = {
    statSync(p) {
      seen.push(p);
      return { isDirectory: () => true };
    },
    readdirSync(p) {
      seen.push(p);
      return [];
    }
  };
  directories.listDirectory('/home/joslyn', { fsImpl });
  assert.deepEqual(seen[0], '\\\\wsl$\\Ubuntu\\home\\joslyn');
});
