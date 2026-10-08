<div align="center">

# zenbox

**脱离 dsh 的一键式 opencode 免费模型中继** — OpenAI 兼容转发 + 局域网多设备 + 终端 IP banner

**简体中文** | [English](README_EN.md)

<img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
<img alt="运行时依赖" src="https://img.shields.io/badge/runtime%20deps-zero-4b6fff?style=flat-square">
<img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.19-7da1de?style=flat-square">
<img alt="平台" src="https://img.shields.io/badge/platform-win%20%C2%B7%20macOS%20%C2%B7%20linux-2f6f4f?style=flat-square">
<img alt="状态" src="https://img.shields.io/badge/status-v0.1.0-f0a441?style=flat-square">

</div>

---

打开即用的免费模型中继：`start` 一条命令在终端打出 IP banner 并持续输出日志，
本机任何 OpenAI 兼容客户端填 `http://127.0.0.1:18899/v1` 与 Key 即可对话；
局域网内手机/平板/另一台电脑凭独立 LAN Key 走转发口使用同一批模型。
模型清单跟随 OpenCode Zen 网关（https://opencode.ai）刷新，免费车道免登录免 Key。

## 亮点

- **一条命令**——`./start.sh`（macOS/Linux）或 `start.ps1`（Windows，建议 `powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1`——避免 `.ps1` 文件关联到编辑器的机器上双击行为）或 `start.cmd`：加载配置 → 监听先行 → 打出 §8.4 banner（本机转发口、Key 尾 4、LAN 地址、公网出口 IP 异步补行）→ 前台日志。SIGINT/SIGTERM 优雅关闭（转发口回收 + 统计落盘）。
- **运行时零 npm 依赖**——`dependencies` 为空，仅 `devDependencies: typescript` 做类型检查；无构建步骤，克隆即可跑。
- **OpenAI 兼容面**——`/v1/chat/completions`（SSE 流式 + 非流式）、`/v1/responses`、`/v1/models`、`/health`；工具调用、8 MiB 请求体上限、心跳注释帧齐备。Key 每请求校验（`timingSafeEqual`），`key rotate` 后旧 Key 立即 401，Key 以 0600 落盘 `data/`。
- **局域网多设备**——`lan.enabled` 打开后中继门独立监听（默认端口 0 自动分配、可配），LAN Key 与本机 Key **不通用**；PROXY v1 设备地址归因（前门嗅探 + 中继非池化逐请求头），设备真实 IP 贯穿到网关的 `x-forwarded-for`，本机日志显示真实来源 IP。**LAN Key 同样消耗免费额度——仅限你信任的网络启用（家庭/办公内网，别对公网 0.0.0.0 暴露到不可信边界）。**
- **思考档位实际生效**——Light / Balanced / Deep 对应真实输出 token 预算（2 048 / 8 192 / 模型上限），调用方可用 `reasoning_effort`、嵌套 `reasoning.effort` 或模型名尾缀 `(level)` 指定；`/v1/models` 每行暴露 `x_ofm_efforts` / `x_ofm_effort_default`。
- **出口三态**——`egress.mode = direct / subscription / proxy`：直连、订阅节点（故障切换 + 三类故障分账日志）、自备代理 URL；配置同步、坏节点规避轮换。
- **可用性探测**——网关逐模型探测（200 流 OK / 400-404 不可用 / 429 限流 / 403 地区受限），整轮被拒保留清单不置空，region-limited 单独分组；失败只记日志，永不阻塞监听。
- **数据留在本机**——`data/` 下 settings/stats/Key 三个 JSON，`JsonStore` 800ms 去抖 + temp+rename 原子落盘；速率统计带 `MIN_DECODE_MS` 可信窗（短窗不给数，不给假数）。公网 IP 只在 banner/status 展示并按期后台刷新，不落盘、不出站到除探测源以外的任何一方。

## 快速开始

要求：Node.js `^22.19.0 || >=24`。

```bash
git clone https://github.com/menghuanshiguang/zenbox
cd zenbox
./start.sh            # Windows: .\start.ps1 或 start.cmd
```

首次启动自动生成 Key（`data/forward.key`，0600），banner 里可见尾 4。启动 5 秒后自测 `/v1/models`：带 Key 200、不带 401。

对话一行起：

```bash
curl http://127.0.0.1:18899/v1/chat/completions \
  -H "Authorization: Bearer $(cat data/forward.key)" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

任何 OpenAI 兼容客户端（OpenAI SDK、ollama、各类 chat UI）把 base URL 指到 `http://127.0.0.1:18899/v1`、Key 从 `data/forward.key` 取即可。

## 内置 mihomo（跨平台出口）

`egress.mode = "subscription"`（Clash 订阅出口）需要 mihomo 二进制。zenbox 在 `vendor/mihomo/manifest.json` 内置了 pin 版本（当前 v1.19.32），一条命令把当前平台的官方构建拉到 `vendor/mihomo/<os>-<arch>/`：

```bash
node scripts/fetch-mihomo.mjs --smoke                # 下载 + mihomo -v 冒烟
node scripts/fetch-mihomo.mjs --platform linux-arm64 # 为其他平台预取
```

- 覆盖 linux / darwin / windows × amd64 / arm64 / 386；CI 每次推送在三平台自动执行，Linux 服务器 clone 后跑一次即可用订阅出口。
- 二进制不入库（`.gitignore` 忽略 `vendor/mihomo/*/`，manifest 入库 pin 版本）；运行时 `findMihomoBinary` 优先认领内置副本（其次 PATH、Clash Verge 等安装目录），都没到时报错会点名这个脚本。
- 升级 mihomo：改 manifest 的 `version` 后重跑。

## 终端 banner（§8.4）

```
┌──────────────────────────────────────────────────────────────┐
│  zenbox v0.1.0 · opencode 免费模型中继                        │
│  上游        https://opencode.ai/zen/v1                      │
│  公网出口    221.182.83.175 (CN)                              │
│  本机转发    127.0.0.1:18899 · Key ****bodR                   │
│  局域网      关闭（config lan.enabled=true 开启，独立 Key 与本机不通用）│
│  LAN 地址    10.39.21.192 (物理)                              │
│  模型清单    8 个 · 可用 6 · 地区受限 1 · 移除 1               │
└──────────────────────────────────────────────────────────────┘
```

公网出口与模型清单分桶是后台轮异步补行（启动不等网络，网络轮失败只记日志）；端口被占自动顺延并在 banner 标注。

## CLI

| 命令 | 作用 |
| --- | --- |
| `start`（默认） | 启动中继：监听先行 → banner → 后台轮 → 前台日志 |
| `status` | 端口/Key 尾 4/公网 IP/LAN 地址/中继状态一览，`--json` 机器可读 |
| `models` | 模型清单与上下文长度，`--json` 同步 `/v1/models` 形状 |
| `probe` | 探测配置节奏与最近一轮摘要，`--json` 同步 |
| `key rotate [--lan]` | 轮换本机 / LAN Key，旧 Key 即刻 401 |
| `doctor` | 逐项体检 node/配置/监听/Key/上游，任一不过退出码 1 |

全部命令支持 `--json`。配置优先级：flag > `OFM_*` 环境变量 > `config.json`（允许 `//` 注释）> 默认值。

## 配置

`config.json` 全键样张见仓库根（每键带 `//` 注释；**文件顶部有「客户端接入速览」——OpenAI 格式 Base URL、Key、上游 Key、订阅凭据一屏看全**）。常用的几个：

```jsonc
{
  "listen": { "host": "127.0.0.1", "port": 18899, "fallback": true, "key": "" },  // key 空 = 首次生成写 data/0600
  "lan":    { "enabled": false, "host": "0.0.0.0", "port": 18899, "key": "" },     // 独立 Key，与本机不通用
  "upstream": { "base": "https://opencode.ai", "timeoutMs": 45000, "key": "" },    // key 空 = 免密；换兼容网关时填
  "effort": "balanced",                                                            // light | balanced | deep
  "egress": {                                                                      // direct | proxy | subscription
    "mode": "direct",
    "subscription": { "url": "", "token": "" },                                    // 订阅链接 + 订阅站 apikey
    "proxy": { "url": "", "password": "" }
  },
  "data": "./data"
}
```

只有三条配置途径（config.json / `OFM_*` 环境变量 / CLI flag），无 Web UI。

## 测试与门禁

```bash
npm test             # L0 静态（rg 禁词 / node --check / tsc 棘轮 / config schema / 文档对账）
                     # L1 单元 · L2 集成（桩网关）+ 上游迁移套件 14 件
npm run test:live    # L3 live（默认档禁真实出网，显式 --allow-live 才跑）
```

- 三平台 CI（ubuntu/amd64、ubuntu/arm64、macOS、Windows）：`npm ci` + `npm test` + start 冒烟。
- 文档同步是硬门禁：改 `src/*.js` 必须同提交更新 `docs/modules/<同名>.md`（十节齐全），`test/meta/gates.test.js` 双向对账。
- 模块索引与依赖速览见 [`docs/INDEX.md`](docs/INDEX.md)；15 个未合并上游 PR 的取舍逐行记在 [`docs/pr-coverage.md`](docs/pr-coverage.md)；§12 DoD 八项的验收证据汇在 [`docs/conformance.md`](docs/conformance.md)；开发机环境记录在 [`docs/env.md`](docs/env.md)。

## 上游与来源

本仓库自 [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的 main 分支裁出（去掉 dsh 宿主与分发面），保留并移植其未合并 PR 中适用的部分（逐行对照见 `docs/pr-coverage.md`）。免责三则：①客户端身份——本中继以固定池化凭据（`Bearer public`）与指纹头代表你的出口访问上游，上游看到的是本机/本出口的 IP 与请求形态；②免费车道由上游决定是否记录 prompt 用于改进服务，**请勿发送敏感内容**；③地区受限的模型按探测分组单列（region-limited），它们对你的出口不放行、不是被移除。请求由谁处理、数据发往何处，以上游文档为准。

## 计划中

- **Docker 镜像**——planned（v0.1 不提供；三条平台启动脚本与裸 Node 已覆盖本机/局域网场景）。

## 许可

MIT — 源码 **derived from [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)**（原仓库亦为 MIT）；裁剪、移植与本仓库新增代码沿用同一许可，详见 [LICENSE](LICENSE)。
