// Renders docs/mocks/attached-context-note/board.html: each #part-N into its own PNG (easier to read on a
// phone than one long board), at 2x, with Inter + Noto Sans SC.
const WT = '/root/.orbit/worktrees/01a17c4a-2917-730f-b47a-4da0f9b5cd27';
const DIR = `${WT}/docs/mocks/attached-context-note`;
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);

// node render.mjs [board.html] [part-name,part-name,…]: #part-N is written to the N-th name.
const BOARD = process.argv[2] ?? 'board.html';
const PARTS = process.argv[3]?.split(',')
  ?? ['01-today-vs-line', '02-whole-page', '03-opened', '04-elsewhere', '05-dark-phone', '06-decide-a-or-b', '07-rollout'];

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' } });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`file://${DIR}/${BOARD}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  });
  const broken = await page.evaluate(() => [...document.images].filter((img) => !img.naturalWidth).map((img) => img.src));
  if (broken.length) throw new Error(`images missing: ${broken.join(', ')}`);
  for (const [i, name] of PARTS.entries()) {
    const part = page.locator(`#part-${i + 1}`);
    const box = await part.boundingBox();
    // Element screenshots are cropped at the viewport: grow it to the part's bottom first.
    await page.setViewportSize({ width: 1440, height: Math.ceil(box.y + box.height + 20) });
    await part.screenshot({ path: `${DIR}/${name}.png` });
    console.log(name, Math.round(box.width), 'x', Math.round(box.height));
  }
} finally {
  await browser.close();
}
