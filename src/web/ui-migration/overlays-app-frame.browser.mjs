import { test, expect } from '@playwright/test';

// The reference overlays inside the app's page frame (overlays.html?app-frame): the page scrolls in
// .app-view and the document never does. The first notice leaves lib/toast's screen-reader live region
// at the end of <body>; from then on, opening and closing an overlay must still leave the page where it
// was scrolled, as the replaced AntD overlays do (docs/evidence/base-ui-migration/webkit-scroll-lock).
const fixture = '/ui-migration/overlays.html?app-frame';
const errors = new WeakMap();
test.beforeEach(async ({ page }, info) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
  await page.goto(fixture);
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
    .toEqual({ width: info.project.use.viewport.width, dpr: 1, scale: 1 });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function settled(overlay) {
  await expect(overlay).toBeVisible();
  await expect.poll(() => overlay.evaluate((el) => {
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.opacity !== '1' || s.transform !== 'none' || (s.scale !== 'none' && s.scale !== '1')) return false;
    }
    return true;
  })).toBe(true);
  await overlay.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const locked = (page) => page.evaluate(() => [document.documentElement, document.body].some((el) => /hidden|clip/.test(getComputedStyle(el).overflowY)));
// The page's scroll position, the document's own height and scrollbar, and what a scroll lock wrote inline.
const frame = (page) => page.evaluate(() => {
  const html = document.documentElement;
  return { pageScrollTop: document.querySelector('.app-view').scrollTop, documentHeight: html.scrollHeight, viewportHeight: innerHeight,
    documentScrollbar: innerWidth - html.clientWidth, htmlStyle: html.style.cssText, bodyStyle: document.body.style.cssText };
});
async function notice(page) {
  await page.getByRole('button', { name: 'Show notice', exact: true }).click();
  await expect(page.locator('body > [aria-live="polite"]')).toHaveText('Workspace saved');
  await page.getByRole('button', { name: 'Clear notifications', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toHaveCount(0);
}

test('a notice leaves the document one viewport high, with no scrollbar of its own', async ({ page }, info) => {
  const before = await frame(page);
  await notice(page);
  const after = await frame(page);
  await info.attach('document', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
  expect(before.documentHeight).toBe(before.viewportHeight);
  expect(before.documentScrollbar).toBe(0);
  expect(after.documentHeight).toBe(after.viewportHeight);
  expect(after.documentScrollbar).toBe(0);
});

for (const kind of ['dialog', 'right drawer', 'bottom drawer', 'confirm']) for (const system of ['Orbit', 'AntD']) {
  test(`${system} ${kind} leaves the page where it was scrolled, before and after a notice`, async ({ page }, info) => {
    const trigger = page.getByRole('button', { name: `${system} ${kind}`, exact: true });
    const overlay = page.getByRole(system === 'Orbit' && kind === 'confirm' ? 'alertdialog' : 'dialog');
    const states = [];
    for (const when of ['before a notice', 'after a notice']) {
      if (when === 'after a notice') await notice(page);
      // Scroll the page as a reader would, so the overlay's button sits near the top of the view.
      const scrolled = await trigger.evaluate((el) => {
        const view = el.closest('.app-view');
        view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - 80;
        return view.scrollTop;
      });
      expect(scrolled).toBeGreaterThan(0);
      states.push({ when, step: 'scrolled', ...(await frame(page)) });
      await trigger.click();
      await settled(overlay);
      await expect.poll(() => locked(page)).toBe(true);
      const open = await frame(page);
      states.push({ when, step: 'open', ...open });
      expect.soft(open.pageScrollTop, `${system} ${kind} open ${when}`).toBe(scrolled);
      await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(overlay).toHaveCount(0);
      await expect.poll(() => locked(page)).toBe(false);
      const closed = await frame(page);
      states.push({ when, step: 'closed', ...closed });
      expect.soft(closed.pageScrollTop, `${system} ${kind} closed ${when}`).toBe(scrolled);
    }
    await info.attach('scroll-positions', { body: JSON.stringify(states, null, 2), contentType: 'application/json' });
  });
}
