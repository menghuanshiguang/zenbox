// L1 单元：#74 effort 别名——转发口的 OpenAI 档位写法必须落到同一套真实预算。
// 本车道唯一强制手段是 max_tokens（见 src/effort.js 模块头），所以
// minimal/low/none → light、medium → balanced、high/xhigh/max → deep，
// 大小写与首尾空格不敏感；认不出的写法落默认档，不静默放大。
// 红→绿：先断言（当前 resolveLevel 无别名表，应红），再移植。
// 运行: node test/unit/effort.test.js
import { strict as assert } from 'node:assert'
import {
  DEFAULT_LEVEL, MIN_BUDGET, ALWAYS_THINKING_FACTOR, LEVELS, budgetFor, budgetLadder, defaultEffortFor,
  effortsFor, effortPatchFor, hasDeclaredEffortMenu, menuDefaultLevel, normalizeLevel, resolveLevel, supportsEffort,
} from '../../src/effort.js'
import { buildCatalog } from '../../src/catalog.js'

let passed = 0
/** @param {string} name @param {() => void | Promise<void>} fn */
async function check(name, fn) {
  try { await fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

const catalog = id => buildCatalog([id])[0]
const MIMO = catalog('mimo-v2.6-flash-free') // 永远在思考的车道：梯子翻倍
const UNION = catalog('union-alpha') // 无档位菜单
const MENU = { id: 'menu-model', reasoning: true, efforts: ['disabled', 'low', 'medium', 'high'], effortDefault: 'medium' }
const DEFAULTS = 32768

// ── #74 normalizeLevel：任何写法归到声明的档位 id ──────────────────────────
await check('OpenAI 低档写法归到 light', async () => {
  assert.deepEqual(['minimal', 'low', 'light'].map(name => normalizeLevel(name)), ['light', 'light', 'light'])
})
await check('medium 归到 balanced', async () => {
  assert.equal(normalizeLevel('medium'), 'balanced')
})
await check('高档写法归到 deep', async () => {
  assert.deepEqual(['high', 'xhigh', 'max', 'deep'].map(name => normalizeLevel(name)), ['deep', 'deep', 'deep', 'deep'])
})
await check('大小写与首尾空格不敏感', async () => {
  assert.equal(normalizeLevel('  HIGH '), 'deep')
  assert.equal(normalizeLevel('None'), 'light')
})
await check('非字符串与认不出的写法返回 undefined（由调用方落默认）', async () => {
  assert.equal(normalizeLevel(42), undefined)
  assert.equal(normalizeLevel(undefined), undefined)
  assert.equal(normalizeLevel('turbo'), undefined)
})

// ── #74 resolveLevel：别名走同一阶梯，认不出的落默认档 ─────────────────────
await check('别名在真实阶梯上解析（light/balanced/deep）', async () => {
  assert.equal(resolveLevel('minimal', MIMO)?.id, 'light')
  assert.equal(resolveLevel('medium', MIMO)?.id, 'balanced')
  assert.equal(resolveLevel('high', MIMO)?.id, 'deep')
  assert.equal(resolveLevel('  HIGH ', MIMO)?.id, 'deep')
})
await check('两把梯子都不认识的词落默认档，不静默放大', async () => {
  assert.equal(resolveLevel('turbo', MIMO)?.id, DEFAULT_LEVEL)
})
await check('无菜单模型仍整窗给答案（不被档位切）', async () => {
  assert.equal(resolveLevel('light', UNION), undefined)
})
await check('有声明菜单的模型仍按其自身档位精确匹配，别名不劫持', async () => {
  assert.equal(resolveLevel('medium', MENU)?.id, 'medium') // 菜单自身档位
  assert.equal(resolveLevel('minimal', MENU)?.id, 'medium') // 菜单没有的写法 → 菜单默认，而非 free 梯子
})

// ── #74 budgetFor：none/off/disabled 落最小档（不是无界） ──────────────────
await check('询问"不思考"得到最小档而非无上限', async () => {
  assert.deepEqual(['none', 'off', 'disabled'].map(name => budgetFor(name, MIMO, undefined, DEFAULTS)), [4096, 4096, 4096])
})
await check('OpenAI 档位写法在预算上落到同档', async () => {
  assert.deepEqual(['minimal', 'medium', 'high'].map(name => budgetFor(name, MIMO, undefined, DEFAULTS)), [4096, 16384, 32768])
})

// ── 核心导出符号各至少一条断言（§7.2 effort 模块） ─────────────────────────
await check('默认档与地板值不变', async () => {
  assert.equal(DEFAULT_LEVEL, 'balanced')
  assert.equal(MIN_BUDGET, 512)
})
await check('budgetLadder 三档且默认标记在 balanced', async () => {
  const rows = budgetLadder(MIMO, undefined, DEFAULTS)
  assert.deepEqual(rows.map(row => row.id), ['light', 'balanced', 'deep'])
  assert.deepEqual(rows.map(row => row.isDefault), [false, true, false])
})
await check('supportsEffort/hasDeclaredEffortMenu 的判定边界', async () => {
  assert.equal(supportsEffort(MIMO), true)
  assert.equal(supportsEffort(UNION), false)
  assert.equal(hasDeclaredEffortMenu(MENU), true)
  assert.equal(hasDeclaredEffortMenu(MIMO), false)
})
await check('defaultEffortFor：菜单模型取菜单默认，free 车道取 balanced', async () => {
  assert.equal(defaultEffortFor(MENU), 'medium')
  assert.equal(defaultEffortFor(MIMO), 'balanced')
})
await check('effortsFor：菜单模型给菜单，free 车道给带真实预算的梯子', async () => {
  assert.deepEqual(effortsFor(MENU, undefined, DEFAULTS).map(row => row.id), ['disabled', 'low', 'medium', 'high'])
  assert.deepEqual(effortsFor(MIMO, undefined, DEFAULTS).map(row => row.id), ['light', 'balanced', 'deep'])
  assert.equal(effortsFor(UNION, undefined, DEFAULTS), undefined)
})
await check('LEVELS/ALWAYS_THINKING_FACTOR：档位表与翻倍系数定值', async () => {
  assert.deepEqual(LEVELS.map(row => row.id), ['light', 'balanced', 'deep']) // 选择器顺序即数组序
  assert.equal(LEVELS[0].ceiling, 2048)
  assert.equal(LEVELS[1].ceiling, 8192)
  assert.equal(LEVELS[2].ceiling, undefined) // deep 不设上限
  assert.equal(ALWAYS_THINKING_FACTOR, 2) // 必思考模型的梯级翻倍系数
})
await check('menuDefaultLevel：菜单默认优先，缺省回落首档，无菜单给 undefined', async () => {
  assert.equal(menuDefaultLevel(MENU), 'medium') // effortDefault 在表内
  assert.equal(menuDefaultLevel({ ...MENU, effortDefault: 'nope' }), 'disabled') // 默认不在表 → 首档
  assert.equal(menuDefaultLevel({ id: 'x' }), undefined) // 无 efforts 数组
  assert.equal(menuDefaultLevel({ efforts: [] }), undefined) // 空菜单
})
await check('effortPatchFor：无菜单 null、$effort 实例化、off 走 offPatch', async () => {
  assert.equal(effortPatchFor('light', MIMO), null) // free 梯子模型没有 patch 面
  assert.equal(effortPatchFor('low', MENU), null) // 有菜单但未声明 patch 模板
  assert.deepEqual(
    effortPatchFor('low', { ...MENU, effortPatch: { reasoning_effort: '$effort' } }),
    { reasoning_effort: 'low' },
  ) // 菜单内档位直通
  assert.deepEqual(
    effortPatchFor('nope', { ...MENU, effortPatch: { a: '$effort' } }),
    { a: 'medium' }, // 未知写法回菜单默认（与 resolveLevel 同口径）
  )
  assert.deepEqual(
    effortPatchFor('disabled', { ...MENU, effortPatch: { a: '$effort' }, effortOffPatch: { thinking: { type: '$effort' } } }),
    { thinking: { type: 'disabled' } }, // off 档有专属模板时不复用主模板
  )
})

console.log(`effort.test: ${passed} passed`)
if (passed !== 19) process.exitCode = 1
