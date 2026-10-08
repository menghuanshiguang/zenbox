/**
 * 上游链单元断言：把六模块审计（§7.2 "每导出符号 ≥1 断言"）里
 * src/upstream.js 的缺口一次性补齐——id 铸造/复用、路由三 wire、
 * 端点与声明面常量、惰性 base。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPSTREAM_BASE, upstreamBase, CLIENT_UA,
  SESSION_RE, REQUEST_RE, mintSessionId, mintRequestId,
  sessionForConversation, requestIdFor, baseModelId,
  isResponsesModel, isMessagesModel, endpointFor, wireFor,
  declaredToolNames, truncateSession, ANTHROPIC_API_VERSION, MAX_TOOL_NAME_LEN,
} from '../../src/upstream.js'

test('upstream: base 惰性随 env 走（loadConfig 同步的单一真相）', () => {
  const saved = process.env.OUR_FREE_MODEL_BASE
  try {
    delete process.env.OUR_FREE_MODEL_BASE
    assert.equal(upstreamBase(), UPSTREAM_BASE) // 未设 env：与模块快照同源
    process.env.OUR_FREE_MODEL_BASE = 'http://127.0.0.1:9'
    assert.equal(upstreamBase(), 'http://127.0.0.1:9') // 设了就立刻变，不受模块加载时刻约束
    assert.equal(typeof UPSTREAM_BASE, 'string')
    assert.ok(UPSTREAM_BASE.length > 0) // UPSTREAM_BASE 常量非空（素材/probe 面仍引用它）
  } finally {
    if (saved === undefined) delete process.env.OUR_FREE_MODEL_BASE
    else process.env.OUR_FREE_MODEL_BASE = saved
  }
})

test('upstream: UA 与头部常量的字面量', () => {
  assert.equal(CLIENT_UA, 'opencode/1.18.31')
  assert.equal(ANTHROPIC_API_VERSION, '2023-06-01')
  assert.equal(MAX_TOOL_NAME_LEN, 128)
})

test('upstream: SESSION_RE/REQUEST_RE 锁定铸出来的 id 形状', () => {
  assert.match(mintSessionId(), SESSION_RE)
  assert.match(mintRequestId(), REQUEST_RE)
  assert.ok(SESSION_RE.test('ses_0123456789abABCDEFGHIJKLMN')) // 恰 12 hex + 14 base62 = 26 尾字符
  assert.ok(!SESSION_RE.test('ses_0123456789abcdef')) // 尾段不足 14
  assert.ok(!REQUEST_RE.test('nope_0123456789abcdefABCDEFGH'))
})

test('upstream: sessionForConversation 同对话稳定、已规范 id 原样', () => {
  const stable = sessionForConversation('chat-alpha')
  assert.match(stable, SESSION_RE)
  assert.equal(sessionForConversation('chat-alpha'), stable) // 复算同值（跨重启同 session 才不烧配额）
  assert.notEqual(sessionForConversation('chat-beta'), stable) // 不同对话不撞
  const canonical = mintSessionId()
  assert.equal(sessionForConversation(`  ${canonical}  `), canonical.trim()) // 已规范 id 直通（去空白）
  assert.match(sessionForConversation(undefined), SESSION_RE) // 无会话也有兜底
})

test('upstream: requestIdFor 同轮稳定，空 seed 退铸造', () => {
  const a = requestIdFor('ses_0123456789abcdefABCDEFGH', 'turn-1')
  assert.match(a, REQUEST_RE)
  assert.equal(requestIdFor('ses_0123456789abcdefABCDEFGH', 'turn-1'), a) // 同轮重试共享 id
  assert.notEqual(requestIdFor('ses_0123456789abcdefABCDEFGH', 'turn-2'), a)
  assert.match(requestIdFor('ses_0123456789abcdefABCDEFGH', ''), REQUEST_RE) // 空 seed → 每次铸造
  assert.match(requestIdFor('ses_0123456789abcdefABCDEFGH', undefined), REQUEST_RE)
})

test('upstream: baseModelId 剥思考后缀，三 wire 路由各归其位', () => {
  assert.equal(baseModelId('muse-spark-1.3 (deep)'), 'muse-spark-1.3') // mention-only 转真断言
  assert.equal(baseModelId('plain-model'), 'plain-model')
  assert.equal(baseModelId(undefined), '') // String(undefined ?? '')=''
  assert.ok(isResponsesModel('muse-spark-1.3-contributor-free'))
  assert.ok(isResponsesModel('x/muse-spark-1.2-contributor-free (deep)')) // label+后缀剥净后命中
  assert.ok(!isResponsesModel('mimo-v2.6-flash-free'))
  assert.ok(isMessagesModel('union-alpha'))
  assert.ok(!isMessagesModel('mimo-v2.6-flash-free'))
  assert.equal(endpointFor('mimo-v2.6-flash-free'), '/zen/v1/chat/completions')
  assert.equal(endpointFor('muse-spark-1.3-contributor-free'), '/zen/v1/responses')
  assert.equal(endpointFor('union-alpha'), '/zen/v1/messages')
  assert.equal(wireFor('union-alpha'), 'messages') // recovery 已覆盖 wireFor，此处只作路由链自检
})

test('upstream: declaredToolNames 两拼写都收（#27 晋升前提）', () => {
  const names = declaredToolNames({ tools: [{ name: 'bash' }, { function: { name: 'read' } }] })
  assert.ok(names instanceof Set)
  assert.deepEqual([...names].sort(), ['bash', 'read']) // 平铺与嵌套双形状
  assert.deepEqual([...declaredToolNames({})], []) // 无 tools → 空集
  assert.deepEqual([...declaredToolNames({ tools: [{ description: 'no name' }] })], []) // 缺名丢弃
})

test('upstream: truncateSession 长度上限与类型守卫', () => {
  assert.equal(truncateSession(12345), '') // 非字符串 → 空
  const long = `x`.repeat(512)
  assert.equal(truncateSession(long).length, 256) // MAX_SESSION_LENGTH=256 截断
  assert.equal(truncateSession('  short  '), 'short') // 256 内只 trim
})
