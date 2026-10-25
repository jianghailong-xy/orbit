import { test, expect } from './harness.mjs';
import { appendFileSync } from 'node:fs';
import { P42_PATHS, installP42Fixtures } from './p42-fixtures.mjs';
// Dev-only probe (not committed): who moves focus when Rename is chosen from an account's menu.
// Where the results go: PROBE_OUT, one JSON line per run.
const OUT = process.env.PROBE_OUT;
test('rename from the account menu', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.addInitScript(() => {
    const log = (window.__focusLog = []);
    const t0 = performance.now();
    const what = (el) => el && el !== document.body ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ').slice(0, 2).join('.')}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? ''}]` : 'body';
    const stack = () => (new Error().stack ?? '').split('\n').slice(2, 9).map((line) => line.replace(/https?:\/\/[^/]+/, '').replace(/\?v=[0-9a-f]+/, '')).join(' | ');
    for (const name of ['focus', 'blur']) {
      const original = HTMLElement.prototype[name];
      HTMLElement.prototype[name] = function (...args) { log.push([+(performance.now() - t0).toFixed(1), `${name}()`, what(this), stack()]); return original.apply(this, args); };
    }
    for (const type of ['focusin', 'focusout']) document.addEventListener(type, (e) => log.push([+(performance.now() - t0).toFixed(1), type, what(e.target), `related ${what(e.relatedTarget)}`]), true);
    new MutationObserver((records) => { for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) if (n.nodeType === 1 && (n.matches?.('.re-name-input, [role="menu"]') || n.querySelector?.('.re-name-input, [role="menu"]'))) log.push([+(performance.now() - t0).toFixed(1), r.addedNodes.length && [...r.addedNodes].includes(n) ? 'added' : 'removed', what(n.matches?.('.re-name-input, [role="menu"]') ? n : n.querySelector('.re-name-input, [role="menu"]'))]); }).observe(document, { childList: true, subtree: true });
    const timeout = window.setTimeout;
    window.setTimeout = function (fn, ms, ...rest) { const s = stack(); return timeout.call(this, (...a) => { if (s.includes('RunnerEngines')) log.push([+(performance.now() - t0).toFixed(1), 'timeout fires', String(ms), s.slice(0, 200)]); return typeof fn === 'function' ? fn(...a) : undefined; }, ms, ...rest); };
  });
  await page.goto(P42_PATHS.providers);
  const work = page.locator('.re-row').filter({ has: page.locator('.re-name', { hasText: /^Work/ }) }).first();
  await expect(work).toBeVisible();
  const more = work.getByRole('button', { name: 'More actions' });
  await more.click();
  await page.getByRole('menuitem', { name: /Remove account$/ }).click();
  const remove = page.locator('[role="dialog"]').filter({ has: page.getByText('Remove Work?', { exact: true }) });
  await expect(remove).toBeVisible();
  await remove.getByRole('button', { name: 'Cancel' }).click();
  await expect(remove).toHaveCount(0);
  await page.evaluate(() => window.__focusLog.push(['---', 'rename starts']));
  await more.click();
  await page.getByRole('menuitem', { name: /Rename$/ }).click();
  await page.waitForTimeout(800);
  const editor = await page.locator('input.re-name-input').count();
  const active = await page.evaluate(() => document.activeElement?.className);
  const log = await page.evaluate(() => window.__focusLog);
  const start = log.findIndex((entry) => entry[0] === '---');
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, repeat: testInfo.repeatEachIndex, editor, active, log: log.slice(start) }) + '\n');
});

test('configure from the workspace menu', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(P42_PATHS.studio);
  const web = page.locator('.rd-workspace-row').filter({ has: page.locator('.rd-workspace-name', { hasText: /^orbit-web$/ }) }).first();
  await expect(web).toBeVisible();
  await web.locator('button[title="Actions"]').click();
  await page.getByRole('menuitem', { name: /Configure$/ }).click();
  await expect(page.locator('.rd-workspace-form')).toBeVisible();
  await page.waitForTimeout(500);
  const active = await page.evaluate(() => { const el = document.activeElement; return el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}[${el.getAttribute('placeholder') ?? el.getAttribute('aria-label') ?? ''}]` : null; });
  appendFileSync(OUT, JSON.stringify({ project: testInfo.project.name, repeat: testInfo.repeatEachIndex, test: 'configure', active }) + '\n');
});
