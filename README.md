# WSL Web Terminal Hub

在浏览器（包括手机）里查看并操作你 **Tabby** 中已经打开的终端。网页里的每个标签页对应 Tabby 里的一个终端窗格，两边实时同步：在哪边打字，另一边都能看到；在 Tabby 里切换标签，网页也跟着切。

> 项目名里的 WSL 是历史遗留。现在不再依赖 WSL 或 tmux，服务可以跑在任何系统上，设计决定见 [`docs/adr/0001-mirror-tabby-instead-of-tmux.md`](docs/adr/0001-mirror-tabby-instead-of-tmux.md)，术语见 [`CONTEXT.md`](CONTEXT.md)。

## 适合做什么

- 人离开电脑，用手机继续看 Claude Code、编译、部署等长时间任务的输出，必要时敲几个命令。
- 在另一台电脑或平板的浏览器里接管家里/公司电脑上 Tabby 的现有终端，不用新开 SSH、不用重新登录。
- 不想为了远程访问把 shell 搬进 tmux：终端还是原来的 Tabby 终端，网页只是它的一面镜子。
- Windows 和 WSL 的终端一起看：在 Windows 版 Tabby 里开的 WSL 窗格（比如资源管理器里对 `\\wsl$\...` 文件夹 Shift 右键打开的）也是 Tabby 的普通窗格，和 PowerShell/CMD 窗格一样出现在网页上，不需要在 WSL 里另装 Tabby。

## 主要特点

- **镜像而不是新建**：显示的就是 Tabby 里正在运行的那个终端，进程、历史、当前屏幕都是原样，包括 vim、htop、Claude Code 这类全屏程序。
- **双向实时**：网页里的输入会写进 Tabby 的终端，Tabby 里的输出会推到网页。
- **网页铺满**：网页用正常字号铺满浏览器，手机上也一样；网页打开着的窗格按网页的大小排版，关掉网页后交还给 Tabby。Tabby 里切换了有焦点的标签，网页自动切到同一个。
- **手机可用**：触摸平移、虚拟按键栏（Esc/Tab/Ctrl/方向键/`|` `/` `-` `~`）、可调字号。
- **不拖慢 Tabby**：网页太慢时服务只丢弃积压并重发当前屏幕，Tabby 本身从不被限速。
- **离线可用**：xterm.js 从本地 `node_modules` 提供，不依赖 CDN。
- **能在网页上开终端**：选 Windows shell 或 WSL 窗格，选工作目录（可以逐级点进去，也可以手填路径），还能从最近使用的目录里一键挑。

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

**6. 网页开着时，窗格按网页的大小排版。**
终端里的程序同一时刻只能按一个尺寸画画面。网页用正常字号（桌面 14px、手机 12px，A-/A+ 可调）算出浏览器里放得下的列×行，发给 Bridge，Bridge 改 Tabby 里该窗格的 xterm，Tabby 再把新尺寸交给 shell，所以网页总是铺满。浏览器缩放、手机转屏、软键盘弹起、全屏、调字号时都会重新算。
- 代价：网页开着期间，Tabby 窗口里这个窗格按网页的尺寸排版，会错位或显示不全。
- 最后一个网页离开（或服务断开）时，Bridge 让 Tabby 按自己的窗口重新适配，恢复原大小。
- 网页开着时你在 Tabby 里调整窗口，以 Tabby 为准；网页按新尺寸显示，等网页下次缩放再改回。
- 多个浏览器同时看同一个窗格时，以最后发出尺寸的那个为准。
- 万一窗格比网页大（比如上面那种情况），网页里滚动查看，光标和最后一行内容自动保持在可见范围内；你手动平移之后的几秒内不会被打扰。

## 快速开始

### 需要什么

- **Node.js 18 或更高**（在 v22 和 v24 上验证过）。查版本：`node --version`。
- **Tabby 1.0.238 或更高**（下载：https://github.com/Eugeny/tabby/releases）。Bridge 依赖 Tabby 的内部接口（`TerminalDecorator`、`ProfilesService` 等），更老的版本可能没有这些接口。
- 一个放这个项目的目录。

不需要装任何额外的终端软件，WSL 也不是必需的（见下面的「服务跑在哪」）。

### 三步装好

**第 1 步：拿到代码并装依赖**

```bash
git clone <本仓库地址> && cd wsl-web-terminal
npm install
```

**第 2 步：把 Bridge 装进 Tabby**

Bridge 是一个 Tabby 插件，必须放进 **Tabby 所在那个系统** 的插件目录：

```bash
npm run install-bridge
```

这一步会把 `bridge/` 复制到插件目录。如果提示「Tabby's plugin folder was not found」，说明 Tabby 还没启动过——先启动一次 Tabby 再执行，或者用 `--dir` 指定路径（见下面「装到别的系统」）。

**第 3 步：完全退出并重新打开 Tabby，然后启动服务**

Tabby 只在启动时加载插件，所以装完**必须完全退出 Tabby 再打开**（Windows 上注意托盘图标也要退掉）。

```bash
npm start
```

看到这样的输出就成功了：

```
=======================================================
WSL Web Terminal Server is running (Tabby mirror)
URL: http://localhost:7890   Bridge endpoint: ws://localhost:7890/ws/bridge
Listening on 0.0.0.0; there is no authentication.
=======================================================
```

打开 <http://localhost:7890>，Tabby 里的终端标签就出现在网页上了。

> 服务和 Tabby 的启动顺序无所谓，谁先起都行。Tabby 晚启动也没关系，Bridge 会自动重连。
>
> 服务启动时还会打印几行非回环地址，那是给**另一侧**的 Tabby 填配置用的，本机用不到。

### 服务跑在哪、Tabby 跑在哪

服务、浏览器、Tabby 可以在同一个系统上，也可以在两边：

| 场景 | 服务装在哪 | Bridge 装在哪 | 要改配置吗 |
|---|---|---|---|
| 全在 Windows | Windows | Windows | 不用 |
| 全在 WSL | WSL | WSL | 不用 |
| 服务在 WSL，Tabby 在 Windows | WSL | **Windows** | 看下面「跨系统」 |
| 服务在 Windows，Tabby 在 WSL | Windows | **WSL** | 看下面「跨系统」 |

**Bridge 一定要装在 Tabby 所在的那个系统上。** 装错系统的话，网页会一直显示「等待 Tabby 连接」。

### 装到别的系统

`install-bridge` 默认按**运行它的那个系统**决定插件目录。所以如果服务在 WSL、Tabby 在 Windows，要在 **Windows** 上跑这一步：

```cmd
:: 在 Windows 的 PowerShell 或 cmd 里，cd 到项目目录后
npm run install-bridge
```

或者用 `--dir` 明确指定 Tabby 的插件目录：

```bash
# 在 WSL 上，给 Windows 版 Tabby 装：Windows 路径会自动映射到 /mnt/c/...
npm run install-bridge -- --dir 'C:\Users\<你的用户名>\AppData\Roaming\tabby\plugins\node_modules'

# 或者直接写挂载点路径
npm run install-bridge -- --dir '/mnt/c/Users/<你的用户名>/AppData/Roaming/tabby/plugins/node_modules'
```

各系统的默认插件目录：

| 系统 | 路径 |
|---|---|
| Windows | `%APPDATA%\tabby\plugins\node_modules` |
| macOS | `~/Library/Application Support/tabby/plugins/node_modules` |
| Linux / WSL | `~/.config/tabby/plugins/node_modules` |

指定的目录必须**已经存在**（Tabby 第一次运行时会自己建）。路径不存在时报错退出，不会凭空造一个目录出来。

### 跨系统（服务在一侧，Tabby 在另一侧）

两边默认都连 `ws://localhost:7890`。**WSL 用 Mirrored 网络时两边共用 `localhost`**，不需要改任何配置：

```ini
# %UserProfile%\.wslconfig
[wsl2]
networkingMode=Mirrored
```

NAT 网络（WSL 默认）下两边的 `localhost` 不是同一个地址。这时看服务启动日志里打印的地址：

```
另一侧的 Tabby 把 wslWebBridge.serverUrl 设成下面任一地址：
  ws://192.168.77.1:7890
  ws://192.168.15.188:7890
```

把 Windows 能连上的那一个填进 **Tabby → 设置 → 配置文件**：

```yaml
wslWebBridge:
  serverUrl: ws://192.168.77.1:7890
```

改完重启 Tabby。日志里没有非回环地址时，保持默认的 `ws://localhost:7890`。地址变了要再改一次。

### 确认装好了

```bash
curl http://localhost:7890/api/sessions
```

返回的 JSON 里 `bridges` 是已连接的 Bridge 数量（至少 1），`sessions` 是 Tabby 里正在运行的终端。`bridges` 是 0 就是 Bridge 没连上，看下面的常见问题。

### 让服务常驻

`npm start` 会占住前台。长期使用按自己的习惯后台常驻，比如：

```bash
# Linux / WSL
nohup npm start > ~/wsl-web-terminal.log 2>&1 &

# Windows PowerShell
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'src/server.js'
```

### 日常使用

1. 保持服务运行和 Tabby 运行。
2. 浏览器打开服务地址，点标签页切换终端，直接在终端区域打字。
3. 需要时用顶部按钮：
   - **新建**：打开新建面板，可以选环境（Windows shell 或 WSL 窗格）和工作目录，再开一个新标签页。
   - **A- / A+**：调整网页里的终端字号（8–26px）。
   - **按键 / 折叠**：显示或隐藏底部虚拟按键栏（手机端）。
   - **全屏模式**：浏览器全屏，字号不变，多出来的地方变成更多的行和列。
   - **刷新**：重新拉取会话列表。
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
| 来源 | Windows 和 WSL 的 Tabby 连到同一份服务。只有一个来源时标题不加来源名；两侧同时连着时，标题前面加 `[Windows]` 或 `[WSL]`。没报来源的显示 `[未知]` |
| 终端尺寸 | 网页开着时，窗格按网页正常字号（桌面 14px，手机 12px，可用 A-/A+ 调整）能放下的列×行排版，网页铺满；此时 Tabby 窗口里这个窗格会错位。最后一个网页关掉后，Tabby 按自己的窗口恢复原大小 |
| 焦点 | 刷新网页后默认选中 Tabby 里当前有焦点的终端；之后 Tabby 切换标签时网页跟着切，网页里手动选的标签不会被拉回 |
| 首次打开 | 还原当前屏幕和最近约 1000 行历史，之后只推增量 |
| 新建窗口 | 在**最近获得焦点的 Tabby 窗口**里开新标签页。面板里可选环境：**Windows shell**（PowerShell / CMD）或 **WSL 窗格**（`wsl.exe --distribution Ubuntu`）；两者都开在 Windows 版 Tabby 里 |
| 新建时的工作目录 | 面板里点「更改」进目录浏览器，逐级点进子目录或手填路径，再点「用这个目录」。目录按环境过滤：Windows shell 列 Windows 侧目录，WSL 窗格列 WSL 侧目录（显示隐藏项，目录在前文件在后）。不选就用该 profile 的默认目录 |
| 最近使用的目录 | 面板在工作目录下方按环境分别记住最近 6 个用过的目录，点一下即选中。目录被删掉后，下次打开面板会自动从列表里剔除 |
| 窗格的环境标记 | 跑在 WSL 里的窗格，标签标题前带 `[WSL]`。这是**终端实际所在系统**，和「来源」（Bridge 所在的系统）是两回事，Windows Tabby 里开的 WSL 窗格来源仍是 Windows |
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

Bridge 的服务地址默认 `ws://localhost:7890`。同一侧的 Tabby（服务和 Tabby 都在 Windows，或都在 WSL）不用改。WSL 用 Mirrored 网络（`.wslconfig` 里 `networkingMode=Mirrored`）时，两边共用 `localhost`，服务在 WSL、Tabby 在 Windows 也不用改。NAT 网络下两边的 `localhost` 不是同一个地址：看服务启动日志里列出的非回环地址，把 Windows 能连上的那一个写进那个 Tabby 的 **设置 → 配置文件**：

```yaml
wslWebBridge:
  serverUrl: ws://服务打印出来的地址:7890
```

日志里没有非回环地址时，保持默认的 `ws://localhost:7890`。地址变了要再改一次。

`npm run install-bridge -- --dir <路径>` 可以指定 Tabby 的插件目录（默认：Windows `%APPDATA%\tabby\plugins\node_modules`，macOS `~/Library/Application Support/tabby/plugins/node_modules`，Linux `~/.config/tabby/plugins/node_modules`）。在 WSL 里给 Windows 版 Tabby 装时，Windows 路径会自动映射到 `/mnt/<盘符>/`。

## 常见问题

**网页一直显示“等待 Tabby 连接”**
按顺序查：

1. 服务在运行吗？`curl http://localhost:7890/api/sessions` 有没有响应。
2. Bridge 装在**正确的系统**上了吗？Bridge 必须和 Tabby 在同一台机器上——服务在 WSL、Tabby 在 Windows 时，要在 **Windows** 上跑 `npm run install-bridge`，见上面「装到别的系统」。这是最常见的原因。
3. Tabby **完全重启**过吗？插件只在启动时加载，装完不重启等于没装。
4. 版本对吗？服务启动日志会打印 Bridge 的版本号，`0.2.1` 是当前版本；更低的版本不认识新建/列目录这些命令。版本低就在 Tabby 那个系统上重新 `npm run install-bridge`。
5. 服务不在 Tabby 所在机器上时，检查 Tabby 里的 `wslWebBridge.serverUrl` 是不是填了服务日志里打印的地址。

再看 Tabby 开发者工具控制台里 `[wsl-web-bridge]` 开头的日志，那里有具体的报错。

**网页里切换标签没跟着 Tabby 走 / 刷新后选错了标签**
通常是插件或服务还是旧版本：重新 `npm run install-bridge`、重启 Tabby、重启服务。可以用 `curl localhost:7890/api/sessions` 看返回里有没有 `focusedId`。

**网页上的“新建”没有 WSL 选项 / 目录列表报错**
新建面板、目录浏览器和最近目录是 0.2.1 才有的功能，需要 Tabby 那个系统上装的是 0.2.1 以上的 Bridge。在 Tabby 所在系统上重新 `npm run install-bridge` 并重启 Tabby。

**新建出来的 WSL 终端不在我想要的目录**
`wsl.exe` 指定的目录不存在时不会报错，而是让 shell 落在 `/`。用面板里的目录浏览器选（它读的是真实目录），或手动输入后先确认路径存在。

**网页没有铺满 / 终端内容看不全**
网页开着时会把窗格改成网页的大小。没铺满时先看 Tabby 里装的是不是 0.1.4 以上的 Bridge（服务启动日志会打印 Bridge 版本）：旧版收不到改尺寸的请求，网页只能按 Tabby 的尺寸显示，多出来的地方空着，放不下时滚动。另外，网页开着时你在 Tabby 里调整窗口，会暂时以 Tabby 为准，缩放一下浏览器窗口就会再铺满。

**关掉网页后 Tabby 里的窗格大小不对**
Bridge 会让 Tabby 按自己的窗口重新适配。没恢复时，在 Tabby 里点一下那个窗格或调整一下窗口大小。

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
| `/api/sessions` | `GET` | `{ success, bridges, sessions: [{ id, title, cols, rows, windowNo, origin, environment }], focusedId }`（`focusedId` 是最近活跃的 Tabby 窗口里当前有焦点的会话，没有则为 `null`；`origin` 是 Bridge 所在系统，`environment` 是终端实际所在系统） |
| `/api/sessions` | `POST` | Body: `{ environment?: "Windows" \| "WSL", cwd?: string }`。在最近活跃的 Tabby 窗口新建标签页，返回 `201 { session }`（没有 Bridge 时 `503`）。`cwd` 用所选环境的路径形式（Windows 路径或 Linux 路径），不传就用 profile 默认目录 |
| `/api/directories` | `GET` | Query: `path`。列目录，给网页的目录选择器用，返回 `{ success, listing: { path, parent, name, directories, files } }`。由 Bridge 读取，WSL 目录经 `\\wsl$\Ubuntu\...` 读取 |
| `/api/directories/exists` | `GET` | Query: `path`。判断目录是否还在，返回 `{ success, exists }`。网页用它剔除已删除的最近目录 |
| `/api/sessions/:id/rename` | `POST` | Body: `{ name }` |
| `/api/sessions/:id` | `DELETE` | 关闭 Tabby 里对应的窗格 |

### 浏览器 WebSocket：`/ws/terminal?session=<id>`

全部是 JSON 文本帧。

- 浏览器 → 服务：`{ "t": "input", "data": "ls\r" }`、`{ "t": "resize", "cols", "rows" }`（网页正常字号下放得下的列×行，连接后和网页大小变化时发送）
- 服务 → 浏览器：`{ "t": "snapshot", "data", "cols", "rows" }`（连接后第一条）、`{ "t": "output", "data" }`、`{ "t": "size", "cols", "rows" }`、`{ "t": "closed" }`
- 关闭码：`4404` 会话不存在，`4410` 会话已关闭或 Bridge 断开

### Bridge WebSocket：`/ws/bridge`

Bridge → 服务：`hello`、`sessions`（完整列表，含每个会话的 `focused` 和 `environment`，变化时发送）、`output`（带序号，仅在有网页观看时发送）、`snapshot`、`focus`（Tabby 窗口获得焦点）、`result`。
服务 → Bridge：`watch`、`snapshot-request`、`input`、`resize`、`create`、`rename`、`close`、`create-in`（带环境和工作目录新建）、`list-dirs`（列目录）、`check-dir`（判断目录是否还在）。`watch` 关掉时 Bridge 把尺寸交还给 Tabby。`create-in`、`list-dirs`、`check-dir` 需要 Bridge 0.2.1 以上，旧版会拒绝并在网页上报错。
输出序号让服务端能把“屏幕快照”和之后的增量对齐，不重复也不丢。细节见 `src/session-hub.js` 和 `bridge/src/bridge-core.js`。

## 项目结构

```
src/session-hub.js        会话中心：Bridge/会话/浏览器连接的核心逻辑，不直接碰 socket，便于测试
src/server.js             Express 路由 + 两个 WebSocket 服务 + 来源/Host 校验 + 心跳
bridge/src/bridge-core.js Bridge 的全部逻辑，不依赖 Tabby 的类，用假对象测试
bridge/src/index.js       Tabby 插件的薄封装（TerminalDecorator、配置项）
bridge/src/paths.js       Windows 路径 ↔ WSL 路径（Linux 与 \\wsl$\... UNC）互转
bridge/src/directories.js 列目录、判断目录是否存在（WSL 目录经 UNC 读取）
bridge/scripts/install.mjs 把 Bridge 复制进 Tabby 的插件目录（支持跨系统：Windows 路径在 WSL 里自动映射）
public/                   网页（index.html、app.js、style.css），xterm.js 来自 /vendor/*
test/                     测试
docs/adr/                 设计决定记录
docs/flows/               业务流程图谱（分支 ↔ 代码 ↔ 测试的对应关系）
CONTEXT.md                术语表（终端会话、桥接会话、桥接器、来源、环境）
```

整个项目是 ESM（`"type": "module"`），只有 `bridge/` 是 CommonJS（Tabby 用 `require` 加载它）且不带依赖。没有构建步骤、没有打包器。

## 开发与测试

```bash
npm run dev     # 文件改动自动重启服务
npm test        # 全部测试，不需要 Tabby、不需要网络
node --test --test-name-pattern="<关键字>" test/session-hub.test.js   # 只跑某个测试
```

测试覆盖：会话中心逻辑、服务端（真实 HTTP/WebSocket，含来源校验和心跳）、Bridge 逻辑（用假的终端和 WebSocket）、前端逻辑（在 vm 里用假 DOM 运行 `public/app.js`）、安装脚本（插件装到哪、路径不对时报错）。

开发时的几个坑：

- `public/app.js` 是普通浏览器脚本，由 `test/app.test.js` 在 `vm` 里直接执行，不能用 ES module 语法；用到新的 DOM API 时要补测试里的假对象。
- Tabby 只加载 `package.json` 里同时满足“名字含 `tabby-`、`keywords` 含 `tabby-plugin`、有 `author`”的插件，缺 `author` 会被静默跳过（测试里有检查）。
- 前端库要加新依赖时，需要在 `server.js` 里加对应的 `/vendor/*` 静态路由。

**已验证**：Bridge 0.2.1 在真实 Tabby 1.0.238（Windows 版）里跑通——能上报窗格、镜像输出、接收输入、按网页尺寸改排版、列 WSL 目录。

**未验证的部分**：在真实 Tabby 里通过网页「新建」出一个 WSL 窗格的完整链路（这一步要在 Tabby 图形界面里操作，自动化测试覆盖不到）。Bridge 依赖 Tabby 的内部接口（`TerminalDecorator`、`ProfilesService`、`hasFocus`、`focused$`、xterm 的 serialize 插件等），升级 Tabby 后如果网页一直显示“等待 Tabby 连接”，或全屏程序在网页里只显示底下的 shell，先看上面的常见问题。
