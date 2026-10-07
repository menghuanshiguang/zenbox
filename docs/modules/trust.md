# trust.js — 插件 HTTP 面的请求信任栅栏（Host/Origin/Referer 结构层 + 连接接纳层）

## 职责边界

在监听 socket accept 之后、业务路由之前回答"这个请求配不配被处理"。两层各管一件事：**连接接纳层**（`connectionAdmissionView` + `rejectionFor`）把调用方注入的 `admit`/`requestRejection` 语义归一——注意文件头的教训：许多客户端只带 Host 没带 Origin，此时拒绝只能由**连接本身**的接纳逻辑给出，而校验用户在不在本机是服务边界的事务、不是这个结构层的（结构层看得见的证据只有三个头）；**结构栅栏层**（`structuralRejection`）是纯头证据：本机地址 + 同源 + 桌面中继必须带浏览器标记，任何一条不满足即拒——它认证据、不认身份，是端口打开后唯一站在 socket 和内容之间的闸。桌面应用的中继用 `dsh-app://app` 这样的私有 scheme 给回环浏览器送 Origin（文件头注明）；Referer 信标只认 `dsh-app://app` 且带浏览器标记、无凭据无端口。**结构层刻意复刻而非调用内核 `isTrustedApiRequest`**（可漂移的有意选择，文件引 issue #89）：内核在 `adapter/kernel.js`，本模块零依赖，测试用真视图而非夹具。本模块不实现 CORS/PNA 头、不记录密钥、不碰 authn/授权、不改请求体。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `isLoopbackHost` | function | `isLoopbackHost(value) → boolean` | 逐字符命中 `LOOPBACK_NAMES={'127.0.0.1','[::1]','::1','localhost'}`（含 IPv6 方括号形态）；大小写经原样比较收在集合内 |
| `connectionAdmissionView` | function | `connectionAdmissionView(service) → {admit, requestRejection}` | 把注入服务归一成视图：getter **迟绑定**（每次取都重读 service 当前状态）、函数即 thunk 调用取值；`service` 无 `admit` 但有 `requestRejection` 时，把裸状态值包成 `{rejection}`（issue #89 对 304 无 body 响应的分类） |
| `rejectionFor` | function | `rejectionFor(req, connection, onRejection) → status\|undefined` | 决策序：① `view.admit(req)` 返回 falsy → `view.requestRejection(status)`（无值给 `{status:503, source:'connection', reason:'empty-rejection'}`）→ 否则回 fall-through `undefined`；② ①未决且 `requestRejection(req)` 返回 status → 直接用（`reason` 缺失补 `'unspecified'`）；③ ①②都抛 → `{status:503, source:'connection', reason:'admission-error'}`；④ 以上全未决 → `structuralRejection(req)` → 403 `{source:'structural', reason}`。`onRejection` 固定字段 `{status, source, reason}`、**回调本身抛错被吞**（诊断永不破坏主流程） |
| `structuralRejection` | function | `structuralRejection(req) → {rejection}\|undefined` | 纯结构层：`admit(req)` 分支见上；否则逐条短路——`Host` 不 loopback → `host-not-loopback`；跨站证据（Origin/Referer 存在但 `state==='cross-site'`）→ `cross-site`；桌面中继痕迹（Origin/Referer 是 dsh-app 系 + 浏览器标记）无信标 → `desktop-relay-markers`；`Origin` 缺凭据/端口非法 → `origin-invalid`；`Referer` 同理 → `referer-invalid`；Origin 存在且 authority ≠ Host → `origin-mismatch`；Referer 同理 → `referer-mismatch`；全过 → `undefined` |

私有件：`TRUST_ISSUE`（文件头的 issue 链注释：#89 connect 层接纳、#90 缺 Origin 的窗口句柄、#49 desktop relay）、`isDesktopRelayOrigin`、`isDesktopRelayReferer`（只认 scheme `dsh-app:`、host `app`、无凭据、无显式端口，且带 `Origin-Agent-Cluster`/`Sec-Fetch-*`/`User-Agent` 之一的浏览器标记——"浏览器里开的 dsh://链接"）、`authorityOf(value)`（解析 `Host`/`Origin`/`Referer`，仅 `http:`/`https:`，无端口按 80/443 归一；`dsh-app` 不在解析域内）、`structuralReason`（其内部另有循环 `hasBrowserMarker` 与 `isDesktopRelayOrigin`）。

## 依赖关系

- **import 进来**: 无（零 import 纯函数——可被原样提取）。
- **被谁依赖**: `index.js`（`rejectionFor`、`isLoopbackHost`、`connectionAdmissionView`——HTTP 监听器与 LAN/forward 接纳判定）；`scripts/trust-test.mjs`（全部四个导出）。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| 无 | — | — | 本模块不读任何 `config.`/settings 键；`admit`/`requestRejection` 由调用方（index.js 的连接接纳服务）注入，注入什么读什么 |

（相邻的 `listen.host`/`lan.enabled` 决定 socket 绑定面，归 `src/config.js`/`store.js`，不在本文件。）

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| 无日志 | 结构层是静默的——"每个门外的浏览器只知道自己被拒，拿不到任何诊断"（文件头） | 诊断仅经 `onRejection` 回调交还调用方 |
| `{status:503, source:'connection', reason:'admission-error'}` | `admit`/`requestRejection` 抛异常 | 决策值（不是异常），主流程不中断 |
| `{status:503, source:'connection', reason:'empty-rejection'}` / `{status:403, source:'structural', reason:…}` | 见符号表 | 同上；`reason` 枚举：`host-not-loopback`/`cross-site`/`desktop-relay-markers`/`origin-invalid`/`referer-invalid`/`origin-mismatch`/`referer-mismatch`/`unspecified` |

## 网络面

不建立连接，但定义**入向准入**：对 `127.0.0.1`（及 LAN 启用时的入站）请求做 Host/Origin/Referer 三头结构审查。自身无端口、无出向流量；被 index.js 的 HTTP 服务与 `src/forward.js`/中继的接纳调用使用（forward 自带的局域网对 key/本机回环门在 forward.js，不在这里）。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| 无直接 PR | — | 见 docs/pr-coverage.md（该文件当前未创建，M0 补）；代码内注释引 issue #89、#90、#49，相邻文档 docs/issue-49-desktop-trust.md |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/trust-test.mjs` | 实测全绿（`trust-test: OK`，21 项）：结构栅栏全分支（host-not-loopback / cross-site / origin-invalid / referer-invalid / origin-mismatch / referer-mismatch / 全过放行）；桌面中继矩阵（`dsh-app://app` 带浏览器标记放行、无信标拒 `desktop-relay-markers`、带凭据/端口拒）；接纳层（`admit` 决断 → `requestRejection` 取值、裸状态值包 `{rejection}`、双存在优先 admit、抛错 → 503 `admission-error`、回调固定字段且回调抛错被吞）；迟绑定视图（thunk 每次重读） |

## 已知边界

- **结构层是复刻不是调用**：与 `adapter/kernel.js` `isTrustedApiRequest` 的实现可独立漂移（有意选择，见 TRUST_ISSUE 注释与 issue #89）；改动其中一处必须对照另一处与 `scripts/trust-test.mjs`。
- 认证据不认身份：本模块不解析任何凭据/密钥/token；"用户是否在本机"归连接接纳服务（注入的 `admit`）。
- 不发 CORS/PNA 响应头：`rejectionFor` 只给状态与诊断结构，头由调用方补。
- `authorityOf` 的端口归一只覆盖 `http:`/`https:`；非 http(s) 的 Origin/Referer 视为非法（`*-invalid`）。
- `isLoopbackHost` 是精确集合匹配，不做 CIDR/网段推导（`127.0.0.1` 之外的回环段一律不算本机）。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 本仓库无改动（cut 未触及 trust.js）；`connectionAdmissionView` 的迟绑定与 issue #89 包装为上游既有语义。
