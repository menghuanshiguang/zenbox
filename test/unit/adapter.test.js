// L1 单元：#102 systemPromptUpdate —— kernel 只接受字面量 'in-history'。
// chat/responses 线把 system 留在数组原位，可声明；messages 线把 system 折进
// 顶层字段，声明只会换来重写而非缓存命中，故不声明。红→绿的第一条红。
// 运行: node test/unit/adapter.test.js（run-gates.mjs 统一收集）
import { strict as assert } from 'node:assert'
import { FreeModelAdapter, ROUTE_MAIN } from '../../src/adapter.js'

let passed = 0
/** @param {string} name @param {() => void | Promise<void>} fn */
async function check(name, fn) {
  try { await fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

const snapshot = {
  catalog: [
    { id: 'stub-model', name: 'Stub', maxOutput: 8192, contextWindow: 131072 },
    { id: 'union-alpha', name: 'Union Alpha', maxOutput: 8192, contextWindow: 131072 },
  ],
  membership: {},
  settings: { enabled: true, defaultMaxTokens: 8192 },
  attributionUserAgent: 'test/0.0.0',
}
const adapter = new FreeModelAdapter({
  state: () => snapshot,
  recordUsage: () => {},
})

await check('catalog 内的 chat 线模型声明 in-history', async () => {
  const info = await adapter.resolveModel(ROUTE_MAIN, 'stub-model')
  assert.equal(info.systemPromptUpdate, 'in-history')
})

await check('catalog 内的 messages 线模型不声明该字段', async () => {
  const info = await adapter.resolveModel(ROUTE_MAIN, 'union-alpha')
  assert.equal('systemPromptUpdate' in info, false)
})

await check('catalog 不认识的 responses 线模型也声明（回退分支）', async () => {
  const info = await adapter.resolveModel(ROUTE_MAIN, 'muse-spark-1.3-contributor-free')
  assert.equal(info.systemPromptUpdate, 'in-history')
})

await check('catalog 不认识的 chat 线模型也声明（回退分支）', async () => {
  const info = await adapter.resolveModel(ROUTE_MAIN, 'never-heard-of-it-free')
  assert.equal(info.systemPromptUpdate, 'in-history')
})

console.log(`adapter.test: ${passed} passed`)
if (passed !== 4) process.exitCode = 1
