// The rehearsal, in one browser tab, from an empty server (criterion 7 of project 34pLjYBjU6ILsehatEjJs).
//   FWS_RUN=<name> FWS_ORDER=sign-in-first|folder-first node journey.mjs
// Nothing here writes to the database or calls a mutating API: every change goes through the web page or the runner.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import {
  EV, MH, REPOS_ROOT, S, WEB, check, excerpt, fakeSince, finding, launch, logSince, logSize, newPerson, note, psql, query, shot,
  sleep, stack, until, wireSince,
} from './lib.mjs';

const ORDER = process.env.FWS_ORDER === 'folder-first' ? 'folder-first' : 'sign-in-first';
// Where `orbit register` runs. The first run stands in the repository, so the card offers it. The second stands in the
// home directory, which is where the install script usually leaves a person (board rule 2): nothing may be offered, and
// the same repository has to be typed.
const FROM_HOME = ORDER === 'folder-first';
const M = 'lab-mac';
const GIT_DIR = `${MH}/code/payments-api`;
const GIT_DIR_2 = `${MH}/code/billing-api`;
const NEW_NAME = 'scratch-notes';
const NEW_PATH = `${REPOS_ROOT}/${NEW_NAME}`;
const MISSING = `${MH}/code/does-not-exist`;
const MSG_1 = 'List the files in this project and say where you are running.';
const MSG_2 = 'Make a note of what you can see in this new folder.';
const MSG_3 = 'Which branch is this repository on?';

const WS_SQL = `select w.name, w.work_dir, w.auto_create_work_dir, w.enable_worktree, w.work_dir_exists, w.work_dir_is_git,
  w.repo_url, (w.deleted_at is not null) as deleted, r.name as runner from workspace w left join runner r on r.id = w.runner_id order by w.created_at`;
const SESSION_SQL = `select w.name as workspace, s.created_workspace, w.auto_create_work_dir, w.work_dir, s.status, s.engine, s.provider, s.num_turns,
  left(s.prompt, 40) as prompt, s.title from session s left join workspace w on w.id = s.workspace_id order by s.created_at`;

const browser = await launch();
const person = await newPerson(browser);
const { context } = person;
let { page } = person;
const apiGet = (path) => page.evaluate(async (p) => {
  const t = localStorage.getItem('orbit_token');
  const r = await fetch(`/api${p}`, { headers: { authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}, path);
const cardText = async () => (await page.locator('.msc').innerText().catch(() => '')).replace(/\n+/g, ' | ');
const has = async (locator) => (await locator.count()) > 0;
const composerOf = () => page.getByPlaceholder(new RegExp(`Send ${M} a task`));
const sessionsPosted = (from) => wireSince(from).filter((e) => e.call === 'POST /api/sessions');
const heldState = async () => (await page.locator('.msc-held-state').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
const folderOption = (text) => page.locator('.msc-option').filter({ hasText: text });
const useFolder = () => page.getByRole('button', { name: 'Use this folder' });

const logs = ['wire.jsonl', 'runner.log', 'apiserver.log', 'fake-claude.jsonl'];
const marks = () => Object.fromEntries(logs.map((l) => [l, logSize(l)]));
const NOISE = /RouterExplorer|RoutesResolver|InstanceLoader|model catalogue/;
function keepLogs(tag, from) {
  excerpt('wire.jsonl', from['wire.jsonl'], `${tag}-wire.jsonl`);
  excerpt('runner.log', from['runner.log'], `${tag}-runner.log`);
  excerpt('apiserver.log', from['apiserver.log'], `${tag}-apiserver.log`, /./);
  excerpt('fake-claude.jsonl', from['fake-claude.jsonl'], `${tag}-fake-claude.jsonl`, /"kind": "(session|turn|auth-|stdin-closed)/);
  const a = readFileSync(`${EV}/${tag}-apiserver.log`, 'utf8').split('\n').filter((l) => !NOISE.test(l));
  writeFileSync(`${EV}/${tag}-apiserver.log`, a.join('\n'));
}

/** The engine processes alive now and the directory the kernel says each one runs in. Read from /proc directly: a
 *  pgrep through a shell finds the shell, whose command line holds the pattern. */
function liveEngines() {
  const rows = [];
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!argv.some((a) => a.endsWith('/runner-path/claude')) || !argv.includes('--input-format')) continue;
      const session = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('ORBIT_SESSION_ID='))?.split('=')[1];
      rows.push({ pid: +pid, session, cwd: readlinkSync(`/proc/${pid}/cwd`) });
    } catch { /* gone between the two reads */ }
  }
  return rows;
}
const runsIn = (session, dir) => liveEngines().some((e) => e.session === session && e.cwd === dir);

async function signIn(tag) {
  const popupP = context.waitForEvent('page', { timeout: 20_000 });
  const pressed = Date.now();
  await page.getByRole('button', { name: 'Sign in to Claude Code' }).click();
  const popup = await popupP;
  check('the press parks a tab while the link is on its way', popup.url() === 'about:blank' || /claude\.com/.test(popup.url()), popup.url().slice(0, 60));
  await popup.waitForURL(/claude\.com/, { timeout: 90_000 });
  note(`sign-in link reached the parked tab ${((Date.now() - pressed) / 1000).toFixed(1)}s after the press`);
  await popup.locator('#code').waitFor();
  const code = await popup.locator('#code').innerText();
  await shot(popup, `${tag}-fake-claude-page`);
  await page.bringToFront();
  await page.locator('.rsi-input').waitFor({ timeout: 30_000 });
  await shot(page, `${tag}-paste-code`);
  if (FROM_HOME && !signIn.cancelled) {
    // Changing one's mind halfway: Cancel, and the same button starts a fresh sign-in.
    signIn.cancelled = true;
    await page.locator('[data-step="engine"]').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Sign in to Claude Code' }).waitFor({ timeout: 30_000 });
    check('Cancel ends the sign-in and offers the button again', !(await has(page.locator('.rsi-input'))));
    await popup.close().catch(() => {});
    return signIn(`${tag}2`);
  }
  // A wrong code first: the relay's one failure a person can recover from in place.
  await page.locator('.rsi-input').fill('not-the-code');
  await page.getByRole('button', { name: 'Submit' }).click();
  const rejected = await until('the wrong code to come back refused', async () => /invalid|did not|wrong|again/i.test((await page.locator('[data-step="engine"]').innerText().catch(() => ''))), { timeoutMs: 60_000 }).then(() => true, () => false);
  check('a wrong code is refused on the card, and the sign-in stays open', rejected, (await page.locator('[data-step="engine"]').innerText().catch(() => '')).replace(/\n+/g, ' | '));
  await shot(page, `${tag}-invalid-code`);
  await page.locator('.rsi-input').fill(code);
  const submitted = Date.now();
  await page.getByRole('button', { name: 'Submit' }).click();
  return submitted;
}

const failures = [];
try {
  // ── A. A new account, and one machine ───────────────────────────────────────────────────────────────────────
  note(`=== A. first run (order: ${ORDER}) ===`);
  const mA = marks();
  await page.goto(`${WEB}/`);
  await page.waitForURL('**/setup');
  await page.locator('input[type=email]').waitFor();
  await shot(page, 'a-first-run-setup');
  await page.locator('input').nth(0).fill('Lab Owner');
  await page.locator('input[type=email]').fill('owner@first-ws.test');
  const pw = `pw-${Date.now()}-first-ws`;
  await page.locator('input[type=password]').nth(0).fill(pw);
  await page.locator('input[type=password]').nth(1).fill(pw);
  await page.getByRole('button', { name: /Create account/ }).click();
  await page.waitForURL('**/runners/register', { timeout: 30_000 });
  await page.getByText('Waiting for your first runner').waitFor();
  check('a new account with no machine lands on Add a runner', true, new URL(page.url()).pathname);
  await shot(page, 'a-add-a-runner');

  // The machine: `orbit register` from inside the repository, approved on the enroll page.
  const REGISTER_DIR = FROM_HOME ? MH : GIT_DIR;
  const link = stack('register-begin', REGISTER_DIR).trim();
  note('orbit register printed', link);
  // The install script opens the link in a tab of its own, so Add a runner stays open behind it.
  const addRunnerTab = page;
  page = await context.newPage();
  page.errors = addRunnerTab.errors;
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  await page.goto(link);
  await page.getByRole('button', { name: /Approve/ }).waitFor();
  await shot(page, 'a-enroll-pending');
  await page.getByRole('button', { name: /Approve/ }).click();
  await page.getByText('Next: start your first session').waitFor();
  await shot(page, 'a-enroll-approved');
  await until('orbit register to finish', () => /Setup complete/.test(readFileSync(`${S}/logs/register.log`, 'utf8')), { timeoutMs: 30_000 });
  const receipt = readFileSync(`${S}/logs/register.log`, 'utf8');
  note('what orbit register ended on:\n' + receipt.slice(receipt.indexOf('✓ Setup complete')));
  check('orbit register ends on Start a session and this machine\'s new session page', /Next\s+start it with `orbit run`, then Start a session/.test(receipt) && /\/runners\/[^/\s]+\/new\b/.test(receipt));
  // Approved, and nothing runs on the machine yet: no surface may say it is there.
  const approvedRow = (await apiGet('/runners')).body[0];
  check('approved and not running: the machine is not online', approvedRow.online === false && approvedRow.lastHeartbeatAt === null && approvedRow.engines == null && (approvedRow.capabilities ?? []).length === 0, { online: approvedRow.online, lastHeartbeatAt: approvedRow.lastHeartbeatAt, capabilities: approvedRow.capabilities, engines: approvedRow.engines });
  await sleep(6000);
  check('the Add a runner tab left open still waits for it', (await addRunnerTab.locator('body').innerText()).includes('Waiting for your first runner') && !(await addRunnerTab.locator('body').innerText()).includes('Runner online'), (await addRunnerTab.locator('body').innerText()).replace(/\n+/g, ' | ').slice(-160));
  await shot(addRunnerTab, 'a-add-a-runner-approved-not-running');
  const startBtn = page.getByRole('button', { name: 'Start a session' }).or(page.getByRole('link', { name: 'Start a session' })).first();
  await startBtn.click();
  await page.waitForURL(/\/runners\/[^/]+\/new$/);
  await page.locator('.msc').waitFor();
  const runnerRow = (await apiGet('/runners')).body[0];
  const RUNNER = runnerRow.id;
  note('GET /runners right after approval, before the runner ever ran:', {
    online: runnerRow.online, status: runnerRow.status, capabilities: runnerRow.capabilities, engines: runnerRow.engines,
    registerDir: runnerRow.registerDir, reposRoot: runnerRow.reposRoot,
  });
  check('Start a session on the enroll page opens the machine\'s new session page', /\/runners\/[^/]+\/new$/.test(page.url()), new URL(page.url()).pathname);
  check('register_dir is the directory orbit register ran in', runnerRow.registerDir === REGISTER_DIR, runnerRow.registerDir);
  const early = await cardText();
  check('the card no longer calls a machine that has not started out of date', !/updates itself first/.test(early), early);
  check('it is waited for, in the card\'s own words, not called offline', early.includes(`Waiting for ${M} to connect. It can check folders and sign in as soon as it does.`) && !/is offline/.test(early), early);
  check('its folder step is closed meanwhile', (await page.locator('.msc [role="radio"][aria-disabled="true"]').count()) > 0 && (await useFolder().isDisabled()));
  check('and the composer takes a first message to wait with it, rather than saying Runner offline', await has(composerOf()) && !(await has(page.getByPlaceholder('Runner offline'))));
  await shot(page, 'a-card-before-first-heartbeat');

  // The service starts: the open page has to get there by itself.
  const upAt = Date.now();
  note(stack('start-runner').trim());
  // Watched from now, beside everything else: when the card's folder step opens, with no reload.
  const folderStepOpen = async () => {
    const text = await cardText();
    return /A new folder/.test(text) && !/updates itself first|is offline|to connect/.test(text) &&
      (await page.locator('.msc [role="radio"][aria-disabled="true"]').count()) === 0;
  };
  const cardOpened = until('the card\'s folder step to open with no reload', async () => ((await folderStepOpen()) ? Date.now() : 0), { timeoutMs: 120_000, everyMs: 200 });
  const firstBeat = await until('the first heartbeat', () => logSince('beats.jsonl', 0).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((b) => b.call.includes('heartbeat')), { timeoutMs: 40_000, everyMs: 100 });
  const beatAfter = (Date.parse(firstBeat.at) - upAt) / 1000;
  check('the first heartbeat arrives within 5 s of the runner starting', beatAfter <= 5, `${beatAfter.toFixed(2)} s (${firstBeat.at})`);
  await addRunnerTab.getByRole('button', { name: 'Start a session' }).or(addRunnerTab.getByRole('link', { name: 'Start a session' })).first().waitFor({ timeout: 20_000 });
  check('the Add a runner tab left open says the next step by itself', (await addRunnerTab.locator('body').innerText()).includes('start a session on it'), (await addRunnerTab.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 260));
  await shot(addRunnerTab, 'a-add-a-runner-after-approval');
  await addRunnerTab.close();
  const openedAt = await cardOpened;
  note(`the card offered folders ${((openedAt - upAt) / 1000).toFixed(1)}s after the runner started`);
  const afterBeat = (openedAt - Date.parse(firstBeat.at)) / 1000;
  check('the folder step opens within 5 s of the first heartbeat, with no reload', afterBeat <= 5, `${afterBeat.toFixed(2)} s after the first heartbeat (${firstBeat.at})`);
  keepLogs('a-first-run', mA);

  // ── B. Opening Orbit ────────────────────────────────────────────────────────────────────────────────────────
  note('=== B. the landing ===');
  const mB = marks();
  await page.goto(`${WEB}/`);
  await page.waitForURL(/\/runners\/[^/]+\/new$/, { timeout: 30_000 });
  await page.locator('.msc').waitFor();
  check('a new account opening Orbit lands on the machine\'s new session page', page.url().endsWith(`/new`), new URL(page.url()).pathname);
  check('the sidebar has the machine\'s Set up row', await has(page.locator('.tp-workspace-name', { hasText: `Set up ${M}` })));
  const askedAt = Date.now();
  if (FROM_HOME) {
    await until('the machine to answer about the register directory', () => wireSince(mB['wire.jsonl']).some((e) => e.call === 'POST /api/runner/dir-probe-result'), { timeoutMs: 45_000 });
    await sleep(1800);
    const answered = wireSince(mB['wire.jsonl']).find((e) => e.call === 'POST /api/runner/dir-probe-result');
    note(`the machine answered ${((Date.now() - askedAt) / 1000).toFixed(1)}s after the page opened:`, answered.body);
    check('registered from the home directory: the machine says so, and it is not offered', answered.body.result.isHome === true && !(await has(folderOption('Where you ran orbit register'))));
    check('a new folder leads when nothing is offered', await folderOption('A new folder').locator('input:checked, [aria-checked="true"], [data-checked]').count() > 0 || await folderOption('A new folder').getAttribute('aria-checked') === 'true');
    const landing = await cardText();
    check('step 2 asks to sign in Claude Code', landing.includes(`Sign in Claude Code on ${M}`), landing);
  } else {
    await folderOption('Where you ran orbit register').waitFor({ timeout: 45_000 });
    note(`the register directory appeared as an option ${((Date.now() - askedAt) / 1000).toFixed(1)}s after the page opened`);
    const landing = await cardText();
    check('step 1 offers the register directory, checked on the machine', landing.includes(GIT_DIR) && landing.includes('Found · git repository · main') && landing.includes('Where you ran orbit register'), landing);
    check('step 2 asks to sign in Claude Code', landing.includes(`Sign in Claude Code on ${M}`));
    check('the git register directory is selected by default', await folderOption('Where you ran orbit register').locator('input:checked, [aria-checked="true"], [data-checked]').count() > 0 || await folderOption('Where you ran orbit register').getAttribute('aria-checked') === 'true');
  }
  check('composer speaks to the machine', await has(composerOf()));
  await shot(page, 'b-landing');
  check('no workspace and no session exist yet', psql('select count(*) from workspace').includes(' 0') && psql('select count(*) from session').includes(' 0'));

  // ── C. The first message waits ──────────────────────────────────────────────────────────────────────────────
  note('=== C. a message before anything is set up ===');
  await composerOf().fill(MSG_1);
  if (FROM_HOME) {
    // A first message with a picture in it: staged in the composer before anything exists to attach it to.
    await page.locator('input[type=file]').first().setInputFiles(`${EV}/01-a-first-run-setup.png`);
    await until('the attachment to finish uploading', () => wireSince(mB['wire.jsonl']).length >= 0 && page.locator('[class*="composer"] img, [class*="attachment"] img').count().then((n) => n > 0), { timeoutMs: 20_000 });
    await sleep(800);
  }
  await composerOf().press('Enter');
  await page.locator('.msc-held').waitFor();
  check('the message waits under the card', (await heldState()).includes(`Waiting for ${M} — sends once both steps are done`), await heldState());
  check('the composer is empty again', (await composerOf().inputValue()) === '');
  if (FROM_HOME) {
    // Its picture loads after the message lands: the line under it is measured once it has.
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.msc-held img')];
      return images.length > 0 && images.every((img) => img.complete && img.naturalHeight > 0);
    }, null, { timeout: 20_000 });
    await page.waitForTimeout(300);
  }
  await shot(page, 'c-message-waiting');
  const held = await page.evaluate(() => {
    const line = document.querySelector('.msc-held-state').getBoundingClientRect();
    const pane = document.querySelector('.msc-draft').closest('.workspace-sessions');
    const box = pane.getBoundingClientRect();
    return { lineBottom: Math.round(line.bottom), paneBottom: Math.round(box.bottom), scrollTop: Math.round(pane.scrollTop), maxScroll: pane.scrollHeight - pane.clientHeight, mask: getComputedStyle(pane).maskImage };
  });
  note('the waiting line against the pane:', held);
  check(`the "Waiting for ${M} … Withdraw" line is all in view, clear of the pane's 20px fade${FROM_HOME ? ', with the picture loaded' : ''}`,
    held.paneBottom - held.lineBottom >= 20 && held.lineBottom > 0, held);

  await page.locator('.msc-held-state').getByRole('button', { name: 'Withdraw' }).click();
  await page.waitForTimeout(400);
  check('Withdraw gives the words back to the composer', (await composerOf().inputValue()) === MSG_1 && !(await has(page.locator('.msc-held'))), await composerOf().inputValue());
  await sleep(500);
  await composerOf().press('Enter');
  await page.locator('.msc-held').waitFor();
  await composerOf().fill('And one more thing.');
  await composerOf().press('Enter');
  await page.getByText('One message is already waiting').first().waitFor({ timeout: 5_000 });
  check('a second message is refused while one waits', true);
  await composerOf().fill('');
  await page.reload();
  await page.locator('.msc-held').waitFor({ timeout: 15_000 });
  check('the waiting message survives a reload', (await page.locator('.msc-held').innerText()).includes(MSG_1));
  await sleep(4000);
  check('nothing was sent while it waits: no POST /sessions, no workspace', sessionsPosted(mB['wire.jsonl']).length === 0 && psql('select count(*) from workspace').includes(' 0'));

  // ── D. Sign in, pick the git folder: it goes by itself ──────────────────────────────────────────────────────
  note(`=== D. round 1: ${ORDER}, the register directory (a git repository) ===`);
  const mD = marks();
  /** Round 1's folder: the offered one, or (registered from home) the same repository typed by hand. */
  async function pickRepository() {
    if (!FROM_HOME) {
      await folderOption('Where you ran orbit register').waitFor({ timeout: 45_000 });
      await useFolder().click();
      return;
    }
    await folderOption(`Another folder on ${M}`).click();
    await page.getByRole('textbox', { name: `Another folder on ${M}` }).fill('~/code/payments-api');
    await page.locator('.msc-verdict.ok').waitFor({ timeout: 80_000 });
    check('typed with a ~, the machine answers with the repository and its branch', (await page.locator('.msc-verdict.ok').innerText()) === 'Found · git repository · main');
    await useFolder().click();
  }
  let submitted;
  if (ORDER === 'sign-in-first') {
    submitted = await signIn('d');
    await page.locator('[data-step="engine"] .msc-done-line').waitFor({ timeout: 100_000 });
    note(`step 2 turned done ${((Date.now() - submitted) / 1000).toFixed(1)}s after the code was submitted`);
    check('step 2 reads signed in', (await page.locator('[data-step="engine"]').innerText()).includes(`signed in on ${M}`));
    check('still waiting: only one of the two steps is done', sessionsPosted(mD['wire.jsonl']).length === 0 && (await heldState()).includes('Waiting for'), await heldState());
    await shot(page, 'd-signed-in-still-waiting');
    submitted = Date.now();
    await pickRepository();
  } else {
    await pickRepository();
    await page.locator('[data-step="folder"] .msc-done-line').waitFor();
    await sleep(600);
    check('still waiting: only the folder is done', sessionsPosted(mD['wire.jsonl']).length === 0 && (await heldState()).includes('Waiting for'), await heldState());
    await shot(page, 'd-folder-done-still-waiting');
    submitted = await signIn('d');
  }
  const leftAt = Date.now();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 100_000 });
  note(`the message left by itself: on the session page ${((Date.now() - submitted) / 1000).toFixed(1)}s after the last step was done`);
  await page.locator('.msc-created').waitFor({ timeout: 20_000 });
  const posted1 = sessionsPosted(mD['wire.jsonl']);
  check('exactly one POST /sessions, carrying the folder', posted1.length === 1 && posted1[0].status === 201 && posted1[0].body?.newWorkspace?.workDir === GIT_DIR && !posted1[0].body?.workspaceId, posted1.map((p) => ({ status: p.status, newWorkspace: p.body?.newWorkspace, assignedRunnerId: p.body?.assignedRunnerId, prompt: p.body?.prompt, engine: p.body?.engine, provider: p.body?.provider, createdWorkspace: p.answer?.createdWorkspace })));
  const created1 = await page.locator('.msc-created').innerText();
  check('the conversation opens with Created workspace', /Created workspace\s+payments-api\s+on lab-mac/.test(created1.replace(/\n/g, ' ')) && created1.includes(GIT_DIR), created1.replace(/\n/g, ' '));
  await shot(page, 'd-session-started');
  await page.getByText('fake-claude: no model was called').first().waitFor({ timeout: 60_000 });
  note(`the first reply was on the page ${((Date.now() - leftAt) / 1000).toFixed(1)}s after the page moved to the session`);
  await shot(page, 'd-session-replied');
  const SESSION_1 = new URL(page.url()).pathname.split('/').pop();
  const detail1 = (await apiGet(`/sessions/${SESSION_1}`)).body;
  note('GET /sessions/:id', { createdWorkspace: detail1.createdWorkspace, workspace: { id: detail1.workspace?.id, name: detail1.workspace?.name, workDir: detail1.workspace?.workDir }, status: detail1.status });
  check('GET /sessions/:id says createdWorkspace', detail1.createdWorkspace === true);
  const turns1 = fakeSince(mD['fake-claude.jsonl']).filter((e) => e.kind === 'turn');
  check('the engine ran in the folder, on its branch', turns1.length === 1 && turns1[0].cwd === GIT_DIR && turns1[0].branch === 'main' && turns1[0].isGit === true, turns1.map((t) => ({ cwd: t.cwd, branch: t.branch, isGit: t.isGit, prompt: t.prompt, wrote: t.wrote })));
  check('the file the turn wrote is on the disk there', existsSync(`${GIT_DIR}/${turns1[0].wrote}`), `${GIT_DIR}/${turns1[0].wrote}`);
  note('live engine processes, cwd from /proc:', liveEngines());
  check('the kernel agrees where it runs', runsIn(SESSION_1, GIT_DIR), liveEngines());
  if (FROM_HOME) {
    const att = posted1[0].body?.attachmentIds ?? [];
    check('the picture waited with the message and left with it', att.length === 1 && turns1[0].blocks?.includes('image'), { attachmentIds: att.length, blocks: turns1[0].blocks });
    check('and the conversation shows it', await page.locator('.workspace-sessions img').first().evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false));
  }
  query('round 1: workspace rows', WS_SQL);
  query('round 1: session rows', SESSION_SQL);
  check('workspace row: no auto_create_work_dir, isolation off', /payments-api \| .*payments-api\s+\| f\s+\| f/.test(psql(WS_SQL)), psql(WS_SQL).split('\n')[2]);
  keepLogs('d-round1', mD);

  // What happens to the machine's page and the session from here.
  const mE = marks();
  await composerOf().waitFor({ state: 'detached', timeout: 1 }).catch(() => {});
  const reply = page.getByPlaceholder('Reply…');
  await reply.fill('A second message in the same conversation.');
  await reply.press('Enter');
  await until('the second reply', () => fakeSince(mE['fake-claude.jsonl']).filter((e) => e.kind === 'turn').length === 1, { timeoutMs: 45_000 });
  const turns2 = fakeSince(mE['fake-claude.jsonl']).filter((e) => e.kind === 'turn');
  check('a second turn runs in the same folder', turns2[0]?.cwd === GIT_DIR, turns2[0]?.cwd);
  const FIRST_NAME = FROM_HOME ? 'payments-api' : 'payments';
  if (!FROM_HOME) {
    await page.locator('.msc-created').getByRole('button', { name: 'Rename' }).click();
    const nameField = page.getByRole('textbox', { name: 'Workspace name' });
    await nameField.fill(FIRST_NAME);
    await nameField.press('Enter');
    await page.waitForTimeout(800);
    check('Rename on the line renames the workspace', (await page.locator('.msc-created').innerText()).includes(FIRST_NAME) && psql('select name from workspace order by created_at').includes(FIRST_NAME));
  }
  // The probe fills what the workspace didn't know when it was made (contract §3.2), on a heartbeat.
  const probedOf = (name) => psql(`select work_dir_exists, work_dir_is_git, repo_url from workspace where name = '${name}' and deleted_at is null`).split('\n')[2]?.trim() ?? '';
  const probed1 = await until('the runner to report on the new workspace', () => (/^t/.test(probedOf(FIRST_NAME)) ? probedOf(FIRST_NAME) : null), { timeoutMs: 70_000 }).catch(() => '');
  check('a heartbeat later the workspace row knows its folder and its origin', /^t\s*\|\s*t\s*\|\s*\S*payments-api/.test(probed1), probed1);
  await page.goto(`${WEB}/runners/${RUNNER}/new`);
  await page.waitForURL(/\/workspaces\/[^/]+\/new$/, { timeout: 15_000 });
  check('with a workspace, the machine\'s new session page moves on to that workspace', true, new URL(page.url()).pathname);
  await shot(page, 'e-machine-page-moves-on');
  check('the setup card is gone once the machine has a workspace', !(await has(page.locator('.msc'))));
  finding('F2', 'the setup card exists only at 0 workspaces (board rule 1), so "pick a new folder next" on the same machine needs the first workspace deleted first: there is no web path to a second folder other than the Add workspace form, which has no new-folder option');

  // ── F. Back to an empty machine, the way a person can ───────────────────────────────────────────────────────
  async function deleteWorkspace(name) {
    await page.goto(`${WEB}/sessions/${SESSION_1}`);
    await page.goto(`${WEB}/runners/${RUNNER}`);
    const row = page.locator('.rd-workspace-row', { hasText: name });
    await row.waitFor({ timeout: 20_000 });
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await row.waitFor({ state: 'detached', timeout: 15_000 });
  }
  note('=== F. round 2: a new folder ===');
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.goto(`${WEB}/sessions/${SESSION_1}`);
  await page.locator('.msc-created').getByRole('button', { name: 'Settings' }).click();
  await page.waitForURL(new RegExp(`/runners/${RUNNER}\\?workspace=`), { timeout: 10_000 });
  await shot(page, 'f-settings-from-the-line');
  await deleteWorkspace(FIRST_NAME);
  await page.locator('.tp-workspace-name', { hasText: `Set up ${M}` }).waitFor({ timeout: 15_000 });
  check('with the workspace deleted the machine is empty again: the Set up row is back', true);
  await page.locator('.tp-workspace-name', { hasText: `Set up ${M}` }).click();
  await page.waitForURL(/\/runners\/[^/]+\/new$/);
  await page.locator('.msc').waitFor();
  const mF = marks();
  check('step 2 is already done: the CLI stays signed in', (await page.locator('[data-step="engine"]').innerText()).includes(`signed in on ${M}`));
  check('the repos root does not exist before the first new folder', !existsSync(REPOS_ROOT), REPOS_ROOT);
  await folderOption('A new folder').click();
  const nameBox = page.getByRole('textbox', { name: 'A new folder' });
  await nameBox.fill('not a folder/name');
  await page.locator('.msc-verdict.bad').waitFor();
  check('a name the server would refuse is refused on the card', (await page.locator('.msc-verdict.bad').innerText()).includes('Use letters, digits') && await useFolder().isDisabled());
  await shot(page, 'f-new-folder-bad-name');
  await nameBox.fill(NEW_NAME);
  // The name is asked about where it would go before it can be used (F6): nothing there yet, so it starts empty.
  const freeName = await until('the card to say what is at the new folder\'s name', async () => {
    const text = (await folderOption('A new folder').innerText()).replace(/\n+/g, ' ');
    return !(await useFolder().isDisabled()) && !/Checking/.test(text) ? text : '';
  }, { timeoutMs: 20_000 }).catch(() => '');
  check('a good name, with nothing there yet, enables the button once the machine has looked', freeName.includes('Starts empty. Ask for a clone or a new project in your first message.'), freeName);
  await shot(page, 'f-new-folder-named');
  await useFolder().click();
  await page.locator('.msc-foot.ready').waitFor();
  const ready = (await page.locator('.msc-foot').innerText()).replace(/\s+/g, ' ');
  check('the card says what the next send makes', ready.includes(`“${NEW_NAME}”`) && ready.includes(NEW_PATH), ready);
  await shot(page, 'f-new-folder-ready');
  await page.locator('[data-step="folder"]').getByRole('button', { name: 'Change' }).click();
  await folderOption('A new folder').waitFor();
  check('Change takes the folder back', !(await has(page.locator('.msc-foot.ready'))));
  await folderOption('A new folder').click();
  await page.getByRole('textbox', { name: 'A new folder' }).fill(NEW_NAME);
  await useFolder().click();
  await page.locator('.msc-foot.ready').waitFor();
  check('still nothing on the disk before the send', !existsSync(NEW_PATH));
  await composerOf().fill(MSG_2);
  await composerOf().press('Enter');
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  await page.locator('.msc-created').waitFor({ timeout: 20_000 });
  const posted2 = sessionsPosted(mF['wire.jsonl']);
  check('one POST /sessions naming only the new folder', posted2.length === 1 && posted2[0].status === 201 && posted2[0].body?.newWorkspace?.newFolder === NEW_NAME, posted2.map((p) => ({ status: p.status, newWorkspace: p.body?.newWorkspace })));
  await page.getByText('fake-claude: no model was called').first().waitFor({ timeout: 60_000 });
  await shot(page, 'f-new-folder-session');
  const created2 = (await page.locator('.msc-created').innerText()).replace(/\n/g, ' ');
  check('Created workspace names the new folder', created2.includes(NEW_NAME) && created2.includes(NEW_PATH), created2);
  check('the runner made the folder under the repos root', existsSync(NEW_PATH) && statSync(NEW_PATH).isDirectory(), execSync(`stat -c '%A %U %n' ${REPOS_ROOT} ${NEW_PATH}; ls -la ${NEW_PATH}`, { encoding: 'utf8' }).trim());
  const turns3 = fakeSince(mF['fake-claude.jsonl']).filter((e) => e.kind === 'turn');
  check('the engine ran in the new folder, which started empty and is no repository', turns3.length === 1 && turns3[0].cwd === NEW_PATH && turns3[0].isGit === false && turns3[0].filesBefore.length === 0, turns3.map((t) => ({ cwd: t.cwd, isGit: t.isGit, filesBefore: t.filesBefore, wrote: t.wrote })));
  check('the runner says it made it, for this session', readFileSync(`${S}/logs/runner.log`, 'utf8').includes(`created workDir "${NEW_PATH}" in the repos root (createWorkDir)`));
  const SESSION_2 = new URL(page.url()).pathname.split('/').pop();
  note('live engine processes, cwd from /proc:', liveEngines());
  check('the kernel agrees where it runs', runsIn(SESSION_2, NEW_PATH), liveEngines());
  const probed2 = await until('the runner to report on the new folder', () => (/^t/.test(probedOf(NEW_NAME)) ? probedOf(NEW_NAME) : null), { timeoutMs: 70_000 }).catch(() => '');
  check('a heartbeat later the row says the folder exists and is no repository', /^t\s*\|\s*f/.test(probed2), probed2);
  query('round 2: workspace rows', WS_SQL);
  query('round 2: session rows', SESSION_SQL);
  keepLogs('f-round2', mF);

  // ── G. A path that isn't there, and a folder typed by hand ──────────────────────────────────────────────────
  note('=== G. round 3: another folder, typed ===');
  await deleteWorkspace(NEW_NAME);
  await page.getByText(`No workspaces on ${M} yet.`).first().waitFor({ timeout: 15_000 });
  await page.getByText(`No workspaces on ${M} yet.`).first().scrollIntoViewIfNeeded();
  await shot(page, 'g-machine-page-empty');
  check('the machine page says what to do with no workspace', true, (await page.getByText(`No workspaces on ${M} yet.`).first().innerText()).replace(/\n+/g, ' '));
  await page.getByRole('button', { name: 'Start a session' }).or(page.getByRole('link', { name: 'Start a session' })).first().click();
  await page.waitForURL(/\/runners\/[^/]+\/new$/);
  await page.locator('.msc').waitFor();
  const mG = marks();
  await folderOption(`Another folder on ${M}`).click();
  const pathBox = page.getByRole('textbox', { name: `Another folder on ${M}` });
  async function verdictOf(path) {
    const t0 = Date.now();
    await pathBox.fill(path);
    await page.waitForTimeout(450);
    // This option's own line: the register directory's suggestion, offered again (F4), has a verdict of its own.
    const other = folderOption(`Another folder on ${M}`);
    const wasChecking = (await other.locator('.msc-verdict').first().innerText().catch(() => '')).includes('Checking');
    await other.locator('.msc-verdict:not(.wait)').first().waitFor({ timeout: 80_000 });
    const el = other.locator('.msc-verdict:not(.wait)').first();
    const text = await el.innerText();
    const secs = (Date.now() - t0) / 1000;
    note(`typed ${path} → "${text}" after ${secs.toFixed(1)}s (a check was shown: ${wasChecking})`);
    return { text, tone: (await el.getAttribute('class')).split(' ').pop(), secs, wasChecking };
  }
  await pathBox.fill(MISSING);
  await page.waitForTimeout(600);
  await shot(page, 'g-checking', { settle: 0 });
  await pathBox.fill('');
  const times = [];
  const missing = await verdictOf(MISSING);
  times.push(missing.secs);
  check('a path that does not exist is refused where it was typed', missing.text === `No such directory on ${M}.` && missing.tone === 'bad', missing);
  check('it cannot be used: the button stays off', await useFolder().isDisabled());
  await pathBox.press('Enter');
  await page.waitForTimeout(500);
  check('Enter does not pick it either', !(await has(page.locator('[data-step="folder"] .msc-done-line'))));
  await shot(page, 'g-path-does-not-exist');
  const before3 = marks();
  await composerOf().fill(MSG_3);
  await composerOf().press('Enter');
  await page.locator('.msc-held').waitFor();
  await sleep(3000);
  check('a message sent now waits: no POST /sessions, no workspace row made for the bad path', sessionsPosted(before3['wire.jsonl']).length === 0 && !psql('select work_dir from workspace').includes('does-not-exist'));
  await shot(page, 'g-message-waits-on-bad-path');

  const file = await verdictOf(`${MH}/code/README.txt`);
  times.push(file.secs);
  check('a file is not a folder', file.text === `That isn’t a directory on ${M}.` && file.tone === 'bad', file);
  const notGit = await verdictOf('~/code/notes');
  times.push(notGit.secs);
  check('a plain folder can be used, and says what that costs', notGit.tone === 'warn' && notGit.text.includes('not a git repository') && !(await useFolder().isDisabled()), notGit);
  await shot(page, 'g-not-a-repository');
  const typed = await verdictOf('~/code/billing-api');
  times.push(typed.secs);
  check('a typed git folder says its branch, and ~ is the machine\'s to expand', typed.text === 'Found · git repository · develop' && typed.tone === 'ok', typed);
  await shot(page, 'g-typed-git-folder');
  note('seconds per check:', times.map((t) => +t.toFixed(1)));
  if (!FROM_HOME) {
    const offered = await until('the register directory to be offered', () => has(folderOption('Where you ran orbit register')), { timeoutMs: 15_000 }).then(() => true, () => false);
    const askedAgain = wireSince(mG['wire.jsonl']).filter((e) => e.call?.startsWith('POST /api/runners/') && e.call.endsWith('/dir-probe') && e.body?.path === REGISTER_DIR).length;
    note(`the register directory was asked about ${askedAgain} time(s) on this card, and is ${offered ? 'offered' : 'not offered'}`);
    check('the register directory is still offered after other paths took the machine\'s one question', offered, { askedOnThisCard: askedAgain });
  }
  check('each folder check is answered within 3 s of being asked, typing settled', times.every((t) => t <= 3.4), times.map((t) => +t.toFixed(2)));
  const mG2 = marks();
  await useFolder().click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  await page.locator('.msc-created').waitFor({ timeout: 20_000 });
  const posted3 = sessionsPosted(mG2['wire.jsonl']);
  check('the waiting message left by itself once a good folder was picked, with the runner\'s resolved path', posted3.length === 1 && posted3[0].body?.newWorkspace?.workDir === GIT_DIR_2 && posted3[0].body?.prompt === MSG_3, posted3.map((p) => ({ status: p.status, newWorkspace: p.body?.newWorkspace, prompt: p.body?.prompt })));
  await page.getByText('fake-claude: no model was called').first().waitFor({ timeout: 60_000 });
  await shot(page, 'g-typed-folder-session');
  const turns4 = fakeSince(mG2['fake-claude.jsonl']).filter((e) => e.kind === 'turn');
  check('the engine ran there, on develop', turns4[0]?.cwd === GIT_DIR_2 && turns4[0]?.branch === 'develop', turns4.map((t) => ({ cwd: t.cwd, branch: t.branch })));
  const SESSION_3 = new URL(page.url()).pathname.split('/').pop();
  note('live engine processes, cwd from /proc:', liveEngines());
  check('the kernel agrees where it runs', runsIn(SESSION_3, GIT_DIR_2), liveEngines());
  query('round 3: workspace rows', WS_SQL);
  query('round 3: session rows', SESSION_SQL);
  keepLogs('g-round3', mG);

  // ── H. The folder of a deleted workspace, chosen again ──────────────────────────────────────────────────────
  note('=== H. round 4: the first folder again, after its workspace was deleted ===');
  await deleteWorkspace('billing-api');
  await page.locator('.tp-workspace-name', { hasText: `Set up ${M}` }).click();
  await page.waitForURL(/\/runners\/[^/]+\/new$/);
  await page.locator('.msc').waitFor();
  const mH = marks();
  await pickRepository();
  await page.locator('.msc-foot.ready').waitFor({ timeout: 10_000 });
  await shot(page, 'h-same-folder-ready');
  if (FROM_HOME) {
    await composerOf().fill('!pwd');
    await composerOf().press('Enter');
  } else {
    await composerOf().fill('Back in the first folder.');
    await composerOf().press('Enter');
  }
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  await page.locator('.msc-created').waitFor({ timeout: 20_000 });
  const posted4 = sessionsPosted(mH['wire.jsonl']);
  check('the folder of a deleted workspace can be chosen again', posted4.length === 1 && posted4[0].status === 201 && posted4[0].body?.newWorkspace?.workDir === GIT_DIR, posted4.map((p) => ({ status: p.status, newWorkspace: p.body?.newWorkspace, shell: p.body?.shell, prompt: p.body?.prompt })));
  const created4 = (await page.locator('.msc-created').innerText()).replace(/\n/g, ' ');
  check('a deleted workspace does not hold its name', created4.includes('Created workspace payments-api on'), created4);
  if (FROM_HOME) {
    const shellSeen = await until('the shell turn\'s output', async () => (await page.locator('body').innerText()).includes(GIT_DIR) && (await page.locator('[class*="shell"], pre, code').filter({ hasText: GIT_DIR }).count()) > 1, { timeoutMs: 45_000 }).then(() => true, () => false);
    check('a first message that is a shell command runs in the folder', shellSeen);
    await page.getByText('Waiting for your reply').first().waitFor({ timeout: 20_000 }).catch(() => {});
    const header = (await page.locator('.workspace-sessions').first().evaluate(() => document.body.innerText)).split('\n').slice(0, 40).join(' | ');
    check('and the session settles: no longer Starting, waiting for a reply', /Waiting for your reply/.test(header) && !/Starting/.test(header), header.slice(0, 200));
  } else {
    await page.getByText('fake-claude: no model was called').first().waitFor({ timeout: 60_000 });
  }
  await shot(page, 'h-same-folder-session');
  query('round 4: workspace rows', WS_SQL);
  query('round 4: session rows', SESSION_SQL);
  keepLogs('h-round4', mH);

  if (FROM_HOME) {
    // ── J. A new folder's name is never checked: what the card can't know ─────────────────────────────────────
    note('=== J. round 5: new folder names that are already taken on the machine ===');
    await deleteWorkspace('payments-api');
    await page.getByRole('button', { name: 'Start a session' }).or(page.getByRole('link', { name: 'Start a session' })).first().click();
    await page.waitForURL(/\/runners\/[^/]+\/new$/);
    await page.locator('.msc').waitFor();
    const mJ = marks();
    const newFolderSays = async () => {
      const text = (await folderOption('A new folder').innerText()).replace(/\n+/g, ' ');
      return /already exists|already a file|Starts empty/.test(text) && !/Checking/.test(text) ? text : '';
    };
    await folderOption('A new folder').click();
    await page.getByRole('textbox', { name: 'A new folder' }).fill(NEW_NAME);
    const saidThere = await until('the card to say what is at the new folder\'s name', newFolderSays, { timeoutMs: 20_000 });
    check('a new folder named after one still on the disk is said to be used with what is in it, before anything is sent',
      saidThere.includes(`This folder already exists on ${M}. Sessions will use what’s in it.`) && !saidThere.includes('Starts empty'), saidThere);
    check('it was asked about where it would go, and nothing was sent to find out',
      wireSince(mJ['wire.jsonl']).some((e) => e.call?.endsWith('/dir-probe') && e.body?.path === `${REPOS_ROOT}/${NEW_NAME}`) && sessionsPosted(mJ['wire.jsonl']).length === 0);
    await shot(page, 'j-new-folder-name-already-a-folder');
    await useFolder().click();
    await page.locator('.msc-foot.ready').waitFor();
    const doneLine = (await page.locator('[data-step="folder"] .msc-done-line').innerText()).replace(/\n+/g, ' ');
    check('picked, it is that folder: not one made as the session starts', doneLine.includes(`${REPOS_ROOT}/${NEW_NAME}`) && !doneLine.includes('created as the session starts'), doneLine);
    await composerOf().fill('Is this folder empty?');
    await composerOf().press('Enter');
    await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
    await page.getByText('fake-claude: no model was called').first().waitFor({ timeout: 60_000 });
    await shot(page, 'j-new-folder-name-already-a-folder-session');
    const posted5 = sessionsPosted(mJ['wire.jsonl']);
    check('it goes by its path, as any folder that is there does', posted5.length === 1 && posted5[0].body?.newWorkspace?.workDir === `${REPOS_ROOT}/${NEW_NAME}`, posted5.map((p) => ({ status: p.status, newWorkspace: p.body?.newWorkspace })));
    const again = fakeSince(mJ['fake-claude.jsonl']).filter((e) => e.kind === 'turn');
    note('a new folder named after one that exists: the session saw', again.map((t) => ({ cwd: t.cwd, filesBefore: t.filesBefore })));
    check('and the session opened on the files the card said were there', again[0]?.cwd === `${REPOS_ROOT}/${NEW_NAME}` && again[0]?.filesBefore?.length > 0, again.map((t) => ({ cwd: t.cwd, filesBefore: t.filesBefore })));

    await deleteWorkspace(NEW_NAME);
    await page.getByRole('button', { name: 'Start a session' }).or(page.getByRole('link', { name: 'Start a session' })).first().click();
    await page.waitForURL(/\/runners\/[^/]+\/new$/);
    await page.locator('.msc').waitFor();
    writeFileSync(`${REPOS_ROOT}/taken`, 'a file a person left here\n');
    const mJ2 = marks();
    await folderOption('A new folder').click();
    await page.getByRole('textbox', { name: 'A new folder' }).fill('taken');
    const saidFile = await until('the card to say what is at the new folder\'s name', newFolderSays, { timeoutMs: 20_000 });
    check('a new folder named after a file is refused before anything is sent, and says why',
      saidFile.includes(`There’s already a file with this name on ${M}. Pick another name.`), saidFile);
    check('Use this folder stays off', await useFolder().isDisabled());
    await composerOf().fill('Start here.');
    await composerOf().press('Enter');
    await page.locator('.msc-held').waitFor();
    await sleep(4000);
    await shot(page, 'j-new-folder-name-is-a-file');
    check('a message sent now waits: no POST /sessions, and no workspace for the file', sessionsPosted(mJ2['wire.jsonl']).length === 0 && !psql('select work_dir from workspace where deleted_at is null').includes(`${REPOS_ROOT}/taken`));
    await page.locator('.msc-held-state').getByRole('button', { name: 'Withdraw' }).click();
    query('round 5: workspace rows', WS_SQL);
    query('round 5: session rows', `select w.name as workspace, s.created_workspace, w.auto_create_work_dir, w.work_dir, s.status, left(s.error, 120) as error from session s left join workspace w on w.id = s.workspace_id order by s.created_at`);
    keepLogs('j-round5', mJ);
  }

  await page.goto(`${WEB}/`);
  await page.waitForTimeout(1500);
  note('with a workspace, Orbit opens on', new URL(page.url()).pathname);
  await shot(page, 'i-landing-with-a-workspace');
  query('the runner: register_dir, repos_root, when it first spoke', `select name, status, register_dir, repos_root, capabilities_reported_at, last_heartbeat_at, dir_probe_status, dir_probe_path,
    ('create-workdir/v1' = any(capabilities)) as create_workdir, ('dir-probe/v1' = any(capabilities)) as dir_probe from runner`, true);
  check('no page error or console error in the whole walk', page.errors.length === 0, page.errors.slice(0, 8));
  const repoFiles = execSync(`cd ${MH} && find . -path ./.claude -prune -o -type f -not -path '*/.git/*' -print | sort; echo; ls -la orbit-repos`, { encoding: 'utf8' });
  writeFileSync(`${EV}/machine-files.txt`, repoFiles);
  note('files on the machine:\n' + repoFiles);
} catch (e) {
  failures.push(e);
  note(`ABORTED: ${e.stack ?? e}`);
  await page.screenshot({ path: `${EV}/ABORT.png` }).catch(() => {});
  note('page at abort:', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(0, 1500));
  note('page errors:', page.errors.slice(0, 8));
} finally {
  await browser.close().catch(() => {});
}
const failed = summary_();
function summary_() {
  return import('./lib.mjs').then(({ summary }) => summary());
}
process.exit((await failed) || failures.length ? 1 : 0);
