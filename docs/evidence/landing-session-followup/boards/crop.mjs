// Crops the v4 board frames the follow-up's screenshots are compared with (task 34jBwFmcEPK012TsNL0Lc):
// each target is found by its words or by a CSS selector, then cut at its frame-sized ancestor.
//   WT=<worktree> OUT=<dir> FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf node crop.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = process.env.WT ?? path.resolve(HERE, '../../../..');
const OUT = process.env.OUT ?? HERE;
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const V4 = `${WT}/docs/mocks/landing-session/v4`;
fs.mkdirSync(OUT, { recursive: true });

// [board, { text } | { selector }, names]
const TARGETS = [
  ['04-project-sessions-page.html', { text: 'Earlier · 31 landed' }, ['04-c1-earlier-ios', '04-c1-earlier-web']],
  ['04-project-sessions-page.html', { text: 'Merges on its own when it passes.' }, ['04-merge-check-row-a', '04-merge-check-row-b']],
  ['04-project-sessions-page.html', { text: 'Nothing to do — it lands on its own.' }, ['04-task-card-a', '04-task-card-b']],
  ['05-landing-session-page.html', { selector: '.cap4.red' }, ['05-abandon-light-a', '05-abandon-light-b', '05-abandon-light-c']],
  ['05-landing-session-page.html', { selector: '.wsec4.red' }, ['05-abandon-web']],
  ['05-landing-session-page.html', { text: 'round 1 of 3' }, ['05-round-a', '05-round-b']],
  ['06-list-chat-task.html', { text: 'round 1 of 3' }, ['06-c-xe5-ios', '06-c-xe5-web']],
  ['06-list-chat-task.html', { selector: '.chip4.run' }, ['06-e-source-label']],
  ['07-android.html', { text: 'Earlier · 31 landed' }, ['07-earlier']],
  ['07-android.html', { text: 'round 1 of 3' }, ['07-round-a', '07-round-b']],
];

const browser = await chromium.launch();
const report = [];
for (const [file, target, names] of TARGETS) {
  const page = await browser.newPage({ viewport: { width: 2648, height: 1600 }, deviceScaleFactor: 1 });
  await page.goto(`file://${V4}/${file}`);
  await page.waitForTimeout(800);
  const boxes = await page.evaluate(({ text, selector }) => {
    const starts = [];
    if (selector) {
      document.querySelectorAll(selector).forEach((el) => starts.push(el));
    } else {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (walker.currentNode.textContent.includes(text)) starts.push(walker.currentNode.parentElement);
    }
    const out = []; const seen = new Set();
    for (let el of starts) {
      while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r.width >= 340 && r.height >= 380 && r.width <= 1500) break;
        el = el.parentElement;
      }
      if (!el || el === document.body || seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      out.push({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: Math.min(r.height, 2400) });
    }
    return out;
  }, target);
  for (let i = 0; i < Math.min(boxes.length, names.length); i++) {
    await page.screenshot({ path: `${OUT}/${names[i]}.png`, clip: boxes[i], fullPage: true });
    report.push({ file, ...target, name: names[i], box: boxes[i] });
  }
  report.push({ file, ...target, found: boxes.length });
  await page.close();
}
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
