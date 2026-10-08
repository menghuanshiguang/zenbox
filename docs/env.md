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
- 2026-10-08 实况更新：7897 后端（verge-mihomo）运行时配置无 `proxies:`、订阅源全超时 → **代理整体失效**；`git push` 9 连败（github.com reset、ssh.github.com:443/:22 全不通），但 **`api.github.com` 直连可达** → 推送逃生路径：`gh api` 的 Git Data API（blob 逐个上传→建树（base_tree 不支持删除，需重建整棵子树）→建提交（本地 author/committer/时间戳逐字段复刻使 SHA 逐字节一致）→PATCH `refs/heads/main`），网络恢复后 `git push` 只会 `Everything up-to-date`。gh CLI 与 PR diff 拉取一直走 api.github.com，不受 github.com reset 影响。

## 自举步骤

1. 确认 node/git/gh 可用；winget 缺失。
2. `rg` 缺失 → `curl -x http://127.0.0.1:7897` 下载 ripgrep-14.1.1-x86_64-pc-windows-msvc.zip → 解压 `rg.exe` 到 `C:\Users\fantasytat\.local\bin\`。
3. 上游源码: `git archive --format=tar -o ..\upstream.tar HEAD`（在上游 clone 中）→ 本目录 `tar -xf`。
   - 教训: PowerShell 管道传二进制（`git archive | tar -x`）会破坏字节流，tar 报 "Damaged tar archive (bad header checksum)"，必须落文件再解。
4. 建仓两次提交: `c4c7421` import upstream（301 files）→ `5b84917` cut（§2.1 删除清单）→ `1fc1739` M0 脚手架。
5. 首推被 GitHub Push Protection 拦截: 上游历史里 `vendor/channel-pack` 含 Google OAuth Client ID/Secret（后续提交已删、历史仍在）。处理: 用 `git read-tree + rm --cached vendor + write-tree + commit-tree` 重写三个提交（根提交=上游树减 vendor；cut 的树本就不含 vendor，故重写前后树完全一致），`git push -f` 通过。教训: 导入第三方仓库前先扫其敏感文件，或直接以"最终裁剪树"建根提交。
6. 重写后旧 hash（928e283/1c752e5/d989cd0）全部失效，docs 内引用已批量替换为 `c4c7421/5b84917/1fc1739`——**引用 hash 前先 `git log` 核实**。

## CI

- `.github/workflows/ci.yml`: matrix ubuntu amd64 + ubuntu arm64 + macos + windows，`npm ci` → `npm test`（L0/L1/L2）→ start 冒烟（`OFM_SMOKE_MS=2000`）。
- Actions 的 windows runner 自带 Git Bash，`shell: bash` 全平台可用；本机 pwsh 无 shellcheck。

## 已知平台差异

- 本机 pwsh 跑 shellcheck/bash -n 不可用，门禁里记 SKIP（CI 的 bash 层覆盖）。
- 进程被 kill 后 pwsh 报 `[exit code: 1]` 无信号标记，视为中断而非命令失败。
- PowerShell 写文件易带 BOM/控制台乱码：写 JSON/UTF-8 用 `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))`，验证用 read 工具而非 Get-Content。
