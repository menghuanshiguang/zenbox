# banner.js — 启动横幅的框渲染：§8.4 字段结构、异步占位与补行

## 职责边界

把启动状态渲染成 §8.4 规定的框形横幅。输入是一个纯数据字段对象（版本、上游、监听、Key 尾 4、中继、公网 IP、LAN 地址、清单计数），输出是字符串行数组——宿主负责打印。

网络信息在冷启动时尚未取得：公网 IP、LAN 地址、清单分桶都以 `[异步]` 占位打全框，宿主拿到值后用本模块的行渲染函数补行（不重打整框）。IP 三家全挂只显示 `unknown`，不抛错。模块不发任何网络请求、不读文件、不碰监听。

## 导出符号表

| 符号 | 类型 | 签名 | 语义 |
| --- | --- | --- | --- |
| `renderBanner` | 函数 | `(fields) => string[]` | 完整框：框头（`┌─ zenbox v<版本>`）+ 6 字段行 + 框尾。缺省字段渲染成占位，绝不省行 |
| `renderIpLine` | 函数 | `(state) => string` | 公网出口行；`null`/缺省→`… [异步]`；有值→`ip  (国家)`；全挂→`unknown` |
| `renderModelsLine` | 函数 | `(state) => string` | 模型清单行；`null`→占位；仅有 `total`→`N 个 · 分桶待探测 [异步]`；四段齐全→`N 个 · 可用 a · 地区受限 b · 移除 c` |
| `renderLanAddressLine` | 函数 | `(addresses) => string` | 局域网地址行；空/null→占位；有值→`ip (物理) / ip (虚拟)` 逐条拼接（#76 分组） |

私有：`RULE`（`─`）、`WIDTH=60`、`LABEL_WIDTH=12`、`pad(label, value)`（`│  标签列 值`）、`asyncTag`（`  [异步]`）。

## 依赖关系

无运行时 import（零依赖纯函数）。被 `start.js` 的 `printBanner` 调用；补行路径由宿主后台轮触发。

## 配置键

无——字段全部来自实参；配置值（上游 base、监听地址）由宿主读 `config.json` 后传入。

## 日志错误

本模块不打日志、不抛错。任何缺省字段都降级成占位行或 `unknown`。

## 网络面

零。

## 关联 PR

- #23 端口顺延：`listen.fellBack` 为真时转发行带（已顺延自 N）后缀——已移植。
- #76 LAN 地址分组：`renderLanAddressLine` 消费 rankLanAddresses 输出的物理/虚拟序——已移植。
- #72 监听先行：本模块与之配合——框打全（含 [异步] 占位）不等网络信息——已移植（宿主侧时序在 start.js）。

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `test/unit/banner.test.js` | 框头/框尾/中间行格式、上游行、转发行+Key 尾 4、顺延标注、Key 未生成、中继两态、IP pending/有值/unknown、清单 pending/四段计数、LAN 地址分组/空占位 |
| `test/unit/cli.test.js` | `printBanner` 宿主映射：框头版本、转发行、顺延、Key 尾 4+模型数、lan 关闭文案 |

## 已知边界

- 清单分桶（可用/地区受限/移除）依赖探测轮，未接前只显示 total+占位（start.js 侧）。
- 补行由宿主持有节奏；本模块不知道 30min 刷新周期。
- 框宽 60 列写死；不做终端宽度自适应。

## 变更记录

- 2026-10-08：M4 初版——§8.4 框渲染三函数 + printBanner 接线（cli.test 四断言改写适配框格式）。
