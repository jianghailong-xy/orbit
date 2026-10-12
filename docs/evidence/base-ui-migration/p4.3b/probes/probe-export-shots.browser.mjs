import { test, expect } from '@playwright/test';

// Probe: the exported session file (exportCardsProbe.test.tsx wrote it on each tree: buildSessionHtml with the
// tree's index.css and highlight.js's theme inlined, as the production `?raw` imports do) opened from disk in
// this project's browser, viewport and theme, a full-page screenshot to EXPORT_SHOTS/<tree>/<project>.png and
// the computed styles of the returned-review card's parts.
test('the exported file with a returned review', async ({ page }, testInfo) => {
  const theme = testInfo.project.use.colorScheme;
  await page.goto(`file://${process.env.EXPORT_DIR}/${process.env.TREE}/returned-${theme}.html`);
  const card = page.locator('.crc.is-returned');
  await expect(card).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const styles = await page.evaluate(() => Object.fromEntries(['.crc', '.crc-head', '.crc-mark', '.crc-who a', '.crc-quote', '.crc-problems li', '.crc-problem-label', '.chat-assistant, .md'].map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return [sel, null];
    const s = getComputedStyle(el);
    return [sel, ['display', 'color', 'backgroundColor', 'border', 'borderRadius', 'padding', 'margin', 'fontSize', 'fontWeight', 'lineHeight', 'gap'].map((p) => s[p]).join(' | ')];
  })));
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} export ${JSON.stringify(styles)}`);
  await page.screenshot({ path: `${process.env.EXPORT_SHOTS}/${process.env.TREE}/${testInfo.project.name}.png`, fullPage: true });
});
