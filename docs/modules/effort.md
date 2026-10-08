# effort.js — 推理努力档位到生成预算与请求补丁的换算策略

## 职责边界

为一次调用回答两个问题：这一轮实际生效的努力档位是什么（`resolveLevel`），以及它折算出的生成上限 `max_tokens` 是多少（`budgetFor`/`budgetLadder`）。档位在这里不是提示而是硬预算——模块头注释记录了 2026-09-24 的实测结论：网关接受 `reasoning_effort`、`thinking.budget_tokens`、`enable_thinking`、`thinking_budget` 全部并忽略之（`low` 比 `xhigh` 出更多推理 token，未知字段偶发上游 503），唯一被强制执行的控制量是 `max_tokens`，故每个声明档位都必须改变实测行为才能被声明。两条语义并存：免费车道走 token 梯子（`light`/`balanced`/`deep` 三档 × 天花板），带声明菜单的模型（`model.efforts` 数组，两条被吸收渠道的条目）走模型自己的档位列表，由 `effortPatchFor` 生成请求体 JSON merge patch。本模块不发请求、不读配置文件、不做重试：预算的发送与 `usage.effort` 的记录由 `src/adapter.js` 完成，参数（会话 `maxTokens`、插件默认上限）由调用方注入。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `LEVELS` | const | `LEVELS: Array<{id,name,zh,ceiling,hint}>` | `light`(2048)/`balanced`(8192)/`deep`(undefined=模型全量输出容量)；数组顺序即 picker 展示顺序 |
| `DEFAULT_LEVEL` | const | `'balanced'` | 缺省档位 id；`budgetLadder` 的 `isDefault` 与无档位回落都取它 |
| `ALWAYS_THINKING_FACTOR` | const | `2` | `canDisableThinking === false` 的模型每级天花板 ×2（思考与正文共享同一上限，见模块注释的 82% 推理占比实测） |
| `supportsEffort` | function | `supportsEffort(model) → boolean` | `model?.reasoning === true` 才存在档位菜单 |
| `resolveLevel` | function | `resolveLevel(level, model) → {id} \| undefined` | 一次调用生效的档：声明菜单模型只认 `model.efforts` 内的值否则 `menuDefaultLevel`；无菜单且非 reasoning 返回 `undefined`；否则 `LEVELS` 查找并回落 `DEFAULT_LEVEL` |
| `budgetFor` | function | `budgetFor(level, model, requested, fallback) → number` | `max(MIN_BUDGET, min(档位天花板(含翻倍), model.maxOutput ?? 32768, requested, fallback))`；声明菜单模型跳过梯子直接取 `max(MIN_BUDGET, 容量)`；非正数/非有限的 `requested`/`fallback` 视为无上限（`usableTokens`） |
| `MIN_BUDGET` | const | `512` | 地板：低于它正文本身落不了地，任何档位不得下穿 |
| `budgetLadder` | function | `budgetLadder(model, requested, fallback) → Array<{id,name,tokens,isDefault}>` | 三档全部换算后的实际 wire 数字，供设置页/picker 展示 |
| `menuDefaultLevel` | function | `menuDefaultLevel(model) → string \| undefined` | 声明菜单的默认档：`effortDefault` ∈ `efforts` 用之，否则首档；空菜单 `undefined`（M0 由 `eacDefaultLevel` 改名） |
| `effortPatchFor` | function | `effortPatchFor(level, model) → object \| null` | 菜单模型的请求体 patch：所选 `disabled` 且声明了 `effortOffPatch` 时实例化 off patch，否则实例化 `effortPatch`，`$effort` 占位符替换为所选档；无 `efforts` 或无 patch 返回 `null` |
| `hasDeclaredEffortMenu` | function | `hasDeclaredEffortMenu(model) → boolean` | `Array.isArray(model.efforts) && length > 0`；为真时该模型 wire 上的 effort 字段才是控制量 |
| `defaultEffortFor` | function | `defaultEffortFor(model) → string` | 宿主应视为默认的档：菜单模型给 `menuDefaultLevel(model) ?? DEFAULT_LEVEL`，否则 `DEFAULT_LEVEL`（给密封模型报免费车道 id 会被宿主以 "adapter returned an unknown default reasoning effort" 整体拒收） |
| `effortsFor` | function | `effortsFor(model, requested, fallback) → Array<{id,name,description}> \| undefined` | picker 档位表：菜单模型走 `declaredEffortsFor`（含 `disabled`→`Off` 文案），免费车道由 `budgetLadder` 生成 `"N K output ceiling, shared by thinking and the answer"` 描述（含翻倍提示与 hint），非 reasoning 模型 `undefined` |

私有实现不导出但构成语义：`ceilingOf`（翻倍施加点）、`usableTokens`（"非正数=无上限"）、`instantiatePatch`（`$effort` 深度替换）、`declaredEffortsFor`、`roundK`（`16384 → "16 K"`，M0 由 `kilos` 改名）。

## 依赖关系

- **import 进来**: 无。零依赖纯函数模块（不触文件、不发网络、不用 node 内置）。
- **被谁依赖**: `src/adapter.js`（`DEFAULT_LEVEL, MIN_BUDGET, budgetFor, defaultEffortFor, effortsFor, resolveLevel`）；`src/config.js`（`DEFAULT_LEVEL, LEVELS`——校验配置键 `effort` 的取值域）；`index.js`（`DEFAULT_LEVEL, budgetLadder`）；`test/upstream/effort-test.test.mjs`（`MIN_BUDGET, budgetFor, budgetLadder, resolveLevel`）；`scripts/probes/long-answer.mjs`（`budgetFor`）。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `effort` | `DEFAULT_LEVEL`（`"balanced"`） | src/config.js `DEFAULTS.effort` → 校验必须 ∈ `LEVELS` 的 id 集，CLI `--effort` / env `OFM_EFFORT` 覆盖 | 全局默认努力档位；当前由 `start.js`/`loadConfig` 消费，config.json 尚在建设（M0 补） |
| `defaultMaxTokens` | `32768` | store.js `SETTINGS_INITIAL` → index.js/adapter 注入为 `budgetFor` 的 `fallback` | 插件默认输出上限，梯子三档的容量钳制项 |
| 会话 `maxTokens` | 无 | 宿主请求 → adapter 透传为 `requested` | 会话自己的上限，只压低不抬高 |

本模块自身不读任何 `config.` 字段，全部经参数注入。

## 日志错误

无：模块不产生日志、不抛异常、不写网络。所有分支以返回值表达（`undefined`/`null` 表示"该模型无此概念"），错误分类责任在调用方 `src/adapter.js` 与宿主。

## 网络面

无网络面。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #74 | 已移植（M1 effort 单元 + M3 forward 端到端） | `LEVEL_ALIASES` + `normalizeLevel` + `resolveLevel` 梯子分支走归一（`src/effort.js`）：minimal/low/none/off/disabled→light、medium→balanced、high/xhigh/max→deep，大小写与首尾空格不敏感；**声明菜单模型分支保持自身 id 精确匹配，别名不劫持**。M3 补 forward 侧：`src/forward.js` 私有 `callerEffort` 三门提升（chat/responses 两端）+ `src/turn.js` `publicModelRows` 的 `x_ofm_efforts`/`x_ofm_effort_default` 暴露（与菜单同用 `effortsFor`）。测试 `test/unit/effort.test.js`（effort-unit，19 断言）+ `test/upstream/forward-test.test.mjs` #74 四断言 + `test/unit/turn.test.js` x_ofm 两态 |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `test/upstream/effort-test.test.mjs` | 实测通过（尾行 `effort: the ladder is the budget`）：`canDisableThinking` 目录位；梯子翻倍（mimo `[4096,16384,32768]`、muse `[2048,8192,32768]`、无档位模型三档全为窗口 32768）；`isDefault` 只标 `balanced`；会话 ceiling/插件默认/模型容量/`MIN_BUDGET` 四重 min；0/负数/非数字 fallback 读作无上限而数值仍钳制；`resolveLevel` 三态（菜单缺档回菜单默认、无菜单模型不套档、未知档回 `DEFAULT_LEVEL`）；真 adapter 实发 `max_tokens` 与 `usage.effort` 记录一致（含未知档记为回落后的默认）；DSML 控制标记清洗不影响正文与工具 |
| `test/unit/effort.test.js` | #74 单元（effort-unit，19 断言）：`normalizeLevel` 别名全表+大小写空格+非字符串；`resolveLevel` 别名解析/未知词落默认/无菜单不套档/**菜单分支不被别名劫持**；`budgetFor` none/off/disabled→最小档 4096 与 OpenAI 写法同预算；`LEVELS` 档位表定值（light 2048/balanced 8192/deep 无上限）与 `ALWAYS_THINKING_FACTOR=2`；`menuDefaultLevel` 默认在表/回落首档/无菜单三态；`effortPatchFor` 无菜单 null、`$effort` 实例化、未知写法回菜单默认、off 档专属 offPatch；核心导出 `DEFAULT_LEVEL`/`MIN_BUDGET`/`budgetLadder`/`supportsEffort`/`hasDeclaredEffortMenu`/`defaultEffortFor`/`effortsFor` 各 ≥1 断言 |
| `scripts/probes/long-answer.mjs` | 以 `budgetFor` 驱动长回答预算探针（辅助） |

## 已知边界

- 档位的全部效力来自 `max_tokens`：天花板同时约束思考与正文，低档位缩短的是两者的总和，这是本车道唯一可用的调制手段（模块注释的实测依据）。
- 声明菜单模型不做梯子：其上限恒为模型容量，因为 wire 上的控制量是 effort 字段而非 token 数。
- #74 全量落地（M1 `normalizeLevel` + M3 forward `callerEffort` 三门与 `x_ofm_*` 暴露）；移植前 `effortsFor` 的 id 集恒为 `light/balanced/deep`（菜单模型为 `efforts` 声明集）。
- 不处理重试、配额、记录：`providerRetryPolicy` 的 `retryableCodes` 在 `src/adapter.js`，统计在 `src/store.js`。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- M0（cut 5b84917）本仓库改动：`eacDefaultLevel` → `menuDefaultLevel` 改名、`kilos` → `roundK` 改名（EAC 车道痕迹清除，4 处调用点同步）。
- 2026-10-07 M1 移植 #74（effort 侧）：新增 `LEVEL_ALIASES`/`normalizeLevel`，`resolveLevel` 梯子分支归一；菜单分支保持精确匹配。红→绿 `test/unit/effort.test.js` 16 断言；本文件同步。
- 2026-10-08 M3 移植 #74（forward 端到端）：`src/forward.js` `callerEffort` 三门 + `src/turn.js` `publicModelRows` `x_ofm_*` 暴露；forward-test #74 四断言与 turn.test 两断言红→绿。
