/**
 * Configuration loader.
 *
 * 四层优先级：CLI flag > `OFM_*` 环境变量 > `config.json` 文件 > DEFAULTS。
 * 文件允许 `//` 注释（行注释与行内注释；字符串字面量内的 `//` 不动）。
 * 每个字段逐项校验，未知键、越界值一律抛 ConfigError —— start 拒绝带病启动。
 *
 * @module src/config.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LEVEL, LEVELS } from './effort.js'

/** 配置错误：携带出错字段路径，start 捕获后打印并以退出码 1 拒绝启动。 */
export class ConfigError extends Error {
  /** @param {string} message @param {string} field */
  constructor(message, field) {
    super(message)
    this.name = 'ConfigError'
    this.field = field
  }
}

/**
 * 规范化后的配置对象（loadConfig 返回；configPath 仅由 loadConfig 附加）。
 * @typedef {object} ZenConfig
 * @property {{host: string, port: number, fallback: boolean, key: string}} listen
 * @property {{enabled: boolean, host: string, port: number, key: string}} lan
 * @property {{base: string, timeoutMs: number}} upstream
 * @property {{refreshMinutes: number, allow: string[], deny: string[]}} catalog
 * @property {{enabled: boolean, intervalMinutes: number, concurrency: number, timeoutMs: number}} probe
 * @property {string} effort
 * @property {{mode: string, subscription: {url: string, token: string}, proxy: {url: string, password: string}}} egress
 * @property {{refreshMinutes: number, providers: string[]}} ip
 * @property {{level: string, timestamps: boolean, color: boolean, file: string}} log
 * @property {string} data
 * @property {string|null} [configPath]
 */

/** §8 的规格默认值；任何一层缺键都回落到这里。 */
export const DEFAULTS = Object.freeze({
  listen: { host: '127.0.0.1', port: 18899, fallback: true, key: '' },
  lan: { enabled: false, host: '0.0.0.0', port: 18899, key: '' },
  upstream: { base: 'https://opencode.ai', timeoutMs: 45000 },
  catalog: { refreshMinutes: 30, allow: [], deny: [] },
  probe: { enabled: true, intervalMinutes: 60, concurrency: 2, timeoutMs: 45000 },
  effort: DEFAULT_LEVEL,
  egress: { mode: 'direct', subscription: { url: '', token: '' }, proxy: { url: '', password: '' } },
  ip: { refreshMinutes: 30, providers: ['ipify', 'ipinfo', 'ipapi'] },
  log: { level: 'info', timestamps: false, color: true, file: '' },
  data: './data',
})

const KNOWN_KEYS = new Set(['listen', 'lan', 'upstream', 'catalog', 'probe', 'effort', 'egress', 'ip', 'log', 'data'])
/** 对象段的段内已知键；段内未知键同样拒绝——打字残留（如旧名 baseUrl）必须响。 */
const SECTION_KEYS = {
  listen: new Set(['host', 'port', 'fallback', 'key']),
  lan: new Set(['enabled', 'host', 'port', 'key']),
  upstream: new Set(['base', 'timeoutMs']),
  catalog: new Set(['refreshMinutes', 'allow', 'deny']),
  probe: new Set(['enabled', 'intervalMinutes', 'concurrency', 'timeoutMs']),
  egress: new Set(['mode', 'subscription', 'proxy']),
  ip: new Set(['refreshMinutes', 'providers']),
  log: new Set(['level', 'timestamps', 'color', 'file']),
}
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const EFFORT_IDS = new Set(LEVELS.map(level => level.id))
const EGRESS_MODES = new Set(['direct', 'proxy', 'subscription'])
const IP_PROVIDERS = new Set(['ipify', 'ipinfo', 'ipapi'])

/**
 * 剥离 `//` 注释：逐字符扫描，跳过字符串字面量（含转义），保证
 * `"https://…"` 这类值原样保留。
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += char
  }
  return out
}

/** 解析配置文件文本（允许 // 注释）；JSON 非法 → ConfigError。
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseConfigFile(text) {
  try {
    const parsed = JSON.parse(stripComments(text))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError('配置文件顶层必须是 JSON 对象', 'config')
    }
    return parsed
  } catch (error) {
    if (error instanceof ConfigError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConfigError(`配置文件 JSON 解析失败: ${message}`, 'config')
  }
}

/** 深合并（仅已知嵌套结构；override 的 undefined 不覆盖）。
 * @param {any} base
 * @param {any} override
 * @returns {any}
 */
function deepMerge(base, override) {
  if (override === undefined || override === null) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] = (value !== null && typeof value === 'object' && !Array.isArray(value)
      && current !== null && typeof current === 'object' && !Array.isArray(current))
      ? deepMerge(current, value)
      : value
  }
  return out
}

/** @param {any} value @param {string} field @param {number} min @param {number} max */
function expectInt(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${field} 必须是 ${min}..${max} 的整数，实为 ${JSON.stringify(value)}`, field)
  }
}
/** @param {any} value @param {string} field @param {{nonEmpty?: boolean}} [options] */
function expectString(value, field, { nonEmpty = true } = {}) {
  if (typeof value !== 'string' || (nonEmpty && value.trim() === '')) {
    throw new ConfigError(`${field} 必须是非空字符串，实为 ${JSON.stringify(value)}`, field)
  }
}
/** @param {any} value @param {string} field */
function expectBool(value, field) {
  if (typeof value !== 'boolean') throw new ConfigError(`${field} 必须是布尔值，实为 ${JSON.stringify(value)}`, field)
}

/** `host:port` → `{host, port}`；IPv6 用 `[::1]:port` 形式。
 * @param {string} text
 * @param {string} field
 * @returns {{host: string, port: number}}
 */
export function parseHostPort(text, field) {
  expectString(text, field)
  let host = null
  let portText = null
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0 || text[close + 1] !== ':') throw new ConfigError(`${field} 形如 [host]:port，实为 ${text}`, field)
    host = text.slice(1, close)
    portText = text.slice(close + 2)
  } else {
    const at = text.lastIndexOf(':')
    if (at <= 0 || at === text.length - 1) throw new ConfigError(`${field} 形如 host:port，实为 ${text}`, field)
    host = text.slice(0, at)
    portText = text.slice(at + 1)
  }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${field} 端口必须是 1..65535 的整数，实为 ${portText}`, field)
  }
  return { host, port }
}

/** 逐字段校验 + 规范化；返回深冻结的配置对象。
 * @param {any} raw
 * @returns {ZenConfig}
 */
export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('配置必须是 JSON 对象', 'root')
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new ConfigError(`未知配置键: ${key}`, key)
  }
  for (const [section, known] of Object.entries(SECTION_KEYS)) {
    const value = raw[section]
    if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!known.has(key)) throw new ConfigError(`未知配置键: ${section}.${key}`, `${section}.${key}`)
      }
    }
  }
  const cfg = deepMerge(structuredClone(DEFAULTS), raw)

  expectString(cfg.listen.host, 'listen.host')
  expectInt(cfg.listen.port, 'listen.port', 1, 65535)
  expectBool(cfg.listen.fallback, 'listen.fallback')
  expectString(cfg.listen.key, 'listen.key', { nonEmpty: false })
  expectBool(cfg.lan.enabled, 'lan.enabled')
  expectString(cfg.lan.host, 'lan.host')
  expectInt(cfg.lan.port, 'lan.port', 1, 65535)
  expectString(cfg.lan.key, 'lan.key', { nonEmpty: false })
  expectString(cfg.upstream.base, 'upstream.base')
  /** @type {URL|null} */
  let url = null
  try { url = new URL(cfg.upstream.base) } catch { url = null }
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new ConfigError(`upstream.base 必须是 http(s) URL，实为 ${cfg.upstream.base}`, 'upstream.base')
  }
  expectInt(cfg.upstream.timeoutMs, 'upstream.timeoutMs', 1000, 600000)
  expectInt(cfg.catalog.refreshMinutes, 'catalog.refreshMinutes', 1, 1440)
  for (const list of ['allow', 'deny']) {
    const value = cfg.catalog[list]
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw new ConfigError(`catalog.${list} 必须是字符串数组，实为 ${JSON.stringify(value)}`, `catalog.${list}`)
    }
  }
  expectBool(cfg.probe.enabled, 'probe.enabled')
  expectInt(cfg.probe.intervalMinutes, 'probe.intervalMinutes', 5, 1440)
  expectInt(cfg.probe.concurrency, 'probe.concurrency', 1, 8)
  expectInt(cfg.probe.timeoutMs, 'probe.timeoutMs', 1000, 600000)
  if (!EFFORT_IDS.has(cfg.effort)) throw new ConfigError(`effort 必须是 ${[...EFFORT_IDS].join('|')}，实为 ${cfg.effort}`, 'effort')
  if (!EGRESS_MODES.has(cfg.egress.mode)) throw new ConfigError(`egress.mode 必须是 ${[...EGRESS_MODES].join('|')}，实为 ${cfg.egress.mode}`, 'egress.mode')
  expectString(cfg.egress.subscription.url, 'egress.subscription.url', { nonEmpty: false })
  expectString(cfg.egress.subscription.token, 'egress.subscription.token', { nonEmpty: false })
  expectString(cfg.egress.proxy.url, 'egress.proxy.url', { nonEmpty: false })
  expectString(cfg.egress.proxy.password, 'egress.proxy.password', { nonEmpty: false })
  expectInt(cfg.ip.refreshMinutes, 'ip.refreshMinutes', 1, 1440)
  if (!Array.isArray(cfg.ip.providers) || cfg.ip.providers.length === 0) {
    throw new ConfigError(`ip.providers 必须是非空数组，实为 ${JSON.stringify(cfg.ip.providers)}`, 'ip.providers')
  }
  for (const provider of cfg.ip.providers) {
    if (!IP_PROVIDERS.has(provider)) throw new ConfigError(`ip.providers 仅允许 ipify|ipinfo|ipapi，实为 ${provider}`, 'ip.providers')
  }
  if (!LOG_LEVELS.has(cfg.log.level)) throw new ConfigError(`log.level 必须是 ${[...LOG_LEVELS].join('|')}，实为 ${cfg.log.level}`, 'log.level')
  expectBool(cfg.log.timestamps, 'log.timestamps')
  expectBool(cfg.log.color, 'log.color')
  expectString(cfg.log.file, 'log.file', { nonEmpty: false })
  expectString(cfg.data, 'data')
  return deepFreeze(cfg)
}

/** @param {any} value @returns {any} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

/** OFM_* 环境变量 → 覆盖层。
 * @param {Record<string, string|undefined>} env
 * @returns {any}
 */
function envLayerOf(env) {
  /** @type {any} */
  const layer = {}
  /** @param {string} name @returns {number} */
  const int = (name) => {
    const value = env[name]
    const num = Number(value)
    if (!Number.isInteger(num)) throw new ConfigError(`${name} 必须是整数，实为 ${JSON.stringify(value)}`, name)
    return num
  }
  if (env.OFM_LISTEN) layer.listen = parseHostPort(env.OFM_LISTEN, 'OFM_LISTEN')
  if (env.OFM_LAN !== undefined) {
    const value = env.OFM_LAN
    layer.lan = (value === '0' || value === 'off' || value === 'false')
      ? { enabled: false }
      : { enabled: true, ...parseHostPort(value, 'OFM_LAN') }
  }
  if (env.OFM_UPSTREAM) layer.upstream = { base: env.OFM_UPSTREAM }
  if (env.OFM_TIMEOUT !== undefined) layer.upstream = { ...layer.upstream, timeoutMs: int('OFM_TIMEOUT') }
  if (env.OFM_CATALOG_REFRESH !== undefined) layer.catalog = { refreshMinutes: int('OFM_CATALOG_REFRESH') }
  if (env.OFM_PROBE !== undefined) layer.probe = { enabled: !(value => value === '0' || value === 'off' || value === 'false')(env.OFM_PROBE) }
  if (env.OFM_PROBE_INTERVAL !== undefined) layer.probe = { ...layer.probe, intervalMinutes: int('OFM_PROBE_INTERVAL') }
  if (env.OFM_PROBE_CONCURRENCY !== undefined) layer.probe = { ...layer.probe, concurrency: int('OFM_PROBE_CONCURRENCY') }
  if (env.OFM_EFFORT) layer.effort = env.OFM_EFFORT
  if (env.OFM_EGRESS) layer.egress = { mode: env.OFM_EGRESS }
  if (env.OFM_IP_REFRESH !== undefined) layer.ip = { refreshMinutes: int('OFM_IP_REFRESH') }
  if (env.OFM_IP_PROVIDERS) layer.ip = { ...layer.ip, providers: env.OFM_IP_PROVIDERS.split(',').map(s => s.trim()).filter(s => s !== '') }
  if (env.OFM_DATA) layer.data = env.OFM_DATA
  return layer
}

/** CLI flag → 覆盖层；未识别的 flag 原样留给 CLI 层（start.js）处理。
 * @param {string[]} argv
 * @returns {any}
 */
function flagLayerOf(argv) {
  /** @type {any} */
  const layer = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const take = () => {
      const value = argv[++i]
      if (value === undefined) throw new ConfigError(`${flag} 缺少取值`, flag)
      return value
    }
    switch (flag) {
      case '--listen': layer.listen = parseHostPort(take(), '--listen'); break
      case '--port': layer.listen = { ...layer.listen, port: Number(take()) }; break
      case '--lan': layer.lan = { enabled: true, ...parseHostPort(take(), '--lan') }; break
      case '--no-lan': layer.lan = { enabled: false }; break
      case '--upstream': layer.upstream = { ...layer.upstream, base: take() }; break
      case '--timeout': layer.upstream = { ...layer.upstream, timeoutMs: Number(take()) }; break
      case '--data': layer.data = take(); break
      case '--effort': layer.effort = take(); break
      case '--egress': layer.egress = { mode: take() }; break
      case '--verbose': layer.log = { ...layer.log, level: 'debug' }; break
      case '--probe': layer.probe = { ...layer.probe, enabled: true }; break
      case '--no-probe': layer.probe = { ...layer.probe, enabled: false }; break
      case '--probe-interval': layer.probe = { ...layer.probe, intervalMinutes: Number(take()) }; break
      case '--probe-concurrency': layer.probe = { ...layer.probe, concurrency: Number(take()) }; break
      case '--ip-refresh': layer.ip = { ...layer.ip, refreshMinutes: Number(take()) }; break
      default: break
    }
  }
  return layer
}

/** @param {string} value @param {string} cwd @returns {string} */
function normalizeData(value, cwd) {
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value)
  return absolute.split(path.sep).join('/')
}

/**
 * 装载配置：flag > env > 文件 > 默认。
 *
 * @param {object} [options]
 * @param {string[]} [options.argv] - 已去掉 node 与脚本路径的 argv
 * @param {Record<string, string|undefined>} [options.env] - 环境变量表
 * @param {string|null} [options.configPath] - 显式文件路径（覆盖 --config/OFM_CONFIG/默认）
 * @param {string} [options.fileText] - 直接注入文件文本（测试用）
 * @param {boolean} [options.fileMissing] - 声明文件不存在（测试用）
 * @param {string} [options.cwd] - data 相对路径的解析基准
 * @returns {ZenConfig} 深冻结的配置对象（含 configPath 字段）
 */
export function loadConfig({ argv = [], env = {}, configPath = null, fileText, fileMissing = false, cwd = process.cwd() } = {}) {
  const configFlagIndex = argv.indexOf('--config')
  const configFlag = configFlagIndex >= 0 ? argv[configFlagIndex + 1] : undefined
  const target = configPath ?? configFlag ?? env.OFM_CONFIG ?? path.join(cwd, 'config.json')

  let text = fileText
  /** @type {string|null} */
  let resolvedPath = target
  if (!fileMissing && text === undefined) {
    try {
      text = fs.readFileSync(target, 'utf8')
    } catch (error) {
      const err = /** @type {any} */ (error)
      if (err.code !== 'ENOENT') throw new ConfigError(`读取配置文件失败: ${err.message}`, 'config')
      resolvedPath = null
    }
  }
  if (fileMissing) { resolvedPath = null; text = undefined }

  const fileLayer = text === undefined ? {} : parseConfigFile(text)
  const merged = deepMerge(deepMerge(deepMerge(structuredClone(DEFAULTS), fileLayer), envLayerOf(env)), flagLayerOf(argv))
  const cfg = structuredClone(validateConfig(merged))
  cfg.data = normalizeData(cfg.data, cwd)
  cfg.configPath = resolvedPath
  return deepFreeze(cfg)
}
