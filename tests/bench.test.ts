import { it } from 'vitest'
import { parse, renderBlocks } from '../src/core'
import { IncrementalCompiler } from '../src/core/incremental'

/**
 * 性能对照：全量 vs 增量。
 *
 * 只在需要出数字时跑：`$env:BENCH=1; npx vitest run tests/bench.test.ts`
 * 其余时候直接返回，避免给日常测试加噪音。
 */

function doc(size: number): string {
  const para = (i: number) =>
    `## 第 ${i} 节\n\n这是**第 ${i} 段**内容，带 [链接](https://example.com/${i}) 和 \`行内代码\`。\n\n- 项目 a\n- 项目 b\n\n| 列 | 值 |\n| :-- | --: |\n| x | ${i} |\n\n`
  let out = ''
  for (let i = 0; out.length < size; i++) out += para(i)
  return out.slice(0, out.lastIndexOf('\n'))
}

function run(label: string, size: number): void {
  const text = doc(size)

  const t0 = performance.now()
  for (let i = 0; i < 5; i++) parse(text)
  const full = (performance.now() - t0) / 5

  const compiler = new IncrementalCompiler()
  compiler.parse(text)
  const mid = text.length >> 1

  const t1 = performance.now()
  for (let i = 0; i < 50; i++) compiler.parse(text.slice(0, mid + i) + 'x' + text.slice(mid + i))
  const inc = (performance.now() - t1) / 50

  const blocks = compiler.parse(text)
  const t2 = performance.now()
  renderBlocks(blocks)
  const render = performance.now() - t2

  console.log(
    `${label} ${(text.length / 1024).toFixed(0)}KB | ${compiler.blockCount} 块 | 全量 ${full.toFixed(2)}ms | 增量 ${inc.toFixed(2)}ms | ${(full / inc).toFixed(1)}x | 渲染 ${render.toFixed(1)}ms | ${JSON.stringify(compiler.lastStats)}`,
  )
}

it('benchmark', () => {
  if (!(globalThis as any).process?.env?.BENCH) return
  for (const size of [10_000, 50_000, 100_000, 300_000]) run('doc', size)
}, 120_000)
