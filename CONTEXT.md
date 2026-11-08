# WSL Web Terminal

A web UI for viewing and driving, from a browser, the terminals the user already has open in Tabby, so the same terminal can be used from a desktop and a phone.

## Language

**Terminal Session (终端会话)**:
A live shell the web UI can show and type into, and that keeps running while no browser is connected. Each one appears as one tab. Today every Terminal Session is a Bridged Session.
_Avoid_: Window, shell, tab (a tab is only its on-screen representation)

**Bridged Session (桥接会话)**:
A Terminal Session that lives inside a third-party terminal app, such as one pane of a Tabby tab (a split Tabby tab holds several), and is shown and driven in the web UI through a Bridge.
_Avoid_: Mirrored tab, attached shell, external shell

**Bridge (桥接器)**:
The piece running inside a third-party terminal app (one per Tabby window) that connects its sessions to this application's server.
_Avoid_: Plugin (when speaking about the concept rather than Tabby's packaging), connector, agent
