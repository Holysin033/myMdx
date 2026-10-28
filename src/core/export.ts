import themeCss from '../styles/theme.css?raw'
import markdownCss from '../styles/markdown.css?raw'

/**
 * 导出：HTML 与 PDF 都复用同一个渲染器（Renderer），不再写第二套转换逻辑。
 *
 * - HTML：把样式表内联进单文件，双击就能看，不依赖任何外部资源
 * - PDF：`window.print()` + `@media print`，零依赖（jsPDF/html2canvas 那套是给
 *   「必须在前端生成 PDF 文件」的场景准备的，这里浏览器自带的排版更好）
 */

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function standaloneHtml(title: string, body: string, dark: boolean): string {
  return `<!doctype html>
<html lang="zh-CN" data-theme="${dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
<style>
${themeCss}
${markdownCss}
body { height: auto; }
.export-page { max-width: 800px; margin: 0 auto; padding: 48px 24px 96px; }
</style>
</head>
<body>
<div class="md-body export-page">
${body}
</div>
</body>
</html>
`
}

export function download(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // 立刻回收会让某些浏览器来不及开始下载，给一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 从正文里挑一个像标题的名字：第一个 h1/h2，否则用日期 */
export function pickTitle(body: string): string {
  const match = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(body)
  if (match) {
    const text = match[1]!.replace(/<[^>]+>/g, '').trim()
    if (text) return text.slice(0, 60)
  }
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `未命名-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

export function fileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'document'
}
