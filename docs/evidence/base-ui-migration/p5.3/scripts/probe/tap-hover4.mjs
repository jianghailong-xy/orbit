export default async function (page) {
  await page.locator('.workspace-back, .session-pane-back, button[aria-label^="Back"]').first().tap();
  await page.waitForTimeout(600);
  await page.locator('.session-scope-menu').tap();
  await page.waitForTimeout(600);
  const row = page.locator('[role="menuitem"]').filter({ hasText: 'Filter by Tag' }).filter({ visible: true }).first();
  await row.tap();
  const out = [];
  for (const ms of [100, 300, 600]) {
    await page.waitForTimeout(ms);
    out.push(await page.evaluate(() => {
      const r = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes('Filter by Tag') && e.getBoundingClientRect().width > 0);
      return { hover: r.matches(':hover'), bg: getComputedStyle(r).backgroundColor, cls: String(r.className).slice(0, 120), open: r.getAttribute('data-popup-open'), hl: r.getAttribute('data-highlighted') };
    }));
  }
  console.log(JSON.stringify(out, null, 1));
}
