/**
 * ipinfo.js — 出口 IP 三家降级的红→绿锁（§8 config ip 段 / brief line148）。
 *
 * 桩 fetch 记录每次 URL，可编程响应或永不返回（超时路径）。无真实出网。
 */
import { strict as assert } from 'node:assert'
import { fetchPublicIp, PROVIDER_URLS } from '../../src/ipinfo.js'

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** 桩 fetch：script[i] 是 {json|status|never}；记录被访问的 URL。 */
function stubFetch(script) {
  const seen = []
  const impl = async (url, init) => {
    seen.push(String(url))
    const step = script[seen.length - 1] ?? { status: 500 }
    if (step.never === true) {
      // 永不返回，但尊重 abort 信号（真实 fetch 的超时语义）。
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (step.status !== undefined && step.status !== 200) {
      return { ok: false, status: step.status, json: async () => { throw new Error('no body') } }
    }
    return { ok: true, status: 200, json: async () => step.json }
  }
  return { impl, seen }
}

await check('ipify 首选命中即返回，带 provider 名', async () => {
  const { impl, seen } = stubFetch([{ json: { ip: '1.2.3.4' } }])
  const result = await fetchPublicIp({ fetchImpl: impl, timeoutMs: 500 })
  assert.deepEqual(result, { ip: '1.2.3.4', country: '', provider: 'ipify' })
  assert.deepEqual(seen, [PROVIDER_URLS.ipify])
})

await check('ipify 挂掉降到 ipinfo，国家码带上', async () => {
  const { impl, seen } = stubFetch([{ status: 500 }, { json: { ip: '5.6.7.8', country: 'JP' } }])
  const result = await fetchPublicIp({ fetchImpl: impl, timeoutMs: 500 })
  assert.deepEqual(result, { ip: '5.6.7.8', country: 'JP', provider: 'ipinfo' })
  assert.equal(seen.length, 2)
})

await check('前两家挂降到 ipapi（country_code 两字母）', async () => {
  const { impl } = stubFetch([{ status: 500 }, { status: 500 }, { json: { ip: '9.9.9.9', country_code: 'US' } }])
  const result = await fetchPublicIp({ fetchImpl: impl, timeoutMs: 500 })
  assert.deepEqual(result, { ip: '9.9.9.9', country: 'US', provider: 'ipapi' })
})

await check('三家全挂回 unknown，不抛错（§8.4 不崩溃）', async () => {
  const { impl } = stubFetch([{ status: 500 }, { status: 500 }, { status: 500 }])
  const result = await fetchPublicIp({ fetchImpl: impl, timeoutMs: 500 })
  assert.deepEqual(result, { ip: 'unknown', country: '', provider: '' })
})

await check('卡死的 provider 超时后换下家（timeoutMs 生效）', async () => {
  const { impl } = stubFetch([{ never: true }, { json: { ip: '2.2.2.2', country: 'DE' } }])
  const started = Date.now()
  const result = await fetchPublicIp({ fetchImpl: impl, timeoutMs: 200 })
  assert.deepEqual(result, { ip: '2.2.2.2', country: 'DE', provider: 'ipinfo' })
  assert.ok(Date.now() - started < 1500, '总耗时应在超时量级而非挂死')
})

await check('providers 为空直接 unknown（config 可关探测）', async () => {
  const { impl } = stubFetch([{ json: { ip: '1.1.1.1' } }])
  const result = await fetchPublicIp({ providers: [], fetchImpl: impl, timeoutMs: 200 })
  assert.deepEqual(result, { ip: 'unknown', country: '', provider: '' })
})

await check('响应缺 ip 字段视为坏数据降下家', async () => {
  const { impl } = stubFetch([{ json: { nothing: true } }, { json: { ip: '3.3.3.3', country: 'FR' } }])
  const result = await fetchPublicIp({ fetchImpl: impl, timeoutMs: 500 })
  assert.deepEqual(result, { ip: '3.3.3.3', country: 'FR', provider: 'ipinfo' })
})

console.log(`\nipinfo: ${passed} passed`)
if (passed !== 7) process.exitCode = 1
