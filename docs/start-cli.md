# CLI（docs/start-cli.md）

入口 `start.js`（`node start.js <命令>`，`package.json` bin 名 `zenbox`，`npm start` → `node start.js start`）。

## 命令

| 命令 | M0 现状 | 最终形态（§8.5） |
| --- | --- | --- |
| `start` | 装载配置 → 打印 banner → 前台心跳日志；SIGINT/SIGTERM 优雅退出 0 | §3 时序：loadConfig → store init(0600 Key) → syncEgress → bindForwardPort+startLanRelay（监听先行）→ banner → 后台轮 → 前台请求日志 |
| `status` | banner + `listeners/key` 状态行；`--json` 出结构化 | 含公网出口 IP、LAN 地址、模型数、egress 三态 |
| `models` | 未接入（M1 catalog 后台轮）；`--json` 出占位结构 | 列出清单（id/档位/能力） |
| `probe` | 未接入（M3）；`--json` 出 probe 配置回显 | 手动触发一轮探测并出结果 |
| `key` | 未接入（M1 store）；`--json` 出占位 | 显示 Key 尾4 / `key rotate` 轮换 |
| `doctor` | 检查 node 版本、配置合法性；listener/上游两项如实 PENDING（退出码 1） | 全绿检查（监听、上游 200/401 自测、数据目录可写） |

## 通用约定

- `--json` 适用于 status/models/probe/key/doctor；对 `start` 报错（流式日志与 JSON 不兼容）。
- 配置错误（`ConfigError [field]`）打 stderr 并以退出码 1 拒绝启动；未知命令同样退出 1。
- 优先级与全部 flag/env 见 [modules/config.md](modules/config.md#配置键)。
- banner 字段（§8.4）：M0 打印已存在的事实，未接线字段标 `（M1/M2/M4 接入）`，禁止假装就绪。
- 测试钩子：`OFM_SMOKE_MS=<毫秒>` 时 `start` 到点自动优雅退出 0（CI 冒烟专用，真实启动不设）。

## 网络面

M0 无监听、无出网；`start` 仅本地 stdout。接入监听后以 start.js 后续变更记录为准。
