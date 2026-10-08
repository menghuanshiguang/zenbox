# ipinfo.js — 公网出口 IP 的三家降级探测

## 职责边界

按 `config.ip.providers` 顺序（默认 ipify → ipinfo → ipapi）逐家请求公网出口地址，第一个给出可用 `ip` 的即返回。任何一家超时、坏体、非 200 都换下家；三家全挂返回 `{ip: 'unknown', country: '', provider: ''}` 而不是抛错——§8.4 要求 banner/status 不许因 IP 探测全灭崩溃。

模块单发单收：不做定时（30min 节奏由 start.js 后台轮持有）、不缓存、不打日志。响应字段解析各按各家格式（ipify 无国家、ipinfo 用 `country`、ipapi 用 `country_code`）。

## 导出符号表

| 符号 | 类型 | 签名 | 语义 |
| --- | --- | --- | --- |
| `PROVIDER_URLS` | 常量 | `Record<string, string>` | 三家端点：ipify=`api.ipify.org?format=json`、ipinfo=`ipinfo.io/json`、ipapi=`ipapi.co/json` |
| `fetchPublicIp` | 函数 | `(options?) => Promise<{ip, country, provider}>` | 顺序探测；`options.providers` 试验顺序、`options.timeoutMs` 单家超时（默认 4000）、`options.fetchImpl` 注入点（测试桩）；全挂回 `unknown` 三元组 |

私有：`DEFAULT_PROVIDERS`、`DEFAULT_TIMEOUT_MS`、`parse(provider, data)`（三家字段名差异归一）。

## 依赖关系

零 import（纯 fetch）。被 `start.js` 后台轮调用。

## 配置键

- `ip.providers`（数组，默认 `["ipify","ipinfo","ipapi"]`）：试验顺序，即降级顺序。
- `ip.refreshMinutes`（默认 30）：刷新节奏——宿主持有，本模块只管单发。

## 日志错误

不打日志；错误以 catch→换下家消化。宿主轮失败时由 start.js 的 `roundWarn` 记一行。

## 网络面

出网目标白名单成员：GET `config.ip.providers` 点名的三家公开端点（默认 api.ipify.org / ipinfo.io / ipapi.co），单家 AbortController 超时。这是运行时仅有的三处公网 GET 之一（另两处为 opencode 网关与订阅/代理）。无鉴权、无 cookie、无重定向跟随要求。

## 关联 PR

- 无上游 PR 对应——自写（brief §8 `ip` 配置段与 §8.4 公网出口行）。

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `test/unit/ipinfo.test.js` | 首家成功即返回、首家超时降次家、坏体/非 200 换下家、三家全挂回 unknown 不抛、providers 自定义顺序、国家码字段差异（ipinfo `country` vs ipapi `country_code`）、fetchImpl 注入 |

## 已知边界

- 不判断地址是否真的"公网"（routability 检查不在范围）。
- 无 IPv6/IPv4 族偏好逻辑——返回什么用什么。
- 不记录探测历史（趋势/变化检测归宿主 stats，未实现）。

## 变更记录

- 2026-10-08：M4 初版——三家降级 + unknown 兜底 + tsc 注解（PROVIDER_URLS Record 化）。
