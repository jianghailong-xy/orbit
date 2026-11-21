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
 * mixed sets (auto-retry.service.ts FAILED with AWAITING_INPUT; wiki-maintenance.ts), and the derived SessionRunState
 * and SessionState sets (share-links/public-task.ts, watch-predicate.ts, web sessionState.ts).
 *
 * Plan step 4.2 moved the TypeScript readers of "released" and "held" (appendix sections B and C, and those that
 * arrived from main since) onto the release column, `finished_at`, through isReleased / isHeld / releasedFilter /
 * heldFilter in common/session-release.ts, and deleted the rows it took to zero. Still counted below: the writers
 * that record a release, the old runner protocol's status words, readers of FAILED as against the other terminal
 * values (the release does not yet record whether it was a failure), activity sets, and readers other phase 4 steps
 * own (raw SQL 4.3, work readers 4.6, wake rules 4.7, the projector 4.8).
 */
export const SESSION_TERMINAL_STATUS_READERS: Readonly<Record<string, number>> = {
  'src/apiserver/src/common/session-scheduling.ts': 2,
  // The one definition of "held" and "released" (plan step 3.5): the two status sets, their SQL fragments, and the
  // release causes. Its TypeScript readers read `finished_at` since plan step 4.2; the sets stay for the raw SQL
  // fragments (plan step 4.3) and for the filters whose status list is an index's access path.
  'src/apiserver/src/common/session-release.ts': 8,
  'src/apiserver/src/common/session-tree-sql.ts': 1,
  'src/apiserver/src/help/help-ask-marker.ts': 1,
  'src/apiserver/src/help/help-ask-reads.ts': 1,
  'src/apiserver/src/projects/coordinator-evidence-queue.service.ts': 2,
  'src/apiserver/src/projects/coordinator-handoff.service.ts': 3,
  'src/apiserver/src/projects/landing-session.ts': 4,
  'src/apiserver/src/projects/pending-addressees.ts': 1,
  'src/apiserver/src/projects/project-done-request.ts': 1,
  'src/apiserver/src/projects/project-open-item.ts': 4,
  'src/apiserver/src/projects/session-source.ts': 1,
  'src/apiserver/src/providers/active-sessions.ts': 3,
  'src/apiserver/src/push/settle-alert.ts': 2,
  'src/apiserver/src/realtime/reaper.service.ts': 4,
  'src/apiserver/src/runner-api/background-job-wake.ts': 3,
  'src/apiserver/src/runner-api/runner-api.controller.ts': 26,
  'src/apiserver/src/runner-api/runner-link-hints.ts': 1,
  'src/apiserver/src/runner-api/scheduled-wakeup.ts': 3,
  'src/apiserver/src/runner-api/scheduled-wakeup.worker.ts': 2,
  // The old runner protocol's turn status words translated into the turn outcome; goes when plan phase 6 lets the runner report the outcome itself.
  'src/apiserver/src/runner-api/turn-outcome.ts': 4,
  'src/apiserver/src/schedules/schedule-runs.service.ts': 10,
  'src/apiserver/src/sessions/auto-retry.service.ts': 9,
  'src/apiserver/src/sessions/session-move.ts': 1,
  'src/apiserver/src/sessions/sessions.service.ts': 9,
  'src/apiserver/src/sessions/task-work-carrier.ts': 2,
  'src/apiserver/src/share-links/public-task.ts': 1,
  'src/apiserver/src/task-lists/task-lists.service.ts': 1,
  'src/apiserver/src/tasks/evidence-review.service.ts': 1,
  'src/apiserver/src/tasks/reference-expansion.ts': 1,
  'src/apiserver/src/tasks/task-retry-policy.ts': 2,
  'src/apiserver/src/tasks/task-route-decision.ts': 3,
  'src/apiserver/src/tasks/tasks.service.ts': 5,
  'src/apiserver/src/tasks/verification-dependency.ts': 2,
  'src/apiserver/src/watches/watch-delivery.service.ts': 3,
  'src/apiserver/src/watches/watch-predicate.ts': 4,
  'src/apiserver/src/wiki/wiki-maintenance.ts': 2,
  'src/shared/src/enums.ts': 25,
  'src/web/src/lib/sessionState.ts': 3,
};
