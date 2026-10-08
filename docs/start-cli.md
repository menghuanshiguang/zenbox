# CLI（docs/start-cli.md）

入口 `start.js`（`node start.js <命令>`，`package.json` bin 名 `zenbox`，`npm start` → `node start.js start`）。被 `import`（测试取导出）不拉起 main——`import.meta.url` 与 `argv[1]` 比对后才执行。

## 命令

| 命令 | 现状（M2 实测） | 最终形态（§8.5） |
| --- | --- | --- |
| `start` | §3 时序落地：`ensureKey`（0600 落 `data/forward-key|lan-key`）→ JsonStore(stats) + 盘上轮次重放（`catalog.json`/`availability.json` 有则先用，重启即显真实清单与裁决）→ **egress（#45/#75/#82 宿主半，三态 config 切换）**：`egress.mode≠direct` 时 `startEgressRelay`（`proxy→{mode:'client', url, password}` 密码独立字段、`subscription→{mode:'subscription', url, token}`（`egress.subscription.token` 订阅站 apikey 透传给 mihomo provider 的 Authorization 头）受管 mihomo，起不来退出 1 不改直连；`onFault`/`onQuotaHit` 汇入 `scheduleOutletRotation`——60s 冷却+单飞+`limitedNodes` 10min 候补 → `refreshOutletExit({avoid})`；`onLane` 打切直连/回中继行）→ 运行链组装（可变 catalog/availability + computeMembership + FreeModelAdapter + createRunForwarded，与 recovery-test withForward 同构）→ `startForwardServer`（`config()` 每请求 `readKey`，rotate 即刻生效）→ `lan.enabled` 时 `startLanRelay` → **banner（§8.4 框，src/banner.js；models 行按盘上裁决给「分桶待探测」或四段全分桶）** → `[listen]` 行 → **后台轮（#72 + §3 全套）：LAN 地址轮、公网 IP 轮、**清单轮**（`egressFetch GET /zen/v1/models` → `parseListing` → `buildCatalog` 替换运行态与 `data/catalog.json`，失败保留旧 roster 只记 warn）、**探测轮**（清单后首轮 force、随后 `probe.intervalMinutes` 节奏；`probeCatalog` 并发逐模型，裁决边到边写 `data/availability.json`；全拒保留清单、全 429 指数退避 30→120min；完成四段分桶 `renderModelsLine` 补行）——每轮独立 try，失败只记 `[warn]` 永不挡监听** → **5s 自测（带 Key /v1/models 200、无 Key 401，失败提示 doctor）** → 60s 心跳 → SIGINT/SIGTERM/`OFM_SMOKE_MS` 优雅关（relay→forward→egress→stats/availability/catalog 三 store dispose，含 `clearInterval(ipTimer/catalogTimer/probeTimer)`） | 全部达成（§3 三后台轮 + §8.4 异步补行齐） |
| `status` | 实态（无 pending）：`listeners/key/lanKey` 实测 + **公网出口 IP**（`fetchPublicIp` 现拉三家降级）、**LAN 地址**（`rankLanAddresses` 现算）、**models 四段分桶**与 **probe 最近轮摘要**（盘上 `availability.json`，按 state 计数带时间戳）；`--json` 全字段 | 达成 |
| `models` | 盘上清单（`data/catalog.json`，无盘回 FALLBACK 8）+ 盘上裁决分桶 + routable 门；`verdicts` 为最近轮摘要（state 计数），`source` 如实标 `fallback` 或 `data/catalog.json` | 达成 |
| `probe` | 配置节奏 + 盘上最近一轮摘要（`N 个模型 @ 时间（available:x throttled:y …）`），尚无轮次如实说「start 后首轮清单拉完即探」 | 手动触发一轮（v0.2） |
| `key` | 查看：`readKey` → `{target, source, tail4, exists, path}`；`key rotate` → `rotateKey` 覆盖文件（0600），旧 Key 即刻 401（forward 每请求重读）；config 显式 Key 时 rotate 报错退出 1；`--lan` 轮换 LAN 独立 Key | 达成 |
| `doctor` | 5 检查：node(≥22.19)/config-valid/listeners(`/health`)/key/**upstream-reachable**（`egressFetch GET /zen/v1/models` 5s 超时，`HTTP 200 · N 个模型` 或 `不可达（原因）`——诊断命令即出网授权）→ 任一非 OK 退出 1（如实不装绿） | 达成 |

## 通用约定

- `--json` 适用于 status/models/probe/key/doctor；对 `start` 报错（流式日志与 JSON 不兼容）。
- 配置错误（`ConfigError [field]`）打 stderr 并以退出码 1 拒绝启动；未知命令同样退出 1。
- 优先级与全部 flag/env 见 [modules/config.md](modules/config.md#配置键)。
- banner 字段（§8.4）：`src/banner.js` 框渲染；冷启动没拿到的字段打 `[异步]` 占位，后台轮拿到值后**单行补打**（不重排已输出日志）。禁止假装就绪。
- `OFM_*` env 层已接线（`loadConfig({argv, env: process.env})`——此前 env 参数默认空对象，层写了没接，M4 修复）；`loadConfig` 归一后会把 `upstream.base` 同步进 `process.env.OUR_FREE_MODEL_BASE`（对话/探测链的惰性基址，config 三途径单一真相）。
- 测试钩子：`OFM_SMOKE_MS=<毫秒>` 时 `start` 到点自动优雅退出 0（CI 冒烟专用，真实启动不设）。
- Key 口径（§8.1）：`listen.key`/`lan.key` 空 = 首启 `generateKey()` 写 `data/<name>`（0600）；两键互不通用；`key rotate` 无条件换新。

## 网络面

`start` 绑本机回环转发口（默认 `127.0.0.1:18899`，被占走 #23 顺延，`fallback:false` 即占用即败）；`lan.enabled=true` 才绑 LAN 中继口；`egress.mode≠direct` 时额外起回环出口中继（127.0.0.1 随机口，本启动 key 鉴权）。`start` 的三个后台轮与 5s 自测出网（清单 `GET /zen/v1/models`、探测逐模型 SSE、公网 IP 三家降级、自测仅回环 200/401）；`status` 出网拉一次公网 IP（4s 超时降级 `unknown`）；`doctor` 出网上游一次（5s 超时）；`models`/`probe`/`key` 只读本地文件，不出网。
