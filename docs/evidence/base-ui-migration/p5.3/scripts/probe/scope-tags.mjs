export default async function (page) {
  await page.locator('.session-scope-menu').click();
  await page.waitForTimeout(500);
  const item = page.locator('[role="menuitem"]').filter({ hasText: 'Filter by Tag' }).first();
  const box = await item.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.waitForTimeout(800);
}
