# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web UI (Express + WebSocket + xterm.js) that mirrors and drives the terminal panes the user already has open in **Tabby**, from a browser (including a phone). The server is a plain Node process and runs on any OS; the repo name's "WSL" is historical — there is no tmux/WSL dependency any more (see `docs/adr/0001-mirror-tabby-instead-of-tmux.md`). ESM throughout (`"type": "module"`) except `bridge/`, which is CommonJS because Tabby `require`s it. No build step, no bundler, no linter.

Read `CONTEXT.md` first and use its vocabulary: **Terminal Session**, **Bridged Session**, **Bridge**. Bare "session" means Terminal Session, never a tmux session. Update `CONTEXT.md` when a term is settled with the user; it is a glossary only, no implementation detail.

The README is in Chinese and documents the user-facing behaviour, configuration and the REST/WebSocket API.

## Commands

```bash
npm install
npm start                 # node src/server.js, port 7890 (PORT=, HOST=, ALLOWED_HOSTS=)
npm run dev               # same with --watch
npm test                  # node --test "test/*.test.js"; needs no Tabby and no network
npm run install-bridge    # copies bridge/ into Tabby's plugins/node_modules; restart Tabby afterwards
node --test --test-name-pattern="<substring>" test/session-hub.test.js   # single test
```

## Architecture

```
browser ──ws /ws/terminal?session=ID──▶ server ◀──ws /ws/bridge── Bridge (Tabby plugin) ──▶ Tabby panes
```

- `src/session-hub.js` — `SessionHub`, the core. Socket-agnostic: it is handed "channels" (`send`, `bufferedAmount`, `close`). Tracks Bridges (one per Tabby window, numbered `W1`, `W2`…) and their sessions, and fans output out to viewers (browsers). Key mechanisms:
  - **Snapshot + sequence numbers.** A new viewer buffers live output, asks the Bridge for a screen snapshot tagged with the last output `seq` it covers, then replays only buffered output with a higher `seq`. Every snapshot request has its own `reqId`; replies for stale requests are ignored.
  - **Watch/unwatch.** The Bridge only forwards output for a session while at least one viewer is attached.
  - **Slow browsers.** If a viewer's socket backs up (or its pre-snapshot buffer overflows) the backlog is dropped and a fresh snapshot is requested. Tabby is never throttled.
  - **Commands** (`create`/`rename`/`close`) go to the Bridge and are answered with `result`; `create` targets the most recently focused Bridge and waits for the new session to appear.
- `src/server.js` — Express routes under `/api/sessions`, two `ws` servers (browser, Bridge) upgraded manually, heartbeat, and the same-origin/`Host` checks. `createServer()` is exported and does not listen; it only listens when run as the entry file. There is **no authentication by design** (user's decision) but cross-origin requests and unknown `Host` headers are refused. Note `handleUpgrade`'s callback does not emit `connection`; per-socket setup (pong tracking) lives in `accept()`.
- `bridge/` — the Tabby plugin. `src/bridge-core.js` holds all logic and knows nothing about Tabby classes (tested with fakes); `src/index.js` is the thin Tabby wiring (`TerminalDecorator` per pane, `ConfigProvider` for `wslWebBridge.serverUrl`, DI via manual `Inject(...)` calls because there is no TypeScript/decorator build). `scripts/install.mjs` copies it into Tabby.
- `public/` — vanilla JS SPA (`index.html`, `app.js`, `style.css`), no framework. xterm.js and the web-links addon are served from `node_modules/@xterm/*` under `/vendor/*` (offline); adding a frontend lib needs a matching static route in `server.js`. The terminal's cols×rows always come from Tabby (`snapshot`/`size` messages); the page never sends a size and never shrinks the font to fit (14px desktop, 12px phone, A-/A+ within 8–26px). A terminal bigger than the screen scrolls inside `#terminal-container`; `revealCursor()` keeps the cursor in view except for a few seconds after the user panned by hand, and touch drags pan before they scroll history. `localStorage` is used only for the accessory-bar collapsed flag.

## Gotchas

- `public/app.js` is a plain browser script evaluated directly by `test/app.test.js` in a `vm` with fake DOM/WebSocket/Terminal; keep it free of ES module syntax and extend the stubs in `createApp()` when you use new DOM APIs.
- The page's xterm must never answer terminal queries (DA1/DA2, cursor-position and colour reports, DECRQM…): Tabby's own xterm already does, and a second reply gets typed into the shell (symptom: `[?1;2c` before the command). `suppressTerminalReplies()` in `public/app.js` swallows the queries in xterm's parser; keep it when touching `initTerminal`. Colour *setting* sequences must still pass through.
- Snapshots must include the alternate screen. Tabby's `frontend.saveState()` hard-codes `excludeAltBuffer: true`, so for a full-screen program (Claude Code, vim, htop) it restores only the shell underneath. `BridgeCore.serializeFrontend()` therefore calls Tabby's private `serializeAddon.serialize({ scrollback })` (alt screen and modes included) and falls back to `saveState()`. Checked against the real `@xterm/addon-serialize`; if Tabby renames that private field the fallback silently brings the bug back.
- Tabby only loads a plugin whose `package.json` has `tabby-` in the name, `tabby-plugin` in `keywords` **and an `author`** (its finder does `info.author.name` and silently skips the plugin on error). `test/bridge-core.test.js` guards this.
- When editing files with `String.replace` from a script, pass a function as the replacement: `$'` and `$&` in a plain string are expanded (this once duplicated half of `app.js`).
- `bridge/` must stay CommonJS and dependency-free: Tabby supplies `@angular/core`, `tabby-core`, `tabby-terminal` at runtime. `test/bridge-core.test.js` loads `bridge/src/index.js` against mocked versions of those modules.
- **The Bridge has never been run inside a real Tabby** (no GUI automation here). Its Tabby-facing calls (`terminal.output$`, `sendInput`, `write('')`, `frontend.saveState()`, `setCustomTitle`, `destroy`, `ProfilesService.openNewTabForProfile`) were checked against the Tabby source cloned at `X:\third\tabby`, not against a running instance.
- Tabby's own tabs are split containers; panes are reached through `TerminalDecorator.attach`, not by walking `AppService.tabs`.
- `.omo/` (untracked) holds local planning drafts, not project source.
