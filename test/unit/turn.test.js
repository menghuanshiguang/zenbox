// L1 单元：src/turn.js —— 转发口一次请求的语义链（素材抽自 index.js，M1）。
// fromOpenAiMessages 钉住 issue #62 的 assistant source 形状；
// computeMembership 钉住探测判定→路由归属（拒答全空时整体回退）；
// runForwarded 钉住 OpenAI 语义（404 模型/工具展平/max_tokens 截断过滤）。
// 红→绿：先断言（src/turn.js 尚不存在，应纯红），再抽取实现。
// 运行: node test/unit/turn.test.js
import { strict as assert } from 'node:assert'
import {
  httpError, computeMembership, routableModelIds, publicModelRows,
  fromOpenAiMessages, normalizeTool, foldForwardOutcome, createRunForwarded,
} from '../../src/turn.js'
import { ROUTE_MAIN, ROUTE_REGION } from '../../src/adapter.js'
import { effortsFor } from '../../src/effort.js'
import { STATE } from '../../src/probe.js'
import { buildCatalog } from '../../src/catalog.js'

let passed = 0
/** @param {string} name @param {() => void | Promise<void>} fn */
async function check(name, fn) {
  try { await fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

const cat = ids => ids.map(id => buildCatalog([id])[0])
const MIMO = buildCatalog(['mimo-v2.6-flash-free'])[0]
const UNION = buildCatalog(['union-alpha'])[0]

// ─── httpError ───
await check('httpError 带状态码', () => {
  const error = httpError(404, 'model "x" not found')
  assert.equal(error.statusCode, 404)
  assert.equal(error.message, 'model "x" not found')
})

// ─── fromOpenAiMessages（issue #62 source 形状） ───
await check('字符串 content→text 块，assistant 带 source', () => {
  const out = fromOpenAiMessages({ messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ] }, false, 'mimo-v2.6-flash-free')
  assert.deepEqual(out.map(row => row.role), ['system', 'user', 'assistant'])
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'hi' }])
  assert.deepEqual(out[2].source, { kind: 'model', provider: ROUTE_MAIN, model: 'mimo-v2.6-flash-free' })
  assert.equal(out[0].source, undefined)
})
await check('tool_calls 展开为 tool-call 块 + tool 角色带 callId', () => {
  const out = fromOpenAiMessages({ messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"cmd":"id"}' } }] },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' },
  ] }, false, 'm1')
  assert.deepEqual(out[0].content, [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"id"}' }])
  assert.equal(out[1].toolCallId, 'c1')
  assert.deepEqual(out[1].source, { kind: 'tool', callId: 'c1' })
})
await check('图片 part→image 块（url 数据）', () => {
  const out = fromOpenAiMessages({ messages: [{ role: 'user', content: [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ] }] }, false, 'm1')
  assert.equal(out[0].content[1].type, 'image')
  assert.equal(out[0].content[1].attachment.url, 'data:image/png;base64,AAAA')
})
await check('Responses input 归一：function_call / function_call_output / 字符串', () => {
  const out = fromOpenAiMessages({ input: [
    'plain',
    { type: 'function_call', call_id: 'f1', name: 'search', arguments: '{}' },
    { type: 'function_call_output', call_id: 'f1', output: '{"hits":[]}' },
  ] }, true, 'm1')
  assert.equal(out[0].role, 'user')
  assert.deepEqual(out[1].content, [{ type: 'tool-call', id: 'f1', name: 'search', arguments: '{}' }])
  assert.equal(out[2].role, 'tool')
  assert.equal(out[2].toolCallId, 'f1')
})

// ─── normalizeTool ───
await check('扁平与 function 包装都展平；缺名→null', () => {
  assert.deepEqual(normalizeTool({ name: 'a', description: 'd', parameters: { type: 'object' } }),
    { name: 'a', description: 'd', parameters: { type: 'object' } })
  assert.deepEqual(normalizeTool({ type: 'function', function: { name: 'b', description: 'x', parameters: { type: 'object', properties: {} } } }),
    { name: 'b', description: 'x', parameters: { type: 'object', properties: {} } })
  assert.equal(normalizeTool({ function: {} }), null)
  assert.equal(normalizeTool({ name: '  ' }), null)
})

// ─── foldForwardOutcome ───
await check('text-delta 累加；usage/finish 折入', () => {
  const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  foldForwardOutcome(outcome, { type: 'text-delta', text: 'he' })
  foldForwardOutcome(outcome, { type: 'text-delta', text: 'llo' })
  foldForwardOutcome(outcome, { type: 'usage', usage: { inputTokens: 5, cacheReadTokens: 0, outputTokens: 7 } })
  foldForwardOutcome(outcome, { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(outcome.text, 'hello')
  assert.equal(outcome.usage.prompt_tokens, 5)
  assert.equal(outcome.usage.completion_tokens, 7)
  assert.equal(outcome.usage.total_tokens, 12)
  assert.equal(outcome.truncated, false)
  assert.equal(outcome.error, undefined)
})
await check('tool-call-delta 建槽累参，name/id 后到补全', () => {
  const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  foldForwardOutcome(outcome, { type: 'tool-call-delta', index: 0, argumentsDelta: '{"c"' })
  foldForwardOutcome(outcome, { type: 'tool-call-delta', index: 0, argumentsDelta: ':1}', id: 't1', name: 'run' })
  assert.deepEqual(outcome.toolCalls, [{ slot: 0, id: 't1', name: 'run', arguments: '{"c":1}' }])
})
await check('max-tokens→truncated，error/aborted→error 消息', () => {
  const a = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  foldForwardOutcome(a, { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(a.truncated, true)
  const b = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  foldForwardOutcome(b, { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } })
  assert.equal(b.error, 'boom')
  const c = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  foldForwardOutcome(c, { type: 'finish', reason: { kind: 'aborted' } })
  assert.equal(c.error, undefined)
})

// ─── computeMembership（探测判定→路由） ───
const catalog2 = cat(['mimo-v2.6-flash-free', 'union-alpha'])
const membershipOf = (results, settings) => computeMembership(catalog2, { results }, settings ?? {})
await check('无判定→全在主线（新装没探测不是拒答）', () => {
  const m = membershipOf({})
  assert.deepEqual(m[ROUTE_MAIN], ['mimo-v2.6-flash-free', 'union-alpha'])
  assert.equal(m[ROUTE_REGION], undefined)
})
await check('单模型 unavailable 出主线，其余保留', () => {
  const m = membershipOf({ 'union-alpha': { state: STATE.unavailable } })
  assert.deepEqual(m[ROUTE_MAIN], ['mimo-v2.6-flash-free'])
})
await check('全部 unavailable→整轮回退（线路坏≠花名册消失）', () => {
  const m = membershipOf({
    'mimo-v2.6-flash-free': { state: STATE.unavailable },
    'union-alpha': { state: STATE.unavailable },
  })
  assert.deepEqual(m[ROUTE_MAIN], ['mimo-v2.6-flash-free', 'union-alpha'])
})
await check('region-blocked 进区域线，exposeRegionModels=false 时隐藏', () => {
  const m = membershipOf({ 'union-alpha': { state: STATE.regionBlocked } })
  assert.deepEqual(m[ROUTE_MAIN], ['mimo-v2.6-flash-free'])
  assert.deepEqual(m[ROUTE_REGION], ['union-alpha'])
  const hidden = membershipOf({ 'union-alpha': { state: STATE.regionBlocked } }, { exposeRegionModels: false })
  assert.equal(hidden[ROUTE_REGION], undefined)
})

// ─── routableModelIds / publicModelRows ───
await check('routableModelIds 主线+（暴露时）区域线合并', () => {
  const state = () => ({ membership: { [ROUTE_MAIN]: ['a'], [ROUTE_REGION]: ['b'] } })
  assert.deepEqual([...routableModelIds(state, {})], ['a', 'b'])
  assert.deepEqual([...routableModelIds(state, { exposeRegionModels: false })], ['a'])
})
await check('publicModelRows 过滤到可拨号线路并带 context_window', () => {
  const rows = publicModelRows(catalog2, new Set(['mimo-v2.6-flash-free']))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'mimo-v2.6-flash-free')
  assert.equal(rows[0].object, 'model')
  assert.equal(rows[0].owned_by, 'our-free-model')
  assert.equal(rows[0].context_window, 1048576)
})
await check('publicModelRows 暴露 x_ofm_efforts 与默认档，与 picker 菜单同源（#74）', () => {
  const rows = publicModelRows(catalog2, new Set(['mimo-v2.6-flash-free']))
  const entry = catalog2.find(item => item.id === 'mimo-v2.6-flash-free')
  const ladder = effortsFor(entry, undefined, 32768)
  assert.ok(Array.isArray(ladder) && ladder.length > 0, '前提：mimo 有档位梯子')
  assert.deepEqual(rows[0].x_ofm_efforts, ladder.map(row => row.id))
  assert.ok(rows[0].x_ofm_efforts.includes(rows[0].x_ofm_effort_default))
})
await check('无档位模型不带 x_ofm_*（effortsFor 返回 undefined 即整段省略）', () => {
  const rows = publicModelRows(catalog2, new Set(['union-alpha']))
  assert.equal('x_ofm_efforts' in rows[0], false)
  assert.equal('x_ofm_effort_default' in rows[0], false)
})

// ─── createRunForwarded（OpenAI 语义门） ───
const fakeAdapter = () => {
  const calls = []
  return {
    calls,
    stream: async function* (options) {
      calls.push(options)
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
const wiring = adapter => createRunForwarded({
  getCatalog: () => catalog2,
  getState: () => ({ membership: { [ROUTE_MAIN]: ['mimo-v2.6-flash-free', 'union-alpha'], [ROUTE_REGION]: [] }, settings: {} }),
  getSettings: () => ({}),
  adapter,
})
await check('未知模型→404（网关的锅不是调用方的错）', async () => {
  const run = wiring(fakeAdapter())
  await assert.rejects(() => run({ model: 'nope', openAi: {} }, null), error => error.statusCode === 404)
})
await check('线路外模型同样 404（与 /v1/models 同一门）', async () => {
  const adapter = fakeAdapter()
  const run = createRunForwarded({
    getCatalog: () => catalog2,
    getState: () => ({ membership: { [ROUTE_MAIN]: ['mimo-v2.6-flash-free'], [ROUTE_REGION]: [] }, settings: {} }),
    getSettings: () => ({}),
    adapter,
  })
  await assert.rejects(() => run({ model: 'union-alpha', openAi: {} }, null), error => error.statusCode === 404)
  assert.equal(adapter.calls.length, 0)
})
await check('参数映射：temperature/max_tokens/reasoning_effort/工具展平', async () => {
  const adapter = fakeAdapter()
  const run = wiring(adapter)
  const outcome = await run({ model: 'mimo-v2.6-flash-free', openAi: {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash', description: 'd', parameters: { type: 'object', properties: {} } } }],
    temperature: 0.7,
    max_tokens: 512,
    reasoning_effort: 'deep',
    user: 'u1',
  } }, null)
  const options = adapter.calls[0]
  assert.equal(options.temperature, 0.7)
  assert.equal(options.maxTokens, 512)
  assert.equal(options.reasoningEffort, 'deep')
  assert.equal(options.provider, ROUTE_MAIN)
  assert.deepEqual(options.tools, [{ name: 'bash', description: 'd', parameters: { type: 'object', properties: {} } }])
  assert.equal(options.messages[0].role, 'user')
  assert.match(options.sessionId, /^forward:/)
  assert.equal(outcome.text, 'ok')
  assert.equal(outcome.error, undefined)
})
await check('截断轮过滤参数坏掉的工具调用（与 length 一致）', async () => {
  const adapter = {
    stream: async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 't1', name: 'bash', arguments: '{"cmd":' } }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 't2', name: 'bash', arguments: '{"cmd":"id"}' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  const outcome = await wiring(adapter)({ model: 'mimo-v2.6-flash-free', openAi: { messages: [] } }, null)
  assert.equal(outcome.truncated, true)
  assert.deepEqual(outcome.toolCalls.map(call => call.id), ['t2'])
})

console.log(`turn.test: ${passed} passed`)
if (passed !== 21) process.exitCode = 1
