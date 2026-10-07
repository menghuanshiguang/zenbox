#!/usr/bin/env node
/**
 * INDEX.md ② 依赖速览生成器（AGENT-BRIEF §10：脚本生成、禁手改）。
 *
 *   node scripts/gen-deps.mjs          # 打印区块
 *   node scripts/gen-deps.mjs --write  # 写入 INDEX.md 的 deps 标记区间
 *   node scripts/gen-deps.mjs --check  # 校验区间与当前 import 一致（gates 调用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BEGIN = '<!-- deps:begin 由 scripts/gen-deps.mjs 生成，禁止手改 -->'
const END = '<!-- deps:end -->'

function localImports(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const names = []
  for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = path.posix.basename(match[1])
    if (!names.includes(target)) names.push(target)
  }
  return names.sort()
}

function buildLines() {
  const files = fs.readdirSync(path.join(ROOT, 'src'))
    .filter(file => file.endsWith('.js'))
    .map(file => `src/${file}`)
  files.push('start.js')
  files.sort()
  return files.map(file => {
    const deps = localImports(file)
    const label = file === 'start.js' ? 'start.js' : path.posix.basename(file)
    return `- ${label} → ${deps.length > 0 ? deps.join(', ') : '（无本地依赖）'}`
  })
}

function block() {
  return [BEGIN, ...buildLines(), END].join('\n')
}

function readIndex() {
  const file = path.join(ROOT, 'docs', 'INDEX.md')
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8')
}

const mode = process.argv[2] ?? '--print'
const generated = block()

if (mode === '--print') {
  process.stdout.write(`${generated}\n`)
} else if (mode === '--write') {
  const index = readIndex()
  if (index === null) { process.stderr.write('缺 docs/INDEX.md\n'); process.exit(1) }
  const beginAt = index.indexOf(BEGIN)
  const endAt = index.indexOf(END)
  if (beginAt < 0 || endAt < 0) {
    process.stderr.write(`INDEX.md 缺依赖速览标记: ${BEGIN} / ${END}\n`)
    process.exit(1)
  }
  const updated = index.slice(0, beginAt) + generated + index.slice(endAt + END.length)
  fs.writeFileSync(path.join(ROOT, 'docs', 'INDEX.md'), updated)
  process.stdout.write('INDEX.md 依赖速览已更新\n')
} else if (mode === '--check') {
  const index = readIndex()
  if (index === null) { process.stderr.write('缺 docs/INDEX.md\n'); process.exit(1) }
  const beginAt = index.indexOf(BEGIN)
  const endAt = index.indexOf(END)
  if (beginAt < 0 || endAt < 0) {
    process.stderr.write('INDEX.md 缺依赖速览标记（先 node scripts/gen-deps.mjs --write）\n')
    process.exit(1)
  }
  const current = index.slice(beginAt, endAt + END.length)
  if (current !== generated) {
    process.stderr.write('INDEX.md 依赖速览与当前 import 不一致（运行 node scripts/gen-deps.mjs --write）\n')
    process.exit(1)
  }
  process.exit(0)
} else {
  process.stderr.write(`未知模式: ${mode}\n`)
  process.exit(1)
}
