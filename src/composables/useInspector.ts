import { computed, ref } from 'vue'
import { scanInline, type InlineToken } from '../core/lexer'
import type { BlockNode, InlineNode, ListItemNode } from '../core/types'
import { useMarkdown } from './useMarkdown'

/**
 * 解析过程可视化：把「编译器看到了什么」摆到用户面前。
 *
 * 这三块面板不是装饰 —— 调试解析器时，缺的就是「这段源码被切成什么 token、
 * 落成了哪棵树、花了多少毫秒」。所以整个面板都是**光标驱动**的：
 * 光标落在哪个块，就展开哪个块，点任意一行能跳回源码对应位置。
 */

const MAX_ROWS = 400

const { content, ast, parseMs, renderMs, stats, refs } = useMarkdown()

const open = ref(false)
const caret = ref(0)

export interface AstRow {
  depth: number
  kind: string
  label: string
  start: number
  end: number
  line: number
  /** 点这一行时该选中的源码区间 */
  select: [number, number]
}

function clip(s: string, n = 34): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

function insertText(node: InlineNode): string {
  switch (node.type) {
    case 'text':
    case 'code':
    case 'html':
      return node.value
    case 'link':
      return node.href
    case 'em':
    case 'strong':
    case 'del':
      return node.children.map(insertText).join('')
    case 'image':
      return node.alt
    case 'break':
      return ''
    default:
      return ''
  }
}

function blockLabel(node: BlockNode | ListItemNode): string {
  switch (node.type) {
    case 'paragraph':
      return `paragraph · ${clip(node.children.map(insertText).join(''))}`
    case 'heading':
      return `heading h${node.depth} · ${clip(node.children.map(insertText).join(''))}`
    case 'code':
      return `code · ${node.lang ?? 'plain'} · ${node.value.split('\n').length} 行${node.closed ? '' : ' · 未闭合'}`
    case 'list':
      return `list · ${node.ordered ? 'ordered' : 'bullet'} · ${node.children.length} 项 · ${node.tight ? 'tight' : 'loose'}`
    case 'item':
      return `item${node.checked === null ? '' : node.checked ? ' · ☑' : ' · ☐'}`
    case 'table':
      return `table · ${node.align.length} 列 · ${node.rows.length} 行`
    case 'blockquote':
      return 'blockquote'
    case 'container':
      return `container :::${node.kind}${node.closed ? '' : ' · 未闭合'}${node.title ? ' · ' + clip(node.title, 20) : ''}`
    case 'html':
      return `html block · ${clip(node.value)}`
    case 'hr':
      return 'thematic break'
  }
}

function inlineLabel(node: InlineNode): string {
  const body = insertText(node)
  return `${node.type} · ${clip(body)}`
}

/**
 * 把 AST 摊平成「带缩进的行」而不是递归组件：
 * 一个 <ul> + padding-left 就够，省掉一个递归组件和它的 props 传参。
 */
const rows = computed<AstRow[]>(() => {
  const out: AstRow[] = []

  const row = (node: BlockNode | ListItemNode | InlineNode, depth: number, label: string): void => {
    if (out.length >= MAX_ROWS) return
    out.push({
      depth,
      kind: node.type,
      label,
      start: node.start,
      end: node.end,
      line: node.line,
      select: [node.start, node.end],
    })
  }

  const pushInline = (node: InlineNode, depth: number): void => {
    if (out.length >= MAX_ROWS) return
    row(node, depth, inlineLabel(node))
    if (node.type === 'em' || node.type === 'strong' || node.type === 'del' || node.type === 'link') {
      for (const child of node.children) pushInline(child, depth + 1)
    }
  }

  const pushBlock = (node: BlockNode | ListItemNode, depth: number): void => {
    if (out.length >= MAX_ROWS) return
    row(node, depth, blockLabel(node))
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        for (const child of node.children) pushInline(child, depth + 1)
        break
      case 'blockquote':
      case 'container':
      case 'item':
        for (const child of node.children) pushBlock(child, depth + 1)
        break
      case 'list':
        for (const item of node.children) pushBlock(item, depth + 1)
        break
      default:
        break
    }
  }

  for (const block of ast.value) pushBlock(block, 0)
  return out
})

/** 光标所在的、最内层的「行内块」（段落或标题） */
function findInlineBlock(blocks: BlockNode[], pos: number): BlockNode | null {
  const walk = (node: BlockNode | ListItemNode): BlockNode | null => {
    if (pos < node.start || pos > node.end) return null
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        return node
      case 'blockquote':
      case 'container':
      case 'item':
        for (const child of node.children) {
          const found = walk(child)
          if (found) return found
        }
        return null
      case 'list':
        for (const item of node.children) {
          const found = walk(item)
          if (found) return found
        }
        return null
      default:
        return null
    }
  }
  for (const block of blocks) {
    const found = walk(block)
    if (found) return found
  }
  return null
}

const activeBlock = computed<BlockNode | null>(() => findInlineBlock(ast.value, caret.value))

/** 光标所在块的行内 token 流（重跑一次词法，纯展示用） */
const tokens = computed<{ label: string; start: number; end: number }[]>(() => {
  const block = activeBlock.value
  if (!block || (block.type !== 'paragraph' && block.type !== 'heading')) return []
  const first = block.children[0]
  const last = block.children[block.children.length - 1]
  if (!first || !last) return []

  const slice = content.value.slice(first.start, last.end)
  const base = first.start
  return scanInline(slice, refs()).map((token: InlineToken) => ({
    label: tokenLabel(token),
    start: token.start + base,
    end: token.end + base,
  }))
})

function tokenLabel(token: InlineToken): string {
  switch (token.t) {
    case 'text':
      return `text · ${clip(token.value)}`
    case 'delim':
      return `delim ${token.char.repeat(token.count)} · ${token.canOpen ? 'open' : ''}${token.canOpen && token.canClose ? '+' : ''}${token.canClose ? 'close' : ''}`
    case 'code':
      return `code span · ${clip(token.value)}`
    case 'link':
      return `link · ${clip(token.href)}`
    case 'image':
      return `image · ${clip(token.alt)}`
    case 'autolink':
      return `autolink · ${clip(token.href)}`
    case 'rawhtml':
      return `raw html · ${clip(token.value)}`
    case 'break':
      return token.hard ? 'hard break' : 'soft break'
  }
}

export function useInspector() {
  return {
    open,
    caret,
    rows,
    tokens,
    activeBlock,
    parseMs,
    renderMs,
    stats,
    toggle: () => (open.value = !open.value),
    setCaret: (pos: number) => (caret.value = pos),
  }
}
