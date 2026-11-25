/**
 * Today's uses of `session.status` in the apiserver, per file: how many each may hold. Read by
 * session-status-column.spec.ts, whose scanner (test-support/session-status-scan.ts) says what counts.
 * Paths are under src/apiserver/src. A count left out is 0.
 *
 * - `reads`: the column is read. Tasks T7 to T12 of docs/session-status-retirement-plan.md take these to 0.
 * - `writes`: the column is written. Task T14 takes these to 0 and deletes this list.
 * - `alone`: a write with no `turnState` beside it. Deploy 2 writes both, so T7 to T12 take these to 0.
 * - `enums`: the column's Prisma type, `RunStatus` of `@prisma/client`. Gone with the field (T14).
 *
 * A number may only go down: when a task moves a use onto the facts, lower its number, and delete the row at zero.
 * The `*-fixture(s).ts` files are listed because they are compiled into the server like any other source file.
 */
export interface SessionStatusUses {
  reads?: number;
  writes?: number;
  alone?: number;
  enums?: number;
}

export const SESSION_STATUS_USES: Readonly<Record<string, SessionStatusUses>> = {
  'auth/tenant-isolation-fixtures.ts': { writes: 3, alone: 3 },
  'deadlock/dependency-revision-fixture.ts': { writes: 1, alone: 1 },
  'deadlock/lock-order-fixture.ts': { writes: 2, alone: 2 },
  'deadlock/orbit-lock-fixture.ts': { reads: 2, writes: 1, alone: 1 },
  // Reads none (task T7). The out-of-memory stop writes the word and `turnState` together, as deploy 2 does; T14 takes
  // it to 0.
  'managed-runners/managed-runner-manager.ts': { writes: 1 },
  'projects/landing-session.ts': { writes: 2 },
  'projects/session-source.ts': { writes: 1 },
  // Reads none (task T7): claim, slots and dispatch read the turn state. The claim and its undo write the word and
  // `turn_state` together, as deploy 2 does; T14 takes these to 0. common/, managed-runners/, runners/ and metrics/ read
  // none and write none.
  'queue/queue.service.ts': { writes: 2 },
  // Reads none (task T9). `forceFinalize` writes the word and `turnState` together, as deploy 2 does; T14 takes it to 0.
  'realtime/reaper.service.ts': { writes: 1 },
  // Reads none (task T8). Its runner-driven writers write the word and `turnState` together, as deploy 2 does; T14
  // takes these to 0.
  // The tenth is main's return-slot (f49915d0b8), moved onto the facts with T10's landing merge.
  'runner-api/runner-api.controller.ts': { writes: 10 },
  'session-guests/session-guests.service.ts': { writes: 1 },
  // The reads added after the list was seeded: the one fallback for a held row with no `turn_state` (not yet
  // backfilled), which keeps its stored word (project rule of 2026-11-25: readers may reach production before the
  // backfill, task T3). Task T4 added it to the projector; task T11 moved it into session-turn-state.ts, beside the
  // turn state readers move onto (`heldSessionWord`, `turnStateOf`, `turnStateFilter`, `sessionTurnStateSql`), so the
  // projector and every moved reader ask the same function. The projector's SQL twin takes the word as an argument
  // (`legacySessionStatusSql` hands it over), and LEGACY_STATUS_SELECT / TURN_STATE_SELECT select it for them. Goes
  // with the column's writers (T14). Since task T10 these two are the only reads left in sessions/ and session-guests/:
  // every other reader there asks them, and `?status=` (statusWordFilter) matches an unfilled held row through them.
  'sessions/session-legacy-words.ts': { reads: 1 },
  'sessions/session-turn-state.ts': { reads: 4 },
  // Nine writers, each writing `turnState` beside the word; the ninth is main's Stop on a draining runner (f49915d0b8).
  'sessions/sessions.service.ts': { writes: 9, enums: 1 },
};
