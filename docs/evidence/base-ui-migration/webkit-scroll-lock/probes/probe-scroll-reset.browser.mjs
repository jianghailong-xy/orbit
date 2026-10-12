import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only, not committed to the app's suites): the P4.2 "Codex pool" steps, with every change to
// .app-view's scroll position, every scroll/focus call and every <body> mutation logged with a stack.
const OUT = process.env.PROBE_OUT;
test('what resets the page scroll when a dialog opens after a notice', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  const named = (name) => new RegExp(`^(?:[a-z]+(?:-[a-z]+)* )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const button = (scope, name) => scope.getByRole('button', { name: named(name) });
  const box = (title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]').filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
  await page.goto(P42_PATHS.codexPool);
  const who = page.locator('.who-card');
  await expect(who).toBeVisible();
  await who.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const variant = process.env.PROBE_VARIANT || 'notice';
  if (variant === 'notice') {
    await button(who, 'Add people').click();
    const share = box('Share My Codex');
    await expect(share).toBeVisible();
    await share.getByRole('combobox', { name: 'People to add' }).click();
    await share.getByRole('combobox', { name: 'People to add' }).pressSequentially('zhang@example.test,');
    await button(share, 'Share').click();
    const added = page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Added to My Codex', { exact: true });
    await expect(added).toBeVisible();
    await expect(added).toHaveCount(0);
  }
  await page.evaluate(() => {
    const log = window.__scrollLog = [];
    const view = document.querySelector('.app-view');
    const t0 = performance.now();
    const name = (el) => (el === window ? 'window' : `${el.nodeName}.${String(el.className?.baseVal ?? el.className ?? '').slice(0, 60)}`);
    const note = (type, extra = {}) => log.push({ t: +(performance.now() - t0).toFixed(1), type, top: view.scrollTop, scrollHeight: view.scrollHeight,
      clientHeight: view.clientHeight, docTop: document.documentElement.scrollTop, docHeight: document.documentElement.scrollHeight,
      body: document.body.style.cssText, html: document.documentElement.style.cssText, ...extra });
    view.addEventListener('scroll', () => note('view scroll event'));
    document.addEventListener('scroll', (e) => { if (e.target !== view) note('other scroll event', { target: name(e.target === document ? document.documentElement : e.target) }); }, true);
    new ResizeObserver(() => note('view resize')).observe(view);
    new MutationObserver((records) => note('body/html mutation', { what: records.map((r) => `${name(r.target)}:${r.type}:${r.attributeName ?? ''}`).slice(0, 8) }))
      .observe(document.documentElement, { attributes: true, childList: true });
    new MutationObserver((records) => note('body mutation', { what: records.map((r) => `${name(r.target)}:${r.type}:${r.attributeName ?? ''}:${[...r.addedNodes].map(name).join(',')}`).slice(0, 8) }))
      .observe(document.body, { attributes: true, childList: true });
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get: desc.get,
      set(value) { note('set scrollTop', { el: name(this), value, stack: new Error().stack }); desc.set.call(this, value); } });
    for (const [proto, method] of [[Element.prototype, 'scrollTo'], [Element.prototype, 'scroll'], [Element.prototype, 'scrollBy'], [Element.prototype, 'scrollIntoView'],
      [Element.prototype, 'scrollIntoViewIfNeeded'], [HTMLElement.prototype, 'focus'], [SVGElement.prototype, 'focus'], [window, 'scrollTo'], [window, 'scroll']]) {
      const original = proto[method];
      if (!original) continue;
      proto[method] = function (...args) { note(method, { el: name(this), args: JSON.stringify(args).slice(0, 120), stack: new Error().stack }); return original.apply(this, args); };
    }
    note('instrumented');
  });
  await button(page, 'Replace key').click();
  const replace = box('Replace lin-proj');
  await expect(replace).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
  await page.evaluate(() => window.__scrollLog.push({ type: 'end', top: document.querySelector('.app-view').scrollTop }));
  const log = await page.evaluate(() => window.__scrollLog);
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, variant, log }) + '\n');
});
