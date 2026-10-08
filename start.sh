#!/usr/bin/env bash
# zenbox 一键启动（macOS/Linux/WSL）：仓库根目录执行，转发口/日志都从这里起。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node start.js start "$@"
