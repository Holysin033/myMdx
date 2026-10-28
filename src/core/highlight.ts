import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * 高亮层。
 *
 * 只按需注册语言（包里全量是 190+ 语言、约 1MB），主题色由 CSS 变量接管，
 * 所以切换主题不重跑高亮、不发请求、不闪烁。
 */

const languages = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
}

for (const [name, def] of Object.entries(languages)) hljs.registerLanguage(name, def)

const ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
}

/** 超过这个长度的代码块不做高亮：单块高亮的耗时是 O(n)，几百 KB 的块会明显掉帧 */
const MAX_HIGHLIGHT_LENGTH = 20_000

/**
 * 高亮结果缓存（LRU）。
 *
 * 为什么要它：每次按键都会重新渲染整篇 HTML，而文档里通常有大段没改过的代码块。
 * 没有缓存 = 每次按键把所有代码块重新高亮一遍（10 个块 / 几十毫秒），
 * 增量解析省下的时间会被渲染层原样花掉。
 */
const CACHE_LIMIT = 200
const cache = new Map<string, string>()

function cached(key: string, make: () => string): string {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = make()
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(key, value)
  return value
}

export function highlightCode(code: string, lang: string | null): string | null {
  if (!lang) return null
  const key = ALIAS[lang] ?? lang
  if (!hljs.getLanguage(key)) return null
  if (code.length > MAX_HIGHLIGHT_LENGTH) return null
  return cached(`${key}\u0000${code}`, () => {
    try {
      return hljs.highlight(code, { language: key, ignoreIllegals: true }).value
    } catch {
      return ''
    }
  })
}
