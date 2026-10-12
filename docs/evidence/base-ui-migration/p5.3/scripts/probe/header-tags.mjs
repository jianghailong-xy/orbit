export default async function (page) {
  await page.locator('.workspace-header button[title="More actions"]').click();
  await page.waitForTimeout(400);
  const ops = page.locator('[role="menu"]').filter({ visible: true }).getByRole('menuitem', { name: 'Ops' }).first();
  const box = await ops.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.waitForTimeout(300);
  console.log('BEFORE', await page.evaluate(() => [document.activeElement?.textContent?.trim().slice(0, 30), [...document.querySelectorAll('[data-highlighted], .ant-dropdown-menu-item-active')].map((el) => el.textContent.trim().slice(0, 20))]));
  await page.mouse.down(); await page.mouse.up();
  for (const wait of [0, 50, 150, 400]) {
    await page.waitForTimeout(wait);
    console.log('AFTER+' + wait, await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.getAttribute('role'), document.activeElement?.textContent?.trim().slice(0, 30), [...document.querySelectorAll('[data-highlighted], .ant-dropdown-menu-item-active')].map((el) => el.textContent.trim().slice(0, 20)), [...document.querySelectorAll('[aria-disabled="true"], .ant-dropdown-menu-item-disabled')].map((el) => el.textContent.trim().slice(0, 12))]));
  }
  // The keyboard: down to Design, Enter.
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  console.log('ARROWUP', await page.evaluate(() => [document.activeElement?.textContent?.trim().slice(0, 30), [...document.querySelectorAll('[data-highlighted], .ant-dropdown-menu-item-active')].map((el) => el.textContent.trim().slice(0, 20))]));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  console.log('ENTER', await page.evaluate(() => [document.activeElement?.textContent?.trim().slice(0, 30), [...document.querySelectorAll('[data-highlighted], .ant-dropdown-menu-item-active')].map((el) => el.textContent.trim().slice(0, 20))]));
}
