# turn.js — 转发口一次请求的语义链：OpenAI 拼写→harness 消息→适配器流→outcome 折叠

## 职责边界

把调用方的一个 OpenAI 请求翻译成适配器能消费的参数，并把适配器吐回的 StreamChunk 流折成 outcome（文本、工具调用、用量、截断与错误标记）。它同时给出两处共享的"可拨号"判定：`routableModelIds`（picker 与转发口同一门）和 `publicModelRows`（`/v1/models` 行），以及决定模型归主线还是区域线的 `computeMembership`。

明确不做：不发任何网络请求（上游 I/O 全在 `adapter.stream` 一侧），不做鉴权与协议重放（那是 `forward.js`），不做线上协议投影与指纹（那是 `messages.js`/`upstream.js`），不感知 HTTP 请求形态（那是 `forward.js` 的 `serveCompletion`）。

素材全部抽自 `index.js`（M1 拆解）：`index.js` 是上游插件宿主入口，拆完即删；本模块是其中与"一次转发请求"有关的纯语义部分，改名参数化后供 `start.js` 接线与测试共用。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `httpError` | function | `httpError(statusCode, message) → Error` | 带 `statusCode` 的拒绝（404/409），让调用方读到语义状态而非裸 500 |
| `computeMembership` | function | `computeMembership(catalog, availabilitySnapshot, settings) → {route: ids}` | 探测判定→路由归属；region-blocked 进区域线（可隐藏），全部 unavailable 时整轮回退 |
| `routableModelIds` | function | `routableModelIds(state, settings) → Set<id>` | 当前可拨号集合=主线∪（暴露时）区域线；`/v1/models` 与转发口同一门 |
| `publicModelRows` | function | `publicModelRows(catalog, membership, nowSec?) → rows` | `/v1/models` 的行（id/object/created/owned_by/context_window） |
| `fromOpenAiMessages` | function | `fromOpenAiMessages(body, isResponses, modelId) → harnessMsg[]` | chat.messages 或 Responses.input → harness 消息；assistant 行带 #62 要求的完整 `source` |
| `normalizeTool` | function | `normalizeTool(tool) → {name,description,parameters} \| null` | 扁平与 `{function:{…}}` 包装都展平；缺名返回 null |
| `foldForwardOutcome` | function | `foldForwardOutcome(outcome, chunk) → outcome` | StreamChunk 折叠：文本累加、工具槽累参、usage 换算、max-tokens→truncated、error/aborted→error 消息 |
| `createRunForwarded` | function | `createRunForwarded({getCatalog,getState,getSettings,adapter}) → run(request, onChunk)` | 404 门→消息/工具/参数翻译→流→截断过滤的完整装配；`start.js` 与测试共用 |

## 依赖关系

- **import 进来**: `./adapter.js`（`ROUTE_MAIN`/`ROUTE_REGION` 路由常量）、`./probe.js`（`STATE` 探测判定枚举）、`./forward.js`（`toOpenAiUsage` 用量换算，fold 的 usage 分支）。
- **被谁依赖**: `scripts/forward-test.mjs`（`fromOpenAiMessages` 的 #62 source 断言）；`test/unit/turn.test.js`；`start.js` 接线与 `scripts/recovery-test.mjs` 尾段（Forward 口改造后直连本模块）。`index.js` 中保留同名实现素材直至 M1 末删除，期间两处以本模块为准。

## 配置键

无（由调用方注入参数）：`getSettings()` 返回的对象里 `exposeRegionModels` 决定区域线是否并入可拨集合，默认（`undefined`）即暴露；`getState()` 返回 `{membership, settings}`，由接线方从 `computeMembership(catalog, availability, settings)` 供给。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| `httpError(404, model "…" not found)` | 模型不在目录，或不在 `routableModelIds` 集合 | `runForwarded` 抛出 → forward 层按状态码回 `model_not_found`（与 `/v1/models` 同门） |
| `outcome.error = failure.message` | adapter 流以 `finish.reason.kind` = `error`/`aborted` 收束 | 交给 `serveCompletion`：流式发一次 error、非流式 502 |

本模块自身不打日志。

## 网络面

无网络面（纯语义换算；上游连接由 adapter/http 一侧持有）。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #27 | 源码已含；独立回归另立 | `normalizeTool` 展平是 #27 回归（caller tools 抵达上游载荷）的前置换算；回归本体在 `test/integration/forward-tools.test.js` |
| #113 | 源码已含 | 投影次序本体在 `messages.js`；本模块只负责把调用方 messages 翻成 harness 输入，不动次序 |
| #102 | 已移植（落点 adapter.js） | `systemPromptUpdate` 声明发生在 `adapter.resolveModel`，不在本模块 |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `test/unit/turn.test.js`（`turn-unit`） | 19 断言：httpError 状态码；#62 source 形状/Responses 归一/图片 part；normalizeTool 双形态与空名；fold 的文本/工具槽/用量/截断/error 分支；computeMembership 无判定/单拒/全拒回退/区域线；routableModelIds 暴露开关；publicModelRows 过滤与 context_window；runForwarded 404 双门、参数映射（temperature/max_tokens/reasoning_effort/sessionId）、截断过滤坏参数工具 |
| `scripts/forward-test.mjs`（上游迁移素材） | `fromOpenAiMessages` 在真实 Forward 口下的行为与 #62 `synthesized assistant rows carry a complete model source` |

## 已知边界

- `getState()` 在入口检查、routable 门、`adapter.stream` 三处各读一次——与 `index.js` 闭包逐字等价：探测判定在请求中途落地会被同一次请求观察到，不是快照语义。
- `foldForwardOutcome` 对 `aborted` 沿用上游写法赋 `failure?.message`（多数 aborted 无 failure → `error` 保持 undefined），行为与 `index.js` 原实现一致，差异只在显式分支写法。
- `publicModelRows` 的 `created` 是调用时刻时间戳，不反映模型实际上线时间（与上游一致）。
- `index.js` 尚未删除其中的同名实现（素材层）；以本模块为唯一事实源，M1 结束时随 `index.js` 一并移除。

## 变更记录

- 2026-10-07 建档（M1，素材抽自上游 `index.js` fbc3b9b：`fromOpenAiMessages`/`normalizeTool`/`foldForwardOutcome`/`httpError`/`computeMembership`/`routableModelIds`/`publicModelRows`/`runForwarded` 参数化为 `createRunForwarded`）；`scripts/forward-test.mjs` 的 `fromOpenAiMessages` import 从 `index.js` 改指本模块。
