// L2 集成（桩网关，禁真实出网）：#27 回归——调用方 tools 必须原样抵达上游载荷。
// 背景: 监听层曾把 caller 的 {type,function:{…}} 预转成 wrapper 再喂给
// toToolDefs（读 tool.name），每个工具都被丢弃，上游只收到指纹四件套的
// 自禁 decoy 并被钉死 tool_choice:'none'，模型于是回答"没有可用工具"。
// 决策性断言: 上游 payload.tools 非空、caller schema 存活、tool_choice 未被钉死。
// 运行: node test/integration/forward-tools.test.js（run-gates.mjs 统一收集）
import { strict as assert } from 'node:assert'
import http from 'node:http'

let passed = 0
/** @param {string} name @param {() => void | Promise<void>} fn */
async function check(name, fn) {
  try { await fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

// ── 桩网关: 记录请求，回一段最小 chat SSE ──────────────────────────────────
const captured = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    captured.push({
      method: req.method,
      path: req.url,
      headers: { ...req.headers },
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// 必须在 import 之前: UPSTREAM_BASE 在模块加载时读取。
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${port}`
const { FreeModelAdapter } = await import('../../src/adapter.js')

// ── 适配器脚手架: 一个 catalog 条目 + 记录型 deps ──────────────────────────
const entry = { id: 'stub-model', name: 'Stub Model', maxOutput: 8192, contextWindow: 131072 }
const usageRecords = []
const turnRecords = []
const snapshot = {
  catalog: [entry],
  membership: { 'our-free-model': [entry.id] },
  settings: { enabled: true, defaultMaxTokens: 8192 },
  attributionUserAgent: 'test/0.0.0',
}
const adapter = new FreeModelAdapter({
  state: () => snapshot,
  resolveImage: () => undefined,
  recordUsage: record => usageRecords.push(record),
  recordTurn: record => turnRecords.push(record),
  warn: () => {},
})

const openAiTool = name => ({
  type: 'function',
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  },
})

/** 跑一轮到 finish，返回产出的文本。 */
async function runTurn(tools) {
  const options = {
    model: entry.id,
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    sessionId: `turn-${captured.length}`,
    signal: new AbortController().signal,
  }
  let text = ''
  let finish
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, finish }
}

// ── 断言 ────────────────────────────────────────────────────────────────────
await check('caller tools 抵达上游载荷（#27 决策性回归）', async () => {
  const caller = ['pwsh', 'glob', 'grep', 'read'].map(openAiTool)
  const { text, finish } = await runTurn(caller)
  assert.equal(captured.length, 1)
  const { path, headers, body } = captured[0]
  assert.equal(path, '/zen/v1/chat/completions')
  assert.equal(headers.authorization, 'Bearer public')
  // 核心: 上游 payload tools 非空
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, `payload.tools 空: ${JSON.stringify(body.tools)}`)
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['bash', 'glob', 'grep', 'read'])
  // pwsh 的真实 schema 以 bash 槽位存活（decoy 不会带 caller 的 parameters）
  assert.equal(body.tools[0].function.parameters.properties.x.type, 'string')
  assert.equal(String(body.tools[0].function.description).includes('unavailable'), false)
  // caller 工具在场时不得钉死 tool_choice
  assert.equal(body.tool_choice, undefined)
  // 流也正常收尾
  assert.equal(text, 'ok')
  assert.equal(finish.kind, 'stop')
})

await check('空 tools 列表才落入指纹 decoy + tool_choice none（对照组）', async () => {
  const { finish } = await runTurn([])
  assert.equal(captured.length, 2)
  const body = captured[1].body
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['bash', 'glob', 'grep', 'read'])
  assert.equal(body.tool_choice, 'none')
  assert.equal(finish.kind, 'stop')
})

await check('usage/turn 记账各两次且 ok', () => {
  assert.equal(usageRecords.length, 2)
  assert.equal(turnRecords.length, 2)
  for (const record of usageRecords) assert.equal(record.ok, true)
  for (const record of turnRecords) assert.equal(record.ok, true)
})

server.close()
server.unref?.()
console.log(`forward-tools.test: ${passed} passed`)
if (passed !== 3) process.exitCode = 1
