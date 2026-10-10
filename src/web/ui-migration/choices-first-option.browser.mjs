import { test, expect } from '@playwright/test';

// The option a single select opens on, and what Enter picks then: the old AntD Select and the Orbit Select at
// the same place (the choices fixture's sample). With no value the old select opened on its first enabled
// option (rc-select's defaultActiveFirstOption) and Enter picked it; with a value, on that value. Opened by the
// pointer (a tap on phones) and by the keys that open it.
const fixture = '/ui-migration/choices.html?sample=select';
const CASES = [
  { name: 'no value', query: 'value=none', opensOn: 'Never', picks: 'never' },
  { name: 'a value', query: 'value=7', opensOn: '7 days', picks: '7' },
  { name: 'no value and the first option disabled', query: 'value=none&options=first-disabled', opensOn: '7 days', picks: '7' },
];
const OPENERS = ['pointer', 'ArrowDown', 'Enter', 'Space'];

async function settle(locator) {
  await expect(locator).toBeVisible();
  await locator.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => locator.evaluate((el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (Number(style.opacity) !== 1 || Math.hypot(matrix.a, matrix.b) !== 1 || Math.hypot(matrix.c, matrix.d) !== 1) return false;
    }
    return true;
  })).toBe(true);
  await locator.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

// Each option of the open list (the old select's are .ant-select-item-option; its role=option nodes are a hidden
// copy for assistive technology), whether it is the active one, and its background.
const options = (surface) => surface.evaluate((el) => [...el.querySelectorAll('.ant-select-item-option, .orbit-select-option')].map((option) => ({
  label: option.textContent.trim(), highlighted: option.matches('.ant-select-item-option-active, [data-highlighted]'),
  background: getComputedStyle(option).backgroundColor })));

for (const sample of CASES) for (const opener of OPENERS) test(`opened by ${opener} with ${sample.name}, the list is on the option the old select was on and Enter picks it`, async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const results = {};
  for (const system of ['antd', 'orbit']) {
    await page.goto(`${fixture}&system=${system}&${sample.query}`);
    await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
    await page.evaluate(() => document.fonts.ready);
    const region = page.getByRole('region', { name: 'Appearance sample' });
    const choice = region.getByRole('combobox', { name: 'Sample choice' });
    const value = region.getByRole('status', { name: 'Sample value' });
    if (opener === 'pointer') {
      if (info.project.use.hasTouch) await choice.tap();
      else await choice.click();
    } else {
      await choice.focus();
      await page.keyboard.press(opener);
    }
    const surface = page.locator('.sample-surface:visible');
    await settle(surface);
    const open = await options(surface);
    await info.attach(`${system}-open`, { body: await surface.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.keyboard.press('Enter');
    // Waited for, not asserted here: a system that stays open still reports what it did.
    await expect(choice).toHaveAttribute('aria-expanded', 'false', { timeout: 5_000 }).catch(() => {});
    await expect(choice).toBeFocused({ timeout: 5_000 }).catch(() => {});
    results[system] = { open, highlighted: open.filter((option) => option.highlighted).map((option) => option.label),
      afterEnter: await value.textContent(), expanded: await choice.getAttribute('aria-expanded'),
      focused: await choice.evaluate((el) => el === document.activeElement) };
  }
  await info.attach('first-option', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.antd.highlighted).toEqual([sample.opensOn]);
  expect(results.antd).toMatchObject({ afterEnter: sample.picks, expanded: 'false', focused: true });
  expect(results.orbit).toEqual(results.antd);
  expect(errors).toEqual([]);
});
