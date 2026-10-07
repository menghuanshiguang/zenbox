/**
 * src/turn.js — 转发口一次请求的语义链：调用方 OpenAI 拼写 → harness 消息 → adapter 流 → outcome 折叠。
 *
 * 素材抽自 index.js（M1 拆解，index.js 拆完即删）：fromOpenAiMessages 及其
 * Responses 归一（issue #62 的 assistant source 形状）、normalizeTool（调用方
 * 工具定义展平，#27 回归的前置）、foldForwardOutcome、httpError（带状态码的
 * 404/409 语义）、computeMembership（探测判定 → 主线/区域线归属，全拒回退）、
 * routableModelIds（picker 可拨集合，/v1/models 与转发口同一门）、
 * publicModelRows（/v1/models 行）、createRunForwarded（runForwarded 的可注入
 * 装配：目录/状态/设置/适配器全部参数化，start.js 与测试共用同一条链）。
 *
 * 网络面：无（纯语义换算）；上游 I/O 全在 adapter.stream 一侧。
 */
import { ROUTE_MAIN, ROUTE_REGION } from './adapter.js'
import { STATE } from './probe.js'
import { toOpenAiUsage } from './forward.js'

/**
 * An error the forward listener presents with its own status line, not a bare 500.
 * Used where a refusal is the *correct* answer — a roster miss, a gated model —
 * so the caller reads `model_not_found` instead of blaming the gateway.
 */
export function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * Which route advertises which model, given the last probe.
 *
 * Region-gated models move to their dedicated route, and only while the user
 * wants them shown. Everything else sits on the main route, including models a
 * probe could not reach this round — a call that never got an answer is not a
 * verdict, and a flaky network must not empty the picker.
 *
 * A model the gateway named in its listing but refused to route at all is the
 * exception: it cannot answer any prompt, so advertising it trades the user's
 * turn for a guaranteed failure. Those come out of both routes until a later
 * probe reverses the verdict, which the periodic re-probe does by itself if the
 * lane brings the id back.
 *
 * A catalog entry with no verdict at all is normal, not an edge case: a fresh
 * install has no probe history until the boot round lands, and a model the
 * listing just added has none until the next one does. Such an entry is
 * advertised — not knowing is not the same as knowing it is refused.
 *
 * The one thing that may never happen is an empty result. Every model failing
 * the same way means the lane or the client fingerprint is broken, not that the
 * whole roster went away, so a round that refused everything is ignored,
 * geography grouping and all.
 */
export function computeMembership(catalog, availabilitySnapshot, settings) {
  const results = availabilitySnapshot?.results ?? {}
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = entry => results[entry.id]?.state
  // Only the free lane is ever probed, so "the round refused everything" is a
  // verdict about that lane alone. A catalog row with a channel carried no
  // verdict at all; counting it among the refused would keep the fallback from
  // firing (usable could never empty).
  const probeable = catalog.filter(entry => !entry.channel)
  const refusedAll = probeable.length > 0 && probeable.every(entry => verdictOf(entry) === STATE.unavailable)
  let usable = catalog.filter(entry => verdictOf(entry) !== STATE.unavailable)
  if (refusedAll) usable = catalog
  const main = []
  const region = []
  for (const entry of usable) {
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}

/** What the picker selects and the forward port may dial — one definition, two surfaces. */
export function routableModelIds(state, settings) {
  const membership = new Set(state().membership[ROUTE_MAIN] ?? [])
  if (settings?.exposeRegionModels !== false) for (const id of state().membership[ROUTE_REGION] ?? []) membership.add(id)
  return membership
}

/** The `/v1/models` rows for whatever is dialable right now. */
export function publicModelRows(catalog, membership, nowSec = Math.floor(Date.now() / 1000)) {
  return catalog
    .filter(entry => membership.has(entry.id))
    .map(entry => ({
      id: entry.id,
      object: 'model',
      created: nowSec,
      owned_by: 'our-free-model',
      ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
    }))
}

/** OpenAI request messages -> harness messages, for the forward listener.
 *  Exported for the suite, which pins the assistant `source` shape the v4
 *  session format requires (issue #62). */
export function fromOpenAiMessages(body, isResponses, modelId) {
  const out = []
  const rows = isResponses
    ? normaliseResponsesInput(body.input)
    : (Array.isArray(body.messages) ? body.messages : [])
  for (const row of rows) {
    const role = row.role ?? 'user'
    const content = []
    if (typeof row.content === 'string') {
      if (row.content !== '') content.push({ type: 'text', text: row.content })
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === 'string') { if (part !== '') content.push({ type: 'text', text: part }); continue }
        const text = part?.text ?? part?.input_text ?? part?.output_text
        if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
        const image = part?.image_url?.url ?? part?.image_url
        if (typeof image === 'string' && image !== '') {
          content.push({ type: 'image', attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: image } })
        }
      }
    }
    if (role === 'tool') {
      out.push({ role: 'tool', content: [{ type: 'text', text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '') }], toolCallId: row.tool_call_id ?? '', source: { kind: 'tool', callId: row.tool_call_id ?? '' } })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: 'tool-call', id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
    if (content.length === 0) continue
    out.push({
      role: role === 'developer' ? 'developer' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
      content,
      // The v4 session format admits a `model` source only with its provider
      // and model named (dsh-session refuses a bare one on restore), so the
      // synthesized assistant rows carry the route they will stream through.
      ...role === 'assistant' ? { source: { kind: 'model', provider: ROUTE_MAIN, model: String(modelId ?? '') } } : {},
    })
  }
  return out
}

function normaliseResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.map(row => {
    if (typeof row === 'string') return { role: 'user', content: row }
    if (row.type === 'function_call') return { role: 'assistant', content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] }
    if (row.type === 'function_call_output') return { role: 'tool', content: String(row.output ?? ''), tool_call_id: row.call_id }
    return row
  })
}

export function normalizeTool(tool) {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} }
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ''), parameters }
}

export function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) { call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }; outcome.toolCalls.push(call) }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        const existing = outcome.toolCalls.find(candidate => candidate.id === chunk.block.id)
        if (existing === undefined) outcome.toolCalls.push({ slot: chunk.index, id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
      }
      break
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      // An aborted turn carries the same in-body nothing as an errored one; both
      // are the caller's failure to report, not an empty completion.
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') outcome.error = chunk.reason.failure?.message
      break
    default: break
  }
  return outcome
}

/**
 * Assemble one forwarded OpenAI request through the adapter.
 *
 * The caller's spelling is translated into harness messages, and the resulting
 * chunk stream is handed straight back to the caller's callback while an
 * outcome summary accumulates for the non-streaming path.
 *
 * `getState()` is re-read per step (entry check → routable gate → stream), so a
 * probe verdict landing mid-request is observed exactly like the index.js
 * closure did; `getSettings().exposeRegionModels` closes the region route.
 */
export function createRunForwarded({ getCatalog, getState, getSettings, adapter }) {
  return async function runForwarded(request, onChunk) {
    const entry = getCatalog().find(candidate => candidate.id === request.model)
    // OpenAI semantics: a model the roster does not carry is the caller's
    // mistake (404 model_not_found), not the gateway's — a 502 here read as
    // "the plugin is broken" to every client that inspects the status. The same
    // gate as `/v1/models`: a model the picker hides for having no route must
    // not become dialable just by naming it in a request body.
    if (entry === undefined || !routableModelIds(getState, getSettings()).has(entry.id)) {
      throw httpError(404, `model "${request.model}" not found`)
    }
    const openAi = request.openAi ?? {}
    const messages = fromOpenAiMessages(openAi, request.responses === true, entry.id)
    // The caller's defs reach the adapter in the harness's own flat spelling,
    // and the adapter re-shapes them for the endpoint it picked. Pre-converting
    // them here fed `{type,function:{…}}` wrappers back into that same
    // conversion, which reads `tool.name`: every tool was dropped, the request
    // went upstream with none, and the model answered "no tool is available"
    // instead of calling the one the caller offered.
    const tools = (openAi.tools ?? []).map(normalizeTool).filter(Boolean)
    const handler = typeof onChunk === 'function' ? onChunk : () => {}
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }

    const options = {
      provider: ROUTE_MAIN,
      model: entry.id,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      ...typeof openAi.temperature === 'number' ? { temperature: openAi.temperature } : {},
      ...typeof openAi.max_tokens === 'number' ? { maxTokens: openAi.max_tokens } : {},
      ...typeof openAi.reasoning_effort === 'string' ? { reasoningEffort: openAi.reasoning_effort } : {},
      sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? 'shared')}`,
      // The PROXY-claimed device, threaded to the gateway's x-forwarded-for;
      // absent for local traffic, so its outbound shape stays as it was.
      ...typeof request.deviceIp === 'string' && request.deviceIp !== '' ? { deviceIp: request.deviceIp } : {},
      signal: request.signal,
    }

    for await (const chunk of adapter.stream(options, entry, getState())) {
      handler(chunk)
      foldForwardOutcome(outcome, chunk)
    }
    // A max-tokens finish means the adapter judged a tool call unexecutable
    // (arguments cut mid-JSON); keep the OpenAI answer consistent with its
    // finish_reason by not reporting the broken call alongside `length`.
    if (outcome.truncated === true) {
      outcome.toolCalls = outcome.toolCalls.filter(call => {
        try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
      })
    }
    return outcome
  }
}
