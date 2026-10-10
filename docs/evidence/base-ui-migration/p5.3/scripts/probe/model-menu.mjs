export default async function (page) {
  await page.locator('.composer-model-chip').click();
  await page.waitForTimeout(500);
}
