// L1 单元测试：config 三层合并 / // 注释剥离 / 逐字段校验（红→绿的第一条红）。
// 运行: node test/unit/config.test.js （run-gates.mjs 会统一收集）
import { strict as assert } from 'node:assert'
import {
  ConfigError, DEFAULTS, loadConfig, parseConfigFile, stripComments, validateConfig,
} from '../../src/config.js'

let passed = 0
/** @param {string} name @param {() => void} fn */
function check(name, fn) {
  try { fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

// —— // 注释剥离（允许行内 //，字符串字面量内的 // 不受影响）——
check('stripComments: 行注释与行内注释被移除', () => {
  const out = stripComments(`{\n  // 纯注释\n  "a": 1 // 行内\n}`)
  assert.deepEqual(JSON.parse(out), { a: 1 })
})
check('stripComments: 字符串里的 // 原样保留', () => {
  const out = stripComments(`{ "u": "https://opencode.ai" }`)
  assert.equal(JSON.parse(out).u, 'https://opencode.ai')
})
check('parseConfigFile: 带注释的文件可解析', () => {
  const parsed = parseConfigFile(`{\n  // 首行注释\n  "effort": "deep"\n}`)
  assert.equal(parsed.effort, 'deep')
})

// —— 默认值与 §8 口径逐字对齐 ——
check('DEFAULTS: §8 默认值', () => {
  assert.equal(DEFAULTS.listen.host, '127.0.0.1')
  assert.equal(DEFAULTS.listen.port, 18899)
  assert.equal(DEFAULTS.lan.enabled, false)
  assert.equal(DEFAULTS.lan.host, '0.0.0.0')
  assert.equal(DEFAULTS.lan.port, 18899)
  assert.equal(DEFAULTS.lan.separateKey, false)
  assert.equal(DEFAULTS.upstream.baseUrl, 'https://opencode.ai')
  assert.equal(DEFAULTS.upstream.timeoutMs, 45000)
  assert.equal(DEFAULTS.catalog.refreshMinutes, 30)
  assert.equal(DEFAULTS.probe.enabled, true)
  assert.equal(DEFAULTS.probe.intervalMinutes, 60)
  assert.equal(DEFAULTS.probe.concurrency, 2)
  assert.equal(DEFAULTS.effort, 'balanced')
  assert.equal(DEFAULTS.egress.mode, 'direct')
  assert.equal(DEFAULTS.ip.refreshMinutes, 30)
  assert.deepEqual(DEFAULTS.ip.providers, ['ipify', 'ipinfo', 'ipapi'])
})

// —— 校验：拒绝启动的每类错误都指向字段 ——
/** @param {() => void} fn @param {string} fieldPart */
function expectConfigError(fn, fieldPart) {
  assert.throws(fn, (/** @type {any} */ error) => {
    assert.ok(error instanceof ConfigError, `应为 ConfigError，实为 ${error?.constructor?.name}`)
    assert.ok(String(error.field).includes(fieldPart), `field 应含 ${fieldPart}，实为 ${error.field}`)
    return true
  })
}
check('validate: 端口 0 被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), listen: { host: '127.0.0.1', port: 0 } }), 'listen.port')
})
check('validate: 非 http 上游被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), upstream: { baseUrl: 'ftp://x', timeoutMs: 45000 } }), 'upstream.baseUrl')
})
check('validate: 未知 effort 被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), effort: 'turbo' }), 'effort')
})
check('validate: 未知 egress 模式被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), egress: { mode: 'vpn' } }), 'egress.mode')
})
check('validate: 未知顶层键被拒（打字错误拒绝启动）', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), levevl: {} }), 'levevl')
})
check('validate: probe 并发越界被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), probe: { enabled: true, intervalMinutes: 60, concurrency: 99 } }), 'probe.concurrency')
})

// —— 三层优先级: flag > env > file > default ——
check('loadConfig: 文件层覆盖默认', () => {
  const cfg = loadConfig({
    argv: [], env: {},
    fileText: `{ "effort": "deep", "data": "./d1" }`,
  })
  assert.equal(cfg.effort, 'deep')
})
check('loadConfig: env 覆盖文件', () => {
  const cfg = loadConfig({
    argv: [], env: { OFM_EFFORT: 'light', OFM_LISTEN: '127.0.0.1:19001' },
    fileText: `{ "effort": "deep" }`,
  })
  assert.equal(cfg.effort, 'light')
  assert.equal(cfg.listen.port, 19001)
})
check('loadConfig: flag 覆盖 env', () => {
  const cfg = loadConfig({
    argv: ['--effort', 'deep', '--listen', '127.0.0.1:19002'],
    env: { OFM_EFFORT: 'light' },
    fileText: `{ "effort": "balanced" }`,
  })
  assert.equal(cfg.effort, 'deep')
  assert.equal(cfg.listen.port, 19002)
})
check('loadConfig: 文件缺失 → 纯默认，不报错', () => {
  const cfg = loadConfig({ argv: [], env: {}, fileMissing: true })
  assert.equal(cfg.effort, DEFAULTS.effort)
  assert.equal(cfg.configPath, null)
})
check('loadConfig: 文件存在但 JSON 非法 → ConfigError 拒绝启动', () => {
  assert.throws(() => loadConfig({ argv: [], env: {}, fileText: `{ nope` }), ConfigError)
})
check('loadConfig: --no-lan 关闭、--lan 开启并解析 host:port', () => {
  const off = loadConfig({ argv: ['--no-lan'], env: {} })
  assert.equal(off.lan.enabled, false)
  const on = loadConfig({ argv: ['--lan', '0.0.0.0:19003'], env: {} })
  assert.equal(on.lan.enabled, true)
  assert.equal(on.lan.port, 19003)
})
check('loadConfig: data 解析为绝对路径', () => {
  const cfg = loadConfig({ argv: [], env: {}, fileText: `{ "data": "./data-x" }` })
  assert.ok(/^(?:[A-Za-z]:\/|\/)/.test(cfg.data), `data 应为绝对路径，实为 ${cfg.data}`)
  assert.ok(!cfg.data.includes('\\'), '统一使用正斜杠')
})
check('loadConfig: 返回对象被冻结（运行时不可被上层改写）', () => {
  const cfg = loadConfig({ argv: [], env: {} })
  assert.ok(Object.isFrozen(cfg))
})

console.log(`config.test: ${passed} passed${process.exitCode ? '（有失败）' : ''}`)
