/**
 * The product files allowed to name a terminal session status through its enum or to spell their own
 * session status set, and how many such hits each may hold. Read by
 * session-terminal-status-readers.spec.ts, whose header says what counts as a hit.
 *
 * Seeded from the tree at plan step 0.5 of docs/session-three-state-plan.md. Every file here is a row
 * of docs/session-three-state-read-sites.md whose Facts are not NONE. A number may only go down: when
 * a phase moves a reader onto the shared definition, lower its number, and delete the row at zero.
 *
 * Plan step 3.5 moved every hand-copied held set (PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED) and released set
 * (SUCCEEDED, FAILED, CANCELLED) onto common/session-release.ts. The hand-written session sets still counted below
 * are left on purpose, because none of them is either set: activity sets (PENDING and RUNNING, a turn queued or
 * running: session-scheduling.ts UNSETTLED, project-done-request.ts, providers/active-sessions.ts,
 * schedule-runs.service.ts, sessions.service.ts, tasks.service.ts, task-work-carrier.ts), held-but-idle sets
 * (AWAITING_INPUT and INTERRUPTED, with or without PENDING or RUNNING: session-tree-sql.ts,
 * coordinator-evidence-queue.service.ts, providers/active-sessions.ts, evidence-review.service.ts, tasks.service.ts,
 * task-work-carrier.ts), the claimed-and-held set without PENDING (runner-link-hints.ts),
 * mixed sets (auto-retry.service.ts FAILED with AWAITING_INPUT), and the derived SessionRunState
 * and SessionState sets (share-links/public-task.ts, watch-predicate.ts, web sessionState.ts).
 *
 * Plan step 4.2 moved the TypeScript readers of "released" and "held" (appendix sections B and C, and those that
 * arrived from main since) onto the release column, `finished_at`, through isReleased / isHeld / releasedFilter /
 * heldFilter in common/session-release.ts, and deleted the rows it took to zero. Still counted below: the writers
 * that record a release, the old runner protocol's status words, readers of FAILED as against the other terminal
 * values (the release does not yet record whether it was a failure), activity sets, and readers other phase 4 steps
 * own (raw SQL 4.3, work readers 4.6, wake rules 4.7, the projector 4.8).
 *
 * Plan step 4.3 moved the raw SQL readers of "held" and "released" onto the release column through sessionHeldSql /
 * sessionReleasedSql, deleted releasedSql, and took wiki-maintenance.ts's settled set (every status but PENDING and
 * RUNNING) to its activity spelling, `NOT IN ('PENDING', 'RUNNING')`. Left: the activity, held-but-idle and
 * claimed-and-held sets above, which name no terminal value.
 *
 * Plan step 4.5 (release A) moved queue/dispatch-pause.service.ts onto sessionHeldIndexedSql and deleted heldSql, and
 * the readers whose access path is the execution claim index onto its new predicate (`finished_at IS NULL`). Neither
 * was a hit: heldSql's list is one constant, and the claim readers spread TASK_OCCUPYING, so no number falls.
 *
 * Plan step 4.6 moved the readers of what became of the work (decision D5) onto the release cause: a failure is a
 * failure cause (isFailedRelease / failedReleaseFilter / failedReleaseSql), and the work finished exactly when the cause
 * is task_done or landing_settled (isWorkFinishedRelease); every other release is a stop. It deleted the rows it took
 * to zero (help-ask-marker.ts, auto-retry.service.ts, session-move.ts, task-retry-policy.ts, task-route-decision.ts,
 * verification-dependency.ts). Left in the files it lowered: the old runner protocol's turn words in
 * coordinator-handoff.service.ts afterTurn (the runner's turn-complete status, as in turn-outcome.ts), the held
 * INTERRUPTED and the activity set in schedule-runs.service.ts, and in sessions.service.ts and tasks.service.ts the
 * release writers, the LANDING detail's legacy status, and activity or held-idle sets.
 *
 * Removal steps R3 and R4 (design §12, decision D9) moved the readers of "released by a failure" and "the work
 * finished" off the release cause onto the release module's two questions (releaseWasFailure / releaseFinishedTheWork,
 * each a predicate, a Prisma filter and an SQL fragment), which read the turn outcome and the end reason. Their one
 * terminal value was the status bridge, counted in a section of its own, (f) FAILURE_STATUS_BRIDGE, until removal step
 * R7 (deploy 3, after migration 1441 backfilled the turn outcome) deleted the arm and the section with it.
 *
 * Plan step 4.8 split this list by kind. Only (a) and (b) decide from a terminal value, beside named transitions that
 * end with later steps, (c) and (d); (e) names none. A file may sit in more than one section; its allowance is
 * the sum. (a) RELEASE_WRITERS: the writers of design §6.3 that record a release, which still write the legacy
 * `status` beside the release fact, and decide in the same statement from the status they write (the reaper's
 * forceFinalize, the runner's finalize and its failed turn, the import, the end of a queued session, the landing
 * container and the refused source), with the one vocabulary they share
 * (RELEASED_SESSION_STATUSES, which the finalize also checks the runner's word against, and gracefulEndStatus).
 * (b) PROJECTOR: the projector of the status word from a session's facts (session-legacy-words.ts) and the derive
 * functions that produce the legacy wire fields `runState`, `sessionState` and
 * `filingState` from it and the stored facts, which withSessionState (sessions/session-state.ts) puts on every payload beside
 * `status` and `runStatus`; session-state-legacy-fields.spec.ts pins their output for every stored combination.
 * (c) OLD_PROTOCOL: the runner's turn-complete status word, translated into the turn outcome and read by the turn
 * writer; it goes when plan phase 6 (task 3509dk246EQ9g9yZRriiQ, step 6.1) lets the runner report the outcome and the
 * release as two things. (d) CLIENT_WIRE: the web client's decoder of the legacy vocabulary, which plan step 5.2
 * (task 3509djyYbFwb4VQd8DnCc) moves onto the new fields. (e) NO_RELEASED_VALUE: hand-written activity sets
 * (PENDING, RUNNING), held-idle sets (AWAITING_INPUT, INTERRUPTED), the held set and slot counts. They name no released
 * value, and are counted because the project's criterion JGPQFXIZvP1MO137FGfPP counts every hand-written live or
 * terminal status set, not because they decide from a terminal value. INTERRUPTED is counted wherever it stands for the
 * same reason: session_release_fact_chk (migrations 1401, 1402) makes it a held status, never a released one.
 *
 * The spec holds the split to the source: a file that names a released value (SUCCEEDED, FAILED or CANCELLED, or for
 * the derived states ENDED, COMPLETED, DORMANT or DELETED, through an enum or in a session set) is in one of sections
 * (a) to (d), and every file in those sections names one; a file only in section (e) names none.
 */

/** (a) The writers that record a release, and the vocabulary they write. */
export const RELEASE_WRITERS: Readonly<Record<string, number>> = {
  // RELEASED_SESSION_STATUSES: the statuses a release writes, which session_release_fact_chk ties to `finished_at`
  // and the runner's finalize accepts (its TERMINAL); isReleasedStatus builds spec rows from it.
  'src/apiserver/src/common/session-release.ts': 4,
  // landingContainerStatus: the status both container writers write, and the LANDING detail shows before its row exists.
  'src/apiserver/src/projects/landing-session.ts': 2,
  // The refused source: FAILED with setup_failed.
  'src/apiserver/src/projects/session-source.ts': 1,
  // forceFinalize and the status each sweep hands it.
  'src/apiserver/src/realtime/reaper.service.ts': 4,
  // turnComplete's failed turn (the status it writes and publishes), the finalize (its status, the side effects it
  // decides in the same transaction, producedNothingBeforeFailing) and the failed import.
  'src/apiserver/src/runner-api/runner-api.controller.ts': 14,
  // The end of a session still queued: CANCELLED, and the status the end answers with.
  'src/apiserver/src/sessions/sessions.service.ts': 2,
  // gracefulEndStatus: the status the finalize and the reaper write for a graceful end.
  'src/shared/src/enums.ts': 2,
};

/** (b) The one projector of the legacy wire fields. */
export const PROJECTOR: Readonly<Record<string, number>> = {
  // legacySessionStatus, which derives the status word from a session's facts, and statusWordFilter beside it
  // (docs/session-status-retirement-plan.md §3.1, §6).
  'src/apiserver/src/sessions/session-legacy-words.ts': 9,
  // deriveSessionRunState, deriveSessionState (deriveSessionLifecycleState and deriveSessionFilingState name none).
  'src/shared/src/enums.ts': 23,
};

/** (c) The old runner protocol's turn status words, until plan phase 6 (task 3509dk246EQ9g9yZRriiQ). */
export const OLD_PROTOCOL: Readonly<Record<string, number>> = {
  // afterTurn reads the runner's turn-complete status word, as turn-outcome.ts does.
  'src/apiserver/src/projects/coordinator-handoff.service.ts': 2,
  // turnComplete's reading of the runner's word (`dto.status`) for what the turn did.
  'src/apiserver/src/runner-api/runner-api.controller.ts': 12,
  // The word translated into the turn outcome.
  'src/apiserver/src/runner-api/turn-outcome.ts': 4,
};

/** (d) A client's decoder of the legacy vocabulary, until plan step 5.2 (task 3509djyYbFwb4VQd8DnCc). */
export const CLIENT_WIRE: Readonly<Record<string, number>> = {
  // SESSION_RUN_STATES and SESSION_STATES, the two vocabularies, and one held-idle set of derived run states.
  'src/web/src/lib/sessionState.ts': 3,
  // RELEASED_STATUSES: the session counts' tally class of a row, read off its legacy `status` (main e513174734, merged
  // into the project with plan step 6.1). Plan step 5.2 reads the rows' `released` first; the set is left as the
  // reading of a row from a control plane that predates it, which has nothing else to tell a release by.
  'src/web/src/lib/useControlPlane.tsx': 1,
};

/** (e) Hand-written sets that name no released value: activity, held-idle and held sets, and slot counts. */
export const NO_RELEASED_VALUE: Readonly<Record<string, number>> = {
  // Not a set: the repeated out-of-memory stop writes INTERRUPTED on the turns it parks (main 1baac761e8). It goes
  // when that writer moves to `turn_state` (docs/session-status-retirement-plan.md, writer #1).
  'src/apiserver/src/managed-runners/managed-runner-manager.ts': 1,
  // HELD_SESSION_STATUSES, for the filters whose status list is an index's access path.
  'src/apiserver/src/common/session-release.ts': 2,
  // UNSETTLED (a turn queued or running), and statusAfterTurnEnqueued's idle statuses (AWAITING_INPUT, INTERRUPTED).
  'src/apiserver/src/common/session-scheduling.ts': 2,
  // The background-held set in the slot counts: PENDING, AWAITING_INPUT, INTERRUPTED.
  'src/apiserver/src/common/session-tree-sql.ts': 1,
  // `paused`: held and stopped mid-turn (INTERRUPTED).
  'src/apiserver/src/help/help-ask-reads.ts': 1,
  // Idle coordinators: AWAITING_INPUT or INTERRUPTED.
  'src/apiserver/src/projects/coordinator-evidence-queue.service.ts': 2,
  // A coordinator is busy unless AWAITING_INPUT or INTERRUPTED.
  'src/apiserver/src/projects/pending-addressees.ts': 1,
  // Tasks with a session queued or running.
  'src/apiserver/src/projects/project-done-request.ts': 1,
  // Sessions per account: queued or running, and held-idle within a window.
  'src/apiserver/src/providers/active-sessions.ts': 3,
  // The claimed-and-held set (RUNNING, AWAITING_INPUT, INTERRUPTED) as an index condition.
  'src/apiserver/src/runner-api/runner-link-hints.ts': 1,
  // landRun's held INTERRUPTED, and the not-queued-or-running filter of completeNoChangeSessions.
  'src/apiserver/src/schedules/schedule-runs.service.ts': 2,
  // The workspace tally of sessions queued or running.
  'src/apiserver/src/sessions/sessions.service.ts': 1,
  // Activity and the parked status in the carrier SQL.
  'src/apiserver/src/sessions/task-work-carrier.ts': 2,
  // The derived run states still live on the public task page: QUEUED, RUNNING.
  'src/apiserver/src/share-links/public-task.ts': 1,
  // The idle sweep's creator sessions: AWAITING_INPUT or INTERRUPTED.
  'src/apiserver/src/tasks/evidence-review.service.ts': 1,
  // Tasks with a session queued or running, and the held-idle sessions in raw SQL.
  'src/apiserver/src/tasks/tasks.service.ts': 2,
};

export const ALLOW_LIST_SECTIONS = {
  RELEASE_WRITERS,
  PROJECTOR,
  OLD_PROTOCOL,
  CLIENT_WIRE,
  NO_RELEASED_VALUE,
} as const;

/** Each file's allowance: the sum of its sections. */
export const SESSION_TERMINAL_STATUS_READERS: Readonly<Record<string, number>> = Object.values(ALLOW_LIST_SECTIONS)
  .flatMap((section) => Object.entries(section))
  .reduce<Record<string, number>>((sum, [file, n]) => ({ ...sum, [file]: (sum[file] ?? 0) + n }), {});
