export default async function (page) {
  // Delete permanently from the header menu of a trashed session is not here; use the shared row's Delete on desktop-like
  // flow: the header ⋯ → Delete on a shared session is plain; so open the folder delete through the folder page's ⋯.
  const back = page.locator('.workspace-back, .session-pane-back, button[aria-label^="Back"]').first();
  if (await back.isVisible()) { await back.tap(); await page.waitForTimeout(400); }
  await page.locator('.session-folder-row').filter({ hasText: 'Release' }).first().tap();
  await page.waitForTimeout(500);
  await page.locator('.session-folder-head-more').tap();
  await page.waitForTimeout(400);
  await page.locator('[role="menu"]').filter({ visible: true }).getByRole('menuitem', { name: 'Delete Folder' }).first().tap();
  await page.waitForTimeout(800);
}
