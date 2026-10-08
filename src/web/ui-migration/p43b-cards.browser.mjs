import { test, expect } from './harness.mjs';
import {
  CARDS_PATH, CARD_IDS, CRITERIA_REFUSAL, EVIDENCE_REFUSAL, EVIDENCE_STALE, OWNER_REFUSAL, REOPEN_REFUSAL, installCardFixtures,
} from './p43b-cards-fixtures.mjs';
import { attachTrace, button, dialog, fill, frames, observe, phone, top } from './p43b-helpers.mjs';

// P4.3b decision cards a session's conversation draws (WorkspaceView is P5's page), on their own
// page (p43b-cards.html): the real wired components with the app's providers, reading and pressing
// through REST fixtures. An evidence decision refused, then out of date; an owner confirmation whose
// review asks a question answered in the owner's own words, refused; a criteria decision refused; the
// strip's rows waiting on the reader; the two review turns; a receipt's Reopen task, asked and
// refused; and the start dialog when its request no longer stands.
// Locators are roles, accessible names, labels and the cards' own classes, so the same file drives the
// replaced controls (same-commit reference tree) and the Orbit ones. Screenshots, computed styles and
// each step's observation are compared between the two runs.

const ALERT = '.ant-alert, .orbit-alert';
const DIALOG_SURFACE = '.ant-modal-container, .orbit-overlay';
const section = (page, name) => page.locator(`[data-case="${name}"]`);

async function open(page) {
  await page.goto(CARDS_PATH);
  await expect(page.getByRole('heading', { name: 'P4.3b decision cards' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** A card a phone draws as a preview that opens it (ReviewCard): the preview opened, and the review
 *  it opens; a card drawn in full, the card itself. `drawn` is the card's own class. */
async function reviewed(page, scope, drawn) {
  await expect(scope.locator(`${drawn}, .review-card-preview`).filter({ visible: true }).first()).toBeVisible();
  const preview = scope.locator('.review-card-preview').filter({ visible: true });
  if (await preview.count() === 0) return scope;
  await preview.first().click();
  const review = page.locator('.review-card-dialog').filter({ visible: true }).last();
  await expect(review.locator(drawn)).toBeVisible();
  return review;
}

test.describe('P4.3b session decision cards', () => {
  test('an evidence decision: refused, then out of date', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'evidence');
    await top(scope);
    const card = await reviewed(page, scope, '.evidence-decision');
    await frames(page);
    trace.push(await observe(page, fixtures, 'evidence card'));
    await card.getByRole('button', { name: /^Confirm done/ }).click();
    await expect(card.locator(ALERT)).toContainText(EVIDENCE_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'confirm refused'));
    await capture('p43b-card-evidence-refused', { alert: card.locator(ALERT) });
    fixtures.state.evidence = 'stale';
    await card.getByRole('button', { name: /^Confirm done/ }).click();
    await expect(card.locator(ALERT)).toContainText(EVIDENCE_STALE.message);
    await frames(page);
    trace.push(await observe(page, fixtures, 'confirm refused as out of date'));
    await capture('p43b-card-evidence-stale', { alert: card.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  test('an owner confirmation: a review question answered in the owner’s own words, refused', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'owner');
    await top(scope);
    const card = await reviewed(page, scope, '.owner-confirmation');
    await frames(page);
    trace.push(await observe(page, fixtures, 'owner card'));
    // The second question's own row: Other, and the box under it.
    await card.getByRole('radio', { name: /^Other/ }).last().check();
    const own = card.getByRole('textbox').last();
    await expect(own).toBeVisible();
    await fill(own, 'Now, with a note in the changelog that the cap can overshoot.');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'own words typed')), field: await own.evaluate((el) => ({ height: el.getBoundingClientRect().height, value: el.value })) });
    await capture('p43b-card-owner-typed', { field: own });
    await card.getByRole('button', { name: /^Confirm done/ }).click();
    await expect(card.locator(ALERT)).toContainText(OWNER_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'confirm refused'));
    await capture('p43b-card-owner-refused', { alert: card.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  test('a criteria decision: refused', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'criteria');
    await top(scope);
    const card = await reviewed(page, scope, '.criteria-decision');
    await frames(page);
    trace.push(await observe(page, fixtures, 'criteria card'));
    await card.getByRole('button', { name: /^Approve/ }).first().click();
    await expect(card.locator(ALERT)).toContainText(CRITERIA_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'approve refused'));
    await capture('p43b-card-criteria-refused', { alert: card.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  test('the decision strip: what waits on the reader', async ({ evidence }, testInfo) => {
    test.skip(phone(testInfo), 'A phone has no line for what waits on the reader (DecisionStrip).');
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'strip');
    const fold = scope.getByRole('button', { expanded: false }).last();
    await expect(fold).toBeVisible();
    await fold.click();
    await expect(scope.getByText(/no project criterion/)).toBeVisible();
    await top(scope);
    await frames(page);
    trace.push(await observe(page, fixtures, 'waiting on you, unfolded'));
    await capture('p43b-card-strip', { rows: scope.locator('.decision-rail-why').first() });
    await attachTrace(testInfo, trace);
  });

  test('the review turns: the run’s session opened from the request', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'review-turns');
    await top(scope);
    await frames(page);
    trace.push(await observe(page, fixtures, 'review turns'));
    const press = button(scope, 'Open task session');
    await capture('p43b-card-review-turns', { request: scope.locator('.crc').first(), press });
    await press.click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${CARD_IDS.runSession}$`));
    trace.push(await observe(page, fixtures, 'run session opened'));
    await attachTrace(testInfo, trace);
  });

  test('a receipt’s Reopen task: asked, refused, and back', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'receipt');
    const reopen = button(scope, 'Reopen task');
    await expect(reopen).toBeVisible();
    await top(scope);
    await frames(page);
    trace.push(await observe(page, fixtures, 'receipt'));
    await capture('p43b-card-receipt', { reopen });
    await reopen.click();
    const question = dialog(page, 'Reopen this task?');
    await expect(question).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'reopen asked'));
    await capture('p43b-card-reopen', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last() });
    await button(question, 'Reopen').click();
    await expect(question.locator(ALERT)).toContainText(REOPEN_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'reopen refused'));
    await capture('p43b-card-reopen-refused', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last(), alert: question.locator(ALERT) });
    await button(question, 'Back').click();
    await expect(question).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'back'));
    await attachTrace(testInfo, trace);
  });

  test('the start dialog when its request no longer stands', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    await section(page, 'start').getByRole('button', { name: 'Open the start dialog' }).click();
    const start = page.locator('[role="dialog"]').filter({ visible: true }).last();
    await expect(start.locator(ALERT)).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'request gone'));
    await capture('p43b-card-start-gone', { alert: start.locator(ALERT) });
    await page.keyboard.press('Escape');
    await expect(start).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed'));
    await attachTrace(testInfo, trace);
  });
});
