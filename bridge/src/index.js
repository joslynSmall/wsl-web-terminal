'use strict';

// Tabby plugin entry. Tabby supplies these modules at runtime; they are not bundled.
const { NgModule, Injectable, Inject } = require('@angular/core');
const { ConfigProvider, ConfigService, ProfilesService } = require('tabby-core');
const { TerminalDecorator } = require('tabby-terminal');
const { BridgeCore } = require('./bridge-core');

const DEFAULT_SERVER_URL = 'ws://localhost:7890';

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
    getServerUrl: () => {
      try {
        return config.store.wslWebBridge.serverUrl || DEFAULT_SERVER_URL;
      } catch {
        return DEFAULT_SERVER_URL;
      }
    },
    openDefaultTab: async () => {
      const all = await profiles.getProfiles();
      const wanted = config.store && config.store.terminal && config.store.terminal.profile;
      const profile = all.find((p) => p.id === wanted)
        || all.find((p) => p.type === 'local' && p.isBuiltin)
        || all[0];
      if (!profile) throw new Error('No Tabby profile available');
      await profiles.openNewTabForProfile(profile);
    },
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
