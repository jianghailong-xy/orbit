import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Probe (dev-only): on the P4.2 Codex pool page, with the page scrolled to the bottom of its range, apply
// the inline styles Base UI's scroll lock writes for an inset scrollbar one at a time (no overlay open)
// and read .app-view's scroll position after each.
const OUT = process.env.PROBE_OUT;
test('which lock style resets the page scroll', async ({ evidence }, testInfo) => {
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
  const steps = await page.evaluate(async () => {
    const view = document.querySelector('.app-view');
    const html = document.documentElement, body = document.body;
    const out = [];
    const read = (step) => out.push({ step, top: view.scrollTop, scrollHeight: view.scrollHeight, clientHeight: view.clientHeight, viewWidth: view.clientWidth,
      bodyHeight: body.getBoundingClientRect().height, bodyWidth: body.getBoundingClientRect().width, docHeight: html.scrollHeight, scrollbar: innerWidth - html.clientWidth });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    read('start');
    for (const [step, apply] of [
      ['html scrollbar-gutter stable', () => { html.style.scrollbarGutter = 'stable'; }],
      ['html overflow-y hidden', () => { html.style.overflowY = 'hidden'; }],
      ['html overflow-x hidden', () => { html.style.overflowX = 'hidden'; }],
      ['html overflow-y scroll', () => { html.style.overflowY = 'scroll'; }],
      ['body position relative', () => { body.style.position = 'relative'; }],
      ['body height 100dvh', () => { body.style.height = '100dvh'; }],
      ['body width calc(100vw - 8px)', () => { body.style.width = 'calc(100vw - 8px)'; }],
      ['body box-sizing border-box', () => { body.style.boxSizing = 'border-box'; }],
      ['body overflow-y hidden', () => { body.style.overflowY = 'hidden'; }],
      ['body overflow-x hidden', () => { body.style.overflowX = 'hidden'; }],
    ]) { apply(); read(step); await frame(); read(`${step} (+2 frames)`); }
    html.style.cssText = ''; body.style.cssText = '';
    read('restored'); await frame(); read('restored (+2 frames)');
    return out;
  });
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, variant, steps }) + '\n');
});
