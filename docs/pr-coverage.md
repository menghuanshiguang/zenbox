# 未合并 PR 处置对照表（docs/pr-coverage.md）

AGENT-BRIEF §5 的 15 个 PR diff 已全部落盘 `.pr-diffs/pr-N.diff`（该目录不入库）。
本表每行三列必填：**处置**（移植/部分移植/不移植/已合入/不适用 + 理由）、**落点**
（commit 或"待移植"）、**测试**（`test/meta/coverage-map.json` 的 test id，或 `—`）。
gates.test 校验测试列引用的 id 存在。

| PR | 处置 | 落点 | 测试 |
| --- | --- | --- | --- |
| #27 | 源码已含（上游 main 的 `toToolDefs` 双拼写分支与 5 断言在位）；独立回归用例已建 | 随 c4c7421 导入（上游 fbc3b9b）；回归 test/integration/forward-tools.test.js | forward-tools |
| #102 | 移植：`systemPromptUpdate:'in-history'`（chat/responses 声明，messages 不声明） | 已移植（M1: `src/adapter.js` systemPromptUpdateFor + `types/dsh-llm.d.ts`；commit `e8f7…` 见 git log `test(adapter): #102`） | adapter-unit |
| #113 | 部分移植：messages.js 投影次序 | 待移植（M1 messages） | — |
| #105 | 不移植：已被上游实现取代 | — | — |
| #103 | 不移植：自更新三连修，本仓库无自更新器 | — | — |
| #68 | 不移植：自更新三连修，本仓库无自更新器 | — | — |
| #84 | 移植：被拒换同区节点重发不重复计费 | 待移植（M3 egress/adapter） | — |
| #82 | 移植：egress 故障切换 + `x-ofm-egress-fault` 三类分账 | 待移植（M3 egress） | — |
| #76 | 移植：rankLanAddresses | 待移植（M2 forward） | — |
| #75 | 移植：onQuotaHit→refreshOutletExit({avoid}) | 待移植（M3 egress/adapter） | — |
| #74 | 移植：effort 别名 minimal/low/medium/high/none→light/balanced/deep + /v1/models 暴露档位 | 待移植（M3 effort+forward） | — |
| #72 | 移植：监听先行 boot-order（勿误读为不移植） | 待移植（M4 start 时序） | — |
| #41 | 移植：设备 IP→`x-forwarded-for`（依赖 #40） | 待移植（M2 forward） | — |
| #40 | 移植：中继 PROXY v1 设备 IP | 待移植（M2 forward） | — |
| #45 | 部分移植：egress.mode=proxy（吸收 proxy/secret 逻辑，剔除 EAC 触达） | 待移植（M3 egress） | — |
| #44 | 不适用：被取代 | — | — |
| #53 | 不适用：与本仓库形态冲突（自写） | — | — |
| #108 | 不适用：被取代/自写 | — | — |

## 已合入上游 main、不得误删的 PR（§5 口径，随裁剪保留其代码）

#23 端口顺延、#24 LAN 中继、#25 思考兼容+静默心跳、#46 流式 tool delta、#51 分阶段日志、#56 订阅出口、#94 无名工具调用、#39 探测截止。

## 明确不移植（记录不移植的理由，保留本行）

- #44 / #53 / #108：被上游后续提交取代或与本仓库形态冲突（§5）。
- #103 / #105 / #68：上游自更新三连修，本仓库无自更新器（§13：自更新不做）。
- #72：**移植**（监听先行，M4 start 时序，boot-order 测试）——本行为提醒其关键性，勿按"不移植"误读。

（其余 PR 的处置在 M1–M3 移植时逐行补全，含 commit hash 与 test id。）
