// The first workspace's real flows in a real browser against the kit's fixtures: what the vitest suites
// can't see (StrictMode's double effects in the dev build, keys in a field inside a radio group, focus).
// `unshare -n ./run-ns.sh <worktree> flow-p1.mjs`. Prints one line per check, and fails on the first miss.
import assert from 'node:assert/strict';
import { launch, open, settle } from './lib.mjs';
import * as D from './data.mjs';

const quiet = { 'GET /api/projects/sidebar': [], 'GET /api/wiki/spaces': [], 'GET /api/projects': [] };
const A = D.IDS.austin;
const SID = D.IDS.session;
const session = (over = {}) => ({
  id: SID, workspaceId: D.WS_APP.id, workspace: D.WS_APP, runnerId: A, assignedRunnerId: A, createdWorkspace: true,
  title: 'Fix it', provider: 'claude', engine: 'claude', model: 'claude-opus-5', status: 'RUNNING', runState: 'RUNNING',
  lifecycleState: 'OPEN', createdAt: D.ago(1), updatedAt: D.ago(0.2), startedAt: D.ago(1), shareToken: null, ...over,
});

/** A server for one flow: the fleet it starts with, and what POST /sessions was asked. */
function server(runner) {
  const s = { runner, workspaces: [], posts: [], login: D.LOGIN_IDLE, asks: [] };
  s.handler = (req, url) => {
    const p = url.pathname;
    if (req.method() === 'POST' && p === '/api/sessions') {
      s.posts.push(req.postDataJSON());
      s.workspaces = [D.WS_APP];
      return { ...session(), id: SID };
    }
    if (req.method() === 'POST' && p === `/api/runners/${A}/dir-probe`) { s.asks.push(req.postDataJSON().path); return undefined; }
    if (req.method() === 'POST' && p === `/api/runners/${A}/login/code`) {
      s.login = { ...D.LOGIN_IDLE, status: 'done', engine: 'claude' };
      s.runner = D.AUSTIN_READY;
      return s.login;
    }
    if (req.method() === 'POST' && p === `/api/runners/${A}/login`) return (s.login = D.LOGIN_AWAITING_CODE);
    if (req.method() !== 'GET') return undefined;
    if (p === '/api/runners') return [s.runner];
    if (p === `/api/runners/${A}`) return s.runner;
    if (p === `/api/runners/${A}/login`) return s.login;
    if (p === '/api/workspaces') return s.workspaces;
    if (p === '/api/sessions') return s.posts.length ? [session()] : [];
    if (p === `/api/sessions/${SID}`) return session();
    if (p === `/api/sessions/${SID}/events/page`) return { events: [], hasMore: false };
    if ([`/api/sessions/${SID}/turns`, `/api/sessions/${SID}/approvals`, `/api/sessions/${SID}/background`].includes(p)) return [];
    if (p === `/api/sessions/${SID}/diff`) return { files: [], patches: [] };
    if (p === `/api/sessions/${SID}/created-tasks`) return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] };
    return undefined;
  };
  return s;
}

const fresh = (b, s, path) => open(b, {
  path, handler: s.handler, height: 900,
  routes: { ...D.fleetRoutes({ runners: [s.runner], workspaces: [] }), ...quiet },
});
const composer = (page) => page.locator('.workspace-composer textarea');
const say = async (page, text) => { await composer(page).fill(text); await composer(page).press('Enter'); };
const ok = (what) => console.log(`ok - ${what}`);

const browser = await launch();
try {
  { // Landing, held, withdrawn.
    const s = server(D.AUSTIN);
    const { page, context } = await fresh(browser, s, '/');
    await page.locator('.msc').waitFor();
    assert.equal(new URL(page.url()).pathname, `/runners/${A}/new`);
    ok('a new account lands on the first online machine’s new session page');
    await say(page, 'Fix the login test');
    await page.locator('.msc-held').waitFor();
    assert.equal(await composer(page).inputValue(), '');
    assert.equal(s.posts.length, 0);
    ok('sent before the steps are done, the message waits and nothing is posted');
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await page.locator('.msc-held').waitFor({ state: 'detached' });
    assert.equal(await composer(page).inputValue(), 'Fix the login test');
    ok('Withdraw takes it back to the composer');
    await context.close();
  }
  { // Both steps with a message waiting: sign in through the real card, paste, and it goes once.
    const s = server(D.AUSTIN);
    const { page, context, errors } = await fresh(browser, s, `/runners/${A}/new`);
    await page.locator('.msc').waitFor();
    await page.getByText('Where you ran orbit register').waitFor();
    await say(page, 'Fix the login test');
    await page.locator('.msc-held').waitFor();
    await page.getByRole('button', { name: 'Use this folder' }).click();
    await page.evaluate(() => { window.open = () => null; });
    await page.getByRole('button', { name: 'Sign in to Claude Code' }).click();
    await page.getByPlaceholder('Paste the code').fill('abc#123');
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.waitForURL(`**/sessions/${SID}`, { timeout: 30_000 });
    await settle(page);
    await page.waitForTimeout(800);
    assert.equal(s.posts.length, 1, 'exactly one POST /sessions, StrictMode or not');
    assert.deepEqual(s.posts[0].newWorkspace, { workDir: '/home/orbit/code/app' });
    assert.equal(s.posts[0].prompt, 'Fix the login test');
    assert.equal(s.posts[0].assignedRunnerId, A);
    assert.equal(s.posts[0].workspaceId, undefined);
    assert.deepEqual([s.posts[0].engine, s.posts[0].provider], ['claude', 'claude']);
    ok('both steps done: the waiting message goes by itself, once, and the page is the new session');
    await page.locator('.msc-created').waitFor({ timeout: 8000 });
    assert.match((await page.locator('.msc-created').innerText()).replace(/\s+/g, ' '), /Created workspace app on orbit@austin · \/home\/orbit\/code\/app · Rename · Settings/);
    ok('the conversation opens with the Created workspace line');
    assert.deepEqual(errors.filter((e) => !/favicon|manifest/.test(e)), []);
    await context.close();
  }
  { // Ready first: a new folder, typed with the keys a radio group would otherwise take.
    const s = server(D.AUSTIN_READY);
    s.runner = { ...D.AUSTIN_READY, registerDir: '/home/orbit' };
    const { page, context } = await fresh(browser, s, `/runners/${A}/new`);
    await page.locator('.msc').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByText('Where you ran orbit register').count(), 0);
    const name = page.locator('.msc-input input');
    await name.click();
    await page.keyboard.type('payments');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('-');
    const typed = await name.inputValue();
    assert.equal(typed, 'paymen-ts');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    assert.ok(await name.isVisible(), 'arrows stayed in the field');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT');
    ok(`arrow keys stay in the field (${typed}); the radio group does not take them`);
    await name.fill('payments-api');
    await name.press('Enter');
    await page.locator('.msc-foot.ready').waitFor();
    assert.match(await page.locator('.msc-foot').innerText(), /Ready\. Send a task — Orbit adds the workspace “payments-api” for \/home\/orbit\/orbit-repos\/payments-api as it starts\./);
    ok('home is not suggested; a new folder under the Repos Folder reads Ready');
    await say(page, 'Clone the repo');
    await page.waitForURL(`**/sessions/${SID}`, { timeout: 30_000 });
    assert.equal(s.posts.length, 1);
    assert.deepEqual(s.posts[0].newWorkspace, { newFolder: 'payments-api' });
    ok('ready, a send makes the workspace at once');
    await context.close();
  }
  { // Other folder: a path that isn't there can't be used; a typed one is checked on the machine.
    const s = server(D.AUSTIN);
    const { page, context } = await fresh(browser, s, `/runners/${A}/new`);
    await page.locator('.msc').waitFor();
    await page.getByText('Where you ran orbit register').waitFor();
    await page.getByText('Another folder on orbit@austin').click();
    const field = page.locator('input.msc-path-input');
    await field.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('msc-path-input')), true);
    ok('choosing Another folder puts the caret in its field');
    await field.pressSequentially('/home/orbit/code/ap');
    await page.getByText('No such directory on orbit@austin.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Use this folder' }).isDisabled(), true);
    ok('a missing path is said on the spot and can’t be used');
    await field.fill('/home/orbit/notes');
    await page.getByText('Found · not a git repository — sessions will share it instead of isolating.').waitFor();
    await page.getByRole('button', { name: 'Use this folder' }).click();
    await page.locator('[data-step="folder"] .msc-done-line').waitFor();
    assert.ok(s.asks.includes('/home/orbit/notes'));
    ok('a folder that is no repository can be used, and says so');
    await context.close();
  }
  { // A pane shorter than the card: it starts at its top, and a held message still comes into view.
    const s = server(D.AUSTIN);
    const { page, context } = await open(browser, {
      path: `/runners/${A}/new`, handler: s.handler, height: 620,
      routes: { ...D.fleetRoutes({ runners: [s.runner], workspaces: [] }), ...quiet },
    });
    await page.locator('.msc').waitFor();
    await page.getByText('Where you ran orbit register').waitFor();
    await page.waitForTimeout(500);
    const start = await page.evaluate(() => {
      const card = document.querySelector('.msc');
      const pane = card.closest('.workspace-sessions');
      return { top: pane.scrollTop, overflow: pane.scrollHeight > pane.clientHeight, title: document.querySelector('.msc-title').getBoundingClientRect().top - pane.getBoundingClientRect().top };
    });
    assert.ok(start.overflow, 'the card is taller than this pane');
    assert.equal(start.top, 0);
    assert.ok(start.title > 0, 'the card’s title is on screen');
    ok('a pane shorter than the card opens at the top of the card');
    await say(page, 'Fix the login test');
    await page.locator('.msc-held').waitFor();
    await page.waitForTimeout(300);
    const inView = await page.evaluate(() => {
      const held = document.querySelector('.msc-held-state').getBoundingClientRect();
      const pane = document.querySelector('.msc').closest('.workspace-sessions').getBoundingClientRect();
      return held.bottom <= pane.bottom + 1 && held.top >= pane.top;
    });
    assert.ok(inView, 'the waiting message is in view');
    ok('the waiting message comes into view when it lands below the fold');
    await context.close();
  }
  { // A machine that has a workspace has no setup page.
    const s = server(D.AUSTIN);
    s.workspaces = [{ ...D.WS_APP }];
    const { page, context } = await fresh(browser, s, `/workspaces/${A}`);
    await page.waitForURL(`**/workspaces/${D.WS_APP.id}**`, { timeout: 30_000 });
    assert.equal(await page.locator('.msc').count(), 0);
    ok('an older /workspaces/<runner> link of a machine with a workspace ends at that workspace');
    await context.close();
  }
} finally {
  await browser.close();
}
