/**
 * rounds.test.js — §3 后台轮（清单/探测）端到端红→绿契约。
 *
 * 桩网关回答 GET /zen/v1/models（2 个 id）与探测 POST（SSE delta），
 * spawn 完整 start：①清单轮把 FALLBACK 8 个换成上游 2 个并落盘
 * data/catalog.json；②探测轮逐模型判 available、落 data/availability.json
 * 并把 banner 的「分桶待探测」补成四段全分桶；③转发面 /v1/models
 * 随运行态清单变 2 行。清单失败保留旧 roster 的分支由素材语义兜底
 * （boot-order.test 的挂死上游场景已覆盖其不崩）。
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const data = mkdtempSync(join(tmpdir(), 'zenbox-rounds-'))
const { freePort } = await import('../../scripts/lib/fake-kernel.mjs')
const listenPort = await freePort()

const LISTING = ['mimo-v2.6-flash-free', 'mimo-v2.5-free']
const probed = []
const gateway = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/zen/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: LISTING.map(id => ({ id })) }))
    return
  }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    try { probed.push(JSON.parse(body).model) } catch { probed.push('?') }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
const gatewayPort = gateway.address().port

const env = {
  ...process.env,
  OFM_UPSTREAM: `http://127.0.0.1:${gatewayPort}`,
  OFM_DATA: data,
  OFM_LISTEN: `127.0.0.1:${listenPort}`,
  OFM_SMOKE_MS: '9000',
}
const child = spawn(process.execPath, ['start.js', 'start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', chunk => { output += String(chunk) })
child.stderr.on('data', chunk => { output += String(chunk) })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

try {
  // 轮是毫秒级（本地桩），8s 内两轮必须都落
  const deadline = Date.now() + 7000
  while (!output.includes('[probe] 一轮完成') && Date.now() < deadline) await sleep(50)
  // JsonStore edit→schedule(800ms)→flush：等 debounce 走完再断言落盘
  await sleep(1200)

  check('清单轮：上游清单拉取并报数', () =>
    assert.match(output, /\[catalog\] 上游清单 2 个/, `输出尾=\n${output.slice(-900)}`))
  check('banner 模型行初始是「分桶待探测」态（未探不报可用）', () =>
    assert.match(output, /模型清单\s+8 个 · 分桶待探测/))
  check('探测轮：四段分桶补行（2 个 · 可用 2 · 地区受限 0 · 移除 0）', () =>
    assert.match(output, /模型清单\s+2 个 · 可用 2 · 地区受限 0 · 移除 0/))
  check('探测轮日志一行收束', () =>
    assert.match(output, /\[probe\] 一轮完成/))
  check('清单落盘 data/catalog.json（重启即显真实清单）', () => {
    const saved = JSON.parse(readFileSync(join(data, 'catalog.json'), 'utf8'))
    assert.deepEqual(saved.ids, LISTING)
  })
  check('探测裁决落盘 data/availability.json（两 id 均 available）', () => {
    const saved = JSON.parse(readFileSync(join(data, 'availability.json'), 'utf8'))
    assert.equal(saved.results['mimo-v2.6-flash-free'].state, 'available')
    assert.equal(saved.results['mimo-v2.5-free'].state, 'available')
    assert.ok(saved.at > 0, 'at 时间戳')
  })
  check('桩收到 2 个模型的探测各一次', () =>
    assert.deepEqual([...probed].sort(), [...LISTING].sort()))
  // 转发面：check 是同步壳，这一项必须手动 await
  try {
    const key = readFileSync(join(data, 'forward-key'), 'utf8').trim()
    const response = await fetch(`http://127.0.0.1:${listenPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    const payload = await response.json()
    assert.equal(payload.data.length, 2, JSON.stringify(payload.data.map(row => row.id)))
    passed += 1
    console.log('ok    转发面 /v1/models 随运行态清单变 2 行')
  } catch (error) {
    console.error(`FAIL  转发面 /v1/models: ${error.message}`)
    process.exitCode = 1
  }
} finally {
  child.kill()
  await sleep(300)
  gateway.close()
  try { rmSync(data, { recursive: true, force: true }) } catch { /* 临时目录尽力 */ }
}

console.log(`\nrounds: ${passed} passed`)
if (passed !== 8) process.exitCode = 1
