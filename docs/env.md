# 环境记录（docs/env.md）

本文件记录构建/开发机环境与自举步骤（AGENT-BRIEF §1）。

## 机器

- OS: Windows 11（用户 fantasytat），shell: PowerShell（pwsh）
- Node: v24.14.0（engines `^22.19.0 || >=24.0.0`）
- git: 2.47.1.windows.2
- gh: 2.97.0（已登录 github.com 账号 `menghuanshiguang`，token scopes: gist/read:org/repo/workflow）
- rg (ripgrep): 14.1.1，位于 `C:\Users\fantasytat\.local\bin\rg.exe`（已在用户 PATH）

## 网络

- 系统代理: Clash，`ProxyEnable=1 ProxyServer=127.0.0.1:7897`（PowerShell/curl 不自动走）
- git 全局代理: `git config --global http.proxy http://127.0.0.1:7897`（https.proxy 同设）
- curl 联网需显式 `-x http://127.0.0.1:7897`
- npm 走 npmmirror（`--registry=https://registry.npmmirror.com`），registry.npmjs.org 直连不可达
- github.com 直连 443 重置，经代理可达

## 自举步骤

1. 确认 node/git/gh 可用；winget 缺失。
2. `rg` 缺失 → `curl -x http://127.0.0.1:7897` 下载 ripgrep-14.1.1-x86_64-pc-windows-msvc.zip → 解压 `rg.exe` 到 `C:\Users\fantasytat\.local\bin\`。
3. 上游源码: `git archive --format=tar -o ..\upstream.tar HEAD`（在上游 clone 中）→ 本目录 `tar -xf`。
   - 教训: PowerShell 管道传二进制（`git archive | tar -x`）会破坏字节流，tar 报 "Damaged tar archive (bad header checksum)"，必须落文件再解。
4. 建仓两次提交: `928e283` import upstream（301 files）→ `1c752e5` cut（§2.1 删除清单）。

## 已知平台差异

- Windows 下 bash/shellcheck 类门禁不可用（CI 由 ubuntu/macos 承担 bash -n + shellcheck）。
- 进程被 kill 后 pwsh 报 `[exit code: 1]` 无信号标记，视为中断而非命令失败。
