/**
 * Offline behaviour with no API key.（上游 offline-test 改编，M1）
 *
 * The plugin's whole premise is that there is no key to configure — the free
 * lane's pooled credential lives in `src/upstream.js` and nowhere else. The
 * cold promise: a fresh install with the gateway unreachable must still list
 * the fallback roster, still serve the forward endpoint behind its own locally
 * minted key, and fail a turn as a clean upstream error rather than a crash —
 * with no key material configured or required anywhere.
 *
 * Local network only: the "offline" gateway is a real server that was closed,
 * so every connection is refused immediately. No free-lane quota is spent.
 *
 * 改编（原 223 行 dsh 宿主版三块，块①保留为 src 直连）与 N/A 记录：
 * - summary/settings API 断言 —— 无 Web UI（§13 决策），配置面走 config.json +
 *   config-unit；roster 离线广告改由 adapter.listModels + forward /v1/models 直验；
 * - listing 刷新失败日志（"model listing refresh failed"） —— 后台轮在 start.js
 *   （M4），届时补回该断言；
 * - 订阅 URL 凭证块（settings GET/POST /egress/url 遮蔽三断言） —— 无 settings 面，
 *   egress 订阅出口随 M3 移植时在 egress 测试落回归；
 * - 托管安装闸两块（update/reload/feed 409 与公告 stand-down） —— 不做自更新与
 *   公告（§13 决策），zenbox 无分发方。
 *
 * Run: node scripts/offline-test.mjs
 */
import http from 'node:http'
import { freePort } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** A port that answers nothing, forever: the honest stand-in for "no network". */
const dead = http.createServer()
await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve))
const deadBase = `http://127.0.0.1:${dead.address().port}`
await new Promise(resolve => dead.close(resolve))

process.env.OUR_FREE_MODEL_BASE = deadBase

const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
const { FALLBACK_CATALOG } = await import('../src/catalog.js')
const { computeMembership, routableModelIds, publicModelRows, createRunForwarded } = await import('../src/turn.js')
const { startForwardServer, generateKey } = await import('../src/forward.js')

const state = () => ({
  catalog: FALLBACK_CATALOG,
  membership: computeMembership(FALLBACK_CATALOG, { results: {} }, {}),
  settings: { enabled: true, defaultMaxTokens: 32768 },
  attributionUserAgent: 'offline-test',
})
const adapter = new FreeModelAdapter({ state, recordUsage: () => {} })

// ── offline, no key: the lane must still be usable ──────────────────────────
{
  check('a cold start with no network still has a roster to stand on',
    FALLBACK_CATALOG.length > 0, true)

  // The harness forwards to these by name with no guard (`adapters.get(provider)
  // ?.adapter.<method>`), and `?.` cannot short-circuit because registration
  // succeeded. A method missing here is a TypeError at first use — for
  // `imageRequestPricing` that is every token measurement, which silently kills
  // auto- and manual compaction while the UI keeps no error (issue #42).
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    check(`the adapter answers the contract method ${method}()`, typeof adapter?.[method], 'function')
  }
  check('imageRequestPricing declares no per-image price for this free lane',
    adapter?.imageRequestPricing(ROUTE_MAIN, 'any-model-free'), undefined)

  const models = await adapter.listModels(ROUTE_MAIN)
  check('the fallback roster is advertised with no network and no key', models.length > 0, true)

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN, model: models[0].id, sessionId: 'offline:turn',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) chunks.push(chunk)
  const finish = chunks.find(chunk => chunk.type === 'finish')?.reason
  check('a turn ends as an upstream error, not an exception', finish?.kind, 'error')
  check('with the transport failure named', /upstream|fetch|ECONNREFUSED|request failed/i.test(finish?.failure?.message ?? ''), true)

  // The forward listener is part of the no-key promise: other local harnesses
  // get an OpenAI endpoint that needs only its own bearer, minted locally.
  const forwardPort = await freePort()
  const key = generateKey()
  const complete = createRunForwarded({
    getCatalog: () => FALLBACK_CATALOG,
    getState: state,
    getSettings: () => ({}),
    adapter,
  })
  const forward = await startForwardServer({
    config: () => ({ enabled: true, host: '127.0.0.1', port: forwardPort, key }),
    complete,
    modelRows: () => publicModelRows(FALLBACK_CATALOG, routableModelIds(state, {})),
    log: () => {},
  })
  try {
    const listed = await fetch(`http://127.0.0.1:${forwardPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    check('the forward listener serves its model list offline', listed.status, 200)
    const refused = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: models[0].id, messages: [{ role: 'user', content: 'hi' }] }),
    }).catch(() => null)
    const body = refused === null ? null : await refused.json().catch(() => null)
    check('a forwarded turn fails cleanly against a dead gateway', [refused?.status, body?.error !== undefined], [502, true])
    const unknown = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model-free', messages: [{ role: 'user', content: 'hi' }] }),
    }).catch(() => null)
    check('a model the roster does not carry answers 404 model-shaped', unknown?.status, 404)
  } finally {
    await forward.close()
  }
}

console.log(failures === 0 ? '\noffline: no key needed offline' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
