export default async function (page) {
  await page.locator('.composer-model-chip').tap();
  await page.waitForTimeout(500);
  await page.locator('[role="menu"]').filter({ visible: true }).getByRole('menuitem', { name: 'Provider' }).first().tap();
  await page.waitForTimeout(600);
}
