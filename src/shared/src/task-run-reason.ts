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
export type TaskRunReason = SessionActivity;

/**
 * What any live session is doing, beyond what its `status` says — the same three answers, for every
 * session and not only one carrying a task. Decided once on the server (`sessionActivitySql` in
 * `sessions/task-work-carrier.ts`) and sent with the session wherever its state is shown, so no
 * surface reads AWAITING_INPUT alone as "idle, waiting for a reply": a self-driven turn, a sub-agent,
 * a `bg_run` job or a wait that will wake it all sit at AWAITING_INPUT too.
 *
 * Null when none of them holds: queued or running sessions say so through `status`, and a parked one
 * with nothing in flight is really waiting on its next message. A `service` left up (a dev server)
 * does not count — it never ends, so it never wakes anyone.
 */
export type SessionActivity = 'TURN' | 'BACKGROUND_JOB' | 'WAITING';
