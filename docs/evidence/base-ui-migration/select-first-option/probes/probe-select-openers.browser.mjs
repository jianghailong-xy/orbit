import { test, expect } from '@playwright/test';

// Probe: what choices-first-option.browser.mjs does not assert, on the old AntD Select and the Orbit Select at the same
// place: the option ↑ opens the list on; the option a list reopened after Escape (nothing chosen) is on; the option
// still active after the pointer hovered one and left the list, and what Enter then picks. Prints PROBE lines.
const settle = (page) => page.evaluate(async () => {
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const highlighted = (page) => page.evaluate(() => {
  const surface = [...document.querySelectorAll('.sample-surface')].find((el) => el.getBoundingClientRect().height > 0);
  if (!surface) return 'closed';
  return [...surface.querySelectorAll('.ant-select-item-option-active, .orbit-select-option[data-highlighted]')].map((el) => el.textContent.trim()).join(', ') || 'none';
});
const CASES = [['no value', 'value=none'], ['a value', 'value=7'], ['first option disabled', 'value=none&options=first-disabled']];

for (const [name, query] of CASES) test(`select openers: ${name}`, async ({ page }, info) => {
  const results = {};
  for (const system of ['antd', 'orbit']) {
    const open = async () => {
      await page.goto(`/ui-migration/choices.html?sample=select&system=${system}&${query}`);
      await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      await page.evaluate(() => document.fonts.ready);
      return page.getByRole('region', { name: 'Appearance sample' }).getByRole('combobox', { name: 'Sample choice' });
    };
    const record = {};
    let choice = await open();
    await choice.focus();
    await page.keyboard.press('ArrowUp');
    await settle(page);
    record.arrowUpOpensOn = await highlighted(page);
    choice = await open();
    await choice.click();
    await settle(page);
    record.clickOpensOn = await highlighted(page);
    await page.keyboard.press('ArrowDown');
    await settle(page);
    record.afterArrowDown = await highlighted(page);
    await page.keyboard.press('Escape');
    await settle(page);
    await choice.click();
    await settle(page);
    record.reopenedOn = await highlighted(page);
    choice = await open();
    await choice.click();
    await settle(page);
    const options = page.locator('.sample-surface:visible').locator('.ant-select-item-option, .orbit-select-option');
    await options.nth(1).hover();
    await settle(page);
    record.hovered = await highlighted(page);
    await page.mouse.move(5, 5);
    await settle(page);
    record.afterLeaving = await highlighted(page);
    await page.keyboard.press('Enter');
    await settle(page);
    record.enterAfterLeaving = `${await page.getByRole('status', { name: 'Sample value' }).textContent()} | list ${await highlighted(page) === 'closed' ? 'closed' : 'open'}`;
    results[system] = record;
    console.log(`PROBE ${info.project.name} ${name} ${system} ${JSON.stringify(record)}`);
  }
  await info.attach('select-openers', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});
