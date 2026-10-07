# http.js — 出站请求与 SSE 读取：体态嗅探、头窗重放、网关失败到中立错误码的分类

## 职责边界

免密车道唯一的真实出口层：`postStreamed`/`getJson` 经 `src/egress.js` 的 `egressFetch` 打到 `UPSTREAM_BASE`，先读 4096 字节的体窗嗅探体态（`Content-Type` 完全不信，issue #6），再把已读字节重放进 `readSse` 分帧；`classifyFailure`/`classifyStreamFailure`/`transportCause` 把网关 JSON 错误信封、HTML 错误页、传输故障统一成 harness 中立的 `CODE`/`UpstreamError`。它不做消息转换（`src/messages.js`）、不做块投影（`src/stream.js`），也不决定重试策略——`src/adapter.js` 的 `providerRetryPolicy` 读它的 `code` 做决策。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `CODE` | const | `{ region:'REGION_BLOCKED', quota:'RATE_LIMIT', credential:'INVALID_CREDENTIAL', authorization:'AUTHORIZATION_REQUIRED', transport:'TRANSPORT', timeout:'TIMEOUT', server:'SERVER', client:'CLIENT_ERROR', empty:'EMPTY_RESPONSE', aborted:'ABORTED' }` | harness 中立错误码词表（`packages/llm/llm/src/error.ts` 词汇），重试决策与设置页文案都按它分流。 |
| `UpstreamError` | class | `new UpstreamError(message, code, details = {})` | `name='UpstreamError'`，`code` 为主判据，`details`（`status`/`type`/`providerRetryAfterMs`/`signatureRejected`/`unavailable`/`reason` 等）就地挂载。 |
| `transportCause` | function | `transportCause(error) → string` | 沿 `cause` 链最多走 3 层，把 `ENOTFOUND`/`ECONNRESET` 等码与首行去重拼接为 `' — fact; fact'`，让 "fetch failed" 可读（issue #79）。 |
| `classifyFailure` | function | `classifyFailure(status, payload, retryAfterMs) → UpstreamError` | 错误信封分类器，判定次序：`RegionError`/region 文案 → `REGION_BLOCKED`；`429`/`FreeUsageLimitError`/usage limit 文案 → `RATE_LIMIT`（带 `providerRetryAfterMs`）；`401|403` + signature rejected/mismatch → `TRANSPORT`（`signatureRejected:true`，本地代理改写请求体的口径，issue #50）；`AuthorizationRequired` 或 `需要 GitHub 授权/GitHub 授权无效` → `AUTHORIZATION_REQUIRED`；`401|403` → `INVALID_CREDENTIAL`（HTML 页降为 `CLIENT_ERROR`）；`ModelError`/model unavailable 文案 → `SERVER`（`unavailable:true`）；其余 `400–499`（`408`/`425` 除外）→ `CLIENT_ERROR`；兜底 → `SERVER`。HTML 原文改写为一行 WAF/体长提示（issue #63）。 |
| `sniffBody` | function | `sniffBody(text) → 'sse' \| 'json' \| 'empty' \| 'unknown'` | 按体的形状分类：剥 BOM/前导空白后，`:` 注释或 `data|event|id|retry:` 行 → `sse`；`{`/`[` → `json`；空 → `empty`；其余 → `unknown`。 |
| `readHead` | async function | `readHead(stream, limit, { signal, timeoutMs }) → { reader, chunks, done, text, decoder }` | 在 `limit`（`SNIFF_BYTES=4096`）内读体开头；一旦嗅探为 `sse` 立即停（短答案不被拖到 deadline），全程一个 `TextDecoder`（多字节不切断），出错先 `cancel` 再抛 `classifyStreamFailure`。 |
| `classifyStreamFailure` | function | `classifyStreamFailure(error, signal) → UpstreamError` | 把体读取的任何抛出归一：已是 `UpstreamError` 原样返回；`signal.aborted`/`AbortError` → `ABORTED`（避免 abort 的数字 legacy code `20` 被误判成可重试的 `TRANSPORT`）；其余 → `TRANSPORT` 并附 `transportCause`。 |
| `replayStream` | function | `replayStream(head) → AsyncIterable<Uint8Array> & { cancel() }` | 把已读的头块 + 后续 reader 重新拼成一条字节流（已读字节被重放，不丢失、不再缓冲），并暴露直连 `cancel()`（async generator 的 `return()` 会排在 pending `next()` 之后）。 |
| `postStreamed` | async function | `postStreamed({ path, body, session, requestId, attributionUserAgent, signal, onData, timeoutMs = 300000 }) → { status, headers }` | POST 一条流式请求：拼指纹头（`userAgentWith` 合并 attribution 与 `CLIENT_UA`），`redirect:'error'`；非 2xx 读体转 `classifyFailure`（带 `Retry-After` 毫秒数）；2xx 走体窗 → `sse` 则 `readSse(replayStream(head))`，`json` 则单载荷交 `onData`，`unknown` 的 HTML → `CLIENT_ERROR`，其余 → `SERVER`。 |
| `readSse` | async function | `readSse(source, onData, signal, timeoutMs = 300000) → Promise` | 把字节流（`ReadableStream` 或 async iterable）按行切成 `data:` 载荷：丢空行、`:` 注释、`[DONE]`；每个 chunk 重置空闲 deadline（超时 → `TIMEOUT: upstream stream idle past its deadline`）；与 abort 信号赛跑（`ABORTED`），finally 关流并 `releaseLock`。 |
| `getJson` | async function | `getJson(path, { session, requestId, attributionUserAgent, signal, timeoutMs = 15000 }) → payload` | 带指纹头的小 JSON GET（`accept: application/json`），自建 `AbortController` 区分"本调用超时 → `TIMEOUT`"与"调用方取消 → `ABORTED`"，非 2xx 走 `classifyFailure`。 |

模块内部（不导出）：`retryAfter`（只认数字秒）、`SNIFF_BYTES = 4096`、`userAgentWith`（attribution 已含 `opencode/` 则原样，否则 `${attribution} ${CLIENT_UA}`）、`deadlineFor`、`headRead`（头窗内的单次读，带 deadline 与 abort 监听）、`readRemainder`（非流体读完，续用同一个 decoder）、`emit`（行 → `onData` 过滤器）。

## 依赖关系

- **import 进来**: `./upstream.js`（`CLIENT_UA`、`UPSTREAM_BASE`、`gatewayHeaders`、`truncateSession`）、`./egress.js`（`egressFetch`——实际出网通道，可能经本机出口中继）。
- **被谁依赖**: `index.js`（`CODE`/`UpstreamError`/`getJson`，用于 `/zen/v1/models` 目录拉取）、`src/adapter.js`（`CODE`/`UpstreamError`/`postStreamed`——主对话路径）、`src/probe.js`（`CODE`/`postStreamed`——可用性探测）、`src/stream.js`（`classifyFailure`——流内错误帧）、`scripts/sniff-test.mjs`（`CODE`/`postStreamed`/`readSse`/`sniffBody`）、`scripts/retry-safety-test.mjs`（`CODE`/`classifyFailure`）、`scripts/probes/dangling-tool-call.mjs`（`postStreamed`/`UpstreamError`）。

## 配置键

无（参数注入）：上游基址唯一来源是 `src/upstream.js` 的 `OUR_FREE_MODEL_BASE`/`UPSTREAM_BASE`（本模块只读常量），`timeoutMs`（`postStreamed`/`readSse` 默认 300000、`getJson` 默认 15000）、`signal`、`onData` 全部由调用方传入；本模块不读 `process.env`、不读 settings。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| `UpstreamError(..., 'REGION_BLOCKED')` | 信封 `type==='RegionError'` 或文案含 region / not available in your country | adapter 触发区域重探（`onRegionBlocked`），不进重试集 |
| `UpstreamError(..., 'RATE_LIMIT')` | HTTP 429 / `FreeUsageLimitError` / usage limit 文案 | 直接上抛 harness，不自动重试（issue #13），带 `providerRetryAfterMs` |
| `UpstreamError(..., 'INVALID_CREDENTIAL')` | 401/403 且非 HTML 页、非签名拒绝、非授权门 | 设置页处理；不误清凭据缓存 |
| `UpstreamError(..., 'AUTHORIZATION_REQUIRED')` | 信封 `type==='AuthorizationRequired'` 或 `需要 GitHub 授权/GitHub 授权无效` | 设置页回以登录提示，不触发重装 |
| `UpstreamError(..., 'TRANSPORT')` | `egressFetch` 抛出（附 `transportCause` 事实）、体读取失败、401/403 签名被拒（`signatureRejected:true`） | 可重试集；issue #79/#50 |
| `UpstreamError(..., 'TIMEOUT')` | 头窗 deadline 内无字节（`upstream sent no bytes before its deadline`）、`readSse` 空闲过期（`upstream stream idle past its deadline`）、`getJson` 自身超时 | 可重试集 |
| `UpstreamError(..., 'SERVER')` | 5xx、408/425、`ModelError`/model unavailable、2xx 的 `unknown` 体态非 HTML、JSON 解析失败的体 | 可重试集 |
| `UpstreamError(..., 'CLIENT_ERROR')` | 其余 400–499、200/401/403 的 HTML 错误页（`the gateway's front proxy answered HTTP … with an HTML error page…`） | 不可重试：同体重发必同拒（issue #63） |
| `UpstreamError(..., 'EMPTY_RESPONSE')` | `response.body===null`、嗅探结果 `empty`（`upstream returned no body`） | harness 按 `EMPTY_RESPONSE` 语义处理 |
| `UpstreamError(..., 'ABORTED')` | `signal.aborted`、`AbortError`、`headRead`/`readSse` 的 abort 监听触发 | 永不重试（用户主动取消） |

## 网络面

- `postStreamed`：对 `${UPSTREAM_BASE}${path}` 的 **POST**（默认 `https://opencode.ai/zen/v1/*`；测试注入 `http://127.0.0.1:<port>` 替身），`redirect:'error'`，请求头含 `authorization: Bearer public`、`user-agent`（attribution 合并 `opencode/1.18.31`）、`x-opencode-session/request/client/project`；响应按体态读成 SSE 流或单 JSON。触发时机：adapter 每个回合（含重试、续写）、probe 每次探测。可关：`signal` 中止即关，`readHead`/`readSse` 的 `finally` 会 `cancel` 连接。
- `getJson`：同基址的 **GET**（`/zen/v1/models`），默认 15s 超时；触发时机：目录拉取（`index.js`）。
- 两者都经 `src/egress.js` 的 `egressFetch` 实际出网（可走本机 `127.0.0.1` 出口中继/代理，出口策略在 egress 模块）。
- `readHead`/`readSse`/`replayStream` 不新建连接，只消费上述响应的字节。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| 无直接 PR | 不适用 | 处置矩阵见 docs/pr-coverage.md。其导出的 `postStreamed` 被 `src/adapter.js`、`src/probe.js` 调用（`index.js` 经同一批头的 `getJson` 拉目录），`readSse` 由 `postStreamed` 串联 `replayStream` 后调用并被 `scripts/sniff-test.mjs` 直接驱动；`src/egress.js` 在 `egress.js` 头注释中点名 `postStreamed`/`getJson` 这条依赖方向，并以 `egressFetch` 作为它们的出网通道。 |

（处置矩阵见 docs/pr-coverage.md；本表只列直接落进本模块的。）

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/sniff-test.mjs` | 体态决定读法：200 + 错误 content-type 仍流式、正确 content-type 行为一致、跨块/跨多字节帧完整、超 4K 嗅探窗仍全量到达、窗边界落在多字节字符中仍解析、HTML@200 → `CLIENT_ERROR`（带一行可读消息与 status）、空体 → `EMPTY_RESPONSE`、体不开始 → `TIMEOUT`、挂起连接下的完整短答案不被误判超时、head 前/后 abort → `ABORTED`（含 pending read 的最终结算）、`sniffBody` 八种输入、探测五态（available/unknown/unavailable）。 |
| `scripts/retry-safety-test.mjs` | `classifyFailure`：400/404/422 → `CLIENT_ERROR` 且不在 `retryableCodes`、500/408/425 → `SERVER` 可重试；`CODE.aborted`/`CONFIG_DISABLED` 不在可重试集；九种失败形态端到端产出的 failure 是 durable-log 安全的无 `undefined` 字段 JSON。 |
| `scripts/offline-test.mjs` | 死网关（连接即拒）下插件激活不崩、回合以干净 upstream error 收尾（transport 文案含 ECONNREFUSED/failed）、转发请求回 502 且带 error 体。 |
| `scripts/recovery-test.mjs` | 经 `postStreamed` 的三线流恢复/续写路径；`readSse` 的 300s 空闲截止（每 chunk 重置）被 `src/recovery.js` 注释引为"慢而有帧"与"真静默"的分界口径。 |

## 已知边界

- `Content-Type` 不参与判定，只看体（issue #6）；`unknown` 体态里只有 HTML 走 `CLIENT_ERROR`，其余散文落 `SERVER`（可重试）。
- `classifyFailure` 的 4xx 分支要求 `status` 在 400–499；无 status 的调用（流内信封经 `src/stream.js` 传 `undefined`）在未命中类型关键字时落兜底 `SERVER`——region/quota 靠 `type`/文案先行命中才得到正确码。
- `Retry-After` 只认数字秒，HTTP-date 形式返回 `undefined`（`providerRetryAfterMs` 缺省）。
- `redirect:'error'`：任何重定向都当作传输失败处理，不跟随。
- `transportCause` 最多 3 层 `cause`、事实去重；更深的嵌套原因不再下钻。
- 头窗与流共用同一个 `timeoutMs` 语义但分层计时：`headRead` 有绝对 deadline，`readSse` 每个 chunk 重置空闲窗口；`getJson` 用独立 `AbortController` 与 15s 上限。
- 2xx JSON 体只交一帧 `onData(JSON.stringify(payload))`，不做分页/多载荷拆分；错误信封（`payload.error`）在 2xx 上同样转 `classifyFailure`。
- 本模块不决定重试：同一个 `code` 在 adapter 的 `retryableCodes` 里才可重试，`ABORTED` 被刻意排除（`retry-safety-test` 有专项守护）。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
