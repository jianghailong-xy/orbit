export default async function (page) {
  await page.locator('.composer-field textarea').click();
  await page.keyboard.type('!ls -la');
  await page.waitForTimeout(500);
}
