import type { RefMap } from './types'

/**
 * 词法层。
 *
 * 块级「词法」= 行切分 + 行分类（在 block-parser 里判定）。
 * 行内「词法」= 字符扫描，产出扁平的 token 流（不建树）。
 *
 * 关键点：链接 `[...](...)` 在扫描阶段整体识别，因为括号配对本身就需要
 * 前向窥视；但强调分隔符只标记 canOpen/canClose，不在这一层配对。
 */

export interface Line {
  text: string
  /** 该行在归一化源码中的起始偏移 */
  start: number
  /** 0 起始行号 */
  index: number
}

/** `base` 用于增量编译：把窗口内切出的行 / 行内位置直接抬到全文坐标系 */
export function splitLines(src: string, base?: { start: number; line: number }): Line[] {
  const offset = base?.start ?? 0
  const lineOffset = base?.line ?? 0
  const out: Line[] = []
  let start = 0
  let index = 0
  for (let i = 0; i <= src.length; i++) {
    if (i === src.length || src.charCodeAt(i) === 10) {
      out.push({ text: src.slice(start, i), start: start + offset, index: index + lineOffset })
      start = i + 1
      index++
    }
  }
  return out
}

export function isBlank(text: string): boolean {
  return text.trim() === ''
}

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/* ---------------- 字符分类 ---------------- */

const SPACE_RE = /\s/u
const PUNCT_RE = /[\p{P}\p{S}]/u

export function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || SPACE_RE.test(ch)
}

export function isPunct(ch: string | undefined): boolean {
  return ch !== undefined && PUNCT_RE.test(ch)
}

function charBefore(src: string, i: number): string | undefined {
  if (i <= 0) return undefined
  const code = src.charCodeAt(i - 1)
  if (code >= 0xdc00 && code <= 0xdfff && i >= 2) return src.slice(i - 2, i)
  return src[i - 1]
}

function charAt(src: string, i: number): string | undefined {
  if (i >= src.length) return undefined
  const code = src.charCodeAt(i)
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < src.length) return src.slice(i, i + 2)
  return src[i]
}

/**
 * CommonMark 的 flanking 规则：决定一个分隔符串能否开/闭强调。
 * `_` 额外禁止「词内强调」（snake_case_name 不算强调）。
 */
export function flanking(
  src: string,
  start: number,
  end: number,
  char: '*' | '_' | '~',
): { canOpen: boolean; canClose: boolean } {
  const prev = charBefore(src, start)
  const next = charAt(src, end)

  const prevWs = isWhitespace(prev)
  const nextWs = isWhitespace(next)
  const prevPunct = isPunct(prev)
  const nextPunct = isPunct(next)

  const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct)
  const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct)

  if (char === '_') {
    return {
      canOpen: leftFlanking && (!rightFlanking || prevPunct),
      canClose: rightFlanking && (!leftFlanking || nextPunct),
    }
  }
  return { canOpen: leftFlanking, canClose: rightFlanking }
}

/* ---------------- 行内 token ---------------- */

export type InlineToken =
  | { t: 'text'; value: string; start: number; end: number }
  | {
      t: 'delim'
      char: '*' | '_' | '~'
      count: number
      canOpen: boolean
      canClose: boolean
      start: number
      end: number
    }
  | { t: 'code'; value: string; start: number; end: number }
  | {
      t: 'link'
      href: string
      title: string | null
      innerStart: number
      innerEnd: number
      start: number
      end: number
    }
  | {
      t: 'image'
      src: string
      title: string | null
      alt: string
      start: number
      end: number
    }
  | { t: 'autolink'; href: string; label: string; start: number; end: number }
  | { t: 'rawhtml'; value: string; start: number; end: number }
  | { t: 'break'; hard: boolean; start: number; end: number }

/** 行内原始 HTML：注释，或开/闭标签 */
const INLINE_HTML = /^(?:<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\/?>)/

function findCodeClose(src: string, from: number, runLen: number): number {
  let j = from
  while (j < src.length) {
    if (src[j] === '`') {
      let m = 0
      while (src[j + m] === '`') m++
      if (m === runLen) return j
      j += m
    } else {
      j++
    }
  }
  return -1
}

/** 从 `[` 出发找配对的 `]`，跳过转义与代码段，支持嵌套方括号 */
function matchBracket(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') {
      let n = 0
      while (src[i + n] === '`') n++
      const close = findCodeClose(src, i + n, n)
      i = close < 0 ? i + n : close + n
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

interface Destination {
  href: string
  title: string | null
  end: number
}

function parseDestination(src: string, open: number): Destination | null {
  let i = open + 1
  const skipWs = () => {
    while (i < src.length && /[ \t\n]/.test(src[i]!)) i++
  }
  skipWs()

  let href = ''
  if (src[i] === '<') {
    const close = src.indexOf('>', i + 1)
    if (close < 0) return null
    href = src.slice(i + 1, close)
    i = close + 1
  } else {
    const from = i
    let depth = 0
    while (i < src.length) {
      const ch = src[i]
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        if (depth === 0) break
        depth--
      } else if (/[ \t\n]/.test(ch)) break
      i++
    }
    href = src.slice(from, i)
  }

  skipWs()

  let title: string | null = null
  const quote = src[i]
  if (quote === '"' || quote === "'" || quote === '(') {
    const closeCh = quote === '(' ? ')' : quote
    let j = i + 1
    let buf = ''
    while (j < src.length && src[j] !== closeCh) {
      if (src[j] === '\\' && j + 1 < src.length) {
        buf += src[j + 1]
        j += 2
        continue
      }
      buf += src[j]
      j++
    }
    if (j < src.length) {
      title = buf
      i = j + 1
      skipWs()
    }
  }

  if (src[i] !== ')') return null
  return { href, title, end: i + 1 }
}

interface LinkMatch {
  href: string
  title: string | null
  innerEnd: number
  end: number
}

/** `open` 指向 `[`。支持行内式与引用式（含 shortcut 形式） */
function parseLinkAt(src: string, open: number, refs: RefMap): LinkMatch | null {
  const close = matchBracket(src, open)
  if (close < 0) return null

  const inner = src.slice(open + 1, close)
  const after = close + 1

  if (src[after] === '(') {
    const dest = parseDestination(src, after)
    if (dest) return { href: dest.href, title: dest.title, innerEnd: close, end: dest.end }
  }

  let label = inner
  let end = close + 1
  if (src[after] === '[') {
    const closeRef = src.indexOf(']', after + 1)
    if (closeRef > 0) {
      const raw = src.slice(after + 1, closeRef)
      if (raw.trim() !== '') label = raw
      end = closeRef + 1
    }
  }

  const def = refs.get(normalizeLabel(label))
  if (def) return { href: def.href, title: def.title, innerEnd: close, end }
  return null
}

/** 行内扫描：产出扁平 token 流，不建树 */
export function scanInline(src: string, refs: RefMap): InlineToken[] {
  const out: InlineToken[] = []

  const pushText = (value: string, start: number, end: number) => {
    const last = out[out.length - 1]
    if (last && last.t === 'text' && last.end === start) {
      last.value += value
      last.end = end
    } else {
      out.push({ t: 'text', value, start, end })
    }
  }

  const pushBreak = (hard: boolean, start: number, end: number) => {
    const last = out[out.length - 1]
    if (last && last.t === 'text' && /[ ]+$/.test(last.value)) {
      const trailing = /[ ]+$/.exec(last.value)![0].length
      if (trailing >= 2) hard = true
      last.value = last.value.slice(0, -trailing)
    }
    out.push({ t: 'break', hard, start, end })
  }

  let i = 0
  while (i < src.length) {
    const ch = src[i]!

    if (ch === '\\') {
      const next = src[i + 1]
      if (next === '\n') {
        pushBreak(true, i, i + 2)
        i += 2
        continue
      }
      if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
        pushText(next, i, i + 2)
        i += 2
        continue
      }
      pushText('\\', i, i + 1)
      i++
      continue
    }

    if (ch === '`') {
      let n = 0
      while (src[i + n] === '`') n++
      const close = findCodeClose(src, i + n, n)
      if (close >= 0) {
        let value = src.slice(i + n, close).replace(/\n/g, ' ')
        if (value.length > 1 && value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '') {
          value = value.slice(1, -1)
        }
        out.push({ t: 'code', value, start: i, end: close + n })
        i = close + n
      } else {
        pushText('`'.repeat(n), i, i + n)
        i += n
      }
      continue
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let n = 0
      while (src[i + n] === ch) n++
      if (ch === '~' && n < 2) {
        pushText('~'.repeat(n), i, i + n)
        i += n
        continue
      }
      const f = flanking(src, i, i + n, ch)
      out.push({
        t: 'delim',
        char: ch,
        count: n,
        canOpen: f.canOpen,
        canClose: f.canClose,
        start: i,
        end: i + n,
      })
      i += n
      continue
    }

    if (ch === '<') {
      const rest = src.slice(i)
      const uri = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest)
      const email =
        uri ??
        /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(
          rest,
        )
      if (email) {
        const label = email[1]!
        const href = uri ? label : `mailto:${label}`
        out.push({ t: 'autolink', href, label, start: i, end: i + email[0].length })
        i += email[0].length
        continue
      }
      const html = INLINE_HTML.exec(rest)
      if (html) {
        out.push({ t: 'rawhtml', value: html[0], start: i, end: i + html[0].length })
        i += html[0].length
        continue
      }
      pushText('<', i, i + 1)
      i++
      continue
    }

    if (ch === '!' && src[i + 1] === '[') {
      const match = parseLinkAt(src, i + 1, refs)
      if (match) {
        out.push({
          t: 'image',
          src: match.href,
          title: match.title,
          alt: src.slice(i + 2, match.innerEnd),
          start: i,
          end: match.end,
        })
        i = match.end
        continue
      }
      pushText('!', i, i + 1)
      i++
      continue
    }

    if (ch === '[') {
      const match = parseLinkAt(src, i, refs)
      if (match) {
        out.push({
          t: 'link',
          href: match.href,
          title: match.title,
          innerStart: i + 1,
          innerEnd: match.innerEnd,
          start: i,
          end: match.end,
        })
        i = match.end
        continue
      }
      pushText('[', i, i + 1)
      i++
      continue
    }

    if (ch === '\n') {
      pushBreak(false, i, i + 1)
      i++
      continue
    }

    pushText(ch, i, i + 1)
    i++
  }

  return out
}
