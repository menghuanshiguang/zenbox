# egress.js — 全部上游请求共用的可切换出口（回环中继 + client/subscription 双拨号）

## 职责边界

三个发请求的调用点——`src/http.js` 的 `postStreamed`/`getJson`、`src/probe.js` 的 `detectEgress`——过去都是裸 `fetch`；本模块把路由挪到底下：无出口时 `egressFetch` 就是 `fetch`，有出口时改写为向本模块自有的 `127.0.0.1` 临时端口中继发请求，中继校验每次启动随机铸造的 key 后按出口打开隧道、双向管道转发，调用点的 body/headers/signal/`redirect:'error'` 逐字不变。两种出口一个拨号器：`client` 直拨已存在的 http/https/socks5/socks5h 代理；`subscription` 拉起托管 mihomo（proxy-provider 指向订阅 URL + url-test 组每 300s 重测、429 判死剔除），插件只拨本地带认证的 mixed port，从不解析 vless/vmess/trojan URI——协议实现属于自带健康分与组选的专用二进制（不内嵌的理由见模块注释：轻量路径根本表达不了 vless-REALITY）。本模块不下载任何二进制（`findMihomoBinary` 只查找）、不做重试与退避（死子进程的重启退避在 `index.js` `scheduleOutletRestart`）、不管请求构造与配额记账。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `egressActive` | function | `egressActive() → boolean` | 模块级 `activeRelay` 是否非空，即请求会被改道而非直连 |
| `egressFetch` | function | `egressFetch(url, init) → Promise<Response>` | 无出口直连 `fetch(url, init)`；有出口把 URL 换成 `http://127.0.0.1:<port><path><search>` 并加两个头：`x-ofm-egress-target`（绝对目标 URL）、`x-ofm-egress-key`（本启动的 16 字节 hex）；协议非 http(s) 抛 `the egress relay only carries http(s) targets, got "<proto>"` |
| `startEgressRelay` | function | `startEgressRelay({config, dataDir, log=()=>{}, onDead}) → Promise<handle>` | 按当前设置起中继：`config` 是 thunk（index.js 每次读 `settings.egress` 的 mode/url/mihomoPath）；`url` 为空抛 `the egress outlet is enabled but empty — paste a proxy address or a subscription link`；client 模式 scheme 不符抛 `unsupported proxy scheme "<proto>" — use http, https, socks5 or socks5h`；subscription 模式解析二进制→铸造 mixed/api 端口与 secret/auth→渲染 `<dataDir>/egress/mihomo.yaml`(0600)→`spawn(binary, ['-d', dir, '-f', configPath])`→`waitForPort` 15s 就绪（失败自 reap 子进程后抛出）→起回环 HTTP 中继。幂等归调用方（index.js `syncEgress` 先 close 旧的）；返回 handle `{port, key, mode, url, outlet, managed, child, log, dead, close}` |
| `renderMihomoConfig` | function | `renderMihomoConfig({subscription, mixedPort, apiPort, secret, auth, logFile}) → string` | 生成 mihomo.yaml：`mixed-port`、`bind-address: 127.0.0.1`、`allow-lan: false`、`authentication: ["ofm:<hex>"]`、`mode: rule`、`log-level: warning`、`external-controller: 127.0.0.1:<apiPort>` + `secret`、`dns.enable: false`、proxy-provider `egress`（http，`interval: 86400`，health-check `http://www.gstatic.com/generate_204` 每 300s `expected-status: 204`——429/错误页即判死节点）、组 `ofm-outlet`（url-test，`tolerance: 50`，`interval: 300`）、`rules: MATCH,ofm-outlet` |
| `findMihomoBinary` | function | `findMihomoBinary(explicit) → string` | 显式路径（不存在抛 `the mihomo path "<p>" does not exist`）→ `PATH` → 常见安装目录（win32: `mihomo.exe/verge-mihomo.exe/verge-mihomo-alpha.exe/clash-meta.exe/clash.exe`，含 Clash Verge roots；posix: `mihomo/clash-meta/clash` 与 `/usr/local/bin` 等）；全落空抛 `no mihomo binary found — set its path in the egress settings (Clash Verge installs one, or get it from MetaCubeX/mihomo)` |
| `outletLabel` | function | `outletLabel(url) → string` | `protocol//host`；订阅链接的 path 即凭据，故只露主机名，解析失败返回 `''` |
| `readOutletSelection` | function | `readOutletSelection(relay, {timeoutMs=4000}) → Promise<{node, delayMs} \| null>` | 只对托管 mihomo：GET controller `/proxies/ofm-outlet` 取 `now`，再 GET `/providers/proxies/egress` 读胜者延迟（provider 表 → 组 history → 0 兜底）；client 出口或 url-test 未决返回 `null`；controller 非 200/非 JSON/超时抛 `mihomo controller <path> answered <code>` / `sent unparsable JSON` / `timed out`（调用方保留上次数值） |

内部常量与私有件：`RELAY_HOST='127.0.0.1'`、`TARGET_HEADER='x-ofm-egress-target'`、`KEY_HEADER='x-ofm-egress-key'`、`DIAL_TIMEOUT_MS=10_000`、`READY_TIMEOUT_MS=15_000`、`CLIENT_SCHEMES={http:,https:,socks5:,socks5h:}`、`HOP_BY_HOP`（九个逐跳头，含 `transfer-encoding`——Node 自行推导成帧），以及 `relayRequest`/`openTunnel`/`netConnect`/`httpConnect`/`socks5Connect`(RFC1928+可选1929，`socks5h` 交代理解析域名)/`encodeAddress`/`readUntil`/`withTimeout`/`freePort`/`waitForPort`/`killChild`(先礼后 SIGKILL，3s)/`sameSecret`(`timingSafeEqual` 恒时比较，长度 ≥16 且相等)/`sendLocal`/`failOnce`/`controllerJson`。

## 依赖关系

- **import 进来**: `node:fs`（写 mihomo.yaml、查二进制）、`node:net`（隧道 TCP、端口探测、`freePort`）、`node:tls`（https 目标与 https 代理握手，ALPN 仅 `http/1.1`）、`node:http`（中继 server、每请求 one-shot `http.Agent`、controllerJson）、`node:path`、`node:crypto`（`randomBytes` 铸 key/secret/auth、`timingSafeEqual`）、`node:dns/promises`（`lookup`——仅 `socks5`（非 h）本地解析）、`node:child_process`（`spawn` 托管 mihomo）。
- **被谁依赖**: `src/http.js`（`egressFetch`，全部上游流量）；`src/probe.js`（`egressFetch`，echo 源）；`index.js`（`startEgressRelay, outletLabel, readOutletSelection`——`syncEgress`/`syncEgressOnce`/`scheduleOutletRestart`/`publicSettings` 的出口呈现）；`scripts/egress-test.mjs`。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `egress.enabled` | `false` | `SETTINGS_INITIAL` → index.js `syncEgressOnce`（决定是否调 `startEgressRelay`） | 出口总开关；关则直连 |
| `egress.mode` | `'subscription'` | `SETTINGS_INITIAL` → index.js 注入的 `config()` thunk → `startEgressRelay` | `subscription`=托管 mihomo；`client`=直拨给定代理 URL（仅这两值，index.js 设置路由 400 校验） |
| `egress.url` | `''` | 同上 | 订阅链接或代理 URL；空且 enabled 时 index.js 以 `the outlet needs a subscription or proxy URL` 拒绝 |
| `egress.mihomoPath` | `''` | 同上 → `findMihomoBinary` | 显式 mihomo 系二进制路径；空则按 PATH/安装目录搜寻 |
| `egress.mode`（新配置层） | `'direct'` | src/config.js `DEFAULTS.egress`（允许集 `direct\|proxy`，CLI `--egress` / env `OFM_EGRESS`） | M0 新配置层的出口模式，承接 PR #45 的 proxy 语义；由 `start.js` 消费，**尚未接线到 egress.js**（运行时仍读 settings 注入的 `subscription\|client`），config.json 尚在建设（M0 补） |

## 日志错误

| 日志/错误 | 触发条件 | 去向 |
| --- | --- | --- |
| `managed mihomo on 127.0.0.1:<mixed> (controller 127.0.0.1:<api>)` | 托管子进程就绪 | `log` → index.js `logger.info`（前缀 `our-free-model egress: `） |
| `the managed mihomo process exited`、`…; a restart has been scheduled` | 启动后子进程退出 | 置 `handle.dead`、`log` 一次、触发 `onDead` → index.js 指数退避重启（15s×2^n，封顶 600s；运行 ≥120s 重置） |
| `relay: refused a caller without this start's key` | 中继收到无 key/键不符请求 | 客户端得 403 `{"error":"the egress relay answers its own plugin only"}`（任何拨号前拒绝） |
| `relay: <METHOD> → <scheme//host> (outlet ok\|none)` | 每个过中继的请求 | `log`；只记 host 不记 query（query 常携带凭据） |
| `relay: response <status> for <host> started`、`relay: response for <host> closed before finish (writableEnded=…)`、`relay: sendLocal(<n>) after headers, destroying` | 响应阶段各支路 | `log` |
| `egress relay: tunnel to <host> failed: …`、`egress relay: upstream body for <host> failed: …`、`egress relay: <host> failed: …` | 隧道/上行体/收尾异常 | `log`；客户端 502 `egress tunnel failed: …`（`failOnce`，headers 已发则 destroy） |
| 400 `the egress relay needs a full x-ofm-egress-target target URL`、400 `… carries http(s) targets only, got "<proto>"`、502 `the egress relay is not running` | 目标头缺失/协议不符/outlet 空 | `sendLocal` JSON 拒绝 |
| 抛出串：`timed out after <ms>ms: <what>`、`the proxy sent more than 16KB without finishing the <what>`、`the proxy closed during the <what>`、`the proxy answered "<line>" to CONNECT`、`the proxy refused CONNECT with <code>`、`the socks5 proxy answered version <n>` / `demands credentials this outlet does not have` / `rejected the credentials` / `selected method <n>, expected 0 (none) or 2 (user/pass)` / `refused the connection (code <n>)` / `reply started with <n>` / `used unknown address type <n>`、`unexpected IPv6 literal "<a>"`、`the port 127.0.0.1:<p> never opened within <ms>ms`、`mihomo could not start (<msg>)`、`mihomo exited (<sig/code>) — see <dir>/mihomo.log` | 拨号/握手/就绪各失败点 | `startEgressRelay` 上抛 → index.js `logger.warn` 并置 `outletError` 供设置页展示 |

## 网络面

- **回环中继（本模块自有）**：`http` server 绑 `127.0.0.1:0`（每次随机端口），仅服务携带本启动 key 的 `egressFetch`；非本插件调用在任何拨号前被 403 拒绝——刻意不是开放代理。随 `handle.close()` 关闭并 destroy 全部 socket。
- **client 出口**：TCP 拨向用户给定 URL 的主机端口（`http:`/`https:` 走 CONNECT，`https:` 先代理 TLS；`socks5:`/`socks5h:` 走 RFC1928 握手，`socks5h` 把域名交代理解析），每次拨号预算 10s。
- **subscription 出口**：`spawn` 托管 mihomo；其 mixed port `127.0.0.1:<freePort>` 带 `authentication` 凭据（`ofm:<hex>`，只有本模块的 outlet URL 持有）、external-controller `127.0.0.1:<freePort>` 持 `secret`。mihomo 自身外联：拉取**订阅 URL**（provider，`interval: 86400`——URL 即 bearer 凭据，写入 0600 的 `<dataDir>/egress/mihomo.yaml`、从不入日志、设置页只显示主机名）、健康检查与 url-test 一律打 `http://www.gstatic.com/generate_204`（每 300s，期望 204）。日志文件 `<dataDir>/egress/mihomo.log`。
- **controller 读数**：`GET http://127.0.0.1:<apiPort>/proxies/ofm-outlet` 与 `/providers/proxies/egress`，`Authorization: Bearer <secret>`（`readOutletSelection`，4s 预算）。
- **过隧道的目标流量**：中继按 `x-ofm-egress-target` 的主机端口出站（本车道上游即 `https://opencode.ai` 的 `/zen/v1/*`，由调用点决定），https 在隧道内补 TLS 握手（`servername` 取主机名，IP 字面量不带）；`redirect:'error'` 保证 3xx 是响应而非绕开出口的第二跳。可随出口关闭整体停用。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| #75 | 待移植 | `onQuotaHit` → `refreshOutletExit({avoid})` 换出口逻辑；**当前代码未含**（429 只由 mihomo 健康检查 `expected-status: 204` 判死节点，无 quota 命中回调） |
| #82 | 待移植 | egress 故障切换与 `x-ofm-egress-fault` 三类分账；**当前代码未含**（`HOP_BY_HOP` 与中继头集合中无此头，故障只表现为 502 与死子进程重启） |
| #84 | 待移植 | 被拒换同区节点重发且不重复计费；**当前代码未含**（中继每请求单隧道、无重发路径，计费在 `src/store.js` 按到达 usage 记） |
| #45 | 部分移植 | 落点=`egress.mode=proxy`：213KB diff 吸收的 proxy/secret 逻辑经由 M0 新配置层承接（`src/config.js` `egress.mode ∈ {direct, proxy}`）；运行时 `egress.js` 仍只认 settings 注入的 `subscription\|client`，proxy 模式接入当前代码未含（待 M0 入口接线） |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `scripts/egress-test.mjs` | 实测 `PASS: egress 50/50 checks`（全回环双替身，不触网）：假 socks5（带/不带认证）与假 HTTP CONNECT 拨号、echo 目标（429 透传、`/stream` 分片节奏）、`egressFetch` 改道与直通、错误 key 三连拒 403、`file:///` 拒绝、方法/体/头（`x-keep`）逐字转发、`socks5h` 域名块（atyp 3）、CONNECT PUT 载荷、`renderMihomoConfig` 渲染、`findMihomoBinary`、`outletLabel`、`readOutletSelection`。托管 mihomo 真拉起不在离线门禁内（文件头注明属安装期 smoke） |

## 已知边界

- 不实现 vless/vmess/trojan 等协议，也不下载二进制：缺 mihomo 是设置页可解释的错误，不是静默 fetch。
- 超时模型固定：拨号/TLS/握手 10s、mihomo 就绪 15s、`readUntil` 收满 16KB 未完成即拒；中继每请求新隧道（`keepAlive: false`），不复用。
- `client` 出口没有 controller，`readOutletSelection` 恒 `null`；url-test 未定档时同样 `null`。
- 死子进程的重试策略归 index.js（退避 `scheduleOutletRestart`），本模块只上报一次死亡；启动中途失败的子进程由 `startEgressRelay` 自己 reap（`killChild`）。
- #75/#82/#84 的配额感知换出口、故障分账、同区重发当前代码未含；#45 只到配置层（`direct|proxy`）部分移植。
- 中继不缓冲流（体与 SSE 都按字节过），依赖 Node 自身流控维持 chunk 节奏。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- M0：新配置层 `src/config.js` 以 `egress.mode: {direct, proxy}` 承接 PR #45 的 proxy 语义；与 `SETTINGS_INITIAL.egress.mode: subscription|client` 双层并存，运行时接线待入口重建。
