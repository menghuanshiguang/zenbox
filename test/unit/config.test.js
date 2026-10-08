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
  assert.equal(DEFAULTS.lan.key, '')
  assert.equal('separateKey' in DEFAULTS.lan, false, '§8.1 用 lan.key 独立 Key，separateKey 已废')
  assert.equal(DEFAULTS.upstream.base, 'https://opencode.ai')
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
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), upstream: { base: 'ftp://x', timeoutMs: 45000 } }), 'upstream.base')
})
check('validate: 未知 effort 被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), effort: 'turbo' }), 'effort')
})
check('validate: 未知 egress 模式被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), egress: { mode: 'vpn' } }), 'egress.mode')
})
check('validate: 三态 direct/proxy/subscription 都放行（出口由 config 切换）', () => {
  for (const mode of ['direct', 'proxy', 'subscription']) {
    validateConfig({ ...structuredClone(DEFAULTS), egress: { ...structuredClone(DEFAULTS.egress), mode } })
  }
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

// —— §8.1 样张补全键（M2: listen.fallback/key、lan.key、catalog.allow/deny、
//    probe.timeoutMs、egress.subscription/proxy、log.*）——
check('DEFAULTS: §8.1 样张缺键补齐', () => {
  assert.equal(DEFAULTS.listen.fallback, true)
  assert.equal(DEFAULTS.listen.key, '')
  assert.equal(DEFAULTS.lan.key, '')
  assert.deepEqual(DEFAULTS.catalog.allow, [])
  assert.deepEqual(DEFAULTS.catalog.deny, [])
  assert.equal(DEFAULTS.probe.timeoutMs, 45000)
  assert.deepEqual(DEFAULTS.egress.subscription, { url: '', token: '' })
  assert.deepEqual(DEFAULTS.egress.proxy, { url: '', password: '' })
  assert.deepEqual(DEFAULTS.log, { level: 'info', timestamps: false, color: true, file: '' })
})
check('validate: listen.fallback 非布尔被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), listen: { host: '127.0.0.1', port: 18899, fallback: 'yes' } }), 'listen.fallback')
})
check('validate: listen.key 非字符串被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), listen: { host: '127.0.0.1', port: 18899, key: 123 } }), 'listen.key')
})
check('validate: lan.key 非字符串被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), lan: { enabled: false, host: '0.0.0.0', port: 18899, key: true } }), 'lan.key')
})
check('validate: 未知 log.level 被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), log: { level: 'loud' } }), 'log.level')
})
check('validate: catalog.allow 非数组被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), catalog: { refreshMinutes: 30, allow: 'x' } }), 'catalog.allow')
})
check('validate: probe.timeoutMs 越界被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), probe: { enabled: true, intervalMinutes: 60, concurrency: 2, timeoutMs: 500 } }), 'probe.timeoutMs')
})
check('validate: 未知段内键被拒（upstream.baseUrl 打字残留报错）', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), upstream: { baseUrl: 'https://x' } }), 'upstream.baseUrl')
})
check('loadConfig: OFM_UPSTREAM 落到 base', () => {
  const cfg = loadConfig({ argv: [], env: { OFM_UPSTREAM: 'https://env.example' } })
  assert.equal(cfg.upstream.base, 'https://env.example')
})
check('loadConfig: --port 与 --verbose 落位', () => {
  const cfg = loadConfig({ argv: ['--port', '19007', '--verbose'], env: {} })
  assert.equal(cfg.listen.port, 19007)
  assert.equal(cfg.log.level, 'debug')
})
check('DEFAULTS: upstream.key 与 egress 订阅凭据字段在位', () => {
  assert.equal(DEFAULTS.upstream.key, '', '上游 API key 默认空 = opencode 免密')
  assert.equal(DEFAULTS.egress.subscription.url, '')
  assert.equal(DEFAULTS.egress.subscription.token, '')
})
check('validate: upstream.key 非字符串被拒', () => {
  expectConfigError(() => validateConfig({ ...structuredClone(DEFAULTS), upstream: { base: 'https://x', timeoutMs: 45000, key: 123 } }), 'upstream.key')
})
check('loadConfig: 文件里的 upstream.key 保留、OFM_UPSTREAM_KEY 覆盖', () => {
  const fromEnv = loadConfig({ argv: [], env: { OFM_UPSTREAM_KEY: 'sk-env' } })
  assert.equal(fromEnv.upstream.key, 'sk-env')
  const fromFile = loadConfig({ argv: [], env: {} })
  assert.equal(typeof fromFile.upstream.key, 'string') // 文件层与默认层都留键
})

console.log(`config.test: ${passed} passed${process.exitCode ? '（有失败）' : ''}`)
