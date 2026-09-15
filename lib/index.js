/**
 * dsh-sidebar-ratio —— 宿主半边。
 *
 * 只做一件事：把同包内 lib/dom.js 作为 script 行注入 index.html，
 * 并把 bundle patch 里的 config 作为默认值用 global 行交给页面。
 *
 * 机制证据（全部只读源码，未修改任何 DSH 文件）：
 * - packages/host/webserver/src/injections.ts:15-31   结构化注入行共有 6 种：
 *     global / script / script-src / script-preload / style / html
 *     本包只用 global 与 script；global 硬编码落 head（:56），script 用 placement: 'body'（:19）
 * - packages/host/webserver/src/index.ts:347-351,359-361   每次渲染 index.html 重新收集注入表
 *     -> 改 lib/dom.js 按 F5 即生效，不用重启 dsh web（本文件每次渲染都重读它）
 *     -> 但改 lib/index.js 或 cordis.patch.yml 的 config 必须重启：apply 只在启动时执行一次，
 *        config 也是在启动时就 pick 好的（apps/cli/src/profile-boot.ts:372-381 只 watch 用户 patch 文件）
 * - packages/client/ui-layout/src/client/AppFrame.tsx:203-238  三列网格与两个把手（DOM 侧接管目标）
 *
 * 注入契约（injections.ts:18 明文约束）：
 *   script 行的 text 里**不允许**出现 script 的结束标签字面量，宿主不做任何转义
 *   （:59 `markup = '<script>' + row.text + '</script>'`）。一旦出现，HTML 解析器会提前闭合
 *   该元素，页面结构直接崩掉。所以下面注入前先断言，命中就记 warn 并整行跳过 —— 宁可插件不
 *   生效，也不能把页面搞坏。
 *
 * 停用（官方渠道，二选一）：
 * - dshmarket 的启用/开关（往 profile patch 层写 `- id: sidebar-ratio` + `disabled: true`，HMR ~1s 生效）
 * - `dsh plugin --profile web remove dsh-sidebar-ratio`
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOM_FILE = join(HERE, 'dom.js')

/** bundle patch 里 config 的已知字段；其余忽略，避免把无关配置塞进页面。 */
const KEYS = ['left', 'right', 'minLeft', 'minRight', 'enabled', 'inherit', 'inheritAll', 'inheritFromParent']

/** script 结束标签（大小写不敏感）——注入内容里出现它就等于把页面撕开。 */
const CLOSING_TAG = /<\/script/i

/** dom.js 的 mtime 缓存：避免每次 index 响应都在请求路径上同步读 15KB。 */
const cache = { mtimeMs: -1, size: -1, text: null }

function warn(ctx, message) {
  try { ctx.logger.warn(`dsh-sidebar-ratio: ${message}`) } catch { /* 没有 logger 也不抛 */ }
}

/** 读 dom.js（按 mtime+size 缓存，保证 F5 仍能拿到最新内容）。读不到返回 null。 */
function readDom(ctx) {
  let stat
  try {
    stat = statSync(DOM_FILE)
  } catch (error) {
    warn(ctx, `跳过注入（stat ${DOM_FILE} 失败：${error instanceof Error ? error.message : String(error)}）`)
    return null
  }
  if (cache.text !== null && stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.text
  let text
  try {
    text = readFileSync(DOM_FILE, 'utf8')
  } catch (error) {
    warn(ctx, `跳过注入（读取 ${DOM_FILE} 失败：${error instanceof Error ? error.message : String(error)}）`)
    return null
  }
  cache.mtimeMs = stat.mtimeMs
  cache.size = stat.size
  cache.text = text
  return text
}

export function apply(ctx, config = {}) {
  const defaults = pick(config)

  ctx.on('webserver/index-inject', (table) => {
    const text = readDom(ctx)
    // 读不到就安静跳过：注入失败绝不能把页面渲染拖成 500。
    if (typeof text !== 'string' || text === '') return
    if (CLOSING_TAG.test(text)) {
      // 见文件头「注入契约」：宁可不注入，也不能让 HTML 解析器提前闭合 script 元素。
      warn(ctx, `跳过注入（${DOM_FILE} 里出现了 script 结束标签字面量，注入会破坏页面结构）`)
      return
    }
    // global 行落在 head，且先于后续 script 行（injections.ts 的顺序约定）
    table.push({ kind: 'global', name: '__DSH_SIDEBAR_RATIO__', value: defaults })
    table.push({ kind: 'script', placement: 'body', text })
  })
}

/** 只放行可 JSON 序列化的已知字段（null / boolean / number）。 */
function pick(config) {
  const out = {}
  if (config === null || typeof config !== 'object') return out
  for (const key of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue
    const value = config[key]
    if (value === null || typeof value === 'boolean' || typeof value === 'number') out[key] = value
  }
  return out
}
