# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p43b.browser.mjs >> P4.3b project decision cards >> the owner’s own start: its settings, the line menu, the merge check, refused; loading and unread
- Location: ui-migration/p43b.browser.mjs:532:3

# Error details

```
Test timeout of 90000ms exceeded.
```

```
Error: locator.click: Test timeout of 90000ms exceeded.
Call log:
  - waiting for getByRole('option', { name: /Directly into main/ })
    - locator resolved to <div role="option" id="_r_16__list_1" aria-selected="false" aria-disabled="false" title="Directly into main" class="ant-select-item ant-select-item-option">…</div>
  - attempting click action
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling

```

# Test source

```ts
  470 |   test('a merge into main, refused', async ({ evidence }, testInfo) => {
  471 |     const { page, capture } = evidence;
  472 |     const fixtures = await installP43bFixtures(page, { promotion: true });
  473 |     const trace = [];
  474 |     await page.goto(P43B_PATHS.project);
  475 |     const merge = page.locator('[data-project-block="promotion"]');
  476 |     await top(block(page, 'promotion'));
  477 |     const card = await reviewed(page, merge, '.project-promotion');
  478 |     await frames(page);
  479 |     trace.push(await observe(page, fixtures, 'merge asked'));
  480 |     // Its name carries the keyboard hint drawn beside it ("Merge to main ⌘/Ctrl + Enter").
  481 |     await card.getByRole('button', { name: /^Merge to main/ }).click();
  482 |     await expect(card.locator(ALERT)).toContainText(MERGE_REFUSAL);
  483 |     await frames(page);
  484 |     trace.push(await observe(page, fixtures, 'merge refused'));
  485 |     await capture('p43b-merge-refused', { card, alert: card.locator(ALERT) });
  486 |     await attachTrace(testInfo, trace);
  487 |   });
  488 | 
  489 |   test('the done question: not yet with a note, refused; record as done, refused; closed and opened again', async ({ evidence }, testInfo) => {
  490 |     const { page, capture } = evidence;
  491 |     const fixtures = await installP43bFixtures(page, { done: true });
  492 |     const trace = [];
  493 |     await page.goto(P43B_PATHS.project);
  494 |     const review = page.locator('.project-open-items').getByRole('button', { name: /^Review/ }).first();
  495 |     await review.click();
  496 |     const done = page.locator('[role="dialog"]').filter({ has: page.locator('.project-done-card') }).filter({ visible: true }).last();
  497 |     await expect(done.locator('.project-done-card')).toBeVisible();
  498 |     await frames(page);
  499 |     trace.push(await observe(page, fixtures, 'done question'));
  500 |     await capture('p43b-done', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last(), card: done.locator('.project-done-card') });
  501 | 
  502 |     await done.getByRole('button', { name: /^Not yet/ }).click();
  503 |     const note = done.getByRole('textbox', { name: /^What’s missing/ });
  504 |     await expect(note).toBeVisible();
  505 |     await fill(note, 'The phone screenshots of the graph are still missing from the evidence.');
  506 |     await frames(page);
  507 |     trace.push({ ...(await observe(page, fixtures, 'not yet, a note typed')), field: await note.evaluate((el) => ({ height: el.getBoundingClientRect().height, value: el.value })) });
  508 |     await capture('p43b-done-not-yet', { field: note });
  509 |     await button(done, 'Send to coordinator').click();
  510 |     await expect(done.locator(ALERT)).toContainText(DECLINE_REFUSAL);
  511 |     await frames(page);
  512 |     trace.push(await observe(page, fixtures, 'not yet refused'));
  513 |     await capture('p43b-done-not-yet-refused', { alert: done.locator(ALERT) });
  514 | 
  515 |     // Closed and opened again: the project page unmounts the dialog when it closes, so it opens fresh
  516 |     // (no note, Not yet folded) on both trees.
  517 |     await page.keyboard.press('Escape');
  518 |     await expect(done).toHaveCount(0);
  519 |     trace.push(await observe(page, fixtures, 'closed'));
  520 |     await review.click();
  521 |     await expect(page.locator('.project-done-card').filter({ visible: true })).toBeVisible();
  522 |     const again = page.locator('[role="dialog"]').filter({ has: page.locator('.project-done-card') }).filter({ visible: true }).last();
  523 |     trace.push({ ...(await observe(page, fixtures, 'opened again')), note: await again.getByRole('textbox').count() });
  524 |     await again.getByRole('button', { name: /^Record as done/ }).click();
  525 |     await expect(again.locator(ALERT)).toContainText(DONE_REFUSAL);
  526 |     await frames(page);
  527 |     trace.push(await observe(page, fixtures, 'record refused'));
  528 |     await capture('p43b-done-refused', { alert: again.locator(ALERT) });
  529 |     await attachTrace(testInfo, trace);
  530 |   });
  531 | 
  532 |   test('the owner’s own start: its settings, the line menu, the merge check, refused; loading and unread', async ({ evidence }, testInfo) => {
  533 |     const { page, capture } = evidence;
  534 |     const fixtures = await installP43bFixtures(page, { graph: 'p0', started: false });
  535 |     const trace = [];
  536 |     const hold = gate();
  537 |     fixtures.state.holdStanding = hold;
  538 |     await page.goto(P43B_PATHS.project);
  539 |     await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
  540 |     const sheet = page.locator('[role="dialog"]').filter({ visible: true }).last();
  541 |     await expect(sheet.locator(SPINNER)).toBeVisible();
  542 |     await frames(page);
  543 |     trace.push(await observe(page, fixtures, 'reading'));
  544 |     await capture('p43b-start-loading', { spinner: sheet.locator(SPINNER) });
  545 |     hold.release();
  546 |     fixtures.state.holdStanding = null;
  547 |     const card = sheet.locator('.start-card');
  548 |     await expect(card).toBeVisible();
  549 |     await frames(page);
  550 |     trace.push(await observe(page, fixtures, 'start card'));
  551 |     await capture('p43b-start', { card, automatic: card.locator(SWITCH), line: card.locator(SELECT), count: card.locator(NUMBER) });
  552 | 
  553 |     // Automatic off and on again, the line menu, the merge check, the count.
  554 |     const automatic = card.getByRole('switch', { name: 'Automatic' });
  555 |     await automatic.click();
  556 |     await expect(automatic).toHaveAttribute('aria-checked', 'false');
  557 |     await frames(page);
  558 |     trace.push(await observe(page, fixtures, 'automatic off'));
  559 |     await capture('p43b-start-manual', { card, automatic });
  560 |     await automatic.click();
  561 |     await expect(automatic).toHaveAttribute('aria-checked', 'true');
  562 | 
  563 |     const line = card.getByRole('combobox', { name: 'Tasks land on' });
  564 |     await line.click();
  565 |     const option = page.getByRole('option', { name: /Directly into main/ });
  566 |     await expect(option).toBeVisible();
  567 |     await frames(page);
  568 |     trace.push(await observe(page, fixtures, 'line menu open'));
  569 |     await capture('p43b-start-line-menu', { option });
> 570 |     await option.click();
      |                  ^ Error: locator.click: Test timeout of 90000ms exceeded.
  571 |     await expect(card.locator(SELECT)).toContainText('Directly into main');
  572 |     trace.push(await observe(page, fixtures, 'main chosen'));
  573 | 
  574 |     await card.getByRole('button', { name: /^Merge check/ }).click();
  575 |     const check = card.getByRole('textbox', { name: 'Merge check' });
  576 |     await fill(check, 'npm run build -w @orbit/web && npm run test -w @orbit/web');
  577 |     const count = card.getByRole('spinbutton', { name: 'At most' });
  578 |     await fill(count, '4');
  579 |     await frames(page);
  580 |     trace.push({ ...(await observe(page, fixtures, 'settings changed')), check: await check.inputValue(), count: await count.inputValue() });
  581 |     await capture('p43b-start-settings', { card, check, count: card.locator(NUMBER) });
  582 | 
  583 |     await card.getByRole('button', { name: /^Start/ }).last().click();
  584 |     await expect(card.locator(ALERT)).toContainText(START_REFUSAL);
  585 |     await frames(page);
  586 |     trace.push(await observe(page, fixtures, 'start refused'));
  587 |     await capture('p43b-start-refused', { alert: card.locator(ALERT) });
  588 | 
  589 |     // Closed; a read that fails leaves the dialog saying it cannot be read.
  590 |     await page.keyboard.press('Escape');
  591 |     await expect(sheet).toHaveCount(0);
  592 |     fixtures.state.standingError = true;
  593 |     await page.reload();
  594 |     await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
  595 |     const unread = page.locator('[role="dialog"]').filter({ visible: true }).last();
  596 |     await expect(unread.locator(ALERT)).toBeVisible({ timeout: 30_000 });
  597 |     await frames(page);
  598 |     trace.push(await observe(page, fixtures, 'unread'));
  599 |     await capture('p43b-start-unread', { alert: unread.locator(ALERT) });
  600 |     await attachTrace(testInfo, trace);
  601 |   });
  602 | 
  603 |   // main d91a0dd48 (docs/mocks/start-card-web-width): the plan is the project's task graph while the whole
  604 |   // of it fits the card, and otherwise the plan by level, with "Task graph" opening the graph full screen.
  605 |   // Whether Escape there leaves the start dialog open is recorded, not asserted: it is where the replaced
  606 |   // modals and the Orbit layers differ.
  607 |   test('the owner’s start: the plan as the task graph when it fits; by level, with the graph full screen, when it does not', async ({ evidence }, testInfo) => {
  608 |     const { page, capture } = evidence;
  609 |     const fixtures = await installP43bFixtures(page, { started: false });
  610 |     fixtures.state.graph = PLAN_FITS;
  611 |     const trace = [];
  612 |     const openStart = async () => {
  613 |       await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
  614 |       const sheet = page.locator('[role="dialog"]').filter({ visible: true }).last();
  615 |       const card = sheet.locator('.start-card');
  616 |       // Decided once StartPlanGraph has loaded and measured the card: the graph, or the list by level in
  617 |       // its box (until then the list stands on its own).
  618 |       await expect(card.locator('.start-card-plan > div > .start-card-levels, .start-card-graph .react-flow__node').first()).toBeVisible();
  619 |       await frames(page);
  620 |       return { sheet, card };
  621 |     };
  622 |     const plan = (card) => card.evaluate((el) => ({
  623 |       // Which toggles are drawn: More (the coordinator's reasons) and "Read all" (the criteria).
  624 |       more:[...el.querySelectorAll('.start-card-quote .start-card-link')].map((node) => node.textContent),
  625 |       read: [...el.querySelectorAll('.settlement-card-read')].map((node) => node.textContent),
  626 |       graph: el.querySelectorAll('.start-card-graph').length, levels: el.querySelectorAll('.start-card-levels').length,
  627 |       graphLink: [...el.querySelectorAll('.start-card-graph-link')].map((node) => node.textContent),
  628 |       head: [...el.querySelectorAll('.start-card-section')].map((node) => node.textContent).at(-1) ?? null,
  629 |     }));
  630 |     await page.goto(P43B_PATHS.project);
  631 |     let { sheet, card } = await openStart();
  632 |     // A chain of three fits the card: drawn top to bottom, nothing to press.
  633 |     await expect(card.locator('.start-card-graph .react-flow')).toBeVisible();
  634 |     trace.push({ ...(await observe(page, fixtures, 'plan as the graph')), geometry: await plan(card) });
  635 |     // The plan in view, below the rest of the card.
  636 |     const inView = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  637 |     await inView(card.locator('.start-card-plan'));
  638 |     await capture('p43b-start-plan-graph', { plan: card.locator('.start-card-plan') });
  639 |     await page.keyboard.press('Escape');
  640 |     await expect(sheet).toHaveCount(0);
  641 | 
  642 |     // Six tasks side by side do not fit it: by level, and the graph full screen.
  643 |     fixtures.state.graph = PLAN_WIDE;
  644 |     await page.reload();
  645 |     ({ sheet, card } = await openStart());
  646 |     await expect(card.locator('.start-card-levels')).toBeVisible();
  647 |     trace.push({ ...(await observe(page, fixtures, 'plan by level')), geometry: await plan(card) });
  648 |     await inView(card.locator('.start-card-plan'));
  649 |     await capture('p43b-start-plan-levels', { plan: card.locator('.start-card-plan') });
  650 |     await card.getByRole('button', { name: /^Task graph/ }).click();
  651 |     const full = page.locator('.tdg-full-canvas');
  652 |     await expect(full.locator('.pdg-task').first()).toBeVisible();
  653 |     await frames(page);
  654 |     trace.push(await observe(page, fixtures, 'task graph full screen'));
  655 |     await capture('p43b-start-task-graph', { surface: page.locator(DIALOG_SURFACE).filter({ visible: true }).last() });
  656 |     await page.keyboard.press('Escape');
  657 |     await expect(full).toHaveCount(0);
  658 |     trace.push(await observe(page, fixtures, 'task graph closed'));
  659 |     await attachTrace(testInfo, trace);
  660 |   });
  661 | });
  662 | 
  663 | 
```