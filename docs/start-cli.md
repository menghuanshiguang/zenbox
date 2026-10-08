# CLI（docs/start-cli.md）

入口 `start.js`（`node start.js <命令>`，`package.json` bin 名 `zenbox`，`npm start` → `node start.js start`）。被 `import`（测试取导出）不拉起 main——`import.meta.url` 与 `argv[1]` 比对后才执行。

## 命令

| 命令 | 现状（M2 实测） | 最终形态（§8.5） |
| --- | --- | --- |
| `start` | §3 时序落地：`ensureKey`（0600 落 `data/forward-key|lan-key`）→ JsonStore(stats) → **egress（#45/#75/#82 宿主半，三态 config 切换）**：`egress.mode≠direct` 时 `startEgressRelay`（`proxy→{mode:'client', url, password}` 密码独立字段、`subscription→{mode:'subscription', url}` 受管 mihomo，起不来退出 1 不改直连；`onFault`/`onQuotaHit` 汇入 `scheduleOutletRotation`——60s 冷却+单飞+`limitedNodes` 10min 候补 → `refreshOutletExit({avoid})`；`onLane` 打切直连/回中继行）→ 运行链组装（FALLBACK_CATALOG + computeMembership + FreeModelAdapter + createRunForwarded，与 recovery-test withForward 同构）→ `startForwardServer`（`config()` 每请求 `readKey`，rotate 即刻生效）→ `lan.enabled` 时 `startLanRelay` → banner → `[listen]` 行 → 60s 心跳 → SIGINT/SIGTERM/`OFM_SMOKE_MS` 优雅关（relay→forward→egress→stats.dispose） | + 后台轮（清单/探测/出口 IP，M4） |
| `status` | banner + `listeners/key/lanKey` 实测（`/health` 800ms 探测）；`--json` 全字段；`pending` 如实列公网 IP（M4）与探测摘要（M3） | + 公网出口 IP、LAN 地址（#76）、egress 三态实值 |
| `models` | 列 FALLBACK_CATALOG 8 行（id + context_window）+ 分桶 verdict `unknown` 占位 | 分桶 available/region-limited/removed 带拒因（M3 probe 轮） |
| `probe` | 回显 probe 配置节奏 + `pending: M3 probe 轮接入（data/availability.json 落盘）`，不真出网 | 手动触发一轮探测并出结果 |
| `key` | 查看：`readKey` → `{target, source, tail4, exists, path}`；`key rotate` → `rotateKey` 覆盖文件（0600），旧 Key 即刻 401（forward 每请求重读）；config 显式 Key 时 rotate 报错退出 1 | `--lan` 轮换 LAN 独立 Key（M4） |
| `doctor` | 5 检查：node(≥22.19)/config-valid/listeners(`/health`)/key/upstream-reachable（`PENDING` M4，本轮不真出网）→ 任一非 OK 退出 1（如实不装绿） | 全绿检查（上游 200/401 自测） |

## 通用约定

- `--json` 适用于 status/models/probe/key/doctor；对 `start` 报错（流式日志与 JSON 不兼容）。
- 配置错误（`ConfigError [field]`）打 stderr 并以退出码 1 拒绝启动；未知命令同样退出 1。
- 优先级与全部 flag/env 见 [modules/config.md](modules/config.md#配置键)。
- banner 字段（§8.4）：只打印已存在的事实，未接线字段标 `pending`，禁止假装就绪。
- 测试钩子：`OFM_SMOKE_MS=<毫秒>` 时 `start` 到点自动优雅退出 0（CI 冒烟专用，真实启动不设）。
- Key 口径（§8.1）：`listen.key`/`lan.key` 空 = 首启 `generateKey()` 写 `data/<name>`（0600）；两键互不通用；`key rotate` 无条件换新。

## 网络面

`start` 绑本机回环转发口（默认 `127.0.0.1:18899`，被占走 #23 顺延，`fallback:false` 即占用即败）；`lan.enabled=true` 才绑 LAN 中继口；`egress.mode≠direct` 时额外起回环出口中继（127.0.0.1 随机口，本启动 key 鉴权）。其余命令仅回环 `/health` 探测与本地文件，无出网。
