// L2 集成：key rotate 后旧 Key 立即 401（§8.4/§9 CLI 口径）。
// 桩网关无关——只打 startForwardServer 自己的 /v1/models 与 /health。
// 运行: node test/integration/key-rotate.test.js （run-gates.mjs 收集）
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startForwardServer } from '../../src/forward.js'
import { ensureKey, rotateKey, readKey } from '../../src/store.js'

let passed = 0
/** @param {string} name @param {() => Promise<void>} fn */
async function check(name, fn) {
  try { await fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

const dir = mkdtempSync(join(tmpdir(), 'zenbox-rotate-'))
// config() 每请求重读文件——与 start.js 的接线一致，rotate 才能即刻生效。
const config = () => ({
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  fallback: true,
  key: readKey(dir, 'forward-key').key,
})

let forward = null
try {
  ensureKey(dir, 'forward-key', '')
  forward = await startForwardServer({
    config,
    complete: async () => ({ chunks: [], outcome: { kind: 'text', text: '' } }),
    modelRows: () => [{ id: 'x', created: 0, owned_by: 'our-free-model' }],
    log: () => {},
  })
  const base = `http://127.0.0.1:${forward.port}`
  const oldKey = readKey(dir, 'forward-key').key

  await check('带 Key 请求 /v1/models → 200', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${oldKey}` } })
    assert.equal(res.status, 200)
  })

  await check('无 Key → 401', async () => {
    const res = await fetch(`${base}/v1/models`)
    assert.equal(res.status, 401)
  })

  await check('/health 免鉴权 → 200', async () => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
  })

  await check('rotate 后旧 Key 立即 401、新 Key 200', async () => {
    rotateKey(dir, 'forward-key')
    const freshKey = readKey(dir, 'forward-key').key
    assert.notEqual(freshKey, oldKey)
    const stale = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${oldKey}` } })
    assert.equal(stale.status, 401, '旧 Key 必须即刻失效（每请求重读 key 文件）')
    const fresh = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${freshKey}` } })
    assert.equal(fresh.status, 200)
  })
} finally {
  if (forward) await forward.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`key-rotate: ${passed} passed`)
if (passed !== 4) {
  console.error(`expected 4 assertions, got ${passed}`)
  process.exitCode = 1
}
