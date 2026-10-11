import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

// Does `system=antd` still draw anything of its own? P6 deleted the AntD half of the choices fixture; this
// probe loads every sample under both `system` values twice each and digests the drawn DOM. Two runs of the
// same URL give the noise floor (React-generated ids are not in the digest); the two systems are compared
// against it. Out file per run: DUP_OUT.
const SAMPLES = ['attachment', 'submenu', 'session', 'expiry', 'popconfirm', 'search', 'multiple'];
const OUT = process.env.DUP_OUT ?? '/mnt/data/tmp/34dq7m9wxKsEaWbvtNqk2/runs/dup-check.json';
writeFileSync(OUT, '');

// Everything a reader of the fixture would see: tag, ARIA role and label, class list, and the text of leaves.
const digest = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('body *')].map((el) => {
    const role = el.getAttribute('role') ?? '';
    const label = el.getAttribute('aria-label') ?? '';
    const cls = typeof el.className === 'string' ? el.className : '';
    const text = el.children.length === 0 ? (el.textContent ?? '').trim().slice(0, 80) : '';
    return `${el.tagName.toLowerCase()}|${role}|${label}|${cls}|${text}`;
  });
  return { rows, text: document.body.innerText };
});

for (const sample of SAMPLES) for (const system of ['antd', 'orbit']) for (const run of [1, 2]) {
  test(`${sample} ${system} run ${run}`, async ({ page }) => {
    await page.goto(`/ui-migration/choices.html?system=${system}&sample=${sample}`);
    await page.evaluate(() => document.fonts.ready);
    const d = await digest(page);
    const hash = createHash('sha256').update(JSON.stringify(d)).digest('hex');
    appendFileSync(OUT, `${JSON.stringify({ sample, system, run, hash, rows: d.rows.length, text: d.text })}\n`);
    expect(d.rows.length).toBeGreaterThan(0);
  });
}
