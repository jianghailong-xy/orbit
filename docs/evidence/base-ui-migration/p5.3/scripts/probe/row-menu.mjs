export default async function (page) {
  const row = page.locator('.session-col .session-row').filter({ hasText: 'Demo for the design review' }).first();
  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.waitForTimeout(500);
}
