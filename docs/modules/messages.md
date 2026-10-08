# messages.js — harness 消息词表到三种上游线形的出站投影与工具 schema 转换

## 职责边界

只做出站方向（harness → 上游）：把 harness 消息数组（V3 的 `user`+`tool-result` 包裹块与 V4 的一等 `tool` 消息两代形态并存）先经 `repairToolPairing` 修复配对，再投影成 `chat`（OpenAI Chat Completions）、`messages`（Anthropic Messages）、`responses`（OpenAI Responses）三种上游载荷，以及把 harness 工具 schema 转成各提供方的工具声明形态。它不回放 assistant 推理、不发请求、不做 SSE 解析（回程投影在 `src/stream.js`），指纹门（四件套补齐/改名）在 `src/upstream.js` 的 `applyFingerprint`，本模块只负责把真实工具如实搬过去。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `repairToolPairing` | function | `repairToolPairing(messages) → messages` | 丢未被回答的 tool 调用、丢没有对应调用的 tool 结果、丢无名调用（issue #92：无名调用被执行成 `unknown tool ""` 后成为永久毒丸）；无变化时原对象逐字保留。三线共用这一个修复，否则任一线 400 会废掉整个会话的后续回合。 |
| `toChatMessages` | function | `toChatMessages(messages, resolveImage, warnings) → Array` | 投成 Chat 形态：`system/developer` → `role:'system'` 文本；assistant 只带文本 + `tool_calls`（推理不回放）；工具结果为一等 `role:'tool'`（`tool_call_id` 键控，文本空则 `'(see attached image)'`/`'(no output)'` 占位）；工具结果里的图像放到紧随其后的 user 轮（`followUp` 归并，先于后续图像/用户内容 flush）。 |
| `toClaudeMessages` | function | `toClaudeMessages(messages, resolveImage, warnings) → { system, messages }` | 投成 Messages 形态：`system/developer` 拼接进顶层 `system`；同角色相邻块合并（`push`），避免连续 user 轮被该线拒绝；工具结果为 `tool_result` 块（`is_error` 透传），V4 `tool` 消息投完即 `continue`（防同一文本/base64 计费两次）；图像只接受 `IMAGE_MEDIA` 四种 data URL，否则记 `image-dropped`。 |
| `toResponseInput` | function | `toResponseInput(messages, resolveImage, warnings) → items` | 投成 Responses 输入项：`function_call`/`function_call_output`（图像同样后置到 user 项）、`message`（system/assistant/user，块为 `input_text`/`output_text`/`input_image`）；此前轮次的 reasoning 项天然不回传（池化凭据轮换账号，回传加密内容必 400——代码注释明示按构造丢弃）。 |
| `toToolDefs` | function | `toToolDefs(tools, style) → Array` | harness 工具 schema → 提供方形态；`style` 为 `'claude'`（`name/description/input_schema`）、`'flat'`（`{type:'function',name,…}`）、默认（`{type:'function',function:{…}}`）。flat `{name,…}` 与 OpenAI `{function:{…}}` 两种输入拼写都吃（否则转发监听的预转换会把工具全部丢光），无名跳过，名字截到 `MAX_TOOL_NAME_LEN`（128）。 |
| `needsVision` | function | `needsVision(messages) → boolean` | 内容含未 offload 的 `image` 块即 true。仓内暂无调用方。 |
| `baseModelId` | function（re-export） | `baseModelId(model) → string` | 转手自 `src/upstream.js`：剥掉尾部 `(level)` 标签。 |
| `restoreToolName` | function（re-export） | `restoreToolName(name, map) → string` | 转手自 `src/upstream.js`：指纹改名映射回译。 |

模块内部（不导出）：`IMAGE_MEDIA = {image/png, image/jpeg, image/webp, image/gif}`、`textOf`、`blocksOf`（字符串/块数组/`input_text`/`output_text` 统一成块列表）、`hasBlocks`、`imageDataUrl`（offload 块不可旅行；`resolveImage` 优先，`attachment.url` 兜底）、`toolResultsOf`（同时读 V3 包裹块与 V4 `role:'tool'`，`toolCallId`/`source.callId` 双取键）、`callIdOf`、`claudeImageBlock`（data URL → base64 `image` 块）。

## 依赖关系

- **import 进来**: `./upstream.js`（`MAX_TOOL_NAME_LEN`——工具名截断、`baseModelId`/`restoreToolName`——转手再导出）。无 node 内置依赖。
- **被谁依赖**: `src/adapter.js`（`toChatMessages`/`toClaudeMessages`/`toResponseInput`/`toToolDefs`/`repairToolPairing`，是唯一生产调用方）、`test/upstream/projection-test.test.mjs`（`repairToolPairing`/`toChatMessages`/`toClaudeMessages`/`toResponseInput`）、`test/upstream/forward-test.test.mjs`（`toToolDefs`）。grep 全仓 `from '.../messages.js'` 仅命中上述三处。

## 配置键

无（参数注入）：`resolveImage`（图像解析器）与 `warnings`（`'image-dropped'` 收集数组）由 `src/adapter.js` 注入；消息数组来自 harness 调用参数。本模块不读 `process.env`、不读 settings。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| （本模块不抛错、不打日志） | 纯函数投影 | — |
| `warnings.push('image-dropped')` | `resolveImage` 给不出 URL、块已 offload、或 data URL 媒体类型不在 `IMAGE_MEDIA` 四种之内 | adapter 收集为回合警告（非异常），图像内容静默缺席该回合 |
| （按构造规避的上游 400） | 未答调用/无主结果/无名调用进入线上、V4 工具消息文本被投两次、连续 user 轮 | 由 `repairToolPairing` 与各投影的 `continue`/合并分支在本模块内消化，不产生本地错误 |

## 网络面

无网络面：纯转换器，不建立任何连接。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #27 | 源码已含 + 独立回归 | `toToolDefs` 双拼写分支在位（上游 fbc3b9b）；独立回归 `test/integration/forward-tools.test.js`（forward-tools，M1 建）。本模块为其 `tools` 转换的源头。 |
| #113 | 源码已含 + 独立回归 | 投影次序：`followUp` 归并（工具结果先于图像/用户内容 flush）、`toClaudeMessages` 同角色合并、混合包裹文本不打断结果序列均在位；`test/upstream/projection-test.test.mjs` 第 8 节 39 断言全绿。独立回归 `test/unit/messages-projection.test.js`（messages-projection，M1 建）。 |
| #102 | 已移植（落点在 adapter） | `systemPromptUpdate:'in-history'` 由 `src/adapter.js` resolveModel 声明（`systemPromptUpdateFor`）；本模块只投影消息序列，不持该字段。测试 `test/unit/adapter.test.js`（adapter-unit）。 |

（处置矩阵见 docs/pr-coverage.md；本表只列直接落进本模块的。）

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `test/upstream/projection-test.test.mjs` | 主覆盖：V3/V4 两代工具结果各恰好上行一次（`repairToolPairing` + 三投影计数）、孤儿调用/无主结果/无 call id 结果丢弃（不再 400 整会话）、无名调用按 issue #92 丢弃（三线一致）、并行调用批、`isError`→`is_error`、图像 offload 与 `image-dropped` 警告、空结果 `'(no output)'`、构造良好的回合 byte-for-byte 不被改写、混合包裹文本次序（`assistant/tool/tool/user`）、Claude 侧同文本不重复附着、并行图片结果相邻性（第 8 节，#112/#113）。 |
| `test/unit/messages-projection.test.js` | 独立回归（messages-projection）：#113——chat/responses 两线的并行结果必须背靠背、图片跟随行全部在其后、混合包裹文本保留一次、源历史不被投影改动。 |
| `test/upstream/forward-test.test.mjs` | `toToolDefs`：flat harness def 与 OpenAI `{function:{…}}` 包裹 def 都能读（不丢工具）、二次转换保留全部调用方工具（#26 区块）、与 `applyFingerprint` 联动（非空列表不钉 `tool_choice`）。 |

（`test/upstream/picker-test.test.mjs` 未引用本模块：grep 证实 `src/messages.js` 的 import 方仅 `src/adapter.js`、上述两测试。）

## 已知边界

- 只做出站投影：回程的块拼写恢复（`restoreToolName`）由 `src/stream.js` 消费，但符号定义在 `src/upstream.js`，本模块仅转手导出。
- `needsVision` 无仓内调用方——是否需要视觉模型由 `src/catalog.js`/`src/adapter.js` 按目录决定，本模块不参与选型。
- Chat 线的 `role:'tool'` 只能携带文本：工具返回的图像永远拆到紧随其后的 user 轮，并带一句英文说明（`The result of tool call … image(s), attached below.`）；Messages 线则把图像内嵌进 `tool_result`。
- assistant 推理（reasoning/thinking 块）从不回传任何一线；`toResponseInput` 连历史 reasoning 项也按构造丢弃（池化凭据轮换 → 回传必 400）。
- `block.arguments` 非字符串按 `'{}'` 处理；Claude 侧 `tool_use.input` 解析失败回退 `{}`——坏参数以空对象上行，不抛错。
- V3 与 V4 形态必须同时支持：只读其一的投影会把工具结果整批丢掉且模型无法察觉（该回归是 `projection-test` 的存在理由，issue #9 口径）。
- `toToolDefs` 的名字截断（128）与 `applyFingerprint` 的大小写归一是两道独立处理：前者在这里，后者在 `src/upstream.js`。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 2026-10-07 M1：#113 判定为源码已含（followUp 次序 + projection-test 第 8 节全绿），建独立回归 `test/unit/messages-projection.test.js`（4 断言）；#27/#102 关联处置同步。本文件同步。
