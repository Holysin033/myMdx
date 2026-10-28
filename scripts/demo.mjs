// 录制演示 GIF 的帧序列：驱动真实 Edge 操作真实页面，逐帧截图到 docs/frames/
// 用法：node scripts/demo.mjs   （需要 dev server 已在 5173 运行）
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.env.DEMO_URL ?? 'http://localhost:5173';
const EDGE =
  process.env.DEMO_BROWSER ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('docs/frames');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'networkidle2' });

let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(hold = 1) {
  for (let i = 0; i < hold; i++) {
    await page.screenshot({
      path: path.join(OUT, `${String(n++).padStart(3, '0')}.jpg`),
      type: 'jpeg',
      quality: 88,
    });
    await sleep(70);
  }
}

// 1. 首屏：内置示例文档已经渲染好
await sleep(400);
await shot(4);

// 2. 定位到文末，输入一段新内容（增量编译在这时生效）
await page.click('.editor');
await page.keyboard.down('Control');
await page.keyboard.press('End');
await page.keyboard.up('Control');
await shot(1);

const typing = '\n\n## 增量编译\n\n单次按键只重新解析脏窗口，其余块直接复用。\n';
for (let i = 0; i < typing.length; i += 2) {
  await page.keyboard.type(typing.slice(i, i + 2));
  if (i % 6 === 0) await shot(1);
}

// 3. 打开 Inspector：左侧 token 流、中间 AST、右侧分段耗时
await page.click('.inspector-toggle');
await shot(1);
// 把光标放进第一个正文段落，让 TOKEN 流面板有内容（程序化选区 + 触发 keyup）
await page.evaluate(() => {
  const ta = document.querySelector('.editor');
  const i = ta.value.indexOf('一个**手写编译器**');
  ta.focus();
  ta.setSelectionRange(i + 2, i + 2);
  ta.scrollTop = 0;
  window.scrollTo(0, 0);
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
});
await sleep(250);
await shot(4);

// 4. 切到暗色主题
const buttons = await page.$$('.toolbar button');
const themeBtn = buttons[buttons.length - 1];
await themeBtn.click();
await sleep(120);
await themeBtn.click();
await sleep(200);
await shot(4);

// 5. Ctrl+S 触发保存提示
await page.keyboard.down('Control');
await page.keyboard.press('KeyS');
await page.keyboard.up('Control');
await sleep(120);
await shot(3);
await sleep(1400);
await shot(4);

await browser.close();
console.log(`frames: ${n} → ${OUT}`);
