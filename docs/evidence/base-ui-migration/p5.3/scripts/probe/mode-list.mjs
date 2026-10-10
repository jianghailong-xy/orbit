export default async function (page) {
  await page.locator('.composer-toolbar .ant-select, .composer-toolbar .orbit-select').last().click();
  await page.waitForTimeout(600);
}
