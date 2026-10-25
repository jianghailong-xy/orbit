import { test, expect } from './harness.mjs';
import {
  ANSWER_REFUSAL, CROSSING_REFUSAL, CROSSINGS_ERROR, DECLINE_REFUSAL, DONE_REFUSAL, EMPTY_GRAPH, GRAPH_ERROR,
  MERGE_REFUSAL, P43B_PATHS, PLAN_FITS, PLAN_WIDE, RICH_GRAPH, START_REFUSAL, TRUNCATED_GRAPH, gate, installP43bFixtures,
} from './p43b-fixtures.mjs';
import { PILOT_IDS, PILOT_PATHS, installPilotFixtures } from './pilot-fixtures.mjs';
import { attachTrace, button, dialog, fill, frames, observe, phone, popup, settled, top } from './p43b-helpers.mjs';

// P4.3b states on real routes, none of which the P0 matrix reaches: the project page's dependency
// graph with every kind of mark (a finished block, a run, a repeated motif, a parent's box, tasks
// ready, blocked, running and failed), a motif's tasks, a run and a finished block opened, a drag on
// it and on its full screen, and a task opened from the full screen; the graph's loading,
// failed-and-retried, empty and truncated reads; its geometry at 639, 641 and 1280px, where the P0
// baseline recorded the existing layout defects; a task's own dependency graph (the remove question,
// a drag in the panel and in its full screen, a node opening its task); and the project page's
// decision cards: crossings, a coordinator question, a merge into main, the done question and the
// owner's own start, whose plan is the task graph when it fits and by level when it does not.
// Locators are roles, accessible names, labels and the pages' own classes, so the same file drives the
// replaced controls (same-commit reference tree) and the Orbit ones; a painted box is named by both
// class names. Screenshots, computed styles and each step's observation (`trace`: address, focus, open
// dialogs, popups and tooltips, alerts, notifications and the requests a press sends) are compared
// between the two runs.

const DIALOG_SURFACE = '.ant-modal-container, .orbit-overlay';
const SPINNER = '.ant-spin, .orbit-spinner';
const ALERT = '.ant-alert, .orbit-alert';
const SELECT = '.ant-select, .orbit-select';
const NUMBER = '.ant-input-number, .orbit-number-input';
const SWITCH = '.ant-switch, .orbit-switch';
const CARD = '.ant-card, .orbit-card';

/** A block of the project page: its wrapper draws no box (display: contents), so this is what it holds. */
const block = (page, name) => page.locator(`[data-project-block="${name}"] > *`).first();
const graphSection = (page) => block(page, 'task-graph');
/** A mark on the project graph, by the start of its accessible name. */
const mark = (scope, name) => scope.locator(`[aria-label^="${name}"]`).first();
/** On a phone the graph is drawn top to bottom in a strip narrower than its marks, so the strip (and the
 *  full screen) is fitted first, the same way on both trees: a mark outside it cannot be pressed. */
async function fitOnPhone(page, scope, testInfo) {
  if (!phone(testInfo)) return;
  await scope.getByRole('button', { name: 'Fit whole project in view' }).click();
  await frames(page);
}
/** A card a phone draws as a preview that opens it (ReviewCard): the preview opened, and the review it
 *  opens; a card drawn in full, the card itself. `drawn` is the card's own class. */
async function reviewed(page, scope, drawn) {
  await expect(scope.locator(`${drawn}, .review-card-preview`).filter({ visible: true }).first()).toBeVisible();
  const preview = scope.locator('.review-card-preview').filter({ visible: true });
  if (await preview.count() === 0) return scope.locator(drawn).filter({ visible: true }).last();
  await preview.first().click();
  const review = page.locator('.review-card-dialog').filter({ visible: true }).last();
  await expect(review.locator(drawn)).toBeVisible();
  return review.locator(drawn).last();
}

/** What the graph's layout comes to on screen: the strip, every mark, the zoom toolbar, the full-screen
 *  button, and how far the marks run past the strip's bottom edge. */
const graphGeometry = (page) => page.evaluate(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  const strip = document.querySelector('[data-testid="project-dependency-graph"]');
  const marks = [...(strip?.querySelectorAll('.pdg-task, .pdg-fold, .pdg-group') ?? [])].map((el) => ({ label: el.textContent.trim().slice(0, 40), ...rect(el) }));
  const controls = rect(strip?.querySelector('.react-flow__controls'));
  const overlaps = controls ? marks.filter((m) => m.x < controls.right && m.right > controls.x && m.y < controls.bottom && m.bottom > controls.y).map((m) => m.label) : [];
  const box = rect(strip);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    strip: box, marks, controls, maximize: rect(strip?.querySelector('.tdg-maximize')),
    clippedBelow: box && marks.length ? Math.max(0, Math.max(...marks.map((m) => m.bottom)) - box.bottom) : null,
    overlapsControls: overlaps,
  };
});

/** Drag a graph's canvas by (60, 40) from a spot of its pane that nothing is drawn over, 24px around
 *  (nothing on the graph is draggable, so a drag can only pan it): its viewport's transform before and
 *  after. The spot is the first whose pointer the pane itself takes once the mouse is over it. A dialog
 *  that has just opened is let finish first (the replaced modal zooms in whatever motion is asked for,
 *  and the canvas places its view once its size settles)... */
async function pan(page, scope) {
  const viewport = scope.locator('.react-flow__viewport');
  const pane = scope.locator('.react-flow__pane');
  await settled(page);
  // ...and its view has stood still for ten frames.
  await viewport.evaluate((el) => new Promise((resolve) => {
    let last = el.style.transform;
    let still = 0;
    let count = 0;
    const tick = () => {
      still = el.style.transform === last ? still + 1 : 0;
      last = el.style.transform;
      if (still >= 10 || ++count > 240) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const before = await viewport.evaluate((el) => el.style.transform);
  const spots = await pane.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const clear = (x, y) => [[0, 0], [-24, -24], [24, -24], [-24, 24], [24, 24]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === el);
    const found = [];
    for (let y = box.top + 32; y < box.bottom - 32 && found.length < 8; y += 16) {
      for (let x = box.left + 32; x < box.right - 32 && found.length < 8; x += 16) {
        if (clear(x, y)) found.push({ x, y });
      }
    }
    return found;
  });
  let start = null;
  for (const spot of spots) {
    await page.mouse.move(spot.x, spot.y);
    if (await pane.evaluate((el) => [...document.querySelectorAll(':hover')].pop() === el)) { start = spot; break; }
  }
  expect(start, 'a spot of the pane nothing is drawn over').not.toBeNull();
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 20, { steps: 4 });
  await page.mouse.move(start.x + 60, start.y + 40, { steps: 4 });
  await page.mouse.up();
  await frames(page);
  const after = await viewport.evaluate((el) => el.style.transform);
  return { before, after, moved: before !== after };
}

test.describe('P4.3b dependency graphs', () => {
  test('the project graph: its marks, a motif’s tasks, a run opened, the full screen, a task opened', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page);
    const trace = [];
    await page.goto(P43B_PATHS.project);
    const strip = page.getByTestId('project-dependency-graph');
    await expect(strip).toBeVisible();
    await expect(strip.locator('.pdg-task').first()).toBeVisible();
    await top(graphSection(page));
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'graph')), geometry: await graphGeometry(page) });
    await capture('p43b-graph', { title: '.pdg-section-title', strip, task: strip.locator('.pdg-task').first(), fold: strip.locator('.pdg-fold').first() });

    // The full-screen button says what it does on hover (a phone has no hover).
    const maximize = page.getByRole('button', { name: 'Open project task graph full screen' });
    if (!phone(testInfo)) {
      await maximize.hover();
      const tip = popup(page, 'Open full-screen graph');
      await expect(tip).toBeVisible();
      await frames(page);
      trace.push(await observe(page, fixtures, 'full-screen button hovered'));
      await capture('p43b-graph-tooltip', { tooltip: tip, button: maximize });
      await page.mouse.move(0, 0);
      await expect(tip).toHaveCount(0);
    }

    // A motif names a few of its tasks, failures first, each one openable.
    await fitOnPhone(page, strip, testInfo);
    await mark(strip, 'Compare one page').click();
    const samples = popup(page, 'instances ·');
    await expect(samples).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'motif opened'));
    await capture('p43b-graph-motif', { popover: samples });
    await page.keyboard.press('Escape');
    await expect(samples).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'motif closed with Escape'));

    // Full screen: the same graph, its motif's tasks inside the dialog, Escape one layer at a time.
    await maximize.click();
    const full = dialog(page, 'Task graph');
    await expect(full).toBeVisible();
    await expect(full.locator('.pdg-task').first()).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'full screen'));
    await capture('p43b-graph-full', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last(), title: full.getByText('Task graph', { exact: true }) });
    await fitOnPhone(page, full, testInfo);
    await mark(full, 'Compare one page').click();
    const fullSamples = popup(page, 'instances ·');
    await expect(fullSamples).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'motif opened in full screen'));
    await capture('p43b-graph-full-motif', { popover: fullSamples });
    await page.keyboard.press('Escape');
    await expect(fullSamples).toHaveCount(0);
    await expect(full).toBeVisible();
    trace.push(await observe(page, fixtures, 'Escape closed the motif only'));
    await page.keyboard.press('Escape');
    await expect(full).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'Escape closed the full screen'));

    // A run opens into its steps where it stood.
    await fitOnPhone(page, strip, testInfo);
    await mark(strip, 'Shared overlays').click();
    await expect(strip.getByText('Selects and comboboxes', { exact: true })).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'run opened')), geometry: await graphGeometry(page) });
    await capture('p43b-graph-run-open', { strip });

    // The finished block opens into its tasks. On a phone the fitted strip puts it under the canvas's
    // summary panel, which takes the pointer, so it is pressed from the keyboard there (the same button).
    await fitOnPhone(page, strip, testInfo);
    if (phone(testInfo)) {
      await mark(strip, '2 done').focus();
      await page.keyboard.press('Enter');
    } else {
      await mark(strip, '2 done').click();
    }
    await expect(strip.getByText('Inventory existing components', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'finished block opened'));
    await capture('p43b-graph-settled-open', { strip });

    // A drag on the canvas pans it and opens nothing, on the page and in the full screen.
    const stripPanned = await pan(page, strip);
    expect(stripPanned.moved).toBe(true);
    trace.push({ ...(await observe(page, fixtures, 'strip dragged')), panned: stripPanned.moved });

    // A task opened from the full screen opens over the project page, and the full screen gets out of its way.
    // The canvas re-opens centred on the last mark toggled, which can leave this one outside it: the whole
    // project is fitted first, on every environment and on both trees.
    await maximize.click();
    await expect(full).toBeVisible();
    const fullPanned = await pan(page, full);
    expect(fullPanned.moved).toBe(true);
    trace.push({ ...(await observe(page, fixtures, 'full screen dragged')), panned: fullPanned.moved });
    await full.getByRole('button', { name: 'Fit whole project in view' }).click();
    await frames(page);
    await full.getByRole('link', { name: /^Capture browser baselines,/ }).click();
    await expect(full).toHaveCount(0);
    await expect(page.locator('.task-detail-panel')).toBeVisible();
    trace.push(await observe(page, fixtures, 'task opened from the full screen'));
    await attachTrace(testInfo, trace);
  });

  test('the project graph: loading, failed and retried, empty, truncated', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page);
    const trace = [];
    const hold = gate();
    fixtures.state.holdGraph = hold;
    fixtures.state.graphError = true;
    await page.goto(P43B_PATHS.project);
    const section = graphSection(page);
    await expect(section.locator(SPINNER)).toBeVisible();
    await top(section);
    await frames(page);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p43b-graph-loading', { spinner: section.locator(SPINNER) });
    hold.release();
    fixtures.state.holdGraph = null;
    const failed = section.locator(ALERT);
    await expect(failed).toContainText(GRAPH_ERROR, { timeout: 30_000 });
    await top(section);
    await frames(page);
    trace.push(await observe(page, fixtures, 'failed'));
    await capture('p43b-graph-error', { alert: failed, retry: button(failed, 'Retry') });
    fixtures.state.graphError = false;
    await button(failed, 'Retry').click();
    await expect(page.getByTestId('project-dependency-graph')).toBeVisible();
    trace.push(await observe(page, fixtures, 'retried'));

    fixtures.state.graph = EMPTY_GRAPH;
    await page.reload();
    await expect(section.getByText('No tasks to draw yet', { exact: true })).toBeVisible();
    await top(section);
    await frames(page);
    trace.push(await observe(page, fixtures, 'empty'));
    await capture('p43b-graph-empty', { empty: section.getByText('No tasks to draw yet', { exact: true }) });

    fixtures.state.graph = TRUNCATED_GRAPH;
    await page.reload();
    const truncated = section.locator(ALERT);
    await expect(truncated).toContainText('larger than one graph request reads');
    await truncated.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await frames(page);
    trace.push(await observe(page, fixtures, 'truncated'));
    await capture('p43b-graph-truncated', { alert: truncated });
    fixtures.state.graph = RICH_GRAPH;
    await attachTrace(testInfo, trace);
  });

  test('the project graph at 639, 641 and 1280px, where the P0 baseline recorded its layout defects', async ({ evidence }, testInfo) => {
    test.skip(phone(testInfo), 'The P0 records were taken with a desktop pointer at a height of 900, as here.');
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page, { graph: 'p0' });
    const trace = [];
    for (const width of [639, 641, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(P43B_PATHS.project);
      const strip = page.getByTestId('project-dependency-graph');
      await expect(strip.locator('.pdg-task-title')).toHaveCount(3);
      await strip.scrollIntoViewIfNeeded();
      await frames(page);
      trace.push({ ...(await observe(page, fixtures, `${width}px`)), geometry: await graphGeometry(page) });
      await capture(`p43b-geometry-${width}`, { strip });
    }
    await attachTrace(testInfo, trace);
  });

  test('a task’s graph: the full-screen button, the remove question, the full screen', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    const observeTask = async (step) => {
      const seen = await observe(page, { requests: [] }, step);
      return { ...seen, requests: fixtures.requests.splice(0).filter(({ method }) => method !== 'GET').map(({ method, path, body }) => ({ method, path, body })) };
    };
    await page.goto(PILOT_PATHS.task);
    const canvas = page.locator('.tdg-canvas');
    await expect(canvas.locator('.tdg-node').first()).toBeVisible();
    await top(canvas);
    await frames(page);
    trace.push(await observeTask('graph'));
    await capture('p43b-task-graph', { canvas, node: canvas.locator('.tdg-node').first() });
    // In the panel the graph is drawn top to bottom and leaves a drag to the page (TaskDependencyGraph's
    // canPan): recorded, the same on both trees. The full screen pans (below).
    const inlinePanned = await pan(page, canvas);
    trace.push({ ...(await observeTask('graph dragged')), panned: inlinePanned.moved });

    const maximize = page.getByRole('button', { name: 'Open dependency graph full screen' });
    if (!phone(testInfo)) {
      await maximize.hover();
      const tip = popup(page, 'Open full-screen graph');
      await expect(tip).toBeVisible();
      await frames(page);
      trace.push(await observeTask('full-screen button hovered'));
      await capture('p43b-task-graph-tooltip', { tooltip: tip });
      await page.mouse.move(0, 0);
      await expect(tip).toHaveCount(0);
    }

    // A direct prerequisite's remove button asks first; Cancel keeps it, Remove sends the delete.
    const prerequisite = canvas.locator('.tdg-node').filter({ hasText: 'Capture browser baselines' });
    const remove = page.getByRole('button', { name: 'Remove Capture browser baselines as a prerequisite' });
    // On a narrow canvas, focusing a node's button first centres the node (ensureFocusedNodeVisible), so a
    // press that also focuses it releases elsewhere and opens nothing — on both trees (see the README's
    // pre-existing behaviour). The button is focused first, as that first press would.
    await prerequisite.hover();
    await remove.focus();
    await frames(page);
    await remove.click();
    const question = popup(page, 'Remove prerequisite?');
    await expect(question).toBeVisible();
    await frames(page);
    trace.push(await observeTask('remove asked'));
    await capture('p43b-task-remove', { question, remove });
    await button(question, 'Cancel').click();
    await expect(question).toHaveCount(0);
    trace.push(await observeTask('remove cancelled'));
    await prerequisite.hover();
    await remove.focus();
    await frames(page);
    await remove.click();
    await expect(question).toBeVisible();
    await button(question, 'Remove').click();
    await expect(question).toHaveCount(0);
    await expect.poll(() => fixtures.requests.some(({ method }) => method === 'DELETE')).toBe(true);
    trace.push(await observeTask('removed'));

    await maximize.click();
    const full = dialog(page, 'Dependency graph · Migrate the task detail pilot');
    await expect(full).toBeVisible();
    await expect(full.locator('.tdg-node').first()).toBeVisible();
    await frames(page);
    trace.push(await observeTask('full screen'));
    await capture('p43b-task-graph-full', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last() });
    const fullPanned = await pan(page, full);
    expect(fullPanned.moved).toBe(true);
    trace.push({ ...(await observeTask('full screen dragged')), panned: fullPanned.moved });
    await page.keyboard.press('Escape');
    await expect(full).toHaveCount(0);
    trace.push(await observeTask('Escape closed the full screen'));

    // A node opens its task (the panel's own onOpenTask), here from the full screen, fitted first. The
    // task is opened afresh: on the reference tree the full screen's Escape also closed the task panel
    // under it (see the README's pre-existing behaviour).
    await page.goto(PILOT_PATHS.task);
    await expect(canvas.locator('.tdg-node').first()).toBeVisible();
    await maximize.click();
    await expect(full).toBeVisible();
    await full.getByRole('button', { name: 'Fit dependency graph to view' }).click();
    await frames(page);
    await full.getByRole('button', { name: /^Migrate shared controls, / }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${PILOT_IDS.dependent}$`));
    trace.push(await observeTask('a node opened its task'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.3b project decision cards', () => {
  test('crossings: loading, the list, a refused answer, asking to refuse; a failed read', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page);
    const trace = [];
    const hold = gate();
    fixtures.state.holdCrossings = hold;
    await page.goto(P43B_PATHS.project);
    const card = page.locator('[data-project-block="crossings"]');
    await expect(card.getByText('Cross-project crossings', { exact: true })).toBeVisible();
    await top(block(page, 'crossings'));
    await frames(page);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p43b-crossings-loading', { card: card.locator(CARD) });
    hold.release();
    fixtures.state.holdCrossings = null;
    await expect(card.getByText('Document the Orbit components', { exact: true }).first()).toBeVisible();
    await top(block(page, 'crossings'));
    await frames(page);
    trace.push(await observe(page, fixtures, 'crossings'));
    await capture('p43b-crossings', { card: card.locator(CARD) });

    // Approve… asks again naming both ends; the door refuses with its code, and the answer can be cancelled.
    await button(card, 'Approve…').first().click();
    const confirm = button(card, 'Yes, approve');
    await expect(confirm).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'approve asked'));
    await capture('p43b-crossings-approve', { card: card.locator(CARD), confirm });
    await confirm.click();
    await expect(card.locator(ALERT)).toContainText(CROSSING_REFUSAL.message);
    await frames(page);
    trace.push(await observe(page, fixtures, 'approve refused'));
    await capture('p43b-crossings-refused', { alert: card.locator(ALERT) });
    await button(card, 'Cancel').click();
    await button(card, 'Refuse…').first().click();
    await expect(button(card, 'Yes, refuse')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'refuse asked'));
    await capture('p43b-crossings-refuse', { card: card.locator(CARD), confirm: button(card, 'Yes, refuse') });
    await button(card, 'Cancel').click();

    // A project id's copy button says what it does (a phone has no hover).
    if (!phone(testInfo)) {
      const copy = card.getByRole('button', { name: /^Copy/ }).first();
      await copy.hover();
      const tip = popup(page, 'Copy');
      await expect(tip).toBeVisible();
      await frames(page);
      trace.push(await observe(page, fixtures, 'copy hovered'));
      await capture('p43b-crossings-copy', { tooltip: tip, copy });
      await page.mouse.move(0, 0);
    }

    fixtures.state.crossingsError = true;
    await page.reload();
    await expect(card.locator(ALERT)).toContainText(CROSSINGS_ERROR, { timeout: 30_000 });
    await top(block(page, 'crossings'));
    await frames(page);
    trace.push(await observe(page, fixtures, 'read failed'));
    await capture('p43b-crossings-error', { card: card.locator(CARD), alert: card.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  test('a coordinator question: answering in one’s own words, refused', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page, { question: true });
    const trace = [];
    await page.goto(P43B_PATHS.project);
    const questions = page.locator('[data-project-block="coordinator-questions"]');
    await top(block(page, 'coordinator-questions'));
    const card = await reviewed(page, questions, '.coordinator-question');
    await frames(page);
    trace.push(await observe(page, fixtures, 'question'));
    await capture('p43b-question', { card });
    const own = card.getByRole('textbox');
    await fill(own, 'Land the lists first, then rebase the graph batch and run its comparison again on the new tip.');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'own words typed')), field: await own.evaluate((el) => ({ height: el.getBoundingClientRect().height, value: el.value })) });
    await capture('p43b-question-typed', { field: own });
    await button(card, 'Send answer').click();
    await expect(card.locator(ALERT)).toContainText(ANSWER_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'answer refused'));
    await capture('p43b-question-refused', { alert: card.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  test('a merge into main, refused', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page, { promotion: true });
    const trace = [];
    await page.goto(P43B_PATHS.project);
    const merge = page.locator('[data-project-block="promotion"]');
    await top(block(page, 'promotion'));
    const card = await reviewed(page, merge, '.project-promotion');
    await frames(page);
    trace.push(await observe(page, fixtures, 'merge asked'));
    // Its name carries the keyboard hint drawn beside it ("Merge to main ⌘/Ctrl + Enter").
    await card.getByRole('button', { name: /^Merge to main/ }).click();
    await expect(card.locator(ALERT)).toContainText(MERGE_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'merge refused'));
    await capture('p43b-merge-refused', { card, alert: card.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  test('the done question: not yet with a note, refused; record as done, refused; closed and opened again', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page, { done: true });
    const trace = [];
    await page.goto(P43B_PATHS.project);
    const review = page.locator('.project-open-items').getByRole('button', { name: /^Review/ }).first();
    await review.click();
    const done = page.locator('[role="dialog"]').filter({ has: page.locator('.project-done-card') }).filter({ visible: true }).last();
    await expect(done.locator('.project-done-card')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'done question'));
    await capture('p43b-done', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last(), card: done.locator('.project-done-card') });

    await done.getByRole('button', { name: /^Not yet/ }).click();
    const note = done.getByRole('textbox', { name: /^What’s missing/ });
    await expect(note).toBeVisible();
    await fill(note, 'The phone screenshots of the graph are still missing from the evidence.');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'not yet, a note typed')), field: await note.evaluate((el) => ({ height: el.getBoundingClientRect().height, value: el.value })) });
    await capture('p43b-done-not-yet', { field: note });
    await button(done, 'Send to coordinator').click();
    await expect(done.locator(ALERT)).toContainText(DECLINE_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'not yet refused'));
    await capture('p43b-done-not-yet-refused', { alert: done.locator(ALERT) });

    // Closed and opened again: the project page unmounts the dialog when it closes, so it opens fresh
    // (no note, Not yet folded) on both trees.
    await page.keyboard.press('Escape');
    await expect(done).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed'));
    await review.click();
    await expect(page.locator('.project-done-card').filter({ visible: true })).toBeVisible();
    const again = page.locator('[role="dialog"]').filter({ has: page.locator('.project-done-card') }).filter({ visible: true }).last();
    trace.push({ ...(await observe(page, fixtures, 'opened again')), note: await again.getByRole('textbox').count() });
    await again.getByRole('button', { name: /^Record as done/ }).click();
    await expect(again.locator(ALERT)).toContainText(DONE_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'record refused'));
    await capture('p43b-done-refused', { alert: again.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  test('the owner’s own start: its settings, the line menu, the merge check, refused; loading and unread', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page, { graph: 'p0', started: false });
    const trace = [];
    const hold = gate();
    fixtures.state.holdStanding = hold;
    await page.goto(P43B_PATHS.project);
    await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
    const sheet = page.locator('[role="dialog"]').filter({ visible: true }).last();
    await expect(sheet.locator(SPINNER)).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'reading'));
    await capture('p43b-start-loading', { spinner: sheet.locator(SPINNER) });
    hold.release();
    fixtures.state.holdStanding = null;
    const card = sheet.locator('.start-card');
    await expect(card).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'start card'));
    await capture('p43b-start', { card, automatic: card.locator(SWITCH), line: card.locator(SELECT), count: card.locator(NUMBER) });

    // Automatic off and on again, the line menu, the merge check, the count.
    const automatic = card.getByRole('switch', { name: 'Automatic' });
    await automatic.click();
    await expect(automatic).toHaveAttribute('aria-checked', 'false');
    await frames(page);
    trace.push(await observe(page, fixtures, 'automatic off'));
    await capture('p43b-start-manual', { card, automatic });
    await automatic.click();
    await expect(automatic).toHaveAttribute('aria-checked', 'true');

    const line = card.getByRole('combobox', { name: 'Tasks land on' });
    await line.click();
    const option = page.getByRole('option', { name: /Directly into main/ });
    await expect(option).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'line menu open'));
    await capture('p43b-start-line-menu', { option });
    await option.click();
    await expect(card.locator(SELECT)).toContainText('Directly into main');
    trace.push(await observe(page, fixtures, 'main chosen'));

    await card.getByRole('button', { name: /^Merge check/ }).click();
    const check = card.getByRole('textbox', { name: 'Merge check' });
    await fill(check, 'npm run build -w @orbit/web && npm run test -w @orbit/web');
    const count = card.getByRole('spinbutton', { name: 'At most' });
    await fill(count, '4');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'settings changed')), check: await check.inputValue(), count: await count.inputValue() });
    await capture('p43b-start-settings', { card, check, count: card.locator(NUMBER) });

    await card.getByRole('button', { name: /^Start/ }).last().click();
    await expect(card.locator(ALERT)).toContainText(START_REFUSAL);
    await frames(page);
    trace.push(await observe(page, fixtures, 'start refused'));
    await capture('p43b-start-refused', { alert: card.locator(ALERT) });

    // Closed; a read that fails leaves the dialog saying it cannot be read.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    fixtures.state.standingError = true;
    await page.reload();
    await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
    const unread = page.locator('[role="dialog"]').filter({ visible: true }).last();
    await expect(unread.locator(ALERT)).toBeVisible({ timeout: 30_000 });
    await frames(page);
    trace.push(await observe(page, fixtures, 'unread'));
    await capture('p43b-start-unread', { alert: unread.locator(ALERT) });
    await attachTrace(testInfo, trace);
  });

  // main d91a0dd48 (docs/mocks/start-card-web-width): the plan is the project's task graph while the whole
  // of it fits the card, and otherwise the plan by level, with "Task graph" opening the graph full screen.
  // Whether Escape there leaves the start dialog open is recorded, not asserted: it is where the replaced
  // modals and the Orbit layers differ.
  test('the owner’s start: the plan as the task graph when it fits; by level, with the graph full screen, when it does not', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43bFixtures(page, { started: false });
    fixtures.state.graph = PLAN_FITS;
    const trace = [];
    const openStart = async () => {
      await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
      const sheet = page.locator('[role="dialog"]').filter({ visible: true }).last();
      const card = sheet.locator('.start-card');
      // Decided once StartPlanGraph has loaded and measured the card: the graph, or the list by level in
      // its box (until then the list stands on its own).
      await expect(card.locator('.start-card-plan > div > .start-card-levels, .start-card-graph .react-flow__node').first()).toBeVisible();
      await frames(page);
      return { sheet, card };
    };
    const plan = (card) => card.evaluate((el) => ({
      // Which toggles are drawn: More (the coordinator's reasons) and "Read all" (the criteria).
      more:[...el.querySelectorAll('.start-card-quote .start-card-link')].map((node) => node.textContent),
      read: [...el.querySelectorAll('.settlement-card-read')].map((node) => node.textContent),
      graph: el.querySelectorAll('.start-card-graph').length, levels: el.querySelectorAll('.start-card-levels').length,
      graphLink: [...el.querySelectorAll('.start-card-graph-link')].map((node) => node.textContent),
      head: [...el.querySelectorAll('.start-card-section')].map((node) => node.textContent).at(-1) ?? null,
    }));
    await page.goto(P43B_PATHS.project);
    let { sheet, card } = await openStart();
    // A chain of three fits the card: drawn top to bottom, nothing to press.
    await expect(card.locator('.start-card-graph .react-flow')).toBeVisible();
    trace.push({ ...(await observe(page, fixtures, 'plan as the graph')), geometry: await plan(card) });
    // The plan in view, below the rest of the card.
    const inView = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await inView(card.locator('.start-card-plan'));
    await capture('p43b-start-plan-graph', { plan: card.locator('.start-card-plan') });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // Six tasks side by side do not fit it: by level, and the graph full screen.
    fixtures.state.graph = PLAN_WIDE;
    await page.reload();
    ({ sheet, card } = await openStart());
    await expect(card.locator('.start-card-levels')).toBeVisible();
    trace.push({ ...(await observe(page, fixtures, 'plan by level')), geometry: await plan(card) });
    await inView(card.locator('.start-card-plan'));
    await capture('p43b-start-plan-levels', { plan: card.locator('.start-card-plan') });
    await card.getByRole('button', { name: /^Task graph/ }).click();
    const full = page.locator('.tdg-full-canvas');
    await expect(full.locator('.pdg-task').first()).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'task graph full screen'));
    await capture('p43b-start-task-graph', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last() });
    await page.keyboard.press('Escape');
    await expect(full).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'task graph closed'));
    await attachTrace(testInfo, trace);
  });
});

