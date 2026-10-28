import { describe, expect, it } from 'vitest'
import { fileName, pickTitle, standaloneHtml } from '../src/core/export'

describe('导出', () => {
  it('单文件 HTML 自带样式、标题转义、主题跟随', () => {
    const html = standaloneHtml('<b>a&b</b>', '<p>正文</p>', true)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('<title>&lt;b&gt;a&amp;b&lt;/b&gt;</title>')
    expect(html).toContain('class="md-body export-page"')
    expect(html).toContain('<p>正文</p>')
    // 样式表必须内联（`<link>` 会让离线文件掉样式）
    expect(html).not.toContain('<link')
    // 注：vitest 的 node 环境会把 `.css?raw` 打桩成空串，所以这里验不了
    // 样式内容 —— 生产构建里的内联在 dist 里确认过（bundle 含 `--bg: #ffffff`）。
  })

  it('标题取第一个 h1/h2，没有就用日期兜底', () => {
    expect(pickTitle('<h2 class="x">你好 <em>世界</em></h2>')).toBe('你好 世界')
    expect(pickTitle('<p>没有标题</p>')).toMatch(/^未命名-\d{8}$/)
  })

  it('文件名去掉非法字符', () => {
    expect(fileName('a/b:c *d?')).toBe('a-b-c-d')
    expect(fileName('///')).toBe('document')
  })
})
