export default async function (page) {
  await page.locator('.workspace-back, .session-pane-back, button[aria-label^="Back"]').first().tap();
  await page.waitForTimeout(600);
  await page.locator('.session-scope-menu').tap();
  await page.waitForTimeout(600);
  await page.locator('[role="menuitem"]').filter({ hasText: 'Filter by Tag' }).filter({ visible: true }).first().tap();
  await page.waitForTimeout(600);
  await page.locator('[role="menuitem"]').filter({ hasText: 'Ops' }).filter({ visible: true }).first().tap();
  await page.waitForTimeout(800);
  const menus = () => page.evaluate(() => [...document.querySelectorAll('[role=menu]')].filter((m) => m.getBoundingClientRect().width > 0).map((m) => (m.textContent || '').slice(0, 30)));
  const a = await menus();
  await page.touchscreen.tap(30, 820);
  await page.waitForTimeout(800);
  const b = await menus();
  await page.locator('.session-scope-menu').tap();
  await page.waitForTimeout(600);
  const c = await menus();
  console.log(JSON.stringify({ afterOps: a, afterTapOutside: b, reopened: c }));
}
