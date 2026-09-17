import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsService } from './sessions.service';

/**
 * A WORKING ROW REPORTS HOW LONG *THIS TURN* HAS BEEN GOING, AND `last_turn_at` CANNOT TELL IT.
 *
 * That column is rewritten on every state move — the turn being delivered, the session going to
 * AWAITING_INPUT, the reaper resetting the idle clock so it won't tear a session down mid-reload.
 * So on a running session it always sits seconds behind now. Measured against the live database
 * while writing this: eight running sessions, `last_turn_at` ages 0s / 1s / 2s / 3s across them,
 * while the turns underneath had been going 19s, 68s, 137s and 300s. Reading the first clock beside
 * a spinner prints "just now" against every row at once, which is why the client used to show
 * nothing there — and showing nothing loses the one fact worth having when six rows are spinning:
 * which of them has been at it for forty minutes.
 *
 * The turn's own delivery time is the second clock. `answered_at IS NULL` is what makes it the
 * *current* turn rather than the last finished one, and the CASE gate keeps the subquery off the
 * settled rows that make up most of a list.
 */
test('the list dates the turn in flight, gated on the states that can have one', async () => {
  let sql = '';
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      sql = query.sql;
      return [];
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  await service.list('00000000-0000-0000-0000-000000000001', {});

  assert.match(sql, /AS "currentTurnStartedAt"/);
  // The *current* turn: one already answered is a finished turn and must not be picked up.
  assert.match(sql, /ct\.answered_at IS NULL/);
  // Only a mid-turn session has one, so settled rows never pay for the subquery.
  assert.match(sql, /CASE WHEN s\.status IN \('RUNNING', 'PENDING'\)/);
  // max() takes the newest of them, and skips the undelivered rows for free — it ignores NULLs,
  // which is also why this carries no LIMIT: the unpaged list asserts it emits none.
  assert.match(sql, /SELECT max\(ct\.delivered_at\)/);
});

/**
 * The paired negative: the row's settled timestamp is a different column and stays where it was.
 * Without this, a regression that aliased the turn clock as `lastTurnAt` would pass the assertions
 * above while silently changing what every non-running row displays.
 */
test('the settled timestamp keeps its own column', async () => {
  let sql = '';
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      sql = query.sql;
      return [];
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  await service.list('00000000-0000-0000-0000-000000000001', {});

  assert.match(sql, /s\.last_turn_at\s+AS "lastTurnAt"/);
});
