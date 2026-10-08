/**
 * What the model roster is allowed to advertise.（上游 picker-test 改编，M1）
 *
 * Issue #3: a model the gateway names in `/zen/v1/models` but refuses to route
 * at all still appeared in the picker, so picking it spent a turn on a
 * guaranteed failure. The probe already knew, but `computeMembership` only ever
 * separated the region-gated ones.
 *
 * zenbox 改编（原 349 行 dsh 宿主版）：断言原样保留，宿主换成 src 模块直连——
 * probeCatalog 轮次 + computeMembership/routableModelIds + FreeModelAdapter +
 * startForwardServer/createRunForwarded，与 start.js 同一条链。
 *
 * 不适用（zenbox 无此面，原断言不移植，理由记录在 docs/modules/probe.md 已知边界）：
 * - settings summary/catalog 行、availability/detail 文案、budgets 行投影 —— 无 Web UI（§13）；
 * - announcement ack 上限、settings 数值清洗（probeIntervalMinutes 等） —— 无公告面；配置走
 *   config.json 四层校验（config-unit 覆盖）；
 * - settings API/events 的 trust 栅栏与 connection admission —— 无 settings API；
 * - reprobe 路由的单飞（一轮在途第二触发合并） —— 归 start 编排（M4 probe 编排测试）；
 * - forward 绑定写入 settings 断言 —— 无 settings 文件，绑定拒绝由 resolveLoopbackBind 直测。
 *
 * Run: node scripts/picker-test.mjs
 */
import { chatFrames, freePort, stubUpstream, until } from '../../scripts/lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const LISTING = [
  'mimo-v2.6-flash-free', 'space-bunny-free', 'deepseek-v4-flash-free',
  'jev-1.13-free', 'ling-3.0-flash-fin-free', 'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free', 'muse-spark-1.3-contributor-free',
]

/** One answer per model, standing in for what the lane really does. */
function verdict(id) {
  if (id === 'deepseek-v4-flash-free') {
    return { status: 400, body: JSON.stringify({ error: { type: 'ModelError', message: 'Model is unavailable.' } }) }
  }
  // Named by the listing, no route for it at all: the message says the id, and
  // so does the status.
  if (id === 'jev-1.13-free') return { status: 404, body: JSON.stringify({ error: { message: 'No such model: jev-1.13-free' } }) }
  // The gateway's own trouble, which is not a fact about the model.
  if (id === 'ling-3.0-flash-fin-free') return { status: 500, body: JSON.stringify({ error: { message: 'Internal server error' } }) }
  if (id === 'nemotron-3-ultra-free') {
    return { status: 429, body: JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }) }
  }
  if (id === 'muse-spark-1.3-contributor-free') {
    return { status: 403, body: JSON.stringify({ error: { type: 'RegionError', message: 'This model is not available in your country.' } }) }
  }
  if (id === 'nemotron-3.5-lightning-free') return { socket: true } // no answer at all: the probe learns nothing
  // Held by the test itself, so the "in the catalog, not yet probed" state can be
  // read as long as the test likes rather than racing a clock.
  if (id === 'union-alpha') return { wait: gate.promise, body: chatFrames() }
  return { body: chatFrames() }
}

const stub = await stubUpstream({ listing: LISTING, answer: verdict })
process.env.OUR_FREE_MODEL_BASE = stub.base

const { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } = await import('../../src/adapter.js')
const { buildCatalog } = await import('../../src/catalog.js')
const { probeCatalog, STATE } = await import('../../src/probe.js')
const { computeMembership, routableModelIds, publicModelRows } = await import('../../src/turn.js')
const { startForwardServer, generateKey } = await import('../../src/forward.js')
const { budgetLadder } = await import('../../src/effort.js')

let CATALOG = buildCatalog(LISTING)
const availability = { results: {}, at: 0 }
const roundLogs = []
const runtimeSettings = {}
/** One probe round, with the index.js refused-all utterance ported verbatim. */
async function runRound() {
  await probeCatalog(CATALOG, {}, (id, result) => {
    availability.results[id] = {
      state: result.state,
      ...result.detail === undefined ? {} : { detail: result.detail },
      ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs },
      latencyMs: result.latencyMs,
      at: Date.now(),
    }
  }, 2)
  availability.at = Date.now()
  const verdicts = CATALOG.map(entry => availability.results[entry.id]).filter(Boolean)
  if (verdicts.length > 0 && verdicts.every(row => row.state === STATE.unavailable)) {
    const line = `the gateway refused all ${verdicts.length} models this round; keeping them advertised`
    roundLogs.push(line)
    console.log(`log  ${line}`)
  }
}

const state = () => ({
  catalog: CATALOG,
  membership: computeMembership(CATALOG, { results: availability.results }, runtimeSettings),
  settings: { enabled: true, defaultMaxTokens: 32768 },
  attributionUserAgent: 'picker-test',
})
const adapter = new FreeModelAdapter({ state, recordUsage: () => {} })

const ids = models => models.map(model => model.id)
const advertised = async route => ids(await adapter.listModels(route))

// Every probe in the round has to have landed before the verdicts mean anything.
await runRound()
check('the probe did leave a verdict for every model it saw',
  Object.keys(availability.results).length >= LISTING.length && availability.at > 0, true)

// ── #3: verdicts move the roster ─────────────────────────────────────────────
check('a refused model leaves the picker', (await advertised(ROUTE_MAIN)).includes('deepseek-v4-flash-free'), false)
check('and so does one the listing names but no route answers for', (await advertised(ROUTE_MAIN)).includes('jev-1.13-free'), false)
check('a working model stays', (await advertised(ROUTE_MAIN)).includes('mimo-v2.6-flash-free'), true)
check('the gateway having trouble is not a verdict about the model',
  (await advertised(ROUTE_MAIN)).includes('ling-3.0-flash-fin-free'), true)
check('a quota refusal keeps its model: the next window may answer', (await advertised(ROUTE_MAIN)).includes('nemotron-3-ultra-free'), true)
check('a probe that got no answer keeps its model: that is not a verdict',
  (await advertised(ROUTE_MAIN)).includes('nemotron-3.5-lightning-free'), true)
check('region-gated models move to their own route', await advertised(ROUTE_REGION), ['muse-spark-1.3-contributor-free'])

// ── a model the listing just added, verdict missing while a round is in flight ─
// Reading a missing verdict used to throw `Cannot read properties of undefined
// (reading state)` out of computeMembership, which took the picker down with it.
const gate = Promise.withResolvers()
stub.api.setListing([...LISTING, 'union-alpha'])
CATALOG = buildCatalog([...LISTING, 'union-alpha'])
const round = runRound()
let midRoundError = null
let midRoundModels = null
await until(async () => {
  try {
    const models = await adapter.listModels(ROUTE_MAIN)
    if (!models.some(model => model.id === 'union-alpha')) return false
    midRoundModels = models
    return true
  } catch (error) {
    if (midRoundError === null) midRoundError = error
    throw error
  }
}, { what: 'the newly listed model to be advertised while its probe is still held', timeoutMs: 5000 }).catch(() => {})
check('no read throws while a verdict is missing', midRoundError?.message ?? 'none', 'none')
check('and the new model is advertised in that window', midRoundModels !== null, true)
check('and the picker keeps the models that do have verdicts', (await advertised(ROUTE_MAIN)).includes('mimo-v2.6-flash-free'), true)
check('the missing verdict reads as not knowing, not as a verdict',
  availability.results['union-alpha'], undefined)
gate.resolve()
await round
check('once the round lands it carries a verdict',
  availability.results['union-alpha']?.state, 'available')
stub.api.setListing(LISTING)
CATALOG = buildCatalog(LISTING)

// The forward listener's roster must be exactly the union of both routes — one
// definition of "dialable", two surfaces.
const rows = publicModelRows(CATALOG, routableModelIds(state, runtimeSettings))
check('model discovery offers what the picker advertises, nothing more',
  ids(rows).sort(), [...await advertised(ROUTE_MAIN), ...await advertised(ROUTE_REGION)].sort())

// ── a hidden model still resolves: hiding is selection, not amnesia ──────────
const hidden = await adapter.resolveModel(ROUTE_MAIN, 'deepseek-v4-flash-free')
check('a hidden model still resolves its real capacities for the session using it', [hidden?.id, hidden?.context?.contextWindow], ['deepseek-v4-flash-free', 128000])
check('and its effort menu is intact', hidden?.reasoning?.efforts?.map(row => row.id), ['light', 'balanced', 'deep'])
const hiddenTurn = []
for await (const chunk of adapter.stream({
  provider: ROUTE_MAIN, model: 'deepseek-v4-flash-free', sessionId: 'picker:hidden',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})) hiddenTurn.push(chunk)
const hiddenFinish = hiddenTurn.find(chunk => chunk.type === 'finish')?.reason
check('a turn on it fails as an upstream error, not as an unresolvable model', hiddenFinish?.kind, 'error')
check('with the gateway message attached', /unavailable/i.test(hiddenFinish?.failure?.message ?? ''), true)

// ── the menus and ladders the caller is shown must be the numbers it sends ───
const menu = async id => (await adapter.resolveModel(ROUTE_MAIN, id))?.reasoning?.efforts ?? []
const mimoMenu = await menu('mimo-v2.6-flash-free')
check('the thinking-always-on menu states the doubled ceiling it will send',
  mimoMenu.map(row => row.description.match(/^(\d+) K/)?.[1]), ['4', '16', '32'])
check('and says out loud that thinking cannot be switched off here',
  mimoMenu.every(row => /cannot be switched off/.test(row.description)), true)
const museMenu = await menu('muse-spark-1.3-contributor-free')
check('a model that can think nothing at all keeps the published rungs',
  museMenu.map(row => row.description.match(/^(\d+) K/)?.[1]), ['2', '8', '32'])
check('without the always-thinking clause', museMenu.every(row => !/cannot be switched off/.test(museMenu[0]?.description ?? '') || !/cannot be switched off/.test(row.description)), true)
const mimoEntry = CATALOG.find(entry => entry.id === 'mimo-v2.6-flash-free')
check('a reasoning model carries the rung ladder it will really send',
  budgetLadder(mimoEntry, undefined, 32768).map(row => `${row.id}:${row.tokens}`), ['light:4096', 'balanced:16384', 'deep:32768'])
const jevResolved = await adapter.resolveModel(ROUTE_MAIN, 'jev-1.13-free')
check('a model with no effort menu carries no ladder to mislead with',
  [jevResolved?.reasoning, CATALOG.find(entry => entry.id === 'jev-1.13-free').reasoning], [undefined, false])

// Turning the region group off hides those models rather than listing them as broken.
runtimeSettings.exposeRegionModels = false
check('withhold-region hides them from the region route', await advertised(ROUTE_REGION), [])
check('and from the main route too', (await advertised(ROUTE_MAIN)).includes('muse-spark-1.3-contributor-free'), false)
runtimeSettings.exposeRegionModels = true

// ── the round where the lane itself is down: every model reads as refused ────
stub.api.refuseAll = true
await runRound()
check('a lane-wide failure never empties the picker', (await advertised(ROUTE_MAIN)).length > 0, true)
check('it keeps the refused models rather than dropping them', (await advertised(ROUTE_MAIN)).includes('deepseek-v4-flash-free'), true)
check('and says so in the log', roundLogs.some(line => line.includes('refused all')), true)
stub.api.refuseAll = false
await runRound()
check('the next honest round hides them again', (await advertised(ROUTE_MAIN)).includes('deepseek-v4-flash-free'), false)

// ── the forward listener: loopback-only bind, one roster, the picker's gate ──
// The forward listener spends this machine's free lane, so it binds loopback and
// nothing else: a routable address would put the whole subnet's traffic through
// the user's egress on the strength of one string.
const forwardPort = await freePort()
const key = generateKey()
const refusedBind = await startForwardServer({
  config: () => ({ enabled: true, host: '0.0.0.0', port: forwardPort, key }),
  complete: async () => { throw new Error('must not serve') },
  modelRows: () => [],
}).then(() => 'started', error => error)
check('a routable forward bind is refused outright', refusedBind instanceof Error, true)
check('and says which address is acceptable', /loopback/i.test(String(refusedBind?.message ?? '')), true)

const complete = (await import('../../src/turn.js')).createRunForwarded({
  getCatalog: () => CATALOG,
  getState: state,
  getSettings: () => runtimeSettings,
  adapter,
})
const forward = await startForwardServer({
  config: () => ({ enabled: true, host: '127.0.0.1', port: forwardPort, key }),
  complete,
  modelRows: () => publicModelRows(CATALOG, routableModelIds(state, runtimeSettings)),
  log: () => {},
})
try {
  check('a loopback bind still works', forward.port > 0, true)
  const listed = await fetch(`http://127.0.0.1:${forwardPort}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  check('and the listener answers its own model list', listed.status, 200)
  // The listing already hides a model the gateway names but will not route. The
  // request path has to apply the same gate: naming it in a body used to bypass
  // the picker's verdict and dial upstream for an answer the probe already knew.
  const unroutedProbes = () => stub.requests.filter(row => row.body?.model === 'jev-1.13-free').length
  const jevBefore = unroutedProbes()
  const unrouted = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jev-1.13-free', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('the forward port refuses a model the picker hides', unrouted.status, 404)
  check('and says so in the answer', /not found/.test(await unrouted.text()), true)
  check('without dialling upstream for a verdict it already has', unroutedProbes(), jevBefore)
} finally {
  await forward.close()
}

await stub.close()
console.log(failures === 0 ? '\npicker: only what this egress can use is offered' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
