# WSL Web Terminal Hub (wsl-web-terminal)

轻量、高性能、进程持久的 WSL2 多终端 Web 交互管理平台。通过宿主机浏览器即可实时查看本地 WSL 中所有运行的 Linux Shell 窗口输出，并随时切换至任意窗口进行低延迟的双向打字与命令交互，同时支持在网页上直接新建与销毁窗口。

---

## 🌟 核心特性

1. **会话与窗口全景发现**：自动发现并纳管本机 WSL2 中运行的所有 `tmux` 会话与 Shell 窗口，多窗口集中呈现在 Web 界面。
2. **零数据破坏与双向同步**：基于成熟的终端多路复用机制，彻底避免直接窥探 `/dev/pts` 导致的字符抢占与乱码；Web 端与外部终端可双向同时查看与输入。
3. **进程脱机持久化**：会话与后台任务在 Linux 内核层独立持久运行。即使刷新浏览器、关闭网页或断开网络，编译、训练等长耗时任务丝毫不受影响，重新打开网页即刻无缝恢复。
4. **全生命周期交互管理**：
   - 顶部选项卡（Tabs）一键平滑切换不同 Shell 窗口；
   - 支持在 Web 界面点击 **➕ 新建窗口** 快速派生新的 Shell；
   - 支持点击 **✕ 关闭窗口** 优雅销毁指定窗口。
5. **高保真终端视口**：
   - 嵌入现代轻量 `xterm.js` 终端渲染引擎，支持 ANSI/VT100 控制序列、256 色/真彩色高保真渲染；
   - 配备 `FitAddon` 视口自适应插件，窗口缩放时自动双向同步调整 PTY 列数与行数（Resize 协商）；
   - 包含超链接自动识别与点击跳转插件 (`WebLinksAddon`)。
6. **离线自包含与单端口设计**：
   - 前端所有库（xterm.js、样式、插件）均由后端本地托管，零外部 CDN 依赖，断网也能正常运行；
   - 单一 Express + WebSocket 整合服务，默认仅占用端口 `7890`，无额外微服务负担。

---

## 📁 目录结构

```
wsl-web-terminal/
├── package.json           # 项目配置与核心依赖 (express, ws, node-pty)
├── README.md              # 完整项目文档与使用指南
├── src/
│   ├── server.js          # HTTP 静态服务与 WebSocket 终端流桥接服务
│   └── tmux-service.js    # Tmux 会话/窗口发现、创建、关闭与生命周期管理服务
├── public/
│   ├── index.html         # 单页面终端控制台骨架
│   ├── style.css          # 现代化极简深色主题样式 (Nord/Catppuccin 风格)
│   └── app.js             # 前端多标签管理、xterm.js 实例挂载与双向交互逻辑
└── test/
    └── e2e-verify.js      # 端到端自动化集成验证脚本
```

---

## 🚀 快速上手

### 1. 前置环境
- WSL2 (Ubuntu / Debian 或其他 Linux 发行版)
- Node.js (推荐 v18+，已在 v22.22.0 验证通过)
- tmux (系统中已安装：`which tmux`)

### 2. 启动服务
进入项目目录并执行启动命令：

```bash
cd /home/joslyn/code/github_me/wsl-web-terminal

# 安装依赖（首次运行已完成，如有需要可重新安装）
npm install

# 启动服务
npm start
```

终端将打印启动提示：
```text
=======================================================
🚀 WSL Web Terminal Server is running!
📡 URL: http://localhost:7890
=======================================================
```

### 3. 访问与使用
在 Windows 宿主机或任意局域网设备上的浏览器打开：
👉 **http://localhost:7890**

- **查看窗口**：顶部标签栏会自动罗列当前 WSL 中的所有 Shell 窗口（如 `[#0] shell-1`, `[#1] shell-2`）。
- **切换窗口**：点击任意标签，终端区域将平滑切换到该窗口，即刻显示历史缓冲区与当前提示符。
- **打字输入**：直接在终端中键入命令（如 `top`, `htop`, `ls -la`, `curl`, `python3` 等），按键即时响应。
- **新建窗口**：点击右上角 **➕ 新建窗口** 按钮，输入窗口名称即可秒级新建一个独立 Shell。
- **关闭窗口**：点击标签上的小叉号 **✕**，确认后即可安全关闭指定窗口。
- **外部终端互通**：在 Windows Terminal 或命令行中运行 `tmux a -t wsl-web`，即可与 Web 端实现实时同屏双向同步！

---

## 🔌 API 与通信接口

### 1. REST 接口
| 路径 | 方法 | 描述 | 请求/返回格式 |
| :--- | :---: | :--- | :--- |
| `/api/windows` | `GET` | 列出所有活动的窗口列表 | `{ success: true, windows: [...] }` |
| `/api/windows` | `POST` | 新建一个 Shell 窗口 | Body: `{ name?: string }` |
| `/api/windows/:target` | `DELETE` | 关闭指定的 Shell 窗口 | 返回: `{ success: true }` |
| `/api/windows/rename` | `POST` | 重命名指定窗口 | Body: `{ target: string, name: string }` |

### 2. WebSocket 终端协议
- **连接地址**：`ws://<host>:7890/ws/terminal?target=<session:index>&cols=<cols>&rows=<rows>`
- **双向数据流**：
  - 客户端发送原生字符串/按键数据 -> 直接注入 PTY `stdin`；
  - PTY 输出流 -> 实时推送到客户端 `term.write(data)`；
  - 客户端窗口缩放时发送：`{"type": "resize", "cols": 120, "rows": 36}` -> 触发 PTY `resize` 并自适应 tmux。

---

## 🧪 自动化测试验证

项目内置了完整的端到端自动化测试套件：

```bash
node test/e2e-verify.js
```

测试覆盖范围：
- ✅ 静态 HTML / CSS / 离线 Vendor 资源托管检测
- ✅ `GET /api/windows` 窗口列表查询接口测试
- ✅ `POST /api/windows` 动态窗口创建与分配测试
- ✅ WebSocket 全双工终端流实时连通性、命令回显验证 (`echo`)
- ✅ 动态 PTY Resize 尺寸协商机制验证
- ✅ `DELETE /api/windows/:target` 窗口安全销毁测试
