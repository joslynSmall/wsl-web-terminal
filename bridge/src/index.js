'use strict';

// Tabby plugin entry. Tabby supplies these modules at runtime; they are not bundled.
const { NgModule, Injectable, Inject } = require('@angular/core');
const { ConfigProvider, ConfigService, ProfilesService } = require('tabby-core');
const { TerminalDecorator } = require('tabby-terminal');
const { BridgeCore } = require('./bridge-core');
const { listDirectory, directoryExists } = require('./directories');
const { WSL_DISTRO, shellCwd, wslPathToLinux } = require('./paths');

const DEFAULT_SERVER_URL = 'ws://localhost:7890';

// Linux here is the WSL install of Tabby. A native Linux machine would also report WSL;
// this project only distinguishes the Windows app from the one started inside WSL.
function detectOrigin() {
  return process.platform === 'win32' ? 'Windows' : 'WSL';
}

/** The environment a terminal actually runs in, told apart by the command Tabby spawned it with. */
function detectEnvironment(terminal) {
  const profile = terminal && terminal.profile;
  const command = profile && profile.options && profile.options.command;
  const base = String(command || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return base === 'wsl' ? 'WSL' : 'Windows';
}

/** The profile Tabby uses for plain Windows shells (PowerShell, cmd, …). */
function defaultWindowsProfile(profiles, config) {
  const wanted = config.store && config.store.terminal && config.store.terminal.profile;
  return profiles.find((p) => p.id === wanted)
    || profiles.find((p) => p.type === 'local' && p.isBuiltin)
    || profiles.find((p) => p.type === 'local')
    || profiles[0];
}

/**
 * wsl.exe lives in the Windows directory, which is not always on the PATH of the process Tabby
 * spawns (a service started without the user's environment, for example).
 */
function wslExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  return `${systemRoot}\\System32\\wsl.exe`;
}

class WebBridgeConfigProvider extends ConfigProvider {
  constructor() {
    super();
    // Editable in Tabby: Settings -> Config file.
    this.defaults = { wslWebBridge: { serverUrl: DEFAULT_SERVER_URL } };
  }
}
Injectable()(WebBridgeConfigProvider);

// One Bridge per Tabby window (this module is loaded once per window).
let core = null;

function getCore(config, profiles) {
  if (core) return core;
  core = new BridgeCore({
    WebSocketImpl: WebSocket,
    bridgeId: crypto.randomUUID(),
    version: require('../package.json').version,
    origin: detectOrigin(),
    getServerUrl: () => {
      try {
        return config.store.wslWebBridge.serverUrl || DEFAULT_SERVER_URL;
      } catch {
        return DEFAULT_SERVER_URL;
      }
    },
    openDefaultTab: async () => {
      const all = await profiles.getProfiles();
      const profile = defaultWindowsProfile(all, config);
      if (!profile) throw new Error('No Tabby profile available');
      await profiles.openNewTabForProfile(profile);
    },
    // 新建指定环境和目录的窗格（MIRROR-B12 / B13 / B14）。
    // WSL 窗格不是 Tabby 内置的 profile，所以这里自己造一个，用 wsl.exe 起 PTY。
    openTabForRequest: async ({ environment, cwd }) => {
      const all = await profiles.getProfiles();
      if (environment !== 'WSL') {
        const base = defaultWindowsProfile(all, config);
        if (!base) throw new Error('No Tabby profile available');
        const profile = cwd
          ? { ...base, options: { ...(base.options || {}), cwd } }
          : base;
        await profiles.openNewTabForProfile(profile);
        return;
      }
      // wsl.exe 总是带 --cd：不带的话它会继承 Windows 的当前目录，shell 会落在 /mnt/c/... 而不是家目录。
      // profile 不设 cwd，避免 Tabby 的 local provider 用上一个标签的目录覆盖它；
      // 真正决定 shell 工作目录的是 --cd。
      const linuxCwd = cwd ? wslPathToLinux(cwd) : '~';
      const profile = {
        id: 'local:wsl-web-bridge-wsl',
        type: 'local',
        name: 'WSL',
        options: {
          command: wslExecutable(),
          args: ['--distribution', WSL_DISTRO, '--cd', linuxCwd],
          homeDirArgs: [],
          cwd: null,
          env: {},
          shellType: null,
          fsBase: null
        }
      };
      await profiles.openNewTabForProfile(profile);
    },
    listDirectories: (dirPath) => listDirectory(dirPath),
    directoryExists: (dirPath) => directoryExists(dirPath),
    environmentOf: detectEnvironment,
    focusTarget: window,
    hasFocus: () => document.hasFocus(),
    log: (...args) => console.warn('[wsl-web-bridge]', ...args)
  });
  core.start();
  return core;
}

class WebBridgeDecorator extends TerminalDecorator {
  constructor(config, profiles) {
    super();
    this.core = getCore(config, profiles);
  }

  attach(terminal) {
    this.core.attach(terminal);
  }

  detach(terminal) {
    this.core.detach(terminal);
  }
}
Injectable()(WebBridgeDecorator);
Inject(ConfigService)(WebBridgeDecorator, undefined, 0);
Inject(ProfilesService)(WebBridgeDecorator, undefined, 1);

class WebBridgeModule {}
NgModule({
  providers: [
    { provide: ConfigProvider, useClass: WebBridgeConfigProvider, multi: true },
    { provide: TerminalDecorator, useClass: WebBridgeDecorator, multi: true }
  ]
})(WebBridgeModule);

Object.defineProperty(module.exports, '__esModule', { value: true });
module.exports.default = WebBridgeModule;
module.exports.detectOrigin = detectOrigin;
module.exports.detectEnvironment = detectEnvironment;
module.exports.defaultWindowsProfile = defaultWindowsProfile;
module.exports.wslExecutable = wslExecutable;
module.exports.shellCwd = shellCwd;
