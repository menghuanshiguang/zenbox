# adapter.js — 免密网关的 provider 适配器：双路由注册、三种线上协议转换、流式读取与有界断流续写

## 职责边界

实现 harness 的 adapter contract（`registerAdapter` 按调用方法做结构校验，不 `instanceof` 基类），向内核注册 `our-free-model` 与 `our-free-model-region` 两条路由：前者放当前出口可用的模型，后者放网关按出口地区拒绝的模型，空分组由客户端从选择器丢弃。本模块负责把 `GenerateOptions` 按 catalog 条目选定的 wire（chat / responses / messages）构造成上游请求体、调 `postStreamed` 发出、经 `readStream` 逐 chunk 产出给宿主，并在断流/静默停收/`finish=length` 三种截断上做**有界一次**续写，最后把失败整形成可持久化日志接受的 `LlmFailure`。不监听任何端口（转发与中继在 `forward.js`）、不发裸 HTTP（请求与出口在 `http.js`/`egress.js`）、不落盘（用量与回合交给注入的 `recordUsage`/`recordTurn`）、不解析模型列表（`catalog.js`/`probe.js`）、不做 OpenAI 拼写翻译（`forward.js`，其请求经 `index.js` 最终回到本模块的 `stream`）。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `ROUTE_MAIN` | const | `ROUTE_MAIN = 'our-free-model'` | 主路由 id（选择器第一分组） |
| `ROUTE_REGION` | const | `ROUTE_REGION = 'our-free-model-region'` | 地区受限分组路由 id |
| `ROUTE_LABELS` | const | `ROUTE_LABELS = { [ROUTE_MAIN]: 'Our Free Model', [ROUTE_REGION]: 'Our Free Model · region-limited' }` | 分组标题（选择器唯一可见的组名） |
| `FreeModelAdapter` | class | `new FreeModelAdapter(dependencies)` | 适配器实例；`dependencies` = `{ state, resolveImage, recordUsage, recordTurn, warn, onRegionBlocked?, onQuotaHit? }`（`runStream` catch 里 `CODE.region → onRegionBlocked`、`CODE.quota → onQuotaHit`；`index.js` 另注入的 `sealedCredential` 本模块未读取） |
| `providerInfo` | method | `providerInfo(provider) → { id, name }` | 路由 id → 显示名 |
| `providerRetryPolicy` | method | `providerRetryPolicy() → Object.freeze({ mode: 'normal', maxRetries: 2, retryableCodes: ['EMPTY_RESPONSE','SERVER','TIMEOUT','TRANSPORT'], initialDelayMs: 700, maxDelayMs: 8000, jitterRatio: 0.2 })` | 内核退避调度器原样读取的顶层字段；`REGION_BLOCKED`/`RATE_LIMIT` 有意缺席（重试只烧额度，issue #13） |
| `imageRequestPricing` | method | `imageRequestPricing(_provider, _model) → undefined` | 恒 `undefined`：免费出口不报按图价格，且必须同步（issue #42） |
| `listModels` | async method | `listModels(provider) → Array<{ provider, id, name, description, inputModalities }>` | 该路由当前成员（`state.membership[provider] ∩ state.catalog`） |
| `resolveModel` | async method | `resolveModel(provider, model) → { provider, id, name, inputModalities, context, defaultMaxTokens, reasoning? }` | 目录条目 → 内核模型描述；未知 id 以 `131072`/`8192` 兜底；`defaultMaxTokens = min(entry.maxOutput, settings.defaultMaxTokens ?? 32768)` |
| `prepareCall` | async method | `prepareCall(provider, model) → { model, stream }` | 把模型元数据与 `stream` 闭包冻结到同一 state 快照，目录刷新不串代 |
| `stream` | method | `stream(options, pinned?, snapshot?) → { [Symbol.asyncIterator], next, return, throw }` | 包装 `runStream` 的异步迭代器：转发宿主 abort，`return/throw` 先 `controller.abort()` 再退出（原生生成器把 `return` 排在 pending `next` 之后） |
| `runStream` | async generator（类成员，非模块导出） | `runStream(options, pinned, snapshot)` | 实际的两段式 attempt 循环（首段 + 至多一次续写）与所有 finish/usage 产出点 |

模块私有（未导出）：`STYLE_FOR_WIRE`、`buildPayload(wire, modelId, messages, options, budget, resolveImage, warnings)`、`toFailure(error)`、`describe(entry, settings)`。

## 依赖关系

- **import 进来**：`./upstream.js`（`applyFingerprint` 指纹注入与改名映射、`baseModelId` 去标签、`endpointFor`/`wireFor` 选路径与线上协议、`mintRequestId`/`sessionForConversation` 请求与会话 id）；`./messages.js`（`toChatMessages`/`toClaudeMessages`/`toResponseInput` 三种线上格式、`toToolDefs` 工具定义转换、`repairToolPairing` 孤儿工具对修复）；`./http.js`（`CODE` 失败码表、`UpstreamError`、`postStreamed` 流式 POST）；`./stream.js`（`finishReason` 终帧映射、`readStream` 帧解析、`windowTokens` 解码窗）；`./effort.js`（`DEFAULT_LEVEL`、`MIN_BUDGET`、`budgetFor`、`defaultEffortFor`、`effortsFor`、`resolveLevel`）；`./channel.js`（`createChannel` 把 `onData` 回调变异步迭代源）；`./recovery.js`（`recoveryPolicy`、`canRecover`、`canRecoverSilentStop`、`recoveryMessages`、`continuationMessages`、`checkpointFits`、`addUsage`、`createBlockTracker`）。node 内置：无。
- **被谁依赖**：`index.js`（`new FreeModelAdapter({ state, resolveImage, sealedCredential, recordUsage, recordTurn, warn, onRegionBlocked })` + `ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)`）；`scripts/effort-test.mjs`、`scripts/recovery-test.mjs`、`scripts/retry-safety-test.mjs`、`scripts/truncation-test.mjs`、`scripts/offline-test.mjs`、`scripts/picker-test.mjs`、`scripts/tui-test.mjs`（动态 import 实例化）；`scripts/probes/decode-window.mjs`、`scripts/probes/long-answer.mjs`、`scripts/probes/long-think-truncation.mjs`、`scripts/probes/shell-slot-promotion.mjs`（手工探针）。

## 配置键

本模块不读 `src/config.js` 的 `config.json`（其 `KNOWN_KEYS` = listen/lan/upstream/catalog/probe/effort/egress/ip/data，无一被本模块消费）；键名来自 `index.js` 注入的 `state()` 快照的 `settings` 对象，默认值出自 `store.js` 的 `SETTINGS_INITIAL`。

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `enabled` | `true` | `runStream`（`settings.enabled === false` 即 yield `CONFIG_DISABLED` 后返回） | 总开关，关闭时不发任何请求 |
| `defaultMaxTokens` | `32768` | `resolveModel`（ceiling 与 `effortsFor`）、`runStream`→`budgetFor`、`describe` | 输出上限缺省与思考预算梯 |
| `streamRecovery` | `true` | `runStream`→`recoveryPolicy(settings.streamRecovery)` | 续写开关；`recoveryPolicy` 接受 boolean 或对象 `{ enabled, maxContinuationMs, totalTimeoutMs, checkpointLimit, maxOutputTokens }`，数值封顶 `RECOVERY_DEFAULTS`（1800000 / 1800000 / 131072 / 8192） |
| `membership` / `catalog` / `settings` / `attributionUserAgent`（state() 快照字段） | `attributionUserAgent` 初值 `'deepseek-harness'`（`index.js`，可由 `resolveAttributionUserAgent` 更新） | `listModels`/`resolveModel`/`prepareCall`/`runStream` | 路由成员、模型条目（`vision`/`reasoning`/`contextWindow`/`maxOutput`/`efforts`/`canDisableThinking`）、上述设置、归因 UA（传给 `postStreamed`） |

（`config.json` 层的默认值待 M0 后续接入本模块时再补，键名以上表为准。）

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| finish `{ kind: 'error', failure: { code: 'CONFIG_DISABLED', message: 'our free model is switched off in its settings page' } }` | `settings.enabled === false` | 宿主 finish 事件；不可重试 |
| finish `code: 'SERVER'`，message `our free model does not serve "X" on this egress` | 目录/成员表中无该条目 | 宿主 finish；`SERVER ∈ retryableCodes` |
| `UpstreamError('request aborted', CODE.aborted)` | 迭代期间 `options.signal.aborted` | finish `{ kind: 'aborted' }`；`ABORTED` 不在重试集 |
| `UpstreamError('our free model continuation unexpectedly requested a tool', 'STREAM_CUT')` | 续写段出现 tool-call 块（`tool_choice: none` 不被网关遵守） | finish error，打断续写 |
| `our free model closed the stream after Ns, before its finish token; automatic recovery was not safe` / `...without answering; retrying` / `our free model upstream response ended with status X` / `our free model continuation ended without a complete answer after Ns; automatic recovery exhausted` | 终帧缺失、`failed`/`cancelled` 收尾、续写段异常结束 | finish，`code` ∈ {`STREAM_CUT`, `SERVER`, `TRANSPORT`}；首段可重试、续写段不可 |
| finish `our free model returned an empty response`，`code: 'EMPTY_RESPONSE'` | 无 text/tool/reasoning 且 reason 为 stop | 宿主 finish；`EMPTY_RESPONSE ∈ retryableCodes` |
| `our free model reached its Ns time limit before its finish token[, during the continuation from its checkpoint]` | `recoveryPolicy` 墙钟到点 `controller.abort()` | finish error，`code` = `TIMEOUT`/`STREAM_CUT` |
| `our free model continuation failed: <原消息>` | 续写段抛错且未中止 | finish error |
| `deps.warn('our-free-model: interrupted reasoning; continuing once from its checkpoint')` / `'our-free-model: a stopped turn held only its reasoning; continuing once from its checkpoint'` / `'our-free-model: the answer hit the output token ceiling; continuing once from where it stopped'` | 三类续写各仅一次（纯推理断流 / 静默停收 / `finish=length` 截断，issue #28） | `index.js` → `logger.warn` |
| `deps.warn('our-free-model: dropped unsupported content for <id>: ...')` | `warnings` 非空（丢块告警只由首段 payload 收集） | `logger.warn` |
| `deps.recordUsage({ at, model, effort, ok, input, output, reasoning, cacheRead, decodeTokens, ttftMs, decodeMs, origin: 'harness', recoveryId, attempt, elapsedMs, recoveryAttempt?, noUsage?, warnings? })` | 每 attempt 恰一次（`recorded` 幂等） | `index.js` → `recordUsage(stats, ...)` |
| `deps.recordTurn({ at, model, ok, recovered, attempts, origin: 'harness' })` | 每逻辑回合恰一次（`turnRecorded` 幂等） | `recordTurn(stats, ...)` |
| `deps.onRegionBlocked(entry.id)` | 捕获错误 `error.code === 'REGION_BLOCKED'` | `index.js` → `scheduleReprobe()` |
| `deps.onQuotaHit(entry.id)` | 捕获错误 `error.code === 'RATE_LIMIT'`（#75：配额拒绝是出口的事实而非模型的事实） | start.js → `scheduleOutletRotation()`（M3 装配）→ `refreshOutletExit({avoid})` |

## 网络面

本模块不监听任何端口。出站每个 attempt 一次 `postStreamed`（`http.js`）→ `egressFetch` → 目标 `UPSTREAM_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'`（`src/upstream.js`，import 时固定），路径 `endpointFor(modelId)`：默认 `/zen/v1/chat/completions`，Responses 系 `/zen/v1/responses`，Messages 系 `/zen/v1/messages`，均为 SSE 流式 POST（`postStreamed` 默认 `timeoutMs = 300000`，另受 `recoveryPolicy.totalTimeoutMs` 整轮墙钟约束）。首段 requestId 复用 `recoveryId`，续写段重新 `mintRequestId()`；会话 id 由 `sessionForConversation` 稳定（配额拒绝换会话只会更糟）。触发时机：宿主每次 `stream` 调用、至多 2 次 attempt。可关：`settings.enabled=false` 不发请求；宿主 abort 立即中止上游。若 `settings.egress.enabled`，出口经 `egress.js` 的本机 relay（在 `http.js` 层生效，本模块不感知）。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #102 | **已移植**（2026-10-07 M1，本仓 commit 见 pr-coverage） | `systemPromptUpdateFor(modelId)` + `resolveModel` 两分支展开（`src/adapter.js`）+ `types/dsh-llm.d.ts` 声明 `SystemPromptUpdate`/`LlmResolvedModelInfo`；chat/responses 线声明 `'in-history'`，messages 线不声明；测试 `test/unit/adapter.test.js`（adapter-unit） |
| #41 | **已移植**（2026-10-07 M2，本仓 commit 见 pr-coverage） | `stream` 的 `options.deviceIp` 并入 `postStreamed` 调用（本模块 line ~308）；端到端断言 `scripts/recovery-test.mjs`（deviceIp→网关 `x-forwarded-for`，缺失不带头） |
| #75 | 已移植（M3，port-of #75） | 构造参数补 `onRegionBlocked?`/`onQuotaHit?` 文档；`runStream` catch 在 `onRegionBlocked` 后加 `CODE.quota → onQuotaHit`（换出口钩子，`scripts/retry-safety-test.mjs` quota hook 断言：只有 quota 一击、传输/地区拒绝不触发）；宿主半 `refreshOutletExit` 在 `src/egress.js` |
| #84 | 待移植（M1/M3） | 被拒换同区节点重发且不重复计费（改 `src/adapter.js` + `src/egress.js` + `src/store.js` + `index.js`）；**当前代码未含**（无对应计费/重发路径）；同 AGENT-BRIEF §6 |
| #27 | 源码上游 main 已含；回归用例待补（M1） | tools 二次转换回归：`toToolDefs` 双拼写在 `src/messages.js` 已在位、`index.js` 不再预转换（无 `toToolDefs` import）、`scripts/forward-test.mjs` 已含其 5 项断言；计划中的独立回归用例落 `test/integration/forward-tools.test`（forward 层，但 `toToolDefs` 是本模块 `payloadFor`→`declared` 的出口，`test/` 现仅 `unit/config.test.js`） |

（处置矩阵见 docs/pr-coverage.md；本表只列直接落进本模块的。）

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/retry-safety-test.mjs` | 8 种失败形态（transport / abort 前 / abort 中 / 未服务 / `CONFIG_DISABLED` / 流内 RegionError / 流内 FreeUsageLimitError / 400 拒绝）的 finish kind、`failure.code`、可重试性、region 重探触发、已交付文本判定；`failure` 逐叶子过 `isLosslessJson`（durable log round trip）；`providerRetryPolicy` 形状（首延迟有限、`ABORTED`/`CONFIG_DISABLED` 不在重试集）；`classifyFailure` 4xx→`CLIENT_ERROR` 不重试、5xx/408/425→`SERVER` 可重试；`mapUsage` 裸 usage 与 `cached_tokens` 拆分 |
| `scripts/truncation-test.mjs` | `finishReason` 三映射；参数被截断的工具调用降级 `max-tokens` 且块仍流式交付、计入成功调用；零块正常收尾→`EMPTY_RESPONSE` 且日志可回写；无终帧→error 而非 stop、已交付内容不重发、消息含耗时；RESPONSES/MESSAGES 终帧判定（`response.completed`/`message_stop`）；`finish=length` 自动续写一次（两次请求、正常 stop 收尾、续写正文拼接）、被截工具调用不续写、`streamRecovery=false` 时保持 `max-tokens` |
| `scripts/recovery-test.mjs` | 纯推理 EOF 的有界续写回归：真实 `FreeModelAdapter` + 本地 HTTP 服务，实际请求体与流输出断言 |
| `scripts/effort-test.mjs` | 思考预算阶梯真实发出且记录档位=发出档位（issue #2）；实例化 `FreeModelAdapter` 走完整链路 |
| `scripts/offline-test.mjs` | 网关不可达时冷启动、备用名单、回合以干净上游错误收场（取用 `ROUTE_MAIN`） |
| `scripts/picker-test.mjs` | 择模型可见面：`listModels`、模型发现回调、设置摘要（取用 `ROUTE_MAIN`/`ROUTE_REGION`，对应 #3 分组） |
| `scripts/tui-test.mjs` | 无 web server 的 composition 下插件可激活、免密车道可用（取用 `ROUTE_MAIN`） |
| `scripts/test-all.mjs` | 一键编排全部离线套件（effort/truncation/recovery/retry-safety/picker/tui/offline/forward 等） |
| `scripts/probes/*.mjs` | `decode-window`、`long-answer`、`long-think-truncation`、`shell-slot-promotion` 直接实例化 `FreeModelAdapter` 的实测探针 |

## 已知边界

- attempt 循环硬编码 `attempt < 2`：首段 + 至多一次续写，续写段再截断即如实报 `max-tokens`/错误，不无限续。
- `retryableCodes` 有意不含 `REGION_BLOCKED`（出口属性，非瞬时故障）、`RATE_LIMIT`（该 429 带增长 retry-after，自动重试让同一回合付三次费，issue #13）、`ABORTED`、`CONFIG_DISABLED`、`CLIENT_ERROR`。
- `imageRequestPricing` 恒 `undefined`：免费出口无按图报价，缺此方法会令 `ctx.llm.imageRequestPricing()` 抛错（issue #42）。
- 不读 `config.json`；所有设置来自注入的 `state()` 快照。构造接收 `sealedCredential` 但模块内从未读取（`index.js` 注入的冗余项）。
- 目录无条目时 `resolveModel` 不抛错，以 `contextWindow: 131072`、`defaultMaxTokens: 8192` 兜底返回；`runStream` 再按 membership 判定拒绝。
- 未移植 #75（配额不换出口）、#84（被拒不换同区节点重发）；现状即上游 fbc3b9b 行为。#102 已于 2026-10-07 移植（见关联 PR 表）。
- 系统提示词: #102 落位后 `resolveModel` 按线形声明 `systemPromptUpdate`；chat wire 的提示词仍经 `options.system` 拼进 payload，历史内注提示词的消费由宿主按该字段决定。
- 续写只在首段触发，且与 `checkpointFits` 预算检查绑定：`continuationBudget < MIN_BUDGET(512)` 或检查点放不下时放弃续写、按原错误上报。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 2026-10-07 M1 移植 #102（`systemPromptUpdateFor` 两分支 + d.ts 声明）；红→绿 `test/unit/adapter.test.js` 4 断言；本文件同步。
- 2026-10-07 M2 移植 #41：`options.deviceIp` → `postStreamed`；recovery-test 端到端一断言红→绿。
- 2026-10-08 M3 移植 #75：`runStream` catch 加 `CODE.quota → onQuotaHit`，构造 JSDoc 补两回调；`scripts/retry-safety-test.mjs` quota hook 红→绿。
