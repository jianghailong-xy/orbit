import { writeFileSync } from 'node:fs';
import { test, expect } from './harness.mjs';
import { P51_PATHS, installP51Fixtures } from './p51-fixtures.mjs';

// Development probe (not committed): where focus goes when the merge-target menu opens from the keyboard, the first
// and the second time, and where ArrowDown, Tab and Escape take it, in either tree.
test('probe merge keyboard', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
  const bar = page.locator('.wt-bar').first();
  await page.goto(P51_PATHS.codex);
  await expect(bar).toBeVisible({ timeout: 45_000 });
  const caret = page.getByRole('button', { name: 'Choose a branch to merge into', exact: true });
  const focus = () => page.evaluate(() => {
    const a = document.activeElement;
    const menuOpen = [...document.querySelectorAll('[role="menu"]')].some((m) => {
      const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(m).visibility !== 'hidden';
    });
    if (!a || a === document.body) return { at: 'body', menuOpen };
    return { at: `${a.tagName.toLowerCase()}${a.getAttribute('role') ? `[${a.getAttribute('role')}]` : ''}`,
      name: (a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), menuOpen };
  });
  const log = [];
  for (const round of [1, 2]) {
    await caret.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    log.push({ round, step: 'Enter', ...(await focus()) });
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    log.push({ round, step: 'ArrowDown', ...(await focus()) });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    log.push({ round, step: 'Tab', ...(await focus()) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    log.push({ round, step: 'Escape', ...(await focus()) });
  }
  writeFileSync(process.env.PROBE_OUT, JSON.stringify(log, null, 1));
});
