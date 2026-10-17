// Side-by-side boards: the design board's frame on the left, the real web page on the right, one PNG
// per board part. Images are 2x captures, drawn at half their pixel size (srcset 2x).
// Writes out/compare-<n>-<name>.png and out/compare.html.
import { mkdirSync, writeFileSync } from 'node:fs';

const WT = '/root/.orbit/worktrees/1c3c7f6d-70e6-51a2-b06b-004d60e5ea8e';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const HERE = '/mnt/data/tmp/34hIEi97/web-shots';
const OUT = `${HERE}/out`;
mkdirSync(OUT, { recursive: true });

const img = (path, caption) => `<figure><img srcset="file://${HERE}/${path} 2x"><figcaption>${caption}</figcaption></figure>`;
const BEFORE = 'Real page, main eb3fb67fa (before this change)';
const AFTER = 'Real page, this change';

const PARTS = [
  ['1-today', '① Today: one task drawn twice', 'The owner’s case: a task_await on the task and a session_await on its run session. Main draws a Watching strip for the run session and an eye in Tasks for the task.',
    [img('board/1-today.png', 'Board ① (7cf74c6ea)')], [img('shots/owner-before-folded.png', BEFORE)]],
  ['2-folded', '② Folded: the Watching strip is gone, the Tasks line is unchanged', 'Same watches. The run session counts as its task, so no Watching strip; Tasks still reads 👁 1 · 1 running · 1/2 done.',
    [img('board/2-folded.png', 'Board ② (7cf74c6ea)')], [img('shots/owner-after-folded.png', AFTER)]],
  ['3-opened', '③ Opened: two waits, one row, one eye', 'Same watches, the Tasks card opened: the task’s row carries one eye, waited on first.',
    [img('board/3-opened.png', 'Board ③ (7cf74c6ea)')], [img('shots/owner-after-opened.png', AFTER)]],
  ['a-elsewhere', 'a · The run of a task created elsewhere', 'A session_await on the run session of a task this session did not create: an elsewhere row, by the task’s own title and pill, never the session’s “Task: …”.',
    [img('board/a-elsewhere.png', 'Board case a (7cf74c6ea)')],
    [img('shots/elsewhere-before-folded.png', `Today — ${BEFORE}`), img('shots/elsewhere-after-opened.png', `Proposed (opened) — ${AFTER}`)]],
  ['b-unchecked', 'b · An unchecked run-session watch', 'The session_await has not been checked for 12 minutes: the header’s eye and the row’s eye turn orange, and the line moves to the top of the opened Tasks list.',
    [img('board/b-unchecked.png', 'Board case b (7cf74c6ea)')],
    [img('shots/stale-after-folded.png', `Folded — ${AFTER}`), img('shots/stale-after-opened.png', `Opened — ${AFTER}`)]],
  ['c-words', 'c · The session list row and the header’s word', 'The owner’s case. The list row names the one target left; the header counts a task and its run session as one target, as the server’s link-preview tally does. The Following chip still says the watches as they were made.',
    [img('board/c-words.png', 'Board case c (7cf74c6ea)')],
    [img('shots/words-before-row.png', `Today — ${BEFORE}`), img('shots/words-before-header.png', 'Today — header'),
     img('shots/words-after-row.png', `Proposed — ${AFTER}`), img('shots/words-after-header.png', 'Proposed — header')]],
  ['A-child', 'A · A child session that runs no task stays in Watching', 'A task_await on the task and a session_await on a deploy session that runs no task (targetTask null): the Watching strip is exactly as before.',
    [img('board/A-child.png', 'Board, option A (7cf74c6ea)')],
    [img('shots/child-before-folded.png', BEFORE), img('shots/child-after-folded.png', AFTER)]],
];

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Watching session into Tasks — board vs real page</title>
<style>
  body { margin: 0; padding: 28px; background: #e9e9ee; font: 15px/1.55 "Inter", "Noto Sans SC", sans-serif; color: #16161a; width: 1560px; box-sizing: border-box; }
  section { background: #f7f7f9; border-radius: 22px; padding: 24px 28px 28px; }
  section + section { margin-top: 26px; }
  h2 { margin: 0 0 4px; font-size: 21px; }
  p.lede { margin: 0 0 16px; color: #4d4d56; max-width: 1400px; }
  .pair { display: grid; grid-template-columns: 740px 1fr; gap: 28px; align-items: start; }
  .col > h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: .03em; text-transform: uppercase; color: #8a8a94; }
  figure { margin: 0 0 14px; }
  figure img { display: block; border: 1px solid #d5d8dd; border-radius: 10px; background: #fff; max-width: 100%; height: auto; }
  figcaption { font-size: 12.5px; color: #6b6b75; margin-top: 5px; }
</style></head><body>
${PARTS.map(([key, title, lede, board, real]) => `<section id="${key}"><h2>${title}</h2><p class="lede">${lede}</p>
<div class="pair"><div class="col"><h3>Design board</h3>${board.join('')}</div><div class="col"><h3>Real web page</h3>${real.join('')}</div></div></section>`).join('\n')}
</body></html>`;
writeFileSync(`${OUT}/compare.html`, html);

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' } });
try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 1200 }, deviceScaleFactor: 1 });
  await page.goto(`file://${OUT}/compare.html`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
  const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.currentSrc));
  if (broken.length) throw new Error(`images that did not load: ${broken.join(', ')}`);
  let n = 1;
  for (const [key] of PARTS) {
    await page.locator(`[id="${key}"]`).first().screenshot({ path: `${OUT}/compare-${n}-${key}.png` });
    console.log(`compare-${n}-${key}.png`);
    n += 1;
  }
} finally {
  await browser.close();
}
