# myMdx — 手写编译器的实时 Markdown 编辑器

> 开发计划书 v1
> 目标：简历级项目 + 编译原理实战 + 可量化的性能工程

---

## 1. 项目定位

### 1.1 它是什么

一个 Vue 3 Markdown 编辑器。**但它真正的作品是中间那层编译器。**

绝大多数「Markdown 编辑器」简历项目 = `marked.parse(text)` + `v-html` + 一个暗色按钮。面试官扫一眼就知道没有技术含量。本项目的差异化只有一句话：

> **从字符流到 AST 到 DOM，全链路自己写的解析器；编辑时只重新编译脏区域，并用数字证明它比全量编译快一个数量级。**

### 1.2 三个支柱

| 支柱 | 内容 | 对应简历能力 |
|------|------|-------------|
| **编译器** | 手写 Lexer（状态机）+ Block Parser（递归下降 + 容器栈）+ Inline Parser（分隔符栈）→ 带位置的 AST → Renderer | 编译原理、算法、数据结构设计 |
| **性能工程** | 块级增量编译、节点身份复用、Worker 卸载、视口内高亮、原生 `content-visibility`；内置 benchmark 出数字 | 性能分析、可量化优化、取舍判断 |
| **产品做工** | 中文输入法处理、双向滚动同步、零闪白主题切换、零依赖 PDF 导出 | 用户体验细节、工程严谨度 |

### 1.3 明确不做（YAGNI）

- ❌ 不做 WYSIWYG / 富文本双向绑定（会让编辑器内核复杂度淹没解析器主线）
- ❌ 不做多人协作 / CRDT
- ❌ 不做完整 CommonMark 100% 合规（目标：核心子集 + 明确的不支持清单）
- ❌ 不引入 Pinia（一个 `useEditor` composable 就够）
- ❌ 不引入 UI 组件库（样式自己做，主题系统才有控制权）
- ❌ PDF 不用 jsPDF/html2canvas（见 §9.3）

---

## 2. 架构总览

```
                       ┌──────────────────────────────────────┐
   键盘/IME 输入 ──────▶│  Editor (textarea)                   │
                       └──────────────┬───────────────────────┘
                                      │ source string + 变更区间(prefix/suffix diff)
                                      ▼
                       ┌──────────────────────────────────────┐
                       │  Incremental Engine                  │
                       │  · dirty 区间 → 顶层块边界窗口        │
                       │  · 复用未变更 BlockNode（引用相等）   │
                       └──────────────┬───────────────────────┘
                                      │ 变更窗口内的行
                     ┌────────────────┴────────────────┐
                     ▼                                 │
        ┌────────────────────────┐                    │
        │ Lexer (行/字符状态机)   │                    │
        └───────────┬────────────┘                    │
                    ▼                                 │
        ┌────────────────────────┐                    │
        │ Block Parser           │  ← 容器栈          │
        │ 递归下降 + 行状态机     │                    │
        └───────────┬────────────┘                    │
                    ▼                                 │
        ┌────────────────────────┐   延迟解析（仅视口内）│
        │ Inline Parser          │  ← 分隔符栈        │
        └───────────┬────────────┘                    │
                    ▼                                 ▼
        ┌─────────────────────────────────────────────────────┐
        │  AST（每个节点带 start/end 源码偏移 + 稳定 id）      │
        └──────┬───────────────────────────────┬─────────────┘
               ▼                               ▼
   ┌───────────────────┐            ┌──────────────────────┐
   │ Renderer          │            │ Consumers            │
   │ AST → HTML string │            │ · 滚动同步(行↔元素)   │
   └─────────┬─────────┘            │ · Inspector 面板     │
             ▼                      │ · 导出 HTML          │
   ┌───────────────────┐            └──────────────────────┘
   │ Preview（块级 v-for│
   │  + key=node.id）   │
   └───────────────────┘
```

**一根线串三件事（架构核心决策）**：AST 节点携带 `start/end` 源码偏移。
同一份位置信息同时喂给 **① 增量编译的脏区间定位 ② 滚动同步的行↔元素映射 ③ Inspector 的源码↔AST 高亮联动**。三个功能不各写一套映射逻辑。

---

## 3. 解析器设计（学习主线）

### 3.1 词法层 Lexer

**块级**：行导向。把 source 切成行（保留换行符），每行标注缩进、是否为空行、是否以 fence/list marker/引用符开头。
**行内**：字符导向状态机，产出 token 队列：`Text`、`CodeSpan`、`DelimiterRun(*/_)`、`LinkOpen[`、`LinkClose]`、`Image!`、`Escape`、`AutoLink`、`HardBreak`。

行内切分核心规则：
- `` ` `` 反引号串 → 向前找等长反引号闭合，找不到则整串是字面量（**不做回溯搜索，O(n)**）
- `\` 转义 → 吞掉下一个 ASCII 标点
- `*`/`_` 成串 → 生成 `DelimiterRun{char, count, canOpen, canClose}`。`canOpen`/`canClose` 由左右邻字符的空白/标点属性决定（这是 CommonMark 的 flanking 规则，必须实现，否则 `a*b*c` 和 `a_b_c` 行为会错）

### 3.2 块级 Parser：容器栈

仿 CommonMark 的两阶段结构：

```
parseBlocks(lines):
  stack = []                       // 打开的容器：blockquote / list / listItem
  for line in lines:
    matched = 匹配栈内各容器的延续条件
    if 有未匹配的容器 → 关闭它们（pop 到匹配处）
    尝试开启新容器（`>`、`-`/`1.`、缩进）→ push，继续消费该行
    否则 → 交给叶子块（paragraph / fenced code / table / hr / html）
    空行 → 关闭 paragraph
```

- **容器延续条件**是难点：`>` 引用要吞掉可选空格后再判；列表项内容缩进 = marker 宽度，且「懒续行」（lazy continuation）允许段落续行不缩进 —— 这两条是手写解析器最容易翻车的地方，必须有针对性单测。
- **叶子块**：fenced code（``` 或 ~~~，支持 info string）、缩进代码（4 空格）、ATX 标题（`#`~`######`）、Setext 标题（`===`/`---`）、水平线、HTML 块、段落。
- **扩展语法**（本项目自实现，非依赖）：GFM 表格（对齐行 `|:--:|`）、任务列表（`- [x]`）、删除线 `~~`、脚注、自定义容器 `::: note`（← 展示 AST 可扩展性）。

### 3.3 行内 Parser：分隔符栈

这是整个项目最有技术含量的一块，也是面试可以讲 10 分钟的部分。

```
1. 扫描出 token 队列（含 DelimiterRun）
2. 遍历，维护 delimiterStack：
     - 遇到 closer：向栈内回找同 char 的 opener
        · 两边 count 都 >= 2 → 消耗 2，包裹 Strong
        · 否则 → 消耗 1，包裹 Emphasis
        · 未消耗的分隔符留在原位成为字面量文本
3. 链接用「方括号栈」：遇到 `]` 回看最近的 `[`
     - 尝试 `(url "title")` → inline link
     - 尝试 `[label]` / 引用定义表 → reference link
     - 失败 → `[` 降级为字面量
4. 语义阶段：收集全文 `[label]: url` 引用定义，回填所有引用
```

关键点：**先出 token 再配对**，而不是边扫边匹配。这样嵌套 `***a***`、`**a *b* c**`、`_a_b_` 这类交叉都能正确处理，且没有指数回溯。

### 3.4 AST 契约

```ts
interface BaseNode {
  id: number            // 稳定身份，增量复用 + Vue :key
  type: string
  start: number         // 源码偏移，含
  end: number           // 源码偏移，不含
  line: number          // 起始行号（滚动同步用）
}

type BlockNode =
  | { type:'paragraph'; children: InlineNode[] }
  | { type:'heading'; depth:1..6; children: InlineNode[] }
  | { type:'code'; lang:string|null; value:string; highlighted?:string }
  | { type:'blockquote'; children: BlockNode[] }
  | { type:'list'; ordered:boolean; tight:boolean; start:number; children: ListItem[] }
  | { type:'table'; align:(null|'left'|'center'|'right')[]; head:Row; rows:Row[] }
  | { type:'hr' } | { type:'html'; value:string }
  | { type:'admonition'; kind:'note'|'tip'|'warn'; children: BlockNode[] }

type InlineNode =
  | { type:'text'; value:string }
  | { type:'em'|'strong'|'del'; children: InlineNode[] }
  | { type:'code'; value:string }
  | { type:'link'; href:string; title?:string; children: InlineNode[] }
  | { type:'image'; src:string; alt:string }
  | { type:'break' } | { type:'softbreak' }
```

规则：解析器**纯函数**（无 DOM、无 Vue、无全局状态），输入 `string` 输出 `AST`。这样它能在 Node 里直接单测、能在 Worker 里跑、能被 fuzz 差分测试。

---

## 4. 增量编译引擎（核心创新点）

### 4.1 变更区间获取

textarea 只给新全文，不给 diff。自己算：**公共前缀 + 公共后缀扫描**，O(n) 字符比较，单次编辑下几乎总是 < 1ms，且不依赖任何 diff 库。

```ts
function changedRange(oldText, newText): {start, end, newEnd}
```

### 4.2 脏窗口边界：不能只看空行

朴素做法「按空行切块」是错的 —— 列表项、引用、围栏代码内部都可以有空行，切开就会破坏嵌套。

**正确做法**：以上一次解析结果为准。

```
1. 用旧 AST 找到变更起点命中的顶层块（depth 0 块）
2. 脏窗口 = [前一个顶层块起始行, 后一个顶层块结束行]   ← 各带一格守卫
3. 窗口边界一定处于「容器栈为空」的行 → 用空栈重新解析该行切片，
   结果与整篇解析完全等价（可证明，也可用测试验证）
4. 窗口内重新解析出的节点替换旧节点；窗口两端的守卫块可能被合并（如删掉空行
   让两段并成一段）→ 合并逻辑吸收进窗口，无需额外处理
```

这就是为什么 AST 必须带 `start/end` 和 `line`。

### 4.3 两级复用

| 级别 | 机制 | 收益 |
|------|------|------|
| 块级 | 窗口外节点**原对象引用**放回新 AST → `id` 不变 → Vue `:key` 命中 → 该块**完全跳过 patch** | 长文档编辑只重渲染 1~3 个块 |
| 行内级 | `Map<text, InlineNode[]>` LRU 缓存（上限 500 条） | 块被重建但内容未变时（守卫块合并）、撤销重做、滚动中延迟解析，全部免算 |

### 4.4 正确性护栏（必做）

增量编译最大的风险是「快但错」。防御分三层：

1. **开发期双跑断言**：`import.meta.env.DEV` 时同时跑全量解析，序列化比对（忽略 id），不一致就 `console.error` 并把用例打印成可粘贴的测试。
2. **Fuzz 测试**：随机文档 + 随机编辑操作（插入/删除/换行/改标记），断言 `incremental(doc) === full(doc)`，跑 2000 轮。
3. **保守降级**：出现「引用定义增删」这种全局语义变化时，直接全量重解析（罕见，代价可接受）。

第 3 条是必须的：`[label]: url` 可以定义在文档任意位置并影响任意位置的引用，不维护全局引用表就必须回退全量。

---

## 5. 性能优化清单

每一项都要在 benchmark 里体现「优化前 / 优化后」。

| # | 手段 | 作用点 | 预期 |
|---|------|--------|------|
| 1 | 增量编译（§4） | 解析 | 100KB 文档单次编辑：全量 20~40ms → 增量 < 3ms |
| 2 | 块级 `:key=node.id` + 引用复用 | 渲染 | 未变块零 patch |
| 3 | 行内解析延迟到「进入视口」 | 解析 | 滚动到哪算到哪，首屏只付 1/10 代价 |
| 4 | **`content-visibility: auto` + `contain-intrinsic-size`** | 浏览器原生 | 视口外的块浏览器直接跳过布局/绘制，**零 JS 的虚拟滚动** |
| 5 | 代码高亮只对视口内代码块执行 + 按代码 hash 缓存结果 | 高亮 | highlight.js 是 CPU 大户，长文档省 90% |
| 6 | highlight.js **按需注册语言子集**（只装 10 种常用） | 打包 | 全量 ~1MB → 选中子集约 80KB |
| 7 | Web Worker 解析（文档 > 50KB 时切换） | 主线程 | 大文档不阻塞输入；小文档走同步（省掉克隆开销） |
| 8 | 输入防抖 16ms + `requestAnimationFrame` 合帧 | 渲染 | 快速连打不重复渲染中间态 |
| 9 | **IME 合成期跳过解析**（`compositionstart/end`） | 输入 | 中文拼音输入不再每个字母触发全量渲染 |
| 10 | 滚动同步用缓存好的锚点表 + 二分查找，`rAF` 节流，禁止读写交错 | 布局抖动 | 消灭 scroll 事件里的强制同步布局 |
| 11 | 解析耗时 / 缓存命中率可视化面板 | 度量 | 优化有数字，不是玄学 |

**注意取舍**：Worker 传 AST 有结构化克隆成本。所以设阈值（50KB）而不是无脑全走 Worker。这个取舍本身就是面试可以讲的内容 —— 说明不是抄百科，是真测过。

### 5.1 度量方式

- `performance.mark/measure` 包裹 parse / render / highlight 三段
- `PerformanceObserver` 监听 `longtask`（> 50ms）并记录
- `benchmark/run.ts`（Node 侧，跑纯解析器）：3 种文档 × 4 个尺寸（10/50/100/300KB）× 全量 vs 增量，输出 Markdown 表格 → 直接贴进 README 和简历

---

## 6. 创新点（简历可写的差异化）

按「含金量 ÷ 实现成本」排序，**前三个必须做，其余按时间可砍**：

1. **手写三层解析器**：状态机 + 容器栈 + 分隔符栈，独立实现 GFM 表格 / 任务列表 / 自定义容器。→ 证明懂编译原理，不是套壳。
2. **块级增量编译**：靠 AST 位置信息定位最小重编译窗口，未变节点引用复用。→ 证明性能工程能力，有 benchmark 数字。
3. **解析过程可视化 Inspector**：开发态侧栏实时展示 Token 流 / AST 树 / 各阶段耗时 / 缓存命中率，点击节点跳转源码对应位置。**这是「为了学习编译原理」这个目的本身的产物**，也是演示时最抓眼球的东西 —— 面试官能看到你是怎么理解解析的。
4. **双向滚动锚点同步**：不是按滚动比例硬套，而是用 AST 行号 ↔ 块 DOM 的锚点表 + 二分插值，且反向（拖预览→源码跟随）。
5. **零依赖 PDF 导出**：浏览器原生 `window.print()` + 专用打印样式表（见 §9.3），中文排版质量优于 jsPDF 方案。
6. **可插拔渲染目标**：同一 AST 支持 3 个 consumer（预览 HTML / 独立 HTML 文件 / 终端 ANSI），证明 AST 抽象是干净的。

---

## 7. 用户体验设计要点（踩坑清单）

这些是「看起来能跑」和「真的能用」的差距，逐条落实：

### 7.1 输入体验
- **IME 合成期不渲染**：`compositionstart` 置 flag，`compositionend` 再触发。中文用户的第一优先级。
- 编辑器用 `textarea` + 同步滚动的**行号栏** + 自绘光标行高亮（`textarea` 定位透明、背后一层 mirrors 显示行号）。
- 快捷键：`Ctrl/⌘+B` 加粗、`+I` 斜体、`+K` 插入链接、`+S` 立即保存（阻止浏览器保存对话框）、`Ctrl+/` 开关 Inspector。
- 输入超长行时 `textarea` 水平滚动 vs 软换行的取舍：默认软换行（`white-space: pre-wrap`），加一个开关。

### 7.2 布局与响应式
- 桌面：左编辑右预览 + 可拖拽分隔条（记住比例）。
- 「仅编辑 / 仅预览 / 分栏」三态切换，移动端（< 900px）自动退化为 Tab 切换（两栏并排在手机上必然不可用）。
- 预览宽度上限 `max-width: 72ch`，长行可读性。

### 7.3 主题系统
- CSS 自定义属性：`[data-theme="dark"] { --bg: ...; --fg: ...; --accent: ... }`，切换只改 `<html data-theme>`，**不重新渲染任何组件**。
- `color-scheme: light dark` 让原生控件（滚动条、input）跟随。
- **防闪白（FOUC）**：`index.html` 里内联一段同步脚本，在首次绘制前从 localStorage 读主题并设到 `<html>`。
- 三态：跟随系统 / 亮 / 暗。跟随系统时监听 `matchMedia('(prefers-color-scheme: dark)')`。
- **代码高亮跟随主题**：不切换 highlight.js 样式表，而是把 hljs 的 token 类名映射到我们的 CSS 变量（`.hljs-keyword { color: var(--code-keyword) }`）。→ 主题切换零闪烁、零额外请求。
- 尊重 `prefers-reduced-motion`。

### 7.4 状态反馈
- 底部状态栏：字数 / 行数 / 选中数 / 保存状态（「已保存 · 2 秒前」）/ 解析耗时 / 缓存命中率。
- 空文档时的引导示例（不是空白页）。
- 保存失败（localStorage 配额满）必须显式提示，不能静默丢数据。

### 7.5 滚动同步的坑
- 用 `rAF` + 方向锁：A 滚动时给 B 打 100ms 抑制锁，避免互相触发抖动。
- 锚点表在渲染后、`ResizeObserver` 触发时重建，不在 scroll 里测量（读写交错 = 强制同步布局）。
- 预览内有图片时尺寸未知会顶偏 → 给 `img` 预留宽高比或监听 `load` 重建锚点。

---

## 8. 数据流与状态

```ts
// composables/useEditor.ts —— 唯一状态源
const source = ref<string>('')        // 编辑器内容
const ast = shallowRef<BlockNode[]>([])  // shallowRef！AST 是整体替换，不需要深层响应
const dirty = ref(false)
```

- **必须用 `shallowRef`**：对 AST 做 `ref()` 会让 Vue 递归代理上万个节点，是性能杀手。这个细节本身就值得写进 README。
- 状态不引 Pinia：一个 composable 模块级单例足够，注入成本低于收益。

---

## 9. 持久化与导出

### 9.1 本地自动保存
- 防抖 500ms 写入；`visibilitychange`(hidden) / `beforeunload` 时强制 flush。
- 存储结构：`{ version: 1, content, theme, updatedAt, scrollTop }`，`version` 用于后续迁移。
- 配额守卫：写入 `try/catch`，`QuotaExceededError` 时提示并降级建议。
- 多文档管理（新建/切换/删除）作为 P2 扩展；`localStorage` 单域名约 5MB，超大文档再考虑 IndexedDB。

### 9.2 导出 HTML
复用**同一个 Renderer**：AST → HTML string，套一个自包含模板（内联主题 CSS + 已高亮的代码），`Blob` + `URL.createObjectURL` 下载。不需要第二次解析。

### 9.3 导出 PDF
`window.print()` + `@media print` 样式表：
- `@page { margin: 18mm }`、隐藏工具栏/状态栏、代码块 `break-inside: avoid`、标题 `break-after: avoid`、链接显示 URL（`a::after { content: " (" attr(href) ")" }`）。
- 用户「另存为 PDF」。**零依赖、矢量文字、中文排版正确**，质量高于 canvas 截图的 jsPDF 方案。
- 只有当需求变成「程序化生成 PDF 文件（服务端/批量）」时才引入 `pdf-lib`。

---

## 10. 技术选型决策表

| 决策点 | 选择 | 否决了 | 理由 |
|--------|------|--------|------|
| 解析器 | **手写** | marked / remark 直接渲染 | 本项目目的就是学编译原理；同时 `marked` 装进 devDependencies 当**差分测试基准（oracle）**——拿真实文档对比我们和成熟实现的输出，这个用法比直接调用它有价值得多 |
| 编辑器内核 | **`textarea`** | CodeMirror 6 / Monaco | 重点在编译器而非编辑器内核；CM6 会引入 200KB+ 和一套自己的状态机，掩盖主线。P6 后可换 |
| 代码高亮 | **highlight.js**（按需注册 + 视口内执行） | Shiki（更准但 WASM 重、不适合浏览器实时）/ Prism | 用户指定技术栈；配合主题变量映射 |
| 状态管理 | **composable** | Pinia / Vuex | 单一状态源，无需 module 拆分 |
| 深/浅响应 | **`shallowRef`** | `ref` | AST 是整体替换，深层代理纯属浪费 |
| 虚拟滚动 | **`content-visibility: auto`** | vue-virtual-scroller | 浏览器原生，零 JS 零依赖，对块级 DOM 足够 |
| PDF | **`window.print()`** | jsPDF + html2canvas | 零依赖、矢量文字、中文正确；canvas 截图方案文字模糊且分页不可控 |
| 测试 | **Vitest**（项目已有 Vite） | Jest | 免配置 |
| 样式 | **原生 CSS + 变量** | Tailwind / Element Plus | 主题系统需要完全控制 CSS 变量作用域 |

---

## 11. 目录结构

```
myMdx/
├─ PLAN.md
├─ README.md                    # 含 benchmark 表格 + 架构图 + GIF
├─ index.html                   # 内联防闪白主题脚本
├─ package.json
├─ vite.config.ts
├─ benchmark/
│  ├─ corpus/                   # 10/50/100/300KB 测试文档
│  └─ run.ts                    # 全量 vs 增量 耗时对比 → Markdown 表格
├─ src/
│  ├─ core/                     # ★ 纯函数，零 DOM 零 Vue
│  │  ├─ types.ts               # AST / Token 类型定义
│  │  ├─ lexer.ts               # 行切分 + 行内 token 化 + flanking 规则
│  │  ├─ block-parser.ts        # 容器栈 + 叶子块
│  │  ├─ inline-parser.ts       # 分隔符栈 + 方括号栈 + 引用定义
│  │  ├─ index.ts               # parse(md) → AST 门面 + 引用表
│  │  ├─ incremental.ts         # 脏窗口 + 节点复用
│  │  ├─ renderer.ts            # AST → HTML string
│  │  ├─ sanitize.ts            # 输出转义（安全边界）
│  │  └─ highlight.ts           # 按需注册 + LRU 结果缓存
│  ├─ workers/
│  │  └─ parser.worker.ts
│  ├─ composables/
│  │  ├─ useEditor.ts           # 唯一状态源
│  │  ├─ useTheme.ts            # 三态主题
│  │  ├─ usePersist.ts          # localStorage 防抖存
│  │  ├─ useScrollSync.ts       # 双向锚点同步
│  │  └─ usePerf.ts             # mark/measure + 面板数据
│  ├─ components/
│  │  ├─ EditorPane.vue         # textarea + 行号栏
│  │  ├─ PreviewPane.vue        # 块级 v-for + v-html
│  │  ├─ Toolbar.vue
│  │  ├─ StatusBar.vue
│  │  ├─ Splitter.vue
│  │  └─ InspectorPanel.vue     # ★ Token/AST/耗时 可视化
│  ├─ styles/
│  │  ├─ theme.css              # CSS 变量 + 暗色
│  │  ├─ markdown.css           # 预览排版
│  │  ├─ highlight-map.css      # hljs token → CSS 变量
│  │  └─ print.css
│  ├─ App.vue
│  └─ main.ts
└─ tests/
   ├─ lexer.test.ts
   ├─ block-parser.test.ts
   ├─ inline-parser.test.ts
   ├─ incremental.fuzz.test.ts  # ★ 增量 === 全量
   └─ commonmark-subset.test.ts # 挑 ~60 条规范用例
```

---

## 12. 里程碑

每个阶段都有可运行产物，不做「全写完才能跑」。

### P0 · 骨架（0.5 天）
- Vite + Vue 3 + TS 初始化；三栏布局；CSS 变量主题 + 三态切换 + 防闪白脚本。
- **验收**：能切主题，刷新不闪白。

### P1 · 编译器核心（3~4 天，项目重心）
- `types.ts` → `lexer.ts` → `block-parser.ts` → `inline-parser.ts` → `renderer.ts`。
- 顺序：先段落/标题/代码块/引用/列表；再行内强调/代码/链接；最后表格/任务列表/删除线/自定义容器。
- 全程 TDD：先写 CommonMark 子集用例，再写实现。
- **验收**：`pnpm test` 全绿；随手贴一篇 README 渲染正确；`marked` 差分测试在语料上无差异（或差异已记录在「不支持」清单）。

### P2 · 实时预览 + 渲染层（1~2 天）
- `useEditor`（`shallowRef` AST）、`EditorPane`、`PreviewPane`（块级 `v-for :key=node.id` + `v-html`）、防抖、IME 处理。
- 安全：链接 `href` 过滤 `javascript:`，HTML 块默认转义或可选信任开关（trust boundary，不能省）。
- **验收**：中文输入流畅；打字无可感知延迟。

### P3 · 增量编译（2 天）
- `incremental.ts` + 双跑断言 + fuzz 测试 + 保守降级。
- **验收**：fuzz 2000 轮全绿；100KB 文档单次编辑解析 < 3ms。
- **实测**（`$env:BENCH=1; npx vitest run tests/bench.test.ts`，单次编辑 = 复用 3265 块 / 重解析 3 块 / 窗口 111 字符）：

  | 文档 | 块数 | 全量 | 增量 | 倍数 | 渲染 |
  |--|--|--|--|--|--|
  | 10KB | 340 | 7.52ms | 0.91ms | 8.3x | 1.8ms |
  | 49KB | 1644 | 15.93ms | 1.25ms | 12.7x | 6.1ms |
  | 98KB | 3268 | 21.56ms | 1.87ms | 11.5x | 5.9ms |
  | 293KB | 9592 | 64.65ms | 4.05ms | 15.9x | 28.8ms |

### P4 · 高亮 + 滚动同步 + Inspector（2 天）
- highlight.js 按需注册、视口内高亮、LRU 缓存、主题变量映射。
- 双向滚动锚点同步。
- Inspector 面板：Token 流 / AST 树 / 阶段耗时 / 缓存命中率。
- **验收**：滚动不抖、不高亮卡顿；Inspector 能点节点跳源码。
- **实施记录**：高亮按需注册 16 语言 + 20KB 上限 + 200 条 LRU（按键重渲染时不再重跑未改动代码块）；Inspector 为光标驱动（Token 流取光标所在段落/标题重跑 `scanInline`，AST 摊平成缩进行、点击回跳源码），耗时拆成 解析/渲染/合计 + 块复用率；滚动同步目前是单向（编辑器→预览），**视口内高亮与双向锚点暂缓**——`content-visibility: auto` 已经省掉屏外绘制，先按实测决定要不要再加。

### P5 · 持久化 + 导出 + UX 打磨（1.5 天）
- localStorage 自动保存（防抖 + flush + 配额处理）、恢复滚动位置。
- 导出 HTML（复用 Renderer）、导出 PDF（print 样式表）。
- 快捷键、状态栏、空状态、可拖拽分隔条、移动端 Tab 布局。
- **验收**：刷新内容与滚动位置都还在；导出的 HTML 单文件可独立打开且样式完整。
- **实施记录**：`src/core/export.ts` 用 `?raw` 把 `theme.css` + `markdown.css` 内联进单文件 HTML（离线可看，无外链）；PDF 走 `window.print()` + `src/styles/print.css`（打印时隐藏工具栏/编辑器/Inspector，代码块与表格 `break-inside: avoid`，链接后补真实 URL），打印前临时切浅色、`afterprint` 还原。UX：可拖拽分隔条（18%~82% 夹紧，移动端 `!important` 退回上下布局）、`Ctrl/⌘+S` 强制落盘 + toast、预览空状态、滚动位置只在 `pagehide` 写一次 localStorage（跟 scroll 事件写会拖慢滚动）。

### P6 · 度量与包装（1~2 天）
- `benchmark/run.ts` 出数据表格；README（架构图 + GIF + benchmark + 「不支持」清单 + 设计决策记录）。
- 部署到 GitHub Pages / Vercel。
- **验收**：README 里有一张真实的性能对比表。

**总计约 11~14 个工作日。**

---

## 13. 测试策略

| 层 | 方式 | 内容 |
|----|------|------|
| 解析器 | Vitest 单元 | CommonMark 子集约 60 条；边界用例（空文档、只有空行、未闭合 fence、嵌套三层引用、列表懒续行、`a*b*c` vs `*a*b*`） |
| 差分 | 对比 `marked` | 真实语料（挑 20 篇真实 README）批量比对 HTML 输出 |
| 增量 | fuzz + 不变量 | 随机编辑 2000 轮，断言增量 AST === 全量 AST |
| 渲染 | 冒烟 | 导出 HTML 能独立打开；print 样式无断裂 |
| 性能 | 脚本 | benchmark 出表，控制在 CI 里跑（只报数不设阈值，避免 flaky） |

---

## 14. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 手写 CommonMark 极易踩边界坑 | 陷入细节泥潭 | 明确「子集」范围，列出不支持清单；用 marked 做差分，发现差异先记录再决定修不修 |
| 增量编译「快但错」 | 数据/渲染错误 | 双跑断言 + fuzz 不变量 + 全局语义变化时回退全量 |
| `v-html` 的 XSS | 安全 | 输出统一走 `sanitize.ts`（转义 raw HTML 或白名单），链接协议过滤 |
| highlight.js 体积 | 首屏慢 | 只注册 10 种语言；大代码块延迟到视口内 |
| 滚动同步抖动 | 体验差 | 方向锁 + 缓存锚点 + `rAF` 节流 |
| 范围蔓延（想加 WYSIWYG/协作） | 做不完 | §1.3 的「不做」清单是硬约束 |

---

## 15. 简历与面试包装

### 15.1 简历写法（数字按实测，与 README 一致）

> **myMdx — 手写编译器的实时 Markdown 编辑器**（Vue3 / TS / Vite）
> · 独立实现 Markdown 编译器四段管线：字符级 Lexer → 递归下降 Block Parser → 分隔符贪心配对的 Inline Parser → 渲染器，AST 全节点带源码位置；支持 GFM 表格/任务列表/自定义容器，54 条测试（含与 marked 的差分测试）。
> · 设计**块级增量编译**：用 AST 位置信息定位最小重编译窗口（窗口两端各带一格守卫块，可用空栈独立解析、与全量等价），未变更节点引用复用；98KB 文档单次编辑解析 21.6ms → 1.9ms（11.5x，重解析 3/3268 块），并有 2000 轮 fuzz 断言增量 AST 恒等于全量。
> · 渲染侧：`shallowRef` 存 AST 避免上万个节点的深度代理、highlight.js 按需注册 16 语言 + LRU 缓存、首帧前定主题做到零闪白；解析过程可视化面板（Token 流 / AST / 分段耗时 / 块复用率）可直接定位性能瓶颈。
> · 体验细节：可拖拽分隔条、编辑器→预览滚动同步、`execCommand` 写回保住原生撤销栈、自动保存只写一次（`pagehide`）、零依赖单文件 HTML 导出与打印式 PDF。

> 简历口径提醒：Worker 卸载、视口内高亮、双向滚动锚点、节点身份 `:key` 本期**没做**，写简历时别带；本 README 的「明确不做的」清单正好是面试里被追问时的答案。

### 15.2 面试预期追问（提前准备答案）

1. **为什么不用 marked？** → 目的是学编译原理；且我在测试里用 marked 做差分 oracle，比自己写个壳去调它更有价值。
2. **行内强调怎么处理交叉嵌套？** → 分隔符栈，先 token 化再配对，讲清 `***a***` 和三重规则的消耗顺序。
3. **增量怎么保证正确？** → 脏窗口边界取顶层块边界（容器栈为空处可独立解析）→ 可证等价；再加 fuzz 不变量测试和引用定义变更时的全量回退。
4. **为什么不虚拟滚动？** → 原生 `content-visibility: auto` 已经覆盖块级场景，省掉一个依赖和一套定位逻辑；什么时候不该用（块高度不稳定导致滚动条跳动）我也清楚。
5. **Worker 为什么只在大文档用？** → AST 结构化克隆有成本，实测小文档走 Worker 反而更慢，设了 50KB 阈值。
6. **最难的地方？** → 列表懒续行 + 容器栈的延续条件判定；以及增量窗口的守卫块合并。

---

## 16. 后续扩展（按成本排序，均不在本期）

1. **多文档管理**（localStorage → IndexedDB）
2. **大纲 / TOC 侧栏**（遍历 AST 标题节点，成本极低，AST 现成）
3. **图片粘贴 → base64 内嵌**（配 IndexedDB 存 blob）
4. **数学公式**（KaTeX 接入，在 Inline Parser 加 `$...$` token）
5. **CodeMirror 6 替换 textarea**（语法高亮编辑区 + 折叠）
6. **markdown → DOCX / 终端 ANSI 渲染器**（验证 AST 抽象的通用性，最能体现架构设计能力）
7. **插件系统**：自定义语法通过注册 block/inline 扩展实现（本项目 `::: note` 已铺路）
8. **云同步 / 协作（CRDT）** —— 成本最高，仅当要转全栈时做

---

## 17. MDX 版本（v2 独立项目 · 本期不实现）

> **状态：已决策拆分为第二个项目，不进入本期开发。**
> 本节保留为 v2 的设计输入。本期交付纯 Markdown 编辑器（§1~§16）；完成后打 tag `v1-markdown` 冻结基线，另起分支/仓库做 MDX 版。

### 17.1 定位

它不是范围蔓延，而是把项目从「解析器」升级成「编译器」：§3 只有 frontend（lex / parse / AST），MDX 逼你补上 **codegen + 求值**，这才是完整编译链路。对「学编译原理」是直线前进。

但**不能一步到位**。风险是做出「半残 MDX」：既丢了 Markdown 编辑器的完整度，又没拿到 MDX 的深度。所以分层交付，Markdown 版必须能独立跑通并打 tag。

### 17.2 支持范围（MDX-Lite，边界写死）

✅ 支持
- `{expr}` 行内与块级表达式
- JSX 元素与属性：`<Foo a="s" b={1} c />`（暂不做 spread `{...props}`）
- JSX children 内写 Markdown（真实 MDX 的核心特性，两套语法嵌套的地方，最有意思）
- `import` / `export` 语句：解析进模块表，通过白名单注册表解析
- 大小写标签分派：小写 → HTML 标签，大写 → 组件注册表

❌ 不支持（写进 README 的「不支持清单」）
- 真实 ESM 模块解析 / 远程 import
- `export default` 元数据导出
- Fragments `<>...</>`、spread 属性

**简历上写「MDX 子集编译器」并列出范围，不要写「完整兼容 MDX」** —— 真实 MDX 包含 ESM 模块解析，被追问会露馅。标注边界反而是加分项。

### 17.3 三个必须先拍的设计决策

**① 求值：自写 tree-walking 解释器，禁用 `eval` / `new Function`**

`acorn` + `acorn-jsx` 把表达式解析成 ESTree → 自己写求值器，覆盖：字面量、标识符→作用域查表、二元/逻辑/一元/条件、成员访问、函数调用、模板字符串、数组/对象字面量、箭头函数。约 250~350 行。防护：求值深度上限 200、表达式长度上限，防递归炸栈。

三条连带收益，是这个决策真正的分量：
- **不需要 sandbox iframe、不需要 eval** → 仍在主文档渲染 → `@media print` 的零依赖 PDF 导出继续有效。一旦用 `new Function` 就必须进 iframe 隔离，PDF 立刻变麻烦。
- 安全边界由「语法白名单」决定，而不是靠沙箱兜底：求值器不认识 `globalThis`、`eval`、`Function`、`new`，天然跑不出去。
- 学习收益：项目里同时有了 lexer + parser + **evaluator**，编译原理的「解释执行」一环补齐。

*可替换缝*：接口是 `expr 源码 → ESTree`，之后想多学一个经典算法，可以把 acorn 换成自写 **Pratt 解析器**（运算符优先级爬升），+2~3 天，接口不变。

**② 代码生成目标：直接产 VNode，不拼字符串**

`AST → Vue h() 调用树`。静态 Markdown 子树仍走「HTML 字符串 + innerHTML」快路径（便宜、可缓存），只有含 JSX / 表达式的子树走 VNode 路径。

→ 块级天然分成 **静态块 / 动态块**。这不破坏增量引擎，反而让它更有说服力：动态块缓存 key = (表达式源码, 作用域版本号)，作用域不变就不重算。

**③ 组件作用域：显式白名单**

`src/mdx/registry.ts` 导出 `{ name: Component }`。`import` 只解析不执行（进模块表），渲染时按名查表；查不到 → 编译错误。不用碰真实模块解析。

### 17.4 对既有设计的影响（逐条，都是硬代价）

| 模块 | 变化 |
|------|------|
| 增量引擎（§4） | 脏窗口边界条件由「容器栈为空」加一条 → **容器栈为空 且 花括号/标签嵌套深度为 0**（JSX 可跨行，不平衡就不能独立重解析）。ESM 模块表与链接引用定义同类：`import/export` 一变 → 全局失效，回退全量 |
| 安全（§13） | `sanitize.ts` 对纯 Markdown 路径仍有效；MDX 路径靠求值器语法白名单。威胁模型必须写进文档：**MDX 文档本身是可执行代码**，所以未知 import 一律不生效 |
| UX（新增，必须做） | **编译错误面板**：行列定位 + 源区红色波浪线 + 人话信息（「未知组件 `<Foo>`」「表达式缺少 `}`」「不支持 `new Date()`」）。**错误恢复：单块编译失败只把该块降级为代码块显示，不炸整个预览** —— 错误恢复质量本身就是编译器工程水平的体现，可讲 |
| PDF（§9.3） | 因不走 iframe，`window.print()` 方案保留；`@media print` 需额外处理动态块（打印前强制求值一次、组件渲染为静态形态） |
| 工作量 | **+4~6 个工作日**，作为 **P2.5**，不打断 Markdown 主线 |
| 新增创新点 | 静态/动态块分离 + 表达式求值缓存 + 语法级安全边界（无 eval 的可执行文档） |

### 17.5 两个项目的切分（关键）

```
项目 A（本期）：myMdx        P0 骨架 → P1 解析器 → P2 实时预览 → P3 增量编译
                            → P4 高亮/滚动/Inspector → P5 持久化/导出 → P6 度量包装
                            交付后打 tag v1-markdown，作为 v2 的基线
        ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
项目 B（后续）：myMdx-pro    acorn 接入 → {expr} → JSX 块 → 求值器 → 组件分派 → 错误 UI
                            在 v1 分支上叠加，增量引擎此时要加花括号平衡条件
```

这样切分的两个好处：
1. 项目 A 的完整度不受 v2 拖累，随时可交付、可写简历。
2. 项目 B 有真实起点对比（同一份代码前后），简历上可以写成「在 v1 基础上将解析器升级为编译器」，故事比单版本更完整。

### 17.6 简历话术升级

> **myMdx — MDX 子集编译器与实时编辑器**（Vue3 / TS / Vite）
> · 独立实现 MDX 子集编译器：手写 Markdown 前端（字符状态机 + 容器栈 + 分隔符栈）与 JSX 嵌入语法融合，输出带源码位置的 AST；接入 acorn 解析表达式并实现 **tree-walking 求值器**（不使用 `eval`/`new Function`，安全边界由语法白名单保证），完成 AST → Vue VNode 代码生成。
> · 编译器按静态/动态块分类：静态子树编译为可缓存 HTML，动态子树按作用域版本号增量求值；配合块级增量编译，100KB 文档单次编辑从 ~30ms 降至 ~2ms。
> · 编译错误行列定位与块级错误恢复（单块失败降级为代码块，不中断整篇渲染）；内置 Token / AST / 耗时可视化面板。
> · 体验层：中文 IME 合成处理、双向滚动锚点同步、零闪白主题切换、零依赖矢量 PDF 导出。

---

## 附：已锁定的决策（2026-10-27）

原则：**怎么简单上手怎么来。** 遇到底层选择一律取「最少依赖 + 最少概念」的那条，把精力全部投给解析器与性能工程。

| # | 决策 | 结论 | 影响 |
|---|------|------|------|
| 1 | 编辑器内核 | **`textarea`** | 不引 CodeMirror。行号栏自绘，专注编译器主线 |
| 2 | CommonMark 范围 | **核心子集 + 表格/任务列表/删除线/自定义容器** | 不追求完整合规；README 列出「不支持清单」，用 marked 做差分测试兜底 |
| 3 | 导出 PDF | **`window.print()` + `@media print`** | 零依赖、矢量文字、中文排版正确。不引 jsPDF |
| 4 | MDX | **拆成第二个独立项目**，本期不做 | 本期只交付纯 Markdown 编辑器，完成后打 tag `v1-markdown` |

由此产生的硬约束（开发时不再回头讨论）：
- 不引入 Pinia / UI 组件库 / 虚拟滚动库 / diff 库 / jsPDF / CodeMirror
- 运行时依赖只有 `vue` + `highlight.js`；`marked` 仅进 devDependencies 作测试基准
- 包管理器用 **npm**（本机无 pnpm），Node 22.14.0
