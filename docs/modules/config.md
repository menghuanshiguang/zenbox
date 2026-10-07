# config.js — 四层配置装载与逐字段校验，非法即拒绝启动

## 职责边界

把 CLI flag、`OFM_*` 环境变量、`config.json`（允许 `//` 注释）与 §8 规格默认值合并为一个深冻结对象，路径为 **flag > env > 文件 > 默认**；对每个字段做类型/范围/枚举校验，未知顶层键视为打字错误直接抛 `ConfigError`，`start.js` 捕获后以退出码 1 拒绝启动。不负责读取运行时状态（Key、清单缓存——那是 store 的职责），不发任何网络请求，不写任何文件。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `ConfigError` | class | `new ConfigError(message, field)` | 带字段路径的配置错误；`field` 指向出错键（如 `listen.port`） |
| `DEFAULTS` | const | `Object.freeze({...})` | §8 规格默认值（listen/lan/upstream/catalog/probe/effort/egress/ip/data） |
| `stripComments` | function | `stripComments(text) → string` | 逐字符剥离 `//` 注释，跳过字符串字面量（`"https://…"` 不受损） |
| `parseConfigFile` | function | `parseConfigFile(text) → Record<string,any>` | 注释剥离 + JSON.parse；非法 → `ConfigError('config')` |
| `parseHostPort` | function | `parseHostPort(text, field) → {host, port}` | 解析 `host:port` 与 IPv6 `[::1]:port`；坏格式/坏端口 → `ConfigError` |
| `validateConfig` | function | `validateConfig(raw) → ZenConfig` | 深合并默认值后逐字段校验，返回深冻结对象 |
| `loadConfig` | function | `loadConfig({argv, env, configPath, fileText, fileMissing, cwd}) → ZenConfig` | 完整四层装载；`data` 归一为绝对路径（正斜杠）；附加 `configPath` |

（`ZenConfig` 为 JSDoc typedef，随 `loadConfig` 返回值导出给 start.js 注解用。）

## 依赖关系

- **import 进来**: `node:fs`（读配置文件）、`node:path`（data 绝对化）、`./effort.js`（`LEVELS`/`DEFAULT_LEVEL` —— effort 档位枚举以 effort.js 为唯一事实源）。
- **被谁依赖**: `start.js`（唯一装载入口）。

## 配置键

四层合并的全部键即 `DEFAULTS` 结构（`config.json` 逐键同构）：

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `listen.host/port` | `127.0.0.1:18899` | 本模块 `validateConfig` | 本机转发监听 |
| `lan.enabled/host/port/separateKey` | `false / 0.0.0.0:18899 / false` | 同上 | 局域网入口；separateKey 恒 false（LAN 复用本机 Key） |
| `upstream.baseUrl/timeoutMs` | `https://opencode.ai / 45000` | 同上（url 校验 http/https） | 上游网关与超时 |
| `catalog.refreshMinutes` | `30` | 同上（1..1440） | 清单刷新周期 |
| `probe.enabled/intervalMinutes/concurrency` | `true / 60 / 2` | 同上（5..1440；1..8） | 探测轮配置 |
| `effort` | `balanced` | 同上（∈ LEVELS ids） | 默认思考档位 |
| `egress.mode` | `direct` | 同上（direct\|proxy） | 出口形态 |
| `ip.refreshMinutes/providers` | `30 / [ipify,ipinfo,ipapi]` | 同上（1..1440；枚举校验） | 公网出口 IP 展示源 |
| `data` | `./data` | `loadConfig` 归一绝对化 | 运行数据目录 |

环境变量映射（env 层）：`OFM_LISTEN`、`OFM_LAN`（`off/0/false` 关闭）、`OFM_UPSTREAM`、`OFM_TIMEOUT`、`OFM_CATALOG_REFRESH`、`OFM_PROBE`、`OFM_PROBE_INTERVAL`、`OFM_PROBE_CONCURRENCY`、`OFM_EFFORT`、`OFM_EGRESS`、`OFM_IP_REFRESH`、`OFM_IP_PROVIDERS`（逗号分隔）、`OFM_DATA`、`OFM_CONFIG`。
flag 层：`--listen --lan --no-lan --upstream --timeout --data --effort --egress --probe --no-probe --probe-interval --probe-concurrency --ip-refresh --config`；未识别 flag 留给 CLI 层（start.js）。

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| `ConfigError [field]` | 类型/范围/枚举/未知键/JSON 非法/文件读取失败 | start.js `loadOrDie` 打 stderr、退出码 1（拒绝启动） |
| `--config 缺少取值` | flag 无值 | 同上 |

## 网络面

无网络面（纯本地解析）。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| — | 无直接 PR | 本模块为 AGENT-BRIEF §8 四层优先级规格的从零新写（M0） |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `test/unit/config.test.js`（coverage id: `config-unit`） | stripComments 字符串保真、parseConfigFile 注释解析、DEFAULTS §8 逐字、六类 ConfigError、flag>env>file>默认 四层优先级、文件缺失回落默认、`--lan/--no-lan`、data 绝对化、深冻结 |
| `test/meta/gates.test.js`（coverage id: `doc-sync`） | 本文档与 src/config.js 双向齐备、十节结构 |

## 已知边界

- `config.json` 缺失不报错（合法默认态）；存在但 JSON 非法才拒绝启动。
- `--config` 取值紧跟 flag（不支持 `--config=path` 写法）。
- env 层整数解析失败即 `ConfigError`（不做静默回落）。
- 校验后返回对象深冻结；`configPath` 仅由 `loadConfig` 附加（`validateConfig` 输入不允许带它）。

## 变更记录

- 2026-10-07 建档并落地（M0，红线④：`test/unit/config.test.js` 先红后绿，18 项断言）。
