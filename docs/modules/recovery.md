# recovery.js — 缺终帧与纯思考空停的有界续写恢复策略及配套工具

## 职责边界

回答一个边界问题：模型"没答完"时，允许在哪里续、续到什么时候为止。文件头把物理边界写死：三层——续写段截止 = 总窗 − 已耗（只许向下调，时钟上限不许延长）、每帧带入模型的全部上下文（错误消息不携带、工具痕迹不携带）、两次耗尽再等第二轮就是用户在白屏前空转。本模块纯策略 + 三个与恢复无关但共享文件的工具：决策（`canRecover`/`canRecoverSilentStop`：文本/工具/截断终态不续，语义完结总帧到了也不续——真续写只针对**缺终帧的纯推理空停**，有终帧的 silent stop 是有界一次、第二次放弃，避免"无限续长文"在缺终帧与有终帧两种失败里反复开新推理段把墙钟烧光）、造轮（`recoveryMessages` 新决策轮 vs `continuationMessages` 续写 assistant 片段）、闸（`checkpointFits` 字节预算：重试把上下文重打一遍，checkpoint 超容会让"恢复"变成最贵的操作）、账（`addUsage`）、节流（`createBlockTracker` 只转录块事件）。零依赖、不发请求、不读文件、不发日志——HTTP/退避/配额在 `src/adapter.js` 与 `src/http.js`，落盘在 `src/store.js`。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `RECOVERY_DEFAULTS` | const | `frozen {maxContinuationMs:1800000, totalTimeoutMs:1800000, checkpointLimit:131072, maxOutputTokens:8192}` | 30 分钟总窗（唯一墙钟）/ 续写段预算 / checkpoint 字节上限 / 恢复轮输出 token 预算 |
| `recoveryPolicy` | function | `recoveryPolicy(value) → object` | `enabled = value !== false && value?.enabled !== false`（默认开）；四个数值只收安全整数且 >0，再 `Math.min` 封顶默认值——乱数只许把预算变小 |
| `canRecover` | function | `canRecover({sawReasoning, sawText, sawToolCall, checkpointTruncated, reasoningText, startedAt, now=Date.now(), policy})` | 无终帧恢复闸：`enabled` && 未超总窗 && 看到过推理 && 无正文 && 无工具调用 && 未被 checkpoint 截断 && `reasoningText` trim 非空 |
| `canRecoverSilentStop` | function | 同参 + `{hadFinalFrame, continuationStartedAt, continuationStarted}` | 有终帧的空停闸：追加 `hadFinalFrame` && 未超 `maxContinuationMs` && 尚未续写过；与 `canRecover` 共用同一组核心条件 |
| `recoveryMessages` | function | `recoveryMessages(messages, checkpoint) → array` | 新决策轮：截到末次 tool 结果为止的历史 + 英文 instruction（要求按原约束补完回答、每 800 words 换一行、结论先行、`Do not call tools`、附 `JSON.stringify(checkpoint)`）+ 空 assistant 占位 |
| `continuationMessages` | function | `continuationMessages(messages, partialAnswer) → array` | 无 checkpoint 的字节续写：截到末次 tool 结果为止的历史 + **部分正文作为 assistant 轮**（模型从此处接续），没有新 instruction 轮 |
| `checkpointFits` | function | `checkpointFits(payload, entry, checkpoint, outputBudget) → boolean` | 字节闸：`checkpoint <= (context − outputBudget)/2` 且 `JSON.stringify(entry)` 剔除 `image_url`/`data` 字段后大小 + `outputBudget < context`；`context` 无效直接放行（无从判定） |
| `addUsage` | function | `addUsage(total, usage, present)` | 在场的 usage 字段（prompt/completion/reasoning/output）逐项累加到 `total`；缺失不写入 |
| `createBlockTracker` | function | `createBlockTracker() → {accept(chunk), close()}` | 块事件转录机：识别 `block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`；`close()` 把未闭合的进行中块补 `block-end` 并返回其数组 |

私有件：`continuationInstruction`（`continuationMessages` 的续写文案常量，同族英文要求）。

## 依赖关系

- **import 进来**: 无（零依赖纯函数）。
- **被谁依赖**: `src/adapter.js`（`RECOVERY_DEFAULTS, addUsage, canRecover, canRecoverSilentStop, checkpointFits, continuationMessages, createBlockTracker, recoveryMessages, recoveryPolicy`——恢复调度、usage 聚合、流解析全在此接线）；`scripts/recovery-test.mjs`（同一批导出 + `dispatchStream`/`fakeProvider` 联动）。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| 无新配置层键 | — | — | `src/config.js` 未定义任何 `recovery.*`/`streamRecovery.*` 键，**当前代码未含** |
| `streamRecovery` | `true` | store.js `SETTINGS_INITIAL` → index.js → adapter | 旧链路的恢复总开关，经 `recoveryPolicy(value)` 消费：`false` 关、对象按四键收紧 |
| 会话/调用方注入的 `policy` | `RECOVERY_DEFAULTS` | adapter 透传 | `recoveryPolicy` 的入参；无配置文件读取，全部走参数 |

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| 无 | 本模块零日志、零抛错 | 决策以 `false` 表达；恢复失败后的 429/503/重置/重试预算分类与日志在 `src/adapter.js`（recovery-test 的段组即其回归面） |

## 网络面

无网络面。模块不发请求；"恢复失败不整轮重发、usage 只累加一次"的网络语义由 `src/adapter.js` 实现、`scripts/recovery-test.mjs` 验证。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #14 | 已合入上游 main | 缺终帧恢复的总窗/阶段边界与 `canRecover` 决策即其落点；随上游 fbc3b9b 进入本仓库 |
| #35 | 已合入上游 main | `canRecoverSilentStop` 的有界一次续写（有终帧但正文空）语义 |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/recovery-test.mjs` | adapter 直驱部分实测**全绿**（后段因 `../index.js` 加载失败中止）：三种 wire × 纯推理 EOF 发起恢复、resume 后仍无正文的 silent stop 续写、第二段再 EOF 不发第三次、恢复失败（429/503/网络重置/空响应/流内错误）不整轮重发、usage 只累加一次、checkpoint 超容不带 checkpoint、`enabled:false` 拒绝、时间上限（越过 30 分钟总窗）、取消、工具元数据不泄漏进恢复请求 |
| `scripts/truncation-test.mjs` | 相邻回归面（adapter 层）：上游自封长度与代理均限的自截断、注释"截断服务真实记录仍为该会话诚实，真实语言模型对不计费"——与 `checkpointTruncated` 闸互为边界 |

## 已知边界

- 两族文案不合并：`recoveryMessages` 的 instruction 轮（新决策，模型重新想）与 `continuationMessages` 的 assistant 片段轮（接着写）语义不同，混用会让续写变成重新作答。
- 时间上限只减不增：`recoveryPolicy` 的 `Math.min` 封顶意味着配置只能收紧 `RECOVERY_DEFAULTS`，放宽需改源码常量。
- `checkpointFits` 是保守估算（截到 tool 结果 + 字节/2 预算），不保证 token 精确；`context` 无效时放行，宁可后续上游报错也不误杀。
- 恢复期间的错误分类（429/5xx/重置）、重试预算与计费口径在 `src/adapter.js`；本文件不做退避、不记账。
- `createBlockTracker` 不判断业务合法性，只保证进行中块被 `close()` 收尾。
- 无 `src/config.js` 键——若 M0 后续把恢复策略纳入新配置层，需补键并更新本节。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- M0（cut 1c752e5）：仅改文件头注释——删去对 `src/eac.js`/`src/kilo.js`（已随 cut 移除）的引用，逻辑零改动。
