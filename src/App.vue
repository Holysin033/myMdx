<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useTheme } from './composables/useTheme'
import { useMarkdown } from './composables/useMarkdown'
import { useInspector } from './composables/useInspector'
import { download, fileName, pickTitle, standaloneHtml } from './core/export'

const theme = useTheme()
const { content, html, compileMs, savedAt, stats, lines, chars, flushSave, hasBackup, restoreBackup } = useMarkdown()
const inspector = useInspector()

/* ---- 导出 ---- */

function exportHtml(): void {
  const title = pickTitle(html.value)
  download(
    `${fileName(title)}.html`,
    standaloneHtml(title, html.value, theme.isDark.value),
    'text/html;charset=utf-8',
  )
  toast('HTML 已导出')
}

/** 打印 = 导出 PDF。纸面统一走浅色，打完再切回用户原来的主题 */
function exportPdf(): void {
  const root = document.documentElement
  const before = root.dataset.theme
  if (theme.isDark.value) root.dataset.theme = 'light'

  const restore = (): void => {
    if (before) root.dataset.theme = before
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  window.print()
  // Safari 有时不触发 afterprint，兜个底
  setTimeout(restore, 1500)
}

/* ---- 轻提示 ---- */

const message = ref('')
let messageTimer: ReturnType<typeof setTimeout> | undefined

function toast(text: string): void {
  message.value = text
  if (messageTimer !== undefined) clearTimeout(messageTimer)
  messageTimer = setTimeout(() => (message.value = ''), 1600)
}

function onRestore(): void {
  restoreBackup()
  toast('已恢复到上一版')
}

/* ---- 可拖拽分隔条 ---- */

const ratio = ref(0.5)

function startDrag(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const panes = el.parentElement
  if (!panes) return

  const move = (ev: PointerEvent): void => {
    const box = panes.getBoundingClientRect()
    const next = (ev.clientX - box.left) / box.width
    ratio.value = Math.min(0.82, Math.max(0.18, next))
  }
  const up = (): void => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}

const panesStyle = computed(() => ({
  gridTemplateColumns: `minmax(0, ${ratio.value}fr) 6px minmax(0, ${1 - ratio.value}fr)`,
}))


const editorEl = ref<HTMLTextAreaElement>()
const previewEl = ref<HTMLElement>()

const savedLabel = computed(() => {
  const t = savedAt.value
  if (t === null) return '本地草稿'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `已保存 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})

/** 用 execCommand 写回，浏览器原生撤销栈（Ctrl+Z）不会被破坏 */
function replaceSelection(text: string, selStart: number, selEnd: number): void {
  const el = editorEl.value
  if (!el) return
  el.focus()
  const ok = document.execCommand('insertText', false, text)
  if (!ok) {
    const start = el.selectionStart
    const end = el.selectionEnd
    content.value = content.value.slice(0, start) + text + content.value.slice(end)
  }
  el.setSelectionRange(selStart, selEnd)
}

function wrapInline(marker: string): void {
  const el = editorEl.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = content.value.slice(start, end)
  replaceSelection(marker + selected + marker, start + marker.length, end + marker.length)
}

function outdent(): void {
  const el = editorEl.value
  if (!el) return
  const caret = el.selectionStart
  const lineStart = content.value.lastIndexOf('\n', caret - 1) + 1
  let n = 0
  while (n < 2 && content.value[lineStart + n] === ' ') n++
  if (n === 0) return
  el.setSelectionRange(lineStart, lineStart + n)
  replaceSelection('', lineStart, lineStart)
}

function onKeydown(e: KeyboardEvent): void {
  const el = editorEl.value
  if (!el) return

  if (e.key === 'Tab') {
    e.preventDefault()
    if (e.shiftKey) outdent()
    else replaceSelection('  ', el.selectionStart + 2, el.selectionEnd + 2)
    return
  }

  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase()
    if (key === 'b') {
      e.preventDefault()
      wrapInline('**')
    } else if (key === 'i') {
      e.preventDefault()
      wrapInline('*')
    } else if (key === 's') {
      // 浏览器默认是「保存网页」，这里改成立刻落盘
      e.preventDefault()
      flushSave()
      toast('已保存到本地')
    }
  }
}

/** 按滚动比例同步（单向：编辑器 → 预览，避免两边互相拉扯） */
function onScroll(): void {
  const el = editorEl.value
  const pv = previewEl.value
  if (!el || !pv) return
  const editable = el.scrollHeight - el.clientHeight
  const pannable = pv.scrollHeight - pv.clientHeight
  if (editable <= 0) return
  scrollRatio = el.scrollTop / editable
  if (pannable > 0) pv.scrollTop = scrollRatio * pannable
}

/**
 * 滚动位置只在「页面要走了」时写一次 localStorage。
 * 跟着 scroll 事件写会每秒几十次同步 IO —— 这正是滚动发涩的典型来源。
 */
const SCROLL_KEY = 'mymdx:scroll'
let scrollRatio = 0

onMounted(async () => {
  const saved = Number(localStorage.getItem(SCROLL_KEY) ?? '0')
  if (!Number.isFinite(saved) || saved <= 0) return
  await nextTick()
  const el = editorEl.value
  if (el) el.scrollTop = saved * (el.scrollHeight - el.clientHeight)
})

window.addEventListener('pagehide', () => {
  try {
    localStorage.setItem(SCROLL_KEY, String(scrollRatio))
  } catch {
    // 存不下就算了，滚动位置不值得为它牺牲任何东西
  }
})

function trackCaret(): void {
  const el = editorEl.value
  if (el) inspector.setCaret(el.selectionStart)
}

/** Inspector 里点一行 → 选中源码对应区间，并把编辑区滚到能看见它 */
function jumpTo(start: number, end: number): void {
  const el = editorEl.value
  if (!el) return
  el.focus()
  el.setSelectionRange(start, end)
  const line = content.value.slice(0, start).split('\n').length - 1
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 24
  const top = line * lh
  if (top < el.scrollTop + lh || top > el.scrollTop + el.clientHeight - lh * 3) {
    el.scrollTop = Math.max(0, top - el.clientHeight / 2)
  }
  inspector.setCaret(start)
}
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <strong class="brand">myMdx</strong>
      <span class="tag">v0.2 · 手写解析器</span>
      <div class="grow" />
      <button class="ghost" title="导出单文件 HTML（样式内联，双击即可打开）" @click="exportHtml">
        导出 HTML
      </button>
      <button class="ghost" title="用浏览器打印对话框另存为 PDF" @click="exportPdf">导出 PDF</button>
      <button
        class="inspector-toggle"
        :class="{ on: inspector.open.value }"
        title="查看 Token 流 / AST / 耗时"
        @click="inspector.toggle()"
      >
        🔍 Inspector
      </button>
      <button :title="`主题：${theme.label.value}，点击切换`" @click="theme.cycle()">
        {{ theme.mode.value === 'auto' ? '🌗' : theme.mode.value === 'dark' ? '🌙' : '☀️' }}
        {{ theme.label.value }}
      </button>
    </header>

    <main class="panes" :style="panesStyle">
      <section class="pane">
        <div class="pane-head">
          编辑
          <span class="hint">Tab 缩进 · Ctrl/⌘+B 加粗 · Ctrl/⌘+I 斜体 · Ctrl/⌘+S 保存</span>
        </div>
        <textarea
          ref="editorEl"
          v-model="content"
          class="editor"
          spellcheck="false"
          autocomplete="off"
          placeholder="# 从这里开始写…"
          @keydown="onKeydown"
          @keyup="trackCaret"
          @click="trackCaret"
          @select="trackCaret"
          @scroll.passive="onScroll"
        />
      </section>

      <div class="splitter" title="拖动调整比例" @pointerdown="startDrag" />

      <section class="pane">
        <div class="pane-head">预览</div>
        <div ref="previewEl" class="preview">
          <div v-if="!content.trim()" class="preview-empty">
            <p>左边是空的。</p>
            <p class="hint">输入 <code>#</code> 加空格就是标题，<code>```</code> 开代码块。</p>
          </div>
          <div v-else class="md-body" v-html="html" />
        </div>
      </section>
    </main>

    <aside v-if="inspector.open.value" class="inspector">
      <section class="insp-col">
        <h4>
          Token 流
          <small v-if="inspector.activeBlock.value">
            行 {{ inspector.activeBlock.value.line }} ·
            {{ inspector.activeBlock.value.type === 'heading' ? '标题' : '段落' }}
          </small>
        </h4>
        <ul>
          <li
            v-for="(t, i) in inspector.tokens.value"
            :key="i"
            :title="`${t.start}–${t.end}`"
            @click="jumpTo(t.start, t.end)"
          >
            <code>{{ t.label }}</code>
          </li>
        </ul>
        <p v-if="!inspector.tokens.value.length" class="empty">把光标放进一个段落或标题</p>
      </section>

      <section class="insp-col">
        <h4>AST <small>{{ inspector.rows.value.length }} 节点</small></h4>
        <ul class="tree">
          <li
            v-for="(r, i) in inspector.rows.value"
            :key="i"
            :style="{ paddingLeft: r.depth * 12 + 8 + 'px' }"
            :class="{ inline: r.depth > 0 }"
            @click="jumpTo(r.select[0], r.select[1])"
          >
            <code>{{ r.label }}</code>
          </li>
        </ul>
      </section>

      <section class="insp-col perf">
        <h4>耗时</h4>
        <dl>
          <dt>解析</dt>
          <dd>{{ inspector.parseMs.value.toFixed(2) }} ms</dd>
          <dt>渲染</dt>
          <dd>{{ inspector.renderMs.value.toFixed(2) }} ms</dd>
          <dt>合计</dt>
          <dd>{{ compileMs.toFixed(2) }} ms</dd>
          <dt>模式</dt>
          <dd>{{ stats.mode === 'incremental' ? '增量' : '全量' }}</dd>
          <dt>复用 / 重解析</dt>
          <dd>{{ stats.reused }} / {{ stats.reparsed }}</dd>
          <dt>窗口</dt>
          <dd>{{ stats.windowChars }} 字符</dd>
          <dt>块复用率</dt>
          <dd>
            {{
              stats.reused + stats.reparsed === 0
                ? '—'
                : ((stats.reused / (stats.reused + stats.reparsed)) * 100).toFixed(1) + '%'
            }}
          </dd>
        </dl>
      </section>
    </aside>

    <footer class="statusbar">
      <span>{{ lines }} 行</span>
      <span>{{ chars }} 字符</span>
      <span>编译 {{ compileMs.toFixed(2) }} ms</span>
      <span
        class="stat"
        :class="stats.mode"
        :title="
          stats.mode === 'full'
            ? `全量解析 ${stats.reparsed} 块（首次加载或引用定义变化时没有可复用的块）`
            : `增量：复用 ${stats.reused} 块 · 重解析 ${stats.reparsed} 块 · 窗口 ${stats.windowChars} 字符`
        "
      >
        {{ stats.mode === 'full' ? '全量' : `增量 ${stats.reused}/${stats.reused + stats.reparsed}` }}
      </span>
      <div class="grow" />
      <button v-if="hasBackup" class="ghost small" title="把内容回退到上一次保存之前" @click="onRestore">
        恢复上一版
      </button>
      <span>{{ savedLabel }}</span>
    </footer>

    <div v-if="message" class="toast">{{ message }}</div>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}

.brand {
  font-size: 15px;
  letter-spacing: 0.2px;
}

.tag {
  font-size: 11px;
  color: var(--fg-faint);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
}

.grow {
  flex: 1;
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  /* 行轨道默认按内容撑高（隐式 auto），内容一长就把 .app 顶出视口、整页跟着滚。
     minmax(0,1fr) 把轨道钉在容器高度上，多余的部分交给 .editor / .preview 自己滚 */
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}

.pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
}

.pane:last-child {
  border-right: none;
}

.splitter {
  cursor: col-resize;
  background: var(--border);
  transition: background-color var(--dur);
  touch-action: none;
}

.splitter:hover,
.splitter:active {
  background: var(--accent);
}

.preview-empty {
  padding: 32px 4px;
  color: var(--fg-faint);
}

.preview-empty p {
  margin: 0 0 8px;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  padding: 7px 14px;
  border-radius: 999px;
  background: var(--fg);
  color: var(--bg);
  font-size: 12px;
  pointer-events: none;
  animation: toast-in 160ms ease-out;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translate(-50%, 6px);
  }
}

.pane-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  color: var(--fg-faint);
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  user-select: none;
}

.hint {
  font-size: 11px;
  color: var(--fg-faint);
  opacity: 0.8;
}

.editor {
  flex: 1;
  width: 100%;
  min-height: 0;
  resize: none;
  border: none;
  outline: none;
  padding: 18px;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 13.5px;
  line-height: 1.75;
  tab-size: 2;
}

.preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 24px 40vh;
  /* v-html 整块替换时，浏览器的滚动锚定会和手动同步打架 */
  overflow-anchor: none;
}

.stat.incremental {
  color: var(--accent);
}

.inspector-toggle.on {
  border-color: var(--accent);
  color: var(--accent);
}

.inspector {
  height: 34vh;
  min-height: 180px;
  display: grid;
  grid-template-columns: 1fr 1.2fr 220px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
}

.insp-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  overflow: hidden;
}

.insp-col:last-child {
  border-right: none;
}

.insp-col h4 {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 0;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--fg-faint);
  border-bottom: 1px solid var(--border);
}

.insp-col h4 small {
  font-size: 10px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.insp-col ul {
  flex: 1;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.7;
}

.insp-col li {
  padding: 0 12px;
  cursor: pointer;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.insp-col li:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.tree li.inline {
  color: var(--fg-faint);
}

.empty {
  margin: 10px 12px;
  font-size: 11.5px;
  color: var(--fg-faint);
}

.perf dl {
  margin: 0;
  padding: 8px 12px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  font-size: 11.5px;
}

.perf dt {
  color: var(--fg-faint);
}

.perf dd {
  margin: 0;
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.statusbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 5px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 12px;
  color: var(--fg-muted);
}

/* 状态栏里的救援按钮：只在存在上一版备份时出现 */
.ghost.small {
  padding: 1px 8px;
  font-size: 11px;
  border-radius: 999px;
}

@media (max-width: 900px) {
  .panes {
    /* 内联的 grid-template-columns 要 !important 才盖得住 */
    grid-template-columns: 1fr !important;
    grid-template-rows: 1fr 1fr;
  }

  .splitter {
    display: none;
  }

  .pane {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}
</style>
