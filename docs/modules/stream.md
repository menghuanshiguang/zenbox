# stream.js — 三种上游 SSE 载荷到 harness StreamChunk 的同步投影与用量核算

## 职责边界

把 `src/http.js` 切出的 `data:` 载荷字符串流（AsyncIterable）投影成 harness 的扁平块协议：`block-start` → `text-delta`/`reasoning-delta`/`tool-call-delta` → `block-end`，并给出 finish 原因映射、用量的不相交核算与测速分子。它只消费已解析的 JSON 载荷，不做字节读取与 SSE 分帧（`src/http.js` 的 `readSse`），不做消息出站投影（`src/messages.js`），不发请求。三种线形（`chat`/`messages`/`responses`）的帧语义各有一个 feed 函数，输出统一为 harness `StreamChunk`。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `mapUsage` | function | `mapUsage(usage) → TokenUsage \| undefined` | 把 OpenAI/Anthropic 两种 usage 字段名归一：`inputTokens = prompt − cached`（cached 缺省按 0 先补再减，避免 NaN），`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` 仅在 >0 时写入，`totalTokens = prompt + completion`；输入两侧皆非数返回 `undefined`。 |
| `finishReason` | function | `finishReason(token) → { kind }` | `tool_calls`/`tool_use`/`function_call` → `tool-calls`；`length`/`max_tokens`/`max_output_tokens`/`incomplete` → `max-tokens`；其余（含 `undefined`）→ `stop`。 |
| `windowTokens` | function | `windowTokens(usage, sawReasoning) → number` | 测速窗口的诚实分子：没观测到推理帧时从 `outputTokens` 里扣掉 `reasoningTokens`（未流出的推理不计入时窗），见到推理帧则全额保留；无 usage 为 0。 |
| `readStream` | async generator | `readStream(lines, wire, renameMap, now = () => Date.now(), options = {}) → AsyncGenerator<StreamChunk>` | 主读取器。`lines` 为解码后的 `data:` 载荷流；`wire ∈ 'chat'|'messages'|'responses'`；`renameMap` 为指纹改名映射（`restoreToolName` 用）；`now` 打首个 delta 的时间戳；`options.startIndex`（默认 0）给续写分配块索引，`options.checkpointLimit`（默认 131072）限推理/答案检查点，`options.onState` 每处理一帧发布一次状态快照。返回 `{ usage, finish?, sawFinish, sawUsage, sawToolCall, sawReasoning, firstDeltaAt?, nextIndex, reasoningText, checkpointTruncated }`（快照另含 `sawText`、`brokenToolCall`、`answerText`、`nextIndex`）。 |

模块内部（不导出）：`BlockSink`（`toolKey`/`slot`/`text`/`reasoning`/`toolStart`/`toolArgs`/`closeAll`）、`createDsmlScrubber`（`DSML_OPENING`/`DSML_TAG`）、`mintToolCallId`、`REASONING_FIELDS`、`reasoningOf`、`feedChat`、`feedClaude`、`feedResponses`、`carriesDelta`、`number`。

关键内部语义（写入本表以免误读）：

- 块索引按到达顺序分配；Chat 工具增量的槽键优先取 `tool_calls[].index`，无 index 时用 call id，两者皆缺回退到上一槽（`lastToolKey`，再缺则 `c0`），避免并行调用互相覆盖。
- 工具调用缺提供方 id 时铸稳定替身 `call_<24hex>`（provider 后到的 id 覆盖它）；`closeAll` 时参数 `JSON.parse` 失败或工具名为空串 → `brokenToolCall=true`，adapter 据此把该回合降级为 `max-tokens`（否则不可执行调用会被执行/被配对修复永久保留，issue #92 口径）。
- 流内出现 `payload.type === 'error'` 或 `payload.error` → 用 `classifyFailure(undefined, payload)` 分类后抛出（与错误信封同表，`REGION_BLOCKED`/`RATE_LIMIT` 才能被 adapter 识别），message 缺失时补 `'upstream error'`，错误对象附 `upstream` 原帧。
- 终帧语义：chat 认 `choice.finish_reason`；messages 认 `message_stop`（无 token 的终帧只置 `sawFinish`，不覆盖已有 finish）与 `message_delta.stop_reason`；responses 认 `completed/incomplete/failed/done` 四种终态，`incomplete_details.reason === 'max_output_tokens'` 映射为 `length`。
- 推理文本只取第一个非空拼写（`reasoning`/`reasoning_content`/`reasoning_text`/`thinking`，issue #66），`reasoning_details` 数组按 `.text` 拼接兜底；同帧双拼写不会重复计块。
- `<｜DSML｜…>` 控制标记随文本清洗：尾部可能补全成开场的片段挂起到下一 delta，`flush` 时溢出或丢弃（用户逐字引用该 token 会丢字，代码注释明示是刻意取舍）。
- 检查点：`reasoningText` 截到 `checkpointLimit` 即置 `checkpointTruncated`；`answerText` 同限（供 max-tokens 续写，不多于一个上限的缓冲）；delta 本身不截断，全量下发。
- usage 合并：`message_delta` 只带 `outputTokens` 时与既有载荷合并（重算 `totalTokens`），不吞掉 `message_start` 已给的 prompt 计数。

## 依赖关系

- **import 进来**: `./http.js`（`classifyFailure`——流内错误帧与错误信封同分类）、`./upstream.js`（`restoreToolName`——把指纹改名的工具名还原给调用方）、`node:crypto`（`mintToolCallId` 的随机 id）。
- **被谁依赖**: `index.js`（`windowTokens`）、`src/adapter.js`（`finishReason`/`readStream`/`windowTokens`）、`scripts/truncation-test.mjs`（`finishReason`，主覆盖 `readStream`）、`scripts/retry-safety-test.mjs`（`mapUsage`）、`scripts/forward-test.mjs`（`readStream`）、`scripts/effort-test.mjs`（`readStream`）、`scripts/speed-stat-test.mjs`（`windowTokens`）。

## 配置键

无（参数注入）：`startIndex`、`checkpointLimit`（默认 131072）、`now` 时钟与 `onState` 回调全部由 `src/adapter.js` 按次传入；本模块不读 `process.env`、不读 settings。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| `throw classifyFailure(undefined, payload)`（`UpstreamError`，附 `upstream` 原帧） | 流内帧携带 `type:'error'` 或 `error` 字段（如 200 头之后的 `RegionError`/`FreeUsageLimitError`） | `src/adapter.js` 捕获，按 `code` 决策：`REGION_BLOCKED` 触发区域重探、`RATE_LIMIT` 直接上抛不重试（issue #13）、`TRANSPORT` 进可重试集 |
| 快照 `brokenToolCall: true` | `closeAll` 中工具参数 JSON 解析失败，或工具名为空串（issue #92） | adapter 把该回合 finish 由 `tool-calls` 降级为 `max-tokens`，harness 裁掉调用而不是执行 |
| 快照 `checkpointTruncated: true` | 推理文本超出 `checkpointLimit` | adapter 续写/恢复路径读取，本模块不抛错 |
| （无 console 输出） | — | 所有错误以异常抛给 `readStream` 调用方；`onState` 只发布状态 |

## 网络面

无网络面：纯解析器，不建立任何连接；它消费的是 `src/http.js` 已经收到的 `data:` 载荷。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #46 | 已合入上游 main | 流式 tool delta：`BlockSink.toolArgs` 随参数增量发射 `tool-call-delta`、`toolStart` 补 `id`/`name`；当前代码已含。 |
| #25 | 已合入上游 main | 思考兼容：`REASONING_FIELDS` 四拼写 + `reasoning_details`（issue #66）；静默心跳：SSE 注释心跳行由共享读取路径（`src/http.js` 的 `emit` 跳过 `:` 开头行、`sniffBody` 把 `: ping` 识别为 sse）消化，本模块只见 `data:` 载荷、心跳不产 chunk。当前代码已含。 |

（处置矩阵见 docs/pr-coverage.md；本表只列直接落进本模块的。）

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/truncation-test.mjs` | 截断的工具参数降级 `max-tokens`（帧里仍回传供装配器裁剪）、缺 id 铸造且 delta 同步、空 stop → `EMPTY_RESPONSE`、`finishReason` 三映射、三条线形的终帧判定（无终帧 → `STREAM_CUT` 不可重试、`message_stop` 是真结尾、`response.incomplete` → `max-tokens`、裸 `response.done` 是结尾非截断、`message_stop` 不覆盖其前的 `stop_reason`）、长度截断自动续写恰发两次请求。 |
| `scripts/retry-safety-test.mjs` | `mapUsage`：无 details 块保持有限值（`inputTokens=11/total=18`，durable log 可写）、cache 命中走不相交计数（`inputTokens=8/cacheRead=12/total=25`）；流内 region/quota/abort 形态经 `readStream` 抛出的分类端到端。 |
| `scripts/forward-test.mjs` | `readStream('chat')` 直驱：`reasoning_content` 拼写到达 harness（`sawReasoning`/`reasoningText`）、文本与工具块的 chunk 形态。 |
| `scripts/speed-stat-test.mjs` | `windowTokens` 四形态：未流出的推理被扣掉（422−291=131）、见到推理全额（135）、无 reasoning 字段（50）、无 usage（0）。 |
| `scripts/effort-test.mjs` | 以 `readStream` 消费 chat 帧驱动 effort/预算相关读取路径。 |

## 已知边界

- 块索引按到达顺序分配：对"先推理后文本"的提供方顺序恰好一致，但乱序/交错块的提供方会得到按到达序重排的索引（文档头注释明示该前提）。
- 无 usage 帧的回合 `sawUsage=false`、`usage` 落快照兜底零值；缺 usage 本身不是错误（`truncation-test` 以 `noUsage` 记录）。
- `wire` 参数只接受 `'chat'|'messages'|'responses'`，未识别的值会落进 `feedResponses` 分支；由调用方（adapter 的 `wireFor`）保证。
- `finishReason` 是兜底映射：`failed`/`cancelled` 也落成 `stop`，正常收尾判定由 adapter 显式查原 token（`src/adapter.js` 注释）。
- DSML 清洗会连带吃掉用户逐字引用的标记字符；`checkpointLimit` 截断只影响检查点与续写，不影响已下发的 delta。
- `firstDeltaAt` 只在首个携带实际增量的帧打点（`carriesDelta` 覆盖 content/推理/工具三种增量），计时起点不是连接建立时刻。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
