// 02-real.png: each state's board frame (01-board.html) beside the real page's shot of it (capture.mjs).
// Usage: node compose.mjs <worktree> <shotsDir> <out.png> <dockWidthPx> <breakpointPx>
import { readFileSync, writeFileSync } from 'node:fs';
const [W, SHOTS, OUT, DOCK_W, BREAK] = process.argv.slice(2);
const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const BOARD = `${W}/docs/mocks/task-run-sidebar/01-board.html`;
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/nwf-cap/fonts.conf' } });

// The board's frames: ② Failed (the window with the column), ③ Running, ④ Needs you, ⑤ Done.
const b = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
await b.goto(`file://${BOARD}`);
await b.evaluate(() => document.fonts.ready);
await b.evaluate(() => window.drawMarks && window.drawMarks());
await b.locator('#after').screenshot({ path: `${SHOTS}/board-failed.png` });
await b.locator('#today').screenshot({ path: `${SHOTS}/board-today.png` });
const wins = b.locator('#part-2 .w-win');
for (const [i, name] of ['running', 'needsYou', 'done'].entries()) await wins.nth(i).screenshot({ path: `${SHOTS}/board-${name}.png` });
await b.close();

// One scale for the board and the page: each image at its own CSS width (both were shot at 2x).
const boxes = JSON.parse(readFileSync(`${SHOTS}/boxes.json`, 'utf8'));
const COLUMN_W = Math.round(boxes.running.panel.width);
const FAILED_W = Math.round(boxes.failed.panel.x + boxes.failed.panel.width - boxes.failed.main.x + 8);
const NARROW_W = 1500;
const img = (f, w) => `<img src="file://${SHOTS}/${f}" style="width:${w}px">`;
const pair = (label, board, real, bw, rw) => `
  <div class="pair">
    <p class="cap">${label}</p>
    <div class="imgs"><figure>${img(board, bw)}<figcaption>设计稿 01-board</figcaption></figure>
    <figure>${img(real, rw)}<figcaption>真实页面（本分支的 web 构建）</figcaption></figure></div>
  </div>`;
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
  body { margin: 0; background: #f3f4f6; color: #1f2329; font: 15px/1.6 Inter, "Noto Sans SC", sans-serif; }
  .b-part { padding: 36px 44px 44px; width: max-content; }
  h1 { font-size: 28px; margin: 0 0 6px; } .sub { color: #5b6270; margin: 0 0 24px; max-width: 1600px; }
  .row { display: flex; gap: 36px; align-items: flex-start; margin-bottom: 30px; }
  .cap { font-weight: 600; margin: 0 0 8px; } .imgs { display: flex; gap: 14px; align-items: flex-start; }
  figure { margin: 0; } figure img { display: block; border-radius: 12px; box-shadow: 0 2px 14px rgba(0,0,0,.08); background: #fff; }
  figcaption { color: #8a909c; font-size: 13px; margin-top: 6px; }
</style><section class="b-part" id="part-real">
  <h1>任务侧栏：真实页面 vs 设计稿（Failed / Running / Needs you / Done）</h1>
  <p class="sub">右边都是真实页面截图：本分支 vite 构建 + ui-migration 假数据，任务自己的运行会话，窗口 1720px（停靠门槛 ${BREAK}px），什么都没点——侧栏默认打开（D2 = B），宽 ${DOCK_W}px。示例数据，不是真实任务。</p>
  <div class="row">${pair('② Failed · 停靠在会话右侧', 'board-failed.png', 'failed-dock.png', 820 * 0.9, FAILED_W * 0.9)}</div>
  <div class="row">
    ${pair('③ Running', 'board-running.png', 'running-column.png', 400, COLUMN_W)}
    ${pair('④ Needs you', 'board-needsYou.png', 'needsYou-column.png', 400, COLUMN_W)}
    ${pair('⑤ Done', 'board-done.png', 'done-column.png', 400, COLUMN_W)}
  </div>
  <div class="row">${pair('窗口窄于 ' + BREAK + 'px（这里 1500px）· 退回今天的浮层（同 ① 今天）：不自动打开，按「Task ›」才出现', 'board-today.png', 'narrow-window.png', 820 * 0.9, NARROW_W * 0.9)}</div>
</section></html>`;
writeFileSync(`${SHOTS}/compose.html`, html);
const p = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
await p.goto(`file://${SHOTS}/compose.html`);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
await p.locator('#part-real').screenshot({ path: OUT });
await browser.close();
