import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { render } from '../src/core'

/**
 * 差分测试：拿 `marked` 当 oracle。
 *
 * 不比对 HTML 字符串 —— 双方都会往标签上挂 class、空白处理也不一样，
 * 逐字符比只会变成维护噪音。这里比的是**标签序列**：
 * 「同一段源码，两个解析器切出来的结构是否一致」。
 *
 * 只放两边都按 CommonMark 输出的子集。已知的有意偏离（不进这个列表）：
 *   - 任务列表：我们产出 <input type="checkbox">，marked 默认当普通文本
 *   - `:::note` 容器：marked 不支持
 *   - `<kbd>` 这类行内 HTML：marked 会当 HTML 块处理
 */

function tags(html: string): string[] {
  return [...html.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1]!.toLowerCase())
}

const CASES: [string, string][] = [
  ['ATX 标题', '# 一级\n\n### 三级'],
  ['强调嵌套', '*a* **b** ***c*** ~~d~~'],
  ['无序列表', '- a\n- b\n  - b1'],
  ['有序列表', '1. a\n2. b'],
  ['引用', '> 一级\n>\n> > 二级'],
  ['围栏代码', '```ts\nconst a = 1\n```'],
  ['表格', '| a | b |\n| :- | -: |\n| 1 | 2 |'],
  ['分隔线', 'a\n\n---\n\nb'],
  ['行内代码与链接', '用 `x` 和 [链接](https://a.dev) 以及 ![图](i.png)'],
  ['自动链接', '<https://x.dev>'],
  ['转义', '\\*不是强调\\*'],
  ['硬换行', 'a  \nb'],
]

describe('与 marked 的结构一致性', () => {
  for (const [name, src] of CASES) {
    it(name, () => {
      expect(tags(render(src))).toEqual(tags(marked.parse(src, { async: false }) as string))
    })
  }
})
