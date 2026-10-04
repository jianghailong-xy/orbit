import { test, expect } from '@playwright/test';

// Direct behavior evidence for compact reviews, not the project's final visual acceptance.
const errors = new WeakMap();
test.beforeEach(async ({ page }, info) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
  await page.goto('/ui-migration/reviews.html');
  await expect(page.locator('html')).toHaveAttribute('data-theme', info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function trapped(page, dialog) {
  for (const key of ['Tab', 'Shift+Tab']) for (let index = 0; index < 10; index++) {
    await page.keyboard.press(key);
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement)), {
      message: `${key} stays inside the real review portal`,
    }).toBe(true);
  }
}

async function capture(page, dialog, info, name, behavior) {
  const geometry = await dialog.evaluate((node) => {
    const body = node.querySelector('.approval-body');
    const actions = node.querySelector('.approval-actions');
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      theme: document.documentElement.dataset.theme,
      documentWidth: document.documentElement.scrollWidth,
      popup: node.getBoundingClientRect().toJSON(),
      body: { ...body.getBoundingClientRect().toJSON(), scrollTop: body.scrollTop,
        scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, overflow: getComputedStyle(body).overflow },
      actions: actions.getBoundingClientRect().toJSON(),
      buttons: [...actions.querySelectorAll('button')].map((button) => ({
        text: button.textContent, ...button.getBoundingClientRect().toJSON(),
      })),
    };
  });
  expect(geometry.viewport).toEqual({ ...info.project.use.viewport, dpr: 1 });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width);
  for (const box of [geometry.popup, geometry.actions, ...geometry.buttons]) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  }
  await info.attach(`${name}.png`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await info.attach(`${name}.json`, {
    body: JSON.stringify({ browser: page.context().browser().version(), geometry, behavior }, null, 2),
    contentType: 'application/json',
  });
}

test('question traps focus, preserves choices and drafts, and suspends background shortcuts', async ({ page }, info) => {
  // A modal removes its background from the accessibility tree while it is open.
  const trigger = page.locator('.review-card-preview').filter({ hasText: 'Claude has a question for you' });
  const decisions = page.getByTestId('decisions');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Claude has a question for you', exact: true });
  await expect(dialog).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(await dialog.evaluate((node) => document.querySelector('main').contains(node))).toBe(false);
  await trapped(page, dialog);
  await dialog.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Enter');
  await expect(decisions).toHaveText('[]');
  const choice = dialog.getByRole('button', { name: /Main$/ });
  await choice.click();
  const field = dialog.getByPlaceholder('Or type your own answer…');
  await field.fill('Keep the staging branch too');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(dialog).toBeFocused();
  await expect(choice).toHaveClass(/is-picked/);
  await expect(field).toHaveValue('Keep the staging branch too');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog).toBeFocused();
  await expect(choice).toHaveClass(/is-picked/);
  await expect(field).toHaveValue('Keep the staging branch too');
  await capture(page, dialog, info, 'question-retained', {
    portal: true, tabBothDirections: true, escapeAndCloseRestoreFocus: true,
    choicesAndDraftRetained: true, backgroundShortcutsSuspended: true,
  });
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  const answers = [['AskUserQuestion', 'allow', {
    'Which branches should receive the change?': ['Main', 'Keep the staging branch too'],
  }]];
  await expect(decisions).toHaveText(JSON.stringify(answers));
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('heading', { name: 'Compact review behavior' }).focus();
  await page.keyboard.press('Enter');
  await expect(decisions).toHaveText(JSON.stringify([...answers, ['Bash', 'allow']]));
});

test('long plan scrolls above visible actions and owns the foreground shortcut', async ({ page }, info) => {
  const trigger = page.getByRole('button', { name: /Confirm: exit plan mode and proceed with this plan/ });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: /Confirm: exit plan mode and proceed with this plan/ });
  await expect(dialog).toBeFocused();
  await trapped(page, dialog);
  const body = dialog.locator('.approval-body');
  const actions = dialog.locator('.approval-actions');
  const before = await actions.boundingBox();
  await expect.poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await actions.boundingBox()).toEqual(before);
  await expect(dialog.getByRole('heading', { name: 'Step 80', exact: true })).toBeInViewport();
  await capture(page, dialog, info, 'plan-scrolled', { tabBothDirections: true, contentScrolled: true, actionsStayedVisible: true });
  await dialog.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('decisions')).toHaveText(JSON.stringify([['ExitPlanMode', 'allow']]));
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});
