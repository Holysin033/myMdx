import { describe, expect, it } from 'vitest'
import { highlightCode } from '../src/core/highlight'

describe('高亮层', () => {
  it('已知语言产出 token 化 HTML，未知语言返回 null', () => {
    const out = highlightCode('const a = 1', 'ts')
    expect(out).toContain('hljs-keyword')
    expect(highlightCode('const a = 1', 'brainfuck')).toBeNull()
    expect(highlightCode('const a = 1', null)).toBeNull()
  })

  it('缓存命中返回同一份结果（等同直接高亮）', () => {
    const code = 'fn main() { println!("hi") }'
    const a = highlightCode(code, 'rust')
    const b = highlightCode(code, 'rust')
    expect(b).toBe(a)
    expect(a).toContain('hljs-')
  })

  it('超长代码块放弃高亮', () => {
    expect(highlightCode('a'.repeat(20_001), 'js')).toBeNull()
  })
})
