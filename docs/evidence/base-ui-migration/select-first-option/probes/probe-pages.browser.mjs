import { test, expect } from './harness.mjs';
import { installP43aFixtures, P43A_PATHS } from './p43a-fixtures.mjs';
import { installPilotFixtures, PILOT_PATHS } from './pilot-fixtures.mjs';

// Probe: the Selects on the pages that open with no option holding their value: rebinding the coordinator, choosing
// where it opens, a shared link's Expires once the link stops on a date ("until" is not one of its options) and a
// stopped task's Suggested tier with no suggestion. Each is opened by the pointer (a tap on phones); the probe reads
// the option highlighted, attaches the screen, presses Enter and reads the field. Prints one PROBE line per picker.
// The same file runs on the same-commit reference and on the delivery.
const dialog = (page, title) => page.locator('[role="dialog"], [role="alertdialog"]').filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const settled = (page) => page.evaluate(async () => {
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

async function pick(page, info, name, combobox) {
  await settled(page);
  const before = (await combobox.textContent()).trim();
  if (info.project.use.hasTouch) await combobox.tap(); else await combobox.click();
  const list = page.getByRole('listbox').filter({ visible: true }).last();
  await expect(list).toBeVisible();
  await settled(page);
  const highlighted = await list.locator('[data-highlighted]').allTextContents();
  await info.attach(`${name}-open`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden({ timeout: 5_000 }).catch(() => {});
  await settled(page);
  const result = { before, highlighted, afterEnter: (await combobox.textContent()).trim(), listOpen: await list.isVisible() };
  console.log(`PROBE ${info.project.name} ${name} ${JSON.stringify(result)}`);
  if (result.listOpen) await page.keyboard.press('Escape');
  return result;
}

test('pages: the coordinator workspace pickers', async ({ evidence }, info) => {
  const { page } = evidence;
  const fixtures = await installP43aFixtures(page);
  const results = {};
  fixtures.state.coordinator = 'unavailable';
  await page.goto(P43A_PATHS.project);
  const card = page.getByRole('region', { name: 'Coordinator' });
  await card.getByRole('button', { name: 'Rebind workspace…' }).click();
  const rebind = dialog(page, 'Rebind coordination workspace');
  await expect(rebind).toBeVisible();
  results.rebind = await pick(page, info, 'rebind', rebind.getByRole('combobox'));
  results.rebind.rebindEnabled = await rebind.getByRole('button', { name: 'Rebind', exact: true }).isEnabled();
  fixtures.state.coordinator = 'never';
  await page.reload();
  await card.getByRole('button', { name: 'Choose a workspace…' }).click();
  const choose = dialog(page, 'Choose the coordination workspace');
  await expect(choose).toBeVisible();
  results.choose = await pick(page, info, 'choose', choose.getByRole('combobox'));
  await info.attach('pages-coordinator', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});

test('pages: a shared link that stops on a date, and a stopped task with no suggestion', async ({ evidence }, info) => {
  const { page } = evidence;
  await installPilotFixtures(page, { theme: info.project.use.colorScheme });
  const results = {};
  const openShare = async () => {
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: /Share/ }).click();
    const share = page.getByRole('dialog', { name: 'Share task' });
    await expect(share).toBeVisible();
    return share;
  };
  await page.goto(PILOT_PATHS.task);
  let share = await openShare();
  await share.getByRole('button', { name: 'Access' }).click();
  await page.getByRole('menuitem', { name: /Anyone with the link/ }).click();
  await expect(share.getByRole('textbox', { name: 'Public link' })).toBeVisible();
  await share.getByRole('combobox', { name: 'Expires' }).click();
  await page.getByRole('option', { name: '7 days', exact: true }).filter({ visible: true }).click();
  await expect(share).toContainText('Stops working');
  await page.keyboard.press('Escape');
  await expect(share).toBeHidden();
  share = await openShare();
  await expect(share.getByRole('combobox', { name: 'Expires' })).toContainText('Until');
  results.expiresUntil = await pick(page, info, 'expires-until', share.getByRole('combobox', { name: 'Expires' }));
  await page.keyboard.press('Escape');
  await page.goto(PILOT_PATHS.done);
  const suggested = page.locator('.tdp-field').filter({ has: page.locator('.tdp-field-label', { hasText: /^Suggested$/ }) }).getByRole('combobox');
  await expect(suggested).toBeVisible();
  results.suggestedNone = await pick(page, info, 'suggested-none', suggested);
  await info.attach('pages-pilot', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});
