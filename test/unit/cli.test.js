// L1 单元测试：CLI 解析 / banner 渲染 / Key 三助手（§8.1 key 空=首启生成 0600）。
// 运行: node test/unit/cli.test.js （run-gates.mjs 统一收集）
import { strict as assert } from 'node:assert'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgv, printBanner, VERSION } from '../../start.js'
import { ensureKey, rotateKey, readKey } from '../../src/store.js'
import { DEFAULTS, loadConfig } from '../../src/config.js'

let passed = 0
/** @param {string} name @param {() => void} fn */
function check(name, fn) {
  try { fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

// —— parseArgv ——
check('parseArgv: 空 argv 默认 start', () => {
  const parsed = parseArgv([])
  assert.equal(parsed.command, 'start')
  assert.equal(parsed.json, false)
  assert.deepEqual(parsed.flags, [])
})
check('parseArgv: key rotate 走 positional，--json 单列', () => {
  const parsed = parseArgv(['key', 'rotate', '--json'])
  assert.equal(parsed.command, 'key')
  assert.deepEqual(parsed.positional, ['key', 'rotate'])
  assert.equal(parsed.json, true)
})
check('parseArgv: 以 -- 开头的其余参数原样进 flags（交 loadConfig flag 层）', () => {
  const parsed = parseArgv(['status', '--port=19001', '--verbose'])
  assert.deepEqual(parsed.flags, ['--port=19001', '--verbose'])
  assert.deepEqual(parsed.positional, ['status'])
})

// —— printBanner（§8.4 字段）——
const config = loadConfig({ argv: [] })
check('printBanner: 版本行 + 默认本机转发行', () => {
  const lines = []
  printBanner(config, line => lines.push(line), {})
  assert.equal(lines[0], `zenbox v${VERSION} · opencode 免费模型中继`)
  assert.ok(lines.some(line => line.startsWith('本机转发') && line.includes('127.0.0.1:18899')))
})
check('printBanner: 端口顺延时如实标出原端口（#23）', () => {
  const lines = []
  printBanner(config, line => lines.push(line), { port: 18900, requestedPort: 18899, fellBack: true })
  assert.ok(lines.some(line => line.includes('127.0.0.1:18900') && line.includes('已顺延自 18899')))
})
check('printBanner: Key 尾4 与模型数异步补行', () => {
  const lines = []
  printBanner(config, line => lines.push(line), { keyTail: 'bodR', models: 8 })
  assert.ok(lines.some(line => line.includes('尾4 bodR')))
  assert.ok(lines.some(line => line.includes('8 个')))
})
check('printBanner: lan 默认关闭文案含独立 Key 提示', () => {
  const lines = []
  printBanner(config, line => lines.push(line), {})
  assert.ok(lines.some(line => line.includes('局域网') && line.includes('独立 Key 与本机不通用')))
})

// —— Key 三助手（store.js：data/ 0600，config 显式优先）——
const dir = mkdtempSync(join(tmpdir(), 'zenbox-key-'))
try {
  check('ensureKey: explicit 为空时生成 ofm- 前缀 Key 并写文件', () => {
    const first = ensureKey(dir, 'forward-key', '')
    assert.equal(first.source, 'generated')
    assert.match(first.key, /^ofm-/)
    assert.ok(existsSync(first.path))
    assert.ok(readFileSync(first.path, 'utf8').trim() === first.key)
  })
  check('ensureKey: 已有文件时复读（source=file，key 不变）', () => {
    const again = ensureKey(dir, 'forward-key', '')
    assert.equal(again.source, 'file')
    assert.match(again.key, /^ofm-/)
  })
  check('ensureKey: config 显式 Key 优先——不写文件、source=config', () => {
    const explicit = ensureKey(dir, 'lan-key', 'ofm-from-config')
    assert.equal(explicit.key, 'ofm-from-config')
    assert.equal(explicit.source, 'config')
    assert.equal(explicit.path, null)
    assert.equal(existsSync(join(dir, 'lan-key')), false, '显式 Key 不落盘')
  })
  check('rotateKey: 无条件换新——旧 Key 立即失效', () => {
    const before = readKey(dir, 'forward-key')
    const rotated = rotateKey(dir, 'forward-key')
    assert.notEqual(rotated.key, before.key)
    assert.equal(readKey(dir, 'forward-key').key, rotated.key)
  })
  check('readKey: 无文件无显式 → missing', () => {
    const ghost = readKey(dir, 'no-such-key')
    assert.equal(ghost.source, 'missing')
    assert.equal(ghost.key, '')
  })
  check('readKey: 显式 Key 在文件缺失时仍生效', () => {
    const direct = readKey(dir, 'no-such-key', 'ofm-explicit')
    assert.equal(direct.source, 'config')
    assert.equal(direct.key, 'ofm-explicit')
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

check('DEFAULTS: listen.fallback 默认 true（#23 顺延开）', () => {
  assert.equal(DEFAULTS.listen.fallback, true)
})

console.log(`cli: ${passed} passed`)
if (passed !== 14) {
  console.error(`expected 14 assertions, got ${passed}`)
  process.exitCode = 1
}
