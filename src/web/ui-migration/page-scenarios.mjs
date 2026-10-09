import { PATHS, SHARE_TOKEN } from './fixtures.mjs';

// Every scenario visits the production route and interacts through visible controls.
// The runner provides isolated REST fixtures, frozen wall time and browser metadata.
export async function taskScenario({ page, expect, capture, measure }) {
  await page.goto(PATHS.task);
  const panel = page.locator('.task-detail-panel');
  await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
  await expect(page.getByText('Review the visual baseline', { exact: true }).last()).toBeVisible();
  await capture('task-detail', { panel, title: '.tdp-title', button: '.tdp-head-actions button', select: '.task-detail-panel .tdp-assignee-select' });
  const more = page.getByRole('button', { name: 'More actions', exact: true });
  await more.hover();
  await capture('task-action-hover', { hoveredButton: more });
  await more.focus();
  await page.mouse.move(0, 0);
  await expect(more).toBeFocused();
  await capture('task-action-focus', { focusedButton: more });
  await measure('task-menu-open', async () => {
    await more.click();
    await expect(page.getByRole('menuitem', { name: /Share/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Share/ })).toContainText('Live link');
  });
  await capture('task-action-menu', { menu: '.tdp-more-menu' });
  await page.getByRole('menuitem', { name: /Share/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Share task' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Public link' })).toHaveValue(new RegExp(`/s/${SHARE_TOKEN}$`));
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await capture('task-share-dialog', { dialog, surface: dialog, input: '[aria-label="Public link"]', access: '[aria-label="Access"]' });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel).toBeVisible();
}

export async function shareScenario({ page, expect, capture }) {
  await page.goto(PATHS.share);
  await expect(page.getByRole('heading', { name: 'Review the visual baseline' })).toBeVisible();
  await expect(page.getByText('Capture the current interface before the first component migration.', { exact: true })).toBeVisible();
  await capture('task-public-share', { title: 'h1', description: '.md' });
}

export async function projectsScenario({ page, expect, capture, measure }) {
  await page.goto(PATHS.projects);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByText('Orbit UI migration', { exact: true }).last()).toBeVisible();
  await capture('projects-list', { toolbar: '.projects-toolbar', search: '[aria-label="Search projects"]', project: '.project-row' });
  const search = page.getByRole('textbox', { name: 'Search projects', exact: true });
  await measure('project-search-input', async () => {
    await search.fill('no matching project');
    await expect(page.locator('.project-row')).toHaveCount(0);
  });
  await capture('projects-search-empty', { search });
  await search.fill('');
  await page.goto(PATHS.project);
  await expect(page.getByRole('heading', { name: 'Orbit UI migration', exact: true })).toBeVisible();
  await expect(page.getByTestId('project-dependency-graph')).toBeVisible();
  await expect(page.locator('.pdg-task-title')).toHaveCount(3);
  await capture('project-overview', { header: '.project-detail-identity', overview: '.project-command-center' });
  const graph = page.getByTestId('project-dependency-graph');
  await graph.scrollIntoViewIfNeeded();
  await capture('project-graph', { graph, node: '.pdg-task', task: '.project-task-row' });
  await page.getByRole('button', { name: 'Open project task graph full screen' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await capture('project-graph-fullscreen', { dialog: page.getByRole('dialog'), surface: page.getByRole('dialog') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

export async function wikiScenario({ page, expect, capture }) {
  await page.goto(PATHS.wiki);
  await expect(page.getByRole('heading', { name: 'Wiki', exact: true })).toBeVisible();
  await expect(page.getByText('Preserve visible behavior', { exact: true })).toBeVisible();
  const phone = page.viewportSize().width <= 960;
  // main 2f9cc095f (refactor(wiki): list topic articles on the Wiki home, drop status cards) removed the
  // home's .wk-card; its topic-article rows take their place, drawn once the home's reads are in.
  await capture('wiki-home', { title: '.wk-title-row', ...(phone ? {} : { directory: '.wk-toc' }), card: '.wk-pl-doc.topic' });
  if (phone) {
    await page.getByRole('button', { name: 'Contents', exact: true }).click();
    const contents = page.getByRole('dialog', { name: 'Contents' });
    await expect(contents).toBeVisible();
    await capture('wiki-contents', { drawer: contents, directory: contents.getByRole('navigation') });
    await contents.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(contents).not.toBeVisible();
  }
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record', exact: true })).toBeDisabled();
  await capture('wiki-new-entry', { dialog, surface: '.ant-modal-container', input: dialog.locator('input').first() });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
}

export async function settingsScenario({ page, expect, capture }) {
  await page.goto(PATHS.settings);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByText('Default permission mode', { exact: true })).toBeVisible();
  await capture('settings', { card: '.orbit-card', switch: '[role="switch"]', select: '.orbit-select', theme: '.orbit-segmented' });
  const firstSwitch = page.getByRole('switch').first();
  const previous = await firstSwitch.getAttribute('aria-checked');
  await firstSwitch.click();
  await expect(firstSwitch).toHaveAttribute('aria-checked', previous === 'true' ? 'false' : 'true');
  // 50ms after a toast, lib/toast.tsx repeats its text in a body-level screen-reader live region;
  // the visible feedback is the copy inside the Notifications region.
  await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Setting saved', { exact: true })).toBeVisible();
  await capture('settings-saved', { switch: firstSwitch });
}

export async function profileScenario({ page, expect, capture, measure }) {
  await page.goto(PATHS.profile);
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await capture('profile', { card: '.orbit-card', disabledButton: save, name: 'input[autocomplete="name"]' });
  const name = page.locator('input[autocomplete="name"]');
  await measure('profile-name-input', async () => {
    await name.fill('Baseline Reviewer Updated');
    await expect(save).toBeEnabled();
  });
  await save.click();
  await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true })).toBeVisible();
  await expect(name).toHaveValue('Baseline Reviewer Updated');
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText('Enter your current password', { exact: true })).toBeVisible();
  await expect(page.getByText('Enter a new password', { exact: true })).toBeVisible();
  await capture('profile-validation', { field: '.orbit-field[data-help]', error: '.orbit-field-error' });
}

export async function pageScenarios(context) {
  for (const scenario of [taskScenario, shareScenario, projectsScenario, wikiScenario, settingsScenario, profileScenario]) await scenario(context);
}
