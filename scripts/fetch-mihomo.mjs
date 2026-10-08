#!/usr/bin/env node
// 内置 mihomo：按 vendor/mihomo/manifest.json 的 pin 版本，从 GitHub Releases 拉取
// 当前（或 --platform 指定）平台的官方二进制到 vendor/mihomo/<os>-<arch>/。
// 这是安装期/CI 期的显式动作——运行时 findMihomoBinary 只认领、从不下载。
//
// 用法:
//   node scripts/fetch-mihomo.mjs              拉当前平台 + 打印路径
//   node scripts/fetch-mihomo.mjs --smoke      拉完跑 `mihomo -v` 验证
//   node scripts/fetch-mihomo.mjs --dry-run    只解析资产名，不出网
//   node scripts/fetch-mihomo.mjs --list       打印 pin 版本与本机平台键
//   node scripts/fetch-mihomo.mjs --platform linux-arm64   为其他平台预取
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.join(HERE, '..')
export const VENDOR_ROOT = path.join(REPO_ROOT, 'vendor', 'mihomo')

/**
 * 平台键：node 的 platform/arch → mihomo release 的 os-arch 段。
 * @param {string} [platform] @param {string} [arch]
 * @returns {string} 如 `linux-arm64`
 */
export function platformKey(platform = process.platform, arch = process.arch) {
  const osName = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform]
  const cpu = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[arch]
  if (!osName || !cpu) throw new Error(`unsupported platform ${platform}-${arch} — fetch it manually from MetaCubeX/mihomo`)
  return `${osName}-${cpu}`
}

/**
 * 基础版资产名：linux/darwin 是 .gz，windows 是 .zip。
 * @param {string} key @param {string} version
 */
export function assetNameFor(key, version) {
  return `mihomo-${key}-${version}.${key.startsWith('windows') ? 'zip' : 'gz'}`
}

/**
 * @param {string} key
 * @returns {string} vendor 目录里的二进制名
 */
export function binaryNameFor(key) {
  return key.startsWith('windows') ? 'mihomo.exe' : 'mihomo'
}

/**
 * 从 release 资产列表挑基础版——精确匹配，排除 microarch(v1/v2)/go120/compatible 变体与 rpm/deb。
 * @param {string[]} names @param {string} key @param {string} version
 */
export function selectAsset(names, key, version) {
  const want = assetNameFor(key, version)
  if (!names.includes(want)) throw new Error(`no asset "${want}" in the release — saw ${names.length} assets`)
  return want
}

/**
 * 解出 zip 里第一个成员（mihomo windows 包内是单个 mihomo.exe）。
 * 走 central directory——local header 的 compressed size 可能是 0（data descriptor）。
 * @param {Buffer} zip
 * @returns {Buffer}
 */
export function unzipFirstMember(zip) {
  // EOCD 0x06054b50：从尾部 64KB 内反向找。
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found')
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip: bad central directory entry')
    const method = zip.readUInt16LE(offset + 10)
    const compressed = zip.readUInt32LE(offset + 20)
    const nameLen = zip.readUInt16LE(offset + 28)
    const extraLen = zip.readUInt16LE(offset + 30)
    const commentLen = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLen)
    if (name.endsWith('.exe') || n === count - 1) {
      const localNameLen = zip.readUInt16LE(localOffset + 26)
      const localExtraLen = zip.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLen + localExtraLen
      const data = zip.subarray(start, start + compressed)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return zlib.inflateRawSync(data)
      throw new Error(`zip: unsupported compression method ${method}`)
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('zip: no members')
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--smoke' || flag === '--dry-run' || flag === '--list' || flag === '--help') out[flag.slice(2)] = true
    else if (flag === '--platform' || flag === '--version' || flag === '--out') out[flag.slice(2)] = argv[++i]
    else throw new Error(`unknown flag ${flag}`)
  }
  return out
}

/** @param {string} manifestPath */
function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''))
  if (typeof manifest.version !== 'string' || typeof manifest.source !== 'string') {
    throw new Error(`bad manifest at ${manifestPath}: needs {source, version}`)
  }
  return manifest
}

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv) {
  const args = parseArgs(argv)
  const manifest = readManifest(path.join(VENDOR_ROOT, 'manifest.json'))
  const key = args.platform ?? platformKey()
  const version = args.version ?? manifest.version
  const outDir = args.out ?? path.join(VENDOR_ROOT, key)
  if (args.list) {
    console.log(`${manifest.source}@${version} · 本机 ${platformKey()} · 输出 ${path.relative(REPO_ROOT, outDir)}`)
    return 0
  }
  const asset = assetNameFor(key, version)
  if (args['dry-run']) {
    console.log(`dry-run: ${asset} → ${path.relative(REPO_ROOT, outDir)}/${binaryNameFor(key)}`)
    return 0
  }

  const headers = { 'user-agent': 'zenbox-fetch-mihomo', accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const releaseResponse = await fetch(`https://api.github.com/repos/${manifest.source}/releases/tags/${version}`, { headers })
  if (!releaseResponse.ok) throw new Error(`release lookup answered ${releaseResponse.status} for ${manifest.source}@${version}`)
  const release = await releaseResponse.json()
  const names = (release.assets ?? []).map(assetEntry => assetEntry.name)
  const chosen = selectAsset(names, key, version)
  const url = (release.assets ?? []).find(assetEntry => assetEntry.name === chosen).browser_download_url
  const download = await fetch(url, { headers })
  if (!download.ok) throw new Error(`download answered ${download.status} for ${chosen}`)
  const packed = Buffer.from(await download.arrayBuffer())
  const raw = chosen.endsWith('.gz') ? zlib.gunzipSync(packed) : unzipFirstMember(packed)
  const binPath = path.join(outDir, binaryNameFor(key))
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(binPath, raw)
  if (!binPath.endsWith('.exe')) fs.chmodSync(binPath, 0o755)
  const sha = crypto.createHash('sha256').update(raw).digest('hex')
  console.log(`mihomo ${version} → ${path.relative(REPO_ROOT, binPath)} (${raw.length} bytes, sha256 ${sha.slice(0, 16)}…)`)
  if (args.smoke) {
    if (key !== platformKey()) {
      // 预取其他平台的产物：本机执行不了 ELF/别的架构，只验落盘。
      console.log(`smoke: skipped — ${key} artifact on a ${platformKey()} host`)
    } else {
      const run = spawnSync(binPath, ['-v'], { encoding: 'utf8' })
      const line = String(run.stdout ?? run.stderr ?? '').trim().split('\n')[0]
      if (run.status !== 0) throw new Error(`smoke failed (exit ${run.status}): ${line}`)
      console.log(`smoke: ${line}`)
    }
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => { console.error(`fetch-mihomo: ${error.message}`); process.exit(1) },
  )
}
