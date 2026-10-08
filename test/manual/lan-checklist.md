# L4 跨设备手工清单（test/manual/lan-checklist.md）

AGENT-BRIEF §7 L4 / §12 DoD：**每个 release 必走**。目标——第二设备凭 **LAN 独立 Key** 完成流式对话，本机日志显示它的真实 IP（#40 PROXY v1 归因 + #41 贯穿）。

分两段：A 段可由 agent/CI 复现（第二客户端进程模拟第二设备，§11 M2 口径）；B 段真机实测，release 前人工完成。

## A. 本机模拟第二设备（自动，可重复）

```bash
node test/manual/lan-live.mjs   # 期望尾行 lan-live: PASS，exit 0
```

执行器做的事（每步即断言）：

1. 起桩网关（`stubUpstream`，回声 `lan-ok`），以 `OFM_UPSTREAM` 指向它（`loadConfig` 归一后会同步进 `OUR_FREE_MODEL_BASE`，对话链才走桩）。
2. 真 CLI `node start.js start --lan 0.0.0.0:<空闲口>`（`OFM_SMOKE_MS=20000` 兜底），等 `[listen] 中继口` 行。
3. 取 `rankLanAddresses` 首选非回环地址（#76）当"第二设备"，读 `data/lan-key`（`ofm-` 前缀）。
4. 该 LAN 地址上 POST `/v1/chat/completions`（Bearer LAN Key，`stream:true`）→ 断言 200 且 SSE 正文含桩回声。
5. 断言 zenbox 日志两条归因行都点名设备 LAN IP：
   - `[relay] lan relay: <lanIP> → /v1/chat/completions`（中继侧，#41 认领）
   - `[forward] forward: <lanIP>:<port> → POST /v1/chat/completions`（前门 PROXY 认领，#40）

前置：本机有非回环 IPv4；`data/lan-key` 可由首启自动生成（0600）；端口被占时中继按 #23 原则顺延（`lan bind: …` 日志）。

**实测记录（2026-10-07，Windows 11，zenbox main）**：

```text
lan-live: PASS — 第二客户端凭 LAN Key 流式对话成功
  设备地址   10.39.17.3:60252（#76 首选地址）
  中继归因   [relay] lan relay: 10.39.17.3 → /v1/chat/completions
  转发归因   [forward] forward: 10.39.17.3:60259 → POST /v1/chat/completions
  SSE 正文   含桩回声 lan-ok（桩 http://127.0.0.1:60251）
```

## B. 真机第二设备（release 前人工）

前置：同一局域网；`config.json` 置 `lan.enabled=true`（端口冲突会自动顺延，见 banner `[listen] 中继口`）；记下 `data/lan-key`。

| # | 步骤 | 预期 | 勾选 |
| --- | --- | --- | --- |
| 1 | `node start.js start`，看 banner 与 `[listen]` 行 | 转发口/中继口都在；中继行给出 LAN 独立 Key 尾 4 | ☐ |
| 2 | 手机/平板连同一 Wi-Fi，`curl http://<LAN口取自本机IP>:<中继口>/v1/models -H "authorization: Bearer <lan-key>"` | 200 + 模型清单 JSON | ☐ |
| 3 | 同设备发起 `stream:true` 对话 | SSE 逐帧到 `[DONE]` | ☐ |
| 4 | 看本机 zenbox 日志 | `lan relay: <手机真实IP> → /v1/chat/completions`；`forward: <手机真实IP>:<port> → POST …`（#40/#41，**不是** 127.0.0.1 也不是中继隧道口） | ☐ |
| 5 | 拿错 Key / 空 Key 各试一次 | 401 `missing or invalid API key`，`/health` 同样被挡 | ☐ |
| 6 | 关 `lan.enabled` 重启 | 中继口不监听，503/不可达 | ☐ |
| 7 | 真实上游（不设 `OFM_UPSTREAM`，走 `config.upstream.base` 默认 `https://opencode.ai`）对话一轮 | 正常回复；网关侧收到 `x-forwarded-for: <手机IP>`（#41，可用上游日志/抓包核） | ☐ |

## 记录区

| 日期 | 平台 | A 段 | B 段 | 记录人 |
| --- | --- | --- | --- | --- |
| 2026-10-07 | Windows 11 x64 | PASS（上表实测） | 待 release 前走 | zenbox agent |
