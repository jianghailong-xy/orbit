// Web flows the scenarios share: the workspace form's Kimi account, a new Kimi session from the web.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { S, WEB, note, sleep } from './lib.mjs';

// /runners/<runner> → the workspace's row → Advanced → Kimi account → <option> → Save.
export async function setWorkspaceKimiAccount(page, { runner, workspaceName, option, shotTo, shot }) {
  await page.goto(`${WEB}/runners/${runner}`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('.rd-workspace-row').filter({ hasText: workspaceName }).first();
  await row.waitFor({ timeout: 60_000 });
  await row.click();
  const adv = page.locator('.rd-adv-toggle').first();
  await adv.waitFor({ timeout: 30_000 });
  await adv.click();
  const field = page.locator('.rd-form-field').filter({ has: page.locator('.rd-form-label', { hasText: /^Kimi account$/ }) }).first();
  await field.waitFor({ timeout: 30_000 });
  await field.scrollIntoViewIfNeeded();
  await field.locator('[role=combobox]').click();
  await sleep(700);
  const options = await page.locator('[role=option]').allInnerTexts();
  note('Kimi account options:', options);
  if (shotTo) await shot(page, shotTo, { fullPage: false });
  await page.locator('[role=option]').filter({ hasText: option }).first().click();
  await sleep(300);
  await page.getByRole('button', { name: /^Save$/ }).first().click();
  await sleep(1200);
  return options;
}

// /workspaces/<ws>/new → the hero's engine → Kimi → prompt → Send; returns the new session's id.
export async function newKimiSession(page, { workspace, prompt, shotTo, shot }) {
  await page.goto(`${WEB}/workspaces/${workspace}/new`, { waitUntil: 'domcontentloaded' });
  await page.locator('button[aria-label^="Engine:"]').click();
  await page.locator('.np-row').filter({ has: page.locator('.np-row-name', { hasText: /^Kimi/ }) }).first().click();
  await sleep(800);
  await page.locator('.composer-box textarea, textarea').first().fill(prompt);
  if (shotTo) await shot(page, shotTo, { fullPage: false });
  await page.locator('button[aria-label="Send"]').click();
  await page.waitForURL(/\/sessions\//, { timeout: 60_000 });
  return page.url().split('/sessions/')[1].split(/[/?#]/)[0];
}

// The runner's record of a session (runs/<uuid>/meta.json) whose Kimi runtime session is kimiId.
export function runnerMetaFor(runnerName, kimiId) {
  const runs = `${S}/runners/${runnerName}/home/runs`;
  for (const d of readdirSync(runs)) {
    const f = `${runs}/${d}/meta.json`;
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, 'utf8'));
    if (m.runtimeSessionId === kimiId) return { file: f, meta: m };
  }
  return null;
}

// The fake kimi's own log lines for an Orbit session.
export function fakeKimiEvents(runnerName, sessionId, since = '') {
  return readFileSync(`${S}/logs/fake-kimi-${runnerName}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((e) => e.orbitSession === sessionId && e.at >= since);
}

// Send one message on an open session page once the composer is idle (its button reads Send, not Stop — a click
// as a turn starts or ends could land on Stop), and wait until the web has posted it.
export async function sendMessage(page, sessionId, text) {
  const send = page.locator('button.composer-send[aria-label="Send"]');
  await page.locator('button.composer-send[aria-label="Stop"]').waitFor({ state: 'detached', timeout: 180_000 }).catch(() => {});
  await send.waitFor({ timeout: 60_000 });
  await sleep(800);
  await page.locator('.composer-box textarea, textarea').first().fill(text);
  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/sessions/${sessionId}/turns`), { timeout: 30_000 });
  await send.click();
  await posted;
}

// Wait until the fake kimi has answered `count` prompts of this session since `since` — its own log, not text on
// the page, which the session list's preview repeats — and give the page a moment to draw the last one.
export async function waitForTurns(runnerName, sessionId, since, count, { timeoutMs = 240_000, where = () => true } = {}) {
  const prompts = () => fakeKimiEvents(runnerName, sessionId, since).filter((e) => e.event === 'acp.prompt' && where(e));
  const end = Date.now() + timeoutMs;
  while (prompts().length < count) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${count} answered prompt(s) of ${sessionId}`);
    await sleep(1000);
  }
  await sleep(2500);
  return prompts();
}
