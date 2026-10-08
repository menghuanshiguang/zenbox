/**
 * banner.js — §8.4 启动横幅渲染（框 + 字段标签 + 异步占位）。
 *
 * 字段不得缺是硬要求：网络信息（公网 IP、清单、LAN 地址）在冷启动时还没
 * 拿到，先以 `[异步]` 占位打全框，宿主拿到值后用本模块的行渲染函数补行
 * ——不重打整框，不重排已输出的日志。IP 三家全挂只显示 `unknown`，
 * §8.4 明确不许崩。
 */

const RULE = '─'

/** 框宽与 §8.4 示例一致；标签列对齐到 `值` 起点。 */
const WIDTH = 60
const LABEL_WIDTH = 12

/**
 * 标签列对齐到值起点。
 * @param {string} label
 * @param {string} value
 */
const pad = (label, value) => `│  ${label.padEnd(LABEL_WIDTH, ' ')}${value}`

/** 异步字段的占位后缀。 */
const asyncTag = '  [异步]'

/**
 * 公网出口行（异步补行也用它）。
 * @param {{ip?: string, country?: string, provider?: string}|null} state
 */
export function renderIpLine(state) {
  if (state === null || state === undefined) return pad('公网出口', '…') + asyncTag
  const ip = state.ip ?? 'unknown'
  const suffix = state.country ? `  (${state.country})` : ''
  return pad('公网出口', `${ip}${suffix}`)
}

/**
 * 模型清单行；pending 时占位，有数后给四段计数。
 * @param {{total?: number, available?: number, regionLimited?: number, removed?: number}|null} state
 */
export function renderModelsLine(state) {
  if (state === null || state === undefined) return pad('模型清单', '…') + asyncTag
  if (state.available === undefined) return pad('模型清单', `${state.total} 个 · 分桶待探测`) + asyncTag
  return pad('模型清单', `${state.total} 个 · 可用 ${state.available} · 地区受限 ${state.regionLimited} · 移除 ${state.removed}`)
}

/**
 * 局域网地址行（#76 排好序的地址+物理/虚拟分组）。
 * @param {{address: string, kind: string}[]|null} addresses
 */
export function renderLanAddressLine(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) return pad('局域网地址', '…') + asyncTag
  return pad('局域网地址', addresses.map(entry => `${entry.address} (${entry.kind})`).join(' / '))
}

/**
 * 完整启动框（§8.4）。所有字段一次给齐：缺省字段渲染成占位，绝不省行。
 *
 * @param {object} fields
 * @param {string} fields.version
 * @param {string} fields.upstream 上游 base
 * @param {{host: string, port: number, requestedPort: number, fellBack: boolean}} fields.listen
 * @param {string|null} fields.keyTail Key 后 4 位；null=未生成
 * @param {{enabled: boolean, host?: string, port?: number, fellBack?: boolean}} fields.lan
 * @param {{ip: string, country: string, provider: string}|null} [fields.ip] null=异步占位
 * @param {{address: string, kind: string}[]|null} [fields.lanAddresses] null=异步占位
 * @param {{total?: number, available?: number, regionLimited?: number, removed?: number}|null} [fields.models] null=异步占位
 * @returns {string[]}
 */
export function renderBanner({ version, upstream, listen, keyTail, lan, ip = null, lanAddresses = null, models = null }) {
  const header = `┌─ zenbox v${version} ${RULE.repeat(Math.max(4, WIDTH - 11 - String(version).length))}`
  const key = keyTail === null || keyTail === undefined ? '未生成' : `ofm-****${keyTail}`
  const portNote = listen.fellBack === true ? `（已顺延自 ${listen.requestedPort}）` : ''
  const relay = lan.enabled === true
    ? `已启用 ${lan.host ?? '0.0.0.0'}:${lan.port ?? 0}${lan.fellBack === true ? '（顺延）' : ''} · 独立 Key`
    : '关闭（config lan.enabled=true 开启，独立 Key 与本机不通用）'
  return [
    header,
    pad('上游', `${upstream} · 免密车道`),
    renderIpLine(ip),
    renderLanAddressLine(lanAddresses),
    pad('本机转发', `http://${listen.host}:${listen.port}${portNote}   Key: ${key}`),
    pad('局域网中继', relay),
    renderModelsLine(models),
    `└${RULE.repeat(WIDTH - 1)}`,
  ]
}
