// 最小 Node 运行时声明（devDependencies 仅 typescript，不引入 @types/node）。
// node:* 模块用 ambient shorthand —— 导入符号类型为 any；全局只声明本项目真实
// 用到的名字。新模块若引入新 node: 模块，在此追加一行。
declare module 'node:fs'
declare module 'node:path'
declare module 'node:os'
declare module 'node:url'
declare module 'node:crypto'
declare module 'node:child_process'
declare module 'node:http'
declare module 'node:https'
declare module 'node:net'
declare module 'node:tls'
declare module 'node:dns'
declare module 'node:dns/promises'
declare module 'node:perf_hooks'
declare module 'node:events'
declare module 'node:process'
declare module 'node:assert'
declare module 'node:assert/strict'
declare module 'node:stream'
declare module 'node:buffer'
declare module 'node:worker_threads'

declare const process: any
declare const console: any
declare const Buffer: any
declare const URL: any
declare const structuredClone: (value: any) => any
declare const setTimeout: (fn: (...args: any[]) => void, ms: number) => any
declare const clearTimeout: (handle: any) => void
declare const setInterval: (fn: (...args: any[]) => void, ms: number) => any
declare const clearInterval: (handle: any) => void
declare const queueMicrotask: (fn: () => void) => void
declare const AbortController: any
declare const AbortSignal: any
declare const fetch: any
declare const Headers: any
declare const Request: any
declare const Response: any
declare const TextEncoder: any
declare const TextDecoder: any
declare const performance: any
