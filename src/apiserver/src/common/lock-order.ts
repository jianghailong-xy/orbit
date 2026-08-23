import type { Prisma } from '@prisma/client';

/**
 * The one canonical lock order for Task, Session and dependency writes.
 *
 * Every deadlock this repo has taken in production was two transactions acquiring the same two
 * rows in opposite orders, and in both cases at least one of the two locks was never written in
 * any SQL statement — it was taken for the statement by a foreign key's internal constraint
 * trigger. So the order below is stated over RELATIONS and it counts implicit locks: an
 * `INSERT "task"` naming `creator_session_id` locks a `session` row exactly as surely as
 * `SELECT … FOR UPDATE` does, and `docs/postgres-lock-order.md` derives every entry from a real
 * `pg_locks` reading rather than from the SQL's appearance.
 *
 * The order is a partial order over relations; the invariants that make it executable are:
 *
 *  **I1 — the owner graph mutex comes first.** A transaction that writes more than one `task`
 *  row, or writes `task_dependency` at all, takes `lockOwnerTaskGraph` before anything else.
 *  That serializes the whole Task-writing family per owner: two transactions that both hold it
 *  cannot deadlock with each other no matter which rows they go on to touch, which is why the
 *  rest of this order only has to reason about Task-writer vs Session-writer.
 *
 *  **I2 — Session rows are locked before the first Task write.** A `task` write re-checks
 *  `task_creator_session_id_fkey` and takes `FOR KEY SHARE` on the creator Session. Taking those
 *  locks up front, sorted, at the strongest mode the transaction will need, is what stops a Task
 *  transaction from interleaving Session locks with Task locks — the shape of the 2026-08-21
 *  05:53:11 two-party cycle. An EDGE write used to need this too, because
 *  `task_dependency_dispatch_touch` made it re-write its dependent Task; since 0132 it advances
 *  `task_dependency_revision` (rank 70) instead and takes no Session lock at all, so the pure
 *  edge paths take rank 10 and nothing else.
 *
 *  **I4 — a dispatch takes the owner row at rank 10 before it reaches rank 70.** An edge writer
 *  holds `lockOwnerTaskGraph` (10, `FOR UPDATE`) from its first statement and advances
 *  `task_dependency_revision` (70) from its last. A dispatch does the reverse by nature: it wants
 *  the revision during its decision, and it takes the owner row only IMPLICITLY, several
 *  statements later, when `session_owner_id_fkey` fires on its Session insert. So
 *  `ProjectTaskDispatcherService.dispatchInTransaction` takes `FOR KEY SHARE` on the owner in its
 *  FIRST statement — the same mode and the same row that insert would have taken anyway, moved
 *  earlier, exactly as I2 does for a Task write. Measured, not assumed:
 *  `dependency-revision.pg.spec.ts` runs the same pair with that clause removed and gets a 40P01.
 *
 *  **I3 — one write per Session row per transaction.** PostgreSQL skips a foreign key's re-check
 *  when no key column changed, *except* when the row being updated was written by the current
 *  transaction (`ri_triggers.c`, `RI_FKey_fk_upd_check_required`). So the SECOND write of one
 *  `session` row re-runs every Session foreign key and silently takes `FOR KEY SHARE` on `user`,
 *  `workspace`, `runner` and `task` — the reverse of I1/I2's direction, and the third edge of
 *  the 2026-08-21 05:47:43 cycle. A transaction that writes the row once takes none of them.
 *  Measured, not assumed: `lock-order.pg.spec.ts` reads the four locks appearing on the second
 *  write and being absent on the first.
 *
 * Rank order, lowest first. A transaction acquires locks in non-decreasing rank, and where it
 * needs several rows of one relation it takes them sorted by id in a single statement at the
 * strongest mode it will need (`orderedIds`), so two transactions can never take the same pair
 * of rows in opposite orders.
 */
export const LOCK_ORDER = [
  {
    rank: 10,
    relation: 'user',
    modes: 'FOR UPDATE (owner graph mutex) · FOR KEY SHARE (task/session owner FK)',
    why: 'The graph mutex every multi-row Task write takes first (I1).',
  },
  {
    rank: 20,
    relation: 'task_list',
    modes: 'FOR UPDATE (list policy write) · FOR KEY SHARE (task.list_id FK)',
    why: 'A pause writes the list row and then every Task in it, so the list is taken before its Tasks.',
  },
  {
    rank: 30,
    relation: 'session',
    modes: 'FOR UPDATE (runner lease fence, inbox, lifecycle) · FOR KEY SHARE (task.creator_session_id FK)',
    why: 'I2. Pre-locked before the first Task/edge write; the entire lock set of a runner events transaction (I3).',
  },
  {
    rank: 40,
    relation: 'project',
    modes: 'FOR NO KEY UPDATE (session capacity fence, verdict gate, reconcile, unit L3 scope fence) · FOR KEY SHARE (task/session FK, project_event outbox)',
    why:
      'Above `task` because that is the order the Project authorization adapter already declares ' +
      '(project FOR NO KEY UPDATE, then task FOR SHARE), and below `session` because ' +
      'session_project_capacity_serialize is a BEFORE trigger on a Session write that is already ' +
      'holding its Session row.',
  },
  {
    rank: 50,
    relation: 'task',
    modes: 'FOR UPDATE (delete) · FOR NO KEY UPDATE (update) · FOR SHARE (session dispatch guard, authorization) · FOR KEY SHARE (edge + session.task_id FK)',
    why: 'Multi-row selections are always taken sorted by id (orderedIds).',
  },
  {
    rank: 60,
    relation: 'task_dependency, conversation_turn, run_event, tool_call, attachment, project_event, project_action',
    modes: 'INSERT/UPDATE/DELETE only',
    why: 'Child rows whose FK parents are already held by this point, so they add no wait edge of their own.',
  },
  {
    rank: 70,
    relation: 'task_dependency_revision',
    modes: 'FOR NO KEY UPDATE (0132 advances it after an edge write) · FOR SHARE (the dispatch decision reads the edge set under it)',
    why:
      'The dispatch version boundary for one Task\'s prerequisite set, and the last lock anybody ' +
      'takes. BELOW the edges (60) because a writer changes edges and then advances the revision, ' +
      'and the dispatch decision reads them in that same order — locking the prerequisites at 50, ' +
      'the edges at 60, the revision at 70 — so the two can never take the pair in opposite ' +
      'directions. It is what makes an EMPTY edge set lockable, which is the whole reason 0122 ' +
      'was touching the dependent Task instead. Rows are advanced sorted by Task uuid and once ' +
      'per statement, in the database (`task_dependency_revision_advance`). See I4.',
  },
] as const;

/**
 * The two places a lock is knowingly taken out of rank order, each with the argument for why it
 * still cannot close a cycle. Written down rather than left implicit: an order with unstated
 * exceptions is not an order anybody can check a new call site against.
 */
export const LOCK_ORDER_EXCEPTIONS = [
  {
    where: 'TasksService.deleteAndStopRuns — task (50) before the cascade\'s session write (30)',
    why:
      'The task rows must be locked before the runs attached to them are read, or a dispatch ' +
      'lands between the scan and the DELETE and is stranded by the very code meant to stop that ' +
      '(a session INSERT takes FOR SHARE on the task, which FOR UPDATE conflicts with). The ' +
      'attached sessions are therefore pre-locked at rank 30 first, so the ordinary case takes ' +
      'them in rank order; only a run that attaches between that statement and the task lock is ' +
      'taken out of order, and this transaction holds the owner graph mutex, so its counterpart ' +
      'can never be another Task write.',
  },
  {
    where: 'project_event outbox inserts — project (40) after the task/session write (50/30)',
    why:
      'An outbox insert takes FOR KEY SHARE on the project through project_event_project_id_fkey, ' +
      'and FOR KEY SHARE conflicts with exactly one mode: FOR UPDATE. The only holders of project ' +
      'FOR UPDATE are ProjectAcceptanceService.lockProject(FOR UPDATE) and ProjectsService, and ' +
      'neither waits on a task or session row while holding it (both only write project-scoped ' +
      'child tables), so the inversion has no counterpart to close a cycle with.',
  },
] as const;

/**
 * Relations whose lock modes make them incapable of joining a cycle from these paths, so they
 * are deliberately NOT ranked above. Kept beside the order because "not listed" has to mean
 * "argued", not "forgotten"; `lock-order.spec.ts` asserts each claim still matches the source.
 */
export const LOCK_ORDER_COMPATIBLE = [
  {
    relation: 'workspace',
    why:
      'WorkspacesService.remove takes FOR UPDATE on the row and then waits for nothing — its only ' +
      'other statements are an unlocked count and the update of that same row. A transaction with ' +
      'no outgoing wait edge cannot be an element of a cycle. Every other path touches workspace ' +
      'at FOR KEY SHARE (FK) or FOR SHARE, which do not conflict with each other.',
  },
  {
    relation: 'runner',
    why:
      'Nothing in these paths takes FOR UPDATE on a runner row. Heartbeats write it (FOR NO KEY ' +
      'UPDATE), and FOR NO KEY UPDATE does not conflict with the FOR KEY SHARE a Session or ' +
      'Workspace FK check takes, so an FK check never waits on a heartbeat.',
  },
  {
    relation: 'run_event, tool_call, conversation_turn, attachment',
    why:
      'Child rows only. They are inserted or updated by the transaction that already holds their ' +
      'Session row, so they introduce no lock their parent has not already given.',
  },
] as const;

/**
 * Dedupe and sort ids so several rows of one relation are always taken in the same order by
 * every transaction. `sort()` on uuid text is a total order and is the same one PostgreSQL's
 * `ORDER BY id` produces for the `uuid` type on the ids this codebase mints (all lowercase hex
 * with dashes, so byte order and text order agree).
 */
export function orderedIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))].sort();
}

/**
 * The owner graph mutex (I1). Locking the owner's own row serializes every dependency-graph
 * mutation for one user: it is what makes concurrent A->B and B->A edge writes see each other's
 * result instead of both passing cycle detection against the same stale graph, and it is what
 * keeps two multi-row Task writes from taking the same Tasks in opposite orders.
 */
export async function lockOwnerTaskGraph(
  tx: Prisma.TransactionClient,
  ownerId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${ownerId}::uuid FOR UPDATE`;
}

/**
 * I2: take the Session rows a Task/edge write will foreign-key check, before it writes.
 *
 * `FOR KEY SHARE` is exactly the mode `task_creator_session_id_fkey` takes, so this pre-lock
 * neither strengthens nor weakens what the write does — it only moves WHEN it happens, out of
 * the middle of the Task writes and into one ordered statement ahead of them. It therefore
 * cannot block a reader, cannot block another Task transaction (they take the same mode), and
 * conflicts with exactly one thing: the `FOR UPDATE` a runner holds while it owns the Session.
 *
 * One statement, `ORDER BY "id"`: the LockRows node sits above the sort, so the rows are locked
 * in id order whatever the planner picked to find them. One statement rather than several is
 * itself part of the guarantee — a second statement is a second chance to be interleaved.
 */
export async function lockCreatorSessions(
  tx: Prisma.TransactionClient,
  sessionIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const ids = orderedIds(sessionIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT "id" FROM "session"
    WHERE "id" = ANY(${ids}::uuid[])
    ORDER BY "id"
    FOR KEY SHARE`;
}

/**
 * I2 for the other FK endpoint a Task write re-checks under a lock somebody else takes at
 * `FOR UPDATE`: the list. `TaskListsService` writes the list row and then every Task in it, so a
 * Task write that names a list has to take the list first or the two meet head-on.
 */
export async function lockTaskLists(
  tx: Prisma.TransactionClient,
  listIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const ids = orderedIds(listIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT "id" FROM "task_list"
    WHERE "id" = ANY(${ids}::uuid[])
    ORDER BY "id"
    FOR KEY SHARE`;
}

/**
 * The creator Sessions of a set of Tasks — what I2 needs before touching those Tasks.
 *
 * Read rather than assumed, because the Session a Task's foreign key names is not something the
 * caller usually has: a caller knows task ids, and each of those rows carries whatever creator
 * Session it was born with. Read inside the same transaction and under the owner graph mutex, so
 * the answer is still true when the write lands.
 */
export async function creatorSessionsOf(
  tx: Prisma.TransactionClient,
  taskIds: ReadonlyArray<string | null | undefined>,
): Promise<string[]> {
  const ids = orderedIds(taskIds);
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ creatorSessionId: string | null }>>`
    SELECT "creator_session_id" AS "creatorSessionId"
    FROM "task"
    WHERE "id" = ANY(${ids}::uuid[]) AND "creator_session_id" IS NOT NULL`;
  return orderedIds(rows.map((r) => r.creatorSessionId));
}
