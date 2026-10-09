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
// refused; the start dialog when its request no longer stands; and the start card a conversation draws
// (its width, its toggles, its plan).
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

  // main 3ff232299: a coordinator question that has ended is drawn as a record of what it asked — its
  // opening, the option chosen and the note, or who withdrew it and why — on every width a preview whose
  // review replays the question and every option.
  test('ended coordinator questions: the records, and an answered one’s review', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'question-records');
    await top(scope);
    const records = scope.locator('.answered-question-card');
    await expect(records).toHaveCount(2);
    await frames(page);
    trace.push(await observe(page, fixtures, 'records'));
    await capture('p43b-card-question-records', { records: scope });
    await records.first().click();
    const review = page.locator('.review-card-dialog').filter({ visible: true }).last();
    await expect(review.locator('[data-question-record="question-record-answered"]')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'review'));
    await capture('p43b-card-question-review', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last() });
    await page.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'review closed'));
    await attachTrace(testInfo, trace);
  });

  // In a conversation the card fills the width it is given; More and "Read all" are drawn only while
  // the clamp hides words; the plan is the
  // project's task graph while the whole of it fits the card, and otherwise by level with "Task graph"
  // opening it full screen. The coordinator's reasons run past three lines on a phone only; one
  // criterion runs past two lines everywhere (p43b-cards-fixtures.mjs).
  test('the start card in a conversation: fills the transcript, More and Read all only while cut, the plan as the task graph or by level', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installCardFixtures(page);
    const trace = [];
    await open(page);
    const scope = section(page, 'live-start');
    await top(scope);
    const host = await reviewed(page, scope, '.start-card');
    const card = host.locator('.start-card').filter({ visible: true }).first();
    // The plan's reading is decided once StartPlanGraph has loaded and measured the card: its box holds the
    // graph, or the list by level when the graph does not fit (until then the list stands on its own).
    await expect(card.locator('.start-card-plan > div > .start-card-levels, .start-card-graph .react-flow__node').first()).toBeVisible();
    await frames(page);
    const reading = () => card.evaluate((el) => {
      const width = (node) => (node ? Math.round(node.getBoundingClientRect().width * 100) / 100 : null);
      const texts = (selector) => [...el.querySelectorAll(selector)].map((node) => node.textContent);
      return {
        card: width(el), room: width(el.parentElement),
        more: texts('.start-card-quote .start-card-link'), read: texts('.settlement-card-read'),
        graph: el.querySelectorAll('.start-card-graph').length, levels: el.querySelectorAll('.start-card-levels').length,
        graphLink: texts('.start-card-graph-link'), head: texts('.start-card-section').at(-1) ?? null,
      };
    });
    const first = await reading();
    trace.push({ ...(await observe(page, fixtures, 'start card')), geometry: first });
    await capture('p43b-card-start-live', { card });
    // The plan in view: the graph on a desktop, the list by level on a phone.
    const planned = card.locator('.start-card-plan');
    await planned.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await capture('p43b-card-start-live-plan', { plan: planned });
    await expect(card.locator('.settlement-card-read')).toHaveCount(1);
    const more = card.locator('.start-card-quote .start-card-link');
    if (phone(testInfo)) {
      // Cut on a phone: More is there, and opening it leaves Less to close it again.
      await expect(more).toHaveText('More');
      await more.click();
      await expect(more).toHaveText('Less');
      await frames(page);
      trace.push({ ...(await observe(page, fixtures, 'reasons opened')), geometry: await reading() });
      await capture('p43b-card-start-live-more', { card });
      // The plan does not fit a phone's card: by level, with the graph full screen.
      const link = card.getByRole('button', { name: /^Task graph/ });
      await link.click();
      const full = dialog(page, 'Task graph');
      await expect(full).toBeVisible();
      await expect(full.locator('.pdg-task').first()).toBeVisible();
      await frames(page);
      trace.push(await observe(page, fixtures, 'task graph full screen'));
      await capture('p43b-card-start-live-graph', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last() });
      // Which layer Escape closes is recorded, not asserted: on the reference the graph (AntD) and the
      // review it opened over (Orbit) answer Escape in separate layer stacks.
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await page.locator('.tdg-full-canvas').filter({ visible: true }).count()) === 0 || !(await host.isVisible())).toBe(true);
      trace.push(await observe(page, fixtures, 'escape in the task graph'));
    } else {
      // A desktop card fills the width its host has, its reasons fit three lines, and the plan fits it as a graph.
      expect(first.card).toBe(first.room);
      await expect(more).toHaveCount(0);
      await expect(card.locator('.start-card-graph .react-flow')).toBeVisible();
    }
    await attachTrace(testInfo, trace);
  });
});
