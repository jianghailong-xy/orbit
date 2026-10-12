import { test, expect } from './harness.mjs';
import { PATHS } from './fixtures.mjs';

// Diagnostic for the P0 getByText flake: lib/toast.tsx fills a body-level screen-reader live region
// with the toast's text 50ms after the toast appears. Waiting for that copy makes the race
// deterministic: the P0.2 page-wide locator then resolves to two elements (strict mode violation),
// the Notifications-scoped locator to the visible toast alone.
const cases = {
  settings: { text: 'Setting saved', act: (page) => page.getByRole('switch').first().click() },
  profile: { text: 'Name saved', act: async (page) => {
    await page.locator('input[autocomplete="name"]').fill('Baseline Reviewer Updated');
    await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
  } },
};
for (const [route, { text, act }] of Object.entries(cases)) {
  test(`announce duplicate: ${text}`, async ({ evidence }, info) => {
    const { page } = evidence;
    await page.goto(PATHS[route]);
    await expect(page.getByRole('heading', { name: route === 'settings' ? 'Settings' : 'Profile', exact: true })).toBeVisible();
    await act(page);
    const region = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(region.getByText(text, { exact: true })).toBeVisible();
    await page.waitForFunction((t) => [...document.querySelectorAll('body > .sr-only[aria-live]')].some((el) => el.textContent === t), text);
    const original = page.getByText(text, { exact: true });
    const scoped = region.getByText(text, { exact: true });
    const describe = (locator) => locator.evaluateAll((els) => els.map((el) => ({ tag: el.tagName, className: el.className, ariaLive: el.getAttribute('aria-live'), inNotifications: !!el.closest('section[aria-label="Notifications"]'), rect: el.getBoundingClientRect().toJSON() })));
    const outcome = (locator) => expect(locator).toBeVisible({ timeout: 1000 }).then(() => 'visible', (error) => error.message.split('\n').find((line) => line.includes('strict mode')) || error.message.split('\n')[0]);
    const record = { text, original: { matches: await describe(original), toBeVisible: await outcome(original) }, scoped: { matches: await describe(scoped), toBeVisible: await outcome(scoped) } };
    await info.attach('announce-duplicate', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
    expect(record.original.matches.length).toBe(2);
    expect(record.original.toBeVisible).toContain('strict mode violation');
    expect(record.scoped.matches).toHaveLength(1);
    expect(record.scoped.matches[0].inNotifications).toBe(true);
    expect(record.scoped.toBeVisible).toBe('visible');
  });
}
