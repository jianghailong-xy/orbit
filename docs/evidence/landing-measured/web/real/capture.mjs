// The landing-measured web screens against the REAL apiserver of this worktree (throwaway Postgres): the built dist
// served by gateway.mjs, the browser signed in as the seeded owner, every read answered by the server and every write
// sent to it. After each write the rows it left are read back with psql (read-only SELECTs).
// usage: run.sh  (sets up the env, seeds, runs this, prints one JSON line per shot / query)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = process.env.WT;
const OUT = path.resolve(HERE, '..');
const BASE = `http://127.0.0.1:${process.env.WEB_PORT}`;
const seed = JSON.parse(fs.readFileSync(process.env.SEED_FILE, 'utf8'));
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);

const sql = (query) => execFileSync('docker', ['exec', 'lm-real-pg', 'psql', '-U', 'postgres', '-d', 'orbit', '-At', '-F', ' | ', '-c', query], { encoding: 'utf8' }).trim();
const say = (what) => console.log(JSON.stringify(what));

const browser = await chromium.launch({ env: process.env.FONTCONFIG_FILE ? { ...process.env } : process.env, args: ['--disable-features=BackForwardCache'] });
async function open(theme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2200 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(({ tokens, theme }) => {
    localStorage.setItem('orbit_token', tokens.accessToken);
    localStorage.setItem('orbit_refresh', tokens.refreshToken);
    localStorage.setItem('orbit-theme', theme);
  }, { tokens: seed.tokens, theme });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const writes = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) writes.push({ method: r.method(), path: new URL(r.url()).pathname, body: r.postData() ? JSON.parse(r.postData()) : null }); });
  return { context, page, errors, writes };
}
async function shot(page, selector, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  const file = `${OUT}/real-${name}.png`;
  await target.screenshot({ path: file, animations: 'disabled' });
  say({ shot: path.relative(WT, file), text: (await target.innerText()).slice(0, 400) });
}
const B = seed.B;
const A = seed.A;

// ── read-only screens, dark then light ────────────────────────────────────────────────────────────
for (const theme of ['dark', 'light']) {
  const { context, page, errors } = await open(theme);
  const taskRead = page.waitForResponse((r) => r.url().includes(`/api/tasks/`) && r.request().method() === 'GET' && !r.url().includes('/dependency') && r.url().split('/api/tasks/')[1].split('?')[0].length < 30);
  await page.goto(`${BASE}/projects/${B.projectId}/tasks/${B.exemptTask}`);
  await page.locator('[data-task-exempt]').first().waitFor();
  const task = await (await taskRead).json();
  say({ read: 'GET /api/tasks/:id', landingCheckExempt: task.landingCheckExempt, landingCheckExemptReason: task.landingCheckExemptReason });
  await shot(page, '[aria-label="Task landing"]', `task-exempt-${theme}`);

  await page.goto(`${BASE}/projects/${B.projectId}`);
  await page.locator('.project-landing-none').first().waitFor();
  await shot(page, '.project-run-settings', `settings-no-check-coordinator-${theme}`);
  await page.locator('.project-changes-row').click();
  await page.locator('.project-changes-list').waitFor();
  await shot(page, '.project-changes', `changes-list-${theme}`);
  say({ theme, errors: errors.filter((e) => !/501/.test(e)) });
  await context.close();
}

// ── (c) the settings block with the non-code mark set, then one Revert, light and dark ──────────────
sql(`UPDATE project SET non_code = true, non_code_set_by = 'OWNER', non_code_set_at = now() WHERE id='${B.projectId}'::uuid`);
const rowsQuery = `SELECT field, origin, reverts_change_id IS NOT NULL AS is_revert, old_value::text, new_value::text FROM project_setting_change WHERE project_id='${B.projectId}'::uuid ORDER BY created_at`;
// One theme per run (THEME=light|dark): the Revert is written once, so the dark pass re-seeds a fresh database.
for (const theme of [process.env.THEME ?? 'light']) {
  const { context, page, writes } = await open(theme);
  await page.goto(`${BASE}/projects/${B.projectId}`);
  await page.locator('.project-changes-row').waitFor();
  await shot(page, '.project-run-settings', `settings-non-code-${theme}`);
  say({ theme, landingOffDrawn: (await page.locator('.project-run-landing-off').count()) > 0 });
  await page.locator('.project-changes-row').click();
  await page.locator('.project-changes-list').waitFor();
  say({ theme, before: sql(rowsQuery) });
  await shot(page, '.project-changes', `changes-before-revert-${theme}`);
  await page.locator('.project-change-row button').first().click();
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  await dialog.waitFor();
  await shot(page, '[role="dialog"], [role="alertdialog"]', `changes-confirm-${theme}`);
  await dialog.getByRole('button', { name: 'Revert' }).click();
  await page.locator('.project-change-reverted').first().waitFor();
  await shot(page, '.project-changes', `changes-after-revert-${theme}`);
  say({ theme, writes });
  say({ theme, after: sql(rowsQuery) });
  await context.close();
}

// ── (a) the Start press on a request with no line, in a workspace that HAS a repository, light ───────
{
  const { context, page, writes } = await open('light');
  say({ workspaceHasRepository: sql(`SELECT w.repo_url FROM project p JOIN workspace w ON w.id = p.coordinator_workspace_id WHERE p.id='${A.projectId}'::uuid`) });
  say({ beforeStart: sql(`SELECT (SELECT count(*) FROM project_codebase WHERE project_id='${A.projectId}'::uuid) AS codebase_rows, (SELECT started_at IS NOT NULL FROM project WHERE id='${A.projectId}'::uuid) AS started`) });
  await page.goto(`${BASE}/sessions/${A.sessionId}?project=${A.projectId}`);
  await page.locator('.start-card').first().waitFor();
  await page.locator('.start-card-plan span').first().waitFor();
  await shot(page, '.start-card', 'start-no-line-light');
  await page.locator('.start-card').getByRole('button', { name: 'Start the project' }).click();
  for (let n = 0; n < 60; n += 1) {
    if (sql(`SELECT started_at IS NOT NULL FROM project WHERE id='${A.projectId}'::uuid`) === 't') break;
    await page.waitForTimeout(500);
  }
  say({ startWrites: writes.filter((w) => w.path.includes('/start')) });
  say({ afterStart: sql(`SELECT (SELECT count(*) FROM project_codebase WHERE project_id='${A.projectId}'::uuid) AS codebase_rows, (SELECT started_at IS NOT NULL FROM project WHERE id='${A.projectId}'::uuid) AS started`) });
  await page.waitForTimeout(1500);
  await context.close();
}
await browser.close();
