#!/usr/bin/env node
/**
 * zenbox — 一条命令起的 opencode 免费模型中继（AGENT-BRIEF §8）。
 *
 * 启动时序（§3，PR #72 教训不可改）：loadConfig → init store(0600 Key) →
 * bindForwardPort + startLanRelay（监听先行）→ printBanner（异步行补位）→
 * 后台轮（清单/探测/出口 IP，M3/M4 接入）→ 前台日志。网络轮失败只记日志，
 * 永不阻塞监听。
 *
 * M2 起 start 不是空壳：Key 落盘（0600）、本机转发口与 LAN 中继真绑定、
 * 转发链路由 src/turn.js createRunForwarded + FreeModelAdapter + JsonStore
 * 组装——与 scripts/recovery-test.mjs 的 withForward 同一条链。
 */
import process from 'node:process'
import { ConfigError, loadConfig } from './src/config.js'
import { startForwardServer, startLanRelay } from './src/forward.js'
import { FreeModelAdapter } from './src/adapter.js'
import { createRunForwarded, computeMembership, routableModelIds, publicModelRows } from './src/turn.js'
import { JsonStore, STATS_INITIAL, recordUsage, recordTurn, ensureKey, rotateKey, readKey } from './src/store.js'
import { startEgressRelay, refreshOutletExit, readOutletSelection } from './src/egress.js'
import { FALLBACK_CATALOG } from './src/catalog.js'

export const VERSION = '0.1.0'
const COMMANDS = ['start', 'status', 'models', 'probe', 'key', 'doctor']
const NO_JSON = new Set(['start'])
/** 运行时恒定设置：探测轮（M3）落地后 status.models 才会有分桶，这里只定通路。 */
const RUNTIME_SETTINGS = { enabled: true, exposeRegionModels: true, defaultMaxTokens: 32768 }
/** 尚无探测裁决——computeMembership 对无裁决条目全量放行（turn.js 注释语义）。 */
const AVAILABILITY_EMPTY = { results: {} }

/** @param {string} key */
const tail4 = key => (typeof key === 'string' && key !== '' ? key.slice(-4) : '')

/** @param {string} message */
function fail(message) {
  process.stderr.write(`错误: ${message}\n`)
  process.exitCode = 1
}

/**
 * 解析 argv：首参为命令，`--json` 标志单列，其余原样交给 loadConfig 的
 * flag 层（flag > OFM_* env > 文件 > 默认）。
 * @param {string[]} argv
 * @returns {{command: string, positional: string[], flags: string[], json: boolean, argv: string[]}}
 */
export function parseArgv(argv) {
  const positional = []
  const flags = []
  let json = false
  for (const item of argv) {
    if (item === '--json') json = true
    else if (item.startsWith('--')) flags.push(item)
    else positional.push(item)
  }
  return { command: positional[0] ?? 'start', positional, flags, json, argv }
}

/**
 * @param {string[]} argv
 * @returns {ReturnType<typeof loadConfig>}
 */
function loadOrDie(argv) {
  try {
    return loadConfig({ argv })
  } catch (error) {
    if (error instanceof ConfigError) fail(`${error.message}（字段: ${error.field}）`)
    else fail(error instanceof Error ? error.message : String(error))
    process.exit(1)
    throw error // process.exit 不返回；抛出收口让 TS 认可控制流
  }
}

/**
 * §8.4 banner。runtime 为监听绑定后的实况；缺省时状态如实标 pending/未生成，
 * 不编造地址（status 会先探测再传入）。
 *
 * @param {ReturnType<typeof loadConfig>} config
 * @param {(line: string) => void} [out]
 * @param {{port?: number, requestedPort?: number, fellBack?: boolean, keyTail?: string, relayUp?: boolean, lanPort?: number, models?: number}} [runtime]
 */
export function printBanner(config, out = line => process.stdout.write(`${line}\n`), runtime = {}) {
  const port = runtime.port ?? config.listen.port
  const moved = runtime.fellBack === true && typeof runtime.requestedPort === 'number' && runtime.requestedPort !== port
  const lanState = !config.lan.enabled
    ? '关闭（config lan.enabled=true 或 --lan 开启，独立 Key 与本机不通用）'
    : runtime.relayUp === true
      ? `${config.lan.host}:${runtime.lanPort ?? config.lan.port}（中继监听中，LAN 独立 Key）`
      : `${config.lan.host}:${config.lan.port}（未监听——start 运行中才绑定）`
  const keyLine = runtime.keyTail
    ? `尾4 ${runtime.keyTail}（data/forward-key，0600）`
    : '未生成（首次 start 生成 data/forward-key，0600）'
  const modelsLine = typeof runtime.models === 'number'
    ? `${runtime.models} 个（静态回退清单；探测分桶 M3 后台轮补）`
    : '等待首次刷新（M3 后台轮补行）'
  out(`zenbox v${VERSION} · opencode 免费模型中继`)
  out(`配置文件   ${config.configPath ?? '（无，使用默认值）'}`)
  out(`本机转发   ${config.listen.host}:${port}${moved ? `（端口被占，已顺延自 ${runtime.requestedPort}）` : ''}`)
  out(`局域网     ${lanState}`)
  out(`上游       ${config.upstream.base}（超时 ${config.upstream.timeoutMs}ms）`)
  out(`出口       ${config.egress.mode}`)
  out(`Key        ${keyLine}`)
  out(`模型清单   ${modelsLine}`)
  out('公网出口IP 等待后台刷新（M4 行）')
}

/**
 * 探测一个 HTTP 监听口：`/health` 应答即视为在场。0.0.0.0/:: 归一到回环，
 * IPv6 字面量加括号。仅回环请求，不出网。
 *
 * @param {string} host
 * @param {number} port
 * @returns {Promise<'up'|'down'>}
 */
async function probeHealth(host, port) {
  let target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  if (target.includes(':') && !target.startsWith('[')) target = `[${target}]`
  try {
    const res = await fetch(`http://${target}:${port}/health`, { signal: AbortSignal.timeout(800) })
    return res.ok ? 'up' : 'down'
  } catch {
    return 'down'
  }
}

/**
 * status 报告（§8.2）：端口在场、Key 尾4 与来源、上游/出口/effort、模型数。
 * 公网 IP 与探测摘要属 M4/M3 后台轮，这里如实列 pending。
 *
 * @param {ReturnType<typeof loadConfig>} config
 */
async function statusReport(config) {
  const forwardHealth = await probeHealth(config.listen.host, config.listen.port)
  const relayHealth = config.lan.enabled ? await probeHealth(config.lan.host, config.lan.port) : 'disabled'
  const forwardKey = readKey(config.data, 'forward-key', config.listen.key)
  const lanKey = config.lan.enabled ? readKey(config.data, 'lan-key', config.lan.key) : null
  return {
    version: VERSION,
    configPath: config.configPath,
    listen: `${config.listen.host}:${config.listen.port}`,
    lan: config.lan.enabled ? `${config.lan.host}:${config.lan.port}` : 'disabled',
    upstream: config.upstream.base,
    effort: config.effort,
    egress: config.egress.mode,
    data: config.data,
    listeners: { forward: forwardHealth, lan: relayHealth },
    key: { source: forwardKey.source, tail4: tail4(forwardKey.key) },
    lanKey: lanKey ? { source: lanKey.source, tail4: tail4(lanKey.key) } : null,
    models: FALLBACK_CATALOG.length,
    pending: ['公网出口IP（M4 ipinfo）', '最近探测摘要（M3 probe 轮）'],
  }
}

/**
 * @type {Record<string, (config: ReturnType<typeof loadConfig>, opts: {json: boolean, flags: string[], rotate?: boolean}) => any>}
 */
const commands = {
  // —— start：Key 落盘 → 组装运行链 → 监听先行 → banner → 前台日志 ——
  async start(config) {
    /** @type {(line: string) => void} */
    const log = line => process.stdout.write(`${line}\n`)
    // ① init store：Key 0600（§8.1 key 空=首次生成写 data/）
    const forwardKey = ensureKey(config.data, 'forward-key', config.listen.key)
    const lanKey = config.lan.enabled ? ensureKey(config.data, 'lan-key', config.lan.key) : null
    const stats = new JsonStore(`${config.data}/stats.json`, STATS_INITIAL, { log: () => {} })
    // ② 运行链组装（与 recovery-test withForward 同构）：availability 空 = 无裁决全放行，
    //    M3 probe 轮落 data/availability.json 后在此重放。
    // ①′ 出口（#75/#82 宿主半）：非 direct 才起本地出口中继，配额拒绝与隧道
    //    连击都走同一条换出口路（60s 冷却 + 单飞 + 被拒节点 10min 候补）
    let egressRelay = null
    /** @type {Map<string, number>} 被限流过的节点 → 记录时刻（10 分钟候补） */
    const limitedNodes = new Map()
    const OUTLET_ROTATE_COOLDOWN_MS = 60_000
    const OUTLET_LIMITED_TTL_MS = 10 * 60_000
    let lastRotationAt = 0
    /** @type {Promise<void>|null} */
    let rotating = null
    const rotateOutletExit = async reason => {
      const relay = egressRelay
      if (relay === null) return
      if (relay.managed === null || relay.managed === undefined) {
        log(`[egress] ${reason}；client 单代理出口没有节点可换`)
        return
      }
      const now = Date.now()
      for (const [node, at] of limitedNodes) if (now - at > OUTLET_LIMITED_TTL_MS) limitedNodes.delete(node)
      const selection = await readOutletSelection(relay)
      const current = selection?.node ?? null
      const avoid = [...limitedNodes.keys()]
      if (current !== null) avoid.push(current)
      const rotated = await refreshOutletExit(relay, { avoid })
      if (current !== null) limitedNodes.set(current, now)
      if (rotated === null) {
        log(`[egress] ${reason}；候选都轮过了，留在 ${current ?? '当前节点'}`)
        return
      }
      log(`[egress] ${reason} → ${rotated.previous ?? current ?? '?'} 换到 ${rotated.node}（${rotated.delayMs}ms，${rotated.candidates} 个候选${rotated.switched ? '' : '，已在最优未变动'}）`)
    }
    const scheduleOutletRotation = reason => {
      if (egressRelay === null) return
      if (Date.now() - lastRotationAt < OUTLET_ROTATE_COOLDOWN_MS) return
      if (rotating !== null) return
      lastRotationAt = Date.now()
      rotating = rotateOutletExit(reason)
        .catch(error => log(`[egress] 换出口失败: ${error?.message ?? error}`))
        .finally(() => { rotating = null })
    }
    if (config.egress.mode !== 'direct') {
      // 出口配了却起不来就退出，不悄悄改走直连：把用户的流量从他们配置要
      // 绕开的地址旁路出去，比启动失败更糟。config 层的 proxy（#45）形状
      // {url, password} 映射到拨号器的 client 语义——直拨已给代理，不起 mihomo。
      egressRelay = await startEgressRelay({
        config: () => ({ mode: 'client', url: config.egress.proxy.url }),
        dataDir: config.data,
        log: line => log(`[egress] ${line}`),
        onFault: error => scheduleOutletRotation(`出口连击失败（${error?.message ?? error}）`),
        onLane: lane => log(`[egress] 通道 ${lane.transition === 'bench' ? `切直连 ${Math.round((lane.benchUntil - Date.now()) / 1000)}s` : '回中继'}（direct=${lane.direct}, strikes=${lane.strikes}）`),
      })
    }
    const availability = AVAILABILITY_EMPTY
    const state = () => ({
      catalog: FALLBACK_CATALOG,
      membership: /** @type {Record<string, string[]>} */ (computeMembership(FALLBACK_CATALOG, availability, RUNTIME_SETTINGS)),
      settings: RUNTIME_SETTINGS,
      attributionUserAgent: 'zenbox',
    })
    const adapter = new FreeModelAdapter({
      state,
      recordUsage: row => recordUsage(stats, row),
      recordTurn: row => recordTurn(stats, row),
      warn: message => log(`[warn] ${message}`),
      // 配额拒绝是出口事实，健康检查看不见（gstatic 对刚被限流的节点照样 204）
      onQuotaHit: () => scheduleOutletRotation('配额拒绝（Rate limit exceeded）'),
    })
    const complete = createRunForwarded({
      getCatalog: () => FALLBACK_CATALOG,
      getState: state,
      getSettings: () => RUNTIME_SETTINGS,
      adapter,
    })
    // ③ 监听先行：本机转发口（Key 每请求经 readKey 重读，rotate 后旧 Key 即刻 401）
    const forward = await startForwardServer({
      config: () => ({
        enabled: true,
        host: config.listen.host,
        port: config.listen.port,
        key: readKey(config.data, 'forward-key', config.listen.key).key,
        fallback: config.listen.fallback,
      }),
      complete,
      modelRows: () => publicModelRows(FALLBACK_CATALOG, routableModelIds(state, RUNTIME_SETTINGS)),
      log: line => log(`[forward] ${line}`),
    })
    // ④ LAN 中继（默认关；独立 Key，targetPort 指向本机转发口）
    let relay = null
    if (config.lan.enabled) {
      relay = await startLanRelay({
        config: () => ({
          enabled: true,
          host: config.lan.host,
          port: config.lan.port,
          lanKey: readKey(config.data, 'lan-key', config.lan.key).key,
          localKey: readKey(config.data, 'forward-key', config.listen.key).key,
          targetPort: forward.port,
        }),
        log: line => log(`[relay] ${line}`),
      })
    }
    // ⑤ banner：绑定后实况（顺延/Key 尾4/中继在场/静态清单数）
    printBanner(config, undefined, {
      port: forward.port,
      requestedPort: forward.requestedPort,
      fellBack: forward.fellBack,
      keyTail: tail4(forwardKey.key),
      relayUp: relay !== null,
      lanPort: relay?.port,
      models: FALLBACK_CATALOG.length,
    })
    log(`[listen] 转发口 ${config.listen.host}:${forward.port}${forward.fellBack && forward.requestedPort !== forward.port ? `（顺延自 ${forward.requestedPort}）` : ''} · Key 尾4 ${tail4(forwardKey.key)}`)
    if (relay !== null) log(`[listen] 中继口 ${relay.host}:${relay.port} · LAN 独立 Key 尾4 ${tail4(lanKey?.key ?? '')}`)
    // ⑥ 优雅关闭：SIGINT/SIGTERM/冒烟钩子共用一条路
    let closing = false
    const heartbeat = setInterval(() => log(`[heartbeat] ${new Date().toISOString()} 在线`), 60_000)
    /** @type {(signal: string) => Promise<void>} */
    const shutdown = async signal => {
      if (closing) return
      closing = true
      clearInterval(heartbeat)
      log(`[stop] 收到 ${signal}，优雅关闭（中继/转发口回收 + 统计落盘）`)
      try { if (relay !== null) await relay.close() } catch { /* 关闭尽力 */ }
      try { await forward.close() } catch { /* 关闭尽力 */ }
      try { if (egressRelay !== null) await egressRelay.close() } catch { /* 关闭尽力 */ }
      stats.dispose()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    const smokeMs = Number(process.env.OFM_SMOKE_MS)
    if (Number.isFinite(smokeMs) && smokeMs > 0) setTimeout(() => void shutdown('SMOKE'), smokeMs)
    // ⑦ 前台日志：请求行由 [forward]/[relay] 前缀流出；后台轮（清单/探测/出口IP）M3/M4 接入
    return undefined
  },

  // —— status：监听在场探测 + Key 尾4（§8.2）——
  async status(config, { json }) {
    const report = await statusReport(config)
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }
    printBanner(config, undefined, {
      keyTail: report.key.tail4,
      models: report.models,
      relayUp: report.listeners.lan === 'up',
      lanPort: config.lan.port,
    })
    process.stdout.write(`[status] forward=${report.listeners.forward} lan=${report.listeners.lan} key=${report.key.source}/尾4 ${report.key.tail4 || '无'}（中继 ${report.key.source === 'config' && !config.lan.enabled ? '关' : report.listeners.lan}）\n`)
    if (report.pending.length > 0) process.stdout.write(`[pending] ${report.pending.join('；')}\n`)
  },

  // —— models：静态回退清单 + routable 门（§8.2；探测分桶 M3 接入）——
  models(config, { json }) {
    const membership = computeMembership(FALLBACK_CATALOG, AVAILABILITY_EMPTY, RUNTIME_SETTINGS)
    const rows = /** @type {{id: string, context_window?: number}[]} */ (publicModelRows(FALLBACK_CATALOG, routableModelIds(() => ({ membership }), RUNTIME_SETTINGS)))
    const report = {
      available: rows.length,
      models: rows.map(row => ({ id: row.id, context_window: row.context_window ?? null })),
      verdicts: 'unknown（M3 probe 轮接入后分 available/region-limited/removed 带拒因）',
    }
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }
    process.stdout.write(`[models] ${report.available} 个模型（静态回退清单；${report.verdicts}）\n`)
    for (const row of report.models) process.stdout.write(`  - ${row.id}${row.context_window ? `（ctx ${row.context_window}）` : ''}\n`)
  },

  // —— probe：M3 后台轮接入；配置节奏如实展示——
  probe(config, { json }) {
    const report = {
      enabled: config.probe.enabled,
      intervalMinutes: config.probe.intervalMinutes,
      concurrency: config.probe.concurrency,
      timeoutMs: config.probe.timeoutMs,
      lastRound: null,
      pending: 'M3 probe 轮接入（data/availability.json 落盘）',
    }
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(`[probe] enabled=${report.enabled} 每 ${report.intervalMinutes}min 并发 ${report.concurrency} 超时 ${report.timeoutMs}ms —— ${report.pending}\n`)
  },

  // —— key：查看尾4 / rotate 轮换（旧 Key 即刻 401，§8.2）——
  key(config, { json, flags = [], rotate = false }) {
    const targetLan = flags.includes('--lan')
    const name = targetLan ? 'lan-key' : 'forward-key'
    const explicit = targetLan ? config.lan.key : config.listen.key
    if (rotate) {
      if (explicit !== '') {
        const report = { rotated: false, target: name, reason: `${targetLan ? 'lan' : 'listen'}.key 在 config 显式指定，文件轮换不生效——请清空该键后重试` }
        if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        else process.stderr.write(`[key] ${report.reason}\n`)
        process.exitCode = 1
        return
      }
      const next = rotateKey(config.data, name)
      const report = { rotated: true, target: name, tail4: tail4(next.key), path: `${config.data}/${name}` }
      if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      else process.stdout.write(`[key] 已轮换 ${name} → 尾4 ${report.tail4}（旧 Key 即刻 401）\n`)
      return
    }
    const snapshot = readKey(config.data, name, explicit)
    const report = {
      target: name,
      source: snapshot.source,
      tail4: tail4(snapshot.key),
      exists: snapshot.key !== '',
      path: snapshot.source === 'file' ? `${config.data}/${name}` : null,
    }
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(snapshot.key !== ''
      ? `[key] ${name} 尾4 ${report.tail4}（${snapshot.source}）\n`
      : `[key] ${name} 未生成（首次 start 生成 data/${name}，0600）\n`)
  },

  // —— doctor：node/配置/监听在场/Key/upstream（upstream 自检 M4 接入，如实 PENDING）——
  async doctor(config, { json }) {
    const [major, minor] = process.versions.node.split('.').map(Number)
    const forwardHealth = await probeHealth(config.listen.host, config.listen.port)
    const relayHealth = config.lan.enabled ? await probeHealth(config.lan.host, config.lan.port) : 'disabled'
    const keySnap = readKey(config.data, 'forward-key', config.listen.key)
    const checks = [
      { name: 'node', ok: major > 22 || (major === 22 && minor >= 19), detail: process.version },
      { name: 'config-valid', ok: true, detail: config.configPath ?? '（默认值）' },
      { name: 'listeners', ok: forwardHealth === 'up', detail: `forward=${forwardHealth} lan=${relayHealth}${forwardHealth === 'up' ? '' : '（start 未运行？）'}` },
      { name: 'key', ok: keySnap.key !== '', detail: `${keySnap.source}/尾4 ${tail4(keySnap.key) || '无'}` },
      { name: 'upstream-reachable', ok: false, detail: 'PENDING（M4 健康自检接入；本轮不真出网）' },
    ]
    const report = { version: VERSION, ok: checks.every(check => check.ok), checks }
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else for (const check of checks) process.stdout.write(`${check.ok ? '[OK] ' : '[PENDING] '}${check.name}: ${check.detail}\n`)
    if (!report.ok) process.exitCode = 1
  },
}

/** @param {string[]} argv */
function main(argv) {
  const { command, positional, flags, json, argv: rest } = parseArgv(argv)
  if (!COMMANDS.includes(command)) {
    fail(`未知命令 "${command}"。可用: ${COMMANDS.join(' / ')}（--json 输出机器可读报告）`)
    return
  }
  if (json && NO_JSON.has(command)) {
    fail(`--json 不适用于 start（启动日志是流式文本）`)
    return
  }
  const config = loadOrDie(rest)
  Promise.resolve(commands[command](config, { json, flags, rotate: positional[1] === 'rotate' })).catch(error => {
    fail(`执行失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

// 仅直接执行时启动；被 import（测试、脚本取导出）不拉起 main。
import { fileURLToPath } from 'node:url'
const invoked = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1].replace(/\\/g, '/')}`)) : ''
if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
