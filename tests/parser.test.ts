import { describe, expect, it } from 'vitest'
import { parse, render } from '../src/core'

const nl = (...lines: string[]) => lines.join('\n')

describe('块级', () => {
  it('ATX 标题', () => {
    expect(render('# Hi')).toBe('<h1>Hi</h1>')
    expect(render('## Hi ##')).toBe('<h2>Hi</h2>')
    expect(render('###### deep')).toBe('<h6>deep</h6>')
  })

  it('Setext 标题', () => {
    expect(render(nl('Hi', '==='))).toBe('<h1>Hi</h1>')
    expect(render(nl('Hi', '---'))).toBe('<h2>Hi</h2>')
  })

  it('分隔线', () => {
    expect(render('---')).toBe('<hr>')
    expect(render('* * *')).toBe('<hr>')
  })

  it('围栏代码', () => {
    const src = nl('```js', 'const a = 1', '```')
    expect(render(src)).toBe('<pre><code class="language-js">const a = 1</code></pre>')
  })

  it('未闭合围栏吃到文末', () => {
    const src = nl('```', 'a < b', '```')
    expect(render(src)).toBe('<pre><code>a &lt; b</code></pre>')
  })

  it('缩进代码', () => {
    expect(render(nl('    indented', '    code'))).toBe('<pre><code>indented\ncode</code></pre>')
  })

  it('引用与嵌套引用', () => {
    expect(render(nl('> a', '> b'))).toBe('<blockquote><p>a\nb</p></blockquote>')
    expect(render(nl('> a', '> > b'))).toBe(
      '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>',
    )
  })

  it('紧凑列表不包 <p>，松散列表包 <p>', () => {
    expect(render(nl('- a', '- b'))).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(render(nl('- a', '', '- b'))).toBe(
      '<ul><li><p>a</p></li><li><p>b</p></li></ul>',
    )
  })

  it('有序列表起始号', () => {
    expect(render('3. a')).toBe('<ol start="3"><li>a</li></ol>')
    expect(render('1. a')).toBe('<ol><li>a</li></ol>')
  })

  it('任务列表', () => {
    expect(render('- [x] done')).toBe(
      '<ul><li class="task-list-item"><input type="checkbox" disabled checked> done</li></ul>',
    )
    expect(render('- [ ] todo')).toBe(
      '<ul><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>',
    )
  })

  it('表格', () => {
    const src = nl('| a | b |', '| :-- | --: |', '| 1 | 2 |')
    expect(render(src)).toBe(
      '<table><thead><tr><th style="text-align: left">a</th><th style="text-align: right">b</th></tr></thead>' +
        '<tbody><tr><td style="text-align: left">1</td><td style="text-align: right">2</td></tr></tbody></table>',
    )
  })

  it('自定义容器', () => {
    const src = nl(':::note 提示', '内容', ':::')
    expect(render(src)).toBe(
      '<div class="md-container md-container-note">' +
        '<div class="md-container-title">提示</div><p>内容</p></div>',
    )
    expect(render(nl(':::tip', 'x', ':::'))).toBe(
      '<div class="md-container md-container-tip"><p>x</p></div>',
    )
  })

  it('段落合并与空行分段', () => {
    expect(render(nl('a', 'b', '', 'c'))).toBe('<p>a\nb</p><p>c</p>')
  })
})

describe('行内', () => {
  it('强调', () => {
    expect(render('*a*')).toBe('<p><em>a</em></p>')
    expect(render('**a**')).toBe('<p><strong>a</strong></p>')
    expect(render('***a***')).toBe('<p><em><strong>a</strong></em></p>')
    expect(render('__a__')).toBe('<p><strong>a</strong></p>')
  })

  it('嵌套强调', () => {
    expect(render('**bold *italic* bold**')).toBe(
      '<p><strong>bold <em>italic</em> bold</strong></p>',
    )
  })

  it('下划线不在词内生效', () => {
    expect(render('foo_bar_baz')).toBe('<p>foo_bar_baz</p>')
  })

  it('未配对分隔符原样输出', () => {
    expect(render('*a')).toBe('<p>*a</p>')
    expect(render('a **')).toBe('<p>a **</p>')
  })

  it('删除线', () => {
    expect(render('~~gone~~')).toBe('<p><del>gone</del></p>')
    expect(render('~one~')).toBe('<p>~one~</p>')
  })

  it('代码段', () => {
    expect(render('`a*b*`')).toBe('<p><code>a*b*</code></p>')
    expect(render('``a ` b``')).toBe('<p><code>a ` b</code></p>')
  })

  it('链接与标题', () => {
    expect(render('[a](/b)')).toBe('<p><a href="/b">a</a></p>')
    expect(render('[a](/b "t")')).toBe('<p><a href="/b" title="t">a</a></p>')
  })

  it('引用式链接（含前向引用）', () => {
    expect(render(nl('[a][r]', '', '[r]: /x'))).toBe('<p><a href="/x">a</a></p>')
    expect(render(nl('[r]', '', "[r]: /y 'T'"))).toBe('<p><a href="/y" title="T">r</a></p>')
  })

  it('图片', () => {
    expect(render('![alt](/i.png)')).toBe('<p><img src="/i.png" alt="alt"></p>')
  })

  it('转义', () => {
    expect(render('\\*a\\*')).toBe('<p>*a*</p>')
    expect(render('\\# not heading')).toBe('<p># not heading</p>')
  })

  it('硬换行与软换行', () => {
    expect(render(nl('a  ', 'b'))).toBe('<p>a<br>\nb</p>')
    expect(render(nl('a', 'b'))).toBe('<p>a\nb</p>')
  })

  it('自动链接', () => {
    expect(render('<https://x.dev>')).toBe('<p><a href="https://x.dev">https://x.dev</a></p>')
    expect(render('<a@b.co>')).toBe('<p><a href="mailto:a@b.co">a@b.co</a></p>')
  })

  it('HTML 原样透传', () => {
    expect(render('<kbd>Ctrl</kbd>')).toBe('<p><kbd>Ctrl</kbd></p>')
  })
})

describe('安全', () => {
  it('拦截 javascript: 协议', () => {
    expect(render('[x](javascript:alert(1))')).toBe('<p><a href="">x</a></p>')
    expect(render('[x](JAVASCRIPT:alert(1))')).toBe('<p><a href="">x</a></p>')
    expect(render('![x](vbscript:1)')).toBe('<p><img src="" alt="x"></p>')
  })

  it('放行图片 data URI，拦截其它 data URI', () => {
    expect(render('![x](data:image/png;base64,AA)')).toBe(
      '<p><img src="data:image/png;base64,AA" alt="x"></p>',
    )
    expect(render('[x](data:text/html,<b>)')).toBe('<p><a href="">x</a></p>')
  })
})

describe('AST', () => {
  it('位置信息指向源码偏移', () => {
    const blocks = parse('# Hi')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'heading', depth: 1, start: 0, line: 1 })
  })

  it('空文档返回空数组', () => {
    expect(parse('')).toEqual([])
    expect(render('')).toBe('')
  })

  it('CRLF 归一化', () => {
    expect(render('a\r\n\r\nb')).toBe('<p>a</p><p>b</p>')
  })
})
