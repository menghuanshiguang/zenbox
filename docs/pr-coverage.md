# 未合并 PR 处置对照表（docs/pr-coverage.md）

AGENT-BRIEF §5 的 15 个 PR diff 已全部落盘 `.pr-diffs/pr-N.diff`（该目录不入库）。
本表每行三列必填：**处置**（移植/部分移植/不移植/已合入/不适用 + 理由）、**落点**
（commit 或"待移植"）、**测试**（`test/meta/coverage-map.json` 的 test id，或 `—`）。
gates.test 校验测试列引用的 id 存在。

| PR | 处置 | 落点 | 测试 |
| --- | --- | --- | --- |
| #27 | 源码已含（上游 main 的 `toToolDefs` 双拼写分支与 5 断言在位）；独立回归用例已建 | 随 c4c7421 导入（上游 fbc3b9b）；回归 test/integration/forward-tools.test.js | forward-tools |
| #102 | 移植：`systemPromptUpdate:'in-history'`（chat/responses 声明，messages 不声明） | 已移植（M1: `src/adapter.js` systemPromptUpdateFor + `types/dsh-llm.d.ts`；commit `e8f7…` 见 git log `test(adapter): #102`） | adapter-unit |
| #113 | 源码已含（messages.js `followUp` 投影次序 + projection-test 第 8 节在位）；独立回归用例已建 | 随 c4c7421 导入（上游 fbc3b9b）；回归 test/unit/messages-projection.test.js | messages-projection |
| #105 | 不移植：已被上游实现取代 | — | — |
| #103 | 不移植：自更新三连修，本仓库无自更新器 | — | — |
| #68 | 不移植：自更新三连修，本仓库无自更新器 | — | — |
| #84 | 已移植（M3，port-of #84）——被拒换同区节点重发不重复计费 | `src/adapter.js` QUOTA_RETRY_LIMIT/refusalRetry/attempt 回退重发 + `src/egress.js` addressBlock/rankOutletCandidates/stepOffBlamedAddress（被拒网段连跳≤3）+ `src/store.js` usage 行 refusal 标记 + start.js 单飞轮换 refusal 模式 | upstream-retry-safety |
| #82 | 已移植（M3，port-of #82） | `src/egress.js` 故障梯+`egressLane()`+中继分账+组 interval 60；宿主半 `onFault`/`onLane`/`onQuotaHit`→60s 冷却单飞轮换落 start.js | upstream-failover |
| #76 | 已移植（M2，port-of #76） | `src/forward.js` `rankLanAddresses`/`VIRTUAL_IFACE`；面板轮询 API 不适用（无 Web UI），banner/status 现读（M4） | upstream-forward |
| #75 | 已移植（M3，port-of #75）——onQuotaHit→refreshOutletExit({avoid}) | `src/adapter.js` quota 回调 + `src/egress.js` refreshOutletExit/controllerJson 升级；宿主冷却轮换已接线 start.js | upstream-egress |
| #74 | 已移植（M1 effort 单元 + M3 forward 端到端，port-of #74） | `src/effort.js` normalizeLevel/LEVEL_ALIASES（M1）+ `src/forward.js` callerEffort 三门（chat/responses 两端抬到 reasoning_effort）+ `src/turn.js` publicModelRows `x_ofm_efforts`/`x_ofm_effort_default` 暴露 | effort-unit、upstream-forward、turn-unit |
| #72 | 移植：监听先行 boot-order（勿误读为不移植） | 待移植（M4 start 时序） | — |
| #41 | 已移植（M2，port-of #41） | 设备 IP 贯穿链：`forward.js` `serveCompletion`/`proxyHeaderV1` 认领源 → `turn.js` options → `adapter.js` → `http.js` → `upstream.js` `x-forwarded-for`；4+1 断言 | upstream-forward |
| #40 | 已移植（M2，port-of #40） | `src/forward.js` PROXY v1 嗅探/解析/前门+中继非池化；6 断言 | upstream-forward |
| #45 | 已部分移植（M3，port-of #45 = egress.mode=proxy） | `src/config.js` EGRESS_MODES 三态 `direct\|proxy\|subscription` + `src/egress.js` client 分支 `cfg.password` 独立字段合成拨号 URL（url 永不含密码，内联优先）+ start.js 三态映射（proxy→client/password、subscription→受管 mihomo）；密码平台 seal（secret.js/DPAPI）不进 v0.1——无 Web UI，config 三途径 | upstream-egress |
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
