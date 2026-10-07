# zenbox 模块文档索引（docs/INDEX.md）

## ① 模块索引

# adapter.js — 免密网关的 provider 适配器：双路由注册、三种线上协议转换、流式读取与有界断流续写
# catalog.js — 免费车道模型目录：上游清单与本地能力表合并
# channel.js — 回调源到异步迭代消费者的单生产者单消费通道
# config.js — 四层配置装载与逐字段校验，非法即拒绝启动
# effort.js — 推理努力档位到生成预算与请求补丁的换算策略
# egress.js — 全部上游请求共用的可切换出口（回环中继 + client/subscription 双拨号）
# forward.js — OpenAI 兼容转发监听器与 LAN 中继：本机回环接收外部 harness 请求，鉴权转译后以调用方拼写流式回传
# http.js — 出站请求与 SSE 读取：体态嗅探、头窗重放、网关失败到中立错误码的分类
# messages.js — harness 消息词表到三种上游线形的出站投影与工具 schema 转换
# probe.js — 模型可用性探测与出口公网地址探测
# recovery.js — 缺终帧与纯思考空停的有界续写恢复策略及配套工具
# store.js — 插件自有 JSON 持久化与用量统计累计
# stream.js — 三种上游 SSE 载荷到 harness StreamChunk 的同步投影与用量核算
# trust.js — 插件 HTTP 面的请求信任栅栏（Host/Origin/Referer 结构层 + 连接接纳层）
# turn.js — 转发口一次请求的语义链：OpenAI 拼写→harness 消息→适配器流→outcome 折叠
# upstream.js — 免密车道的上游线缆契约：标识铸造、端点与线形路由、指纹头与工具指纹门

以上每行与 `docs/modules/<名字>.md` 首行逐字一致（gates.test 校验）。

## ② 依赖速览

<!-- deps:begin 由 scripts/gen-deps.mjs 生成，禁止手改 -->
- adapter.js → channel.js, effort.js, http.js, messages.js, recovery.js, stream.js, upstream.js
- catalog.js → upstream.js
- channel.js → （无本地依赖）
- config.js → effort.js
- effort.js → （无本地依赖）
- egress.js → （无本地依赖）
- forward.js → upstream.js
- http.js → egress.js, upstream.js
- messages.js → upstream.js
- probe.js → egress.js, http.js, upstream.js
- recovery.js → （无本地依赖）
- store.js → （无本地依赖）
- stream.js → http.js, upstream.js
- trust.js → （无本地依赖）
- turn.js → adapter.js, forward.js, probe.js
- upstream.js → （无本地依赖）
- start.js → config.js
<!-- deps:end -->

## ③ 阅读路径

1. **跑起来看现状**：`docs/start-cli.md`（六命令与 banner 字段）→ `config.json` 注释（全部配置键）→ `src/config.js` 对应文档 `docs/modules/config.md`。
2. **理解一次转发请求的主链路**：`docs/modules/forward.md`（监听/鉴权转译/LAN 中继）→ `docs/modules/adapter.md`（provider 路由与线上协议转换）→ `docs/modules/messages.md`（消息与工具投影）→ `docs/modules/stream.md`（SSE 到 StreamChunk）→ `docs/modules/upstream.md`（端点与线形契约）。
3. **理解网络与可靠性面**：`docs/modules/http.md`（出站与错误分类）→ `docs/modules/egress.md`（出口切换） → `docs/modules/probe.md`（探测与公网 IP）→ `docs/modules/recovery.md`（断流续写）。
4. **理解目录与档位**：`docs/modules/catalog.md`（清单合并）→ `docs/modules/effort.md`（档位换算）→ `docs/modules/channel.md`（异步通道基础设施）。
5. **理解持久化与安全边界**：`docs/modules/store.md`（JSON 持久化与用量）→ `docs/modules/trust.md`（Host/Origin 栅栏）。
6. **未合并 PR 的处置**：`docs/pr-coverage.md`；**模块文档规范**：`docs/modules/_TEMPLATE.md`（十节必填，缺节 = L0 红）。
