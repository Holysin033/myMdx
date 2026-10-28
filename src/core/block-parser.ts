import { isBlank, splitLines, type Line } from './lexer'
import { parseInline } from './inline-parser'
import type {
  Align,
  BlockNode,
  CodeBlockNode,
  HeadingNode,
  ListItemNode,
  ListNode,
  ParagraphNode,
  RefMap,
  TableNode,
} from './types'

/**
 * 块级语法分析。
 *
 * 采用「递归下降 + 行游标」而不是 CommonMark 的容器栈：容器（引用/列表/自定义块）
 * 由递归表达，每个容器把自己的行切片剥掉前缀后交给下一层。
 * 取舍：懒续行、极复杂的交错容器覆盖不到，换来的是代码量和可读性。
 */

const THEMATIC = /^ {0,3}(?:(?:[ \t]*\*){3,}|(?:[ \t]*-){3,}|(?:[ \t]*_){3,})[ \t]*$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
const CONTAINER = /^ {0,3}:::(\w+)?[ \t]*(.*)$/
const CONTAINER_CLOSE = /^ {0,3}:::[ \t]*$/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const INDENTED = /^(?: {4}|\t)/
const BLOCKQUOTE = /^ {0,3}> ?(.*)$/
const TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/**
 * HTML 块只在这些情况下开启（对齐 CommonMark 条件 1~6）：
 * script/pre/style/textarea、注释、处理指令、声明、CDATA、块级标签。
 * 条件 7（一行一个完整标签）没做 —— 收益低，且会误吞 `<kbd>x</kbd>` 这类行内用法。
 */
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
const HTML_START = new RegExp(
  `^ {0,3}(?:<(?:script|pre|style|textarea)(?:[ \\t>]|$)|<!--|<\\?|<![A-Z]|<!\\[CDATA\\[|</?(?:${BLOCK_TAGS})(?:[ \\t]|/?>|$))`,
  'i',
)

interface Block {
  node: BlockNode
  next: number
}

export function parseBlocks(
  src: string,
  refs: RefMap,
  base?: { start: number; line: number },
): BlockNode[] {
  return parseLines(splitLines(src, base), refs)
}

function parseLines(lines: Line[], refs: RefMap): BlockNode[] {
  const out: BlockNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const text = line.text
    if (isBlank(text)) {
      i++
      continue
    }

    const fence = FENCE.exec(text)
    if (fence) {
      const r = readFence(lines, i, fence)
      out.push(r.node)
      i = r.next
      continue
    }

    const container = CONTAINER.exec(text)
    if (container) {
      const r = readContainer(lines, i, container, refs)
      out.push(r.node)
      i = r.next
      continue
    }

    const atx = ATX.exec(text)
    if (atx) {
      const raw = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
      const node: HeadingNode = {
        type: 'heading',
        depth: atx[1]!.length as HeadingNode['depth'],
        children: parseInline(raw, refs, line.start, line.index + 1),
        start: line.start,
        end: line.start + text.length,
        line: line.index + 1,
      }
      out.push(node)
      i++
      continue
    }

    if (THEMATIC.test(text)) {
      out.push({ type: 'hr', start: line.start, end: line.start + text.length, line: line.index + 1 })
      i++
      continue
    }

    if (BLOCKQUOTE.test(text)) {
      const r = readBlockquote(lines, i, refs)
      out.push(r.node)
      i = r.next
      continue
    }

    const item = ITEM.exec(text)
    if (item) {
      const r = readList(lines, i, refs)
      out.push(r.node)
      i = r.next
      continue
    }

    if (INDENTED.test(text)) {
      const r = readIndentedCode(lines, i)
      out.push(r.node)
      i = r.next
      continue
    }

    const table = tryTable(lines, i, refs)
    if (table) {
      out.push(table.node)
      i = table.next
      continue
    }

    if (HTML_START.test(text)) {
      const r = readHtmlBlock(lines, i)
      out.push(r.node)
      i = r.next
      continue
    }

    const para = readParagraph(lines, i, refs)
    out.push(para.node)
    i = para.next
  }

  return out
}

/* ---------------- 围栏代码 ---------------- */

function readFence(lines: Line[], i: number, m: RegExpExecArray): Block {
  const line = lines[i]!
  const fenceChar = m[1]![0]!
  const fenceLen = m[1]!.length
  const info = (m[2] ?? '').trim()
  const lang = info ? info.split(/\s+/)[0]! : null

  const esc = fenceChar === '`' ? '`' : '~'
  const closeRe = new RegExp(`^ {0,3}${esc}{${fenceLen},}[ \\t]*$`)

  const body: string[] = []
  let j = i + 1
  while (j < lines.length && !closeRe.test(lines[j]!.text)) {
    body.push(lines[j]!.text)
    j++
  }
  const closed = j < lines.length

  const last = lines[Math.min(j, lines.length - 1)]!
  const node: CodeBlockNode = {
    type: 'code',
    lang,
    value: body.join('\n'),
    closed,
    start: line.start,
    end: last.start + last.text.length,
    line: line.index + 1,
  }
  return { node, next: j + 1 }
}

/* ---------------- 自定义容器 ::: note ---------------- */

function readContainer(
  lines: Line[],
  i: number,
  m: RegExpExecArray,
  refs: RefMap,
): Block {
  const line = lines[i]!
  const kind = m[1] ?? 'note'
  const title = (m[2] ?? '').trim() || null

  const body: Line[] = []
  let closed = false
  let j = i + 1
  while (j < lines.length) {
    if (CONTAINER_CLOSE.test(lines[j]!.text)) {
      closed = true
      j++
      break
    }
    body.push(lines[j]!)
    j++
  }

  const last = lines[Math.min(j, lines.length) - 1]!
  return {
    node: {
      type: 'container',
      kind,
      title,
      children: parseLines(body, refs),
      closed,
      start: line.start,
      end: last.start + last.text.length,
      line: line.index + 1,
    },
    next: j,
  }
}

/* ---------------- 引用 ---------------- */

function readBlockquote(lines: Line[], i: number, refs: RefMap): Block {
  const body: Line[] = []
  let j = i
  while (j < lines.length) {
    const line = lines[j]!
    const m = BLOCKQUOTE.exec(line.text)
    if (!m) break
    const inner = m[1]!
    body.push({
      text: inner,
      start: line.start + (line.text.length - inner.length),
      index: line.index,
    })
    j++
  }

  const first = lines[i]!
  const last = lines[j - 1]!
  return {
    node: {
      type: 'blockquote',
      children: parseLines(body, refs),
      start: first.start,
      end: last.start + last.text.length,
      line: first.index + 1,
    },
    next: j,
  }
}

/* ---------------- 列表 ---------------- */

function leadingIndent(text: string): number {
  let n = 0
  for (const ch of text) {
    if (ch === ' ') n++
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

function stripIndent(line: Line, width: number): Line {
  let removed = 0
  let k = 0
  while (k < line.text.length && removed < width) {
    const ch = line.text[k]!
    if (ch === ' ') {
      removed++
      k++
    } else if (ch === '\t') {
      removed += 4
      k++
    } else break
  }
  return { text: line.text.slice(k), start: line.start + k, index: line.index }
}

function startsBlock(text: string): boolean {
  return (
    FENCE.test(text) ||
    ATX.test(text) ||
    THEMATIC.test(text) ||
    BLOCKQUOTE.test(text) ||
    CONTAINER.test(text)
  )
}

/** 末尾的空行不计入块的 end —— 否则窗口解析与全量解析在边界上会差几格 */
function lastNonBlank(lines: Line[], from: number, to: number): Line {
  let k = to - 1
  while (k > from && isBlank(lines[k]!.text)) k--
  return lines[k]!
}

function readList(lines: Line[], i: number, refs: RefMap): Block {
  const first = ITEM.exec(lines[i]!.text)!
  const ordered = /^\d/.test(first[2]!)
  const bulletChar = ordered ? null : first[2]![0]!
  const startNum = ordered ? parseInt(first[2]!, 10) : 1
  const leadIndent = first[1]!.length

  const items: ListItemNode[] = []
  let tight = true
  let j = i

  while (j < lines.length) {
    const m = ITEM.exec(lines[j]!.text)
    if (!m) break
    if (m[1]!.length !== leadIndent) break
    const isOrdered = /^\d/.test(m[2]!)
    if (isOrdered !== ordered) break
    if (!ordered && m[2]![0] !== bulletChar) break

    const markerLen = m[2]!.length
    const spaceLen = m[3]!.length
    const pad = spaceLen >= 1 && spaceLen <= 4 ? spaceLen : 1
    const contentIndent = leadIndent + markerLen + pad
    const headLine = lines[j]!

    const itemLines: Line[] = []
    const firstContent = headLine.text.slice(contentIndent)
    if (firstContent.trim() !== '') {
      itemLines.push({
        text: firstContent,
        start: headLine.start + contentIndent,
        index: headLine.index,
      })
    }
    const itemStart = headLine.start

    let k = j + 1
    let blanks = 0
    while (k < lines.length) {
      const text = lines[k]!.text
      if (isBlank(text)) {
        blanks++
        k++
        continue
      }
      if (leadingIndent(text) >= contentIndent) {
        if (blanks > 0) {
          tight = false
          for (let b = 0; b < blanks; b++) {
            itemLines.push({ text: '', start: lines[k]!.start, index: lines[k]!.index })
          }
          blanks = 0
        }
        itemLines.push(stripIndent(lines[k]!, contentIndent))
        k++
        continue
      }
      // 缩进不足：段落懒续行，或遇到同级列表 / 新块
      if (blanks === 0 && !startsBlock(text) && !ITEM.test(text)) {
        itemLines.push({ text, start: lines[k]!.start, index: lines[k].index })
        k++
        continue
      }
      break
    }

    const nextLine = lines[k]
    if (blanks > 0 && nextLine) {
      // 只有「同一张列表里的下一项」才让列表变 loose；
      // 紧挨着一串不同类型的列表，空行不算它们的
      const nm = ITEM.exec(nextLine.text)
      if (
        nm &&
        nm[1]!.length === leadIndent &&
        /^\d/.test(nm[2]!) === ordered &&
        (ordered || nm[2]![0] === bulletChar)
      ) {
        tight = false
      }
    }

    const children = parseLines(itemLines, refs)
    let checked: boolean | null = null
    if (children[0]?.type === 'paragraph') {
      const head = children[0].children[0]
      if (head?.type === 'text') {
        const task = /^\[([ xX])\][ \t]+/.exec(head.value)
        if (task) {
          checked = task[1] !== ' '
          const rest = head.value.slice(task[0].length)
          if (rest === '') children[0].children.shift()
          else head.value = rest
        }
      }
    }

    const lastLine = lastNonBlank(lines, j, k)
    items.push({
      type: 'item',
      checked,
      children,
      start: itemStart,
      end: lastLine.start + lastLine.text.length,
      line: headLine.index + 1,
    })

    j = k
  }

  const firstLine = lines[i]!
  const lastLine = lastNonBlank(lines, i, j)
  const node: ListNode = {
    type: 'list',
    ordered,
    startNumber: startNum,
    tight,
    children: items,
    start: firstLine.start,
    end: lastLine.start + lastLine.text.length,
    line: firstLine.index + 1,
  }
  return { node, next: j }
}

/* ---------------- 缩进代码 ---------------- */

function readIndentedCode(lines: Line[], i: number): Block {
  const body: string[] = []
  let j = i
  while (j < lines.length) {
    const text = lines[j]!.text
    if (isBlank(text)) {
      body.push('')
      j++
      continue
    }
    if (!INDENTED.test(text)) break
    body.push(text.replace(/^ {4}/, '').replace(/^\t/, ''))
    j++
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()

  const last = lines[Math.max(i, j - 1)]!
  return {
    node: {
      type: 'code',
      lang: null,
      value: body.join('\n'),
      closed: true,
      start: lines[i]!.start,
      end: last.start + last.text.length,
      line: lines[i]!.index + 1,
    },
    next: j,
  }
}

/* ---------------- 表格 ---------------- */

function splitRow(text: string): string[] {
  let s = text.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)

  const cells: string[] = []
  let buf = ''
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]!
    if (ch === '\\' && k + 1 < s.length) {
      buf += ch + s[k + 1]
      k++
      continue
    }
    if (ch === '|') {
      cells.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

function parseAlign(cell: string): Align {
  const t = cell.trim()
  if (!/^:?-+:?$/.test(t)) return null
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return null
}

function tryTable(lines: Line[], i: number, refs: RefMap): Block | null {
  const headLine = lines[i]!
  const delimLine = lines[i + 1]
  if (!delimLine) return null
  if (!headLine.text.includes('|') && !delimLine.text.includes('|')) return null
  if (!delimLine.text.includes('-')) return null
  if (!TABLE_DELIM.test(delimLine.text)) return null

  const headCells = splitRow(headLine.text)
  const delimCells = splitRow(delimLine.text)
  if (headCells.length !== delimCells.length) return null

  const align = delimCells.map(parseAlign)

  const rows: TableNode['rows'] = []
  let j = i + 2
  while (j < lines.length) {
    const text = lines[j]!.text
    if (isBlank(text) || !text.includes('|')) break
    const cells = splitRow(text)
    const norm: string[] = []
    for (let c = 0; c < headCells.length; c++) norm.push(cells[c] ?? '')
    rows.push(norm.map((cell) => parseInline(cell, refs, lines[j]!.start, lines[j]!.index + 1)))
    j++
  }

  const last = lines[Math.max(i, j - 1)]!
  return {
    node: {
      type: 'table',
      align,
      head: headCells.map((cell) => parseInline(cell, refs, headLine.start, headLine.index + 1)),
      rows,
      start: headLine.start,
      end: last.start + last.text.length,
      line: headLine.index + 1,
    },
    next: j,
  }
}

/* ---------------- HTML 块 ---------------- */

function readHtmlBlock(lines: Line[], i: number): Block {
  const body: string[] = []
  let j = i
  while (j < lines.length && !isBlank(lines[j]!.text)) {
    body.push(lines[j]!.text)
    j++
  }
  const last = lines[j - 1]!
  return {
    node: {
      type: 'html',
      value: body.join('\n'),
      closed: j < lines.length,
      start: lines[i]!.start,
      end: last.start + last.text.length,
      line: lines[i]!.index + 1,
    },
    next: j,
  }
}

/* ---------------- 段落 / Setext 标题 ---------------- */

function interrupts(text: string, next: string | undefined): boolean {
  if (FENCE.test(text) || ATX.test(text) || THEMATIC.test(text)) return true
  if (BLOCKQUOTE.test(text) || CONTAINER.test(text)) return true
  const m = ITEM.exec(text)
  if (m) {
    if (!/^\d/.test(m[2]!)) return true
    return parseInt(m[2]!, 10) === 1
  }
  if (next !== undefined && text.includes('|') && TABLE_DELIM.test(next)) return true
  return false
}

function readParagraph(lines: Line[], i: number, refs: RefMap): Block {
  const first = lines[i]!
  const buf: string[] = []
  let j = i

  while (j < lines.length) {
    const text = lines[j]!.text
    if (isBlank(text)) break

    if (j > i) {
      const setext = SETEXT.exec(text)
      if (setext && buf.length > 0) {
        const content = buf.join('\n')
        const node: HeadingNode = {
          type: 'heading',
          depth: setext[1]!.startsWith('=') ? 1 : 2,
          children: parseInline(content, refs, first.start, first.index + 1),
          start: first.start,
          end: lines[j]!.start + text.length,
          line: first.index + 1,
        }
        return { node, next: j + 1 }
      }
      if (interrupts(text, lines[j + 1]?.text)) break
    }

    buf.push(text)
    j++
  }

  const last = lines[j - 1]!
  const node: ParagraphNode = {
    type: 'paragraph',
    children: parseInline(buf.join('\n'), refs, first.start, first.index + 1),
    start: first.start,
    end: last.start + last.text.length,
    line: first.index + 1,
  }
  return { node, next: j }
}
