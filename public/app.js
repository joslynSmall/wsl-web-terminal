let term = null;
let currentSocket = null;
let activeId = null;
let sessionList = [];
let sessionListSig = '';
let fitToScreen = false; // 全屏时自动选能把整个终端放下的最大字号；点 A-/A+ 后交还手动控制
let lastFocusedId = null; // Tabby 里上一次有焦点的会话，用来发现"焦点变了"
let bridgeCount = 0;
let baseFontSize = defaultFontSize();
let reconnectDelay = 1000;
let nextReconnectAt = 0;
let lastPanAt = 0;
let revealQueued = false;

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 26;
const FOLLOW_PAUSE_MS = 3000;

// 正常的网页字号：桌面 14px，手机 12px。终端的列数行数由 Tabby 决定，放不下时在页面里滚动，不缩小字体。
function defaultFontSize() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return 12;
  } catch {}
  return 14;
}
const MAX_RECONNECT_DELAY = 10000;

const appRootEl = document.getElementById('app-root');
const terminalWrapperEl = document.getElementById('terminal-wrapper');
const tabsListEl = document.getElementById('tabs-list');
const terminalContainerEl = document.getElementById('terminal-container');
const connectionBadgeEl = document.getElementById('connection-badge');
const emptyStateEl = document.getElementById('empty-state');

const btnFullscreen = document.getElementById('btn-fullscreen');
const btnNewWindow = document.getElementById('btn-new-window');
const btnRefresh = document.getElementById('btn-refresh');
const btnFontDec = document.getElementById('btn-font-dec');
const btnFontInc = document.getElementById('btn-font-inc');

const statusTargetEl = document.getElementById('status-target');
const statusWindowEl = document.getElementById('status-window');
const statusDimEl = document.getElementById('status-dim');

const accBarEl = document.getElementById('terminal-accessory-bar');
const btnCtrl = document.getElementById('acc-btn-ctrl');
const btnAlt = document.getElementById('acc-btn-alt');
const btnToggleKeys = document.getElementById('btn-toggle-keys');
const btnDrawerToggleKeys = document.getElementById('btn-drawer-toggle-keys');
let isCtrlActive = false;
let isAltActive = false;

const btnMobileMenu = document.getElementById('btn-mobile-menu');
const mobileMenuDrawerEl = document.getElementById('mobile-menu-drawer');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const mobileMenuBackdropEl = document.getElementById('mobile-menu-backdrop');
const btnDrawerFontDec = document.getElementById('btn-drawer-font-dec');
const btnDrawerFontInc = document.getElementById('btn-drawer-font-inc');
const btnDrawerFullscreen = document.getElementById('btn-drawer-fullscreen');
const btnDrawerRefresh = document.getElementById('btn-drawer-refresh');

// 终端查询(设备属性、光标位置、颜色等)的回复由 Tabby 那一侧的 xterm 负责。
// 网页里的 xterm 如果也回复，回复会被当成键盘输入打进 shell(例如命令前多出 "[?1;2c")，所以在解析阶段把查询吞掉。
function suppressTerminalReplies(t) {
  const parser = t && t.parser;
  if (!parser || !parser.registerCsiHandler) return;
  const swallow = () => true;
  [
    { final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, // DA1 / DA2 / DA3
    { final: 'n' }, { prefix: '?', final: 'n' },                               // DSR 状态与光标位置
    { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM
    { final: 't' },                                                            // 窗口操作报告
    { prefix: '>', final: 'q' }                                                // XTVERSION
  ].forEach((id) => parser.registerCsiHandler(id, swallow));
  if (parser.registerOscHandler) {
    // 只吞颜色查询(以 ? 结尾)，真正设置颜色的序列照常处理
    [4, 10, 11, 12, 17, 19].forEach((ident) => parser.registerOscHandler(ident, (data) => /(^|;)\?$/.test(data)));
  }
  if (parser.registerDcsHandler) {
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow); // DECRQSS
  }
}

function initTerminal() {
  term = new window.Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
    fontSize: baseFontSize,
    theme: {
      background: '#11111b',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#11111b',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    }
  });

  suppressTerminalReplies(term);

  if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  }

  term.open(terminalContainerEl);

  term.onData((data) => {
    let payload = data;
    if (isCtrlActive) {
      isCtrlActive = false;
      if (btnCtrl && btnCtrl.classList) btnCtrl.classList.remove('sticky-active');
      if (typeof payload === 'string' && payload.length === 1) {
        const charCode = payload.toLowerCase().charCodeAt(0);
        if (charCode >= 97 && charCode <= 122) {
          payload = String.fromCharCode(charCode - 96);
        } else if (payload === '[') {
          payload = '\x1b';
        } else if (payload === '\\') {
          payload = '\x1c';
        } else if (payload === ']') {
          payload = '\x1d';
        }
      }
    } else if (isAltActive) {
      isAltActive = false;
      if (btnAlt && btnAlt.classList) btnAlt.classList.remove('sticky-active');
      payload = '\x1b' + payload;
    }

    sendInput(payload);
  });

  // 移动端单指拖动：
  //  - 横向拖动：平移页面(终端比屏幕宽时)
  //  - 竖向拖动：程序开启了鼠标追踪(vim/less/htop 等)时转成 SGR 滚轮信号；
  //    否则先平移页面(终端比屏幕高时)，平移到头后再滚动终端的回滚缓冲区
  let touchStartX = 0;
  let touchStartY = 0;
  let touchLastX = 0;
  let touchLastY = 0;
  let touchAxis = null;
  let isSwiping = false;
  let scrollAccumulator = 0;

  if (terminalContainerEl && terminalContainerEl.addEventListener) {
    terminalContainerEl.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      touchStartX = touchLastX = e.touches[0].clientX;
      touchStartY = touchLastY = e.touches[0].clientY;
      touchAxis = null;
      isSwiping = false;
      scrollAccumulator = 0;
    }, { passive: true });

    terminalContainerEl.addEventListener('touchmove', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const diffX = currentX - touchLastX;
      const diffY = currentY - touchLastY;
      touchLastX = currentX;
      touchLastY = currentY;

      if (!touchAxis) {
        const distX = Math.abs(currentX - touchStartX);
        const distY = Math.abs(currentY - touchStartY);
        if (Math.max(distX, distY) <= 6) return;
        touchAxis = distY > distX ? 'y' : 'x';
      }
      isSwiping = true;
      lastPanAt = Date.now();

      if (touchAxis === 'x') {
        terminalContainerEl.scrollLeft = (terminalContainerEl.scrollLeft || 0) - diffX;
        return;
      }

      const mouseMode = term.modes && term.modes.mouseTrackingMode;
      if (mouseMode && mouseMode !== 'none') {
        scrollAccumulator += diffY;
        const lines = Math.trunc(scrollAccumulator / 16);
        if (lines === 0) return;
        scrollAccumulator %= 16;
        const screen = term.element && term.element.querySelector ? term.element.querySelector('.xterm-screen') : null;
        const rect = (screen || terminalContainerEl).getBoundingClientRect ? (screen || terminalContainerEl).getBoundingClientRect() : { left: 0, top: 0, width: 360, height: 600 };
        const cellWidth = (rect.width / (term.cols || 80)) || 9;
        const cellHeight = (rect.height / (term.rows || 24)) || 17;
        const col = Math.min(term.cols || 80, Math.max(1, Math.floor((currentX - rect.left) / cellWidth) + 1));
        const row = Math.min(term.rows || 24, Math.max(1, Math.floor((currentY - rect.top) / cellHeight) + 1));
        const seq = lines > 0 ? `\x1b[<64;${col};${row}M` : `\x1b[<65;${col};${row}M`;
        sendInput(seq.repeat(Math.abs(lines)));
        return;
      }

      // 先平移页面，没平移掉的部分用来滚动回滚缓冲区
      let remaining = diffY;
      const maxTop = terminalContainerEl.scrollHeight - terminalContainerEl.clientHeight;
      if (maxTop > 1) {
        const before = terminalContainerEl.scrollTop || 0;
        const after = Math.min(maxTop, Math.max(0, before - diffY));
        terminalContainerEl.scrollTop = after;
        remaining = diffY - (before - after);
      }
      scrollAccumulator += remaining;
      const lines = Math.trunc(scrollAccumulator / 16);
      if (lines !== 0) {
        scrollAccumulator %= 16;
        if (term.scrollLines) term.scrollLines(-lines);
      }
    }, { passive: true });

    terminalContainerEl.addEventListener('touchend', () => {
      if (!isSwiping) {
        if (term && term.focus) {
          term.focus();
        }
      }
      isSwiping = false;
    }, { passive: true });
  }

  window.addEventListener('resize', handleResize);

  // 软键盘弹出/收起时可视区会变化，重新让光标保持可见
  if (typeof window !== 'undefined' && window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleVisualViewportChange);
    window.visualViewport.addEventListener('scroll', handleVisualViewportChange);
  }
}

let resizeTimer = null;
function handleVisualViewportChange() {
  if (typeof window === 'undefined' || !window.visualViewport) return;
  // 软键盘弹起时防止整个页面被滚出视野，锁定在顶部
  window.scrollTo(0, 0);

  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    handleResize();
  }, 120);
}

function updateToggleAccessoryButton() {
  const iconEl = document.getElementById('acc-toggle-icon');
  const textEl = document.getElementById('acc-toggle-text');
  if (!accBarEl || !accBarEl.classList) return;
  const isCollapsed = accBarEl.classList.contains('collapsed');
  if (iconEl) iconEl.textContent = isCollapsed ? '▼' : '▲';
  if (textEl) textEl.textContent = isCollapsed ? '展开按键' : '折叠';
}

function toggleAccessoryBar() {
  if (!accBarEl || !accBarEl.classList) return;
  const isCollapsed = accBarEl.classList.contains('collapsed');
  if (isCollapsed) {
    accBarEl.classList.remove('collapsed');
  } else {
    accBarEl.classList.add('collapsed');
  }
  updateToggleAccessoryButton();
  try {
    localStorage.setItem('wsl_term_accessory_collapsed', (!isCollapsed) ? 'true' : 'false');
  } catch {}
  setTimeout(() => {
    handleResize();
  }, 50);
}

// 终端的列数和行数由 Tabby 决定，网页不会反向修改 Tabby 的尺寸，也不缩小字体；比屏幕大时在页面里滚动。
// 唯一的例外是全屏：此时可视区通常比 Tabby 的终端大，按基础字号会在下方/右侧留一大片空白，
// 所以全屏时挑能把整个终端放下的最大字号。只放大、不缩小：放不下时保持基础字号，靠滚动查看。
function applyFontSize() {
  if (!term) return;
  const target = (fitToScreen && fitFontSize()) || baseFontSize;
  if (term.options.fontSize !== target) {
    term.options.fontSize = target;
  }
}

// 按实测的像素尺寸找字号：单元格宽高会取整，不能只靠比例推算。设置字号后 .xterm-screen 的尺寸立即更新。
function fitFontSize() {
  const screen = term && term.element && term.element.querySelector ? term.element.querySelector('.xterm-screen') : null;
  const availW = terminalWrapperEl && terminalWrapperEl.clientWidth;
  const availH = terminalWrapperEl && terminalWrapperEl.clientHeight;
  if (!screen || !term.cols || !term.rows || !(availW > 0) || !(availH > 0)) return 0;
  const floor = Math.min(baseFontSize, MAX_FONT_SIZE);
  const clamp = (n) => Math.min(MAX_FONT_SIZE, Math.max(floor, n));
  const fits = () => screen.offsetWidth <= availW && screen.offsetHeight <= availH;

  let size = Number(term.options.fontSize) || baseFontSize;
  for (let i = 0; i < 4; i++) {
    const w = screen.offsetWidth;
    const h = screen.offsetHeight;
    if (!(w > 0) || !(h > 0)) return 0;
    const next = clamp(Math.floor(size * Math.min(availW / w, availH / h)));
    if (next === size) break;
    size = next;
    term.options.fontSize = size;
  }
  while (size > floor && !fits()) {
    size -= 1;
    term.options.fontSize = size;
  }
  return size;
}

// 让光标所在的格子保持在可视区内。用户刚手动平移过的几秒内不打扰他。
function scheduleReveal(force) {
  if (force) lastPanAt = 0;
  if (Date.now() - lastPanAt < FOLLOW_PAUSE_MS || revealQueued) return;
  revealQueued = true;
  const run = () => {
    revealQueued = false;
    revealCursor();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

// 当前屏幕里最后一个有文字的行号(0 起算)；取不到缓冲区行时退回光标所在行
function lastContentRow(buf) {
  if (typeof buf.getLine !== 'function') return buf.cursorY;
  for (let row = term.rows - 1; row > buf.cursorY; row--) {
    const line = buf.getLine(buf.baseY + row);
    if (line && line.translateToString(true).trim() !== '') return row;
  }
  return buf.cursorY;
}

function revealCursor() {
  const el = terminalContainerEl;
  const buf = term && term.buffer && term.buffer.active;
  const screen = term && term.element && term.element.querySelector ? term.element.querySelector('.xterm-screen') : null;
  if (!el || !buf || !screen || !term.rows || !term.cols || !el.clientHeight) return;

  const cellH = screen.offsetHeight / term.rows;
  const cellW = screen.offsetWidth / term.cols;
  const top = buf.cursorY * cellH;
  const bottom = top + cellH;

  // 光标下面常有状态栏(Claude Code 的状态行等)，所以要让"最后一行有内容的行"也露出来；放不下时光标优先
  const contentBottom = (lastContentRow(buf) + 1) * cellH;
  let target = el.scrollTop;
  const wanted = Math.max(bottom, contentBottom);
  if (wanted > target + el.clientHeight) target = wanted - el.clientHeight;
  if (top < target) target = top;
  if (target !== el.scrollTop) el.scrollTop = target;

  // 只超出一两个字符宽时不横向滚动：为了露出最右边的光标把第一列推出去，得不偿失
  if (el.scrollWidth - el.clientWidth <= cellW * 2) {
    if (el.scrollLeft) el.scrollLeft = 0;
    return;
  }
  const left = buf.cursorX * cellW;
  const right = left + cellW;
  if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  else if (left < el.scrollLeft) el.scrollLeft = left;
}

function updateStatusBar() {
  const current = sessionList.find((s) => s.id === activeId);
  statusTargetEl.textContent = current ? `会话: ${current.title}` : '会话: -';
  statusWindowEl.textContent = current ? `Tabby 窗口: W${current.windowNo}` : 'Tabby 窗口: -';
  statusDimEl.textContent = term && current ? `尺寸: ${term.cols}x${term.rows}` : '尺寸: -';
}

function handleResize() {
  applyFontSize();
  updateStatusBar();
  scheduleReveal();
}

function applyTerminalSize(cols, rows) {
  if (!term) return;
  if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
    term.resize(cols, rows);
  }
  handleResize();
}

function sendInput(data) {
  lastPanAt = 0; // 开始打字了，之后光标要跟着走
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify({ t: 'input', data }));
  }
}

function showEmptyState() {
  if (!emptyStateEl) return;
  if (sessionList.length > 0) {
    emptyStateEl.classList.add('hidden');
    return;
  }
  emptyStateEl.textContent = bridgeCount === 0
    ? '等待 Tabby 连接… 请确认已安装并启用 tabby-wsl-web-bridge 插件，且 Tabby 正在运行。'
    : 'Tabby 里还没有终端标签页，点击右上角“新建窗口”。';
  emptyStateEl.classList.remove('hidden');
}

function disconnectSocket() {
  if (currentSocket) {
    const oldSocket = currentSocket;
    currentSocket = null;
    oldSocket.close();
  }
}

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (!data.success || !Array.isArray(data.sessions)) return;

    bridgeCount = data.bridges || 0;
    const newSig = `${bridgeCount}|` + data.sessions.map((s) => `${s.id}:${s.windowNo}:${s.title}`).join('|');
    const listChanged = newSig !== sessionListSig;
    if (listChanged) {
      sessionList = data.sessions;
      sessionListSig = newSig;

      if (!sessionList.find((s) => s.id === activeId)) {
        // 刷新后默认选中 Tabby 里当前有焦点的终端，取不到时才退回第一个
        const focused = sessionList.find((s) => s.id === data.focusedId);
        activeId = focused ? focused.id : (sessionList.length > 0 ? sessionList[0].id : null);
        if (activeId) {
          connectToSession(activeId);
        } else {
          disconnectSocket();
          if (term) term.reset();
          connectionBadgeEl.className = 'badge badge-disconnected';
          connectionBadgeEl.textContent = '● 未连接';
        }
      }
      renderTabs();
      showEmptyState();
    }
    followTabbyFocus(data.focusedId);
    if (!listChanged && activeId && Date.now() >= nextReconnectAt && (!currentSocket || (currentSocket.readyState !== WebSocket.OPEN && currentSocket.readyState !== WebSocket.CONNECTING))) {
      connectToSession(activeId);
    }
  } catch (err) {
    console.error('Failed to fetch sessions:', err);
  }
}

// Tabby 里切换了有焦点的终端时，网页跟着切。只在 focusedId 变化的那一刻切换，
// 这样在网页里手动点了别的标签后，不会被下一次轮询拉回去。
function followTabbyFocus(focusedId) {
  if (!focusedId || focusedId === lastFocusedId) return;
  lastFocusedId = focusedId;
  if (focusedId === activeId || !sessionList.find((s) => s.id === focusedId)) return;
  activeId = focusedId;
  renderTabs();
  connectToSession(focusedId);
}

function tabLabel(session) {
  return bridgeCount > 1 ? `[W${session.windowNo}] ${session.title}` : session.title;
}

function renderTabs() {
  tabsListEl.innerHTML = '';
  sessionList.forEach((session) => {
    const tabEl = document.createElement('div');
    tabEl.className = `tab-item ${session.id === activeId ? 'active' : ''}`;
    tabEl.title = '双击可重命名此标签页';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = tabLabel(session);
    tabEl.appendChild(labelSpan);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = '关闭此标签页 (会关闭 Tabby 里对应的终端)';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession(session);
    });
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener('click', () => {
      if (activeId !== session.id) {
        activeId = session.id;
        renderTabs();
        connectToSession(session.id);
      }
    });

    tabEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameSession(session);
    });

    tabsListEl.appendChild(tabEl);
  });

  updateStatusBar();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

async function renameSession(session) {
  const newName = prompt(`请输入标签页 [${session.title}] 的新名称:`, session.title);
  if (!newName || newName.trim() === '' || newName === session.title) return;

  try {
    const data = await postJson(`/api/sessions/${encodeURIComponent(session.id)}/rename`, { name: newName.trim() });
    if (data.success) {
      sessionListSig = '';
      await fetchSessions();
    } else {
      alert('重命名失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    alert('重命名失败: ' + err.message);
  }
}

async function createNewSession() {
  try {
    const data = await postJson('/api/sessions');
    if (!data.success) {
      alert('新建失败: ' + (data.error || '未知错误'));
      return;
    }
    if (data.session) {
      activeId = data.session.id;
      connectToSession(activeId);
    }
    sessionListSig = '';
    await fetchSessions();
  } catch (err) {
    alert('新建失败: ' + err.message);
  }
}

async function closeSession(session) {
  if (!confirm(`确定关闭 Tabby 里的终端 “${session.title}” 吗？里面运行的程序会被结束。`)) return;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      if (activeId === session.id) {
        activeId = null;
      }
      sessionListSig = '';
      await fetchSessions();
    } else {
      alert('关闭失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    alert('关闭失败: ' + err.message);
  }
}

function connectToSession(id) {
  disconnectSocket();

  term.reset();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws/terminal?session=${encodeURIComponent(id)}`;

  connectionBadgeEl.className = 'badge badge-disconnected';
  connectionBadgeEl.textContent = '● 连接中...';

  const socket = new WebSocket(wsUrl);
  currentSocket = socket;
  nextReconnectAt = Date.now() + reconnectDelay;

  socket.onopen = () => {
    if (currentSocket !== socket) return;
    connectionBadgeEl.className = 'badge badge-connected';
    connectionBadgeEl.textContent = '● 已连接';
    // 仅在桌面环境聚焦；触控移动设备不自动聚焦，避免切换标签页时强制唤起手机输入法
    if (typeof window === 'undefined' || !window.matchMedia || !window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
      term.focus();
    }
  };

  socket.onmessage = (event) => {
    if (currentSocket !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.t === 'snapshot') {
      reconnectDelay = 1000;
      term.reset();
      if (terminalContainerEl) {
        terminalContainerEl.scrollLeft = 0;
        terminalContainerEl.scrollTop = 0;
      }
      applyTerminalSize(msg.cols, msg.rows);
      if (msg.data) term.write(msg.data, () => scheduleReveal(true));
      else scheduleReveal(true);
    } else if (msg.t === 'output') {
      term.write(msg.data, () => scheduleReveal());
    } else if (msg.t === 'size') {
      applyTerminalSize(msg.cols, msg.rows);
    }
  };

  socket.onclose = () => {
    if (currentSocket !== socket) return;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    nextReconnectAt = Date.now() + reconnectDelay;
    connectionBadgeEl.className = 'badge badge-disconnected';
    connectionBadgeEl.textContent = '● 已断开';
  };

  socket.onerror = (err) => {
    if (currentSocket !== socket) return;
    console.error('WebSocket error:', err);
    connectionBadgeEl.className = 'badge badge-disconnected';
    connectionBadgeEl.textContent = '● 连接异常';
  };
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function onFullscreenChange() {
  const isFs = !!document.fullscreenElement;
  btnFullscreen.textContent = isFs ? '✕ 退出全屏' : '⛶ 全屏模式';
  if (isFs) {
    appRootEl.classList.add('is-fullscreen');
  } else {
    appRootEl.classList.remove('is-fullscreen');
  }
  fitToScreen = isFs;
  handleResize();
  setTimeout(handleResize, 150); // 全屏后窗口尺寸要稍后才稳定
}

document.addEventListener('fullscreenchange', onFullscreenChange);

function changeFontSize(delta) {
  if (fitToScreen) {
    // 手动调字号：以当前自动选出的字号为起点，之后不再自动适应
    fitToScreen = false;
    if (term && Number(term.options.fontSize)) baseFontSize = Number(term.options.fontSize);
  }
  baseFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, baseFontSize + delta));
  handleResize();
}

function refreshNow() {
  sessionListSig = '';
  nextReconnectAt = 0;
  fetchSessions();
}

btnFullscreen.addEventListener('click', toggleFullscreen);
btnFontDec.addEventListener('click', () => changeFontSize(-1));
btnFontInc.addEventListener('click', () => changeFontSize(1));
btnNewWindow.addEventListener('click', createNewSession);
btnRefresh.addEventListener('click', refreshNow);

const keyMap = {
  ESC: '\x1b',
  TAB: '\t',
  ENTER: '\r',
  CTRL_C: '\x03',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  PIPE: '|',
  SLASH: '/',
  DASH: '-',
  TILDE: '~'
};

function sendTerminalData(data) {
  sendInput(data);
  // 注意：不要在此处调用 term.focus()！
  // 移动端在 xterm 隐藏 textarea 上调用 .focus() 会强制弹起手机原生软键盘。
  // 用户点击虚拟控制按键仅发送 ANSI 控制字符，不得触发软键盘弹出。
}

function initAccessoryBar() {
  if (!accBarEl || !accBarEl.addEventListener) return;

  // 阻止虚拟按键点击时的默认焦点转移，避免误触系统输入法
  accBarEl.addEventListener('mousedown', (e) => {
    const btn = e.target.closest?.('.acc-btn, .acc-toggle-btn') || e.target;
    if (btn && btn !== accBarEl) {
      e.preventDefault();
    }
  });

  accBarEl.addEventListener('click', (e) => {
    let btn = e.target;
    while (btn && btn !== accBarEl && !btn.getAttribute?.('data-key') && btn.id !== 'btn-toggle-accessory') {
      btn = btn.parentElement;
    }
    if (!btn || btn === accBarEl) return;

    const key = btn.getAttribute ? btn.getAttribute('data-key') : null;
    if (key === 'CTRL') {
      isCtrlActive = !isCtrlActive;
      if (btnCtrl && btnCtrl.classList) {
        if (isCtrlActive) btnCtrl.classList.add('sticky-active');
        else btnCtrl.classList.remove('sticky-active');
      }
      return;
    }

    if (key === 'ALT') {
      isAltActive = !isAltActive;
      if (btnAlt && btnAlt.classList) {
        if (isAltActive) btnAlt.classList.add('sticky-active');
        else btnAlt.classList.remove('sticky-active');
      }
      return;
    }

    if (key === 'KEYBOARD') {
      if (term) term.focus();
      return;
    }

    if (key && keyMap[key]) {
      sendTerminalData(keyMap[key]);
      return;
    }

    if (btn.id === 'btn-toggle-accessory' || (accBarEl.classList && accBarEl.classList.contains('collapsed'))) {
      toggleAccessoryBar();
      return;
    }
  });

  try {
    const isCollapsedSaved = localStorage.getItem('wsl_term_accessory_collapsed') === 'true';
    if (isCollapsedSaved && accBarEl && accBarEl.classList) {
      accBarEl.classList.add('collapsed');
    }
    updateToggleAccessoryButton();
  } catch {}

  if (btnToggleKeys && btnToggleKeys.addEventListener) {
    btnToggleKeys.addEventListener('click', toggleAccessoryBar);
  }
}

function openMobileDrawer() {
  if (mobileMenuDrawerEl && mobileMenuDrawerEl.classList) {
    mobileMenuDrawerEl.classList.remove('hidden');
  }
  if (mobileMenuBackdropEl && mobileMenuBackdropEl.classList) {
    mobileMenuBackdropEl.classList.remove('hidden');
  }
}

function closeMobileDrawer() {
  if (mobileMenuDrawerEl && mobileMenuDrawerEl.classList) {
    mobileMenuDrawerEl.classList.add('hidden');
  }
  if (mobileMenuBackdropEl && mobileMenuBackdropEl.classList) {
    mobileMenuBackdropEl.classList.add('hidden');
  }
}

function initMobileMenu() {
  const on = (el, handler) => {
    if (el && el.addEventListener) el.addEventListener('click', handler);
  };
  on(btnMobileMenu, openMobileDrawer);
  on(btnCloseDrawer, closeMobileDrawer);
  on(mobileMenuBackdropEl, closeMobileDrawer);
  on(btnDrawerFontDec, () => changeFontSize(-1));
  on(btnDrawerFontInc, () => changeFontSize(1));
  on(btnDrawerFullscreen, () => {
    closeMobileDrawer();
    toggleFullscreen();
  });
  on(btnDrawerRefresh, () => {
    closeMobileDrawer();
    refreshNow();
  });
  on(btnDrawerToggleKeys, () => {
    closeMobileDrawer();
    toggleAccessoryBar();
  });
}

initTerminal();
initAccessoryBar();
initMobileMenu();
fetchSessions();
setInterval(fetchSessions, 1000);
