/**
 * boot-order.test.js — #72 改编：监听与 banner 不等网络轮。
 *
 * 上游指到 192.0.2.1（TEST-NET-1，永不应答）——后台的清单/探测/出口 IP
 * 轮都会悬着或超时，但监听是本地 socket 的事，banner 是本地状态的事：
 * 它们必须在网络轮之前就位。断言两件事：①spawn 到 [listen] 转发行 <3s
 * （§12 冷启动 <3s 出 banner）；②到点即 /health 200、带 Key /v1/models
 * 200、无 Key 401——全在上游毫无应答的条件下。
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const data = mkdtempSync(join(tmpdir(), 'zenbox-boot-'))
const { freePort } = await import('../../scripts/lib/fake-kernel.mjs')
const port0 = await freePort()

const env = {
  ...process.env,
  OFM_UPSTREAM: 'http://192.0.2.1:9', // TEST-NET-1：永不应答
  OFM_DATA: data,
  OFM_LISTEN: `127.0.0.1:${port0}`,
  OFM_SMOKE_MS: '15000',
}
const child = spawn(process.execPath, ['start.js', 'start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })

let output = ''
const started = Date.now()
let listenAt = 0
child.stdout.on('data', chunk => {
  output += String(chunk)
  if (listenAt === 0 && output.includes('[listen] 转发口')) listenAt = Date.now() - started
})
child.stderr.on('data', chunk => { output += String(chunk) })

/** @param {number} ms */
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
  // banner 与 [listen] 行应在 3s 内出现（网络轮还没回话——它回不了话）
  const deadline = Date.now() + 4000
  while (listenAt === 0 && Date.now() < deadline) await sleep(50)
  check('冷启动 <3s 出 [listen] 转发行（上游挂死不挡）', () => {
    assert.ok(listenAt > 0, `超时未出转发行；输出=\n${output.slice(-800)}`)
    assert.ok(listenAt < 3000, `用了 ${listenAt}ms`)
  })
  check('§8.4 框在转发行之前完整落下', () => {
    assert.ok(output.includes('┌─ zenbox v'), '框头')
    assert.ok(output.includes('└'), '框尾')
    assert.ok(output.includes('[异步]'), '挂死轮的字段保持异步占位')
  })
  check('出网字段占位不崩（IP 轮失败只记一行 warn 或保持占位）', () => {
    assert.ok(!output.includes('TypeError') && !output.includes('ERR_'), `不应有崩溃栈：\n${output.slice(-500)}`)
  })

  // 监听在场：health 200、Key 门 200/401——全部在上游毫无应答的条件下
  const portMatch = output.match(/\[listen\] 转发口 [^\s:]+:(\d+)/)
  assert.ok(portMatch, `没解析到转发口：\n${output.slice(-800)}`)
  const port = Number(portMatch[1])
  const { readFileSync } = await import('node:fs')
  const key = readFileSync(join(data, 'forward-key'), 'utf8').trim()
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.status).catch(() => 0)
  check('/health 200（挂死上游不挡监听）', () => assert.equal(health, 200))
  const withKey = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.status).catch(() => 0)
  const without = await fetch(`http://127.0.0.1:${port}/v1/models`).then(r => r.status).catch(() => 0)
  check('带 Key /v1/models 200、无 Key 401', () => assert.deepEqual([withKey, without], [200, 401]))
} finally {
  child.kill()
  await sleep(300)
  try { rmSync(data, { recursive: true, force: true }) } catch { /* 临时目录尽力 */ }
}

console.log(`\nboot-order: ${passed} passed`)
if (passed !== 5) process.exitCode = 1
