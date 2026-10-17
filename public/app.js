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
    if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
      currentSocket.send(data);
    }
  });

  window.addEventListener('resize', handleResize);
}

function handleResize() {
  if (!fitAddon || !term) return;
  fitAddon.fit();
  statusDimEl.textContent = `尺寸: ${term.cols}x${term.rows}`;
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
    statusPathEl.textContent = `工作目录: ${currentWin.path || '-'}`;
  } else {
    statusTargetEl.textContent = '窗口: -';
    statusCommandEl.textContent = '命令: -';
    statusPathEl.textContent = '工作目录: -';
  }
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
    term.focus();
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

initTerminal();
fetchWindows();
setInterval(fetchWindows, 1000);
