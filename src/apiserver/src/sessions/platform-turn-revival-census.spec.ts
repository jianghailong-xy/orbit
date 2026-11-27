import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { landingFixTurnId } from '../projects/landing-fix-turn';
import { isOrbitAuthoredTurn } from './orbit-authored-turn';
import {
  PLATFORM_REVIVABLE_END_REASON,
  REVIVING_PLATFORM_TURN_PREFIXES,
  platformTurnRevives,
} from './platform-turn-revival';
import { LANDING_FIX_TURN_KEY_PREFIX, assertClientTurnIdNotReserved } from './watch-turn-key';

/**
 * The session route census for platform turns that revive (docs/project-integration-line-contract.md
 * §0.3 G6, §12.5 W6, §12.8 "landing-fix:v1: is the only platform prefix that can revive a task_done
 * session").
 *
 *   1. The G6 prefix table, read from the contract itself: of its prefixes, `landing-fix:v1:` is the one
 *      `platformTurnRevives` lets revive a `task_done` session, and it revives nothing else.
 *   2. Every `resume` call in the product is registered below with the key it writes, so a new caller
 *      cannot arrive without saying what it revives with; among them, the only one keyed by a G6
 *      platform prefix is the landing-fix delivery.
 *   3. The prefix is registered in the platform turn classifiers: Orbit-authored, and reserved at the
 *      doors (no caller may take it, and buy a revival with it).
 */
const SRC = path.resolve(__dirname, '../../src');
const DOC = path.resolve(__dirname, '../../../../docs/project-integration-line-contract.md');

/** The G6 table of §0.3: each row's `clientTurnId` prefix, up to its last colon before a placeholder. */
function g6Prefixes(): string[] {
  const doc = readFileSync(DOC, 'utf8');
  // The first table whose header row opens with the `clientTurnId` column: §0.3's.
  const start = doc.indexOf('| `clientTurnId` ');
  assert.ok(start >= 0, 'the G6 prefix table is not in the contract');
  const rows = doc.slice(start).split('\n').slice(2);
  const prefixes: string[] = [];
  for (const row of rows) {
    if (!row.startsWith('|')) break;
    const key = /^\| `([^`]+)`/.exec(row)?.[1];
    if (key) prefixes.push(key.slice(0, key.indexOf('<')));
  }
  return prefixes;
}

/** How a session can be ended, as the rows hold it. */
const ENDINGS = {
  task_done: { finishedAt: new Date(), endReason: 'task_done', deletedAt: null },
  ended: { finishedAt: new Date(), endReason: 'ended', deletedAt: null },
  cancelled: { finishedAt: new Date(), endReason: 'cancelled', deletedAt: null },
  completed: { finishedAt: new Date(), endReason: 'completed', deletedAt: null },
  deleted: { finishedAt: new Date(), endReason: 'deleted', deletedAt: new Date() },
  task_cancelled: { finishedAt: new Date(), endReason: 'task_cancelled', deletedAt: null },
  failed: { finishedAt: new Date(), endReason: null, deletedAt: null },
  task_done_in_trash: { finishedAt: new Date(), endReason: 'task_done', deletedAt: new Date() },
} as const;

test('of the G6 platform prefixes, landing-fix:v1: alone revives, and only a task_done session', () => {
  const prefixes = g6Prefixes();
  assert.ok(prefixes.length >= 8, `the G6 table read as ${JSON.stringify(prefixes)}`);
  assert.ok(prefixes.includes(LANDING_FIX_TURN_KEY_PREFIX), 'landing-fix:v1: is not in the G6 table');
  assert.deepEqual(REVIVING_PLATFORM_TURN_PREFIXES, [LANDING_FIX_TURN_KEY_PREFIX]);
  assert.equal(PLATFORM_REVIVABLE_END_REASON, 'task_done');
  for (const prefix of prefixes) {
    for (const [ending, session] of Object.entries(ENDINGS)) {
      const revives = platformTurnRevives(`${prefix}0190f000-0000-7000-8000-000000000000`, session);
      const expected = prefix === LANDING_FIX_TURN_KEY_PREFIX && ending === 'task_done';
      assert.equal(revives, expected, `${prefix} over a session ended ${ending}: revives ${revives}`);
    }
  }
  // A live session is not a revival at all.
  assert.equal(platformTurnRevives(landingFixTurnId('j'), { finishedAt: null, endReason: null, deletedAt: null }), false);
});

/**
 * Every `resume` call in the product, by file, with the key namespace it revives with. `g6` is the G6
 * prefix the key is under, or null when it is not a G6 platform turn (a caller's own key, a re-send, a
 * wake, a task run's brief, a coordinator's delivery).
 */
const RESUME_CALLERS: Record<string, { calls: number; key: string; g6: string | null }> = {
  'projects/coordinator-delivery.service.ts': { calls: 1, key: 'coordinator-wake-delivery:v1: (derivedUuid), to a coordinator', g6: null },
  'projects/coordinator-handoff.service.ts': { calls: 1, key: 'coordinator-handoff:v1:, to a coordinator', g6: null },
  'projects/project-open-item.service.ts': { calls: 1, key: 'landing-fix:v1:<jobId>, to a task_done work session', g6: LANDING_FIX_TURN_KEY_PREFIX },
  'projects/projects.service.ts': { calls: 1, key: 'project_send: the sending session\'s own key', g6: null },
  'runner-api/runner-sessions.controller.ts': { calls: 1, key: 'session_send resumeIfEnded: the caller\'s own key', g6: null },
  'runner-api/scheduled-wakeup.worker.ts': { calls: 1, key: 'bg-wake:wakeup:<id>, to a FAILED session', g6: null },
  'session-guests/session-guests.service.ts': { calls: 1, key: 'a guest\'s own key', g6: null },
  'sessions/auto-retry.service.ts': { calls: 2, key: 'auto-retry:, the re-send of a failed turn', g6: null },
  'sessions/sessions.controller.ts': { calls: 1, key: 'the owner\'s own key (POST /sessions/:id/resume)', g6: null },
  'sessions/sessions.service.ts': { calls: 2, key: 'a merge repair\'s random key; the routed re-entry of the same request', g6: null },
  'tasks/tasks.service.ts': { calls: 1, key: 'task-run:, a task run\'s brief', g6: null },
};

function productSources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'test-support') productSources(full, into);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      into.push(full);
    }
  }
  return into;
}

test('every resume caller is registered with its key, and only the landing-fix delivery revives under a G6 prefix', () => {
  const found: Record<string, number> = {};
  for (const file of productSources(SRC)) {
    const source = readFileSync(file, 'utf8');
    const calls = source.match(/\bsessions\.resume\(|^\s*(?:return |await |const \w+ = await )?this\.resume\(/gm)?.length ?? 0;
    if (calls > 0) found[path.relative(SRC, file)] = calls;
  }
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(RESUME_CALLERS).map(([file, entry]) => [file, entry.calls])),
    'a resume caller appeared, moved or went away: register it in RESUME_CALLERS with the key it revives with',
  );
  const g6 = g6Prefixes();
  const reviving = Object.entries(RESUME_CALLERS).filter(([, entry]) => entry.g6 !== null);
  assert.deepEqual(reviving.map(([file, entry]) => [file, entry.g6]),
    [['projects/project-open-item.service.ts', LANDING_FIX_TURN_KEY_PREFIX]]);
  for (const [, entry] of reviving) assert.ok(g6.includes(entry.g6!), `${entry.g6} is not a G6 prefix`);
  // And that caller's resume is the landing-fix turn's, narrowed by the revival rule.
  const delivery = readFileSync(path.join(SRC, 'projects/project-open-item.service.ts'), 'utf8');
  assert.match(delivery, /const clientTurnId = landingFixTurnId\(item\.integrationJobId\);/);
  assert.match(delivery, /if \(ended && !platformTurnRevives\(clientTurnId, session\)\)/);
  assert.match(delivery, /if \(session\.finishedAt !== null && !platformTurnRevives\(input\.clientTurnId, session\)\)/);
});

test('the landing-fix prefix is registered in the platform turn classifiers', () => {
  const key = landingFixTurnId('0190f000-0000-7000-8000-000000000000');
  assert.ok(key.startsWith('landing-fix:v1:'));
  assert.equal(isOrbitAuthoredTurn(key), true, 'a landing-fix turn is not Orbit-authored');
  assert.throws(() => assertClientTurnIdNotReserved(key), /reserved for the failed landings/);
});
