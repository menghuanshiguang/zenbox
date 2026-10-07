# catalog.js — 免费车道模型目录：上游清单与本地能力表合并

## 职责边界

上游 `GET /zen/v1/models` 只回答"有哪些 id"，菜单要回答的是"哪个能用、什么能力、什么价"——本文件是这两者之间的静态事实层：`parseListing` 从上游报文抽 id 序列，`capabilitiesFor`/`isFreeLane`/`isRegionSensitive`/`displayModelName` 提供本地能力与展示名，`buildCatalog` 合成可下发清单（`wire` 真源、能力缺省、守卫）。文件头的产品约束逐条对应实现：**不报价**（`price` 是相邻 feed 的裁剪字段，free 列表一律免费——`buildCatalog` 不产生任何价字段）、**id 精确匹配**（兜底能力给全部展示模型理由充分）、**state 不覆盖能力**（模型失败不改能力，一次 503 不该让菜单假装模型不存在——所以本文件零状态）、**负类才出局**（分类责任在 `probe.js`，本文件只留形状与能力）、**铁打 id 流水展示名**（id 按上游原样下发给适配器，不做归一）。网络、重试、轮转全不在这里。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `CAPABILITIES` | const | 10 条有序条目 `{re: RegExp, vision, reasoning, contextWindow, maxOutput, canDisableThinking}` | 能力目录按**特异到宽泛**排序：`/^mimo.*v2\.6/`、`/^mimo.*v2\.5/`、`/^mimo/`（三档 mimo：`canDisableThinking` false，其余档 undefined→消费端真）、`/^muse.?spark/`、`/^nemotron/`、`/^ling/`、`/^space.?bunny/`、`/^union/`、`/^deepseek/`、`/^jev/`；命中即停 |
| `isFreeLane` | function | `isFreeLane(modelId) → boolean` | 永久免费车道 `ALWAYS_FREE={'union-alpha','space-bunny-free'}` 命中，或 id 中的单词 `free`（`/(?:^\|[-_])free(?:$\|[-_.])/`——连字符/下划线/点边界，`mimo-free-preview` 算、`prefix-freeze` 不算） |
| `capabilitiesFor` | function | `capabilitiesFor(modelId) → {vision,reasoning,contextWindow,maxOutput,canDisableThinking}` | `CAPABILITIES` 首个正则命中；未命中给缺省 `{vision:false, reasoning:true, contextWindow:131072, maxOutput:32768}`——非 mimo 一律默认可思考，缺省会让 picker 隐藏思考开关 |
| `isRegionSensitive` | function | `isRegionSensitive(modelId) → boolean` | `REGION_SENSITIVE=[/^muse.?spark/]` 命中（按当前主列表排序轮换的 region 模型） |
| `displayModelName` | function | `displayModelName(modelId) → string` | `DISPLAY_NAMES` 11 项精确映射（`mimo-v2-5`→`Xiaomi MiMo`、`mimo-v2-5-pro`→`MiMo Pro`、`mimo-v2-6`→`MiMo V2.6`、`mimo-v2-6-pro`→`MiMo V2.6 Pro`、`muse-spark`→`Xiaomi Muse Spark`、`mimo-v2-5-tts`→`MiVoices`、`nemotron-3-super`→`Nemotron 3 Super`、`ling-1t`→`OPPO Ling 1T`、`space-bunny`→`Space Bunny`、`deepseek-v3-2`→`DeepSeek V3.2`、`jev-3`→`Jeves 3`），未命中按分隔符切词 Title-Case（铁打 id 流水展示名） |
| `buildCatalog` | function | `buildCatalog(ids) → Array<{id,name,wire,vision,reasoning,contextWindow,maxOutput,canDisableThinking,regionSensitive}>` | 过滤非串/去重/保上游序；`wire`：`isResponsesModel(id)` → `'responses'` 否则 `'chat'`（真源只在 `src/upstream.js`）；`name=displayModelName(id)`；能力与 `regionSensitive` 各自查表；四个数值字段经 `number()` 守卫（非正数回缺省）；`price` 不在此产生 |
| `parseListing` | function | `parseListing(payload) → string[]` | `payload.data` / `payload.models` / 顶层数组 → id 字符串数组，非串剔除；空体/无 id 返回 `[]`（上游 listModels 的分流归 index.js/http.js） |

私有件：`ALWAYS_FREE`、`REGION_SENSITIVE`、`DISPLAY_NAMES`、`number()`（`Number.isFinite(n) && n > 0` 守卫，`u ?? def`）。

## 依赖关系

- **import 进来**: `./upstream.js`（`baseModelId`——去厂商前缀供正则匹配，`isResponsesModel`——`wire` 判定唯一真源）。**不 import** `./store.js`（catalog.json 的持久化在 index.js）。
- **被谁依赖**: `index.js`（`buildCatalog, parseListing`——`/models` 清单拉取与菜单组装；**同时仍 import `buildEacCatalog/buildKiloCatalog/isEacEntry/isKiloEntry/reviveKiloCatalog`**，这些导出已随 cut 删除，index.js 因此加载失败，见已知边界）；`scripts/effort-test.mjs`、`scripts/recovery-test.mjs`、`scripts/sniff-test.mjs`、`scripts/probes/decode-window.mjs`、`scripts/probes/long-answer.mjs`、`scripts/probes/long-think-truncation.mjs`（`capabilitiesFor` 造夹具）。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `catalog.refreshMinutes` | `30` | src/config.js `DEFAULTS.catalog`（env `OFM_CATALOG_REFRESH`） | 清单刷新间隔；start.js 消费，**当前代码未含**（运行时刷新仍在 index.js），config.json 尚在建设（M0 补） |
| `catalogSyncedAt` | `0` | store.js `SETTINGS_INITIAL` → index.js | 上次清单同步时间戳（账在 store，不在本文件） |
| `settings.exposeRegionModels` | `true` | 同上 → index.js 过滤 `regionSensitive` | 与 `isRegionSensitive` 配合的展示开关 |

本文件自身零配置读取——纯函数。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| 无 | 本模块零日志、零抛错；坏报文降级为 `[]`、坏数值降级为缺省 | 清单为空的重试与日志（`Could not load model list` 等）在 index.js/`src/http.js` |

## 网络面

无网络面。上游 `GET https://opencode.ai/zen/v1/models` 的拉取由 index.js（`listModels` 经 `src/http.js`）完成，本文件只处理已到手的 `payload`。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #39 | 已合入上游 main（清单联动） | 清单与探测/picker 的联动语义随上游 fbc3b9b 进入：`buildCatalog` 的形状 + `probe.js` 负类出局 + picker 成员资格三件套 |
| （有意差异） | M0 决策 | 上游 main 的 catalog 含 EAC/Kilo 两条渠道车道，本仓库 M0 已按 AGENT-BRIEF §2.1 删除——cut 5b84917 对 `src/catalog.js` 净删 307 行（438→131 行），现仅存 opencode 免费车道逻辑；此为与上游的**有意差异**，回灌上游更新时不得带回归 |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| 暂无 | 暂无专属文件（原 `scripts/catalog-test.mjs` 已随 cut 5b84917 删除；coverage-map 无 `catalog` 映射——M1 补，见 coverage-map） |
| 间接覆盖 | `scripts/sniff-test.mjs`/`scripts/effort-test.mjs`/`scripts/probes/*.mjs` 经 `capabilitiesFor` 使用能力目录（夹具正确性即其回归面）；`scripts/picker-test.mjs` 覆盖 `computeMembership/listModels/summary` 的成员资格消费，但**当前入口未通**（import `../index.js` 即 `src/chan-relay.js` 缺失） |

## 已知边界

- **两处计数出入需核实**：AGENT-BRIEF/任务简报称删除后剩 119 行，实测 `src/catalog.js` 为 131 行（cut 后 `git show 5b84917` 净删 307 行，438→131）——本档案以 131 为准。
- **index.js 未随 cut 重构**：仍 import 已删除的 `buildEacCatalog`/`buildKiloCatalog`/`isEacEntry`/`isKiloEntry`/`reviveKiloCatalog`（及 `src/eac.js`/`kilo.js`/`chan-relay.js` 等），加载即 `ERR_MODULE_NOT_FOUND`；凡 import `../index.js` 的测试（picker/recovery 后段/speed-stat/offline 等）当前全部跑不通，清单端到端亦然。
- 能力目录是**正则序敏感**的：新 id 若被宽泛模式（如 `/^mimo/`）先命中会拿错能力档，新增特异档必须插在序首。
- `parseListing` 不做去重（去重在 `buildCatalog`）；不校验 id 语义——上游给什么 id，菜单就以什么 id 下发（铁打 id）。
- `price`/`cost` 字段被有意排除在 `buildCatalog` 之外——报价归属相邻 feed 层。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- M0（cut 5b84917）：按 AGENT-BRIEF §2.1 删除 EAC/Kilo 车道导出与实现（`buildEacCatalog`/`buildKiloCatalog`/`isEacEntry`/`isKiloEntry`/`reviveKiloCatalog` 及其常量/正则/内联条目），现文件 131 行、仅 opencode 免费车道；与上游 main 的有意差异，回灌时需保留。
