#!/usr/bin/env node
/**
 * 门禁运行器（npm test → 本脚本）。按 AGENT-BRIEF §7 分层：
 *
 *   L0 静态: ① rg 禁词 ② node --check ③ tsc --noEmit ④ bash -n+shellcheck（有 *.sh 才跑）
 *            ⑤ config schema ⑥ 文档对账（test/meta/gates.test.js）⑦ coverage-map 无孤儿
 *   L1 单元: test/unit/*.test.js
 *   L2 集成: test/integration/*.test.js（桩网关，禁真实出网）
 *   L3 live: 仅 --allow-live 时运行 test/live/*.test.js，默认 SKIP 并注明 reason
 *
 * 本文件位于 scripts/（不在禁词扫描范围），承载禁词模式本体。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowLive = process.argv.includes('--allow-live')
const results = []

function record(layer, name, ok, detail = '') {
  results.push({ layer, name, ok, detail })
  const mark = ok ? 'OK   ' : 'FAIL '
  process.stdout.write(`${mark}[${layer}] ${name}${detail ? ` — ${detail}` : ''}\n`)
}
function skip(layer, name, reason) {
  results.push({ layer, name, ok: true, detail: `SKIP: ${reason}` })
  process.stdout.write(`SKIP [${layer}] ${name} — ${reason}\n`)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options })
}

function walk(dir, suffix, out = []) {
  const full = path.join(ROOT, dir)
  if (!fs.existsSync(full)) return out
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(rel, suffix, out)
    } else if (suffix.some(ext => entry.name.endsWith(ext))) out.push(rel)
  }
  return out
}

// ── L0 ① 禁词扫描 ────────────────────────────────────────────────────────────
function gateRg() {
  // 模式与 AGENT-BRIEF §0-4 红线一致；命中范围 src/ start.js test/。
  const pattern = String.raw`@deepseek-ai|eac-|eac\.js|kilo|channel-pack`
  const result = run('rg', ['-n', '-e', pattern, 'src/', 'start.js', 'test/'])
  if (result.error) {
    record('L0', 'rg 禁词扫描', false, `rg 不可执行: ${result.error.message}`)
    return
  }
  if (result.status === 1) { record('L0', 'rg 禁词扫描', true, '零命中'); return }
  if (result.status === 0) {
    record('L0', 'rg 禁词扫描', false, `命中 ${result.stdout.split('\n').filter(Boolean).length} 行:\n${result.stdout}`)
    return
  }
  record('L0', 'rg 禁词扫描', false, `rg 退出码 ${result.status}: ${result.stderr}`)
}

// ── L0 ② 语法检查 ────────────────────────────────────────────────────────────
function gateSyntax() {
  const files = walk('', ['.js', '.mjs']).filter(file => !file.startsWith('.pr-diffs/'))
  const failures = []
  for (const file of files) {
    const result = run(process.execPath, ['--check', file])
    if (result.status !== 0) failures.push(`${file}: ${result.stderr.split('\n').slice(-8).join(' ')}`)
  }
  record('L0', `node --check (${files.length} files)`, failures.length === 0, failures.join('; '))
}

// ── L0 ③ 类型检查（棘轮: test/meta/tsc-baseline.json 按文件上限，新文件必须 0） ──
function gateTsc() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!fs.existsSync(tsc)) {
    record('L0', 'tsc --noEmit', false, 'typescript 未安装（npm i -D typescript）')
    return
  }
  const baselinePath = path.join(ROOT, 'test', 'meta', 'tsc-baseline.json')
  if (!fs.existsSync(baselinePath)) {
    record('L0', 'tsc --noEmit', false, '缺 test/meta/tsc-baseline.json（棘轮基线）')
    return
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8').replace(/^﻿/, ''))
  const result = run(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'])
  const counts = {}
  let total = 0
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = /^([^(\s]+)\(\d+\)/.exec(line)
    if (!match) continue
    const file = match[1].split(path.sep).join('/')
    counts[file] = (counts[file] ?? 0) + 1
    total++
  }
  if (result.status === 0) { record('L0', 'tsc --noEmit', true, '0 errors（可收紧基线至 0）'); return }

  const violations = []
  let tightened = []
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline.files?.[file]
    if (allowed === undefined) violations.push(`${file}: ${count} errors（新文件必须 0）`)
    else if (count > allowed) violations.push(`${file}: ${count} > 基线 ${allowed}`)
    else if (count < allowed) tightened.push(`${file} ${allowed}→${count}`)
  }
  if (violations.length > 0) {
    record('L0', `tsc --noEmit (total ${total}/${baseline.total})`, false, violations.join('; ').slice(0, 2500))
  } else {
    const hint = tightened.length > 0 ? `（可收紧: ${tightened.join(', ')}）` : ''
    record('L0', `tsc --noEmit (total ${total}/${baseline.total} 棘轮)`, true, hint)
  }
}

// ── L0 ④ shell 脚本检查（bash 语法必查；shellcheck 有则查，缺位只注明） ──────
function gateShell() {
  const scripts = walk('', ['.sh'])
  if (scripts.length === 0) { skip('L0', 'bash -n + shellcheck', '仓库暂无 *.sh'); return }
  const probe = run('bash', ['--version'])
  if (probe.error) { skip('L0', 'bash -n + shellcheck', '本机无 bash（语法与 shellcheck 由 CI 的 ubuntu/macos/windows 执行）'); return }
  let ok = true
  const details = []
  for (const file of scripts) {
    const syntax = run('bash', ['-n', file])
    if (syntax.status !== 0) { ok = false; details.push(`${file}: ${syntax.stderr ?? syntax.stdout ?? 'bash -n 失败'}`) }
    const lint = run('shellcheck', [file])
    if (lint.error) details.push('shellcheck 未装（不阻塞；CI ubuntu 覆盖）')
    else if (lint.status !== 0) { ok = false; details.push(`${file}: ${lint.stdout}`) }
  }
  record('L0', `bash -n + shellcheck (${scripts.length})`, ok, details.join('; '))
}

// ── L0 ⑤ config schema（仓库 config.json 必须能通过逐字段校验） ─────────────
async function gateConfig() {
  try {
    const { loadConfig } = await import(`file://${path.join(ROOT, 'src', 'config.js').replace(/\\/g, '/')}`)
    loadConfig({ argv: [], env: {}, configPath: path.join(ROOT, 'config.json') })
    record('L0', 'config.json schema', true, '')
  } catch (error) {
    record('L0', 'config.json schema', false, `${error.field ? `[${error.field}] ` : ''}${error.message}`)
  }
}

// ── 通用: 跑一个测试文件 ─────────────────────────────────────────────────────
function runTest(layer, file) {
  const result = run(process.execPath, [file])
  const ok = result.status === 0
  record(layer, file, ok, ok ? (result.stdout.trim().split('\n').pop() ?? '') : `${result.stdout}\n${result.stderr}`.slice(-3000))
  return ok
}

// ── L3 live 开关 ─────────────────────────────────────────────────────────────
function gateLive() {
  const files = walk('test/live', ['.test.js'])
  if (!allowLive) { skip('L3', 'live 测试', `默认档禁真实出网；确认后用 npm run test:live（现有 ${files.length} 个 live 文件）`); return }
  for (const file of files) runTest('L3', file)
}

async function main() {
  gateRg()
  gateSyntax()
  gateTsc()
  gateShell()
  await gateConfig()

  // L0 ⑥⑦ 由 meta 测试承担（文档对账 / coverage-map 无孤儿 / pr-coverage 引用）
  const metaFiles = walk('test/meta', ['.test.js'])
  for (const file of metaFiles) runTest('L0', file)

  // L1 单元
  const unitFiles = walk('test/unit', ['.test.js'])
  if (unitFiles.length === 0) record('L1', 'unit', false, 'test/unit 为空')
  for (const file of unitFiles) runTest('L1', file)

  // L2 集成
  const integrationFiles = walk('test/integration', ['.test.js'])
  if (integrationFiles.length === 0) skip('L2', 'integration', '尚无 test/integration（M1 核心链路起补）')
  for (const file of integrationFiles) runTest('L2', file)

  gateLive()

  const failed = results.filter(item => !item.ok)
  process.stdout.write(`\n== 门禁汇总: ${results.length - failed.length}/${results.length} 通过 ==\n`)
  for (const item of failed) process.stdout.write(`FAIL [${item.layer}] ${item.name}\n`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
