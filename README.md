# WSL Web Terminal Hub

在浏览器（包括手机）里查看并操作你 **Tabby** 中已经打开的终端。网页里的每个标签页对应 Tabby 里的一个终端窗格，两边实时同步：在哪边打字，另一边都能看到；在 Tabby 里切换标签，网页也跟着切。

> 项目名里的 WSL 是历史遗留。现在不再依赖 WSL 或 tmux，服务可以跑在任何系统上，设计决定见 [`docs/adr/0001-mirror-tabby-instead-of-tmux.md`](docs/adr/0001-mirror-tabby-instead-of-tmux.md)，术语见 [`CONTEXT.md`](CONTEXT.md)。

## 适合做什么

- 人离开电脑，用手机继续看 Claude Code、编译、部署等长时间任务的输出，必要时敲几个命令。
- 在另一台电脑或平板的浏览器里接管家里/公司电脑上 Tabby 的现有终端，不用新开 SSH、不用重新登录。
- 不想为了远程访问把 shell 搬进 tmux：终端还是原来的 Tabby 终端，网页只是它的一面镜子。

## 主要特点

- **镜像而不是新建**：显示的就是 Tabby 里正在运行的那个终端，进程、历史、当前屏幕都是原样，包括 vim、htop、Claude Code 这类全屏程序。
- **双向实时**：网页里的输入会写进 Tabby 的终端，Tabby 里的输出会推到网页。
- **跟随 Tabby**：终端的列×行始终以 Tabby 为准，网页不会改动 Tabby 的排版；Tabby 里切换了有焦点的标签，网页自动切到同一个。
- **手机可用**：触摸平移、虚拟按键栏（Esc/Tab/Ctrl/方向键/`|` `/` `-` `~`）、可调字号。
- **不拖慢 Tabby**：网页太慢时服务只丢弃积压并重发当前屏幕，Tabby 本身从不被限速。
- **离线可用**：xterm.js 从本地 `node_modules` 提供，不依赖 CDN。

## 工作方式

```
浏览器 ──ws /ws/terminal?session=ID──▶ Node 服务 ◀──ws /ws/bridge── Bridge（Tabby 插件）──▶ Tabby 的终端窗格
```

三个角色：

| 角色 | 位置 | 做什么 |
|---|---|---|
| **服务** | `src/`，独立 Node 进程 | 提供网页和 REST/WebSocket 接口，汇总所有 Bridge 报上来的会话，把输出分发给浏览器 |
| **Bridge** | `bridge/`，Tabby 插件，每个 Tabby 窗口一份 | 主动连到服务，报告自己的终端窗格，转发输出，接收输入，响应新建/重命名/关闭 |
| **网页** | `public/`，原生 JS 单页，无框架 | 用 xterm.js 画终端，把按键发回服务 |

Bridge 是**主动连出去**的，所以服务可以单独重启，Tabby 不用动；Tabby 重启后 Bridge 会自动重连。Tabby 没运行或 Bridge 没连上时，网页显示“等待 Tabby 连接”，没有任何会话可用。

### 原理要点

**1. 屏幕快照 + 输出序号，保证新打开的网页不重不漏。**
网页打开某个会话时，服务先把它收到的实时输出暂存起来，再向 Bridge 要一份当前屏幕的快照。Bridge 给快照打上“它已覆盖到的最后一个输出序号”，服务只回放序号更大的暂存输出。每次快照请求都有自己的 `reqId`，过期请求的回复会被忽略。快照包含最近约 1000 行历史。

**2. 有人看才推输出。**
Bridge 只在至少有一个网页正在查看某个会话时，才转发它的输出（`watch`/`unwatch`）。没人看时 Tabby 这边几乎零开销。

**3. 慢网页不拖累 Tabby。**
如果某个网页的连接积压过多（或快照前的缓冲溢出），服务丢弃它的积压，重新要一份快照让它追上。Tabby 一侧永远不会被限速。

**4. 快照要包含“备用屏幕”。**
Tabby 自带的 `saveState()` 会排除备用屏幕，全屏程序（Claude Code、vim、htop）运行时网页只能看到它下面的 shell。Bridge 因此直接调用 Tabby 里 xterm 的 serialize 插件，把备用屏幕和终端模式一起序列化；取不到时才退回 `saveState()`。

**4. 网页的 xterm 不回应终端查询。**
Tabby 自己的 xterm 已经会回应 DA1/DA2、光标位置、颜色查询等；网页再回一次，回复会被当成键盘输入打进 shell（表现为命令前多出 `[?1;2c`）。所以网页在解析阶段把这些查询吞掉，但颜色**设置**序列照常处理。

**5. 焦点同步。**
Bridge 每次上报会话列表时带上每个窗格是否有焦点（取自 Tabby 的 `hasFocus`），Tabby 里焦点一变就立刻上报。服务据此给出“最近活跃的 Tabby 窗口里当前有焦点的会话”（`/api/sessions` 的 `focusedId`）。网页每秒轮询一次，刷新后默认选中它，之后只在这个值**变化**的那一刻跟着切换，所以你在网页里手动点了别的标签不会被拉回去。

**6. 尺寸永远来自 Tabby。**
网页从不上报自己的尺寸，也不为了塞进屏幕而缩小字号。终端比屏幕大时在页面里滚动（有滚动条），光标和最后一行内容自动保持在可见范围内；你手动平移之后的几秒内不会被打扰。

## 快速开始

需要 Node.js 18+（在 v24 上验证）和 Tabby。

```bash
git clone <本仓库> && cd wsl-web-terminal
npm install
npm start                 # 启动服务，默认 http://localhost:7890
npm run install-bridge    # 把 Bridge 复制进 Tabby 的插件目录
```

然后 **完全退出并重新打开 Tabby**，几秒内 Bridge 会连上服务。打开 <http://localhost:7890>，Tabby 里的终端标签就出现在网页上了。

> 服务和 Tabby 的启动顺序无所谓，谁先起都行。

### 日常使用

1. 保持服务运行（`npm start`，或用你习惯的方式后台常驻）和 Tabby 运行。
2. 浏览器打开服务地址，点标签页切换终端，直接在终端区域打字。
3. 需要时用顶部按钮：
   - **➕ 新建窗口**：在最近获得焦点的 Tabby 窗口里用默认 profile 开一个新标签页。
   - **A- / A+**：调整网页里的终端字号（8–26px）。
   - **⌨️ 按键 / 折叠**：显示或隐藏底部虚拟按键栏。
   - **⛶ 全屏模式**：浏览器全屏。
   - **🔄 刷新**：重新拉取会话列表。
4. 双击标签页可重命名（作用在 Tabby 里真实的标签页上）；标签上的 × 会关闭 Tabby 里对应的终端并结束里面的进程，有确认弹窗。

### 在手机上用

1. 电脑和手机在同一个局域网，电脑上服务保持默认 `HOST=0.0.0.0`。
2. 用手机浏览器打开 `http://电脑的局域网IP:7890`（电脑防火墙需要放行该端口）。
3. 用主机名访问时（而不是 IP），要把它加进 `ALLOWED_HOSTS`，见下面的配置。
4. 操作：
   - 单指**横向**拖动：平移终端。
   - **竖向**拖动：先平移页面，到头后再滚动终端历史；程序开启了鼠标模式（vim、less、htop）时竖向拖动变成滚轮。
   - 顶部虚拟按键栏提供 Esc/Tab/Ctrl（点一下进入黏滞状态，再按字母发出 Ctrl 组合）/回车/Ctrl+C/方向键等；点 ⌨️ 唤起手机输入法。
   - 菜单 ☰ 里有字号、全屏、刷新等。

> **安全提醒**：服务没有认证，局域网里能访问到端口的人就能操作你的终端，见下面的“安全”一节。不要把端口直接暴露到公网。

### 更新 Bridge

Bridge 的代码被复制进了 Tabby 的插件目录，所以**改了 `bridge/` 之后必须重新执行 `npm run install-bridge` 并重启 Tabby**，否则 Tabby 里跑的还是旧版本。服务端和网页（`src/`、`public/`）的改动只需要重启服务（网页文件刷新页面即可，不用重启）。

## 行为约定

| 方面 | 行为 |
|---|---|
| 哪些终端会出现 | Tabby 里所有终端类窗格（本地 shell、SSH、串口、Telnet）。分屏标签页里每个窗格是网页里的一个标签 |
| 多个 Tabby 窗口 | 全部汇总到同一个标签栏，超过一个窗口时标题带 `[W1]`、`[W2]` 前缀 |
| 终端尺寸 | 网页**跟随 Tabby** 的列×行，不会改动 Tabby 里的排版。字号是正常的网页字号（桌面 14px，手机 12px，可用 A-/A+ 调整），终端比屏幕大时在页面里滚动 |
| 焦点 | 刷新网页后默认选中 Tabby 里当前有焦点的终端；之后 Tabby 切换标签时网页跟着切，网页里手动选的标签不会被拉回 |
| 首次打开 | 还原当前屏幕和最近约 1000 行历史，之后只推增量 |
| 新建窗口 | 在**最近获得焦点的 Tabby 窗口**里用默认 profile 开新标签页 |
| 重命名 / 关闭 | 作用在 Tabby 里真实的标签页上；关闭会结束里面的进程，有确认弹窗 |
| 网页太慢 | 服务端缓冲写满就丢弃积压并重发当前屏幕，不会拖慢 Tabby；网页里可能缺一段滚动内容，Tabby 里是完整的 |
| Tabby 关闭 | 没有会话可显示（服务不会自己启动 shell），Tabby 重新打开后自动恢复 |

## 配置

服务的环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7890` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址。手机或局域网访问需要保持 `0.0.0.0`，仅本机用可设为 `127.0.0.1` |
| `ALLOWED_HOSTS` | 空 | 额外允许的主机名，逗号分隔。默认只接受 IP 地址、`localhost` 和本机主机名 |

例：`PORT=8080 ALLOWED_HOSTS=mypc.local npm start`（PowerShell 里先 `$env:PORT=8080`）。

Bridge 的服务地址默认 `ws://localhost:7890`。服务不在本机或换了端口时，在 Tabby 的 **设置 → 配置文件** 里加上：

```yaml
wslWebBridge:
  serverUrl: ws://电脑IP:7890
```

`npm run install-bridge -- --dir <路径>` 可以指定 Tabby 的插件目录（默认：Windows `%APPDATA%\tabby\plugins\node_modules`，macOS `~/Library/Application Support/tabby/plugins/node_modules`，Linux `~/.config/tabby/plugins/node_modules`）。

## 常见问题

**网页一直显示“等待 Tabby 连接”**
先确认服务在运行、Bridge 已安装（`npm run install-bridge`）并且 Tabby 已经**完全重启**。再看 Tabby 开发者工具控制台里 `[wsl-web-bridge]` 开头的日志；服务启动日志里会打印 Bridge 连入和它的版本号，版本不对说明装的是旧插件。服务不在本机时检查 `wslWebBridge.serverUrl`。

**网页里切换标签没跟着 Tabby 走 / 刷新后选错了标签**
通常是插件或服务还是旧版本：重新 `npm run install-bridge`、重启 Tabby、重启服务。可以用 `curl localhost:7890/api/sessions` 看返回里有没有 `focusedId`。

**终端内容看不全**
终端尺寸由 Tabby 决定（比如 154×60），网页按正常字号显示，放不下时在页面里滚动，右侧和下方有滚动条。想一眼看全可以用 **A-** 缩小字号（最小 8px），或者把 Tabby 窗口缩小。

**手机能打开页面但没有终端 / 连接被拒绝**
用主机名访问时需要加进 `ALLOWED_HOSTS`；同时检查电脑防火墙是否放行端口。跨域请求和未知 `Host` 会被拒绝，这是有意的。

**命令前面出现 `[?1;2c` 之类的字符**
说明有两个终端同时在回应终端查询。网页端已经屏蔽了自己的回复，如果仍出现，检查是不是同时打开了其他 xterm 前端。

## 安全

**服务没有认证**（这是有意的设计），且默认监听所有网卡：能访问到端口的人就能操作你 Tabby 里的所有终端（包括 SSH 会话）。请只在可信的网络里使用，不要暴露到公网；需要远程访问时放在 VPN 或带认证的反向代理后面。

已有的防护：

- WebSocket 和 `/api` 请求只接受同源（`Origin` 与 `Host` 一致），其他网站无法借你的浏览器控制终端，也无法冒充 Bridge。
- 校验 `Host` 头，防 DNS rebinding。
- 心跳检测，清理死连接；非法消息一律忽略，不会让服务崩溃。

## 接口

### REST

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/sessions` | `GET` | `{ success, bridges, sessions: [{ id, title, cols, rows, windowNo }], focusedId }`（`focusedId` 是最近活跃的 Tabby 窗口里当前有焦点的会话，没有则为 `null`） |
| `/api/sessions` | `POST` | 在最近活跃的 Tabby 窗口新建标签页，返回 `201 { session }`（没有 Bridge 时 `503`） |
| `/api/sessions/:id/rename` | `POST` | Body: `{ name }` |
| `/api/sessions/:id` | `DELETE` | 关闭 Tabby 里对应的窗格 |

### 浏览器 WebSocket：`/ws/terminal?session=<id>`

全部是 JSON 文本帧。

- 浏览器 → 服务：`{ "t": "input", "data": "ls\r" }`
- 服务 → 浏览器：`{ "t": "snapshot", "data", "cols", "rows" }`（连接后第一条）、`{ "t": "output", "data" }`、`{ "t": "size", "cols", "rows" }`、`{ "t": "closed" }`
- 关闭码：`4404` 会话不存在，`4410` 会话已关闭或 Bridge 断开

### Bridge WebSocket：`/ws/bridge`

Bridge → 服务：`hello`、`sessions`（完整列表，含每个会话的 `focused`，变化时发送）、`output`（带序号，仅在有网页观看时发送）、`snapshot`、`focus`（Tabby 窗口获得焦点）、`result`。
服务 → Bridge：`watch`、`snapshot-request`、`input`、`create`、`rename`、`close`。
输出序号让服务端能把“屏幕快照”和之后的增量对齐，不重复也不丢。细节见 `src/session-hub.js` 和 `bridge/src/bridge-core.js`。

## 项目结构

```
src/session-hub.js        会话中心：Bridge/会话/浏览器连接的核心逻辑，不直接碰 socket，便于测试
src/server.js             Express 路由 + 两个 WebSocket 服务 + 来源/Host 校验 + 心跳
bridge/src/bridge-core.js Bridge 的全部逻辑，不依赖 Tabby 的类，用假对象测试
bridge/src/index.js       Tabby 插件的薄封装（TerminalDecorator、配置项）
bridge/scripts/install.mjs 把 Bridge 复制进 Tabby 的插件目录
public/                   网页（index.html、app.js、style.css），xterm.js 来自 /vendor/*
test/                     测试
docs/adr/                 设计决定记录
CONTEXT.md                术语表（终端会话、桥接会话、桥接器）
```

整个项目是 ESM（`"type": "module"`），只有 `bridge/` 是 CommonJS（Tabby 用 `require` 加载它）且不带依赖。没有构建步骤、没有打包器。

## 开发与测试

```bash
npm run dev     # 文件改动自动重启服务
npm test        # 全部测试，不需要 Tabby、不需要网络
node --test --test-name-pattern="<关键字>" test/session-hub.test.js   # 只跑某个测试
```

测试覆盖：会话中心逻辑、服务端（真实 HTTP/WebSocket，含来源校验和心跳）、Bridge 逻辑（用假的终端和 WebSocket）、前端逻辑（在 vm 里用假 DOM 运行 `public/app.js`）。

开发时的几个坑：

- `public/app.js` 是普通浏览器脚本，由 `test/app.test.js` 在 `vm` 里直接执行，不能用 ES module 语法；用到新的 DOM API 时要补测试里的假对象。
- Tabby 只加载 `package.json` 里同时满足“名字含 `tabby-`、`keywords` 含 `tabby-plugin`、有 `author`”的插件，缺 `author` 会被静默跳过（测试里有检查）。
- 前端库要加新依赖时，需要在 `server.js` 里加对应的 `/vendor/*` 静态路由。

**未验证的部分**：Bridge 在真实 Tabby 里的完整行为。它依赖 Tabby 的内部接口（`TerminalDecorator`、`ProfilesService`、`hasFocus`、`focused$`、xterm 的 serialize 插件等），目前主要是对照 Tabby 源码确认接口形状并用模拟对象测试。升级 Tabby 后如果网页一直显示“等待 Tabby 连接”，或全屏程序在网页里只显示底下的 shell，先看上面的常见问题。
