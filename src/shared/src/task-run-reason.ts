/**
 * Why a task counts as running: what the work session carrying it is doing right now. Decided in
 * one place, the apiserver's `sessions/task-work-carrier.ts`; every surface that says a task is
 * running carries this beside it.
 *
 *   - `TURN` — a turn is queued or executing, or the engine is generating on its own (a self-driven
 *     turn, a sub-agent still in flight). A queued turn is TURN too; the row still reads QUEUED.
 *   - `BACKGROUND_JOB` — the session ended its turn to wait for a runner-hosted job it started
 *     (`bg_run`), which wakes it when the job ends.
 *   - `WAITING` — the session ended its turn to be woken by something else: a watch it observes
 *     (`task_await`, `session_await`, `watch_create`), a `schedule_wakeup`, an armed auto-retry.
 *
 * In priority order: a session doing more than one of these reports the first.
 */
export type TaskRunReason = 'TURN' | 'BACKGROUND_JOB' | 'WAITING';
