export default async function (page) {
  await page.locator('.session-scope-menu').click();
  await page.waitForTimeout(500);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
}
