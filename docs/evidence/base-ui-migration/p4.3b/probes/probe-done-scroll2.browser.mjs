import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';
import { fill, frames, observe } from './p43b-helpers.mjs';

// Probe: the done dialog's "Not yet", the spec's own steps; every focus() call, scrollIntoView and
// scroll of the dialog's scroller, with the focus at the time, on this tree.
test('done dialog scroll, spec steps', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await page.addInitScript(() => {
    window.__log = [];
    const describe = (el) => el ? `${el.tagName}.${(el.getAttribute?.('class') ?? '').slice(0, 40)}` : String(el);
    const scroller = () => document.querySelector('.orbit-overlay-viewport:not([hidden]), .ant-modal-wrap');
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options) {
      const before = scroller()?.scrollTop ?? null;
      const result = focus.call(this, options);
      window.__log.push({ kind: 'focus', target: describe(this), options: options ?? null, before, after: scroller()?.scrollTop ?? null });
      return result;
    };
    const into = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg) { window.__log.push({ kind: 'scrollIntoView', target: describe(this), arg: arg ?? null }); return into.call(this, arg); };
    document.addEventListener('scroll', (event) => {
      const el = event.target;
      if (el?.classList?.contains('ant-modal-wrap') || el?.classList?.contains('orbit-overlay-viewport')) window.__log.push({ kind: 'scroll', top: el.scrollTop, active: describe(document.activeElement) });
    }, true);
    document.addEventListener('focusin', (event) => window.__log.push({ kind: 'focusin', target: describe(event.target) }), true);
    document.addEventListener('focusout', (event) => window.__log.push({ kind: 'focusout', target: describe(event.target), related: describe(event.relatedTarget) }), true);
  });
  const fixtures = await installP43bFixtures(page, { done: true });
  const log = async (what) => {
    const s = await page.evaluate(() => ({ top: document.querySelector('.orbit-overlay-viewport:not([hidden]), .ant-modal-wrap')?.scrollTop, active: `${document.activeElement?.tagName}.${(document.activeElement?.getAttribute('class') ?? '').slice(0, 40)}` }));
    console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${what} ${JSON.stringify(s)}`);
    for (const entry of await page.evaluate(() => window.__log.splice(0))) console.log(`PROBE   ${JSON.stringify(entry)}`);
  };
  await page.goto(P43B_PATHS.project);
  await page.locator('.project-open-items').getByRole('button', { name: /^Review/ }).first().click();
  const done = page.locator('[role="dialog"]').filter({ has: page.locator('.project-done-card') }).filter({ visible: true }).last();
  await expect(done.locator('.project-done-card')).toBeVisible();
  await frames(page);
  await observe(page, fixtures, 'done question');
  await log('opened');
  await done.getByRole('button', { name: /^Not yet/ }).click();
  const note = done.getByRole('textbox', { name: /^What’s missing/ });
  await expect(note).toBeVisible();
  await log('not yet pressed');
  await fill(note, 'The phone screenshots of the graph are still missing from the evidence.');
  await frames(page);
  await log('typed');
});
