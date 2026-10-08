/**
 * 转发门单元断言：§7.2 审计补 keyMatches / toOpenAiUsage / SSE_HEARTBEAT_MS
 * 三个纯符号（此前只有大套件间接覆盖或纯 mention）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyMatches, SSE_HEARTBEAT_MS, toOpenAiUsage, generateKey } from '../../src/forward.js'

test('forward: keyMatches 定时安全比较——对/错/异长/非串', () => {
  const key = generateKey()
  assert.ok(keyMatches(key, key)) // 原值命中
  assert.ok(!keyMatches(`${key}x`, key)) // 异长先短路
  assert.ok(!keyMatches('ofm-wrong', key)) // 同长异值（长度相等才走 timingSafeEqual）
  assert.ok(!keyMatches(null, key)) // 非串守卫
  assert.ok(!keyMatches(key, undefined))
  assert.ok(/^ofm-[A-Za-z0-9_-]{32}$/.test(key)) // generateKey 形状（ofm- 前缀 + 24 字节 base62url）
})

test('forward: SSE_HEARTBEAT_MS 心跳间隔定值（#25 静默心跳）', () => {
  assert.equal(SSE_HEARTBEAT_MS, 15000)
})

test('forward: toOpenAiUsage 聚合与分账', () => {
  assert.equal(toOpenAiUsage(undefined), undefined) // usage 缺席 → 整体缺席
  const usage = toOpenAiUsage({ inputTokens: 10, cacheReadTokens: 5, outputTokens: 3, reasoningTokens: 2 })
  assert.equal(usage.prompt_tokens, 15) // input + cacheRead
  assert.equal(usage.completion_tokens, 3)
  assert.equal(usage.total_tokens, 18)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 5)
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 2)
  const bare = toOpenAiUsage({}) // 全缺 → 0 账
  assert.deepEqual([bare.prompt_tokens, bare.completion_tokens, bare.total_tokens], [0, 0, 0])
})
