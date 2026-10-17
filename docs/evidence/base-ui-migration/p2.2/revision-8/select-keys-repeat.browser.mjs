import { test, expect } from '@playwright/test';

// Repetition study following select-keys.browser.mjs: the same unthrottled ArrowDown, ArrowDown,
// Enter sequence (no waits, as in choices.browser.mjs:263) 40 times per target, one test per
// sample, recording whether the second ArrowDown reached the trigger while the listbox was already
// shown and whether Enter then left the value unchanged. The first version of this file looped all
// 40 samples inside one test and exceeded the 90s test budget before attaching anything.
const TARGETS = [
  { name: 'orbit-field', url: '/ui-migration/choices.html', label: 'Expires',
    read: (page) => page.getByRole('status', { name: 'Expiry value', exact: true }).textContent() },
  { name: 'orbit-sample', url: '/ui-migration/choices.html?system=orbit&sample=expiry', label: 'Sample choice',
    read: (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText() },
  { name: 'antd-sample', url: '/ui-migration/choices.html?system=antd&sample=expiry', label: 'Sample choice',
    read: (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText() },
];
const RUNS = 40;

function observeKeys() {
  const describe = (el) => el instanceof Element
    ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  window.keyLog = [];
  const start = performance.now();
  document.addEventListener('keydown', (event) => {
    const listbox = [...document.querySelectorAll('[role="listbox"]')].find((el) => el.getBoundingClientRect().height > 0);
    const active = document.activeElement;
    const descendant = active?.getAttribute('aria-activedescendant');
    window.keyLog.push({ key: event.key, t: Math.round((performance.now() - start) * 10) / 10, target: describe(event.target),
      listbox: !!listbox, highlighted: listbox?.querySelector('[data-highlighted]')?.textContent?.trim()
        ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null });
  }, true);
}

for (const target of TARGETS) for (let run = 0; run < RUNS; run++) {
  test(`${target.name} ArrowDown ArrowDown Enter sample ${run}`, async ({ page }, info) => {
    test.skip(info.project.use.browserName !== 'chromium', 'paired with the Chromium-only throttled probe');
    await page.goto(target.url);
    await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
    await page.evaluate(() => document.fonts.ready);
    const before = (await target.read(page)).trim();
    await page.evaluate(observeKeys);
    await page.getByRole('combobox', { name: target.label, exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const listboxOpen = await page.evaluate(() => [...document.querySelectorAll('[role="listbox"]')].some((el) => el.getBoundingClientRect().height > 0));
    const record = { target: target.name, run, before, after: (await target.read(page)).trim(), listboxOpen, keys: await page.evaluate(() => window.keyLog) };
    await info.attach('select-keys', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  });
}
