// L1 单元测试：内置 mihomo——vendor 目录认领（findMihomoBinary）与 fetch 资产解析。
// 运行: node test/unit/vendor-mihomo.test.js （run-gates.mjs 统一收集，红→绿）
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findMihomoBinary, defaultVendorDirs, renderMihomoConfig } from '../../src/egress.js'
import { platformKey, assetNameFor, binaryNameFor, selectAsset } from '../../scripts/fetch-mihomo.mjs'

let passed = 0
/** @param {string} name @param {() => void} fn */
function check(name, fn) {
  try { fn(); passed++ } catch (error) {
    console.error(`FAIL: ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

/** 建一个假二进制文件，返回路径。@param {string} dir @param {string} name */
function stub(dir, name) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, 'stub')
  return file
}
/** 平台对应的二进制名。 */
const BIN = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'

// —— fetch 脚本纯函数：平台 → 资产名 → 目标二进制 ——
check('platformKey: 三平台 × 两架构映射到 release 资产键', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux-amd64')
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64')
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(platformKey('darwin', 'x64'), 'darwin-amd64')
  assert.equal(platformKey('win32', 'x64'), 'windows-amd64')
  assert.equal(platformKey('win32', 'arm64'), 'windows-arm64')
  assert.throws(() => platformKey('sunos', 'x64'), /unsupported platform/)
})
check('assetNameFor: linux/darwin 是 gz，windows 是 zip', () => {
  assert.equal(assetNameFor('linux-amd64', 'v1.19.32'), 'mihomo-linux-amd64-v1.19.32.gz')
  assert.equal(assetNameFor('linux-arm64', 'v1.19.32'), 'mihomo-linux-arm64-v1.19.32.gz')
  assert.equal(assetNameFor('darwin-arm64', 'v1.19.32'), 'mihomo-darwin-arm64-v1.19.32.gz')
  assert.equal(assetNameFor('windows-amd64', 'v1.19.32'), 'mihomo-windows-amd64-v1.19.32.zip')
  assert.equal(assetNameFor('windows-arm64', 'v1.19.32'), 'mihomo-windows-arm64-v1.19.32.zip')
})
check('binaryNameFor: windows 落 .exe，其余裸名', () => {
  assert.equal(binaryNameFor('windows-amd64'), 'mihomo.exe')
  assert.equal(binaryNameFor('windows-arm64'), 'mihomo.exe')
  assert.equal(binaryNameFor('linux-amd64'), 'mihomo')
  assert.equal(binaryNameFor('darwin-arm64'), 'mihomo')
})
check('selectAsset: 只认基础版资产，排除 microarch/go/compatible 变体与包格式', () => {
  const names = [
    'mihomo-linux-amd64-v1.19.32.gz',
    'mihomo-linux-amd64-v1-v1.19.32.gz',       // microarch 段
    'mihomo-linux-amd64-compatible-v1.19.32.gz', // 老 CPU 兼容版
    'mihomo-linux-amd64-v1-go120-v1.19.32.gz', // go 工具链变体
    'mihomo-linux-amd64-v1.19.32.rpm',          // 包格式
  ]
  assert.equal(selectAsset(names, 'linux-amd64', 'v1.19.32'), 'mihomo-linux-amd64-v1.19.32.gz')
  assert.throws(() => selectAsset(names, 'linux-arm64', 'v1.19.32'), /no asset/)
})

// —— findMihomoBinary: 内置 vendor 目录的认领顺序 ——
check('findMihomoBinary: vendor 目录里的二进制被认领', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-vendor-'))
  try {
    const bin = stub(dir, BIN)
    assert.equal(findMihomoBinary('', { vendorDirs: [dir], dirs: [], roots: [] }), bin)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
check('findMihomoBinary: vendor 优先于 PATH', () => {
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-vendor-'))
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-path-'))
  try {
    const vendored = stub(vendorDir, BIN)
    stub(pathDir, BIN)
    const found = findMihomoBinary('', { vendorDirs: [vendorDir], dirs: [pathDir], roots: [] })
    assert.equal(found, vendored, '内置版本 pin 优先，PATH 只是回落')
  } finally {
    fs.rmSync(vendorDir, { recursive: true, force: true })
    fs.rmSync(pathDir, { recursive: true, force: true })
  }
})
check('findMihomoBinary: vendor 缺席时回落 PATH → 安装目录', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-vendor-'))
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-path-'))
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-root-'))
  try {
    const onPath = stub(pathDir, BIN)
    assert.equal(findMihomoBinary('', { vendorDirs: [empty], dirs: [pathDir], roots: [] }), onPath)
    const installed = stub(rootDir, BIN)
    assert.equal(findMihomoBinary('', { vendorDirs: [empty], dirs: [], roots: [rootDir] }), installed)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
    fs.rmSync(pathDir, { recursive: true, force: true })
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})
check('findMihomoBinary: 默认 vendorDirs 落在 vendor/mihomo/<os>-<arch>', () => {
  const dirs = defaultVendorDirs()
  assert.equal(dirs.length, 1)
  const key = platformKey(process.platform, process.arch)
  assert.equal(dirs[0], path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'vendor', 'mihomo', key))
})
check('findMihomoBinary: 三处全空时，报错指向 fetch 脚本', () => {
  assert.throws(
    () => findMihomoBinary('', { vendorDirs: [], dirs: [], roots: [] }),
    /fetch-mihomo/,
  )
})

// —— 订阅凭据：config.egress.subscription.token 渲成 provider 的 Authorization 头 ——
check('renderMihomoConfig: token 非空渲染 headers（原样，Bearer 由用户自带）', () => {
  const yaml = renderMihomoConfig({ subscription: 'https://sub.example/link', token: 'Bearer abc123', mixedPort: 33001, apiPort: 33002, secret: 's', auth: 'ofm:x', logFile: '/tmp/m.log' })
  assert.ok(yaml.includes('    headers:'), 'provider 段有 headers')
  assert.ok(yaml.includes('      Authorization: "Bearer abc123"'), 'Authorization 头携带 token')
  assert.ok(yaml.indexOf('    headers:') > yaml.indexOf('    url:'), 'headers 紧随 url 之后')
})
check('renderMihomoConfig: token 缺省不渲染 headers（URL 即凭据的老用法不变）', () => {
  const yaml = renderMihomoConfig({ subscription: 'https://sub.example/link', mixedPort: 33001, apiPort: 33002, secret: 's', auth: 'ofm:x', logFile: '/tmp/m.log' })
  assert.ok(!yaml.includes('headers:'), '无 token 就没有 headers 块')
  assert.ok(!yaml.includes('Authorization'), '无 token 就没有 Authorization')
})

console.log(`vendor-mihomo: ${passed} passed`)
if (passed !== 11) {
  console.error(`FAIL: expected 11 checks, got ${passed}`)
  process.exitCode = 1
}
