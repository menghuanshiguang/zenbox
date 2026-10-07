// L1 单元：#113 独立回归——并行图片结果的相邻性（上游 #112）。
// 并行 read_image 批次产生多条 tool 结果；图片跟随的 user 行若插在中间，
// 上游会把批次从中间劈开（配对断裂/拒收）。投影必须先吐完全部结果，
// 再一次性吐出延后的图片与包裹文本。源码投影次序已含（同 #27 情形），
// 本用例锁住它。运行: node test/unit/messages-projection.test.js
import { strict as assert } from 'node:assert'
import { repairToolPairing, toChatMessages, toResponseInput } from '../../src/messages.js'

let passed = 0
/** @param {string} name @param {() => void | Promise<void>} fn */
async function check(name, fn) {
  try { await fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

const resolveImage = () => 'data:image/png;base64,AAAA'
const image = id => ({ type: 'image', attachment: { attachmentId: `att_${id}`, mediaType: 'image/png', url: 'data:image/png;base64,AAAA' } })
const callBlock = id => ({ type: 'tool-call', id, name: 'read_image', arguments: '{"path":"x.png"}' })
const v4Result = (id, block) => ({
  role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, isError: false,
  content: [{ type: 'text', text: 'done' }, block], id: `msg-${id}`,
})

const source = [
  { role: 'user', content: [{ type: 'text', text: 'read both' }] },
  { role: 'assistant', content: [callBlock('a'), callBlock('b')] },
  v4Result('a', image('a')),
  v4Result('b', image('b')),
]

await check('chat: 两条 tool 结果相邻，图片行全部在其后', async () => {
  const chat = toChatMessages(repairToolPairing([...source]), resolveImage, [])
  const toolIdx = chat.map((row, i) => (row.role === 'tool' ? i : -1)).filter(i => i >= 0)
  assert.equal(toolIdx.length, 2)
  assert.equal(toolIdx[1], toolIdx[0] + 1, 'the two results must sit back to back')
  const imageIdx = chat.flatMap((row, i) =>
    Array.isArray(row.content) ? row.content.filter(b => b.type === 'image_url').map(() => i) : [])
  assert.equal(imageIdx.length, 2)
  for (const i of imageIdx) assert.ok(i > toolIdx[1], `image row ${i} must follow both tool rows`)
  assert.equal(chat.at(-1).role, 'user')
})

await check('Responses: 两条 function_call_output 相邻，图片 message 全部在其后', async () => {
  const responses = toResponseInput(repairToolPairing([...source]), resolveImage, [])
  const outIdx = responses.map((row, i) => (row.type === 'function_call_output' ? i : -1)).filter(i => i >= 0)
  assert.equal(outIdx.length, 2)
  assert.equal(outIdx[1], outIdx[0] + 1, 'the two outputs must sit back to back')
  const imageIdx = responses.flatMap((row, i) =>
    (Array.isArray(row.content) ? row.content : []).filter(b => b.type === 'input_image').map(() => i) ?? [])
  assert.equal(imageIdx.length, 2)
  for (const i of imageIdx) assert.ok(i > outIdx[1], `image item ${i} must follow both outputs`)
})

await check('混合包裹文本不打断结果且只保留一次', async () => {
  const mixed = [
    { role: 'assistant', content: [callBlock('a'), callBlock('b')] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', content: [image('a')] }, { type: 'text', text: 'keep this note' }] },
    v4Result('b', image('b')),
  ]
  const chat = toChatMessages(repairToolPairing(mixed), resolveImage, [])
  assert.deepEqual(chat.map(row => row.role), ['assistant', 'tool', 'tool', 'user'])
  assert.equal(JSON.stringify(chat).split('keep this note').length - 1, 1)
})

await check('源历史不被投影改动', async () => {
  const original = JSON.stringify(source)
  toChatMessages(repairToolPairing([...source]), resolveImage, [])
  toResponseInput(repairToolPairing([...source]), resolveImage, [])
  assert.equal(JSON.stringify(source), original)
})

console.log(`messages-projection.test: ${passed} passed`)
if (passed !== 4) process.exitCode = 1
