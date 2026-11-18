import { chromium } from '/root/.orbit/worktrees/01a1a9a9-a2b3-726e-a6c5-a3cf6e09d200/node_modules/playwright-core/index.mjs';
const [, , board, outDir] = process.argv;
const b = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/tmp/d-fonts/fonts.conf' } });
const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 1500, height: 1000 } });
await p.goto('file://' + board);
await p.evaluate(() => document.fonts.ready);
await p.evaluate(() => window.drawMarks && window.drawMarks());
for (const id of ['part-1', 'part-2', 'part-3', 'part-4'])
  await p.locator('#' + id).screenshot({ path: `${outDir}/01-${id}.png` });
await b.close();
