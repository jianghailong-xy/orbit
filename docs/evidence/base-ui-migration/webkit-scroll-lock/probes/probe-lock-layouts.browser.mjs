import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): the Codex pool page after a notice; every offsetWidth read Base UI's lock makes (each
// forces a layout) and every inline style write on <html>/<body> is logged with .app-view's position.
const OUT = process.env.PROBE_OUT;
test('pool page: layouts inside the scroll lock', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  const named = (name) => new RegExp(`^(?:[a-z]+(?:-[a-z]+)* )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const button = (scope, name) => scope.getByRole('button', { name: named(name) });
  const box = (title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]').filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
  await page.goto(P42_PATHS.codexPool);
  const who = page.locator('.who-card');
  await expect(who).toBeVisible();
  await who.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await button(who, 'Add people').click();
  const share = box('Share My Codex');
  await expect(share).toBeVisible();
  await share.getByRole('combobox', { name: 'People to add' }).click();
  await share.getByRole('combobox', { name: 'People to add' }).pressSequentially('zhang@example.test,');
  await button(share, 'Share').click();
  const added = page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Added to My Codex', { exact: true });
  await expect(added).toBeVisible();
  await expect(added).toHaveCount(0);
  await page.evaluate(() => {
    const log = window.__lockLog = [];
    const view = document.querySelector('.app-view');
    const state = (what) => log.push({ what, top: view.scrollTop, scrollHeight: view.scrollHeight, clientWidth: view.clientWidth, clientHeight: view.clientHeight,
      html: document.documentElement.style.cssText, body: document.body.style.cssText });
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() {
      const value = offsetWidth.get.call(this);
      if (this === document.body || this === document.documentElement) state(`read ${this.nodeName}.offsetWidth = ${value}`);
      return value;
    } });
    const style = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'overflowY');
    log.push({ what: `CSSStyleDeclaration.overflowY accessor: ${!!style}` });
    state('instrumented');
  });
  await button(page, 'Replace key').click();
  const replace = box('Replace lin-proj');
  await expect(replace).toBeVisible();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__lockLog.push({ what: 'end', top: document.querySelector('.app-view').scrollTop }));
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, log: await page.evaluate(() => window.__lockLog) }) + '\n');
});
