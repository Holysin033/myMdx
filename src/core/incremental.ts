import { parseBlocks } from './block-parser'
import { collectDefinitions } from './index'
import type { BlockNode, InlineNode, ListItemNode, RefMap } from './types'

/**
 * 块级增量编译。
 *
 * 思路：只重解析「脏窗口」，其余顶层块直接复用上一次的 AST 节点。
 *
 *   1. 前缀/后缀扫描找出变更区间（不引 diff 库，两次 charCodeAt 循环就够）
 *   2. 用变更区间定位受影响的顶层块，**前后各带一块守卫块**
 *   3. 把窗口切出来独立解析（容器栈为空，所以等价于全量解析该区间）
 *   4. 拼接：前段复用 + 新解析 + 后段复用
 *
 * 三个必须回退全量的情况：
 *   - 引用定义集合变化（`[label]: url` 是全篇语义）
 *   - 窗口末尾是未闭合的围栏/容器/HTML 块（它会继续吞掉后面的块，窗口不够大）
 *   - 增长超过上限（防御性）
 *
 * 守卫块为什么必要：`---` 会把上一段变成 setext 标题、去掉空行会让两个块合并，
 * 这些跨块影响只发生在边界的一格之内 —— 各带一块就够，带两块是浪费。
 */

export interface CompileStats {
  mode: 'full' | 'incremental'
  /** 复用的顶层块数 */
  reused: number
  /** 重新解析出的顶层块数 */
  reparsed: number
  /** 本次实际解析的字符数 */
  windowChars: number
}

const MAX_GROW = 16

/** 窗口里有没有「引用定义行」——决定要不要退回全篇扫描 */
const DEF_LOOKS = /^ {0,3}\[[^\]\n]+\]:/m

function isLeaky(block: BlockNode): boolean {
  if (block.type === 'code' || block.type === 'container' || block.type === 'html') {
    return !block.closed
  }
  return false
}

function refSignature(refs: RefMap): string {
  let out = ''
  for (const [label, def] of refs) out += `${label}\u0000${def.href}\u0000${def.title ?? ''}\u0001`
  return out
}

/**
 * 复用块的位置是「上一次」的坐标，而本次编辑改变了它前面文本的长度。
 * 原地平移复用部分的 start/end/line —— 比重新解析便宜得多，也省掉一次分配。
 */
function shiftInline(node: InlineNode, d: number, dl: number): void {
  node.start += d
  node.end += d
  node.line += dl
  if (node.type === 'em' || node.type === 'strong' || node.type === 'del' || node.type === 'link') {
    for (const child of node.children) shiftInline(child, d, dl)
  }
}

function shiftBlock(node: BlockNode | ListItemNode, d: number, dl: number): void {
  node.start += d
  node.end += d
  node.line += dl
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      for (const child of node.children) shiftInline(child, d, dl)
      break
    case 'blockquote':
    case 'container':
      for (const child of node.children) shiftBlock(child, d, dl)
      break
    case 'list':
      for (const item of node.children) shiftBlock(item, d, dl)
      break
    case 'item':
      for (const child of node.children) shiftBlock(child, d, dl)
      break
    case 'table':
      for (const cell of node.head) for (const child of cell) shiftInline(child, d, dl)
      for (const row of node.rows) for (const cell of row) for (const child of cell) shiftInline(child, d, dl)
      break
    default:
      break
  }
}

function countNewlines(src: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

export class IncrementalCompiler {
  private text = ''
  private blocks: BlockNode[] = []
  private refs: RefMap = new Map()
  private stats: CompileStats = { mode: 'full', reused: 0, reparsed: 0, windowChars: 0 }

  get lastStats(): CompileStats {
    return this.stats
  }

  /** 上一次全量扫描得到的引用定义表（Inspector 里重跑行内词法要用） */
  get lastRefs(): RefMap {
    return this.refs
  }

  get blockCount(): number {
    return this.blocks.length
  }

  parse(source: string): BlockNode[] {
    const next = source.includes('\r') ? source.replace(/\r\n?/g, '\n') : source
    if (next === this.text && this.blocks.length > 0) return this.blocks

    const prev = this.text
    if (this.blocks.length === 0) return this.fullParse(next)

    /* ---- 变更区间 ---- */
    const limit = Math.min(prev.length, next.length)
    let head = 0
    while (head < limit && prev.charCodeAt(head) === next.charCodeAt(head)) head++

    let tail = 0
    while (
      tail < limit - head &&
      prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
    ) {
      tail++
    }

    const oldStart = head
    const oldEnd = prev.length - tail
    const delta = next.length - prev.length

    /* ---- 脏窗口（含前后守卫块）---- */
    const blocks = this.blocks
    let first = blocks.findIndex((b) => b.end >= oldStart)
    if (first < 0) first = blocks.length
    first = Math.max(0, first - 1)

    const boundaryAfter = (k: number): number =>
      k + 1 < blocks.length ? blocks[k + 1]!.start : prev.length

    let last = -1
    for (let k = 0; k < blocks.length; k++) if (blocks[k]!.start <= oldEnd) last = k
    last = Math.min(blocks.length - 1, last + 1)
    if (last < first) last = first

    const regionStart = blocks[first]!.start
    // 窗口首行的绝对行号（0 起始），直接借用 AST 里已有的行号，省一次 O(n) 数换行
    const regionLine = blocks[first]!.line - 1
    // 窗口末端取「下一块的起点」，把守卫块后面的空行也包进来：
    // 列表的 tight/loose 正是由块后面的空行决定的，切在块尾会算错
    let regionEndOld = boundaryAfter(last)
    let regionEndNew = Math.min(next.length, regionEndOld + delta)

    /* ---- 解析窗口，遇到「会吞下文」的未闭合块就向右生长 ---- */
    let parsed: BlockNode[] = []
    let windowChars = 0
    let growth = 0

    for (;;) {
      const oldWindow = prev.slice(regionStart, Math.min(regionEndOld, prev.length))
      const newWindow = next.slice(regionStart, regionEndNew)

      // 引用定义行要不要消隐，只有全篇语境知道（它可能躺在某个围栏里），
      // 窗口自己扫会得出相反结论。所以窗口里只要碰到定义行就退回全篇扫描；
      // 慢路径也只在这时候走 —— 普通打字根本碰不到它。
      let windowText = newWindow
      if (DEF_LOOKS.test(newWindow) || DEF_LOOKS.test(oldWindow)) {
        const global = collectDefinitions(next)
        if (refSignature(global.refs) !== refSignature(this.refs)) return this.fullParse(next)
        // 消隐用等长空格填充，偏移与原文一一对应，可以直接按绝对坐标切
        windowText = global.text.slice(regionStart, regionEndNew)
      }

      parsed = parseBlocks(windowText, this.refs, { start: regionStart, line: regionLine })
      windowChars = windowText.length

      const lastParsed = parsed[parsed.length - 1]
      // 窗口必须「停在空行之后」才算自足：删掉一个空行会让窗口里最后一块
      // 继续吃掉后面复用块的开头，此时窗口切在段落中间，必须再长一格
      const terminated = regionEndNew >= next.length || /\n[ \t]*\n$/.test(windowText)
      if (terminated && (!lastParsed || !isLeaky(lastParsed))) break

      growth++
      if (growth > MAX_GROW) return this.fullParse(next)

      if (last + 1 < blocks.length) {
        last++
        regionEndOld = boundaryAfter(last)
        regionEndNew = Math.min(next.length, regionEndOld + delta)
      } else if (regionEndNew < next.length) {
        regionEndOld = prev.length
        regionEndNew = next.length
      } else {
        break
      }
    }

    const kept = blocks.slice(0, first)
    const tailBlocks = blocks.slice(last + 1)

    // 复用块在编辑点之后：整体平移，位置才与全量解析一致
    const lineDelta =
      countNewlines(next, regionStart, regionEndNew) -
      countNewlines(prev, regionStart, Math.min(regionEndOld, prev.length))
    for (const block of tailBlocks) shiftBlock(block, delta, lineDelta)

    this.text = next
    this.blocks = kept.concat(parsed, tailBlocks)
    this.stats = {
      mode: 'incremental',
      reused: kept.length + tailBlocks.length,
      reparsed: parsed.length,
      windowChars,
    }
    return this.blocks
  }

  reset(): void {
    this.text = ''
    this.blocks = []
    this.refs = new Map()
    this.stats = { mode: 'full', reused: 0, reparsed: 0, windowChars: 0 }
  }

  private fullParse(next: string): BlockNode[] {
    const { text, refs } = collectDefinitions(next)
    this.text = next
    this.refs = refs
    this.blocks = parseBlocks(text, refs)
    this.stats = {
      mode: 'full',
      reused: 0,
      reparsed: this.blocks.length,
      windowChars: next.length,
    }
    return this.blocks
  }
}
