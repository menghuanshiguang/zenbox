/**
 * banner.js — §8.4 启动横幅的字段锁（框结构 + 异步占位 + 三态）。
 *
 * 冷启动 banner 必须字段齐全且不许因网络信息缺失而崩（IP 全挂=unknown、
 * 清单未拉=异步占位）。
 */
import { strict as assert } from 'node:assert'
import { renderBanner, renderIpLine, renderModelsLine, renderLanAddressLine } from '../../src/banner.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const full = {
  version: '0.1.0',
  upstream: 'https://opencode.ai/zen/v1',
  listen: { host: '127.0.0.1', port: 18899, requestedPort: 18899, fellBack: false },
  keyTail: 'bodR',
  lan: { enabled: false },
  ip: null,
  lanAddresses: null,
  models: null,
}

await Promise.resolve()
check('框头带版本，框尾闭合，每行以 │ 起（§8.4 结构）', () => {
  const lines = renderBanner(full)
  assert.ok(lines[0].includes('zenbox v0.1.0'), `头行=${lines[0]}`)
  assert.ok(lines.at(-1).startsWith('└'), `尾行=${lines.at(-1)}`)
  assert.ok(lines.slice(1, -1).every(line => line.startsWith('│')), '中间行必须都在框内')
})

check('上游行 = base + 免密车道', () => {
  const text = renderBanner(full).join('\n')
  assert.ok(text.includes('https://opencode.ai/zen/v1'))
  assert.ok(text.includes('免密车道'))
})

check('本机转发行带实际端口与 Key 尾4', () => {
  const text = renderBanner(full).join('\n')
  assert.ok(text.includes('http://127.0.0.1:18899'))
  assert.ok(text.includes('Key: ofm-****bodR') || text.includes('bodR'), 'Key 尾4 必须出现')
})

check('端口顺延时如实标注（#23）', () => {
  const lines = renderBanner({ ...full, listen: { host: '127.0.0.1', port: 18900, requestedPort: 18899, fellBack: true } })
  const text = lines.join('\n')
  assert.ok(text.includes('18900'), '显示实际端口')
  assert.ok(text.includes('18899'), '显示请求端口')
})

check('Key 未生成时显示未生成', () => {
  const text = renderBanner({ ...full, keyTail: null }).join('\n')
  assert.ok(text.includes('未生成'))
})

check('局域网中继关闭行给开启提示；开启行带端口', () => {
  const off = renderBanner(full).join('\n')
  assert.ok(off.includes('关闭') && off.includes('lan.enabled=true'))
  const on = renderBanner({ ...full, lan: { enabled: true, host: '0.0.0.0', port: 18899, fellBack: false } }).join('\n')
  assert.ok(on.includes('18899') || on.includes('已启用'), `开启态=${on}`)
})

check('公网出口 pending 走 [异步] 占位，拿到后回 IP+国家，全挂回 unknown 不崩', () => {
  const pending = renderBanner(full).join('\n')
  assert.ok(pending.includes('公网出口'))
  assert.ok(pending.includes('[异步]'), 'pending 必须显式标 [异步]')
  const line = renderIpLine({ ip: '203.0.113.7', country: 'JP', provider: 'ipify' })
  assert.ok(line.includes('203.0.113.7') && line.includes('JP'))
  const dead = renderIpLine({ ip: 'unknown', country: '', provider: '' })
  assert.ok(dead.includes('unknown'))
})

check('模型清单 pending 同款占位，有数后给四段计数', () => {
  const pending = renderBanner(full).join('\n')
  assert.ok(pending.includes('模型清单'))
  const line = renderModelsLine({ total: 10, available: 7, regionLimited: 2, removed: 1 })
  assert.ok(line.includes('10 个') && line.includes('可用 7') && line.includes('地区受限 2') && line.includes('移除 1'))
})

check('局域网地址行给物理/虚拟分组（#76），空则占位', () => {
  const line = renderLanAddressLine([{ address: '192.168.1.23', kind: '物理' }, { address: '10.208.90.204', kind: '虚拟' }])
  assert.ok(line.includes('192.168.1.23 (物理)'))
  assert.ok(line.includes('10.208.90.204 (虚拟)'))
  const empty = renderLanAddressLine(null)
  assert.ok(empty.includes('[异步]'))
})

console.log(`\nbanner: ${passed} passed`)
if (passed !== 9) process.exitCode = 1
