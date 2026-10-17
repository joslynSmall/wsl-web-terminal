let term = null;
let fitAddon = null;
let currentSocket = null;
let activeTarget = null;
let windowList = [];
let windowListSig = '';
let systemShellsList = [];
let systemShellsSig = '';
let currentFontSize = 14;

const appRootEl = document.getElementById('app-root');
const tabsListEl = document.getElementById('tabs-list');
const terminalContainerEl = document.getElementById('terminal-container');
const connectionBadgeEl = document.getElementById('connection-badge');
const externalCountEl = document.getElementById('external-count');
const btnExternalShells = document.getElementById('btn-external-shells');

const btnFullscreen = document.getElementById('btn-fullscreen');
const btnNewWindow = document.getElementById('btn-new-window');
const btnRefresh = document.getElementById('btn-refresh');
const btnFontDec = document.getElementById('btn-font-dec');
const btnFontInc = document.getElementById('btn-font-inc');

const statusTargetEl = document.getElementById('status-target');
const statusCommandEl = document.getElementById('status-command');
const statusDimEl = document.getElementById('status-dim');
const statusPathEl = document.getElementById('status-path');

const externalModalEl = document.getElementById('external-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCopyJoin = document.getElementById('btn-copy-join');
const joinCmdText = document.getElementById('join-cmd-text');
const externalShellsListEl = document.getElementById('external-shells-list');

const accBarEl = document.getElementById('terminal-accessory-bar');
const btnCtrl = document.getElementById('acc-btn-ctrl');
const btnAlt = document.getElementById('acc-btn-alt');
const btnToggleAccessory = document.getElementById('btn-toggle-accessory');
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
const btnDrawerExternalShells = document.getElementById('btn-drawer-external-shells');
const drawerExternalCountEl = document.getElementById('drawer-external-count');

function initTerminal() {
  term = new window.Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
    fontSize: currentFontSize,
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

  fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  }

  term.open(terminalContainerEl);
  requestAnimationFrame(() => {
    fitAddon.fit();
  });

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

    if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
      currentSocket.send(payload);
    }
  });

  // 移动端全功能触控滑动手势引擎：将手机屏幕的上下滑动手势转换为终端滚动与 SGR 鼠标滚轮信号
  let touchStartY = 0;
  let touchStartX = 0;
  let touchLastY = 0;
  let isSwiping = false;
  let scrollAccumulator = 0;

  if (terminalContainerEl && terminalContainerEl.addEventListener) {
    terminalContainerEl.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      touchLastY = touchStartY;
      isSwiping = false;
      scrollAccumulator = 0;
    }, { passive: true });

    terminalContainerEl.addEventListener('touchmove', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      const currentX = e.touches[0].clientX;
      const diffY = currentY - touchLastY;
      const totalDistY = Math.abs(currentY - touchStartY);
      const totalDistX = Math.abs(currentX - touchStartX);

      if (totalDistY > 6 && totalDistY > totalDistX) {
        isSwiping = true;
        touchLastY = currentY;
        scrollAccumulator += diffY;

        const step = 16;
        if (Math.abs(scrollAccumulator) >= step) {
          const lines = Math.trunc(scrollAccumulator / step);
          scrollAccumulator %= step;

          const rect = terminalContainerEl.getBoundingClientRect ? terminalContainerEl.getBoundingClientRect() : { left: 0, top: 0, width: 360, height: 600 };
          const cellWidth = (rect.width / (term.cols || 80)) || 9;
          const cellHeight = (rect.height / (term.rows || 24)) || 17;
          const col = Math.min(term.cols || 80, Math.max(1, Math.floor((currentX - rect.left) / cellWidth) + 1));
          const row = Math.min(term.rows || 24, Math.max(1, Math.floor((currentY - rect.top) / cellHeight) + 1));

          const count = Math.abs(lines);
          const isUp = lines > 0;
          const seq = isUp ? `\x1b[<64;${col};${row}M` : `\x1b[<65;${col};${row}M`;

          if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
            currentSocket.send(seq.repeat(count));
          }

          if (term && term.scrollLines) {
            term.scrollLines(-lines);
          }
        }
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

  // 移动端视觉视口 (visualViewport) 协同调度：当软键盘弹出或收起时动态适配
  if (typeof window !== 'undefined' && window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleVisualViewportChange);
    window.visualViewport.addEventListener('scroll', handleVisualViewportChange);
  }

  // 移动端检测：根据初始屏幕宽度更新辅助栏状态标记
  updateMobileAccessoryLayout();
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

function updateMobileAccessoryLayout() {
  // 采用标准弹性 Flex 布局，无需 JS 手动计算 padding
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

function handleResize() {
  updateMobileAccessoryLayout();
  if (!fitAddon || !term) return;
  fitAddon.fit();
  if (statusDimEl) {
    statusDimEl.textContent = `尺寸: ${term.cols}x${term.rows}`;
  }
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows
    }));
  }
}

async function fetchWindows() {
  try {
    const res = await fetch('/api/windows');
    const data = await res.json();
    if (data.success) {
      if (Array.isArray(data.windows)) {
        const newSig = data.windows.map(w => `${w.target}:${w.name}`).join('|');
        if (newSig !== windowListSig) {
          windowList = data.windows;
          windowListSig = newSig;
          
          if (!windowList.find(w => w.target === activeTarget)) {
            activeTarget = windowList.length > 0 ? windowList[0].target : null;
            if (activeTarget) {
              connectToWindow(activeTarget);
            } else if (term) {
              term.reset();
            }
          }
          renderTabs();
        } else if (activeTarget && (!currentSocket || (currentSocket.readyState !== WebSocket.OPEN && currentSocket.readyState !== WebSocket.CONNECTING))) {
          connectToWindow(activeTarget);
        }
      }

      if (Array.isArray(data.systemShells)) {
        const newExtSig = data.systemShells.map(s => `${s.pid}:${s.runningCommand}`).join('|');
        if (newExtSig !== systemShellsSig) {
          systemShellsList = data.systemShells;
          systemShellsSig = newExtSig;
          externalCountEl.textContent = systemShellsList.length;
          if (drawerExternalCountEl) {
            drawerExternalCountEl.textContent = systemShellsList.length;
          }
          renderExternalShellsModal();
        }
      }
    }
  } catch (err) {
    console.error('Failed to fetch windows:', err);
  }
}

function renderTabs() {
  tabsListEl.innerHTML = '';
  windowList.forEach((win) => {
    const tabEl = document.createElement('div');
    tabEl.className = `tab-item ${win.target === activeTarget ? 'active' : ''}`;
    tabEl.title = '双击可重命名此窗口';
    
    const labelSpan = document.createElement('span');
    labelSpan.textContent = `[#${win.index}] ${win.name}`;
    tabEl.appendChild(labelSpan);

    if (windowList.length > 1) {
      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.title = '关闭此窗口';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeWindow(win.target);
      });
      tabEl.appendChild(closeBtn);
    }

    tabEl.addEventListener('click', () => {
      if (activeTarget !== win.target) {
        activeTarget = win.target;
        renderTabs();
        connectToWindow(win.target);
      }
    });

    tabEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameWindow(win.target, win.name);
    });

    tabsListEl.appendChild(tabEl);
  });

  const currentWin = windowList.find(w => w.target === activeTarget);
  if (currentWin) {
    statusTargetEl.textContent = `窗口: ${currentWin.target} (${currentWin.name})`;
    statusCommandEl.textContent = `命令: ${currentWin.command}`;
    statusPathEl.textContent = `工作目录: ${shortenPath(currentWin.path)}`;
  } else {
    statusTargetEl.textContent = '窗口: -';
    statusCommandEl.textContent = '命令: -';
    statusPathEl.textContent = '工作目录: -';
  }
}

function shortenPath(p) {
  if (!p || p === '-') return '-';
  if (p.length <= 26) return p;
  const parts = p.split('/');
  if (parts.length > 2) {
    return '.../' + parts.slice(-2).join('/');
  }
  return p;
}

async function renameWindow(target, oldName) {
  const newName = prompt(`请输入窗口 [${target}] 的新名称:`, oldName);
  if (!newName || newName.trim() === '' || newName === oldName) return;

  try {
    const res = await fetch('/api/windows/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, name: newName.trim() })
    });
    const data = await res.json();
    if (data.success) {
      windowListSig = '';
      await fetchWindows();
    }
  } catch (err) {
    alert('重命名窗口失败: ' + err.message);
  }
}

function renderExternalShellsModal() {
  externalShellsListEl.innerHTML = '';
  if (systemShellsList.length === 0) {
    externalShellsListEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">未检测到外部活动 Shell</div>';
    return;
  }

  systemShellsList.forEach((shell) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'shell-card';

    const metaEl = document.createElement('div');
    metaEl.className = 'shell-meta';

    const titleEl = document.createElement('div');
    titleEl.className = 'shell-title';
    titleEl.textContent = `${shell.comm} (PID: ${shell.pid}) - ${shell.tty}`;

    const pathEl = document.createElement('div');
    pathEl.className = 'shell-path';
    pathEl.textContent = `工作目录: ${shell.cwd || '-'}`;

    const cmdRowEl = document.createElement('div');
    cmdRowEl.className = 'shell-cmd-row';
    const cmdLabelEl = document.createElement('span');
    cmdLabelEl.className = 'shell-cmd-label';
    cmdLabelEl.textContent = '正在运行:';
    const cmdTextEl = document.createElement('span');
    cmdTextEl.className = 'shell-cmd-text';
    cmdTextEl.textContent = shell.runningCommand || '空闲 (待命中)';
    cmdRowEl.appendChild(cmdLabelEl);
    cmdRowEl.appendChild(cmdTextEl);

    metaEl.appendChild(titleEl);
    metaEl.appendChild(pathEl);
    metaEl.appendChild(cmdRowEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'shell-actions';

    const badgeEl = document.createElement('span');
    badgeEl.className = `shell-status-badge ${shell.isTmuxChild ? 'shell-status-managed' : 'shell-status-external'}`;
    badgeEl.textContent = shell.isTmuxChild ? '● 已挂载' : '● 外部独立';
    actionsEl.appendChild(badgeEl);

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'btn btn-primary btn-sm';
    useBtn.textContent = '⚡ 立即在Web使用';
    useBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      directAttachShell(shell);
    });
    actionsEl.appendChild(useBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-danger btn-sm';
    closeBtn.textContent = '✕ 关闭';
    closeBtn.title = `结束终端进程 ${shell.comm} (PID: ${shell.pid})`;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeExternalShell(shell);
    });
    actionsEl.appendChild(closeBtn);

    itemEl.appendChild(metaEl);
    itemEl.appendChild(actionsEl);

    itemEl.addEventListener('click', () => {
      directAttachShell(shell);
    });

    externalShellsListEl.appendChild(itemEl);
  });
}

async function directAttachShell(shell) {
  try {
    const res = await fetch('/api/attach-shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pid: shell.pid,
        tty: shell.tty,
        cwd: shell.cwd,
        comm: shell.comm
      })
    });
    const data = await res.json();
    if (data.success && data.window) {
      activeTarget = data.window.target;
      externalModalEl.classList.add('hidden');
      windowListSig = '';
      await fetchWindows();
      connectToWindow(activeTarget);
    }
  } catch (err) {
    alert('接入窗口失败: ' + err.message);
  }
}

async function closeExternalShell(shell) {
  if (!confirm(`确定结束终端进程 ${shell.comm} (PID: ${shell.pid}) 吗？`)) return;

  try {
    const res = await fetch(`/api/system-shells/${shell.pid}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      systemShellsSig = '';
      await fetchWindows();
    } else {
      alert('关闭终端失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    alert('关闭终端请求异常: ' + err.message);
  }
}

function connectToWindow(target) {
  if (currentSocket) {
    const oldSocket = currentSocket;
    currentSocket = null;
    oldSocket.close();
  }

  term.reset();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const cols = term.cols || 120;
  const rows = term.rows || 35;
  const wsUrl = `${protocol}//${location.host}/ws/terminal?target=${encodeURIComponent(target)}&cols=${cols}&rows=${rows}`;

  connectionBadgeEl.className = 'badge badge-disconnected';
  connectionBadgeEl.textContent = '● 连接中...';

  const socket = new WebSocket(wsUrl);
  currentSocket = socket;

  socket.onopen = () => {
    if (currentSocket !== socket) return;
    connectionBadgeEl.className = 'badge badge-connected';
    connectionBadgeEl.textContent = '● 已连接';
    handleResize();
    // 仅在桌面环境聚焦；触控移动设备不自动聚焦，避免切换 tab 时强制唤起手机输入法
    if (typeof window === 'undefined' || !window.matchMedia || !window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
      term.focus();
    }
  };

  socket.onmessage = (event) => {
    if (currentSocket !== socket) return;
    term.write(event.data);
  };

  socket.onclose = () => {
    if (currentSocket !== socket) return;
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

async function createNewWindow() {
  const name = prompt('请输入新终端窗口名称:', `shell-${windowList.length + 1}`);
  if (name === null) return;

  try {
    const res = await fetch('/api/windows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || undefined })
    });
    const data = await res.json();
    if (data.success && data.window) {
      activeTarget = data.window.target;
      connectToWindow(activeTarget);
      windowListSig = '';
      await fetchWindows();
    }
  } catch (err) {
    alert('创建窗口失败: ' + err.message);
  }
}

async function closeWindow(target) {
  if (!confirm(`确定关闭窗口 ${target} 吗？`)) return;

  try {
    const res = await fetch(`/api/windows/${encodeURIComponent(target)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      if (activeTarget === target) {
        activeTarget = null;
      }
      windowListSig = '';
      await fetchWindows();
    }
  } catch (err) {
    alert('关闭窗口失败: ' + err.message);
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  btnFullscreen.textContent = isFs ? '✕ 退出全屏' : '⛶ 全屏模式';
  if (isFs) {
    appRootEl.classList.add('is-fullscreen');
  } else {
    appRootEl.classList.remove('is-fullscreen');
  }
  setTimeout(handleResize, 150);
});

btnFullscreen.addEventListener('click', toggleFullscreen);

btnFontDec.addEventListener('click', () => {
  currentFontSize = Math.max(10, currentFontSize - 1);
  if (term && fitAddon) {
    term.options.fontSize = currentFontSize;
    handleResize();
  }
});

btnFontInc.addEventListener('click', () => {
  currentFontSize = Math.min(26, currentFontSize + 1);
  if (term && fitAddon) {
    term.options.fontSize = currentFontSize;
    handleResize();
  }
});

btnExternalShells.addEventListener('click', () => {
  externalModalEl.classList.remove('hidden');
});

btnCloseModal.addEventListener('click', () => {
  externalModalEl.classList.add('hidden');
});

externalModalEl.addEventListener('click', (e) => {
  if (e.target === externalModalEl) {
    externalModalEl.classList.add('hidden');
  }
});

btnCopyJoin.addEventListener('click', () => {
  navigator.clipboard.writeText('wsl-term').then(() => {
    btnCopyJoin.textContent = '✓ 已复制';
    setTimeout(() => {
      btnCopyJoin.textContent = '📋 复制';
    }, 1500);
  });
});

btnNewWindow.addEventListener('click', createNewWindow);
btnRefresh.addEventListener('click', () => {
  windowListSig = '';
  systemShellsSig = '';
  fetchWindows();
});

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
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(data);
  }
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
  if (btnMobileMenu && btnMobileMenu.addEventListener) {
    btnMobileMenu.addEventListener('click', openMobileDrawer);
  }
  if (btnCloseDrawer && btnCloseDrawer.addEventListener) {
    btnCloseDrawer.addEventListener('click', closeMobileDrawer);
  }
  if (mobileMenuBackdropEl && mobileMenuBackdropEl.addEventListener) {
    mobileMenuBackdropEl.addEventListener('click', closeMobileDrawer);
  }

  if (btnDrawerFontDec && btnDrawerFontDec.addEventListener) {
    btnDrawerFontDec.addEventListener('click', () => {
      currentFontSize = Math.max(10, currentFontSize - 1);
      if (term && fitAddon) {
        term.options.fontSize = currentFontSize;
        handleResize();
      }
    });
  }

  if (btnDrawerFontInc && btnDrawerFontInc.addEventListener) {
    btnDrawerFontInc.addEventListener('click', () => {
      currentFontSize = Math.min(26, currentFontSize + 1);
      if (term && fitAddon) {
        term.options.fontSize = currentFontSize;
        handleResize();
      }
    });
  }

  if (btnDrawerFullscreen && btnDrawerFullscreen.addEventListener) {
    btnDrawerFullscreen.addEventListener('click', () => {
      closeMobileDrawer();
      toggleFullscreen();
    });
  }

  if (btnDrawerRefresh && btnDrawerRefresh.addEventListener) {
    btnDrawerRefresh.addEventListener('click', () => {
      closeMobileDrawer();
      windowListSig = '';
      systemShellsSig = '';
      fetchWindows();
    });
  }

  if (btnDrawerToggleKeys && btnDrawerToggleKeys.addEventListener) {
    btnDrawerToggleKeys.addEventListener('click', () => {
      closeMobileDrawer();
      toggleAccessoryBar();
    });
  }

  if (btnDrawerExternalShells && btnDrawerExternalShells.addEventListener) {
    btnDrawerExternalShells.addEventListener('click', () => {
      closeMobileDrawer();
      if (externalModalEl && externalModalEl.classList) {
        externalModalEl.classList.remove('hidden');
      }
    });
  }
}

initTerminal();
initAccessoryBar();
initMobileMenu();
fetchWindows();
setInterval(fetchWindows, 1000);
