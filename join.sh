#!/usr/bin/env bash
_wsl_web_join() {
    local NAME="${1:-shell-$(basename "$PWD")}"
    local SESSION="wsl-web"
    local CLIENT_SESSION="term-client-$$"
    local WIN_ID

    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        tmux new-session -d -s "$SESSION" -n "main" || return 1
    fi

    WIN_ID=$(tmux new-window -d -P -F "#{window_id}" -t "$SESSION" -n "$NAME" -c "$PWD" 2>/dev/null) || return 1
    [[ -n "$WIN_ID" ]] || return 1

    tmux new-session -d -s "$CLIENT_SESSION" 2>/dev/null || return 1
    tmux link-window -s "$WIN_ID" -t "$CLIENT_SESSION:1" 2>/dev/null || { tmux kill-session -t "$CLIENT_SESSION" 2>/dev/null; return 1; }
    tmux kill-window -t "$CLIENT_SESSION:0" 2>/dev/null

    echo "=========================================================="
    echo "🚀 成功将当前终端接入 WSL Web Terminal Hub!"
    echo "📡 窗口标识: $WIN_ID"
    echo "🌐 Web 访问地址: http://localhost:7890"
    echo "💡 提示: 外部终端与 Web 端已实现 100% 实时同屏镜像！"
    echo "   退出时直接输入 exit 即可优雅解绑"
    echo "=========================================================="
    sleep 1

    tmux attach-session -t "$CLIENT_SESSION"
    local status=$?

    if [[ -n "$WIN_ID" ]]; then
        tmux kill-window -t "$WIN_ID" 2>/dev/null || true
    fi
    if [[ -n "$CLIENT_SESSION" ]]; then
        tmux kill-session -t "$CLIENT_SESSION" 2>/dev/null || true
    fi

    return "$status"
}

_wsl_web_join "$@"
