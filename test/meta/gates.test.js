// L0 门禁: 文档对账 + coverage-map 无孤儿 + pr-coverage 引用完整性。
// 规则（AGENT-BRIEF §10）:
//   ① 每个 src/*.js 有 docs/modules/<名>.md，反向亦然（_TEMPLATE 除外）
//   ② 十个二级标题齐全（缺节 = L0 红）
//   ③ 每份模块文档首行 `# <名>.js — …` 在 INDEX.md 中逐字出现
//   ④ INDEX.md 依赖速览区间由 scripts/gen-deps.mjs 生成且与当前 import 一致
//   ⑤ coverage-map: 映射路径全部存在；每个 test/**/*.test.js 都被映射（双向无孤儿）
//   ⑥ pr-coverage.md 数据行的测试列引用的 id 必须存在于 coverage-map
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECTIONS = [
  '## 职责边界', '## 导出符号表', '## 依赖关系', '## 配置键', '## 日志错误',
  '## 网络面', '## 关联 PR', '## 测试对照', '## 已知边界', '## 变更记录',
]

let passed = 0
/** @param {string} name @param {() => void} fn */
function check(name, fn) {
  try { fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

function listModules() {
  const dir = path.join(ROOT, 'src')
  return fs.readdirSync(dir).filter(file => file.endsWith('.js')).map(file => file.slice(0, -3))
}
function listDocs() {
  const dir = path.join(ROOT, 'docs', 'modules')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.md') && file !== '_TEMPLATE.md')
    .map(file => file.slice(0, -3))
}

// ① 双向齐备
check('src 模块都有文档', () => {
  const missing = listModules().filter(name => !listDocs().includes(name))
  assert.deepEqual(missing, [], `缺文档: ${missing.join(', ')}`)
})
check('文档都有 src 模块（孤儿文档）', () => {
  const orphans = listDocs().filter(name => !listModules().includes(name))
  assert.deepEqual(orphans, [], `孤儿文档: ${orphans.join(', ')}`)
})

// ② 十节齐全
check('十节结构', () => {
  const problems = []
  for (const name of listDocs()) {
    const text = fs.readFileSync(path.join(ROOT, 'docs', 'modules', `${name}.md`), 'utf8')
    let cursor = -1
    for (const section of SECTIONS) {
      const at = text.indexOf(`\n${section}`)
      if (at < 0) { problems.push(`${name}.md 缺 ${section}`); continue }
      if (at < cursor) problems.push(`${name}.md ${section} 顺序错`)
      cursor = at
    }
  }
  assert.deepEqual(problems, [], problems.join('; '))
})

// ③ 首行与 INDEX 对齐
check('INDEX 收录每份文档的首行', () => {
  const index = fs.readFileSync(path.join(ROOT, 'docs', 'INDEX.md'), 'utf8')
  const missing = []
  for (const name of listDocs()) {
    const firstLine = fs.readFileSync(path.join(ROOT, 'docs', 'modules', `${name}.md`), 'utf8').split('\n')[0].trim()
    if (!index.includes(firstLine)) missing.push(`${name}.md 首行未出现在 INDEX.md: ${firstLine}`)
  }
  assert.deepEqual(missing, [], missing.join('; '))
})

// ④ 依赖速览与当前 import 一致
check('INDEX 依赖速览为脚本生成（与 gen-deps 输出一致）', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-deps.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

// ⑤ coverage-map 双向无孤儿
check('coverage-map 无孤儿', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'meta', 'coverage-map.json'), 'utf8'))
  const mappedPaths = Object.values(map.tests).map(file => String(file).split('#')[0])
  const missing = mappedPaths.filter(file => !fs.existsSync(path.join(ROOT, file)))
  assert.deepEqual(missing, [], `映射指向不存在的文件: ${missing.join(', ')}`)
  const actual = []
  const walk = dir => {
    const full = path.join(ROOT, dir)
    if (!fs.existsSync(full)) return
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name)
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.test.js')) actual.push(rel)
    }
  }
  walk('test')
  const uncovered = actual.filter(file => !mappedPaths.includes(file))
  assert.deepEqual(uncovered, [], `未映射的测试: ${uncovered.join(', ')}`)
})

// ⑥ pr-coverage 数据行的测试列引用有效
check('pr-coverage 测试引用有效', () => {
  const file = path.join(ROOT, 'docs', 'pr-coverage.md')
  if (!fs.existsSync(file)) return assert.fail('缺 docs/pr-coverage.md')
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'meta', 'coverage-map.json'), 'utf8'))
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const problems = []
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue // 表头分隔行
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length < 3) continue
    if (cells[0] === 'PR') { // 表头: 列序固定, 测试恒为末列
      assert.deepEqual(cells, ['PR', '处置', '落点', '测试'], `pr-coverage 表头列序异常: ${cells.join('|')}`)
      continue
    }
    const testCell = cells[cells.length - 1] // 测试列 = 末列（处置/落点里可能出现 "test" 字样, 禁止按内容猜列）
    for (const id of testCell.split(/[、,]/).map(s => s.trim())) {
      if (id === '' || id === '—' || id === '-' || id.startsWith('N/A') || id === '待补') continue
      if (!Object.keys(map.tests).includes(id)) problems.push(`PR ${cells[0]}: 未知测试 id "${id}"`)
    }
  }
  assert.deepEqual(problems, [], problems.join('; '))
})

console.log(`gates.test: ${passed} passed${process.exitCode ? '（有失败）' : ''}`)
