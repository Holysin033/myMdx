import { computed, ref, shallowRef, watch } from 'vue'
import { renderBlocks } from '../core'
import { IncrementalCompiler, type CompileStats } from '../core/incremental'
import { highlightCode } from '../core/highlight'
import type { BlockNode } from '../core/types'

/**
 * 文档状态 + 编译流水线的单一入口。
 *
 * 两个克制但关键的取舍：
 *  1. AST 用 shallowRef —— ref 会深度代理上万节点，光代理开销就比解析本身还大。
 *  2. 编译用「脏标记 + rAF 合并」而不是 setTimeout 防抖：一帧内连打 10 个字符
 *     只编译一次，且没有人为延迟（40ms 防抖在快速输入时会明显发粘）。
 */

const STORAGE_KEY = 'mymdx:doc'
const BACKUP_KEY = 'mymdx:doc.bak'
const SAVE_DELAY = 600

const SAMPLE = [
  '# myMdx',
  '',
  '一个**手写编译器**的 Markdown 编辑器。没有用 marked、没有用 remark，',
  '从词法到渲染都是自己的代码 —— 因为写它的目的是学会解析。',
  '',
  '## 能做什么',
  '',
  '- 实时预览（脏标记 + rAF 合并，不做无谓编译）',
  '- 代码高亮（16 种语言按需注册，主题色走 CSS 变量）',
  '- 暗黑模式（首帧前定主题，零闪白）',
  '- 本地自动保存（600ms 防抖 + 页面隐藏时强制落盘）',
  '',
  '## 语法支持',
  '',
  '| 特性 | 状态 |',
  '| :-- | --: |',
  '| 强调 / 删除线 | ✅ |',
  '| 表格 / 任务列表 | ✅ |',
  '| 引用 / 嵌套引用 | ✅ |',
  '',
  '- [x] 块级解析',
  '- [x] 行内解析',
  '- [ ] 增量编译',
  '',
  '```ts',
  'export function greet(name: string): string {',
  '  return `hello, ${name}`',
  '}',
  '```',
  '',
  '> 关键不是「能渲染」，而是「知道自己为什么不完全合规」。',
  '',
  ':::tip 试一试',
  '在左边随便敲点什么，右边会立刻跟着变。',
  ':::',
].join('\n')

function load(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved !== null) return saved
  } catch {
    // 隐私模式 / 配额不可用：退回示例文档
  }
  return SAMPLE
}

const content = ref(load())
const ast = shallowRef<BlockNode[]>([])
const html = ref('')
const compileMs = ref(0)
const parseMs = ref(0)
const renderMs = ref(0)
const savedAt = ref<number | null>(null)
const hasBackup = ref(false)
const stats = ref<CompileStats>({ mode: 'full', reused: 0, reparsed: 0, windowChars: 0 })

const compiler = new IncrementalCompiler()

let frame = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined

function compile(): void {
  const t0 = performance.now()
  const blocks = compiler.parse(content.value)
  const t1 = performance.now()
  html.value = renderBlocks(blocks, { highlight: highlightCode })
  ast.value = blocks
  const t2 = performance.now()
  parseMs.value = t1 - t0
  renderMs.value = t2 - t1
  compileMs.value = t2 - t0
  stats.value = compiler.lastStats
}

function schedule(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    compile()
  })
}

function save(): void {
  saveTimer = undefined
  try {
    // 覆盖前先留一份上一版：选错全选粘贴、误删一大段，是这类编辑器最常见的丢稿方式
    const prev = localStorage.getItem(STORAGE_KEY)
    if (prev !== null && prev !== content.value) {
      localStorage.setItem(BACKUP_KEY, prev)
      hasBackup.value = true
    }
    localStorage.setItem(STORAGE_KEY, content.value)
    savedAt.value = Date.now()
  } catch {
    // 写不进去（配额/隐私模式）就算了，不能因此丢输入
  }
}

function restoreBackup(): void {
  try {
    const backup = localStorage.getItem(BACKUP_KEY)
    if (backup === null) return
    content.value = backup
  } catch {
    // 读不出来就当没有
  }
}

function scheduleSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  saveTimer = setTimeout(save, SAVE_DELAY)
}

function flushSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  saveTimer = undefined
  save()
}

watch(content, () => {
  schedule()
  scheduleSave()
})

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSave)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSave()
  })
}

// 在编辑器上打字的前 30 秒里这是最值钱的一次编译
compile()

try {
  hasBackup.value = localStorage.getItem(BACKUP_KEY) !== null
} catch {
  // 隐私模式下没有 localStorage，忽略
}

const lines = computed(() => content.value.split('\n').length)
const chars = computed(() => content.value.length)

export function useMarkdown() {
  return {
    content, ast, html, compileMs, parseMs, renderMs, savedAt, stats, lines, chars, compile, flushSave,
    hasBackup, restoreBackup,
    refs: () => compiler.lastRefs,
  }
}
