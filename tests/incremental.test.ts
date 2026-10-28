import { describe, expect, it } from 'vitest'
import { IncrementalCompiler } from '../src/core/incremental'
import { parse } from '../src/core/index'

/* 确定性 PRNG，失败可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = [
  '# 标题一\n',
  '## 标题二\n',
  '普通段落，含 **粗体** 与 *斜体*。\n',
  'Setext 标题\n===\n',
  '- 项目 a\n- 项目 b\n',
  '1. 第一\n2. 第二\n',
  '- [ ] 待办\n- [x] 完成\n',
  '> 引用一段\n> 第二行\n',
  '```js\nconst a = 1\n```\n',
  '```\n未闭合的围栏\n',
  '| a | b |\n| :-- | --: |\n| 1 | 2 |\n',
  '---\n',
  ':::note 提示\n容器内容\n:::\n',
  ':::warning\n未闭合容器\n',
  '[ref]: https://example.com "标题"\n',
  '行内 `code` 与 [链接](https://a.dev) 与 ![图](x.png)。\n',
  '<div>\nhtml 块\n</div>\n',
  '文字 <kbd>Ctrl</kbd> 与 <https://a.dev>\n',
  '末尾一段没有换行',
]

function build(rand: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(PIECES[Math.floor(rand() * PIECES.length)]!)
  return out.join('\n')
}

/** 随机做一次编辑：插入 / 删除 / 替换，都落在字符边界上 */
function mutate(doc: string, rand: () => number): string {
  const at = Math.floor(rand() * (doc.length + 1))
  const kind = rand()
  if (kind < 0.4 || doc.length === 0) {
    const piece = PIECES[Math.floor(rand() * PIECES.length)]!
    const cut = Math.floor(rand() * piece.length)
    return doc.slice(0, at) + piece.slice(0, cut) + doc.slice(at)
  }
  if (kind < 0.75) {
    const len = 1 + Math.floor(rand() * 8)
    return doc.slice(0, at) + doc.slice(Math.min(doc.length, at + len))
  }
  const len = 1 + Math.floor(rand() * 6)
  const piece = PIECES[Math.floor(rand() * PIECES.length)]!
  return doc.slice(0, at) + piece + doc.slice(Math.min(doc.length, at + len))
}

/** 等价性核心断言：增量结果必须和全量逐字节一致（位置信息也一起比） */
function expectEqual(doc: string, compiler: IncrementalCompiler, label: string): void {
  const inc = compiler.parse(doc)
  const full = parse(doc)
  // 逐块比对，出错时报「第几块不同」而不是甩两坨 20KB 的 JSON
  const n = Math.max(inc.length, full.length)
  for (let i = 0; i < n; i++) {
    const a = JSON.stringify(inc[i])
    const b = JSON.stringify(full[i])
    if (a !== b) {
      throw new Error(
        `${label}：第 ${i} 块不同（增量 ${inc.length} 块 / 全量 ${full.length} 块）\n` +
          `增量: ${a?.slice(0, 400)}\n全量: ${b?.slice(0, 400)}\n源码:\n${doc}`,
      )
    }
  }
}

describe('增量编译等价性', () => {
  it('随机编辑 2000 轮，增量结果始终等于全量解析', () => {
    const rand = rng(20261027)
    const compiler = new IncrementalCompiler()
    let doc = build(rand, 5)
    expectEqual(doc, compiler, '初始')

    for (let i = 0; i < 2000; i++) {
      doc = mutate(doc, rand)
      expectEqual(doc, compiler, `第 ${i + 1} 轮`)
    }
  }, 60_000)

  it('只在段落里插入字符时，复用的块数应当明显多于重解析的块数', () => {
    const compiler = new IncrementalCompiler()
    const doc = Array.from({ length: 40 }, (_, i) => `第 ${i} 段内容。`).join('\n\n') + '\n'
    compiler.parse(doc)

    const at = doc.indexOf('第 20 段') + 4
    const next = doc.slice(0, at) + '加' + doc.slice(at)
    compiler.parse(next)

    const stats = compiler.lastStats
    expect(stats.mode).toBe('incremental')
    expect(stats.reused).toBeGreaterThan(stats.reparsed * 5)
    expect(stats.windowChars).toBeLessThan(next.length)
    expect(compiler.parse(next)).toBe(compiler.parse(next)) // 同文本直接命中缓存
  })

  it('引用定义变化退回全量解析', () => {
    const compiler = new IncrementalCompiler()
    const doc = '见 [a]。\n\n[a]: https://a.dev\n'
    compiler.parse(doc)
    compiler.parse(doc + '\n新段落\n')
    expect(compiler.lastStats.mode).toBe('incremental')

    compiler.parse(doc + '\n新段落\n[b]: https://b.dev\n')
    expect(compiler.lastStats.mode).toBe('full')
  })

  it('未闭合围栏向右生长后仍与全量一致', () => {
    const rand = rng(99)
    const compiler = new IncrementalCompiler()
    const doc = build(rand, 4) + '\n```js\n代码\n'
    compiler.parse(doc)
    expectEqual(doc + '更多代码\n```\n\n后面一段\n', compiler, '补上闭合围栏')
  })
})
