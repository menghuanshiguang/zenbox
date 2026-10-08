# 最终验收对照（docs/conformance.md）

AGENT-BRIEF §12 DoD 八项 → 证据。每项给可复跑的复现方式；"实测"=本机一次完整实跑记录，"套件"=对应测试文件的绿跑结果。

## DoD 逐项

| # | DoD 条目 | 证据 | 状态 |
| --- | --- | --- | --- |
| 1 | 干净机器 `./start.sh` 一条命令：banner（公网 IP/国家、LAN IP、端口、Key、模型数）+ 持续日志 + Ctrl-C exit 0；`start.cmd` 等价 | 三平台脚本 `start.sh`/`start.ps1`/`start.cmd`；本机实测 banner §8.4 八行全字段（含公网 IP `221.182.83.175 (CN)`、LAN `10.39.21.192 (物理)`、顺延 18899→18900 标注、Key 尾 4）；`OFM_SMOKE_MS` 优雅关 exit 0（`[stop] 收到 SMOKE…`）；CI 三平台 start 冒烟 grep banner 两行 | 实测 ✓ |
| 2 | 与上游插件同机对比一致：`/v1/models` 集合（除 Kilo）、流式/非流式、工具调用(#27)、`reasoning_effort`(#74)、SSE 心跳、401/404/413 | 集合实测：本地 `/v1/models` 11 id ⊆ 上游 `https://opencode.ai/zen/v1/models` 的 free 车道 12 id（`OURS − UPSTREAM = ∅`；差的 `ling-3.0-flash-fin-free` 是探测轮判 `unavailable` 后按 #39 语义剔除——`data/catalog.json` 在列、`data/availability.json` 裁决，链路每步符合设计；Kilo 是上游第二数据源不在该 listing，裁剪口径"除 Kilo"天然成立）。行为面：上游 13 套件（`test/upstream/`，含 forward 71 项/effort/truncation/sniff/projection）绿 = 与上游行为规范一致的可执行证明；401/404/413 另有 `test/upstream/forward-test.test.mjs` 与 `test/integration/boot-order.test.js` 断言；SSE 心跳 `SSE_HEARTBEAT_MS` 断言在 forward-test | 实测 ✓ |
| 3 | 第二设备凭 LAN Key 对话成功，日志显示真实设备 IP(#40/#41) | `node test/manual/lan-live.mjs` → **PASS**：LAN 独立 Key 流式对话 200、SSE 含桩回声；归因行 `lan relay: 10.39.21.192 → /v1/chat/completions` 与 `forward: 10.39.21.192:53875 → POST /v1/chat/completions`（#76 首选物理地址 #40 中继归因 #41 贯穿）。真机（手机/另一台电脑）步骤留 `test/manual/lan-checklist.md`，release 前人工 | 半自动实测 ✓（真机清单人工） |
| 4 | `egress.mode` 三态可切，#75/#82/#84 行为可复现 | `test/upstream/egress-test.test.mjs` 81/81（direct/proxy/subscription 形状与三态切换）+ `test/upstream/failover-test.test.mjs` 41/41（#82 三类分账）+ `test/upstream/retry-safety-test.test.mjs` 8 形状（#84 被拒重发不重复计费）；#75 `refreshOutletExit({avoid})` 断言在 egress-test | 套件 ✓ |
| 5 | `npm test`（L0–L2）全绿：rg 零命中、coverage-map 无孤儿、六模块导出断言达标、模块文档齐备 100% | 门禁 `== 门禁汇总: 33/33 通过 ==`（L0: rg 零命中 / node --check 72 files / tsc 棘轮 0/585 / config schema / gates 7 checks；L1 8 单元套件；L2 集成+upstream 全绿）；coverage-map 30 id 双向无孤儿由 gates ⑤ 强制；模块文档=src 模块 100% 齐备且十节齐全由 gates ①②③ 强制；六模块导出断言审计见下节 | 实测 ✓（33/33） |
| 6 | `docs/pr-coverage.md` 每行 commit hash + test id（N/A 行有理由） | 19 行：13 个有处置行全部落具体 hash（#27 c4c7421+d95062a、#102 73afea4、#113 c4c7421+4306dbd、#84 a48a7bc、#82 e03232b、#76 6a97353、#75 8e68361、#74 ee3a1a7+c157065、#72 6398f58、#41 1e6d427、#40 cfbc487、#45 7c16966）；测试列 30 id 由 gates ⑥ 校验存在于 coverage-map；6 个 N/A 行（#105/#103/#68/#44/#53/#108）均有不移植理由 | ✓ |
| 7 | `zenbox` 仓库 main 无红提交，CI 三平台绿，`v0.1.0` release 已发布 | 仓库 https://github.com/menghuanshiguang/zenbox；每次 push 后 CI（ubuntu/amd64+ubuntu-arm64/macos/windows）跑 L0–L2+start 冒烟；release=tag `v0.1.0` + `gh release create`（本节在 release 执行后回填 run 链接） | push 后回填 |
| 8 | 配置仅 `config.json`/`OFM_*`/flag 三途径，无 Web UI、无交互提问 | `src/config.js` 四层（flag > OFM_* > 文件 > 默认，见 `docs/modules/config.md` 配置键节）；全仓无任何管理 Web UI（转发口是 OpenAI 兼容 API 不是配置面）；CLI 无交互提问（stdin 全程 ignore，参数缺失即报错退出 1） | ✓ |

## 六模块导出断言审计（§7.2）

- 静态导出面：63 个符号（adapter 4 / forward 11 / messages 8 / stream 4 / effort 14 / upstream 22）。
- 首轮审计：covered 36 / mention-only 4 / **gap 23**（纯 0 命中或仅注释提及）。
- 补齐动作（coverage-map 新增 `upstream-unit`/`forward-unit` 两 id）：
  - `test/unit/upstream.test.js` 8 例 → upstream 15 gap + 2 mention 全清（惰性 base、UA/头常量、id 铸造与复用、三 wire 路由、双拼写工具名、会话截断）。
  - `test/unit/forward.test.js` 3 例 → forward `keyMatches`/`toOpenAiUsage` + `SSE_HEARTBEAT_MS` mention 全清。
  - `test/unit/effort.test.js` 16→19 断言 → effort `LEVELS`/`ALWAYS_THINKING_FACTOR`/`menuDefaultLevel`/`effortPatchFor` 全清。
  - `test/unit/adapter.test.js` 4→5 → `ROUTE_LABELS` 清。
  - `test/unit/messages-projection.test.js` 4→6 → `needsVision` + `baseModelId`（messages 出口）清。
- 终态：**63/63 符号 ≥1 断言，gap 0、mention-only 0**（stream 首轮即全绿）。

## 复跑方式

```
npm test                 # L0–L2 全门禁（33 项）
node test/manual/lan-live.mjs   # DoD③ 半自动 LAN 链（需非回环 IPv4）
bash start.sh            # DoD① banner（Ctrl-C 或 OFM_SMOKE_MS=<ms> 自动退）
```
