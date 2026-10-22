// The design board's own frames, cut out of board.html (7cf74c6ea) as the board render draws them —
// Inter + Noto Sans SC, the shipped index.css — so each can stand beside its real-page frame.
// Writes board/<name>.png.
import { mkdirSync } from 'node:fs';

const WT = '/root/.orbit/worktrees/1c3c7f6d-70e6-51a2-b06b-004d60e5ea8e';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const BOARD = 'file:///var/tmp/34hIEi97-web/before/docs/mocks/watching-session-into-tasks/board.html';
const OUT = '/mnt/data/tmp/34hIEi97/web-shots/board';
mkdirSync(OUT, { recursive: true });

const CROPS = {
  '1-today': '#part-1 .b-grid > figure:nth-of-type(1) .b-pane',
  '2-folded': '#part-1 .b-grid > figure:nth-of-type(2) .b-pane',
  '3-opened': '#part-2 .b-grid > figure:nth-of-type(1) .b-pane',
  'a-elsewhere': '#part-2 .b-case:nth-of-type(1) .b-mini',
  'b-unchecked': '#part-2 .b-case:nth-of-type(2) .b-mini',
  'c-words': '#part-2 .b-case:nth-of-type(3) .b-pair',
  'A-child': '#part-3 .b-grid > figure:nth-of-type(1) .b-pane',
};

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' } });
try {
  const page = await browser.newPage({ viewport: { width: 1640, height: 1200 }, deviceScaleFactor: 2 });
  await page.goto(BOARD, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  for (const [name, selector] of Object.entries(CROPS)) {
    const el = page.locator(selector).first();
    await el.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name, JSON.stringify(await el.evaluate((e) => e.getBoundingClientRect().toJSON())));
  }
} finally {
  await browser.close();
}
