# CLI（docs/start-cli.md）

入口 `start.js`（`node start.js <命令>`，`package.json` bin 名 `zenbox`，`npm start` → `node start.js start`）。被 `import`（测试取导出）不拉起 main——`import.meta.url` 与 `argv[1]` 比对后才执行。

## 命令

| 命令 | 现状（M2 实测） | 最终形态（§8.5） |
| --- | --- | --- |
| `start` | §3 时序落地：`ensureKey`（0600 落 `data/forward-key|lan-key`）→ JsonStore(stats) → **egress（#45/#75/#82 宿主半，三态 config 切换）**：`egress.mode≠direct` 时 `startEgressRelay`（`proxy→{mode:'client', url, password}` 密码独立字段、`subscription→{mode:'subscription', url}` 受管 mihomo，起不来退出 1 不改直连；`onFault`/`onQuotaHit` 汇入 `scheduleOutletRotation`——60s 冷却+单飞+`limitedNodes` 10min 候补 → `refreshOutletExit({avoid})`；`onLane` 打切直连/回中继行）→ 运行链组装（FALLBACK_CATALOG + computeMembership + FreeModelAdapter + createRunForwarded，与 recovery-test withForward 同构）→ `startForwardServer`（`config()` 每请求 `readKey`，rotate 即刻生效）→ `lan.enabled` 时 `startLanRelay` → **banner（§8.4 框，src/banner.js；IP/LAN 地址以 [异步] 占位）** → `[listen]` 行 → **后台轮（#72：LAN 地址轮 + 公网 IP 轮——各自 try 包裹，失败只记 `[warn]` 永不挡监听；补行走 `renderIpLine`/`renderLanAddressLine` 单行）** → **5s 自测（带 Key /v1/models 200、无 Key 401，失败提示 doctor）** → 60s 心跳 → SIGINT/SIGTERM/`OFM_SMOKE_MS` 优雅关（relay→forward→egress→stats.dispose，含 `clearInterval(ipTimer)`） | + probe 轮与清单分桶补行 |
| `status` | banner + `listeners/key/lanKey` 实测（`/health` 800ms 探测）；`--json` 全字段；`pending` 如实列公网 IP（M4）与探测摘要（M3） | + 公网出口 IP、LAN 地址（#76）、egress 三态实值 |
| `models` | 列 FALLBACK_CATALOG 8 行（id + context_window）+ 分桶 verdict `unknown` 占位 | 分桶 available/region-limited/removed 带拒因（M3 probe 轮） |
| `probe` | 回显 probe 配置节奏 + `pending: M3 probe 轮接入（data/availability.json 落盘）`，不真出网 | 手动触发一轮探测并出结果 |
| `key` | 查看：`readKey` → `{target, source, tail4, exists, path}`；`key rotate` → `rotateKey` 覆盖文件（0600），旧 Key 即刻 401（forward 每请求重读）；config 显式 Key 时 rotate 报错退出 1 | `--lan` 轮换 LAN 独立 Key（M4） |
| `doctor` | 5 检查：node(≥22.19)/config-valid/listeners(`/health`)/key/upstream-reachable（`PENDING` M4，本轮不真出网）→ 任一非 OK 退出 1（如实不装绿） | 全绿检查（上游 200/401 自测） |

## 通用约定

- `--json` 适用于 status/models/probe/key/doctor；对 `start` 报错（流式日志与 JSON 不兼容）。
- 配置错误（`ConfigError [field]`）打 stderr 并以退出码 1 拒绝启动；未知命令同样退出 1。
- 优先级与全部 flag/env 见 [modules/config.md](modules/config.md#配置键)。
- banner 字段（§8.4）：`src/banner.js` 框渲染；冷启动没拿到的字段打 `[异步]` 占位，后台轮拿到值后**单行补打**（不重排已输出日志）。禁止假装就绪。
- `OFM_*` env 层已接线（`loadConfig({argv, env: process.env})`——此前 env 参数默认空对象，层写了没接，M4 修复）。
- 测试钩子：`OFM_SMOKE_MS=<毫秒>` 时 `start` 到点自动优雅退出 0（CI 冒烟专用，真实启动不设）。
- Key 口径（§8.1）：`listen.key`/`lan.key` 空 = 首启 `generateKey()` 写 `data/<name>`（0600）；两键互不通用；`key rotate` 无条件换新。

## 网络面

`start` 绑本机回环转发口（默认 `127.0.0.1:18899`，被占走 #23 顺延，`fallback:false` 即占用即败）；`lan.enabled=true` 才绑 LAN 中继口；`egress.mode≠direct` 时额外起回环出口中继（127.0.0.1 随机口，本启动 key 鉴权）。其余命令仅回环 `/health` 探测与本地文件，无出网。
