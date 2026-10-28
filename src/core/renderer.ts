import type {
  Align,
  BlockNode,
  InlineNode,
  ListNode,
  TableNode,
} from './types'

/**
 * 渲染层：AST → HTML 字符串。
 *
 * 只做「拼字符串」，不碰 DOM，所以能在 Web Worker 里跑、能单测、能被缓存。
 * 高亮通过 options.highlight 注入，保持本文件无外部依赖。
 */

export interface RenderOptions {
  /** 返回高亮后的 HTML；返回 null 表示退化为纯文本转义 */
  highlight?: (code: string, lang: string | null) => string | null
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

export function esc(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESC_MAP[ch]!)
}

/** 拦截 javascript:/vbscript:/file: 与危险 data: 协议 */
function safeUrl(url: string): string {
  const compact = url.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  if (/^(?:javascript|vbscript|file):/.test(compact)) return ''
  if (/^data:/.test(compact) && !/^data:image\/(?:png|jpe?g|gif|webp|avif);/.test(compact)) {
    return ''
  }
  return esc(url.trim())
}

/* ---------------- 行内 ---------------- */

export function renderInline(nodes: InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += esc(node.value)
        break
      case 'em':
        out += `<em>${renderInline(node.children)}</em>`
        break
      case 'strong':
        out += `<strong>${renderInline(node.children)}</strong>`
        break
      case 'del':
        out += `<del>${renderInline(node.children)}</del>`
        break
      case 'code':
        out += `<code>${esc(node.value)}</code>`
        break
      case 'link': {
        const title = node.title ? ` title="${esc(node.title)}"` : ''
        out += `<a href="${safeUrl(node.href)}"${title}>${renderInline(node.children)}</a>`
        break
      }
      case 'image': {
        const title = node.title ? ` title="${esc(node.title)}"` : ''
        out += `<img src="${safeUrl(node.src)}" alt="${esc(node.alt)}"${title}>`
        break
      }
      case 'break':
        out += '<br>\n'
        break
      case 'softbreak':
        out += '\n'
        break
      case 'html':
        out += node.value
        break
    }
  }
  return out
}

/* ---------------- 块级 ---------------- */

export function renderBlocks(blocks: BlockNode[], options: RenderOptions = {}): string {
  return blocks.map((block) => renderBlock(block, false, options)).join('')
}

function renderBlock(block: BlockNode, tight: boolean, options: RenderOptions): string {
  switch (block.type) {
    case 'paragraph':
      return tight ? renderInline(block.children) : `<p>${renderInline(block.children)}</p>`

    case 'heading':
      return `<h${block.depth}>${renderInline(block.children)}</h${block.depth}>`

    case 'code': {
      const langClass = block.lang ? ` class="language-${esc(block.lang)}"` : ''
      const inner = options.highlight?.(block.value, block.lang) ?? esc(block.value)
      return `<pre><code${langClass}>${inner}</code></pre>`
    }

    case 'blockquote':
      return `<blockquote>${renderBlocks(block.children, options)}</blockquote>`

    case 'list':
      return renderList(block, options)

    case 'table':
      return renderTable(block)

    case 'hr':
      return '<hr>'

    case 'html':
      // 本地编辑器，允许内嵌 HTML（用户自己写的内容）
      return block.value

    case 'container': {
      const kind = esc(block.kind)
      const title = block.title
        ? `<div class="md-container-title">${esc(block.title)}</div>`
        : ''
      return `<div class="md-container md-container-${kind}">${title}${renderBlocks(
        block.children,
        options,
      )}</div>`
    }
  }
}

function renderList(node: ListNode, options: RenderOptions): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const startAttr = node.ordered && node.startNumber !== 1 ? ` start="${node.startNumber}"` : ''

  let items = ''
  for (const item of node.children) {
    const body = item.children
      .map((child) => renderBlock(child, node.tight, options))
      .join('')
    if (item.checked === null) {
      items += `<li>${body}</li>`
    } else {
      const checked = item.checked ? ' checked' : ''
      items += `<li class="task-list-item"><input type="checkbox" disabled${checked}> ${body}</li>`
    }
  }

  return `<${tag}${startAttr}>${items}</${tag}>`
}

function alignStyle(align: Align): string {
  return align ? ` style="text-align: ${align}"` : ''
}

function renderTable(node: TableNode): string {
  let head = '<thead><tr>'
  node.head.forEach((cell, i) => {
    head += `<th${alignStyle(node.align[i] ?? null)}>${renderInline(cell)}</th>`
  })
  head += '</tr></thead>'

  let body = ''
  if (node.rows.length > 0) {
    body = '<tbody>'
    for (const row of node.rows) {
      body += '<tr>'
      row.forEach((cell, i) => {
        body += `<td${alignStyle(node.align[i] ?? null)}>${renderInline(cell)}</td>`
      })
      body += '</tr>'
    }
    body += '</tbody>'
  }

  return `<table>${head}${body}</table>`
}
