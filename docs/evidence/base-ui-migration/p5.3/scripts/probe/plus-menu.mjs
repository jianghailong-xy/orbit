export default async function (page) {
  await page.locator('.composer-attach-btn').first().tap();
  await page.waitForTimeout(800);
}
