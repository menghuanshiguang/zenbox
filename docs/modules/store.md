# store.js — 插件自有 JSON 持久化与用量统计累计

## 职责边界

插件不共用宿主 store：settings、stats、availability、catalog、feed 各是一个 JSON 文件，由 `JsonStore` 统一负责解码—改—排队写回的生命周期（带 800ms 去抖与 temp+rename 原子落盘）。本文件同时承载两套账本语义：`recordUsage`/`recordTurn` 的用量与轮账（天桶 + 终身桶、请求计数、96 点速度环形采样）、`migrateStats`/`pruneDays` 的版本迁移与保留策略；以及五个可独立引用的纯函数——`resolveDshHome`、`dayKey`、`decodeWindow`、`recordTurn`、`recordUsage`。状态分类（`availability.json` 的来源）、磁盘位置争议、/feed 拉取与投稿裁剪都不在这里；`settings.feed.json` 的 feed 源文件与裁剪逻辑在 index.js。写回失败只告警一次、不重试不崩溃——**内存里的数据仍然有效**，与"写入磁盘的相同更新构成的统计"宁可丢盘不丢会话。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `resolveDshHome` | function | `resolveDshHome() → string` | 非空 `process.env.DSH_HOME` 优先，否则 `path.join(os.homedir(), '.dsh')`——文件头点名这是唯一决定数据归属的开关 |
| `ensureKey` | function | `ensureKey(dir, name, explicit='') → {key, path, source}` | §8.1 key 空=首启生成：`explicit` 非空直接返回（`source:'config'`、`path:null`，不落盘）；文件已有则复读（`source:'file'`）；否则 `generateKey()` 写 `<dir>/<name>`（0600，`writeSecret`）返回 `source:'generated'` |
| `rotateKey` | function | `rotateKey(dir, name) → {key, path}` | 无条件生成新 Key 覆盖文件（0600）——旧 Key 因 forward 每请求重读而立即 401 |
| `readKey` | function | `readKey(dir, name, explicit='') → {key, source}` | 显式优先（`source:'config'`）→ 读文件 trim 非空（`'file'`）→ 都无（`'missing'`、`key:''`）；start.js 的 `config()` 每请求调它 |
| `DATA_DIR_NAME` | const | `'our-free-model'` | `<dshHome>/<此名>` 构成 dataDir |
| `STATS_VERSION` | const | `3` | 统计结构版本号，`migrateStats` 的升级标尺 |
| `JsonStore` | class | `new JsonStore(file, initial, {log})`；方法 `load()/get()/update(patch)/edit(fn)/schedule()/flush()/dispose()` | 解析失败保留 `<file>.corrupt-<时间戳>` 副本后退回 `initial`；`update` 浅合入并 `schedule()`；`schedule` 800ms 去抖 + `unref()`；`flush` 写 `<file>.tmp` 后 rename（目标 mode `0600`），失败置回 dirty 且仅首次调 `log(our-free-model: could not persist …)`；`dispose()` 先 flush 再封 `disposed` |
| `dayKey` | function | `dayKey(at) → 'YYYY-MM-DD'` | 统计天桶键（本地时区），采样 `{day, tps, at}` |
| `SETTINGS_INITIAL` | const | frozen，键见"配置键"节 | 旧链路 settings 的初始形状与全部默认值 |
| `STATS_INITIAL` | const | frozen `{version:3, days:[], lifetime:{...}, requests:0, failedRequests:0, logicalTurns:0, estimatedTurns:0, llmSamples:[], llmSamplesIndex:0}` | 统计初值；`days` 每项 `{day, tokens, requests, cost, decodeMs, decodeSamples}` |
| `MIN_DECODE_MS` | const | `250` | 低于该时长的 decode 窗不可信（`window.measurable=false`） |
| `MAX_CREDIBLE_TPS` | const | `250` | 速度样本可信上限（只作 `deem`/挑选护栏） |
| `decodeWindow` | function | `decodeWindow(decodeMs, tokens, ok)` | `measurable = ok && tokens>=0 && decodeMs>=MIN_DECODE_MS`；`tps = tokens/(decodeMs/1000)`，上限 `MAX_CREDIBLE_TPS` |
| `recordUsage` | function | `recordUsage(stats, record)` | 按 `dayKey` 建/取天桶：`tokens += usage.input+output`、`requests++`、累计 decodeMs/decodeSamples、`cost` 按 `usage.cost` 取正数相加；终身桶累计（`cost`、`price`、`tokens` 按 `breakdown{input,output,cached,reasoning}` 分账）；总 `requests`；条件字段 `truncated`/`noUsage`/`refusal`/`recoveryId`/`attempt`/`elapsedMs`/`recoveryAttempt`/`recoveryScheduled`/`recovered`/`aborted` 原样保留进天桶样本（`refusal: true`=#84 被拒轮标记，与替换它的重发轮区分——两轮同 `recoveryId` 同 attempt）；速度样本仅在可测时入 `llmSamples` 环形（400 点，`llmSamplesIndex` 游标覆写） |
| `recordTurn` | function | `recordTurn(stats, record)` | 逻辑轮账：`logicalTurns`（诚实完成）与 `estimatedTurns`（估算）分别累计，毫秒耗时归入天桶 `decodeMs` 口径 |
| `migrateStats` | function | `migrateStats(value) → value` | v<2：清掉旧速度总量（口径不可比）；v<3：重建 `failedRequests`、`logical+estimated` 轮字段；返回原对象/或初值，幂等 |
| `pruneDays` | function | `pruneDays(state, keepDays=120)` | `days` 只留最近 `keepDays` 桶（保序截断），终身桶不动 |

## 依赖关系

- **import 进来**: `node:fs`（`readFileSync`/`writeFileSync`/`renameSync`/`mkdirSync`/`chmodSync`/`existsSync`）、`node:path`、`node:os`（`homedir`）；`./forward.js` 仅取 `generateKey`（Key 铸造的唯一实现，forward 自身不反向依赖 store）。
- **被谁依赖**: `start.js`（`JsonStore, STATS_INITIAL, recordUsage, recordTurn, ensureKey, rotateKey, readKey`——stats 实例与 Key 生命周期）；`index.js`（`DATA_DIR_NAME, JsonStore, SETTINGS_INITIAL, dayKey, pruneDays, recordTurn, recordUsage, resolveDshHome, STATS_INITIAL`——四个 store 实例与统计路由）；`scripts/speed-stat-test.mjs`（全部七个导出 + 以 index.js 的 `buildStats` 为夹具）；`scripts/offline-test.mjs`（经 index.js 的 `SETTINGS_INITIAL` 冷启动断言）。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `DSH_HOME`（env） | 未设 → `~/.dsh` | `resolveDshHome` | 数据根目录唯一开关 |
| `enabled` | `true` | `SETTINGS_INITIAL` | 服务总开关 |
| `exposeRegionModels` | `true` | 同上 | 是否展示 region-blocked 模型 |
| `probeIntervalMinutes` | `15` | 同上 | 探测间隔（probe 旧链生效值） |
| `forward` | `{enabled:false, host:'127.0.0.1', port:18899, lan:{enabled:false, port:0}}` | 同上 | 上游转发段（forward.js） |
| `egress` | `{enabled:false, mode:'subscription', url:'', mihomoPath:''}` | 同上 | 出口段（egress.js 运行时真源；与新层 `egress.mode∈{direct,proxy}` 双层并存） |
| `chanGateway.relay` | `{enabled:false, host:'127.0.0.1', port:18326, key:''}` | 同上 | 中继转发段 |
| `defaultMaxTokens` | `32768` | 同上 | 插件默认输出上限（effort 梯子的 fallback） |
| `streamRecovery` | `true` | 同上 | 流恢复开关（recovery 策略输入） |
| `announcementAck` / `announcementsAcked` / `feedUrl` / `feedPollMinutes:30` / `notifyOs` / `catalogSyncedAt:0` / `updateCheckHours:6` / `updateNotifiedFor` / `autoReloadWatch` / `distribution:'self'` / `reloadedAt` / `reloadCount` / `installedVersion` | 见左 | 同上 | 公告/订阅源/更新/自重载/分发账 |
| `data` | `'./data'` | src/config.js `DEFAULTS.data`（env `OFM_DATA`） | 新配置层数据目录：start.js 已接线——`ensureKey` 落 `<data>/forward-key|lan-key`、`JsonStore(<data>/stats.json)`；settings/availability 等旧账本仍走 `resolveDshHome()` |

文件落点：`<dataDir>/settings.json`、`stats.json`、`availability.json`、`catalog.json`（`<file>.tmp` 中转、损坏副本 `<file>.corrupt-<ts>`）。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| `our-free-model: could not persist <文件名> (<error.message>); changes are kept in memory only` | rename/写盘失败，**每事故只报一次** | `options.log` → index.js `logger.warn`；随后置回 dirty、`disposed` 前停止后续告警 |
| 无抛出异常 | 磁盘不可写时 | 内存状态继续服务（文件头承诺），`dispose()` 的 flush 同样只吞错不抛 |

## 网络面

无网络面。纯本地文件 + env；出口、拉取、转发都由相邻模块承担。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| 无直接 PR | — | 见 docs/pr-coverage.md（该文件当前未创建，M0 补） |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/speed-stat-test.mjs` | 覆盖 `decodeWindow`（`MIN_DECODE_MS`/`MAX_CREDIBLE_TPS` 双界）、`recordUsage`/`recordTurn` 桶累计与条件字段、`migrateStats`（v1/v2→v3 迁移幂等）、`pruneDays` 截断、`JsonStore`（损坏副本/去抖写回/flush 失败只告警一次）、`STATS_INITIAL` 形状、index.js `buildStats`；**当前跑不通**：入口 import `../index.js` 即 `Cannot find module 'src/chan-relay.js'`（见已知边界） |
| `scripts/offline-test.mjs` | 覆盖 `SETTINGS_INITIAL` 驱动的无 key 冷启动与 managed 门、订阅链接保密（设置页不回显 `egress.url`） |
| `test/unit/cli.test.js`（coverage id: `cli-unit`） | `ensureKey` 生成/复读/显式不落盘、`rotateKey` 换新、`readKey` 三态（file/config/missing） |
| `test/integration/key-rotate.test.js`（coverage id: `key-rotate`） | rotate 后旧 Key 立即 401、新 Key 200（每请求重读 key 文件的接线） |

## 已知边界

- `JsonStore` 是**单进程、单实例/文件**模型：并发实例互不感知，rename 原子性依赖同目录；`schedule` 的 800ms 窗口内进程被杀会丢最后一批改动（flush 尽力而为）。
- 写失败不重试：告警一次后依赖下次 `update` 重新置脏；`dispose()` 之后的 `update` 被拒。
- `recordUsage` 的 `cost` 只收正数、`usage` 缺失时按 `noUsage` 记账不计钱；速度样本受 `decodeWindow` 双护栏，不可测的窗根本不入环。
- 保留策略仅对 `days`（`pruneDays` 默认 120 天）；终身桶与 `llmSamples` 环（400 点）自行覆写，无删除路径。
- `DSH_HOME` 必须在进程读它之前设置（`resolveDshHome` 每次现读 `process.env`，但宿主 spawn 时机决定生效）。
- 新配置层 `data` 键未接线：文档所标 dataDir 以 `resolveDshHome()` 现行为准。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 本仓库无改动（cut 未触及 store.js）；`STATS_VERSION=3` 与 `migrateStats` 的 v1/v2 清理是上游既有语义。
- 2026-10-07 M2：落 §8.1 Key 三助手 `ensureKey`/`rotateKey`/`readKey`（`writeSecret` 私有，0600 + 尽力 chmod），import `generateKey` from `./forward.js`；start.js 接线 `data/forward-key|lan-key` 与 `stats.json`（cli-unit / key-rotate 两测试）。
- 2026-10-08 M3：port-of #84——`recordUsage` 样本条件字段增 `refusal`（被拒轮与替换它的重发轮区分，同 `recoveryId` 同 attempt；adapter `record(...,{refusal:true})` 驱动）。
