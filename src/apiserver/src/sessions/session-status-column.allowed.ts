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
  'common/runner-drain-waiting.ts': { reads: 3 },
  'common/session-generating.ts': { reads: 2, enums: 1 },
  'common/session-release.ts': { reads: 3, enums: 1 },
  'common/session-scheduling.ts': { enums: 1 },
  'common/session-tree-sql.ts': { reads: 5 },
  'common/session-working.ts': { reads: 5, enums: 1 },
  'deadlock/dependency-revision-fixture.ts': { writes: 1, alone: 1 },
  'deadlock/lock-order-fixture.ts': { writes: 2, alone: 2 },
  'deadlock/orbit-lock-fixture.ts': { reads: 2, writes: 1, alone: 1 },
  'feishu/feishu-group.service.ts': { reads: 1 },
  'feishu/feishu-open-limits.ts': { reads: 1 },
  'github/github-workspace.service.ts': { reads: 1 },
  'help/help-ask-marker.ts': { reads: 2, enums: 1 },
  'help/help-ask-reads.ts': { reads: 3, enums: 1 },
  'help/help-ask.ts': { reads: 1 },
  'link-previews/link-previews.service.ts': { reads: 1, enums: 1 },
  'managed-runners/managed-runner-manager.ts': { reads: 1, writes: 1, alone: 1, enums: 1 },
  'managed-runners/managed-runner-work.ts': { reads: 2 },
  'managed-runners/managed-runner.service.ts': { reads: 2 },
  'metrics/fleet-metrics.ts': { reads: 4 },
  'projects/landing-session.ts': { writes: 2 },
  'projects/session-source.ts': { writes: 1 },
  'providers/account-health.service.ts': { reads: 2 },
  'providers/account-move-capability.ts': { enums: 1 },
  'providers/active-sessions.ts': { reads: 2 },
  'providers/anthropic-gateway.service.ts': { reads: 1 },
  'providers/pool-login-gateway.service.ts': { reads: 1 },
  'providers/pool-pause.ts': { reads: 1 },
  'push/push.service.ts': { reads: 4, enums: 1 },
  'queue/dispatch-pause.service.ts': { reads: 1 },
  'queue/queue.service.ts': { reads: 8, writes: 2, alone: 2 },
  // Reads none (task T9). `forceFinalize` writes the word and `turnState` together, as deploy 2 does; T14 takes it to 0.
  'realtime/reaper.service.ts': { writes: 1 },
  // Reads none (task T8). Its runner-driven writers write the word and `turnState` together, as deploy 2 does; T14
  // takes these to 0.
  'runner-api/runner-api.controller.ts': { writes: 9 },
  'runners/attention-fix.ts': { reads: 2 },
  'runners/claude-account-swap.ts': { reads: 6 },
  'runners/runner-background-holders.ts': { reads: 1 },
  'runners/runners.service.ts': { reads: 6, enums: 1 },
  'schedules/schedule-runs.service.ts': { reads: 9, enums: 1 },
  'session-guests/session-guests.service.ts': { reads: 3, writes: 1, alone: 1, enums: 1 },
  // The reads added after the list was seeded: the one fallback for a held row with no `turn_state` (not yet
  // backfilled), which keeps its stored word (project rule of 2026-11-25: readers may reach production before the
  // backfill, task T3). Task T4 added it to the projector; task T11 moved it into session-turn-state.ts, beside the
  // turn state readers move onto (`heldSessionWord`, `turnStateOf`, `turnStateFilter`, `sessionTurnStateSql`), so the
  // projector and every moved reader ask the same function. The projector's SQL twin takes the word as an argument
  // (`legacySessionStatusSql` hands it over), and LEGACY_STATUS_SELECT / TURN_STATE_SELECT select it for them. Goes
  // with the column's writers (T14).
  'sessions/session-legacy-words.ts': { reads: 1 },
  'sessions/session-turn-state.ts': { reads: 5 },
  'sessions/auto-retry-eligibility.ts': { reads: 2, enums: 1 },
  'sessions/auto-retry.service.ts': { reads: 22, enums: 1 },
  'sessions/open-list-version.ts': { reads: 2 },
  'sessions/queued-reason-sql.ts': { reads: 2 },
  'sessions/run-now.ts': { reads: 2 },
  'sessions/session-move.ts': { reads: 3, enums: 1 },
  'sessions/session-phase.ts': { reads: 4, enums: 1 },
  'sessions/session-reach.ts': { reads: 1 },
  'sessions/session-request.ts': { reads: 3 },
  'sessions/sessions.controller.ts': { enums: 1 },
  'sessions/sessions.service.ts': { reads: 59, writes: 8, alone: 8, enums: 1 },
  'sessions/task-work-carrier.ts': { reads: 6, enums: 1 },
  'share-links/share-links.service.ts': { reads: 1 },
  'watches/watch-delivery.service.ts': { reads: 1 },
  'watches/watch-evaluator.service.ts': { reads: 1 },
  'watches/watches.service.ts': { reads: 4 },
  'wiki/wiki-chat.ts': { reads: 3, enums: 1 },
  'wiki/wiki-dossier.ts': { reads: 2 },
  'wiki/wiki-maintenance.ts': { reads: 2 },
  'workspaces/main-checkout.service.ts': { reads: 1 },
};
