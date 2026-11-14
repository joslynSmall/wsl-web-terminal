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

**Origin (来源)**:
The system a Bridge is running on, either Windows or WSL. The web UI shows it on a tab title only while Bridges from more than one Origin are connected. It is not a window number.
_Avoid_: Host, machine, platform (when speaking about this label)

**Environment (环境)**:
The system a Terminal Session itself runs on, either Windows or WSL. It is independent of Origin: a WSL pane opened inside a Windows Tabby still has Origin Windows but Environment WSL. The web UI marks a WSL pane's tab title with `[WSL]`.
_Avoid_: Origin (when speaking about this label), platform (when speaking about this label)
