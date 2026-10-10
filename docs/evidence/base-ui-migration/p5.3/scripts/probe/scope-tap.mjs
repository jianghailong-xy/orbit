export default async function (page) {
  await page.locator('.workspace-back, .session-pane-back, button[aria-label^="Back"]').first().tap();
  await page.waitForTimeout(600);
  await page.locator('.session-scope-menu').tap();
  await page.waitForTimeout(600);
  await page.locator('[role="menuitem"]').filter({ hasText: 'Filter by Tag' }).filter({ visible: true }).first().tap();
  await page.waitForTimeout(600);
  await page.locator('[role="menuitem"]').filter({ hasText: 'Ops' }).filter({ visible: true }).first().tap();
  const out = [];
  for (const ms of [300, 700, 1500]) {
    await page.waitForTimeout(ms);
    out.push(await page.evaluate(() => ({ menus: [...document.querySelectorAll('[role=menu]')].filter((m) => m.getBoundingClientRect().width > 0).map((m) => (m.textContent || '').slice(0, 30)),
      flaky: [...document.querySelectorAll('.session-col .session-row')].filter((r) => r.textContent.includes('Fix the flaky upload test')).length,
      scope: document.querySelector('.session-scope-menu')?.textContent })));
  }
  console.log(JSON.stringify(out, null, 1));
}
