# forward.js — OpenAI 兼容转发监听器与 LAN 中继：本机回环接收外部 harness 请求，鉴权转译后以调用方拼写流式回传

## 职责边界

提供两个 HTTP 服务面：其一，**本机回环 OpenAI 兼容转发监听器**（`startForwardServer`）——给局域网内其他 harness 提供 baseURL（Chat Completions / Responses / Models 列表），做 bearer 与 `x-api-key` 双拼写鉴权、CORS 预检、8MB 请求体上限、SSE 心跳与请求诊断，并在转发出口做 wire hygiene（#20：`tool_calls[].index` 按请求从 0 重编号、调用方未声明的指纹工具调用 decoy 抑制）；其二，**LAN 中继**（`startLanRelay`）——局域网入口按白名单路径接收跨机请求，换成本机转发键转发给回环监听器（hop 头、508 拒自打转）。另附带密钥生成与恒时比较（`generateKey`/`keyMatches`）、端口冲突分类与顺延绑定（`classifyBindError`/`bindForwardPort`）、OpenAI usage 归一（`toOpenAiUsage`）。不拼 provider 请求体（`complete` 由 `index.js` 注入，最终走 `adapter.js`）、不解析模型目录（`modelRows` 回调注入）、不管理设置（`index.js`/`store.js`）、除回环外无任何出站。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `generateKey` | function | `generateKey() → string` | `'ofm-' + randomBytes(24).base64url`，本地键与 LAN 键的唯一生成器 |
| `keyMatches` | function | `keyMatches(presented, expected) → boolean` | `crypto.timingSafeEqual` 恒时比较（长度不等先拒绝） |
| `resolveLoopbackBind` | async function | `resolveLoopbackBind(host) → Promise<string>` | 未给出回落 `'127.0.0.1'`；主机名须全部解析为回环地址，否则抛错拒绝绑定 |
| `classifyBindError` | function | `classifyBindError(error) → { kind: 'held'\|'in-use'\|'unavailable'\|'unknown', code, retryable, hint }` | `EACCES`/`EPERM`→`held`（hint 指 Windows portproxy/管理员占用）；`EADDRINUSE`→`in-use`；`EADDRNOTAVAIL`→`unavailable` |
| `bindForwardPort` | async function | `bindForwardPort(server, { address, port, attempts = 4, backoffMs = 150, scan = 10, log }) → { port, requested, fellBack, bindError }` | 同端口重试 4 次（150ms×2^n 退避）→ 顺延至多 10 个端口（≤65535）→ 临时端口兜底；每次失败经 `classifyBindError` 记日志 |
| `startForwardServer` | async function | `startForwardServer({ config, complete, modelRows, log, onTrace, heartbeatMs }) → { server, port, requestedPort, fellBack, bindError, host, close }` | 回环监听器主入口；`heartbeatMs` 默认 `SSE_HEARTBEAT_MS` |
| `rankLanAddresses` | function | `rankLanAddresses(interfaces) → string[]` | #76：`os.networkInterfaces()` 形参每次现读不缓存；过滤 IPv4/非回环/非 APIPA（`169.254.`）/去重后，按网卡名 `VIRTUAL_IFACE` 正则（vEthernet/WSL/Hyper-V/Docker/VMware/tailscale/utun/隧道/虚拟…）分物理/虚拟两组，`sort(Number(virtual)差)` 稳定排序——物理网卡领头（banner 复制行），组内保持 OS 原序；无可用地址回 `[]` |
| `startLanRelay` | async function | `startLanRelay({ config, log, onTrace }) → { server, port, host, close }` | 中继入口；返回实际绑定端口/主机供设置页回写 |
| `SSE_HEARTBEAT_MS` | const | `SSE_HEARTBEAT_MS = 15000` | SSE 心跳间隔（15s 注释帧，代理不掉线） |
| `startHeartbeat` | function | `startHeartbeat(res, intervalMs) → stop` | 定时写 `: ping\n\n`，timer `unref()`，`stop()` 幂等清理 |
| `toOpenAiUsage` | function | `toOpenAiUsage(usage) → { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens }, completion_tokens_details: { reasoning_tokens } }` | 上游 usage → OpenAI 拼写（零值桶省略） |

模块私有：`traceRequest`（`performance.now()` 起止与帧阶段诊断）、`bearerOf`、`httpError`、`readBody`（`MAX_BODY_BYTES = 8 * 1024 * 1024`）、`json`、`openAiError`、`isLoopbackIp`、`bareAddress`（`::ffff:` 剥壳）、`proxyHeaderV1`（socket → PROXY v1 行，`socket.ofmDevice` 认领源优先、家族不配对回 `UNKNOWN` 但认领设备保持家族回退本回环）、`parseProxyV1`（6 段/端口/isIP 校验，畸形回 `null`）、`sniffProxyHeader`（首字节嗅探 + `unshift` 回灌 + 2s 握手超时，`socket.ofmDevice` 落值）、`bindFailure`、`listenOnce`、`serveCompletion`、`authorized`、`corsHeaders`、`sendSse`、`openStreamHeaders`、`createToolWire`、`chatCompletions`、`executableCalls`、`responsesEndpoint`、`VIRTUAL_IFACE`（#76 网卡名虚拟正则）。常量：`REQUEST_ID_HEADER = 'x-ofm-request-id'`（16 字节 hex 诊断头）、`COMPLETION_PATHS`、`RELAY_PATHS`、`RELAY_HOP_HEADER = 'x-ofm-relay-hop'`、`PROXY_V1_MAX_BYTES = 108`、`PROXY_V1_PROBE_TIMEOUT_MS = 2000`。

路由（本地 handle）：`OPTIONS`→204+CORS；`/`、`/health` 免 key 200 `{ok:true, service:'our-free-model'}`；缺 key/错 key→401 `missing or invalid API key`；`GET /v1/models`、`/models`→`modelRows()`；`POST /v1/chat/completions`、`/chat/completions`→`chatCompletions`；`POST /v1/responses`、`/responses`→`responsesEndpoint`；其余→404 `` no route for ${req.method} ${path} ``。中继：每请求校验 `lanKey`（`/health` 也校验，仅 `OPTIONS` 免）、仅放行 `RELAY_PATHS` 同六条、改写为 `Bearer ${settings.localKey}` 并加 `x-ofm-relay-hop: 1`。

## 依赖关系

- **import 进来**：`node:http`（两个监听器与 `http.request` 出站）、`node:net`、`node:dns`（`resolveLoopbackBind` 的主机名解析）、`node:crypto`（`randomBytes`/`timingSafeEqual`）、`node:perf_hooks`（`performance.now()` 诊断计时）、`./upstream.js` 的 `baseModelId`（`chatCompletions`/`responsesEndpoint` 各取一次 `baseModelId(String(body.model ?? ''))` 作为规范化模型名并判空）与 `FINGERPRINT_TOOLS`（`createToolWire` 的 `executable`：`!(FINGERPRINT_TOOLS.includes(name) && !declared.has(name))`，即调用方 `body.tools` 未声明的指纹四件套按 decoy 丢弃）。无其他模块依赖。
- **被谁依赖**：`index.js`（`import { generateKey, startForwardServer, startLanRelay, toOpenAiUsage }`；`startForwardServer` 在转发同步流程调用，`forwardKey()`/`relayKey()` 首次使用时 `generateKey()` 铸造，`startLanRelay` 在中继同步流程调用，`toOpenAiUsage` 归一完成帧 usage）；`scripts/forward-test.mjs`（直接 `import` 全部导出做 56 项断言）。

## 配置键

本模块的 `config()` 由 `index.js` 读 `settings.get().forward` 后注入，不直接读 `config.json`；默认值出自 `store.js` 的 `SETTINGS_INITIAL`。

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `forward.enabled` | `false` | `startForwardServer` 的 `config().enabled` | 关闭时 `/`、`/health` 也回 503 `the forward listener is switched off in Our Free Model settings` |
| `forward.host` | `'127.0.0.1'` | `resolveLoopbackBind(config().host)` | 监听主机；只接受解析后全回环的地址 |
| `forward.port` | `18899`（`config()` 缺省 `?? 0` 即临时端口） | `bindForwardPort` | 请求端口，被占则顺延；实际绑定值回写 settings |
| `forwardKey` | 首次使用时 `generateKey()` 铸造并持久化 | `forwardKey()` → `config().key` | 本地鉴权键（`Bearer`/`x-api-key` 双拼写） |
| `forward.lan.enabled` | `false` | `startLanRelay` 的 `config().enabled` | 中继开关；关闭回 503 `the LAN relay is switched off in Our Free Model settings` |
| `forward.lan.host` | 缺省回落 `'0.0.0.0'`（`SETTINGS_INITIAL.lan` 无 `host` 字段） | `startLanRelay` 绑定 | 中继绑定地址（对外监听） |
| `forward.lan.port` | `0`（OS 自动分配） | `startLanRelay` 绑定 | 中继端口；实际值回写 settings |
| `forwardLanKey` | 首次 `generateKey()` 铸造 | `relayKey()` → 每请求 `lanKey` | 中继独立键（与本地键分离） |
| `targetPort`（派生） | `forward?.port ?? 0` | 中继出站 `http.request` | 本机转发实际端口；`≤0` 时 503 `the local forward listener is not running` |
| `localKey`（派生） | `forwardKey()` | 中继改写请求头 | 出站给回环监听器的键 |

（`src/config.js` 的 `DEFAULTS`——`listen: {host:'127.0.0.1', port:18899}`、`lan: {enabled:false, host:'0.0.0.0', port:18899, separateKey:false}`，`KNOWN_KEYS` = listen/lan/upstream/catalog/probe/effort/egress/ip/data——是 `config.json` 规格，尚未被本模块消费；键名以上表注入键为准，config.json 层默认值待接入后补。）

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| 503 `the forward listener is switched off in Our Free Model settings` / `the LAN relay is switched off in Our Free Model settings` | `config().enabled` 为 false | 回调用方 |
| 503 `the local forward listener is not running` | 中继 `targetPort ≤ 0` | 回调用方 |
| 401 `missing or invalid API key` / `missing or invalid LAN key` | 本地键或中继键校验失败 | 回调用方 |
| 508 `the LAN relay would be dialing itself — give it a port of its own` | 中继目标端口等于自身端口（防自打转） | 回调用方 |
| 413 `request body too large` | 超 `MAX_BODY_BYTES`（8MB） | 回调用方 |
| 400 `request body is not valid JSON` / `` `model` is required `` | 解析失败 / `baseModelId(body.model)` 为空 | 回调用方 |
| 404 `` no route for ${req.method} ${path} `` | 非白名单路径 | 回调用方 |
| 502 `the local forward listener did not answer` | 中继出站失败/上游错误 | 回调用方 |
| 非流式 `outcome.error` → 502 `server_error`；流式失败 → SSE `{error:{message,type:'server_error'}}` + `data: [DONE]`；responses 流失败 → `response.failed` 事件 | `complete` 返回失败或流中断 | 回调用方（200 已发出后只能以 SSE 事件表达） |
| `request failed: ...` / `bind: port N is not available yet (CODE); retrying` / `port N is taken (CODE); listening on M instead — <hint>` / `listener error: ...` | 请求处理抛错 / 绑定重试与顺延 / 监听器错误 | `log()` 回调 → `index.js` 包裹为 `our-free-model forward: <msg>`（warn）、`our-free-model request: <JSON>`（info） |
| `lan relay request failed: ...` / `lan relay upstream failed: ...` / `lan relay error: ...` | 中继各阶段失败 | `log()` → `index.js` 包裹 `our-free-model lan relay: <msg>` |
| 诊断头 `x-ofm-request-id`；trace 阶段 `received`/`dispatch`/`body_received`/`first_delta`/`generation_finished`/`relay_dispatch`/`relay_connected`/`aborted`/`finished`；outcome `completed`/`failed`/`truncated`/`aborted`/`relayed` | 每请求 | `onTrace` → `index.js` 的请求诊断 |

## 网络面

- **本地监听**：地址 = `resolveLoopbackBind(config().host)`（默认 `127.0.0.1`，主机名须解析全回环），端口 = `bindForwardPort` 顺延后的实际值；HTTP/1.1 明文、`access-control-allow-origin: *`。触发由 `index.js` 同步转发设置时调用；`forward.enabled=false` 即关闭。
- **LAN 中继**：默认绑 `0.0.0.0`（`forward.lan.host` 空回落），端口默认 0 自动分配；出站**仅** `http.request({ host: '127.0.0.1', port: targetPort })` ——跨机请求改写 `Bearer ${settings.localKey}` + `x-ofm-relay-hop: 1` 后打到本机回环监听器，508 拒绝中继打自己。触发：局域网 harness 指向中继端口的 `RELAY_PATHS` 请求；`forward.lan.enabled=false` 即关闭。
- 本模块无其他出站（`grep 127.0.0.1`/`0.0.0.0` 确认）；公网出站属 `adapter.js`→`http.js`，与本模块不相交。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #23 | 上游 main 已含 | 端口顺延：当前代码 `bindForwardPort`（重试+顺延+临时端口兜底）+ `classifyBindError` 即该 PR 落点；已合入部分随 M0 基线 fbc3b9b 带入（AGENT-BRIEF §6 模块顺序口径） |
| #24 | 上游 main 已含 | LAN 中继：当前代码 `startLanRelay` + `RELAY_PATHS`/`lanKey`/hop 头/508 拒环即该 PR 落点；同上随 M0 基线带入 |
| #27 | 源码上游 main 已含；回归用例待补（M1） | tools 二次转换回归：`src/messages.js` 的 `toToolDefs` 双拼写（`tool.function ?? tool`）与 `index.js` 不再预转换均已在位，`scripts/forward-test.mjs` 已含该 PR 的 5 项断言；计划中的第一个独立回归用例落 `test/integration/forward-tools.test`（待建，`test/` 现仅 `unit/config.test.js`）。tools 转换是 `adapter.js` 出口、回归用例落转发层，故两文档互见 |
| #40 | 已移植（M2，port-of #40） | 中继 PROXY v1 设备 IP：`sniffProxyHeader`/`parseProxyV1`/`proxyHeaderV1`/`bareAddress` 入 `src/forward.js`（`isLoopbackIp` 后），`startForwardServer`/`startLanRelay` 均改 net 前门 + `http.Server` 出站经 `emit('connection')`；中继侧 `http.Agent({keepAlive:false})` + `createConnection` 先写 PROXY 行保证每请求独立连接；6 项断言入 `scripts/forward-test.mjs` |
| #41 | 已移植（M2，port-of #41） | 设备 IP → `x-forwarded-for`：`serveCompletion` 把 `req.socket.ofmDevice.address` 并进 `complete` 请求（`deviceIp`），`proxyHeaderV1` 认领级联 PROXY 源（`socket.ofmDevice` 优先，家族冲突回退本回环）；下游经 `turn.js → adapter → http → gatewayHeaders`；4 断言入 `scripts/forward-test.mjs`，recovery 端到端 1 断言 |
| #74 | 待移植（M1/M3） | effort 档位名映射：当前 `chatCompletions`/`responsesEndpoint` 只解析模型名尾缀 `/\(([^()]+)\)\s*$/` 并在未显式给出时拷入 `reasoning_effort` 原样透传，无 OpenAI 档位名别名映射 |
| #76 | 已移植（M2，port-of #76） | `rankLanAddresses` + `VIRTUAL_IFACE` 落 `src/forward.js`（`startForwardServer` 与 `RELAY_PATHS` 之间），4 项断言入 `scripts/forward-test.mjs`；上游 PR 的面板轮询 API（`GET /forward/lan/addresses`）不适用——zenbox 无 Web UI（§13），重读语义由 banner/status（M4）直接每次现调 |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/forward-test.mjs`（1236 行，71 项 `checkAsync`/`check`） | 工具线序（`tool_calls[].index` 从 0 重排、指纹 decoy 抑制、截断帧 `finish=length`、非流式 `executableCalls` 过滤）；非 JSON 请求体→400；**#76 四断言**（虚拟网卡不领头、组内 OS 原序+IPv6/回环/APIPA 剔除、同址去重、无可用回 `[]`）；**#40 六断言**（PROXY 行归因设备、直连无 `forward:` 行、双连接不串扰、中继两请求各自来源——非池化、畸形 PROXY 拒绝、截断握手按 2s 探测超时死且 HTTP 零字节）；**#41 四断言**（PROXY 设备到达 complete、本地 completion 无 device、中继门上 PROXY 声明的设备传下去而非隧道 socket、`gatewayHeaders` 有/无 `deviceIp` 的 `x-forwarded-for` 两态）；`/v1/responses` 的 `instructions`/`max_output_tokens`/`stream`/`usage`/`incomplete`/`output_index` 分配；#66 reasoning 别名（`reasoning_content`/`reasoning_text`/`reasoning_details`/Anthropic 拼写归并）；#92 无名工具块降级；SSE 心跳（15s 注释帧、`close()` 停止、正常 finish 不动、默认间隔前静默）；`resolveLoopbackBind` 拒绝可路由解析、`classifyBindError` 各类错误码、`bindForwardPort` 等释放/保端口/顺延、`startForwardServer` 回报实际端口；LAN relay 七项（无 key 含 `/health`、空 key、换本机 key 重发、流式承载、非通用代理、503×2、508 自打转）；请求诊断十项（含 LAN 双跳链接、回调抛错、畸形 URL、健康/名单无诊断）；#62 合成行 `model` 来源；`toOpenAiUsage` 归一 |
| `scripts/test-all.mjs` | 套件表含 `['forward','forward-test.mjs']`，与 effort/truncation/recovery/retry-safety/picker/tui/offline 一键执行 |
| `test/unit/config.test.js` | `src/config.js` 键校验（`listen`/`lan` 等键名与本模块注入键的对应关系由其把关；转发行为本身不经此文件） |

## 已知边界

- 本地监听只绑回环（含顺延），对外只通过 LAN 中继的独立门；中继仅放行 `RELAY_PATHS` 三条路径（chat/responses/models 各两种拼写）+ `/`、`/health`，不是通用 HTTP 代理。
- 中继出站目标写死 `127.0.0.1:targetPort`：设备归因链（PROXY v1 → `deviceIp` → 网关 `x-forwarded-for`）已完整贯通；PROXY 行只在回环上可信，直连本机流量不产生任何来源声明。
- effort 只认模型名尾缀 `(level)`，不做 OpenAI 档位名别名映射（#74 的 forward 侧 `callerEffort` 未移植，归 M3）；显式 `reasoning_effort` 永远优先于尾缀。
- SSE 心跳是写给中间代理的注释帧，不重置 `adapter.js`→`http.js` 侧的上游空闲看门狗；上游超时仍由 `postStreamed` 的 300s 截止管。
- 请求体上限 8MB（`MAX_BODY_BYTES`）；`OPTIONS` 免鉴权（CORS 预检），`/`、`/health` 免本地键但中继侧 `/health` 仍要 `lanKey`。
- 本地键与中继键恒分离铸造（`forwardKey`/`forwardLanKey`）；`keyMatches` 恒时比较，但授权函数只接受精确单键，无作用域分级。
- 非流式完成走 `complete` 单次返回，流式失败在 200 已发出后只能以 SSE `error` 帧 + `data: [DONE]`（responses 为 `response.failed`）表达，无法改状态码。
- `config.json`（`src/config.js` `DEFAULTS`）尚未接入本模块，键名以注入的 `settings.get().forward` 为准，层间默认值待 M0 后续统一。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 2026-10-07 M2：port-of #76 `rankLanAddresses`/`VIRTUAL_IFACE` 落地（`scripts/forward-test.mjs` 四断言红→绿，61 项全绿）。
- 2026-10-07 M2：port-of #40 PROXY v1 设备地址落地——`sniffProxyHeader` 前门嗅探 + 双监听改造 + 中继非池化 agent 逐请求 PROXY 行（六断言红→绿，67 项全绿）。
- 2026-10-07 M2：port-of #41 设备 IP 贯穿——`serveCompletion` 传 `deviceIp`、`proxyHeaderV1` 认领级联源、网关 `x-forwarded-for`（四断言红→绿，71 项全绿）。
