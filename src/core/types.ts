/** 源码位置：偏移以字符计，end 不含；line 为 1 起始行号 */
export interface Pos {
  start: number
  end: number
  line: number
}

export type Align = 'left' | 'center' | 'right' | null

/* ---------------- 行内节点 ---------------- */

export interface TextNode extends Pos {
  type: 'text'
  value: string
}

export interface EmphNode extends Pos {
  type: 'em' | 'strong' | 'del'
  children: InlineNode[]
}

export interface CodeSpanNode extends Pos {
  type: 'code'
  value: string
}

export interface LinkNode extends Pos {
  type: 'link'
  href: string
  title: string | null
  children: InlineNode[]
}

export interface ImageNode extends Pos {
  type: 'image'
  src: string
  alt: string
  title: string | null
}

export interface BreakNode extends Pos {
  type: 'break' | 'softbreak'
}

/** 行内原始 HTML（`<kbd>`、`<br>`、`<!-- -->` 等），原样透传 */
export interface HtmlInlineNode extends Pos {
  type: 'html'
  value: string
}

export type InlineNode =
  | TextNode
  | EmphNode
  | CodeSpanNode
  | LinkNode
  | ImageNode
  | BreakNode
  | HtmlInlineNode

/* ---------------- 块级节点 ---------------- */

export interface ParagraphNode extends Pos {
  type: 'paragraph'
  children: InlineNode[]
}

export interface HeadingNode extends Pos {
  type: 'heading'
  depth: 1 | 2 | 3 | 4 | 5 | 6
  children: InlineNode[]
}

export interface CodeBlockNode extends Pos {
  type: 'code'
  lang: string | null
  value: string
  /** 围栏有闭合行 / 缩进代码恒为 true。增量引擎靠它判断「这块会不会继续吞下文」 */
  closed: boolean
}

export interface BlockquoteNode extends Pos {
  type: 'blockquote'
  children: BlockNode[]
}

export interface ListItemNode extends Pos {
  type: 'item'
  /** null = 普通列表项；false/true = 任务列表的未勾选/已勾选 */
  checked: boolean | null
  children: BlockNode[]
}

export interface ListNode extends Pos {
  type: 'list'
  ordered: boolean
  /** 有序列表的起始序号（`<ol start>`），无序列表固定为 1 */
  startNumber: number
  tight: boolean
  children: ListItemNode[]
}

export interface TableNode extends Pos {
  type: 'table'
  align: Align[]
  head: InlineNode[][]
  rows: InlineNode[][][]
}

export interface HrNode extends Pos {
  type: 'hr'
}

export interface HtmlNode extends Pos {
  type: 'html'
  value: string
  /** 由空行终止为 true；吃掉文末为 false */
  closed: boolean
}

export interface ContainerNode extends Pos {
  type: 'container'
  kind: string
  title: string | null
  children: BlockNode[]
  /** 有 `:::` 闭合行为 true */
  closed: boolean
}

export type BlockNode =
  | ParagraphNode
  | HeadingNode
  | CodeBlockNode
  | BlockquoteNode
  | ListNode
  | TableNode
  | HrNode
  | HtmlNode
  | ContainerNode

/* ---------------- 引用定义 ---------------- */

export interface RefDef {
  href: string
  title: string | null
}

export type RefMap = Map<string, RefDef>
