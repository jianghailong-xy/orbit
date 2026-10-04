import { test, expect } from './harness.mjs';
import { PATHS } from './fixtures.mjs';

test('both sides of existing 600, 640 and 960px rules', async ({ evidence }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('-phone'), 'Phone/touch is covered at 390px; boundary probes use a desktop pointer.');
  const { page, capture } = evidence;
  for (const width of [599, 601, 639, 641, 959, 961]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => innerWidth)).toBe(width);
    if (width < 620) {
      await page.goto(PATHS.share);
      await expect(page.getByRole('heading', { name: 'Review the visual baseline' })).toBeVisible();
      await capture(`breakpoint-${width}-share`, { header: '.share-header', title: 'h1' });
      await page.goto(PATHS.task);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: /Share/ }).click();
      await expect(page.getByRole('textbox', { name: 'Public link' })).toBeVisible();
      await capture(`breakpoint-${width}-dialog`, { dialog: page.getByRole('dialog', { name: 'Share task' }) });
    } else if (width < 700) {
      await page.goto(PATHS.projects);
      await expect(page.locator('.project-row')).toHaveCount(1);
      await capture(`breakpoint-${width}-projects`, { row: '.project-row', toolbar: '.projects-toolbar' });
      await page.goto(PATHS.project);
      const graph = page.getByTestId('project-dependency-graph');
      await expect(page.locator('.pdg-task-title')).toHaveCount(3);
      await graph.scrollIntoViewIfNeeded();
      await capture(`breakpoint-${width}-graph`, { graph });
    } else {
      await page.goto(PATHS.wiki);
      await expect(page.getByText('Preserve visible behavior', { exact: true })).toBeVisible();
      const contents = page.getByRole('button', { name: 'Contents', exact: true });
      if (width <= 960) await expect(contents).toBeVisible();
      else await expect(contents).toBeHidden();
      await capture(`breakpoint-${width}-wiki`, { title: '.wk-title-row' });
      await page.goto(PATHS.session);
      await expect(page.locator('.composer-field textarea')).toBeEnabled();
      await expect(page.getByText('existing interface', { exact: true })).toBeVisible();
      await capture(`breakpoint-${width}-session`, { composer: '.composer-field' });
    }
  }
});
