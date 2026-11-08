---
status: accepted
---

# Mirror Tabby tabs through a Bridge instead of using tmux

The project originally required WSL and tmux, with every shell living in a tmux window. The author does not use tmux and works in Tabby on Windows, and Windows gives no way for one process to read another process's console, so the web UI now shows and drives the user's existing Tabby tabs through a Bridge (a Tabby plugin) that connects out to a separate Node server. The tmux backend, the `ps`/`/proc` shell scanner and `join.sh` are removed rather than kept dormant, and the server does not start shells of its own in this first version.

## Considered Options

- Server-owned shells via node-pty/ConPTY: rejected for the first version because Tabby already provides creation, persistence and multiple tabs, and it would add a native build dependency and a full session lifecycle to maintain.
- Embedding the server inside the Tabby plugin: rejected so the web page survives a Tabby restart and the existing Express/WebSocket code and frontend can be reused.

## Consequences

- With Tabby closed or the Bridge disconnected, the web UI has no sessions to show.
- Only terminal apps with a Bridge are supported, and Tabby is the only one planned.
