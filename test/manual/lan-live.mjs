/**
 * L4 跨设备清单的可执行一半（AGENT-BRIEF §11 M2 / §12 DoD）：
 * 起桩上游 + 真 `start.js start --lan`，用本机的 LAN 地址当"第二设备"
 * 走完整条链：LAN 独立 Key → 中继 → PROXY v1 → 本机转发 → adapter → 桩网关，
 * 并在 zenbox 日志里核对 #40/#41 的真实设备 IP 归因行。
 *
 * 真机（手机/另一台电脑）实测属于 release 前人工步骤，见 lan-checklist.md。
 *
 * Run: node test/manual/lan-live.mjs   （需能拿到一个非回环 IPv4，否则如实失败）
 */
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { stubUpstream, chatFrames, freePort, until } from '../../scripts/lib/fake-kernel.mjs'
import { rankLanAddresses } from '../../src/forward.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stripAnsi = text => text.replace(/\u001b\[[0-9;]*m/g, '')

async function main() {
  // ① 桩网关：adapter 的出网目标（OUR_FREE_MODEL_BASE 在 start 进程加载时读取）
  const stub = await stubUpstream({ listing: ['mimo-v2.6-flash-free'], answer: () => ({ body: chatFrames('lan-ok') }) })
  const lanPort = await freePort()

  // ② 真 CLI：--lan 0.0.0.0:<port>，stdout/stderr 逐行进 transcript
  const transcript = []
  const child = spawn(process.execPath, ['start.js', 'start', '--lan', `0.0.0.0:${lanPort}`], {
    cwd: root,
    env: { ...process.env, OFM_UPSTREAM: stub.base, OUR_FREE_MODEL_BASE: stub.base, OFM_SMOKE_MS: '20000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const feed = chunk => {
    for (const line of stripAnsi(String(chunk)).split(/\r?\n/)) if (line.trim()) transcript.push(line)
  }
  child.stdout.on('data', feed)
  child.stderr.on('data', feed)

  const stop = async () => {
    if (child.exitCode === null) {
      // 先挂监听再 kill，防 exit 抢跑；超时兜底（TerminateProcess 不给优雅期）。
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
    }
    // 桩关不掉（客户端 keep-alive 残留）也不能拖死清单本身。
    await Promise.race([stub.close(), new Promise(resolve => setTimeout(resolve, 2000))])
  }

  try {
    // ③ 等中继监听就绪
    await until(() => transcript.some(line => line.includes('[listen] 中继口')), { timeoutMs: 12000, what: 'relay listen line' })
    const listenLine = transcript.find(line => line.includes('[listen] 中继口'))
    assert.match(listenLine, new RegExp(`中继口 \\S+:${lanPort}\\b`), `中继应绑定 ${lanPort}: ${listenLine}`)

    // ④ "第二设备"：非回环 LAN 地址（#76 排序给出的首选物理地址）
    const lanIp = rankLanAddresses(os.networkInterfaces())[0]
    assert.ok(lanIp, '这台机器没有可用的非回环 IPv4，L4 无法在本机执行（换有网卡的环境或走真机步骤）')

    // ⑤ LAN 独立 Key（start 首启已 ensureKey 落盘）
    const lanKey = fs.readFileSync(path.join(root, 'data', 'lan-key'), 'utf8').trim()
    assert.match(lanKey, /^ofm-/, 'data/lan-key 应是 ofm- 前缀')

    // ⑥ 第二客户端进程：凭 LAN Key 流式对话
    const response = await fetch(`http://${lanIp}:${lanPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lanKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'L4 ping' }], stream: true }),
    })
    assert.equal(response.status, 200, `LAN 流式对话应 200，实际 ${response.status}`)
    const body = await response.text()
    assert.ok(body.includes('lan-ok'), `SSE 正文应含桩回声 lan-ok，实际截断于 ${body.slice(0, 200)}`)

    // ⑦ 日志归因：中继行 + 转发行都必须点名设备的 LAN IP（#40/#41）
    await until(() => transcript.some(line => line.includes(`lan relay: ${lanIp} →`)), { timeoutMs: 4000, what: 'relay device line' })
    await until(() => transcript.some(line => line.includes(`forward: ${lanIp}:`)), { timeoutMs: 4000, what: 'forward device line' })
    const relayLine = transcript.find(line => line.includes(`lan relay: ${lanIp} →`))
    const forwardLine = transcript.find(line => line.includes(`forward: ${lanIp}:`))
    assert.ok(relayLine.includes('/v1/chat/completions'), `中继行应是流式对话端点: ${relayLine}`)

    console.log('lan-live: PASS — 第二客户端凭 LAN Key 流式对话成功')
    console.log(`  设备地址   ${lanIp}:${lanPort}（#76 首选地址）`)
    console.log(`  中继归因   ${relayLine}`)
    console.log(`  转发归因   ${forwardLine}`)
    console.log(`  SSE 正文   含桩回声 lan-ok（桩 ${stub.base}）`)
  } finally {
    await stop()
  }
}

main().then(
  () => { process.exitCode = 0 },
  error => {
    console.error(`lan-live: FAIL — ${error.message}`)
    process.exitCode = 1
  },
)
