# channel.js — 回调源到异步迭代消费者的单生产者单消费通道

## 职责边界

40 行、零依赖的 SPSC 桥：把 **push 式**的流式回调源（SSE reader 的每帧）桥接到 **pull 式**的 `for await` 消费者（chunk parser）。核心契约写在文件头注释：`push()` 永不阻塞——生产者队列、消费者 `next()` 挂起，天然背压是"消费者没来要就不推"，没有事件循环轮询与轮询泄漏（这是它相对裸 EventEmitter 的存在理由：事件会被丢，队列不会）。值域三态：普通值入队或直接交挂起的读者；`undefined` 是结束信号，先放行队列存量再标 `ended`；`Error` 同样终结通道，但读到时**抛出**（不入队），交给消费者传播。`read()` 是异步生成器，消费者可随时开始；没有消费者时生产照常排队，不丢帧。

## 导出符号表

| 符号 | 类型 | 签名/形态 | 一句话语义 |
| --- | --- | --- | --- |
| `createChannel` | function | `createChannel() → {push(value), read()}` | 建一条 SPSC 通道；`push(value)` 投递（void，永不挂起），`read()` 返回异步生成器逐个产出值直至结束/错误 |

内部状态（闭包，不导出）：`queue: []` 已推未读的值、`waiting: []` 挂起的 `resolve`（读者等生产者）、`ended: boolean` 终态标志（`undefined`/`Error` 投递即置位，此后 `push` 一律忽略——终态后生产者继续推送不会破坏消费者，也拿不到回执）。

行为矩阵（真源语义）：

- **push(v)**：有挂起读者 → 直接 `resolve({value, done:false})`；否则 `queue.push(v)`。
- **push(undefined)**：终结——先 `resolve` 所有挂起读者（存量帧先走完），再 `ended = true`；后续 `read()` 立即 `done`。
- **push(err instanceof Error)**：终结——`ended = true`，读者下一个 `next()` 收到 **rejected promise**（错误在消费端抛出，不是入队的值）；无挂起读者时该错误记为待抛。
- **read()**：`queue` 非空先出队；空且 `ended` → `{done: true}`；否则把 `resolve` 推进 `waiting` 挂起（无轮询）。

## 依赖关系

- **import 进来**: 无。
- **被谁依赖**: `src/adapter.js`（`createChannel`——SSE reader 回调与 chunk parser `for await` 之间的桥，三种 wire 流式解析的公共载体）。

## 配置键

无。零配置、零环境读取。

## 日志错误

无日志。错误经通道本身传播：`push(Error)` → 消费者 `next()` 抛出，捕获与重试责任在 `src/adapter.js`；模块自身不抛（`read()` 只挂起或结束）。

## 网络面

无。它是纯内存结构；携带的字节来自 `src/http.js` 的 SSE reader、流向 `src/adapter.js` 的 chunk parser，但通道本身不触网。

## 关联 PR

| PR | 处置 | 落点/理由 |
| --- | --- | --- |
| 无直接 PR | — | 见 docs/pr-coverage.md（该文件当前未创建，M0 补） |

## 测试对照

| 测试 | 覆盖点 |
| --- | --- |
| 暂无 | 暂无专属测试文件（coverage-map 无 `channel` 映射，见 test/meta/coverage-map.json——M1 补）；行为经 `src/adapter.js` 间接覆盖于 `test/upstream/recovery-test.test.mjs`（三 wire 流解析、EOF/silent stop 续写都走此桥）、`test/upstream/effort-test.test.mjs`（adapter 直驱流）、`test/upstream/truncation-test.test.mjs`（截断流） |

## 已知边界

- **SPSC 单消费**：两个并发 `read()` 会瓜分队列（消费端语义未定义），文档与注释都按"一个读者"假设书写。
- **队列无界**：生产者快于消费者时 `queue` 无限增长——背压依赖调用方（SSE reader 按轮次受限）自己限速，通道不施压。
- **终态即焚**：`ended` 后 `push` 静默丢弃，生产者拿不到"已结束"回执；`Error` 与 `undefined` 都终结但读出行为不同（抛 vs 收尾），混用需在调用点区分。
- 不做超时/取消/断连语义：取消由上层 signal 贯穿（`src/http.js`），通道只反映"有没有下一个值"。

## 变更记录

- 2026-10-07 建档（M0，依据上游 fbc3b9b + AGENT-BRIEF）。
- 本仓库无改动（cut 未触及 channel.js）；SPSC 契约为上游既有语义。
