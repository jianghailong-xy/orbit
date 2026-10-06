import { test, expect } from '@playwright/test';

// Read-only diagnostic for the r8 full-matrix failure "select supports arrows, Enter ...": the
// unchanged test presses ArrowDown, ArrowDown, Enter without waiting in between. It repeats that
// exact sequence under Chromium CPU throttling for the Orbit field, the Orbit sample and the legacy
// AntD sample, and logs which element received each key and whether a listbox existed yet.
const TARGETS = [
  { name: 'orbit-field', url: '/ui-migration/choices.html', label: 'Expires',
    read: (page) => page.getByRole('status', { name: 'Expiry value', exact: true }).textContent() },
  { name: 'orbit-sample', url: '/ui-migration/choices.html?system=orbit&sample=expiry', label: 'Sample choice',
    read: (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText() },
  { name: 'antd-sample', url: '/ui-migration/choices.html?system=antd&sample=expiry', label: 'Sample choice',
    read: (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText() },
];
const RATES = [1, 6, 20];
const RUNS = 5;

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

for (const target of TARGETS) for (const rate of RATES) {
  test(`${target.name} ArrowDown ArrowDown Enter at ${rate}x CPU throttling`, async ({ page }, info) => {
    test.skip(info.project.use.browserName !== 'chromium', 'CPU throttling is a Chromium DevTools protocol feature');
    const runs = [];
    for (let run = 0; run < RUNS; run++) {
      await page.goto(target.url);
      await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      await page.evaluate(() => document.fonts.ready);
      const before = (await target.read(page)).trim();
      await page.evaluate(observeKeys);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.getByRole('combobox', { name: target.label, exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await page.waitForTimeout(300);
      const listboxOpen = await page.evaluate(() => [...document.querySelectorAll('[role="listbox"]')].some((el) => el.getBoundingClientRect().height > 0));
      runs.push({ run, before, after: (await target.read(page)).trim(), listboxOpen, keys: await page.evaluate(() => window.keyLog) });
      await cdp.detach();
    }
    await info.attach('select-keys', { body: JSON.stringify({ target: target.name, rate, runs }, null, 2), contentType: 'application/json' });
  });
}
