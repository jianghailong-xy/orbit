export default async function (page) {
  await page.locator('.workspace-header button[title="More actions"]').click();
  await page.waitForTimeout(400);
  const design = page.locator('[role="menu"]').filter({ visible: true }).getByRole('menuitem', { name: 'Design' }).first();
  const box = await design.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.waitForTimeout(400);
}
