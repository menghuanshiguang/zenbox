# probe.js — 模型可用性探测与出口公网地址探测

## 职责边界

两件独立的探测。其一：对单个模型发一次最小的流式 ping（`max_tokens: 16`，`buildPing` 按 `wireFor` 生成三种 wire），以最快路径把答复分类成 `available` / `region-blocked` / `unavailable` / `throttled` / `unknown` 五个态——分类是文件头的核心教训：200 报文里也会带业务层错误（"Model is unavailable"），超时里混着真故障，把网关自身 5xx 当模型死讯会冤杀整个清单，所以只有负类证据才把模型踢出菜单，`unknown` 永远留在线上继续试。`probeCatalog` 把判定套到模型序列，默认 2 个并发跑完一整轮再发下一轮（打一发就限速是很快输光用户额度的方式）。其二：`detectEgress` 问出口三个公网 echo 源，取回 `{ip, country?}` 供 UI 显示路由位置；全部失败返回 `undefined`——故意 fail-open，探测循环不能因一次网络故障冻结。本模块不记可用性账（落盘在 `src/store.js` `availability.json`，索引重建在 index.js）、不实现重试与退避、不缓存结果（缓存层在调用方）；`ttftMs` 只测量、不参与分类。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `STATE` | const | `STATE = {available, regionBlocked:'region-blocked', unavailable, throttled, unknown}` | 可用性五态；UI 菜单过滤与状态列都以它为键 |
| `probeModel` | function | `probeModel(model, {attributionUserAgent, signal, timeoutMs=45000}) → Promise<{state, detail?, latencyMs, ttftMs?, ...}>` | 单模型单发探测：拿 wire 模板（`ping` 变体是 `messages`/`responses` 走入 `src/http.js` `postStreamed`，`chat` 变体直发 `/chat/completions`）；读到第一个正文块→可用并记 TTFT；流内 error 帧、HTTP 状态、空响应（`no usable response frame`）、断流（`stream closed before the first usable frame`）各自归档到 `detail`，再走状态分类 |
| `detectEgress` | function | `detectEgress({signal, timeoutMs=8000}) → Promise<{ip,country?}\|undefined>` | 按 `ECHO_SOURCES` 顺序（ipify → ipinfo → ipapi，顺序即 `src/config.js` `ip.providers` 序，start.js 接线中）经 `egressFetch` 拉 JSON；解析失败/超时换下一源，计时器在 `finally` 清理；全败 `undefined`（fail-open） |
| `probeCatalog` | function | `probeCatalog(models, options, onResult, concurrency=2) → Promise<[]>` | 对每个模型跑 `probeModel` 并把 `{...result, model}` 交 `onResult`（结果不聚合）；逐批并发，整批放行才开下一批 |

私有件：`PING_PROMPT='ping'`、`ECHO_SOURCES`（三 URL 常量）、`buildPing`（`wireFor(wire)` 的模板选择器 + 三种 body，`max_tokens:16`）、`stateOf`（状态分类）、`CODE`（`../http.js` 重导出的自定义状态码域）、`ROUTING_REFUSAL_STATUS = new Set([400, 404, 422])`、`REGION_MARKERS`、`REFUSAL_MARKERS`、`THROTTLED_MARKERS`。

`stateOf` 的分类序（真源）：(1) 自定义状态码 `region` → `region-blocked`，`quota` → `throttled`（`../http.js` 的域，一等优先）；(2) 报文体带 `error.unavailable === true` → `unavailable`；(3) 5xx 状态**禁用**消息文本匹配（网关自己的故障不算模型拒答），其余状态匹配 `unavailable`/`not supported`/`no such model`/`unknown model`/`invalid model` → `unavailable`；(4) 路由拒答状态 `ROUTING_REFUSAL_STATUS`（400/404/422）或撞上拒答/限速 marker → 对应态；(5) `unknown` 兜底。

## 依赖关系

- **import 进来**: `./upstream.js`（`applyFingerprint`、`endpointFor`、`mintRequestId`、`sessionForConversation`、`wireFor`——wire/端点/指纹的唯一事实源）；`./http.js`（`CODE`、`postStreamed`——`messages`/`responses` 两 wire 的流式请求、状态抽取）；`./egress.js`（`egressFetch`——echo 源与 ping 都走出口改道）。
- **被谁依赖**: `index.js`（`STATE`、`detectEgress`、`probeCatalog`——定期探测循环、`exposeRegionModels` 过滤、出口 IP 展示）；`scripts/sniff-test.mjs`（`probeModel`）。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `probe.enabled` | `true` | src/config.js `DEFAULTS.probe`（CLI `--probe` / env `OFM_PROBE`） | 探测总开关；start.js 消费，**当前代码未含**（运行时仍走 index.js 旧配置链），config.json 尚在建设（M0 补） |
| `probe.intervalMinutes` | `60` | src/config.js `DEFAULTS.probe` | 探测周期；同上当前未接线 |
| `probe.concurrency` | `2` | src/config.js `DEFAULTS.probe` | 与 `probeCatalog` 的 `concurrency=2` 同义 |
| `ip.refreshMinutes` | `30` | src/config.js `DEFAULTS.ip` | 出口 IP 刷新周期 |
| `ip.providers` | `['ipify','ipinfo','ipapi']` | src/config.js `DEFAULTS.ip` | 与 `ECHO_SOURCES` 一一对应的短名序（start.js 接线，当前代码未含） |
| `probeIntervalMinutes` | `15` | store.js `SETTINGS_INITIAL` → index.js 读 settings | 旧链路的探测间隔，现行生效值 |
| `settings.exposeRegionModels` | `true` | store.js `SETTINGS_INITIAL` → index.js 过滤 | 为 false 时按 `STATE.regionBlocked` 藏模型 |

`probeModel` 的 `timeoutMs=45000`、`detectEgress` 的 `timeoutMs=8000` 是模块常量，由调用方在 options 覆盖。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| `detail: "probe timed out"` | ping 超出 `timeoutMs` | 返回值字段，无日志 |
| `detail: "probe aborted"` | 调用方 signal 取消 | 返回值字段 |
| `detail: "no usable response frame"` | 200 但无正文/无内容（空 body、`data: [DONE]` 即止） | 返回值字段 |
| `detail: "stream closed before the first usable frame"` | 首帧前断流（ECONNRESET 等） | 返回值字段 |
| 流内 error 帧（`response.error`，正文 slice 前 200 字符） | 200 报文携带业务层错误 | 返回值 `detail`；`error.unavailable===true` 驱动分类 |

模块零 `console`/日志输出——所有诊断以返回结构表达，落盘与展示归调用方。

## 网络面

- **上游网关探测**：`postStreamed`/直发到 `endpointFor(wire)`（`https://opencode.ai/zen/v1/{responses,messages,chat/completions}`，`src/upstream.js` 事实源），流式 body 16 token 上限、带 `applyFingerprint` 指纹与 `mintRequestId`——全部经 `egressFetch`，开出口时过回环中继。
- **公网 echo 源**（`detectEgress`，出向 GET，`redirect: 'error'`）：`https://api.ipify.org?format=json` → `https://ipinfo.io/json` → `https://ipapi.co/json/`，顺序即配置 `ip.providers`；只读 `ip`/`country`，响应体不落盘。
- 无入向监听、无自建端口；探测频率受 `probeIntervalMinutes`/`probe.intervalMinutes` 约束。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #39 | 已合入上游 main（探测截止） | 探测截止语义已随上游 fbc3b9b 进入本仓库：`stateOf` 的分类序与 `probeCatalog` 整轮节流即其落点；**当前代码未含**的是 `src/config.js` 新配置层（`probe.*`/`ip.*`）对它的接线 |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/sniff-test.mjs` | 段组"the probe must not punish a model for the gateway's own trouble"（实测通过）：200 流被标 `Model is unavailable` → 5xx 语义仍判 `available`；503、503 `Service Unavailable`、503 html 代理页 → `unknown`；404 → `unavailable`；503 body 点名 `Model is unavailable` → `unavailable`；200 envelope 点名 `no such model` → `unavailable` |
| `scripts/picker-test.mjs` | 覆盖 `probeModel` 判定到 picker 成员资格的贯通（`computeMembership`/`listModels`/`summary` 三面）；**当前入口未通**：import `../index.js` 即 `Cannot find module 'src/chan-relay.js'`（见已知边界） |
| `scripts/offline-test.mjs` | 覆盖 `detectEgress` 依赖的 `egressFetch` 无出口直通与出口改道（echo 源计时器冻结问题的回归面） |

## 已知边界

- **不写可用性账**：`probeModel` 是纯探测，状态持久化/重建在 `src/store.js` `availability.json` 与 index.js，轮转删除策略不在本文件。
- **`probeCatalog` 不聚合结果**、不中止：`onResult` 抛错会中断整轮（错误处理责任在调用方）；`concurrency` 是逐批并发不是窗口。
- `stateOf` 的 marker 列表是正则匹配而非结构化解析——上游报文措辞变化会静默降级成 `unknown`（兜底方向是"留在线上"）。
- `detectEgress` 不缓存、不并发去重：多处同时调用会各自打一遍三源；`country` 缺失时不补默认。
- `picker-test.mjs` 等 import `../index.js` 的测试当前全部因 `src/chan-relay.js` 缺失而未跑通（index.js 尚未随 cut 重构），`probeModel`/`probeCatalog` 的端到端恢复待该入口修复。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 待接线：`src/config.js` 的 `probe.*`/`ip.*` 键是 M0 新配置层预留，运行时仍旧链（`settings.probeIntervalMinutes`）。
