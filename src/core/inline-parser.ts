import { scanInline, type InlineToken } from './lexer'
import type { InlineNode, RefMap } from './types'

/**
 * 行内语法分析。
 *
 * 两层结构：
 *   1) 扫描阶段已产出扁平 token（delim 只带 canOpen/canClose，不配对）
 *   2) 本层做「最近开符配对」：从左往右遇到 closer，向左找最近的合法 opener，
 *      把中间部分包成节点再塞回数组。
 *
 * 贪心配对天然产生正确嵌套：`*a *b* c*` 先配内层 `*b*`，再配外层。
 */

interface DelimAtom {
  kind: 'delim'
  char: '*' | '_' | '~'
  count: number
  canOpen: boolean
  canClose: boolean
  start: number
  end: number
}

type Atom = InlineNode | DelimAtom

function isDelim(atom: Atom): atom is DelimAtom {
  return (atom as DelimAtom).kind === 'delim'
}

function at(start: number, end: number, base: number, line: number) {
  return { start: base + start, end: base + end, line }
}

export function parseInline(
  src: string,
  refs: RefMap,
  baseStart = 0,
  baseLine = 1,
): InlineNode[] {
  if (src === '') return []
  const atoms = scanInline(src, refs).map((tok) =>
    toAtom(tok, src, refs, baseStart, baseLine),
  )
  return resolveEmphasis(atoms, baseStart, baseLine)
}

function toAtom(
  tok: InlineToken,
  src: string,
  refs: RefMap,
  base: number,
  line: number,
): Atom {
  switch (tok.t) {
    case 'text':
      return { type: 'text', value: tok.value, ...at(tok.start, tok.end, base, line) }
    case 'code':
      return { type: 'code', value: tok.value, ...at(tok.start, tok.end, base, line) }
    case 'break':
      return {
        type: tok.hard ? 'break' : 'softbreak',
        ...at(tok.start, tok.end, base, line),
      }
    case 'link':
      return {
        type: 'link',
        href: tok.href,
        title: tok.title,
        children: parseInline(
          src.slice(tok.innerStart, tok.innerEnd),
          refs,
          base + tok.innerStart,
          line,
        ),
        ...at(tok.start, tok.end, base, line),
      }
    case 'image':
      return {
        type: 'image',
        src: tok.src,
        alt: tok.alt,
        title: tok.title,
        ...at(tok.start, tok.end, base, line),
      }
    case 'autolink':
      return {
        type: 'link',
        href: tok.href,
        title: null,
        children: [
          { type: 'text', value: tok.label, ...at(tok.start + 1, tok.end - 1, base, line) },
        ],
        ...at(tok.start, tok.end, base, line),
      }
    case 'rawhtml':
      return { type: 'html', value: tok.value, ...at(tok.start, tok.end, base, line) }
    case 'delim':
      return {
        kind: 'delim',
        char: tok.char,
        count: tok.count,
        canOpen: tok.canOpen,
        canClose: tok.canClose,
        start: tok.start,
        end: tok.end,
      }
  }
}

function resolveEmphasis(atoms: Atom[], base: number, line: number): InlineNode[] {
  let i = 0
  while (i < atoms.length) {
    const closer = atoms[i]!
    if (isDelim(closer) && closer.count > 0 && closer.canClose) {
      let openIdx = -1
      for (let k = i - 1; k >= 0; k--) {
        const cand = atoms[k]!
        if (isDelim(cand) && cand.count > 0 && cand.canOpen && cand.char === closer.char) {
          openIdx = k
          break
        }
      }
      if (openIdx >= 0) {
        const opener = atoms[openIdx] as DelimAtom
        const minCount = Math.min(opener.count, closer.count)
        const total = opener.char === '~' ? (minCount >= 2 ? 2 : 0) : minCount
        if (total > 0) {
          const children = finalize(atoms.slice(openIdx + 1, i), base, line)
          const node = buildEmphasis(
            total,
            children,
            opener.char === '~',
            at(opener.start, closer.end, base, line),
          )
          opener.count -= total
          closer.count -= total
          atoms.splice(openIdx + 1, i - openIdx - 1, node)
          i = openIdx + 1
        }
      }
    }
    i++
  }
  return finalize(atoms, base, line)
}

function buildEmphasis(
  total: number,
  children: InlineNode[],
  strike: boolean,
  p: { start: number; end: number; line: number },
): InlineNode {
  if (strike) return { type: 'del', children, ...p }

  // `***x***` → em(strong(x))，`****x****` → strong(strong(x))
  // 先成对包裹 strong（内层），余下的单个包裹 em（外层）
  let nodes = children
  const pairs = Math.floor(total / 2)
  for (let k = 0; k < pairs; k++) nodes = [{ type: 'strong', children: nodes, ...p }]
  if (total % 2 === 1) nodes = [{ type: 'em', children: nodes, ...p }]
  return nodes[0]!
}

function finalize(atoms: Atom[], base: number, line: number): InlineNode[] {
  const out: InlineNode[] = []
  for (const atom of atoms) {
    if (isDelim(atom)) {
      if (atom.count <= 0) continue
      out.push({
        type: 'text',
        value: atom.char.repeat(atom.count),
        ...at(atom.start, atom.end, base, line),
      })
      continue
    }
    if (atom.type === 'text' && atom.value === '') continue
    out.push(atom)
  }
  return out
}
