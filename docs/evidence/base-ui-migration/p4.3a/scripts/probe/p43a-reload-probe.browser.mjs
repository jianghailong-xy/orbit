import { test, expect } from './harness.mjs';
import { DELETE_REFUSAL, P43A_PATHS, installP43aFixtures } from './p43a-fixtures.mjs';

// Reload probe for P4.3a's evidence, not part of the comparison spec: the project page, a refused delete, then a
// reload with no screenshot in between -- the header test's last steps made tighter -- ten times at staggered delays.
// The harness fails a test on any page error, so the tally per tree is how often a reload meets WebKit's "Fetch API
// cannot load … due to access control checks" for a read still in flight.
const named = (name) => new RegExp(`^(?:loading |[a-z]+(?:-[a-z]+)* )?${name}$`);
for (let i = 0; i < 10; i += 1) {
  test(`reload probe ${i}`, async ({ evidence }) => {
    const { page } = evidence;
    const fixtures = await installP43aFixtures(page);
    await page.goto(P43A_PATHS.project);
    const header = page.locator('.project-detail-identity');
    await expect(header.getByRole('heading', { name: 'Orbit UI migration' })).toBeVisible();
    fixtures.state.deleteRefusal = DELETE_REFUSAL;
    await page.getByRole('button', { name: 'Delete Orbit UI migration' }).click();
    const question = page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]')
      .filter({ has: page.getByText('Delete “Orbit UI migration”?', { exact: true }) }).filter({ visible: true }).last();
    await question.getByRole('button', { name: named('Delete') }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Project could not be deleted' })).toBeVisible();
    await page.waitForTimeout(i * 100);
    await page.reload();
    await expect(header.getByRole('heading', { name: 'Orbit UI migration' })).toBeVisible();
    await page.waitForTimeout(300);
  });
}
