# upstream.js — 免密车道的上游线缆契约：标识铸造、端点与线形路由、指纹头与工具指纹门

## 职责边界

本模块集中定义与 OpenCode Zen 网关（默认基址 `https://opencode.ai`，路径 `/zen/v1/*`）对话所需的全部静态契约：会话/请求 id 的铸造与稳定映射、模型 id 到端点与线形（chat/responses/messages）的路由、网关指纹请求头、免费层要求的四件套工具指纹门。它不发出任何请求、不解析 SSE、不做消息词表转换——网络与错误语义在 `src/http.js`，流投影在 `src/stream.js`，出站消息投影在 `src/messages.js`。除 `process.env.OUR_FREE_MODEL_BASE` 外没有配置面，其余输入全部由调用方以参数注入。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `UPSTREAM_BASE` | const | `process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'` | 上游基址，模块 import 时求值一次；`src/http.js` 拼 `${UPSTREAM_BASE}${path}` 使用，测试在 import 前注入本地 stub。 |
| `CLIENT_UA` | const | `'opencode/1.18.31'` | 网关 User-Agent 检查要求版本 >= 1.17；该字面量属 adapter 层口径，本模块如实定义并携带（现状记录，非本模块决策）。 |
| `FINGERPRINT_TOOLS` | const | `['bash', 'glob', 'grep', 'read']` | 免费层指纹门要求在 `body.tools` 中声明的四个小写工具名。 |
| `SESSION_RE` | const RegExp | `/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/` | 网关形会话 id 的形态校验。 |
| `REQUEST_RE` | const RegExp | `/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/` | 网关形请求 id 的形态校验。 |
| `mintSessionId` | function | `mintSessionId(timestamp = Date.now()) → string` | 铸造时间前缀 + 单调计数 + 14 字节随机的 `ses_` id；生产路径不用，探针脚本（`scripts/probes/*`）使用。 |
| `mintRequestId` | function | `mintRequestId(timestamp = Date.now()) → string` | 铸造 `msg_` 请求 id；`src/adapter.js` 每次 HTTP 请求各铸一枚（续写换新）。 |
| `sessionForConversation` | function | `sessionForConversation(sessionId) → string` | 把一个下游会话稳定映射到同一上游 `ses_` id（sha256(`our-free-model\0`+seed) 前 6 字节 hex + 后 14 字节 base62；seed 空则用字面 `'global'`；已是合法 `ses_` 形态则原样返回）。配额按会话计，每请求新 id 会打到 429。 |
| `requestIdFor` | function | `requestIdFor(sessionId, turnSeed) → string` | 同一 turn 稳定的 `msg_` id（同一 turn 的重试共享一枚）；`turnSeed` 非非空字符串时退化为 `mintRequestId()`。仓内暂无生产调用方。 |
| `baseModelId` | function | `baseModelId(model) → string` | 剥掉模型 id 尾部的 `(level)` 思考后缀再 trim。 |
| `isResponsesModel` | function | `isResponsesModel(modelId) → boolean` | `RESPONSES_MODELS`（两个 muse-spark 免费 id）或 `muse[-_]?spark` 正则命中即 true。 |
| `isMessagesModel` | function | `isMessagesModel(modelId) → boolean` | `MESSAGES_MODELS`（`union-alpha`）命中即 true。 |
| `endpointFor` | function | `endpointFor(modelId) → '/zen/v1/responses' \| '/zen/v1/messages' \| '/zen/v1/chat/completions'` | 模型到网关端点的唯一路由表。 |
| `wireFor` | function | `wireFor(modelId) → 'responses' \| 'messages' \| 'chat'` | 端点的线形名，驱动请求编码与响应解析。 |
| `gatewayHeaders` | function | `gatewayHeaders({ session, requestId, stream, accept, deviceIp }) → object` | 网关指纹头：`content-type`、`authorization: Bearer public`（池化免密凭据，无每用户密钥）、`user-agent: CLIENT_UA`、`x-opencode-client: desktop`、`x-opencode-session/request/project: global`、`accept`（流式 `text/event-stream`，否则 `*/*`，可显式覆盖）。#41：`deviceIp` 为非空字符串时附 `x-forwarded-for`，本地流量不带该头、线上形状不变。 |
| `applyFingerprint` | function | `applyFingerprint(body, style) → Map<string,string>` | 就地满足指纹门：`style` 为 `true`（Responses 平铺）/ `false`（Chat 包裹）/ `'claude'`（Messages）；四件套大小写归一并去重（上游拒 `Bash`+`bash` 重复），缺槽先用 `QUARTET_DONORS`（`bash`←`pwsh`）提升真实工具再补自禁用 decoy，`tool_choice` 仅在缺失时补（平铺→`'auto'`；调用方无工具→`'none'`/`{type:'none'}`）。返回 发送名→调用方名 的改名映射。 |
| `restoreToolName` | function | `restoreToolName(name, map) → string` | 用改名映射把发送名还原为调用方拼写（映射为空或未命中则原样返回）。 |
| `declaredToolNames` | function | `declaredToolNames(body) → Set<string>` | 收集 `body.tools` 中已声明的工具名（两种拼写通吃）。仓内暂无调用方（`src/forward.js` 自建 declared 集合）。 |
| `truncateSession` | function（re-export） | `truncateSession(value) → string` | 会话 id 去空白并截到 `MAX_SESSION_LENGTH = 256`。 |
| `ANTHROPIC_API_VERSION` | const（re-export） | `'2023-06-01'` | Anthropic 版本头字面量；仓内无调用方（实网探针脚本自带该字面量）。 |
| `MAX_TOOL_NAME_LEN` | const（re-export） | `128` | 工具名长度上限，`messages.js` 的 `toToolDefs` 据此截断。 |

模块内部（不导出）：`MAX_SESSION_LENGTH = 256`、`BASE62` 字母表、`QUARTET_DONORS = { bash: ['pwsh'] }`、`RESPONSES_MODELS`、`MESSAGES_MODELS`、`isMuseSpark`、`toolNameOf`、`quartetKey`、`functionOf`。

## 依赖关系

- **import 进来**: `node:crypto`（`sha256` 摘要用于稳定会话/请求 id，`randomBytes` 用于铸造随机尾部）。无其他模块依赖。
- **被谁依赖**: `src/http.js`（`CLIENT_UA`/`UPSTREAM_BASE`/`gatewayHeaders`/`truncateSession`）、`src/stream.js`（`restoreToolName`）、`src/messages.js`（`MAX_TOOL_NAME_LEN`/`baseModelId`/`restoreToolName`）、`src/adapter.js`（`applyFingerprint`/`baseModelId`/`endpointFor`/`mintRequestId`/`sessionForConversation`/`wireFor`）、`src/probe.js`（`applyFingerprint`/`endpointFor`/`mintRequestId`/`sessionForConversation`/`wireFor`）、`src/catalog.js`（`baseModelId`/`isResponsesModel`）、`src/forward.js`（`baseModelId`/`FINGERPRINT_TOOLS`）、`index.js`（`mintRequestId`/`sessionForConversation`）、`scripts/fingerprint-test.mjs`、`scripts/forward-test.mjs`、`scripts/recovery-test.mjs`、`scripts/probes/batch-delivery.mjs`、`scripts/probes/stream-terminal-frames.mjs`、`scripts/probes/dangling-tool-call.mjs`、`scripts/probes/pairing-repair.mjs`、`scripts/probes/tool-name-charset.mjs`。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `OUR_FREE_MODEL_BASE` | `https://opencode.ai` | `src/upstream.js`（import 时读入 `UPSTREAM_BASE`，再被 `src/http.js` 消费） | 上游基址覆盖；离线测试在 import 任何消费模块之前注入 `http://127.0.0.1:<port>` 的本地替身。 |

其余全部为参数注入：会话 seed、turnSeed、`style`、`body` 由调用方传入，本模块不读 settings.json、不读其他环境变量。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| （本模块不抛错、不打日志） | 纯函数与常量定义 | — |
| `UpstreamError(..., 'REGION_BLOCKED')` 等错误码的**判定素材** | 本模块产出的 `endpointFor`/`gatewayHeaders`/`applyFingerprint` 结果被 `src/http.js` 与 `src/adapter.js` 使用 | `src/http.js` 的 `classifyFailure`/`classifyStreamFailure` 产生 `UpstreamError`，由 adapter 决定重试/重探（本模块自身不构造错误） |

## 网络面

无网络面：本模块不发起也不监听任何连接。它只定义将被 `src/http.js` 使用的目标字面量——基址 `https://opencode.ai`（可用 `OUR_FREE_MODEL_BASE` 覆盖为 `127.0.0.1` 替身）与三条路径 `/zen/v1/chat/completions`、`/zen/v1/responses`、`/zen/v1/messages`——以及会被拼进请求的指纹头（含池化凭据 `Bearer public`）。协议与实际出站由 `src/http.js` + `src/egress.js` 完成。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #39 | 已合入上游 main | 探测截止相关改动；当前代码即合入后状态。UA 字面量 `opencode/1.18.31` 属 adapter 层口径，此处如实记录现状。 |
| #41 | **已移植**（2026-10-07 M2，本仓 commit 见 pr-coverage） | `gatewayHeaders` 增 `deviceIp` 参数→条件附 `x-forwarded-for`（本模块）；链路上游见 `http.js`/`adapter.js`/`turn.js`/`forward.js`；测试 `scripts/forward-test.mjs` 四断言 + `scripts/recovery-test.mjs` 端到端一断言（upstream-forward） |

（处置矩阵见 docs/pr-coverage.md；本表只列直接落进本模块的。）

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/fingerprint-test.mjs` | `applyFingerprint`：四件套全声明、大小写变体归一 + `restoreToolName` 回译、`pwsh`→`bash` 提升后调用可执行、`'claude'` 风格补齐与回译、调用方工具缺位时的 decoy 兜底。 |
| `scripts/recovery-test.mjs` | `sessionForConversation` 跨续写 `x-opencode-session` 不变、`mintRequestId` 每次请求 `x-opencode-request` 独立；`wireFor` 对三条线形的选择。 |
| `scripts/forward-test.mjs` | `applyFingerprint` 与 `toToolDefs` 联动：非空工具列表不钉 `tool_choice`、空列表钉 `'none'`、提升槽位 `map.get('bash') === 'pwsh'`。 |
| `scripts/sniff-test.mjs` | 注入 `OUR_FREE_MODEL_BASE` 指向 `127.0.0.1` 替身，端到端穿过 `UPSTREAM_BASE` + `gatewayHeaders` 的 `postStreamed` 调用。 |
| `scripts/offline-test.mjs` | 冷启动承诺：池化凭据只存在于 `src/upstream.js`，无网、无 key 配置下车道仍激活、回合以干净的 upstream error 收尾。 |
| `scripts/tui-test.mjs` | 无 webServer 组合（dsh-tui）下模型车道端到端可用，同样经 `OUR_FREE_MODEL_BASE` 注入替身。 |
| `scripts/probes/*`（`batch-delivery`、`stream-terminal-frames`、`dangling-tool-call`、`pairing-repair`、`tool-name-charset`） | 实网探针，直接驱动 `gatewayHeaders`/`mintSessionId`/`applyFingerprint`/`endpointFor`；非离线门禁，不进 `scripts/test-all.mjs`。 |

## 已知边界

- `CLIENT_UA` 固定为 `opencode/1.18.31`：网关以搜索方式匹配 `opencode/<version>`（要求 >= 1.17），版本字面量的口径归属 adapter 层，本模块只负责携带，不自动跟随上游版本。
- `mintSessionId`、`requestIdFor`、`declaredToolNames`、`ANTHROPIC_API_VERSION` 在仓内没有生产调用方（前两者与 `mintRequestId` 供探针/自检使用，后两者为保留导出）。
- `requestIdFor` 生成的 id 若不符合 `REQUEST_RE` 会回退 `mintRequestId()`；`SESSION_RE`/`REQUEST_RE` 的形态是 12 位 hex + 14 位 base62，与实测网关形态一致但未承诺与上游未来版本同步。
- `sessionForConversation` 的 seed 为空字符串/非字符串时统一落到字面 `'global'`，即所有无会话调用共享一个上游会话。
- `isMuseSpark` 以正则 `^muse[-_]?spark($|[-_:.\s])` 识别（先剥路径前缀与 `(level)` 标签），它与 `RESPONSES_MODELS` 共同决定 `/responses` 路由；`MESSAGES_MODELS` 目前只有 `union-alpha` 一个成员。
- 指纹门的 decoy 是自禁用描述（`This tool is currently unavailable and must not be used.`）：只有在 `pwsh` 提升也做不到时才补，且提升/降级的改名必须靠返回的 Map 在响应侧还原，否则调用方工具不可调用。
- 本模块完全不做错误分类与网络失败处理；一切失败语义由 `src/http.js` 的 `CODE`/`UpstreamError` 承担。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 2026-10-07 M2 移植 #41：`gatewayHeaders` 增 `deviceIp`→`x-forwarded-for`；forward-test 四断言 + recovery-test 端到端一断言红→绿。
