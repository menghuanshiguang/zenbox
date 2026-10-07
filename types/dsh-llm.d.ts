/**
 * The slice of `@deepseek-ai/dsh-llm` this package is allowed to know about.
 *
 * The kernel is supplied by the installation, never depended on by version —
 * so this declares only the one function the adapter seam calls, and the seam
 * degrades to its fallback User-Agent when even that is absent.
 */

declare module '@deepseek-ai/dsh-llm' {
  export function attributionHeaders(): Record<string, string> | undefined

  /**
   * The one value `LlmResolvedModelInfo.systemPromptUpdate` accepts (#102).
   *
   * `src/adapter.js` returns this field to the kernel, and the kernel validates
   * it on the way out of `resolveModel()` — any other value is rejected with
   * `INVALID_MODEL_INFO` — then carries it onto the prepared call, where the
   * agent loop reads it to decide whether a changed prompt is appended after
   * the cached history or written into the leading system node in place.
   *
   * `'in-history'` means the endpoint reads the latest `system` message at any
   * position of `messages` as the complete effective system prompt. Absent
   * means only a leading system message is read.
   */
  export type SystemPromptUpdate = 'in-history'

  /** The resolved-model slice this package answers to — the rest is the kernel's. */
  export interface LlmResolvedModelInfo {
    systemPromptUpdate?: SystemPromptUpdate
  }
}
