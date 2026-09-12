// Codex rate-limit reset across every layer, from a confirmation pressed in the production web bundle to the
// authoritative Plan usage refresh it ends in. Started by scripts/test-codex-reset-e2e.sh, whose header says what runs
// and what counts as green; the stack is harness.mjs, the browser browser.mjs.
//
// The scenarios run in order on ONE stack and each leaves the fake provider, the runner and the stored snapshot in the
// state the next one starts from, so a scenario that fails still runs its remaining steps where it can (`expect`
// collects instead of throwing) and the rest are attempted; the run is green only when every declared scenario PASSed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { launchChromium } from './browser.mjs';
import {
  CONSUME_METHOD,
  DbWatch,
  FakeCodex,
  OPERATION_COLUMNS,
  RATE_LIMITS_READ_METHOD,
  RunnerLink,
  RunnerMachine,
  WebFront,
  callApi,
  eventually,
  fileLog,
  freePort,
  lookPath,
  migrate,
  startApiserver,
  startPostgres,
} from './harness.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required: scripts/test-codex-reset-e2e.sh sets it`);
  return value;
};
const REPO = required('CODEX_RESET_E2E_REPO');
const SCRATCH = required('CODEX_RESET_E2E_SCRATCH');
const RUNNER_BINARY = required('CODEX_RESET_E2E_RUNNER_BINARY');
const FAULT_BINARY = required('CODEX_RESET_E2E_FAULT_BINARY');
const PRISMA = required('CODEX_RESET_E2E_PRISMA');
const GUARD_BIN = required('CODEX_RESET_E2E_GUARD_BIN');
const REPORT = required('CODEX_RESET_E2E_REPORT');
const CHROMIUM = process.env.CODEX_RESET_E2E_CHROMIUM || 'chromium';
const DEBUG_DIR = process.env.CODEX_RESET_E2E_DEBUG_DIR || '';
const STOP_AFTER = process.env.CODEX_RESET_E2E_STOP_AFTER || '';
const HOLD = process.env.CODEX_RESET_E2E_HOLD === '1';
const GUARD_HITS = process.env.CODEX_RESET_E2E_GUARD_HITS || path.join(SCRATCH, 'guard-hits');
const PG_PREFIX = process.env.CODEX_RESET_E2E_PG_PREFIX || `codex-reset-e2e-pg-${process.pid}-`;

const API = path.join(REPO, 'src/apiserver');
const WEB_DIST = path.join(REPO, 'src/web/dist');
const RUNNER_GO = path.join(REPO, 'src/runner-go');
const LOGS = path.join(SCRATCH, 'logs');
const requireFromApi = createRequire(path.join(API, 'package.json'));
const pg = requireFromApi('pg');
const shared = requireFromApi(path.join(REPO, 'src/shared/dist/index.js'));

const RUNNER_NAME = 'codex-reset-e2e';
const PRIMARY = { account: { type: 'chatgpt', email: 'e2e-primary@example.invalid', planType: 'pro' }, accountId: 'acct_e2e_primary' };
const OTHER = { account: { type: 'chatgpt', email: 'e2e-other@example.invalid', planType: 'plus' }, accountId: 'acct_e2e_other' };
const READ_ERROR = { method: RATE_LIMITS_READ_METHOD, do: 'error' };

const log = {
  harness: fileLog(path.join(LOGS, 'harness.log')),
  api: fileLog(path.join(LOGS, 'apiserver.log')),
  runner: fileLog(path.join(LOGS, 'runner.log')),
  chromium: fileLog(path.join(LOGS, 'chromium.log')),
};
const say = (line) => {
  process.stdout.write(`${line}\n`);
  log.harness(`${new Date().toISOString()} ${line}\n`);
};

// Copy as the web writes it, compared after folding typographic quotes, dashes and ellipses to ASCII.
const fold = (text) =>
  String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/—/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
const TITLE_RANK = new Map([
  ['Starting reset...', 0],
  ['Using reset credit...', 1],
  ['Limits reset - refreshing usage...', 2],
  ['Reset already applied - refreshing usage...', 2],
  ['Usage limits reset', 3],
  ['Limits reset - usage not refreshed', 3],
  ['Nothing to reset', 3],
  ['No reset credit available', 3],
  ['Codex account changed', 3],
  ["Reset didn't start", 3],
  ['Reset not available', 3],
  ['Result unknown', 3],
]);

// ── the page ───────────────────────────────────────────────────────────────────────────────────

/**
 * Runs in every new document before the app does: records each status title the Reset credit card renders, in
 * order. A poll from outside can miss a state the card shows for two seconds; the page itself cannot.
 */
function recordTitles() {
  const titles = (window.__codexResetTitles = window.__codexResetTitles || []);
  const record = () => {
    for (const element of document.querySelectorAll('.cu-rc-status-title')) {
      const title = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (title && titles[titles.length - 1] !== title) titles.push(title);
    }
  };
  new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true });
}

/** Runs in the page: the composer's Plan usage pill, its popover's Reset credit card and the confirmation. */
function readCard() {
  const text = (element) => (element ? element.textContent.replace(/\s+/g, ' ').trim() : null);
  const shown = (element) => {
    const popover = element.closest('.ant-popover');
    return !!popover && !popover.classList.contains('ant-popover-hidden') && element.getBoundingClientRect().width > 0;
  };
  const pills = [...document.querySelectorAll('button.composer-usage')];
  const pill = pills.find((candidate) => candidate.getBoundingClientRect().width > 0) ?? pills[0] ?? null;
  const pops = [...document.querySelectorAll('.cu-pop')];
  const pop = pops.find(shown) ?? pops.at(-1) ?? null;
  const popoverVisible = !!pop && shown(pop);
  const rc = pop ? pop.querySelector('.cu-rc') : null;
  const status = rc ? rc.querySelector('.cu-rc-status') : null;
  const modal = [...document.querySelectorAll('.ant-modal')].find(
    (candidate) => (candidate.textContent || '').includes('Use reset credit?') && candidate.getBoundingClientRect().width > 0,
  );
  const stored = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    stored[key] = localStorage.getItem(key);
  }
  return {
    pill: pill ? pill.getAttribute('aria-label') : null,
    popoverVisible,
    card: rc
      ? {
          count: text(rc.querySelector('.cu-rc-count')),
          meta: [...rc.querySelectorAll('.cu-rc-meta')].map(text),
          stale: !!rc.querySelector('.cu-rc-stale'),
          statusTitle: text(rc.querySelector('.cu-rc-status-title')),
          statusDetail: status ? text(status.querySelector('.cu-rc-status-title + div')) : null,
          tone: status ? ([...status.classList].find((name) => name.startsWith('cu-rc-status--')) || '').slice('cu-rc-status--'.length) : null,
          reasons: [...rc.querySelectorAll('.cu-rc-reason')].map(text),
          buttons: [...rc.querySelectorAll('button')].map((button) => ({ text: text(button), disabled: button.disabled })),
        }
      : null,
    modalOpen: !!modal,
    localStorage: stored,
    titles: [...(window.__codexResetTitles || [])],
    doc: performance.timeOrigin,
    counts: { pills: pills.length, pops: pops.length, cards: document.querySelectorAll('.cu-rc').length },
  };
}

const PILL = () => [...document.querySelectorAll('button.composer-usage')].find((pill) => pill.getBoundingClientRect().width > 0);
const CARD_BUTTON = (label) =>
  [...document.querySelectorAll('.cu-pop .cu-rc button')].find((button) => button.textContent.trim() === label && button.getBoundingClientRect().width > 0);
const CONFIRM_BUTTON = () =>
  [...document.querySelectorAll('.ant-modal')]
    .filter((modal) => (modal.textContent || '').includes('Use reset credit?'))
    .flatMap((modal) => [...modal.querySelectorAll('button')])
    .find((button) => button.textContent.trim() === 'Use reset');

const card = async (page) => page.call(readCard);
const button = (state, label) => state.card?.buttons.find((candidate) => candidate.text === label) ?? null;

async function openPlanUsage(page) {
  await eventually('the Plan usage pill in the Codex composer', async () => (await card(page)).pill !== null, 120_000, 300);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await card(page)).popoverVisible) return;
    if (attempt % 2 === 0) await page.click(PILL);
    else {
      const at = await page.point(PILL);
      await page.mouse('mouseMoved', at.x, at.y);
    }
    await sleep(500);
  }
  await eventually('the Plan usage popover to open', async () => (await card(page)).popoverVisible, 5_000, 200);
}

/**
 * The card as someone watching it sees it: read with its popover open. When the popover is closed (a press or the
 * pointer left it), it is opened again first, unless a confirmation is up.
 */
async function readOpen(page) {
  const state = await card(page);
  if (state.pill === null || state.popoverVisible || state.modalOpen) return state;
  await openPlanUsage(page).catch(() => undefined);
  return card(page);
}

const titleCursors = new WeakMap();

/** Moves the titles the page recorded since the last call into `seen`, folded; a reload starts a new document. */
function absorbTitles(seen, state) {
  const cursor = titleCursors.get(seen) ?? { doc: state.doc, count: state.titles.length };
  if (cursor.doc !== state.doc) {
    cursor.doc = state.doc;
    cursor.count = 0;
  }
  for (const title of state.titles.slice(cursor.count)) {
    const folded = fold(title);
    if (seen.at(-1) !== folded) seen.push(folded);
  }
  cursor.count = state.titles.length;
  titleCursors.set(seen, cursor);
}

/** A list of the status titles the card shows from now on. */
async function beginTitles(page) {
  const seen = [];
  absorbTitles(seen, await card(page));
  return seen;
}

/** Polls the card until `done(state)`, recording every status title shown on the way. */
async function watchCard(page, what, done, timeoutMs, seen = []) {
  let last = null;
  try {
    return await eventually(
      what,
      async () => {
        const state = await readOpen(page);
        last = state;
        absorbTitles(seen, state);
        return done(state) ? state : null;
      },
      timeoutMs,
      250,
    );
  } catch (error) {
    const shown = last && { pill: last.pill, popoverVisible: last.popoverVisible, modalOpen: last.modalOpen, counts: last.counts, card: last.card, pageTitles: last.titles.slice(-8) };
    error.message += `\n    card titles seen: ${seen.join(' > ') || '(none)'}\n    last card: ${JSON.stringify(shown)}\n    page exceptions: ${JSON.stringify(page.exceptions.slice(-5))}`;
    throw error;
  }
}

/**
 * Clears what the card still shows about an earlier operation. The page polls on its own clock, so a result can
 * appear after this is called: it keeps dismissing until the card shows no status at all.
 */
async function clearCard(page, timeoutMs = 90_000) {
  let clearReads = 0;
  await eventually('the card to show no earlier result', async () => {
    const state = await readOpen(page);
    if (button(state, 'Dismiss')) {
      clearReads = 0;
      await openPlanUsage(page).catch(() => undefined);
      await page.click(CARD_BUTTON, 'Dismiss').catch(() => undefined);
      return false;
    }
    // A missing card counts only with the popover open: a closed one may simply not have drawn it yet.
    const nothingShown = state.popoverVisible && (state.card === null || state.card.statusTitle === null);
    const nothingRemembered = !Object.keys(state.localStorage).some((key) => key.startsWith('orbit.codexReset:'));
    clearReads = nothingShown && nothingRemembered ? clearReads + 1 : 0;
    return clearReads >= 2;
  }, timeoutMs, 500);
}

/** Use reset credit, then Use reset in the confirmation — pressed twice in a row when `twice`. */
async function confirmFromWeb(ctx, { twice = false, seen = null } = {}) {
  const { page } = ctx;
  await openPlanUsage(page);
  await clearCard(page);
  await watchCard(page, 'Use reset credit to be offered and enabled', (state) => {
    const use = button(state, 'Use reset credit');
    return use && !use.disabled;
  }, 120_000);
  await openPlanUsage(page);
  await page.click(CARD_BUTTON, 'Use reset credit');
  await eventually('the "Use reset credit?" confirmation', async () => (await card(page)).modalOpen, 10_000, 100);
  const at = await page.point(CONFIRM_BUTTON);
  const sentBefore = ctx.front.createsSeen ?? 0;
  await page.mouse('mouseMoved', at.x, at.y);
  // The pointer rests on the button before the press, as a person's does: the popover's hover-leave timer runs out
  // while the confirmation is still up, so the popover stays open to show what the press became.
  await sleep(400);
  if (seen) {
    // What this confirmation shows starts here; an earlier operation's last words are not part of it.
    seen.length = 0;
    titleCursors.delete(seen);
    absorbTitles(seen, await card(page));
  }
  for (let press = 0; press < (twice ? 2 : 1); press += 1) {
    await page.mouse('mousePressed', at.x, at.y, { button: 'left', clickCount: 1 });
    await page.mouse('mouseReleased', at.x, at.y, { button: 'left', clickCount: 1 });
  }
  // A press that sends nothing must say so here, with what the page showed, not as a missing operation later.
  try {
    await eventually('the confirmation to send its create request', async () => (ctx.front.createsSeen ?? 0) > sentBefore, 15_000, 100);
  } catch (error) {
    const state = await card(page);
    const focus = await page.call(() => {
      const active = document.activeElement;
      return active ? `${active.tagName.toLowerCase()}.${String(active.className)} "${(active.textContent || '').trim().slice(0, 40)}"` : null;
    });
    error.message += `\n    after the press: ${JSON.stringify({ pressedAt: at, modalOpen: state.modalOpen, popoverVisible: state.popoverVisible, counts: state.counts, card: state.card, pageTitles: state.titles.slice(-6), focus, pageExceptions: page.exceptions.slice(-5) })}`;
    throw error;
  }
}

/** A request from the page itself, with the token the web keeps: the same door the card uses. */
function pageFetch(page, method, url, body) {
  return page.call(
    async (m, u, b) => {
      const res = await fetch(u, {
        method: m,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('orbit_token')}` },
        body: b === null ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    },
    method,
    url,
    body ?? null,
  );
}

function assertTitlesForwards(seen, where) {
  const ranks = seen.filter((title) => TITLE_RANK.has(title)).map((title) => TITLE_RANK.get(title));
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok(ranks[i] >= ranks[i - 1], `${where}: the card went back from "${seen.filter((t) => TITLE_RANK.has(t))[i - 1]}" to "${seen.filter((t) => TITLE_RANK.has(t))[i]}" (${seen.join(' > ')})`);
  }
}

// ── the database ───────────────────────────────────────────────────────────────────────────────

async function operations(ctx) {
  const { rows } = await ctx.sql.query(`SELECT ${OPERATION_COLUMNS} FROM codex_rate_limit_reset_operation ORDER BY created_at, id`);
  return rows;
}

async function operation(ctx, id) {
  const { rows } = await ctx.sql.query(`SELECT ${OPERATION_COLUMNS} FROM codex_rate_limit_reset_operation WHERE id = $1`, [id]);
  assert.equal(rows.length, 1, `operation ${id} is not stored`);
  return rows[0];
}

const statusOf = (row) => shared.codexResetOperationStatus(row);

async function storedBlock(ctx) {
  const { rows } = await ctx.sql.query('SELECT plan_usage AS "planUsage" FROM runner WHERE id = $1', [ctx.runnerUuid]);
  return shared.codexRateLimitResetOf(rows[0]?.planUsage ?? null) ?? null;
}

async function runnerRow(ctx) {
  const { rows } = await ctx.sql.query(
    `SELECT capabilities, heartbeat_lease_owner::text AS "leaseOwner", heartbeat_draining AS "draining",
            EXTRACT(EPOCH FROM (now() - last_heartbeat_at)) AS "age"
       FROM runner WHERE id = $1`,
    [ctx.runnerUuid],
  );
  return { ...rows[0], age: rows[0]?.age === null ? Infinity : Number(rows[0]?.age) };
}

async function newOperation(ctx, before) {
  const known = new Set(before.map((row) => row.id));
  const created = await eventually('the confirmation to become an operation', async () => {
    const fresh = (await operations(ctx)).filter((row) => !known.has(row.id));
    return fresh.length > 0 ? fresh : null;
  }, 60_000, 200);
  assert.equal(created.length, 1, `one confirmation made ${created.length} operations`);
  return created[0];
}

async function settled(ctx, id, timeoutMs = 180_000) {
  return eventually(`operation ${id} to settle`, async () => {
    const row = await operation(ctx, id);
    return row.completedAt !== null ? row : null;
  }, timeoutMs, 250);
}

async function noOperationInFlight(ctx) {
  await eventually('no reset operation in flight (a previous scenario left one)', async () =>
    (await operations(ctx)).every((row) => row.completedAt !== null), 60_000, 500);
}

/** Resolves once a heartbeat sent after this call has been answered 200 — the start of a 90-second online window. */
async function freshHeartbeat(ctx, timeoutMs = 75_000) {
  const since = Date.now();
  await eventually('a fresh runner heartbeat', async () =>
    ctx.link.exchanges.some((exchange) => exchange.route === 'heartbeat' && exchange.at > since && exchange.status >= 200 && exchange.status < 300 && !exchange.fault), timeoutMs, 200);
}

async function restartRunner(ctx) {
  const before = (await runnerRow(ctx)).leaseOwner;
  await ctx.runner.stop();
  ctx.runner.start();
  return eventually('the restarted runner to heartbeat under a new lease', async () => {
    const row = await runnerRow(ctx);
    // A heartbeat that is not draining may omit the flag, which stores NULL.
    return row.leaseOwner && row.leaseOwner !== before && row.age < 45 && row.draining !== true ? row.leaseOwner : null;
  }, 150_000, 1000);
}

async function blockFrom(ctx, leaseOwner, what, check = () => true) {
  return eventually(`a stored reset block read by ${leaseOwner} (${what})`, async () => {
    const block = await storedBlock(ctx);
    return block && block.generation === leaseOwner && check(block) ? block : null;
  }, 150_000, 1000);
}

function expectOperation(ctx, row, scenario, consumeCalls, spent) {
  ctx.expected.set(row.id, { scenario, consumeCalls, spent });
}

/**
 * The provider back on the runner's default account with `fields` and no faults, no wire fault left armed, the runner
 * running, and a stored block that names the default account — so a scenario that failed half-way does not hand the
 * next one another account, a fault meant for itself or a paused runner.
 */
async function ensurePrimary(ctx, fields = {}) {
  ctx.link.clearRules();
  ctx.runner.resume();
  await ctx.fake.patch({ ...PRIMARY, faults: [], ...fields });
  const block = await storedBlock(ctx);
  if (block?.support === 'SUPPORTED' && block.accountFingerprint === ctx.primaryFingerprint) return;
  say("    the stored block is not the default account's: restarting the runner so it reads the account again");
  const leaseOwner = await restartRunner(ctx);
  await blockFrom(ctx, leaseOwner, "the default account's block", (candidate) => candidate.support === 'SUPPORTED' && candidate.accountFingerprint === ctx.primaryFingerprint);
}

async function onWorkspace(ctx, workspaceId) {
  const here = await ctx.page.call(() => location.pathname);
  if (!here.startsWith(`/workspaces/${workspaceId}`)) await ctx.page.goto(`${ctx.front.origin}/workspaces/${workspaceId}`);
}

const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && shared.toUuid(a) === shared.toUuid(b);

/** Collects expectations that must not stop a scenario's remaining steps; `throwIfAny` fails it at the end. */
function expectations() {
  const failed = [];
  return {
    that(condition, message) {
      if (!condition) failed.push(message);
    },
    throwIfAny() {
      if (failed.length > 0) throw new Error(failed.join('\n'));
    },
  };
}

// ── the scenarios ──────────────────────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    id: 'S01',
    title: "The runner's authoritative read reaches Plan usage: count, expiry, freshness, capability and lease; only the fake answers as Codex",
    async run(ctx, facts) {
      const block = await eventually("the runner's first Codex reset block in Runner.planUsage", async () => {
        const candidate = await storedBlock(ctx);
        return candidate?.support === 'SUPPORTED' && candidate.rateLimitResetCredits?.availableCount === 3 ? candidate : null;
      }, 180_000, 1000);
      const runner = await runnerRow(ctx);
      assert.ok(runner.capabilities.includes('codex-rate-limit-reset-v1'), `the runner declared ${runner.capabilities}`);
      assert.equal(block.generation, runner.leaseOwner, 'the block was read by the process holding the heartbeat lease');
      assert.equal(block.rateLimitResetCredits.credits, null, 'a count without credit details stays without details');
      assert.match(block.accountFingerprint, /^cxa1_[0-9a-f]{32}$/);
      ctx.primaryFingerprint = block.accountFingerprint;

      const effective = ctx.runner.effectivePath();
      assert.equal(lookPath(effective, 'codex'), ctx.fake.shim, "the runner's `codex` is the fake app-server");
      for (const engine of ['claude', 'kimi', 'opencode']) {
        assert.equal(lookPath(effective, engine), path.join(GUARD_BIN, engine), `the runner's ${engine} is the guard`);
      }
      assert.ok(ctx.fake.ledger().some((event) => event.method === RATE_LIMITS_READ_METHOD), 'the block came from a read the fake answered');
      assert.equal(ctx.fake.consumeCalls().length, 0, 'nothing consumed before any confirmation');

      await ctx.page.goto(`${ctx.front.origin}/workspaces/${ctx.w1}`);
      await openPlanUsage(ctx.page);
      const state = await watchCard(ctx.page, 'the Reset credit card showing 3 credits', (s) => s.card?.count === '3 available', 120_000);
      assert.ok(state.card.meta.includes('Expiry not reported'), `expiry line: ${state.card.meta}`);
      assert.ok(state.card.meta.some((line) => /^Updated (just now|\d+ min ago)$/.test(line)) && !state.card.stale, `freshness line: ${state.card.meta}`);
      const use = button(state, 'Use reset credit');
      assert.ok(use && !use.disabled, 'Use reset credit is offered and enabled');

      const listed = await pageFetch(ctx.page, 'GET', '/api/runners');
      assert.equal(listed.status, 200);
      const mine = listed.json.find((row) => sameId(row.id, ctx.runnerUuid));
      assert.ok(mine, 'the web lists the runner');
      assert.equal(mine.online, true);
      assert.ok(mine.capabilities.includes('codex-rate-limit-reset-v1'));
      assert.ok(sameId(mine.heartbeatLeaseOwner, runner.leaseOwner) || mine.heartbeatLeaseOwner === runner.leaseOwner);
      Object.assign(facts, { fingerprint: `${block.accountFingerprint.slice(0, 12)}…`, generation: block.generation.slice(0, 8), sequence: block.sequence, count: 3 });
    },
  },
  {
    id: 'S02',
    title: 'Web confirmation → operation API → heartbeat CONSUME → fake app-server reset → receipt → authoritative refresh; a double press, a lost create answer, a reload and replayed POSTs stay ONE operation and ONE key',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      await ensurePrimary(ctx, { resettable: true });
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      const frontMark = ctx.front.exchanges.length;
      const linkMark = ctx.link.exchanges.length;
      const seen = await beginTitles(page);
      let op;
      // Held between heartbeats so every duplicate below meets the operation while it is still PENDING.
      await freshHeartbeat(ctx);
      ctx.runner.pause();
      try {
        // The create lands, but its answer is held past the page's 15-second POST timeout, so the page gives up on it.
        ctx.front.holdCreateAnswerMs = 22_000;
        ctx.front.holdCreateAnswers = 1;
        await confirmFromWeb(ctx, { twice: true, seen });
        await watchCard(page, 'the card to follow an operation after the create timed out', (s) => TITLE_RANK.has(fold(s.card?.statusTitle)), 90_000, seen);
        assert.ok(seen.includes("Couldn't reach Orbit - retrying..."), `the timed-out create was retried in the open: ${seen.join(' > ')}`);
        op = await newOperation(ctx, before);
        const creates = ctx.front.creates(frontMark);
        assert.ok(creates.length >= 2 && creates[0].heldMs > 0, `creates: ${creates.map((c) => `${c.status}${c.heldMs ? ` (answer held ${c.heldMs}ms)` : ''}`)}`);
        assert.deepEqual([...new Set(creates.map((c) => c.request.clientRequestId))], [op.clientRequestId], 'every create of this confirmation carried its one clientRequestId');
        assert.equal(creates[0].status, 201, 'the timed-out create was the creation');
        assert.ok(creates.slice(1).every((c) => c.status === 200 && c.text.includes('"replayed":true')), 'every later create was a replay');
        assert.equal(creates[0].request.accountFingerprint, op.accountFingerprint);

        await page.reload();
        await openPlanUsage(page);
        await watchCard(page, 'the reloaded page to follow the same operation', (s) => fold(s.card?.statusTitle) === 'Starting reset...', 60_000, seen);
        const replay = await pageFetch(page, 'POST', `/api/runners/${ctx.runnerPublicId}/codex-rate-limit-reset`, {
          clientRequestId: op.clientRequestId,
          accountFingerprint: op.accountFingerprint,
        });
        assert.equal(replay.status, 200, replay.text);
        assert.equal(replay.json.replayed, true);
        assert.equal(replay.json.operation.clientRequestId, op.clientRequestId);
        assert.ok(sameId(replay.json.operation.id, op.id));
        const other = await pageFetch(page, 'POST', `/api/runners/${ctx.runnerPublicId}/codex-rate-limit-reset`, {
          clientRequestId: randomUUID(),
          accountFingerprint: op.accountFingerprint,
        });
        assert.equal(other.status, 409, other.text);
        assert.equal(other.json.code, 'OPERATION_IN_FLIGHT');
        assert.ok(sameId(other.json.operationId, op.id), `the refusal names the operation in flight: ${other.text}`);
        assert.equal((await operations(ctx)).length, before.length + 1, 'still one operation');
        assert.ok(ctx.front.creates(frontMark).every((c) => c.request.clientRequestId !== op.clientRequestId || c.status !== 201 || c === creates[0]));
      } finally {
        ctx.runner.resume();
      }
      const done = await settled(ctx, op.id);
      assert.equal(statusOf(done), 'SUCCEEDED');
      assert.equal(done.consumeOutcome, 'reset');
      expectOperation(ctx, done, 'S02', 1, 1);

      const final = await watchCard(page, 'the card to show the reset and the refreshed count', (s) => fold(s.card?.statusTitle) === 'Usage limits reset' && s.card.count === '2 available', 150_000, seen);
      assert.equal(fold(final.card.statusDetail), '1 credit used. Plan usage has been refreshed.');
      assertTitlesForwards(seen, 'S02');
      assert.ok(!Object.values(final.localStorage).some((value) => value.includes(done.providerIdempotencyKey)), 'the browser keeps no provider key');

      const calls = ctx.fake.consumeCalls(ledgerMark);
      assert.equal(calls.length, 1, `consume calls: ${calls.length}`);
      assert.deepEqual(calls[0].params, { idempotencyKey: done.providerIdempotencyKey });
      const provider = await ctx.fake.state();
      assert.equal(provider.availableCount, 2);
      assert.equal(provider.redeemed.filter((key) => key === done.providerIdempotencyKey).length, 1);

      const block = await storedBlock(ctx);
      assert.equal(block.rateLimitResetCredits.availableCount, 2, 'the stored block is the authoritative read after the reset');
      assert.ok(Date.parse(block.fetchedAt) > Date.parse(done.consumeConfirmedAt), 'the stored read started after the consume was confirmed');
      const commands = ctx.link.exchanges.slice(linkMark).filter((e) => e.route === 'heartbeat' && e.response?.codexRateLimitResetRequest?.operationId === op.id);
      assert.ok(commands.length >= 1 && commands[0].response.codexRateLimitResetRequest.phase === 'CONSUME');
      assert.equal(commands[0].response.codexRateLimitResetRequest.providerIdempotencyKey, done.providerIdempotencyKey);
      // The row settles inside the apiserver before its answer to the runner's last result is back on the wire.
      const results = await eventually("the runner's results to be answered on the wire", async () => {
        const sent = ctx.link.exchanges.slice(linkMark).filter((e) => e.route === 'result' && e.request?.operationId === op.id);
        return sent.some((e) => e.request.kind === 'REFRESHED') ? sent : null;
      }, 30_000, 200);
      assert.deepEqual(results.map((e) => `${e.request.kind}:${e.response?.disposition}`), ['CONSUME_OUTCOME:APPLIED', 'REFRESHED:APPLIED']);
      assert.ok(results[1].request.rateLimitReset.fetchedAt === block.fetchedAt || Date.parse(block.fetchedAt) > Date.parse(results[1].request.rateLimitReset.fetchedAt));
      const stages = new Set(ctx.apiLines().filter((line) => line.operationId === op.id).map((line) => line.stage));
      for (const stage of ['admission', 'delivery', 'consume', 'refresh', 'receipt']) assert.ok(stages.has(stage), `no ${stage} line for the operation (${[...stages]})`);
      Object.assign(facts, { operation: op.id.slice(0, 8), key: `${done.providerIdempotencyKey.slice(0, 8)}…`, creates: ctx.front.creates(frontMark).length, consumeCalls: 1, spent: 1, web: seen.join(' > ') });
    },
  },
  {
    id: 'S03',
    title: 'The CONSUME command and the results are redelivered: a lost heartbeat answer, a lost receipt and a duplicated REFRESHED change nothing but the dispositions',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      const linkMark = ctx.link.exchanges.length;
      await ensurePrimary(ctx, { resettable: true });
      const lostCommand = ctx.link.rule({ route: 'heartbeat', action: 'drop-response', when: (_req, res) => !!res?.codexRateLimitResetRequest });
      const lostReceipt = ctx.link.rule({ route: 'result', action: 'drop-response', when: (req) => req?.kind === 'CONSUME_OUTCOME' });
      const twice = ctx.link.rule({ route: 'result', action: 'duplicate', when: (req) => req?.kind === 'REFRESHED' });
      const seen = await beginTitles(page);
      try {
        await confirmFromWeb(ctx, { seen });
        const op = await newOperation(ctx, before);
        const done = await settled(ctx, op.id, 240_000);
        assert.equal(statusOf(done), 'SUCCEEDED');
        expectOperation(ctx, done, 'S03', 1, 1);
        assert.deepEqual([lostCommand.hits, lostReceipt.hits, twice.hits], [1, 1, 1], 'every fault was applied once');

        const heartbeats = ctx.link.exchanges.slice(linkMark).filter((e) => e.route === 'heartbeat' && e.response?.codexRateLimitResetRequest?.operationId === op.id);
        assert.ok(heartbeats.length >= 2 && heartbeats[0].fault === 'drop-response', `command deliveries: ${heartbeats.map((e) => e.fault ?? 'answered')}`);
        const delivered = heartbeats.map((e) => JSON.stringify(e.response.codexRateLimitResetRequest));
        assert.equal(new Set(delivered).size, 1, 'the redelivered command is byte for byte the lost one: same claim, same key');
        assert.equal(heartbeats[0].response.codexRateLimitResetRequest.providerIdempotencyKey, done.providerIdempotencyKey);

        const outcomes = ctx.link.exchanges.slice(linkMark).filter((e) => e.route === 'result' && e.request?.operationId === op.id && e.request.kind === 'CONSUME_OUTCOME');
        assert.ok(outcomes.length >= 2, `CONSUME_OUTCOME sent ${outcomes.length} time(s)`);
        assert.equal(new Set(outcomes.map((e) => e.raw)).size, 1, 'the unanswered result was sent again byte for byte');
        assert.deepEqual(outcomes.slice(0, 2).map((e) => `${e.response?.disposition}${e.fault ? `(${e.fault})` : ''}`), ['APPLIED(drop-response)', 'DUPLICATE']);
        assert.equal(outcomes[1].response.next, 'REFRESH');
        const refreshed = await eventually('both REFRESHED sends to be answered on the wire', async () => {
          const sent = ctx.link.exchanges.slice(linkMark).filter((e) => e.route === 'result' && e.request?.operationId === op.id && e.request.kind === 'REFRESHED');
          return sent.length >= 2 ? sent : null;
        }, 30_000, 200);
        assert.deepEqual(refreshed.map((e) => e.response?.disposition), ['APPLIED', 'DUPLICATE']);

        const calls = ctx.fake.consumeCalls(ledgerMark);
        assert.equal(calls.length, 1, 'a lost receipt is answered by resending the result, never by consuming again');
        assert.deepEqual(calls[0].params, { idempotencyKey: done.providerIdempotencyKey });
        assert.equal((await ctx.fake.state()).availableCount, 1);
        await watchCard(page, 'the card to show the reset and 1 credit left', (s) => fold(s.card?.statusTitle) === 'Usage limits reset' && s.card.count === '1 available', 150_000, seen);
        assertTitlesForwards(seen, 'S03');
        Object.assign(facts, { operation: op.id.slice(0, 8), commandDeliveries: heartbeats.length, outcomeSends: outcomes.length, refreshedSends: refreshed.length, consumeCalls: 1, spent: 1 });
      } finally {
        ctx.link.clearRules();
      }
    },
  },
  {
    id: 'S04',
    title: 'Provider outcome alreadyRedeemed: the app-server dies after spending, the retry under the SAME key is answered alreadyRedeemed, one credit, refreshed',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      await ensurePrimary(ctx, { availableCount: 2, resettable: true, faults: [{ method: CONSUME_METHOD, do: 'spendThenExit' }] });
      const seen = await beginTitles(page);
      await confirmFromWeb(ctx, { seen });
      const op = await newOperation(ctx, before);
      const done = await settled(ctx, op.id);
      assert.equal(statusOf(done), 'SUCCEEDED');
      assert.equal(done.consumeOutcome, 'alreadyRedeemed');
      expectOperation(ctx, done, 'S04', 2, 1);
      const calls = ctx.fake.consumeCalls(ledgerMark);
      assert.equal(calls.length, 2, `consume calls: ${calls.length}`);
      for (const call of calls) assert.deepEqual(call.params, { idempotencyKey: done.providerIdempotencyKey }, 'the retry reused the persisted key');
      assert.deepEqual(calls.map((call) => call.answer), ['spendThenExit', 'alreadyRedeemed']);
      const provider = await ctx.fake.state();
      assert.equal(provider.availableCount, 1, 'one credit for the operation, not two');
      assert.equal(provider.redeemed.filter((key) => key === done.providerIdempotencyKey).length, 1);
      assert.ok(ctx.watch.traces.get(op.id).some((sample) => sample.row.lastErrorCode === 'APP_SERVER_UNAVAILABLE'), 'the lost answer was recorded as a recoverable error');
      const final = await watchCard(page, 'the card to show the already-applied reset', (s) => fold(s.card?.statusTitle) === 'Usage limits reset' && s.card.count === '1 available', 150_000, seen);
      assert.equal(fold(final.card.statusDetail), 'Codex had already applied this reset, so no extra credit was used. Plan usage has been refreshed.');
      assertTitlesForwards(seen, 'S04');
      Object.assign(facts, { operation: op.id.slice(0, 8), consumeCalls: 2, sameKey: true, spent: 1, answers: calls.map((call) => call.answer).join(',') });
    },
  },
  {
    id: 'S05',
    title: 'Provider outcome nothingToReset: three concurrent POSTs of one intent are one operation; nothing spent, no refresh',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      await clearCard(page);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      await ensurePrimary(ctx, { availableCount: 1, resettable: false });
      const block = await storedBlock(ctx);
      const intent = { clientRequestId: randomUUID(), accountFingerprint: block.accountFingerprint };
      const seen = await beginTitles(page);
      let op;
      await freshHeartbeat(ctx);
      ctx.runner.pause();
      try {
        const answers = await page.call(
          async (url, body) => {
            const send = () =>
              fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('orbit_token')}` },
                body: JSON.stringify(body),
              }).then(async (res) => ({ status: res.status, json: await res.json() }));
            return Promise.all([send(), send(), send()]);
          },
          `/api/runners/${ctx.runnerPublicId}/codex-rate-limit-reset`,
          intent,
        );
        const statuses = answers.map((a) => a.status);
        facts.answers = answers.map((a) => (a.status === 409 ? `409 ${a.json?.code}` : `${a.status}${a.json?.replayed ? ' replayed' : ''}`)).join(', ');
        assert.equal(statuses.filter((status) => status === 201).length, 1, `exactly one concurrent POST created the operation: ${JSON.stringify(answers)}`);
        const named = new Set(answers.map((a) => shared.toUuid(a.json?.operation?.id ?? a.json?.operationId ?? '')));
        assert.equal(named.size, 1, `all three answers name one operation: ${JSON.stringify(answers)}`);
        for (const answer of answers.filter((a) => a.status !== 201)) {
          assert.ok(
            (answer.status === 200 && answer.json.replayed === true) || (answer.status === 409 && answer.json.code === 'OPERATION_IN_FLIGHT'),
            `a duplicate of the intent was answered ${answer.status} ${JSON.stringify(answer.json)}`,
          );
        }
        op = await newOperation(ctx, before);
        assert.equal(op.clientRequestId, intent.clientRequestId);
        await page.reload();
        await openPlanUsage(page);
        await watchCard(page, 'the page to follow the operation it did not start', (s) => fold(s.card?.statusTitle) === 'Starting reset...', 60_000, seen);
      } finally {
        ctx.runner.resume();
      }
      const done = await settled(ctx, op.id);
      assert.equal(statusOf(done), 'NOTHING_TO_RESET');
      assert.equal(done.refreshState, 'NOT_REQUIRED');
      expectOperation(ctx, done, 'S05', 1, 0);
      const calls = ctx.fake.consumeCalls(ledgerMark);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, { idempotencyKey: done.providerIdempotencyKey });
      assert.equal((await ctx.fake.state()).availableCount, 1, 'nothing spent');
      const final = await watchCard(page, 'the card to say there was nothing to reset', (s) => fold(s.card?.statusTitle) === 'Nothing to reset', 60_000, seen);
      assert.equal(fold(final.card.statusDetail), 'None of your Codex usage windows can be reset right now. No credit was used.');
      assert.ok(!ctx.link.exchanges.some((e) => e.route === 'result' && e.request?.operationId === op.id && e.request.kind === 'REFRESHED'), 'no refresh after nothingToReset');
      assertTitlesForwards(seen, 'S05');
      Object.assign(facts, { operation: op.id.slice(0, 8), concurrentPosts: 3, operations: 1, consumeCalls: 1, spent: 0 });
    },
  },
  {
    id: 'S06',
    title: 'Account changed between the confirmation and the consume: zero consume calls, NOT_ATTEMPTED, the new account shown; a restarted runner reads the default account back',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      await ensurePrimary(ctx);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      const primaryBlock = await storedBlock(ctx);
      await ctx.fake.patch({ ...OTHER, availableCount: 2, resettable: true });
      const seen = await beginTitles(page);
      await confirmFromWeb(ctx, { seen });
      const op = await newOperation(ctx, before);
      assert.equal(op.accountFingerprint, primaryBlock.accountFingerprint, 'the confirmation named the account the card showed');
      const done = await settled(ctx, op.id);
      assert.equal(statusOf(done), 'NOT_ATTEMPTED');
      assert.ok(['ACCOUNT_MISMATCH', 'ACCOUNT_CHANGED'].includes(done.failureCode), `failure code ${done.failureCode}`);
      assert.equal(done.claimsWithUnknownCall, 0);
      expectOperation(ctx, done, 'S06', 0, 0);
      assert.equal(ctx.fake.consumeCalls(ledgerMark).length, 0, 'no consume for an account the runner cannot vouch for');
      const shown = await watchCard(page, 'the card to say the account changed', (s) => fold(s.card?.statusTitle) === 'Codex account changed', 90_000, seen);
      assert.equal(fold(shown.card.statusDetail), 'The runner is signed in to a different Codex account, so nothing was reset. No credit was used.');
      const other = await eventually('the other account\'s block to be stored', async () => {
        const block = await storedBlock(ctx);
        return block?.accountFingerprint && block.accountFingerprint !== op.accountFingerprint ? block : null;
      }, 90_000, 1000);
      assert.equal(other.rateLimitResetCredits.availableCount, 2);
      await clearCard(page);
      await watchCard(page, 'the card to show the account now signed in', (s) => s.card?.count === '2 available' && button(s, 'Use reset credit')?.disabled === false, 150_000, seen);

      await ctx.fake.patch({ ...PRIMARY, availableCount: 2, resettable: true });
      const leaseOwner = await restartRunner(ctx);
      const back = await blockFrom(ctx, leaseOwner, 'the default account again', (block) => block.accountFingerprint === op.accountFingerprint);
      assert.equal(back.rateLimitResetCredits.availableCount, 2);
      assertTitlesForwards(seen, 'S06');
      Object.assign(facts, { operation: op.id.slice(0, 8), failureCode: done.failureCode, consumeCalls: 0, spent: 0, restartedAs: leaseOwner.slice(0, 8) });
    },
  },
  {
    id: 'S07',
    title: 'Offline: a silent runner disables the entry and the API refuses RUNNER_OFFLINE; an operation confirmed just before it went silent waits, spends nothing, and completes once it is back',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      await ensurePrimary(ctx, { availableCount: 2, resettable: true });
      await clearCard(page);
      const ledgerMark = ctx.fake.ledger().length;
      const block = await storedBlock(ctx);

      await freshHeartbeat(ctx);
      ctx.runner.pause();
      let op;
      try {
        await eventually('the runner to count as offline (90s without a heartbeat)', async () => (await runnerRow(ctx)).age > 92, 180_000, 1000);
        await page.reload();
        await openPlanUsage(page);
        const offline = await watchCard(page, 'the entry to be disabled as offline', (s) => {
          const use = button(s, 'Use reset credit');
          return use?.disabled === true && s.card.reasons.includes('The runner is offline.');
        }, 90_000);
        assert.equal(offline.card.count, `${block.rateLimitResetCredits.availableCount} available`);
        const before = await operations(ctx);
        const refused = await pageFetch(page, 'POST', `/api/runners/${ctx.runnerPublicId}/codex-rate-limit-reset`, {
          clientRequestId: randomUUID(),
          accountFingerprint: block.accountFingerprint,
        });
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.json.code, 'RUNNER_OFFLINE');
        assert.equal((await operations(ctx)).length, before.length, 'a refusal writes nothing');
      } finally {
        ctx.runner.resume();
      }

      await freshHeartbeat(ctx);
      ctx.runner.pause();
      try {
        const before = await operations(ctx);
        await page.reload();
        await confirmFromWeb(ctx);
        op = await newOperation(ctx, before);
        await eventually('the runner to count as offline again', async () => (await runnerRow(ctx)).age > 92, 180_000, 1000);
        await page.reload();
        await openPlanUsage(page);
        const waiting = await watchCard(page, 'the card to say it is waiting for the runner to come back', (s) => fold(s.card?.statusTitle) === 'Starting reset...' && /come back online/.test(s.card.statusDetail ?? ''), 90_000);
        assert.equal(fold(waiting.card.statusDetail), 'Waiting for the runner to come back online. No credit has been used yet.');
        const waitingRow = await operation(ctx, op.id);
        assert.equal(statusOf(waitingRow), 'PENDING');
        assert.equal(waitingRow.claimGeneration, 0);
        assert.equal(ctx.fake.consumeCalls(ledgerMark).length, 0, 'an offline runner spends nothing');
      } finally {
        ctx.runner.resume();
      }
      const done = await settled(ctx, op.id);
      assert.equal(statusOf(done), 'SUCCEEDED');
      expectOperation(ctx, done, 'S07', 1, 1);
      const calls = ctx.fake.consumeCalls(ledgerMark);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, { idempotencyKey: done.providerIdempotencyKey });
      assert.equal((await ctx.fake.state()).availableCount, 1);
      await watchCard(page, 'the card to show the reset after the runner came back', (s) => fold(s.card?.statusTitle) === 'Usage limits reset' && s.card.count === '1 available', 150_000);
      Object.assign(facts, { operation: op.id.slice(0, 8), offlineRefusal: 'RUNNER_OFFLINE', waitedPending: true, consumeCalls: 1, spent: 1 });
    },
  },
  {
    id: 'S08',
    title: 'Consume confirmed, refresh read fails and is retried read-only until it succeeds: one call, one credit, refreshed',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      // The consume's own account read passes; the next reads fail.
      await ensurePrimary(ctx, { availableCount: 3, resettable: true, faults: [{ ...READ_ERROR, skip: 1 }, READ_ERROR, READ_ERROR, READ_ERROR, READ_ERROR, READ_ERROR] });
      const seen = await beginTitles(page);
      await confirmFromWeb(ctx, { seen });
      const op = await newOperation(ctx, before);
      const retrying = await watchCard(page, 'the card to show the refresh being retried', (s) => /retrying the usage refresh/.test(s.card?.statusDetail ?? ''), 150_000, seen);
      assert.equal(fold(retrying.card.statusTitle), 'Limits reset - refreshing usage...');
      assert.match(fold(retrying.card.statusDetail), /^Codex used 1 credit and reset your eligible usage windows\. The runner couldn't read the Codex account; retrying the usage refresh\.$/);
      const done = await settled(ctx, op.id);
      assert.equal(statusOf(done), 'SUCCEEDED');
      expectOperation(ctx, done, 'S08', 1, 1);
      const trace = ctx.watch.traces.get(op.id);
      assert.ok(trace.some((s) => s.status === 'REFRESHING' && s.row.lastErrorCode === 'READ_FAILED'), 'the failed refresh reads were recorded while REFRESHING');
      const calls = ctx.fake.consumeCalls(ledgerMark);
      assert.equal(calls.length, 1, 'a failing refresh never consumes again');
      assert.equal((await ctx.fake.state()).availableCount, 2);
      await watchCard(page, 'the card to show the reset and the refreshed count', (s) => fold(s.card?.statusTitle) === 'Usage limits reset' && s.card.count === '2 available', 150_000, seen);
      assertTitlesForwards(seen, 'S08');
      const failedReads = ctx.link.exchanges.filter((e) => e.route === 'result' && e.request?.operationId === op.id && e.request.kind === 'REFRESH_FAILED').length;
      Object.assign(facts, { operation: op.id.slice(0, 8), refreshFailedReports: failedReads, consumeCalls: 1, spent: 1 });
    },
  },
  {
    id: 'S09',
    title: 'Consume confirmed but refresh never succeeds: REFRESH_FAILED still reads as a used credit, the stale snapshot gates a new confirmation (Web and API), and a new read recovers it',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      const soft = expectations();
      await noOperationInFlight(ctx);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      await ensurePrimary(ctx, { availableCount: 2, resettable: true, faults: [{ ...READ_ERROR, skip: 1 }, ...Array.from({ length: 300 }, () => READ_ERROR)] });
      await confirmFromWeb(ctx);
      const op = await newOperation(ctx, before);
      await eventually('the consume to be confirmed while the refresh read keeps failing', async () => {
        const row = await operation(ctx, op.id);
        return statusOf(row) === 'REFRESHING' && row.lastErrorCode === 'READ_FAILED';
      }, 150_000, 500);
      // The refresh deadline is ten minutes after the confirmation; the row is moved there instead of waiting for it.
      ctx.watch.allowMove(op.id, 'consumeConfirmedAt');
      await ctx.sql.query('BEGIN');
      try {
        await ctx.sql.query('SET LOCAL session_replication_role = replica');
        await ctx.sql.query(`UPDATE codex_rate_limit_reset_operation SET consume_confirmed_at = consume_confirmed_at - interval '11 minutes' WHERE id = $1`, [op.id]);
        await ctx.sql.query('COMMIT');
      } catch (error) {
        await ctx.sql.query('ROLLBACK');
        throw error;
      }
      await ctx.sql.query(`UPDATE codex_rate_limit_reset_operation SET claimed_at = claimed_at - interval '61 seconds' WHERE id = $1`, [op.id]);
      const done = await settled(ctx, op.id, 180_000);
      assert.equal(statusOf(done), 'REFRESH_FAILED');
      assert.equal(done.failureCode, 'REFRESH_EXPIRED');
      assert.equal(done.consumeOutcome, 'reset');
      expectOperation(ctx, done, 'S09', 1, 1);
      assert.equal(ctx.fake.consumeCalls(ledgerMark).length, 1, 'a refresh that never succeeds never consumes again');
      assert.equal((await ctx.fake.state()).availableCount, 1);
      const stale = await storedBlock(ctx);
      assert.ok(Date.parse(stale.fetchedAt) <= Date.parse(done.completedAt), 'no read after the settlement has been stored');
      assert.equal(stale.rateLimitResetCredits.availableCount, 2, 'the stored count predates the spend');

      const failed = await watchCard(page, 'the card to show a used credit whose usage was not refreshed', (s) => fold(s.card?.statusTitle) === 'Limits reset - usage not refreshed', 90_000);
      assert.equal(failed.card.tone, 'warning');
      assert.match(fold(failed.card.statusDetail), /^Codex used 1 credit and reset your eligible usage windows, but Orbit couldn't read the updated usage\./);
      await clearCard(page);
      await page.reload();
      await openPlanUsage(page);
      const gated = await watchCard(page, 'the card after the unrefreshed spend', (s) => s.card?.count === '2 available' && !!button(s, 'Use reset credit'), 90_000);
      const use = button(gated, 'Use reset credit');
      // The block is still inside the freshness window, so only the readRequiredAfter gate makes it stale: the card
      // says a credit may have been used and a refresh is awaited, not merely that usage is old.
      soft.that(
        use.disabled === true && gated.card.reasons.some((reason) => /may have used a credit/.test(fold(reason)) && /refresh/.test(fold(reason))),
        `Web: after REFRESH_FAILED the entry must be disabled until a later read (the API's readRequiredAfter gate, SNAPSHOT_STALE), saying a credit may have been used, but the card shows ${JSON.stringify({ disabled: use.disabled, reasons: gated.card.reasons, meta: gated.card.meta })}`,
      );
      const refused = await pageFetch(page, 'POST', `/api/runners/${ctx.runnerPublicId}/codex-rate-limit-reset`, {
        clientRequestId: randomUUID(),
        accountFingerprint: stale.accountFingerprint,
      });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, 'SNAPSHOT_STALE');
      assert.equal((await operations(ctx)).length, before.length + 1, 'the stale gate wrote nothing');

      // Recovery: the fake reads again, and a restarted runner reads the account (docs/codex-rate-limit-reset-runbook.md §6).
      await ctx.fake.patch({ faults: [], availableCount: 3, resettable: true });
      const leaseOwner = await restartRunner(ctx);
      const fresh = await blockFrom(ctx, leaseOwner, 'a read after the settlement', (block) => Date.parse(block.fetchedAt) > Date.parse(done.completedAt));
      assert.equal(fresh.rateLimitResetCredits.availableCount, 3);
      await page.reload();
      await openPlanUsage(page);
      await watchCard(page, 'the entry to be offered again after the new read', (s) => s.card?.count === '3 available' && button(s, 'Use reset credit')?.disabled === false, 150_000);
      const again = await operations(ctx);
      const ledgerAgain = ctx.fake.ledger().length;
      await confirmFromWeb(ctx);
      const next = await newOperation(ctx, again);
      const recovered = await settled(ctx, next.id);
      assert.equal(statusOf(recovered), 'SUCCEEDED');
      expectOperation(ctx, recovered, 'S09', 1, 1);
      assert.notEqual(recovered.providerIdempotencyKey, done.providerIdempotencyKey, 'a new confirmation is a new operation with its own key');
      const calls = ctx.fake.consumeCalls(ledgerAgain);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, { idempotencyKey: recovered.providerIdempotencyKey });
      await watchCard(page, 'the card to show the recovered reset', (s) => fold(s.card?.statusTitle) === 'Usage limits reset' && s.card.count === '2 available', 150_000);
      Object.assign(facts, { failed: op.id.slice(0, 8), failureCode: done.failureCode, apiRefusal: refused.json.code, webEntryDisabled: use.disabled, recovered: next.id.slice(0, 8), spent: 2 });
      soft.throwIfAny();
    },
  },
  {
    id: 'S10',
    title: 'Account override: a confirmation from a workspace with its own CODEX_HOME is refused ACCOUNT_OVERRIDE, nothing is created or spent, and the entry is hidden there',
    async run(ctx, facts) {
      const { page } = ctx;
      await noOperationInFlight(ctx);
      await ensurePrimary(ctx, { availableCount: 2, resettable: true });
      await clearCard(page);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      const frontMark = ctx.front.exchanges.length;
      await page.goto(`${ctx.front.origin}/workspaces/${ctx.w2}`);
      await confirmFromWeb(ctx);
      const notice = await watchCard(page, 'the refusal to be explained', (s) => fold(s.card?.statusTitle) === "Couldn't start the reset", 60_000);
      assert.equal(
        fold(notice.card.statusDetail),
        "This workspace doesn't run on the runner's own Codex sign-in, so its reset credits can't be used here. No credit was used.",
      );
      const creates = ctx.front.creates(frontMark);
      assert.equal(creates.length, 1);
      assert.equal(creates[0].status, 409);
      assert.equal(JSON.parse(creates[0].text).code, 'ACCOUNT_OVERRIDE');
      assert.ok(sameId(creates[0].request.workspaceId, ctx.w2), 'the create named the workspace it came from');
      assert.equal((await operations(ctx)).length, before.length);
      assert.equal(ctx.fake.consumeCalls(ledgerMark).length, 0);
      await openPlanUsage(page);
      await page.click(CARD_BUTTON, 'Dismiss');
      await eventually('the entry to be hidden in this workspace', async () => {
        const state = await readOpen(page);
        return state.popoverVisible && state.card === null;
      }, 15_000, 250);
      await page.goto(`${ctx.front.origin}/workspaces/${ctx.w1}`);
      await openPlanUsage(page);
      await watchCard(page, 'the default-account workspace to offer the entry', (s) => button(s, 'Use reset credit')?.disabled === false, 90_000);
      Object.assign(facts, { refusal: 'ACCOUNT_OVERRIDE', operations: 0, consumeCalls: 0 });
    },
  },
  {
    id: 'S11',
    title: 'Provider outcome noCredit, then no balance: nothing spent, the empty count is read back, the entry is disabled and the API refuses NO_CREDIT_AVAILABLE',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      await ensurePrimary(ctx, { availableCount: 0, resettable: true });
      const seen = await beginTitles(page);
      await confirmFromWeb(ctx, { seen });
      const op = await newOperation(ctx, before);
      const done = await settled(ctx, op.id);
      assert.equal(statusOf(done), 'NO_CREDIT');
      assert.equal(done.refreshState, 'NOT_REQUIRED');
      expectOperation(ctx, done, 'S11', 1, 0);
      const calls = ctx.fake.consumeCalls(ledgerMark);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, { idempotencyKey: done.providerIdempotencyKey });
      const shown = await watchCard(page, 'the card to say there is no credit', (s) => fold(s.card?.statusTitle) === 'No reset credit available', 60_000, seen);
      assert.equal(fold(shown.card.statusDetail), 'Codex reports no earned reset credits on this account. No credit was used.');
      const empty = await eventually('the empty count to be stored', async () => {
        const block = await storedBlock(ctx);
        return block?.rateLimitResetCredits?.availableCount === 0 ? block : null;
      }, 90_000, 1000);
      await clearCard(page);
      await watchCard(page, 'the entry to be disabled for no credit', (s) => s.card?.count === '0 available' && button(s, 'Use reset credit')?.disabled === true && s.card.reasons.includes('No reset credits available.'), 150_000, seen);
      const refused = await pageFetch(page, 'POST', `/api/runners/${ctx.runnerPublicId}/codex-rate-limit-reset`, {
        clientRequestId: randomUUID(),
        accountFingerprint: empty.accountFingerprint,
      });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, 'NO_CREDIT_AVAILABLE');
      assert.equal((await operations(ctx)).length, before.length + 1);
      assert.equal(ctx.fake.consumeCalls(ledgerMark).length, 1);
      assertTitlesForwards(seen, 'S11');
      Object.assign(facts, { operation: op.id.slice(0, 8), consumeCalls: 1, spent: 0, refusal: refused.json.code });
    },
  },
  {
    id: 'S12',
    title: 'Unsupported account (API-key sign-in): the runner reads UNSUPPORTED_AUTH, the entry is hidden and the API refuses it',
    async run(ctx, facts) {
      const { page } = ctx;
      await onWorkspace(ctx, ctx.w1);
      await noOperationInFlight(ctx);
      await ensurePrimary(ctx);
      await clearCard(page);
      const before = await operations(ctx);
      const ledgerMark = ctx.fake.ledger().length;
      const lastSupported = await storedBlock(ctx);
      await ctx.fake.patch({ account: { type: 'apiKey' }, availableCount: 2, resettable: true });
      const leaseOwner = await restartRunner(ctx);
      const unsupported = await blockFrom(ctx, leaseOwner, 'UNSUPPORTED_AUTH', (block) => block.support === 'UNSUPPORTED_AUTH');
      assert.equal(unsupported.accountFingerprint, undefined);
      assert.equal(unsupported.rateLimitResetCredits, null);
      await page.reload();
      await eventually('the card to be gone for an unsupported sign-in', async () => {
        const state = await readOpen(page);
        return state.pill !== null && state.popoverVisible && state.card === null;
      }, 150_000, 1000);
      const refused = await pageFetch(page, 'POST', `/api/runners/${ctx.runnerPublicId}/codex-rate-limit-reset`, {
        clientRequestId: randomUUID(),
        accountFingerprint: lastSupported.accountFingerprint,
      });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, 'UNSUPPORTED_AUTH');
      assert.equal((await operations(ctx)).length, before.length);
      assert.equal(ctx.fake.consumeCalls(ledgerMark).length, 0);
      Object.assign(facts, { support: unsupported.support, refusal: refused.json.code, consumeCalls: 0 });
    },
  },
  {
    id: 'S13',
    title: 'Across the whole run: one operation and one provider key per intent, every retry under its own key, no consume after confirmation, rows and snapshots only forwards, no key or account data anywhere it must not be',
    async run(ctx, facts) {
      const soft = expectations();
      const check = async (what, verify) => {
        try {
          await verify();
        } catch (error) {
          soft.that(false, `${what}: ${error.message}`);
        }
      };
      await ctx.watch.sample();
      const rows = await operations(ctx);
      const calls = ctx.fake.consumeCalls();
      const provider = await ctx.fake.state();
      const keys = rows.map((row) => row.providerIdempotencyKey);
      await check('one provider key per operation', () => {
        assert.equal(new Set(keys).size, rows.length, 'every operation has its own provider key');
        for (const key of keys) assert.ok(shared.isCodexResetUuid(key), `provider key ${key} is a UUID`);
      });
      await check('one operation per confirmation', () => {
        assert.deepEqual(rows.map((row) => row.id).sort(), [...ctx.expected.keys()].sort(), 'the operations are exactly the confirmations the scenarios made');
      });
      await check('every consume carried a persisted key', () => {
        for (const call of calls) {
          assert.deepEqual(Object.keys(call.params ?? {}), ['idempotencyKey'], `consume params ${JSON.stringify(call.params)}`);
          assert.ok(keys.includes(call.params.idempotencyKey), 'every consume carried a persisted operation key');
        }
      });
      let spent = 0;
      for (const row of rows) {
        const expected = ctx.expected.get(row.id);
        if (!expected) continue;
        spent += expected.spent;
        await check(`${expected.scenario} operation ${row.id}`, () => {
          const mine = calls.filter((call) => call.params?.idempotencyKey === row.providerIdempotencyKey);
          assert.equal(mine.length, expected.consumeCalls, `${mine.length} consume calls`);
          const confirmedAt = ctx.watch.firstSeen(row.id, 'consumeConfirmedAt');
          if (confirmedAt) {
            const late = mine.filter((call) => Date.parse(call.at) > Date.parse(confirmedAt));
            assert.equal(late.length, 0, `consume called after its confirmation at ${confirmedAt}`);
          }
          assert.equal(provider.redeemed.filter((key) => key === row.providerIdempotencyKey).length, expected.spent, 'credits redeemed under its key');
        });
      }
      await check('the provider redeemed nothing no operation accounts for', () => assert.equal(provider.redeemed.length, spent));
      await check('rows and stored snapshots only moved forwards', () => {
        assert.deepEqual(ctx.watch.violations(), []);
        assert.deepEqual(ctx.watch.errors, [], 'the sampler read every sample');
      });
      const apiLog = ctx.api.text();
      const runnerLog = readFileSync(path.join(LOGS, 'runner.log'), 'utf8');
      const webBodies = ctx.front.exchanges.map((exchange) => exchange.text).join('\n');
      const wire = ctx.link.exchanges.map((exchange) => `${exchange.raw}${exchange.text}`).join('\n');
      const stored = JSON.stringify((await card(ctx.page)).localStorage);
      await check('provider keys only inside CONSUME commands', () => {
        for (const key of keys) {
          assert.ok(!apiLog.includes(key), `the apiserver log carries provider key ${key}`);
          assert.ok(!runnerLog.includes(key), `the runner log carries provider key ${key}`);
          assert.ok(!webBodies.includes(key), `a response the web received carries provider key ${key}`);
          assert.ok(!stored.includes(key), `the browser stored provider key ${key}`);
          for (const exchange of ctx.link.exchanges) {
            const seen = `${exchange.raw}${exchange.text}`.split(key).length - 1;
            const command = exchange.response?.codexRateLimitResetRequest;
            const carriers = exchange.route === 'heartbeat' && command?.phase === 'CONSUME' && command.providerIdempotencyKey === key ? 1 : 0;
            assert.equal(seen, carriers, `provider key ${key} crossed the runner wire outside a CONSUME command (${exchange.route} #${exchange.seq})`);
          }
        }
      });
      await check('no runner token or raw account data', () => {
        const secrets = { 'the runner token': ctx.runner.config.runnerToken, 'an account id': PRIMARY.accountId, 'an account email': PRIMARY.account.email, 'the other account id': OTHER.accountId, 'the other account email': OTHER.account.email };
        for (const [name, secret] of Object.entries(secrets)) {
          assert.ok(!apiLog.includes(secret), `the apiserver log carries ${name}`);
          assert.ok(!webBodies.includes(secret), `the web received ${name}`);
          assert.ok(!wire.includes(secret), `a heartbeat or result body carries ${name}`);
          assert.ok(!runnerLog.includes(secret), `the runner log carries ${name}`);
        }
      });
      const guardHits = existsSync(GUARD_HITS) ? readFileSync(GUARD_HITS, 'utf8').trim().split('\n').filter(Boolean) : [];
      await check('nothing but the fake answered as Codex', () => {
        assert.deepEqual(guardHits.filter((line) => line.startsWith('codex')), [], 'something ran a codex other than the fake app-server');
      });
      Object.assign(facts, {
        operations: rows.length,
        providerKeys: new Set(keys).size,
        consumeCalls: calls.length,
        creditsSpent: spent,
        rowSamples: [...ctx.watch.traces.values()].reduce((n, trace) => n + trace.length, 0),
        storedBlocks: ctx.watch.blocks.length,
        engineGuardHits: guardHits.length,
      });
      soft.throwIfAny();
    },
  },
];

// ── main ───────────────────────────────────────────────────────────────────────────────────────

async function setUp(teardown) {
  const ctx = { expected: new Map() };
  const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(SCRATCH, 'home'), LANG: 'C.UTF-8' };
  mkdirSync(baseEnv.HOME, { recursive: true });

  const pgName = `${PG_PREFIX}${randomBytes(3).toString('hex')}`;
  say(`==> PostgreSQL ${pgName}`);
  const database = await startPostgres({ pg, name: pgName, log: log.harness });
  teardown.push(() => database.stop());
  say('==> prisma migrate deploy');
  migrate({ apiDir: API, prisma: PRISMA, url: database.url, env: baseEnv, log: log.harness });
  const { rows: migrated } = await (async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      return await client.query('SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL');
    } finally {
      await client.end();
    }
  })();
  say(`    ${migrated[0].n} migrations applied`);
  ctx.sql = new pg.Client({ connectionString: database.url });
  ctx.sql.on('error', (error) => say(`sql client error: ${error.message}`));
  await ctx.sql.connect();
  teardown.push(() => ctx.sql.end());

  say('==> apiserver (node dist/main.js)');
  ctx.api = await startApiserver({
    apiDir: API,
    node: process.execPath,
    port: await freePort(),
    log: log.api,
    env: {
      ...baseEnv,
      DATABASE_URL: database.url,
      JWT_SECRET: randomBytes(32).toString('hex'),
      PROVIDER_SECRET_KEY: randomBytes(32).toString('base64'),
      CORS_ORIGINS: 'http://127.0.0.1',
      MODEL_CATALOG_URL: 'http://127.0.0.1:9/models.json',
      NO_COLOR: '1',
    },
  });
  teardown.push(() => ctx.api.stop());
  ctx.apiLines = () =>
    ctx.api
      .text()
      .split('\n')
      // eslint-disable-next-line no-control-regex
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
      .flatMap((line) => {
        const at = line.indexOf('codex-reset {');
        if (at < 0) return [];
        try {
          return [JSON.parse(line.slice(at + 'codex-reset '.length))];
        } catch {
          return [];
        }
      });

  ctx.link = new RunnerLink(ctx.api.origin);
  await ctx.link.listen();
  teardown.push(() => ctx.link.close());
  ctx.front = new WebFront({ dist: WEB_DIST, upstream: ctx.api.origin });
  await ctx.front.listen();
  teardown.push(() => ctx.front.close());
  say(`    apiserver ${ctx.api.origin}  runner link ${ctx.link.origin}  web ${ctx.front.origin}`);

  const password = randomBytes(18).toString('base64url');
  const owner = await callApi(ctx.api.origin, 'POST', '/auth/bootstrap', { body: { email: 'e2e-owner@example.invalid', name: 'E2E Owner', password } });
  assert.equal(owner.status, 201, `bootstrap: ${owner.text}`);
  ctx.token = owner.json.accessToken;
  const browserSession = await callApi(ctx.api.origin, 'POST', '/auth/login', { body: { email: 'e2e-owner@example.invalid', password } });
  assert.ok([200, 201].includes(browserSession.status), `login: ${browserSession.text}`);
  const enrollment = await callApi(ctx.api.origin, 'POST', '/runners/enrollment-tokens', { token: ctx.token, body: { label: RUNNER_NAME, ttlHours: 6 } });
  assert.equal(enrollment.status, 201, `enrollment token: ${enrollment.text}`);

  ctx.fake = new FakeCodex({ dir: path.join(SCRATCH, 'provider'), binDir: path.join(SCRATCH, 'fake-codex-bin'), faultBinary: FAULT_BINARY, runnerGoDir: RUNNER_GO });
  ctx.fake.init({ ...PRIMARY, availableCount: 3, resettable: true, redeemed: [], answers: [], faults: [] });
  ctx.runner = new RunnerMachine({
    binary: RUNNER_BINARY,
    root: path.join(SCRATCH, 'machine'),
    searchPath: `${ctx.fake.binDir}:${GUARD_BIN}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    log: log.runner,
  });
  say('==> orbit register');
  await ctx.runner.register({ server: ctx.link.origin, token: enrollment.json.token, name: RUNNER_NAME });
  const { rows: runners } = await ctx.sql.query('SELECT id::text AS id FROM runner WHERE name = $1', [RUNNER_NAME]);
  assert.equal(runners.length, 1, 'orbit register created one runner');
  ctx.runnerUuid = runners[0].id;
  ctx.runnerPublicId = shared.uuidToBase62(ctx.runnerUuid);

  // Two workspaces on the runner, each last run on the built-in Codex (a workspace's provider is what its latest
  // session ran): the second one sets its own CODEX_HOME. Their seed sessions are ended before the runner first runs.
  const workspace = async (name, workDir, env) => {
    mkdirSync(workDir, { recursive: true });
    const created = await callApi(ctx.api.origin, 'POST', '/workspaces', { token: ctx.token, body: { name, runnerId: ctx.runnerPublicId, workDir } });
    assert.equal(created.status, 201, `workspace: ${created.text}`);
    const id = created.json.publicId ?? created.json.id;
    if (env) {
      const patched = await callApi(ctx.api.origin, 'PATCH', `/workspaces/${id}`, { token: ctx.token, body: { env } });
      assert.equal(patched.status, 200, `workspace env: ${patched.text}`);
    }
    const session = await callApi(ctx.api.origin, 'POST', '/sessions', {
      token: ctx.token,
      body: { workspaceId: id, provider: 'codex', prompt: 'Codex reset E2E seed: this workspace runs on the built-in Codex.' },
    });
    assert.equal(session.status, 201, `seed session: ${session.text}`);
    const ended = await callApi(ctx.api.origin, 'POST', `/sessions/${session.json.publicId ?? session.json.id}/end`, { token: ctx.token });
    assert.ok([200, 201].includes(ended.status), `ending the seed session: ${ended.text}`);
    return id;
  };
  ctx.w1 = await workspace('Codex reset E2E', ctx.runner.work, null);
  ctx.w2 = await workspace('Codex reset E2E (own CODEX_HOME)', path.join(SCRATCH, 'machine', 'work-override'), {
    CODEX_HOME: path.join(SCRATCH, 'machine', 'override-codex-home'),
  });

  say('==> orbit run');
  ctx.runner.start();
  teardown.push(() => ctx.runner.stop());
  const watchClient = new pg.Client({ connectionString: database.url });
  watchClient.on('error', (error) => say(`watch client error: ${error.message}`));
  await watchClient.connect();
  teardown.push(() => watchClient.end());
  ctx.watch = new DbWatch({ client: watchClient, shared, runnerId: ctx.runnerUuid });
  ctx.watch.start();
  teardown.push(() => ctx.watch.stop());

  say('==> chromium');
  const browser = await launchChromium({
    binary: CHROMIUM,
    profileDir: path.join(SCRATCH, 'chromium'),
    port: await freePort(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(SCRATCH, 'chromium-home') },
    log: log.chromium,
  });
  teardown.push(() => browser.close());
  ctx.page = await browser.newPage();
  teardown.push(() => ctx.page.close());
  await ctx.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${recordTitles.toString()})();` });
  await ctx.page.goto(`${ctx.front.origin}/login`);
  await ctx.page.call(
    (access, refresh) => {
      localStorage.setItem('orbit_token', access);
      localStorage.setItem('orbit_refresh', refresh);
    },
    browserSession.json.accessToken,
    browserSession.json.refreshToken,
  );
  return ctx;
}

function dumpCaptures(ctx) {
  if (!ctx) return;
  try {
    writeFileSync(path.join(LOGS, 'runner-wire.json'), JSON.stringify(ctx.link?.exchanges ?? [], null, 2));
    writeFileSync(path.join(LOGS, 'web-wire.json'), JSON.stringify(ctx.front?.exchanges ?? [], null, 2));
    writeFileSync(path.join(LOGS, 'rows.json'), JSON.stringify(Object.fromEntries(ctx.watch?.traces ?? []), null, 2));
    writeFileSync(path.join(LOGS, 'blocks.json'), JSON.stringify(ctx.watch?.blocks ?? [], null, 2));
    if (existsSync(path.join(SCRATCH, 'provider'))) cpSync(path.join(SCRATCH, 'provider'), path.join(LOGS, 'provider'), { recursive: true });
    if (DEBUG_DIR) cpSync(LOGS, DEBUG_DIR, { recursive: true });
  } catch (error) {
    say(`could not write the captures: ${error.message}`);
  }
}

async function main() {
  mkdirSync(LOGS, { recursive: true });
  const teardown = [];
  let ctx;
  let tornDown = false;
  const tearDown = async () => {
    if (tornDown) return;
    tornDown = true;
    for (const step of teardown.reverse()) {
      try {
        await step();
      } catch (error) {
        say(`teardown: ${error.message}`);
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      say(`==> ${signal}: tearing the stack down`);
      dumpCaptures(ctx);
      void tearDown().then(() => process.exit(130));
    });
  }

  const results = [];
  try {
    ctx = await setUp(teardown);
    for (const scenario of SCENARIOS) {
      const facts = {};
      const started = Date.now();
      say(`\n==> ${scenario.id} ${scenario.title}`);
      // Every scenario but the whole-run invariants starts from the stored block S01 waits for: without it each would
      // only wait out its own timeouts. They are failed, not skipped.
      if (scenario.id !== 'S01' && scenario.id !== 'S13' && results.find((result) => result.id === 'S01')?.status !== 'PASS') {
        const error = 'not attempted: S01 failed, so no Codex reset block reached Runner.planUsage for this scenario to confirm from';
        results.push({ id: scenario.id, title: scenario.title, status: 'FAIL', seconds: 0, facts, error });
        say(`<== ${scenario.id} FAIL: ${error}`);
        continue;
      }
      try {
        await scenario.run(ctx, facts);
        results.push({ id: scenario.id, title: scenario.title, status: 'PASS', seconds: Math.round((Date.now() - started) / 1000), facts });
        say(`<== ${scenario.id} PASS in ${Math.round((Date.now() - started) / 1000)}s ${JSON.stringify(facts)}`);
      } catch (error) {
        results.push({ id: scenario.id, title: scenario.title, status: 'FAIL', seconds: Math.round((Date.now() - started) / 1000), facts, error: error.stack ?? String(error) });
        say(`<== ${scenario.id} FAIL in ${Math.round((Date.now() - started) / 1000)}s\n${error.stack ?? error}`);
        await ctx.page?.screenshot(path.join(LOGS, `${scenario.id}-failed.png`)).catch(() => undefined);
        dumpCaptures(ctx);
        ctx.link?.clearRules();
        ctx.runner?.resume();
      }
      if (STOP_AFTER === scenario.id) {
        say(`==> CODEX_RESET_E2E_STOP_AFTER=${STOP_AFTER}: the remaining scenarios do not run, so this run cannot be green`);
        break;
      }
    }
  } catch (error) {
    say(`==> the stack did not come up:\n${error.stack ?? error}`);
    results.push({ id: 'SETUP', title: 'the stack came up', status: 'FAIL', seconds: 0, facts: {}, error: error.stack ?? String(error) });
  }

  const report = { declared: SCENARIOS.map(({ id, title }) => ({ id, title })), results };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  say('\n==== Codex reset E2E scenarios');
  for (const scenario of SCENARIOS) {
    const result = results.find((candidate) => candidate.id === scenario.id);
    say(`${scenario.id}  ${(result?.status ?? 'NOT RUN').padEnd(7)} ${String(result ? `${result.seconds}s` : '-').padStart(5)}  ${scenario.title}`);
    if (result?.facts && Object.keys(result.facts).length > 0) say(`                     ${JSON.stringify(result.facts)}`);
    if (result?.status === 'FAIL') say(`                     ${String(result.error).split('\n')[0]}`);
  }

  if (DEBUG_DIR) mkdirSync(DEBUG_DIR, { recursive: true });
  dumpCaptures(ctx);

  if (HOLD && ctx) {
    const hold = { api: ctx.api.origin, web: ctx.front.origin, link: ctx.link.origin, token: ctx.token, runner: ctx.runnerPublicId, w1: ctx.w1, w2: ctx.w2 };
    writeFileSync(path.join(SCRATCH, 'hold.json'), JSON.stringify(hold, null, 2));
    say(`==> holding the stack (${path.join(SCRATCH, 'hold.json')}); create ${path.join(SCRATCH, 'release')} to tear it down`);
    while (!existsSync(path.join(SCRATCH, 'release'))) await sleep(1000);
  }
  await tearDown();
  const green = results.length === SCENARIOS.length && results.every((result) => result.status === 'PASS');
  process.exit(green ? 0 : 1);
}

await main();
