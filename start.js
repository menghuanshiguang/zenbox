#!/usr/bin/env node
/**
 * zenbox CLI 入口（AGENT-BRIEF §8.5）。
 *
 * 命令: start | status | models | probe | key | doctor，通用 --json。
 * M0 现状: start 打印 banner 并空转（监听/后台轮按 §6 分别在 M1/M2/M4 接入），
 * 其余命令如实标注可用性；任何配置错误以退出码 1 拒绝启动。
 *
 * @module start.js
 */
import process from 'node:process'
import { ConfigError, loadConfig } from './src/config.js'

export const VERSION = '0.1.0'
const COMMANDS = ['start', 'status', 'models', 'probe', 'key', 'doctor']
const NO_JSON = new Set(['start'])

/** @param {string[]} argv @returns {{command: string, flags: string[], json: boolean, argv: string[]}} */
function parseArgv(argv) {
  const positional = []
  const flags = []
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg.startsWith('--')) flags.push(arg)
    else positional.push(arg)
  }
  const command = positional[0] ?? 'start'
  return { command, flags, json, argv }
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

/** @param {string[]} argv @returns {import('./src/config.js').ZenConfig} */
function loadOrDie(argv) {
  try {
    return loadConfig({ argv, env: process.env })
  } catch (error) {
    if (error instanceof ConfigError) fail(`配置错误 [${error.field}]: ${error.message}`)
    else fail(`配置加载失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
    throw error
  }
}

/** §8.4 banner。M0 只打印已存在的事实，未接线的字段如实标 pending。
 * @param {import('./src/config.js').ZenConfig} config
 * @param {(line: string) => void} [out]
 */
export function printBanner(config, out = line => process.stdout.write(`${line}\n`)) {
  const lanState = config.lan.enabled
    ? `${config.lan.host}:${config.lan.port}（M2 接入）`
    : '关闭（--lan host:port 开启）'
  out(`zenbox v${VERSION} · opencode 免费模型中继`)
  out(`配置文件   ${config.configPath ?? '（无，使用默认值）'}`)
  out(`本机转发   ${config.listen.host}:${config.listen.port}（M1 bind）`)
  out(`局域网     ${lanState}`)
  out(`上游       ${config.upstream.baseUrl}（超时 ${config.upstream.timeoutMs}ms）`)
  out(`出口       ${config.egress.mode}`)
  out(`Key        未生成（M1: data/ 0600 落盘后显示尾4）`)
  out(`模型清单   等待首次刷新（M1 后台轮补行）`)
  out(`公网出口IP 等待后台刷新（M4 补行）`)
}

/** @param {import('./src/config.js').ZenConfig} config */
function statusReport(config) {
  return {
    version: VERSION,
    configPath: config.configPath,
    listen: `${config.listen.host}:${config.listen.port}`,
    lan: config.lan.enabled ? `${config.lan.host}:${config.lan.port}` : 'disabled',
    upstream: config.upstream.baseUrl,
    effort: config.effort,
    egress: config.egress.mode,
    data: config.data,
    listeners: 'pending (M1/M2)',
    key: 'pending (M1)',
  }
}

/** @param {import('./src/config.js').ZenConfig} config */
function doctorReport(config) {
  const checks = []
  const nodeOk = process.versions.node >= '22.19.0'
  checks.push({ name: 'node>=22.19', ok: nodeOk, detail: process.versions.node })
  checks.push({ name: 'config-valid', ok: true, detail: config.configPath ?? 'defaults' })
  checks.push({ name: 'listeners', ok: false, detail: 'pending (M1/M2 接入 bind 后转绿）' })
  checks.push({ name: 'upstream-reachable', ok: false, detail: 'pending (M4 doctor 实测)' })
  return { version: VERSION, ok: checks.every(check => check.ok), checks }
}

/** @type {Record<string, (config: import('./src/config.js').ZenConfig, opts: {json: boolean}) => void>} */
const commands = {
  start(config) {
    printBanner(config)
    process.stdout.write('[start] M0 脚手架：监听与后台轮按 §6 在 M1/M2/M4 接入；进程保持前台日志。\n')
    const heartbeat = setInterval(() => {
      process.stdout.write(`[heartbeat] ${new Date().toISOString()} 前台日志（M1 起替换为请求日志）\n`)
    }, 60_000)
    // 测试钩子: OFM_SMOKE_MS=2000 时到点自动优雅退出（CI 冒烟用，真实启动不设）
    const smokeMs = Number(process.env.OFM_SMOKE_MS)
    if (Number.isFinite(smokeMs) && smokeMs > 0) {
      setTimeout(() => shutdown('SMOKE'), smokeMs)
    }
    /** @param {string} signal */
    const shutdown = signal => {
      clearInterval(heartbeat)
      process.stdout.write(`[stop] 收到 ${signal}，优雅关闭（M0 无监听器需要回收）\n`)
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  },

  status(config, { json }) {
    const report = statusReport(config)
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else {
      printBanner(config)
      process.stdout.write(`[status] listeners=${report.listeners} key=${report.key}\n`)
    }
  },

  models(config, { json }) {
    const report = { available: false, reason: 'M1 接入上游清单后可用', models: [] }
    if (json) process.stdout.write(`${JSON.stringify(report)}\n`)
    else process.stdout.write('[models] 未接入（M1：catalog 后台轮）。配置模型清单: config.catalog.refreshMinutes\n')
  },

  probe(config, { json }) {
    const report = { available: false, reason: 'M3 接入 probe 轮询后可用', config: { enabled: config.probe.enabled, intervalMinutes: config.probe.intervalMinutes, concurrency: config.probe.concurrency } }
    if (json) process.stdout.write(`${JSON.stringify(report)}\n`)
    else process.stdout.write('[probe] 未接入（M3：可用性探测轮）。配置: config.probe.*\n')
  },

  key(config, { json }) {
    const report = { available: false, reason: 'M1 接入 store 后可用（0600 落盘 / rotate）' }
    if (json) process.stdout.write(`${JSON.stringify(report)}\n`)
    else process.stdout.write('[key] 未接入（M1：store 0600 落盘；key rotate 同步）\n')
  },

  doctor(config, { json }) {
    const report = doctorReport(config)
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else for (const check of report.checks) process.stdout.write(`[${check.ok ? 'OK' : 'PENDING'}] ${check.name}: ${check.detail}\n`)
    if (!report.ok) process.exitCode = 1
  },
}

/** @param {string[]} argv */
function main(argv) {
  const { command, flags, json, argv: rest } = parseArgv(argv)
  if (!COMMANDS.includes(command)) {
    fail(`未知命令: ${command}（可选 ${COMMANDS.join('|')}）`)
    return
  }
  if (json && NO_JSON.has(command)) {
    fail(`--json 不适用于 ${command} 命令`)
    return
  }
  const config = loadOrDie(rest)
  commands[command](config, { json })
}

main(process.argv.slice(2))
