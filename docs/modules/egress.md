# egress.js — 全部上游请求共用的可切换出口（回环中继 + client/subscription 双拨号）

## 职责边界

三个发请求的调用点——`src/http.js` 的 `postStreamed`/`getJson`、`src/probe.js` 的 `detectEgress`——过去都是裸 `fetch`；本模块把路由挪到底下：无出口时 `egressFetch` 就是 `fetch`，有出口时改写为向本模块自有的 `127.0.0.1` 临时端口中继发请求，中继校验每次启动随机铸造的 key 后按出口打开隧道、双向管道转发，调用点的 body/headers/signal/`redirect:'error'` 逐字不变。两种出口一个拨号器：`client` 直拨已存在的 http/https/socks5/socks5h 代理；`subscription` 拉起托管 mihomo（proxy-provider 指向订阅 URL + url-test 组每 60s 重测、429 判死剔除），插件只拨本地带认证的 mixed port，从不解析 vless/vmess/trojan URI——协议实现属于自带健康分与组选的专用二进制（不内嵌的理由见模块注释：轻量路径根本表达不了 vless-REALITY）。本模块不下载任何二进制（`findMihomoBinary` 只查找）、不做重试与退避（死子进程的重启退避在 `index.js` `scheduleOutletRestart`）、不管请求构造与配额记账。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `egressActive` | function | `egressActive() → boolean` | 模块级 `activeRelay` 是否非空，即请求会被改道而非直连 |
| `egressFetch` | function | `egressFetch(url, init) → Promise<Response>` | #82 阶梯：无出口直连 `fetch(url, init)`；有出口把 URL 换成 `http://127.0.0.1:<port><path><search>` 并加 `x-ofm-egress-target`（绝对目标 URL）与 `x-ofm-egress-key`（本启动 16 字节 hex）两头；协议非 http(s) 抛 `the egress relay only carries http(s) targets, got "<proto>"`。响应带 `x-ofm-egress-fault`：`refused` 原样返回（网络拒绝不罚）；可重放体（string/Buffer/Uint8Array/无体）的发送前故障（`tunnel`/`no-outlet`）取消体后直连重放一次（direct++）；其余（已发送不可重放/`sent`）原样 502 让调用方分账。无故障头即 `laneHealthy` 清梯 |
| `startEgressRelay` | function | `startEgressRelay({config, dataDir, log=()=>{}, onDead, onFault, onLane, policy}) → Promise<handle>` | 按当前设置起中继：`config` 是 thunk（index.js 每次读 `settings.egress` 的 mode/url/mihomoPath，start.js 传 `{mode:'client', url}`）；`url` 为空抛 `the egress outlet is enabled but empty — paste a proxy address or a subscription link`；client 模式 scheme 不符抛 `unsupported proxy scheme "<proto>" — use http, https, socks5 or socks5h`；subscription 模式解析二进制→铸造 mixed/api 端口与 secret/auth→渲染 `<dataDir>/egress/mihomo.yaml`(0600)→`spawn(binary, ['-d', dir, '-f', configPath])`→`waitForPort` 15s 就绪（失败自 reap 子进程后抛出）→起回环 HTTP 中继。handle 自带 #82 故障梯 `faults{strikes,open,benched,benchUntil,direct,reason,at}` 与 `policy{strikes:3,bypassMs:60_000,bypassMaxMs:600_000}`；`onFault(error)` 首次开口与每次升级时回调、`onLane({transition,strikes,benched,benchUntil,direct})` 状态切换回调（宿主换出口/日志用）。幂等归调用方（index.js `syncEgress` 先 close 旧的）；返回 handle `{port, key, mode, url, outlet, managed, child, log, dead, faults, policy, close}` |
| `renderMihomoConfig` | function | `renderMihomoConfig({subscription, mixedPort, apiPort, secret, auth, logFile}) → string` | 生成 mihomo.yaml：`mixed-port`、`bind-address: 127.0.0.1`、`allow-lan: false`、`authentication: ["ofm:<hex>"]`、`mode: rule`、`log-level: warning`、`external-controller: 127.0.0.1:<apiPort>` + `secret`、`dns.enable: false`、proxy-provider `egress`（http，`interval: 86400`，health-check `http://www.gstatic.com/generate_204` 每 300s `expected-status: 204`——429/错误页即判死节点）、组 `ofm-outlet`（url-test，`tolerance: 50`，`interval: 60`——#82：被限流的节点下一分钟就可能重新入候选）、`rules: MATCH,ofm-outlet` |
| `findMihomoBinary` | function | `findMihomoBinary(explicit) → string` | 显式路径（不存在抛 `the mihomo path "<p>" does not exist`）→ `PATH` → 常见安装目录（win32: `mihomo.exe/verge-mihomo.exe/verge-mihomo-alpha.exe/clash-meta.exe/clash.exe`，含 Clash Verge roots；posix: `mihomo/clash-meta/clash` 与 `/usr/local/bin` 等）；全落空抛 `no mihomo binary found — set its path in the egress settings (Clash Verge installs one, or get it from MetaCubeX/mihomo)` |
| `outletLabel` | function | `outletLabel(url) → string` | `protocol//host`；订阅链接的 path 即凭据，故只露主机名，解析失败返回 `''` |
| `readOutletSelection` | function | `readOutletSelection(relay, {timeoutMs=4000}) → Promise<{node, delayMs} \| null>` | 只对托管 mihomo：GET controller `/proxies/ofm-outlet` 取 `now`，再 GET `/providers/proxies/egress` 读胜者延迟（provider 表 → 组 history → 0 兜底）；client 出口或 url-test 未决返回 `null`；controller 非 2xx/非 JSON/超时抛 `mihomo controller <method> <path> answered <code>` / `sent unparsable JSON` / `timed out`（调用方保留上次数值） |
| `stepOffBlamedAddress` | function | `stepOffBlamedAddress(relay, {hops=1, max=OUTLET_MAX_HOPS, measure, blame, avoidBlocks, avoid, onHop, timeoutMs}?) → Promise<{rotation, hops, blocked}>` | #84 被拒网段连跳：循环至多 `max(1,hops)`（默认 3，`OUTLET_MAX_HOPS`）次 `refreshOutletExit({avoid, avoidBlocks, addressOf: measure})`；`rotation` 为 null 回 `{rotation:null,hops,blocked}`；`switched:false` 即停；每跳把 `rotation.node` 记入 `avoid` 并推进 `names`；`blame` 返回空串（本网段无更多同段节点）提前收手；`measure(node)` 测地址→`addressBlock` 与 `blame` 同段则 `blocked.push({node,address})` 续跳，异段即回；耗尽回 `{rotation:null, hops:attempts, blocked}`；`onHop(node, rotation)` 每跳回调 |
| `refreshOutletExit` | function | `refreshOutletExit(relay, {avoid=[], avoidBlocks=[], addressOf, timeoutMs=4000}) → Promise<{node, delayMs, previous, switched, candidates} \| null>` | #75 配额感知换出口：先 `GET /providers/proxies/egress/healthcheck` 强制全节点重测，再读组 `now` 与 provider 排名；候选经 `rankOutletCandidates`（延迟>0、不在 `avoid`、`addressBlock` 不在 `avoidBlocks`——#84 被拒网段整段排除）按 delay 升序；无 controller（client 单代理）/无候选回 `null` 且出口原封不动；已是最优回 `switched:false`；否则 `PUT /proxies/ofm-outlet {name}` 切换 |
| `egressLane` | function | `egressLane() → {state, strikes, benched, benchUntil, direct, reason, at}` | #82 出口梯状态（读模块级 `activeRelay`，无中继回 `state:'off'` 全零）：`relay`=健康在岗、`direct`=被旁路直连（`benchUntil` 内）、`probing`=直连试验中、`strained`=连击未够门、`relay` 恢复即清梯 |

内部常量与私有件：`RELAY_HOST='127.0.0.1'`、`TARGET_HEADER='x-ofm-egress-target'`、`KEY_HEADER='x-ofm-egress-key'`、`DIAL_TIMEOUT_MS=10_000`、`READY_TIMEOUT_MS=15_000`、`CLIENT_SCHEMES={http:,https:,socks5:,socks5h:}`、`HOP_BY_HOP`（九个逐跳头，含 `transfer-encoding`——Node 自行推导成帧），#82 新增 `FAULT_HEADER='x-ofm-egress-fault'`、`LANE_STRIKES=3`（开口前连击门）、`LANE_BYPASS_MS=60_000`（首窗）、`LANE_BYPASS_MAX_MS=10*60_000`（窗上限）、`PRE_SEND_FAULTS={'tunnel','no-outlet'}`（发送前故障才可重放），以及 `relayRequest`/`openTunnel`/`netConnect`/`httpConnect`(非 2xx 抛 `the proxy …`，401/403/407 置 `refusal.refusal` 让故障分账判 `refused`)/`socks5Connect`(RFC1928+可选1929，`socks5h` 交代理解析域名)/`encodeAddress`/`readUntil`/`withTimeout`/`freePort`/`waitForPort`/`killChild`(先礼后 SIGKILL，3s)/`sameSecret`(`timingSafeEqual` 恒时比较，长度 ≥16 且相等)/`sendLocal(res,status,message,extra?)`/`failOnce(res,error,fault)`（`refusal` 有值→标 `refused`，否则按 fault 标 `sent`/`tunnel`；detail 区分 after/before the request was sent；502 + `x-ofm-egress-fault` 头）/`replayable(body)`/`laneBenched`/`laneHealthy`/`laneFault`/`egressLaneOf`/`controllerJson(managed, path, timeoutMs, {method='GET', body}?)`（2xx 即过——mihomo 的切换与强制健康检查答 204 无体 → 解析为 `null`；body 自带 content-type/length）。

## 依赖关系

- **import 进来**: `node:fs`（写 mihomo.yaml、查二进制）、`node:net`（隧道 TCP、端口探测、`freePort`）、`node:tls`（https 目标与 https 代理握手，ALPN 仅 `http/1.1`）、`node:http`（中继 server、每请求 one-shot `http.Agent`、controllerJson）、`node:path`、`node:crypto`（`randomBytes` 铸 key/secret/auth、`timingSafeEqual`）、`node:dns/promises`（`lookup`——仅 `socks5`（非 h）本地解析）、`node:child_process`（`spawn` 托管 mihomo）。
- **被谁依赖**: `src/http.js`（`egressFetch`，全部上游流量）；`src/probe.js`（`egressFetch`，echo 源）；`index.js`（`startEgressRelay, outletLabel, readOutletSelection`——`syncEgress`/`syncEgressOnce`/`scheduleOutletRestart`/`publicSettings` 的出口呈现）；`test/upstream/egress-test.test.mjs`。

## 配置键

| 键 | 默认值 | 读取位置 | 语义 |
| --- | --- | --- | --- |
| `egress.enabled` | `false` | `SETTINGS_INITIAL` → index.js `syncEgressOnce`（决定是否调 `startEgressRelay`） | 出口总开关；关则直连 |
| `egress.mode` | `'subscription'` | `SETTINGS_INITIAL` → index.js 注入的 `config()` thunk → `startEgressRelay` | `subscription`=托管 mihomo；`client`=直拨给定代理 URL（仅这两值，index.js 设置路由 400 校验） |
| `egress.url` | `''` | 同上 | 订阅链接或代理 URL；空且 enabled 时 index.js 以 `the outlet needs a subscription or proxy URL` 拒绝 |
| `egress.mihomoPath` | `''` | 同上 → `findMihomoBinary` | 显式 mihomo 系二进制路径；空则按 PATH/安装目录搜寻 |
| `egress.mode`（新配置层） | `'direct'` | src/config.js `DEFAULTS.egress`（允许集 `direct\|proxy\|subscription` 三态，CLI `--egress` / env `OFM_EGRESS`）→ start.js `start` 命令 | 出口三态由 config 切换（承接 PR #45/#207 口径）：`direct` 不起中继；`proxy` 映射为 `{mode:'client', url: egress.proxy.url, password: egress.proxy.password}`（密码走独立字段，拨号时才合成进 outlet.url）；`subscription` 映射为 `{mode:'subscription', url: egress.subscription.url}` 起受管 mihomo。起不来就退出，不悄悄改走直连。config.json 同键样张 |

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
| #75 | 已移植（M3，port-of #75） | `refreshOutletExit({avoid})` 落 `src/egress.js`（强制 provider healthcheck 全测→按 avoid 过滤取最优→PUT 切换；`controllerJson` 升级 method/body/2xx/空体）；`src/adapter.js` catch 里 `CODE.quota → onQuotaHit`（`src/http.js` `CODE.quota='RATE_LIMIT'`）；冷却（60s）、`limitedNodes` TTL（10min）、单飞轮换的宿主半装配在 start.js（M3 后续接线）；README 口径随 M5 README 重写 |
| #82 | 已移植（M3，port-of #82） | `x-ofm-egress-fault` 三类分账（`sent` 已发送不可重放/`tunnel` 发送前可重放/`refused` 无罚）落 `src/egress.js`：`egressFetch` 阶梯（bench 中直连、故障头→laneFault、可重放体 cancel 后直连重放一次、恢复→laneHealthy 清梯）、`egressLane()` 状态导出、`laneFault` 连击门（`policy.strikes=3`）与指数旁路窗（60s×2^n 封顶 600s）、中继侧 `sent` 标志与 `failOnce` 分账、`httpConnect` 401/403/407 拒绝识别、url-test 组 `interval: 300→60`；宿主半（`onFault→scheduleOutletRotation`/`onLane` 日志、冷却 60s+单飞）落 start.js |
| #84 | 已移植（M3，port-of #84） | `src/egress.js`：`addressBlock`（IPv4 /24、IPv6 至多 3 组 /48 的网段键，非法回 `''`）+ `siblingKey`（去尾数兄弟键）+ `rankOutletCandidates`（被拒网段整段跳过、未测节点给一次、兄弟降级、延迟升序）+ `refreshOutletExit` 增 `avoidBlocks`/`addressOf` + `stepOffBlamedAddress`（同网段连跳 ≤3）；`src/adapter.js` QUOTA_RETRY_LIMIT=1 拒后重发（onQuotaHit 返回 true 才重发、attempt 回退、refusalRetry 跳过 finishTurn）；`src/store.js` usage 行 refusal 标记；start.js 单飞轮换 refusal 模式 |
| #45 | 已部分移植（M3，port-of #45 = egress.mode=proxy） | 落点：`src/config.js` EGRESS_MODES 三态 + `src/egress.js` client 分支 `cfg.password` 独立字段合成（url 永不含密码、内联优先——日志/状态/配置行可带地址不带凭据；`outletLabel` 抹路径凭据已有）+ start.js 三态映射（proxy→client、subscription→受管 mihomo）。**不移植**：secret.js 平台 seal（DPAPI/AES）——无 Web UI，密码按 config 三途径存；`scripts/proxy-test.mjs` 三 scheme 握手断言由 egress-test 假 socks5/CONNECT 替身覆盖 |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| `test/upstream/egress-test.test.mjs` | 实测 `PASS: egress 59/59 checks`（全回环双替身，不触网）：假 socks5（带/不带认证）与假 HTTP CONNECT 拨号、echo 目标（429 透传、`/stream` 分片节奏）、`egressFetch` 改道与直通、错误 key 三连拒 403、`file:///` 拒绝、方法/体/头（`x-keep`）逐字转发、`socks5h` 域名块（atyp 3）、CONNECT PUT 载荷、`renderMihomoConfig` 渲染、`findMihomoBinary`、`outletLabel`、`readOutletSelection`；**第13节 outlet rotation（#75，9 断言）**：null/无 controller 两态、假 controller 三路由（healthcheck 204 函数路由、组、provider 表）断言首个调用必是强制全测、旋转结果五元组、PUT body 换到 JP4、唯一被拒节点→null 零 PUT、已是最优→`switched:false` 零 PUT。托管 mihomo 真拉起不在离线门禁内（文件头注明属安装期 smoke） |
| `test/upstream/retry-safety-test.test.mjs` | 实测 `retry-safety: all 8 failure shapes…`（8 形态分类/重试/持久日志）；**#75 quota hook**：`onQuotaHit` 只收 `quota-model-free` 一击（传输失败与地区拒绝不许触发换出口钩子） |
| `test/upstream/failover-test.test.mjs` | 实测 `PASS: failover 41/41 checks`（#82 主测试，假 CONNECT 出口四态 ok/cut/stall/refuse + 假 gateway）：携带流量无罚、首击+可重放体直连重放恰拨一号、AbortController 中断不计、第二击进旁路窗（首窗≤150ms、`onLane bench`、被旁路流量不增 connect）、窗口关→probing 试验失败即重开（双窗≤300ms）、恢复→200+全梯清+`lanes='bench,bench,relay'`、指数窗 `'150,300,600,1200'` 封顶、不可重放体（已发送 stall / URLSearchParams）→502+头 `sent`/`tunnel` 且零直连零罚、407 拒绝→502+头 `refused` 零罚 |

## 已知边界

- 不实现 vless/vmess/trojan 等协议，也不下载二进制：缺 mihomo 是设置页可解释的错误，不是静默 fetch。
- 超时模型固定：拨号/TLS/握手 10s、mihomo 就绪 15s、`readUntil` 收满 16KB 未完成即拒；中继每请求新隧道（`keepAlive: false`），不复用。
- `client` 出口没有 controller，`readOutletSelection` 恒 `null`；url-test 未定档时同样 `null`。
- 死子进程的重试策略归 index.js（退避 `scheduleOutletRestart`），本模块只上报一次死亡；启动中途失败的子进程由 `startEgressRelay` 自己 reap（`killChild`）。
- #75/#82/#84 与 #45 三态均已移植（模块层 + start.js 宿主：冷却 60s、单飞、`limitedNodes` 10min 候补，`onQuotaHit`/`onFault` 双路汇入 `scheduleOutletRotation`；proxy 密码独立字段、subscription 起受管 mihomo）。密码平台 seal 不进 v0.1（无 Web UI，§13 仅三途径配置）。
- 中继不缓冲流（体与 SSE 都按字节过），依赖 Node 自身流控维持 chunk 节奏。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- M0：新配置层 `src/config.js` 以 `egress.mode: {direct, proxy}` 承接 PR #45 的 proxy 语义；与 `SETTINGS_INITIAL.egress.mode: subscription|client` 双层并存，运行时接线待入口重建。
- 2026-10-08 M3：port-of #75 落地——`refreshOutletExit` 导出 + `controllerJson` 升级（method/body、2xx 通过、204 空体→null）；`egress-test` 第13节 9 断言红→绿（59/59），`retry-safety-test` quota hook 红→绿。
- 2026-10-08 M3：port-of #82 落地——故障梯（`laneFault`/`laneHealthy`/`laneBenched`/`replayable`）、`egressLane()` 导出、中继 `sent` 标志与 `failOnce` 三类分账、`httpConnect` 拒绝识别、组 `interval: 60`；`test/upstream/failover-test.test.mjs` 41 断言红→绿；start.js 宿主半（`onFault`/`onLane`/`onQuotaHit` → 60s 冷却单飞轮换、config `proxy`→client 映射）。
- 2026-10-08 M3：port-of #84 落地——`addressBlock`/`siblingKey`/`rankOutletCandidates`/`stepOffBlamedAddress` + `refreshOutletExit({avoid,avoidBlocks,addressOf})` 升级；`egress-test` 第14节 18 断言红→绿（77/77）。
- 2026-10-08 M3：port-of #45 落地——EGRESS_MODES 三态 `direct|proxy|subscription`；client 分支 `cfg.password` 独立字段合成拨号 URL（内联优先）；start.js 三态映射；`egress-test` 第15节 proxy 用例三断言+scheme 拒名（81/81）、config.test 三态放行（29 passed）红→绿。
