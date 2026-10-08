/**
 * ipinfo.js — 公网出口 IP 的三家降级探测（§8 `ip` 配置段 / brief line148）。
 *
 * 出网目标白名单成员之一：只打 config `ip.providers` 点名的三家，按顺序
 * 试到第一个给出可用地址为止。任何一家超时/坏体/非 200 都换下家；三家
 * 全挂回 `unknown` 而不是抛错——§8.4 明确 banner 与 status 不许因为 IP
 * 探测全灭而崩溃。
 *
 * 网络面：GET 三家（ipify/ipinfo/ipapi 的公开端点），超时用 AbortController。
 * 30min 刷新节奏由宿主（start.js 后台轮）持有，本模块单发单收。
 */

/** 三家的端点与字段解析（§8 默认 providers 顺序即降级顺序）。 */
export const PROVIDER_URLS = /** @type {Record<string, string>} */ ({
  ipify: 'https://api.ipify.org?format=json',
  ipinfo: 'https://ipinfo.io/json',
  ipapi: 'https://ipapi.co/json',
})

const DEFAULT_PROVIDERS = ['ipify', 'ipinfo', 'ipapi']
const DEFAULT_TIMEOUT_MS = 4000

/** 从各家响应体里取 {ip, country}——三家字段名各不相同。
 * @param {string} provider
 * @param {any} data
 */
function parse(provider, data) {
  if (provider === 'ipify') return typeof data?.ip === 'string' ? { ip: data.ip, country: '' } : null
  if (provider === 'ipinfo') {
    return typeof data?.ip === 'string'
      ? { ip: data.ip, country: typeof data.country === 'string' ? data.country : '' }
      : null
  }
  // ipapi（ipapi.co）：国家码在 country_code。
  return typeof data?.ip === 'string'
    ? { ip: data.ip, country: typeof data.country_code === 'string' ? data.country_code : '' }
    : null
}

/**
 * 按 providers 顺序探测公网出口，第一个成功的即返回。
 *
 * @param {object} [options]
 * @param {string[]} [options.providers] 试验顺序，默认 §8 的 ipify/ipinfo/ipapi
 * @param {number} [options.timeoutMs] 单家超时（默认 4000ms）
 * @param {typeof fetch} [options.fetchImpl] 注入点（测试桩；默认全局 fetch）
 * @returns {Promise<{ip: string, country: string, provider: string}>}
 *   全挂时 `{ip: 'unknown', country: '', provider: ''}`
 */
export async function fetchPublicIp({ providers = DEFAULT_PROVIDERS, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  for (const provider of providers) {
    const url = PROVIDER_URLS[provider]
    if (url === undefined) continue
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (response?.ok !== true) continue
      const parsed = parse(provider, await response.json())
      if (parsed === null) continue
      return { ...parsed, provider }
    } catch {
      // 超时/网络错/坏 JSON——都只是"这家不行"，换下家。
      continue
    } finally {
      clearTimeout(timer)
    }
  }
  return { ip: 'unknown', country: '', provider: '' }
}
