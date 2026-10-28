import { normalizeLabel } from './lexer'
import { parseBlocks } from './block-parser'
import type { BlockNode, RefMap } from './types'
import { renderBlocks, type RenderOptions } from './renderer'

export * from './types'
export { renderBlocks, renderInline, esc, type RenderOptions } from './renderer'

/**
 * 编译入口。
 *
 * 编译流水线：归一化 → 收集引用定义 → 块级解析 → 行内解析 → 渲染。
 * 引用定义要「先全篇收集再解析」，否则前向引用（`[a][r]` 在 `[r]: url` 之前）会失效。
 */

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/
const DEF_LINE =
  /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/

export interface CompileResult {
  text: string
  refs: RefMap
}

/** 抽出 `[label]: url "title"`，把该行替换成空行以保住后续偏移 */
export function collectDefinitions(src: string): CompileResult {
  const lines = src.split('\n')
  const refs: RefMap = new Map()
  let fence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    const f = FENCE_LINE.exec(line)
    if (f) {
      const marker = f[1]!
      if (fence === null) fence = marker[0]!.repeat(marker.length)
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue

    const m = DEF_LINE.exec(line)
    if (!m) continue

    const label = normalizeLabel(m[1]!)
    // 每一行定义都吃掉（不管是不是重复），否则「有没有前一条同名定义」会改变
    // 这一行的消隐与否 —— 全量解析和增量窗口解析就会给出不同的 AST。
    // 用等长空白填充而不是删掉，保证所有偏移仍然指向用户的原始源码
    lines[i] = ' '.repeat(line.length)
    if (refs.has(label)) continue // 首个定义生效

    let href = m[2]!
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)
    refs.set(label, { href, title: m[3] ?? m[4] ?? m[5] ?? null })
  }

  return { text: lines.join('\n'), refs }
}

/** Markdown 源码 → AST */
export function parse(src: string): BlockNode[] {
  const normalized = src.replace(/\r\n?/g, '\n')
  const { text, refs } = collectDefinitions(normalized)
  return parseBlocks(text, refs)
}

/** Markdown 源码 → HTML（一次性路径，增量引擎走 parse + renderBlocks） */
export function render(src: string, options: RenderOptions = {}): string {
  return renderBlocks(parse(src), options)
}
