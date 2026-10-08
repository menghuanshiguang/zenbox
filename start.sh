#!/usr/bin/env bash
# zenbox 一键启动（macOS/Linux/WSL）：仓库根目录执行，转发口/日志都从这里起。
set -euo pipefail
# 切到脚本所在目录：纯参数展开，不依赖 PATH 里的 dirname（PowerShell 直调 bash.exe 时 PATH 可能没有它）
case "${BASH_SOURCE[0]}" in
  */*) cd "${BASH_SOURCE[0]%/*}" ;;
esac
exec node start.js start "$@"
