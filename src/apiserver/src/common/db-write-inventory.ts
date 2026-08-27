/**
 * Every place the API server writes to PostgreSQL, and what each one does about a database
 * conflict.
 *
 * WHY A LIST AND NOT A RULE
 * -------------------------
 * "Retry a transaction the server threw away" is one sentence, and it is not enough on its own:
 * whether re-running a unit of work is CORRECT depends on what else that unit did, what identity
 * makes a re-run the same request rather than a second one, and whether anything outside the
 * database was already told the first attempt happened. Those answers cannot be derived from the
 * code's shape — they have to be stated. So they are stated here, once per write, and
 * `db-write-inventory.spec.ts` re-scans the tree and fails when a write appears, moves or vanishes
 * without its entry moving with it. A new `$transaction` cannot be merged without saying what it
 * does about 40P01; a new autocommit statement cannot be merged without naming which of the five
 * classes below it belongs to.
 *
 * THE THREE SHAPES
 * ----------------
 *  - **A unit of work** (`TRANSACTION_UNITS`) owns a transaction. This is where the retry decision
 *    lives, because a transaction is the only thing that can be re-run: PostgreSQL aborts a
 *    deadlock victim whole, so nothing it wrote is visible and nothing it read can be trusted.
 *  - **A participant** (`TRANSACTION_PARTICIPANTS`) writes only through a transaction client its
 *    caller hands it. It has no boundary of its own, so it has no retry decision of its own — it
 *    is re-run when its owner is, and its lock order is its owner's.
 * The array form of `$transaction` has no production call site left. Three had one — the two
 * reorders and the session re-tag — and all three became callbacks, because an array is a batch
 * the caller cannot re-run: `withTransactionRetry` needs a closure to call again, and a list of
 * already-started promises is not one. The array form is still a shape a conflict can ARRIVE in,
 * which is why `transient-db-conflict.spec.ts` keeps testing the boundary against it.
 *
 *  - **A statement** (`STATEMENT_UNITS`) runs outside any transaction. PostgreSQL wraps each one
 *    in an implicit transaction of exactly one statement, so there is no closure to re-run and no
 *    unit of work to re-derive. These are NOT retried, deliberately; the argument is per class in
 *    `STATEMENT_CLASSES`, and the answer when one of them does lose a conflict is the global
 *    boundary's typed 503 (`transient-db-conflict.filter.ts`).
 *
 * WHAT "RETRIED" BUYS AND WHAT IT COSTS
 * -------------------------------------
 * Retrying is not free correctness. A unit is only safe to re-run when everything a second run
 * must NOT re-derive already sits outside the closure — an idempotency key, a request id, a
 * validated batch — and everything it MUST re-derive is read inside it, under the locks it takes.
 * `identity` is the first half of that claim and `replay` is the second. `effects` is the third
 * thing that decides it: an external action inside a retried closure would happen once per
 * attempt, which is why every one of them in this codebase sits after the commit, and why the
 * spec asserts that mechanically rather than trusting this sentence. The API server sends no mail,
 * so the external actions this has to account for are the realtime publishes, the APNs push and
 * the nudges to a runner — the spec's pattern names all three plus a bare `fetch`.
 *
 * ISOLATION
 * ---------
 * The deployment default is READ COMMITTED, so `isolation` is blank except where a unit asks for
 * something else. The three that ask for REPEATABLE READ are the ones that can take a 40001 at all
 * — under READ COMMITTED the only transient conflict PostgreSQL produces here is 40P01.
 */

/** How a write reaches the database. */
export type WriteShape =
  /** Owns a transaction, run through `withTransactionRetry`. */
  | 'TX_RETRIED'
  /** Owns a transaction and is deliberately NOT retried — `why` says so. */
  | 'TX_BARE'
  /** Writes only through a transaction client its caller owns. */
  | 'INHERITED'
  /** One or more statements, each its own implicit transaction. */
  | 'AUTOCOMMIT';

export interface TransactionUnit {
  /** `<path under src/apiserver/src>#<method>`. */
  at: string;
  shape: 'TX_RETRIED' | 'TX_BARE';
  /**
   * The locks it takes, in the order it takes them, counting the ones no statement spells:
   * foreign-key re-checks and trigger-taken rows (`common/lock-order.ts`,
   * `docs/postgres-lock-order.md`).
   */
  locks: string;
  /** What makes a re-run the same unit of work rather than a second one. */
  identity: string;
  /** Blank for the deployment default, READ COMMITTED. */
  isolation: string;
  /**
   * Total attempts including the first — `DEFAULT_TRANSACTION_MAX_ATTEMPTS` unless the unit asked
   * for something else, which only the two long cascades do. Declared rather than derived so the
   * exhaustion test knows how many conflicts it takes to reach the 503.
   */
  attempts: number;
  /** Why re-running the whole closure reaches the same answer. */
  replay: string;
  /** Everything outside the database this method does, and where it sits relative to commit. */
  effects: string;
  /** What the caller gets when a conflict outlives the attempts. */
  answer: string;
}

/**
 * Every transaction boundary in the API server.
 *
 * All of them are retried. That is not a coincidence and not a policy applied without looking: a
 * transaction boundary in this codebase exists to make several database statements atomic, and
 * none of them does anything else — the spec proves the "anything else" half by scanning every
 * closure for an external call. A unit that could not be re-run would appear here as `TX_BARE`
 * with the reason in `replay`; there is currently none.
 */
export const TRANSACTION_UNITS: readonly TransactionUnit[] = [
  {
    at: 'projects/attempt-ended-unsettled.producer.ts#raiseHumanSignal',
    shape: 'TX_RETRIED',
    locks: 'An unlocked task read discovers the owner, then user FOR UPDATE (rank 10, the owner graph mutex), project FOR NO KEY UPDATE (rank 40, project tasks only), task FOR NO KEY UPDATE (rank 50), then project_blocker and task_comment (rank 60). The authoritative task/path read is after every lock; both branches only descend.',
    identity: 'The open episode key `HUMAN_DECISION_REQUIRED:TASK_NO_JUDGMENT:<taskId>` for project tasks, enforced by the partial unique blocker index. A project-less task uses the hidden signal marker in its append-only comment under the owner/task locks. Both collapse a redelivery of the same missing-path condition.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks and re-reads the task, L0 declaration and live L1 verifier inside the closure. If another path or settlement won, it writes nothing. Otherwise ON CONFLICT chooses the one open blocker and only that INSERT winner writes the paired comment; a rolled-back attempt leaves neither.',
    effects: 'None inside. The blocker and its readable task comment are database rows committed atomically; logging happens only after this method returns.',
    answer: 'The post-commit caller logs the exhausted conflict and leaves the source Session/Task facts derivable for startup or explicit redelivery; an API caller still receives the global typed 503.',
  },
  {
    at: 'projects/coordinator-convergence.service.ts#judge',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_blocker and project_convergence_decision (rank 60). Monotone, and nothing above the project is reached for: the measurement reads `task`, `task_verification_finding`, `project_acceptance_*` and `project_blocker` without locking any of them, because the only writer it has to be serialised against is another judgment of the same project — which is holding the same project row.',
    identity: 'The FACT, above the closure: `wakeConvergenceKey(projectId, scopeHash, wake.idempotencyKey)`, where the wake key is T2\'s identity of the committed fact. A re-run re-derives the same key from the same fact, reads the committed judgment and writes nothing — which is what stops a redelivery from charging the convergence budget twice, and what stops it from raising a second blocker.',
    isolation: '',
    attempts: 4,
    replay: 'Everything the judgment is a function of is read inside the closure under the project row lock: the resolved thresholds, the last committed decision (counters, previous vector, previous outcome) and the four evidence projections. `planWakeConvergence` is pure and reads no clock, so a re-run against the same committed world plans the same decision; a re-run against a world that moved plans the newer one, which is the answer that should be committed.',
    effects: 'None inside. The blocker INSERT and the ledger INSERT are both database writes, and neither is visible outside the transaction until it commits.',
    answer: 'Typed 503 from the global boundary. A wake that could not be judged is not a wake that was allowed: T2 releases the key on a throw, so the fact stays deliverable and the next pass judges it.',
  },
  {
    at: 'projects/convergence-ledger.service.ts#reviseScope',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50) through `lockAndRead`, and nothing above it — a scope revision writes the revision row and the task, never the project.',
    identity: 'The proposal, above the closure: `planScopeRevision` derives the next revision number and the scope hash from the row it just locked, so the revision a re-run writes is the one the winner left plus one, never the one this attempt first computed.',
    isolation: '',
    attempts: 4,
    replay: 'The whole plan is re-derived inside the closure from the locked task — the current revision, the policy, the authority check. Its two writes are ordered so the revision row exists before the update it authorises, and a victim leaves neither, so a re-run never finds a revision claiming to have authorised an update that was rolled back.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary; a refused revision is already a 409 with its own sentence.',
  },
  {
    at: 'projects/project-handoff.service.ts#declare',
    shape: 'TX_RETRIED',
    locks: 'user FOR KEY SHARE (rank 10, the mode the insert own FK takes), the declaring session FOR SHARE (30), both project rows FOR NO KEY UPDATE (40, sorted), the tasks the declaration names FOR SHARE (50, sorted), then project_handoff_approval (60).',
    identity: '(owner, crossing key) — the crossing itself: both ends, the kind, the subject and the digest of the whole request identity including where the work was noticed. A duplicate declaration, two concurrent ones, one out of order and one retried after a timeout all reach the same row.',
    isolation: '',
    attempts: 4,
    replay: 'Everything is derived inside the closure from rows read under those locks — who is asking, which project they hold, the coordinator generation, both statuses and both policies — so a re-run decides against the state the winner left. The insert is ON CONFLICT DO NOTHING plus a verified read-back, so a loser returns the answer that now stands rather than its own intended one.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary; a refused declaration is already a 403/409 with its own code.',
  },
  {
    at: 'projects/projects.service.ts#panoramaReady',
    shape: 'TX_RETRIED',
    locks: 'No row locks. The transaction exists only to keep `SET LOCAL jit = off` on the same connection and transaction as the read-only ready-to-run query.',
    identity: 'The owner id, project id and validated limit, all arguments fixed before the closure.',
    isolation: '',
    attempts: 4,
    replay: 'Both statements are read-only with respect to application data. Every attempt reapplies the transaction-local JIT setting and recomputes the ready set from the fresh READ COMMITTED snapshot; an aborted attempt leaves no row or session setting behind.',
    effects: 'None.',
    answer: 'Typed 503 from the global boundary if a transient database conflict outlives the attempts.',
  },
  {
    at: 'projects/project-acceptance.service.ts#openRun',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_runtime / project_acceptance_run / _criterion child rows (rank 60).',
    identity: 'The project and its open run. A second run cannot be opened while one is open — the locked read decides that, not the caller.',
    isolation: '',
    attempts: 4,
    replay: 'The open run, the runtime row and the criteria are all read under the project lock inside the closure, so a re-run opens against the state the winner left. A victim opened nothing.',
    effects: 'None. The gate result is returned and acted on by the caller after this resolves.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/project-acceptance.service.ts#confirmCriteriaSet',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_acceptance_criteria_confirmation (rank 60). The optional acting Session provenance read happens before this transaction and takes no lock.',
    identity: 'The exact current standard-set fact: UNIQUE(project_id, criteria_digest). A duplicate request returns the existing append-only confirmation instead of inventing a second event.',
    isolation: '',
    attempts: 4,
    replay: 'The digest is read from the project row after locking it inside every attempt. A retry therefore confirms the standard set the winner left, and the unique-key read/create sequence is serialized by that same project lock.',
    effects: 'None inside. Reconciliation is invoked only after the confirmation transaction resolves.',
    answer: 'Typed 503 from the global boundary; a judgment-session refusal is decided before the transaction and remains a 403 with PROJECT_CRITERIA_CONFIRMATION_HUMAN_ONLY.',
  },
  {
    at: 'projects/project-acceptance.service.ts#reconcile',
    shape: 'TX_RETRIED',
    locks: 'project FOR UPDATE (rank 40), then reads evidence Task rows (rank 50) and writes project_acceptance_run / _criterion / _conclusion / _audit children (rank 60). The final project DONE write is against the rank-40 row already held.',
    identity: 'The locked project plus its current criteria digest and durable evidence versions. Automatic conclusion events are omitted when the same evidence source already stands; DONE binds the one current acceptance run.',
    isolation: '',
    attempts: 4,
    replay: 'Every declaration, confirmation, evidence result and current conclusion is re-read inside the closure after the project lock. A victim exposes no event or DONE; a retry derives against the committed winner and either emits only newer facts or returns the standing answer.',
    effects: 'None.',
    answer: 'Typed 503 from the global boundary. Ordinary unmet gates are returned as their typed acceptance refusal code, not retried or surfaced as an infrastructure failure.',
  },
  {
    at: 'projects/project-acceptance.service.ts#finalizeRun',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_acceptance_criterion and project_acceptance_run (rank 60).',
    identity: 'The run id being finalized; the UPDATE is conditional on it still being open.',
    isolation: '',
    attempts: 4,
    replay: 'The verdict is recomputed inside the closure from criteria read under the project lock, so a re-run recomputes rather than replaying a verdict derived from a snapshot the server discarded.',
    effects: 'None.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/project-acceptance.service.ts#recordMergeEvidence',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_merge_evidence (rank 60).',
    identity: 'The merge the evidence is about — the row is found-or-created by it, so a re-run writes the same row.',
    isolation: '',
    attempts: 4,
    replay: 'Find-or-create under the project lock: idempotent by construction.',
    effects: 'None.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/project-acceptance.service.ts#evaluateGate',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40) and the task rows it reads under it (rank 50).',
    identity: 'None needed — the gate reads and decides; what it writes is the verdict for the run it locked.',
    isolation: '',
    attempts: 4,
    replay: 'Everything is read inside the closure under the project lock.',
    effects: 'None.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/projects.service.ts#create',
    shape: 'TX_RETRIED',
    locks: 'When seeded from a Session: owner FOR KEY SHARE (rank 10), live coordinator workspace FOR SHARE (rank 15), that Session UPDATE (rank 30), then the new Project INSERT (rank 40) and its nested runtime/member children (rank 60). Headless creation remains one autocommit INSERT and takes no existing Project row lock.',
    identity: 'The owner, DTO and server-derived coordinator Session/workspace seed. A retry may receive a fresh database-default Project id, but no id has escaped before the transaction commits.',
    isolation: '',
    attempts: 4,
    replay: 'The previous Session title is captured by the conditional UPDATE inside every attempt, and the Project plus binding is inserted afterwards in that same attempt. An aborted attempt exposes neither the rename nor a Project row.',
    effects: 'None inside. The session.updated nudge is published only after the transaction resolves.',
    answer: 'Typed 503 from the global boundary; coordinator uniqueness remains the explicit 409.',
  },
  {
    at: 'projects/projects.service.ts#update',
    shape: 'TX_RETRIED',
    locks: 'For a title write with a bound coordinator: that Session FOR UPDATE first (rank 30), then project FOR NO KEY UPDATE (rank 40). Every path then takes project_acceptance_criterion_definition / project_acceptance_run children (rank 60) as needed and writes only rows it already holds. Direct DONE is refused before this boundary; automatic reconciliation owns the exclusive settlement lock. A pointer that changed between the rank-30 pre-read and rank-40 validation aborts and retries with the new Session.',
    identity: 'The project id and the DTO, both outside the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The row is re-read under its own lock and every derived decision — acceptance recompute, coordinator rebind and managed title sync — comes from that read. Pointer drift is retried from a fresh pre-read rather than locking downward.',
    effects: 'None inside; the control-plane publish is after this resolves.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/projects.service.ts#coordinator',
    shape: 'TX_RETRIED',
    locks: 'After the candidate Session is created, its landing workspace FOR SHARE (rank 15), candidate and previous Session rows FOR UPDATE in UUID order (rank 30), then Project FOR NO KEY UPDATE (rank 40), followed by writes only to those held rows.',
    identity: 'The candidate Session id and the coordinator pointer observed before creating it. The compare-and-swap decides whether that candidate won.',
    isolation: '',
    attempts: 4,
    replay: 'Only the short binding CAS is retried, always against the same already-created candidate. The locked Project is re-read for its current pointer and title; a loser writes no title ownership and is discarded by the caller.',
    effects: 'Session creation is before the transaction and never replayed by it. Discard/publish are after it resolves.',
    answer: 'Typed 503 from the global boundary; a lost CAS adopts the winner or returns the existing 409 contract.',
  },
  {
    at: 'sessions/sessions.service.ts#releaseProjectTitleManagement',
    shape: 'TX_RETRIED',
    locks: 'The former coordinator Session FOR UPDATE (rank 30), then a non-locking Project adoption check and a write only of the held Session row.',
    identity: 'Owner and former coordinator Session id captured before Project deletion.',
    isolation: '',
    attempts: 4,
    replay: 'After any waited-for adopter commits, the Project check runs as a second READ COMMITTED statement and sees the new binding. No binding means the managed-title bit is cleared idempotently.',
    effects: 'None. The delete caller publishes relation metadata separately and treats this post-delete provenance cleanup as best effort.',
    answer: 'The delete has already committed, so its caller logs exhaustion and still returns success.',
  },
  {
    at: 'projects/projects.service.ts#rebindCoordinator',
    shape: 'TX_RETRIED',
    locks: 'the target workspace FOR SHARE (rank 15, taken FIRST so the pair is never locked upward), then project FOR NO KEY UPDATE (rank 40), then the one UPDATE of that same row — whose BEFORE guard re-reads the bound session without locking it, and whose deferred companion trigger re-takes both rows this transaction already holds.',
    identity: 'The project id and the landing, both arguments, both outside the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The pointer and the landing are re-read under the row lock on every attempt, and the write is skipped outright when the project already sits at the landing — so a re-run of a rebind that committed is the no-op branch rather than a second move.',
    effects: 'None.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/projects.service.ts#remove',
    shape: 'TX_RETRIED',
    locks: 'project FOR UPDATE (rank 40), then the DELETE and its cascades (rank 40/60).',
    identity: 'The project id.',
    isolation: '',
    attempts: 4,
    replay: 'The row is re-read under its lock; deleting something already gone is the same answer on any attempt.',
    effects: 'None inside. After commit, the former coordinator Session conditionally clears its internal managed-title bit if no new Project has adopted it.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/session-attempt.service.ts#open',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50) through the ledger `record` this calls first, then the attempt row it inserts.',
    identity: "`attemptKey` — the durable identity of the DISPATCH, handed in from above. GN1 is what makes a re-run the same unit: the closure looks the key up first and returns the row it already committed rather than opening a second generation.",
    isolation: '',
    attempts: 4,
    replay: 'Everything the admission decides is re-read inside the closure — the existing attempt for this key, the previous attempt, the generation the ledger just allocated — so a re-run judges the state the winner left. The generation comes from `record`, which is inside, so a retry cannot reuse one a victim allocated.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary; a refused attempt is already a 409.',
  },
  {
    at: 'projects/session-attempt.service.ts#evaluate',
    shape: 'TX_RETRIED',
    locks: 'task_attempt FOR UPDATE, and nothing else — this measures one attempt and writes only its own row.',
    identity: 'The session id and the instant being measured, both above the closure, so every attempt measures the same `now` rather than a clock that moved between them.',
    isolation: '',
    attempts: 4,
    replay: 'The spend is re-measured from the locked row on every attempt and the wind-down is asked for only when the row does not already record one, so a re-run cannot ask twice or report a dimension the winner already crossed. A closed attempt short-circuits to what it was measured at, which a retry cannot change.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/session-attempt.service.ts#close',
    shape: 'TX_RETRIED',
    locks: 'task_attempt FOR UPDATE, then the task row when a checkpoint promotes `known_good_sha` — attempt before task, which is the order this closure takes them in every branch.',
    identity: 'The session id and the close it is recording, above the closure. `planAttemptClose` refuses a second close of an already-CLOSED attempt, so a replay of a committed close is a 409 rather than a second outcome.',
    isolation: '',
    attempts: 4,
    replay: "The attempt's current status and wind-down state are re-read under the lock and the close is re-planned against them, so a re-run either writes the same outcome or is refused by the same rule. The `known_good_sha` promotion is in the same transaction as the row that establishes it, so a victim leaves neither.",
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary; an illegal close is already a 409.',
  },
  {
    at: 'projects/task-checkpoint.service.ts#record',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50) through the ledger `lockAndRead` this takes first — the same lock a judgment and a finding take, so a checkpoint can never interleave with a judgment about the task it belongs to. Then `task_checkpoint` INSERT, whose `seq` is allocated MAX + 1 under that lock.',
    identity: "§7 CP1's content key: the kind, the commit, the tree, the base, the evidence digest and the artifact, hashed. Derived inside the closure from the task's CURRENT scope revision, which is read under the lock — a re-run that read a moved revision must refuse rather than record against the old one.",
    isolation: '',
    attempts: 4,
    replay: 'The content key is looked up before the insert, so a redelivery, a takeover or a retry after a lost response returns the committed row having written nothing. `seq` is re-allocated from MAX + 1 under the lock, so a re-run cannot reuse a number the winner took.',
    effects: 'None inside.',
    answer: "Typed 503 from the global boundary; a duplicate is not an error — it comes back as the original checkpoint with `duplicate: true`, and an illegal shape comes back as one of §7's record refusals.",
  },
  {
    at: 'queue/queue.service.ts#trySessionClaim',
    shape: 'TX_RETRIED',
    locks: 'pg_advisory_xact_lock (the claim serializer), then session FOR UPDATE NOWAIT (rank 30).',
    identity: 'The runner asking, and the session the claim lands on. A claim is a compare-and-set.',
    isolation: '',
    attempts: 4,
    replay: 'An attempt the server discarded claimed nothing, so a re-run competes from the real state. The advisory lock is transaction-scoped, so it is released with the aborted attempt.',
    effects: 'None inside. After the claim commits, session.updated is published before buildSession hydration so clients observe PENDING → RUNNING even if hydration fails.',
    answer: 'Typed 503; the runner polls again.',
  },
  {
    at: 'queue/queue.service.ts#buildSession',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then conversation_turn / attachment / session writes (rank 30/60).',
    identity: "The session row's own id, allocated before the closure.",
    isolation: '',
    attempts: 4,
    replay: 'The row an aborted attempt inserted does not exist, so a re-run inserts one session rather than a second, and the capacity fence is re-evaluated inside the closure.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'realtime/reaper.service.ts#forceFinalize',
    shape: 'TX_RETRIED',
    locks: 'session (rank 30) and its conversation_turn rows (rank 60), both by conditional UPDATE.',
    identity: 'The session id and the status it is being moved out of — the UPDATE is conditional on it.',
    isolation: '',
    attempts: 4,
    replay: 'A re-run either finds the same stalled run or finds that somebody finished it first, which is already an outcome this handles.',
    effects: 'None inside; the notification is after.',
    answer: 'Typed 503; the sweep runs again on its next tick.',
  },
  {
    at: 'realtime/reaper.service.ts#endParked',
    shape: 'TX_RETRIED',
    locks: 'Same as forceFinalize.',
    identity: 'Same as forceFinalize.',
    isolation: '',
    attempts: 4,
    replay: 'Same as forceFinalize.',
    effects: 'None inside.',
    answer: 'Typed 503; the sweep runs again.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#takeoverLeases',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then inbox_lease_generation and conversation_turn (rank 60). No task or workspace lock — one write of the Session row (lock-order.ts, I3).',
    identity: 'The lease generation in the request body, parsed above the closure.',
    isolation: '',
    attempts: 4,
    replay: "The ownership fence is re-read under the row lock on each attempt, so a re-run judges the state the winner left rather than replaying a takeover decided against a discarded snapshot.",
    effects: 'None inside.',
    answer: 'Typed 503; the runner retries its handshake.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#activateLeases',
    shape: 'TX_RETRIED',
    locks: 'Same as takeoverLeases.',
    identity: 'Same as takeoverLeases.',
    isolation: '',
    attempts: 4,
    replay: 'Same as takeoverLeases.',
    effects: 'None inside.',
    answer: 'Typed 503; the runner retries.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#releaseLeases',
    shape: 'TX_RETRIED',
    locks: 'Same as takeoverLeases.',
    identity: 'The generation being released.',
    isolation: '',
    attempts: 4,
    replay: 'A release is idempotent: a re-run against a fresh snapshot either clears the ownership or finds it already clear.',
    effects: 'None inside.',
    answer: 'Typed 503; the runner retries, and the reaper releases an abandoned lease anyway.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#dequeueTurn',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then conversation_turn FOR UPDATE SKIP LOCKED and the claim UPDATE (rank 60).',
    identity: 'The runner and lease generation asking; the claimed turn is chosen inside.',
    isolation: '',
    attempts: 4,
    replay: "A deadlock victim's claim never happened — the row is still queued — so a re-run claims from the state that exists rather than reporting a turn it does not own.",
    effects: 'None. Nothing is sent to the runner until this returns.',
    answer: 'Typed 503; the runner polls again and the turn is still queued.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#turnComplete',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE via lockSessionLeaseOwner (rank 30); for an executable judgment result, its project FOR NO KEY UPDATE (rank 40) then task FOR UPDATE (rank 50); conversation_turn ACK, task_executable_judgment_result, task_judgment_request and legacy blocker/comment children (rank 60), then the database-maintained task dispatch epoch (rank 70). Later llm_usage and session_diff writes add no wait edge because their Session parent is already held. One write of the Session row per transaction (I3).',
    identity: 'The turn id, usage and shell result in the request body are outside the closure. The OPEN request is already uniquely bound to criterion revision and evidence digest; its executable result is unique by request. A queued acceptance turn also binds its command in content and expected exit code in client_turn_id, so a retry compares the same evidence rather than a declaration edited while it ran. A non-comparable result is owned by that same turn ACK and leaves one append-only unavailable signal.',
    isolation: '',
    attempts: 4,
    replay: 'The duplicate-ack check, park, merge-state clear and billing accrual are all taken from rows read under their locks inside the closure. The command result, request decision, derived task status and raw-output comment — or the mutually exclusive unavailable signal — are written only by the same first ACK; a victim leaves all of them absent, and a retry re-locks the current declaration/request before deriving anything.',
    effects: 'None inside; attempt-budget accounting, EXECUTABLE_RESULT_RECORDED consumption and realtime publication are after commit. The input route is replayed even for a duplicate ACK so an authorization refusal does not burn the immutable result fact.',
    answer: 'Typed 503; the runner re-posts the completion, which the duplicate-ack check absorbs.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#events',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE via lockSessionLeaseOwner (rank 30), then run_event / tool_call child rows (rank 60), then ONE session UPDATE (I3).',
    identity: 'The batch itself: `run_event` is unique on `(sessionId, seq)` with skipDuplicates, tool_call outcomes are keyed by tool_use id, and the running sets are set-valued.',
    isolation: '',
    attempts: 4,
    replay: 'Every write in it is already idempotent, `durable` and `events` are derived from the request body above the closure, and the single Session write is accumulated from a row re-read under its lock on every attempt.',
    effects: 'The live broadcast, outside the loop — so a retried batch is published once, after the attempt that committed.',
    answer: 'Typed 503; the runner re-sends the batch, which is idempotent.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#finalize',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE via lockSessionLeaseOwner (rank 30), then session_diff and conversation_turn (rank 60).',
    identity: 'The lease owner and the terminal status in the request.',
    isolation: '',
    attempts: 4,
    replay: 'One locked re-read decides the final status and the checkout lifetime. A session another writer finalized first is seen as finalized, which is an answer this already gives.',
    effects: 'None inside.',
    answer: 'Typed 503; the runner re-posts.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#mergeResult',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the session row writes (rank 30).',
    identity: 'The worktree-operation id the runner echoes back.',
    isolation: '',
    attempts: 4,
    replay: 'The claim is re-read under the row lock, so a re-run either still owns the operation it is reporting on or finds it reclaimed — the same two outcomes a first attempt has.',
    effects: 'None inside; the receipt publish is after.',
    answer: 'Typed 503; the runner re-posts the result.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#commitResult',
    shape: 'TX_RETRIED',
    locks: 'Same as mergeResult.',
    identity: 'Same as mergeResult.',
    isolation: '',
    attempts: 4,
    replay: 'Same as mergeResult.',
    effects: 'None inside.',
    answer: 'Typed 503; the runner re-posts.',
  },
  {
    at: 'runners/runners.service.ts#reorderRunners',
    shape: 'TX_RETRIED',
    locks: 'runner rows, one UPDATE each, IN ID ORDER — which is what stops two opposite drags taking them backwards.',
    identity: '`ranked` is computed above the closure, so every attempt writes the same positions to the same rows.',
    isolation: '',
    attempts: 4,
    replay: 'Idempotent by construction: the same array written again produces the same order.',
    effects: 'None inside.',
    answer: 'Typed 503; the client re-sends the order.',
  },
  {
    at: 'session-tags/session-tags.service.ts#setForSession',
    shape: 'TX_RETRIED',
    locks: 'session_tag_link rows for this session, then session_tag FOR KEY SHARE through the link FK — the inserts are ordered by tag id.',
    identity: '`linkIds`, computed and sorted above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'Delete-then-insert of the same set, so a re-run rewrites the same links.',
    effects: 'None inside; the session-updated publish is after.',
    answer: 'Typed 503; the picker re-sends its selection.',
  },
  {
    at: 'sessions/merge-receipt.service.ts#record',
    shape: 'TX_RETRIED',
    locks: 'session_merge_receipt insert, then the session row denormalisation (rank 30).',
    identity: '`idempotencyKey`, computed above the closure, so every attempt writes the same receipt.',
    isolation: '',
    attempts: 4,
    replay: 'Only the branch that OWNS the transaction is retried. When a caller passes `tx` this is part of THEIR unit and theirs to re-run; a nested retry would re-run a closure inside a transaction the server has already discarded.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'sessions/sessions.service.ts#insertTurn',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the conversation_turn insert (rank 60).',
    identity: "The caller's `clientTurnId`, passed in.",
    isolation: '',
    attempts: 4,
    replay: 'The seq is allocated from a row read under the Session lock inside the closure, so a re-run allocates from the sequence the winner left rather than reusing a number a discarded snapshot suggested.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'sessions/sessions.service.ts#createTurn',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30) — deliberately blocking, because this is where a user turn serializes against the claim and against turnComplete — then conversation_turn (rank 60).',
    identity: "The caller's `clientTurnId` and message, both above the closure.",
    isolation: '',
    attempts: 4,
    replay: 'A victim wrote no turn, so a re-run enqueues once. Every lifecycle decision is taken from the Session row read under the lock inside the closure.',
    effects: 'The delivery notice to the runner, outside the loop and after commit.',
    answer: 'Typed 503; the client re-sends, and the client turn id keeps that from doubling.',
  },
  {
    at: 'sessions/sessions.service.ts#interrupt',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then conversation_turn deletes and the session write.',
    identity: 'The session id.',
    isolation: '',
    attempts: 4,
    replay: 'Decided from the Session row re-read under its lock.',
    effects: 'None inside; the runner is told after commit.',
    answer: 'Typed 503; the client re-presses.',
  },
  {
    at: 'sessions/sessions.service.ts#cancelQueuedTurn',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the conversation_turn delete.',
    identity: 'The turn id being cancelled.',
    isolation: '',
    attempts: 4,
    replay: 'A compare-and-set against a turn still queued: an attempt the server discarded cancelled nothing, so a re-run either still finds it queued or reports the same "already gone".',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'sessions/sessions.service.ts#mergeToMain',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the session and workspace writes.',
    identity: 'The worktree-operation id minted for this request.',
    isolation: '',
    attempts: 4,
    replay: 'The claim is taken under the Session row lock inside the closure, so a re-run competes for it from the state that exists.',
    effects: 'The runner is only told about the operation after this returns.',
    answer: 'Typed 503; the button can be pressed again.',
  },
  {
    at: 'sessions/sessions.service.ts#adoptWorktreeBranch',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the session write.',
    identity: 'The branch being adopted.',
    isolation: '',
    attempts: 4,
    replay: 'One locked re-read decides whether the branch may be re-pointed.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'sessions/sessions.service.ts#transitionEnd',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), optionally a non-locking Project adoption check for provisional coordinator discard, then conversation_turn and the session writes.',
    identity: 'The end reason and the status being left.',
    isolation: '',
    attempts: 4,
    replay: 'Every terminal transition is decided from the Session row under its lock, so a re-run sees whichever end actually committed rather than re-applying one that did not. Candidate discard also re-checks adoption after that lock; every binder takes the same lock before Project, so it either preserves the winner or atomically clears ownership and files the unbound loser in Trash.',
    effects: 'None inside; notification and publish are after.',
    answer: 'Typed 503; the reaper force-finalizes an end nobody honoured.',
  },
  {
    at: 'sessions/sessions.service.ts#resume',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), task FOR SHARE NOWAIT (rank 50), session FOR UPDATE NOWAIT (rank 30 taken last, NOWAIT, which is the declared way this path declines to wait rather than close a cycle).',
    identity: 'The session id and the prompt, both above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The session, its project capacity and its worktree state are all read under locks taken inside the closure and written from that read.',
    effects: 'The runner is notified after this returns.',
    answer: 'Typed 503; the resume can be re-issued.',
  },
  {
    at: 'sessions/sessions.service.ts#updateConfig',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the session write.',
    identity: 'The config DTO, above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'A locked re-read decides what the new config may be.',
    effects: 'The reload nudge, once, after commit.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'sessions/sessions.service.ts#restore',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the session write.',
    identity: 'The session id.',
    isolation: '',
    attempts: 4,
    replay: 'Restoring something already restored is the same answer on any attempt.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'sessions/sessions.service.ts#purge',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the DELETE and its cascades.',
    identity: 'The session id.',
    isolation: '',
    attempts: 4,
    replay: 'Decided from a locked re-read; a purge of something already purged is the same answer.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'task-lists/task-lists.service.ts#writePolicy',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10, I1 — a pause writes every Task in the list), task_list FOR UPDATE (rank 20), then task_list_revision and the task sweep (rank 50/60).',
    identity: 'The list id and the policy data, above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The revision number, the seeded before-state and the dispatchHold sweep are all derived inside the closure from rows read under the two locks.',
    effects: 'None inside; the list-changed publish is after.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'task-lists/task-lists.service.ts#remove',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10), then the multi-row task disarm and the list DELETE whose cascade nulls Task.listId (rank 50/20).',
    identity: 'The list id.',
    isolation: '',
    attempts: 2,
    replay: 'Two statements over rows selected by the list id; a re-run disarms and deletes the same set.',
    effects: 'The in-flight run teardown, deliberately OUTSIDE the loop and outside the transaction — it talks to runners, and a retry must not send a second cancel.',
    answer: 'Typed 503. Capped at 2 attempts with a 60s per-attempt deadline: a cascade this size should absorb one collision, not spend four deadlines on the same one.',
  },
  {
    at: 'tasks/task-completion-evidence.service.ts#submit',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50), then task_completion_evidence, task_completion_evidence_idempotency, task_judgment_request, its trigger-filed task_judgment_inbox_item / task_judgment_push_delivery children and optional legacy project_blocker children (rank 60). Superseding an older request updates only that older delivery child. The Session and optional TaskAttempt provenance reads take no row lock and no FK is written to either snapshot id. A DONE task uses the same rank-60 request update to close every OPEN question under TASK_ALREADY_DONE.',
    identity: 'The evidence uses the caller idempotency key when supplied, otherwise the stable tuple (task, actor type/id, source Session, criterion revision, evidence digest). The request uses (task, criterion revision, evidence digest, request kind). All are unique in PostgreSQL, and the task mutex makes a concurrent new digest supersede the old OPEN request exactly once.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the Task, verifies the source Session belongs to it, derives the criterion snapshot, allocates MAX(revision)+1 and routes the request inside the closure. A committed retry key returns its original evidence/request even if criteria later changed; an older fact is never reopened or allowed to supersede the current request. If the locked Task is DONE, both a new fact and an exact replay converge every OPEN request to the audited no-successor terminal rule.',
    effects: 'None outside PostgreSQL inside. The transaction never updates Task/Session lifecycle state, comments, notifications or realtime; a HUMAN_SIGNOFF request insert trigger files its inbox item and device outbox in this same transaction but performs no push. After commit the evidence revision is consumed by the request derivation route, HUMAN_SIGNOFF request/supersession facts feed HUMAN_INBOX and nudge the durable delivery worker when needed, and only VERIFICATION is handed to the deterministic verifier-task upsert/dispatch. Replay converges on the same fact keys and request/task or request/version ledger key.',
    answer: 'Typed 503 from the global boundary after retry exhaustion; reused keys with different facts are an explicit 409.',
  },
  {
    at: 'tasks/task-completion-evidence.service.ts#reconcileSatisfiedJudgmentRequest',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50), then the exact task_judgment_request and its trigger-maintained delivery child at rank 60. The source Session/workspace provenance read takes no row lock and is stored as an immutable snapshot.',
    identity: 'The exact owner, task, request and source Session supplied to the explicit operator door. Only OPEN on a currently DONE Task may move; replay of that same TASK_ALREADY_DONE conclusion returns it.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks and re-checks Task.status, request ownership/status and source Session ownership, then delegates the transition to the same supersedeOpenRequests helper used by evidence submission.',
    effects: 'None outside PostgreSQL. This path creates no evidence, signoff or successor and cannot decide a request; the request transition itself cancels retryable device delivery and removes the SQL-view blocker atomically.',
    answer: 'Typed 503 after retry exhaustion; wrong identity is 400/404, a non-DONE Task or differently terminal request is 409.',
  },
  {
    at: 'tasks/task-completion-evidence.service.ts#importLegacyComment',
    shape: 'TX_RETRIED',
    locks: 'user FOR KEY SHARE (rank 10, pre-acquired for the reviewer FK), task FOR UPDATE (rank 50), then task_completion_evidence / idempotency / task_legacy_evidence_import / task_judgment_request, the trigger-filed inbox/delivery rows and optional legacy project_blocker children (rank 60). The source TaskComment is read before its later FK check; source Session/Attempt are immutable provenance snapshots and are not referenced by a new FK.',
    identity: 'Both (task, source comment) and (task, caller idempotency key) are unique audit identities. The evidence stable-fact tuple and request fact tuple remain independently unique; source and structured SHA-256 digests bind the exact reviewed inputs.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the Task and re-reads the exact comment, source Session, current criterion and latest evidence revision. A committed exact replay returns the original import/evidence/request; reusing either source or key with changed actor, provenance, digest, review note or delivery policy is a 409.',
    effects: 'No comment parsing or external action occurs inside. The request trigger files inbox and delivery rows in the same transaction. After commit an explicitly IMMEDIATE human request only nudges the durable worker; IN_APP_ONLY has a terminal zero-attempt delivery row and causes no nudge.',
    answer: 'Typed 503 after retry exhaustion; invalid ownership/input is 400/404 and conflicting import identity is 409.',
  },
  {
    at: 'tasks/task-completion-evidence.service.ts#backfill',
    shape: 'TX_RETRIED',
    locks: 'the batch INSERT takes the owner User FK lock (rank 10), then the bounded candidate query locks Task rows in UUID order with FOR UPDATE SKIP LOCKED (rank 50), followed by request / trigger-filed inbox+delivery / optional legacy blocker children (rank 60). The completed batch counters are written after all children; no Task lifecycle row is updated.',
    identity: 'The owner-scoped idempotency key uniquely names a batch and its digest binds actor, size, fixed selection predicate and sorted device-push task allowlist. Each created request also has the ordinary unique evidence-fact identity.',
    isolation: '',
    attempts: 4,
    replay: 'A committed same-key invocation returns its immutable completed counters. An aborted attempt rolls back batch and requests together; its fixed batch UUID can be retried. A fresh-key rerun re-applies the missing-request predicate and therefore creates only facts still absent.',
    effects: 'No evidence or Task status is written and no APNs call occurs inside. Every request gets an inbox and delivery ledger row; non-allowlisted rows are terminal IN_APP_ONLY cancellations. After commit the worker is nudged once only when the batch selected at least one immediate push.',
    answer: 'Typed 503 after retry exhaustion; a changed replay is 409 and invalid size/ownership/allowlist is 400/404.',
  },
  {
    at: 'tasks/tasks.service.ts#create',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10, only when it links), task_list FOR KEY SHARE (20), the creator and predecessor Sessions FOR KEY SHARE (30), project FOR NO KEY UPDATE (40, only when it retires a predecessor), then the task INSERT and its edges (50/60).',
    identity: 'The idempotency key built from `(session, turn, title, description)` above the closure, so a retry re-inserts the same row rather than a second one.',
    isolation: '',
    attempts: 4,
    replay: 'Everything the closure decides is re-read under the locks it takes; `data` and its key are computed once, outside.',
    effects: 'The realtime publish, outside the loop, after the attempt that committed.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    // Unit L7 split the door from the pass: `createMany` (write) and `previewPlan` (dry run) both
    // call `createManyPass`, and only the first of those reaches the transaction below.
    at: 'tasks/tasks.service.ts#createManyPass',
    shape: 'TX_RETRIED',
    locks: 'Same ranks as create, taken unconditionally: a batch writes several task rows in item order, which is not an order any other writer shares.',
    identity: 'The per-item idempotency keys and the turn they are built from, all outside the closure; the find-or-create by key makes a half-committed attempt impossible to double up on.',
    isolation: '',
    attempts: 4,
    replay: '`idByRef` and `rows` are rebuilt per attempt because they name rows an aborted attempt no longer has; everything else is outside.',
    effects: 'One control-plane nudge per task, outside the loop.',
    answer: 'Typed 503 from the global boundary; a lost duplicate-key race is answered as the batch replay, not a retry.',
  },
  {
    at: 'tasks/tasks.service.ts#signoff',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10), project FOR NO KEY UPDATE when present (40), task FOR UPDATE (50), then the named task_judgment_request FOR UPDATE via the signoff guard, task_human_signoff INSERT, the request-terminal delivery-child update and legacy project_blocker resolution (60), followed by the status write on the task row already held and its task_dispatch_epoch trigger (70). Request/event/delivery/blocker facts precede status intentionally.',
    identity: 'The caller names the current request id and evidence digest. task_human_signoff is unique by task and request, while the server-created event UUID and signedAt are fixed above the closure; an authorised committed replay reads the original event, and any refusal/aborted attempt consumes neither identity.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks and re-reads the task criterion/status/request after the owner/project locks. Signoff creation, request decision, every legacy HUMAN_DECISION_REQUIRED resolution and the derived DONE update roll back together; a retry either performs all four or observes the already-committed event.',
    effects: 'None inside. HUMAN_SIGNOFF_DECIDED input consumption, dependency release, optional verification filing, aggregation and realtime publication all run after commit. No project task-set scan runs.',
    answer: 'Typed 503 from the global boundary; criterion, actor and retirement refusals have their own structured 400/403/409 responses.',
  },
  {
    at: 'tasks/tasks.service.ts#requestMoreEvidence',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50), then the named task_judgment_request FOR UPDATE and the request-terminal delivery-child update (rank 60). There is deliberately no Task status write and no project/blocker row write; both signal and blocker are read-only projections of the request.',
    identity: 'The current request id, its evidence digest and the terminal INCONCLUSIVE decision. A committed replay reads the first decision, time and note without rewriting them.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the Task and request, rechecks the HUMAN_SIGNOFF recipient/digest/current OPEN request, and either commits one INCONCLUSIVE audit or returns that exact audit. A superseding evidence submission takes the same Task mutex and therefore wins wholly before or after this decision.',
    effects: 'None inside. After commit, one task.changed publication makes task/project/inbox readers refetch the derived request/signal/blocker state.',
    answer: 'Typed 503 after retry exhaustion; stale, terminal, mismatched and retired facts are structured 409 responses.',
  },
  {
    at: 'tasks/tasks.service.ts#update',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (10, when it restructures), task_list (20), creator Session (30, when it writes the task row twice), a conservative project FOR NO KEY UPDATE pre-lock (40, retained in application code after the task-acceptance triggers were retired), then Task rows in UUID order (50; verifier plus subject for a verdict, with NOWAIT on supersession/move paths), followed by task_judgment_request / request-delivery / legacy blocker children (60) and the derived subject status trigger boundary (70).',
    identity: 'The task id and the DTO, above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The closure re-reads the task inside the owner mutex on every attempt — `current`, acceptance projects, hierarchy and edges are all derived there. A verifier verdict also re-locks both tasks and requires the request still OPEN before atomically recording the verdict decision and deriving the subject status. The single-statement branch is NOT retried: it owns no transaction.',
    effects: 'An evidence-bound verdict is delivered as VERIFICATION_VERDICT_RECORDED after commit; unchanged replay derives the same key. Aggregation/dependency and realtime publication are also after. No project task-set scan runs.',
    answer: 'Typed 503 from the global boundary, including for the one-statement branch.',
  },
  {
    at: 'sessions/sessions.service.ts#armAutoRetry',
    shape: 'TX_RETRIED',
    locks: "project FOR NO KEY UPDATE (40) when the session's task has one, then that task FOR UPDATE (50), then the CAS on the session row itself.",
    identity: 'The session id and the instant being armed, both above the closure.',
    isolation: '',
    attempts: 4,
    replay: "Everything it decides is re-read inside the closure — the session's task, that task's project, and the role the §13.1 AG6 refusal is judged against — so a re-run judges the state the winning transaction left rather than the one this attempt started from.",
    effects: 'None: the answer is the CAS count.',
    answer: 'Typed 503 from the global boundary; a refusal is already a 409 with its own sentence.',
  },
  {
    at: 'sessions/auto-retry.service.ts#underAggregateParentLock',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE NOWAIT (40), then task FOR UPDATE NOWAIT (50), then the session row — rank order, and every acquisition NOWAIT because this runs on a timer behind live requests and must never be the transaction anybody waits for.',
    identity: 'The task id, the session id and the expected parked state, all above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'Every fact the compare-and-set depends on is re-read inside the closure — the task\'s project, its shape, and the session\'s own task, role, status and claim — so a re-run judges the state the winner left. A NOWAIT refusal does not reach the loop: it is a `55P03`, which the classifier does not call transient, and it short-circuits to BUSY so the next tick looks again.',
    effects: 'The settle/disarm announcement, after the transaction.',
    answer: 'A `55P03`, and the transient verdict from `classifyTransactionError`, both read as BUSY: the retry stays armed. Nothing reaches a client — this is a background timer, not a request.',
  },
  {
    at: 'tasks/tasks.service.ts#applyDag',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10) and nothing else — since 0132 an edge write touches no task row. The revision row it advances is rank 70.',
    identity: '`ops` and the human-facing `preview`, computed above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The edge set is re-read under the owner mutex and re-checked for cycles, so a re-run judges the graph the winning transaction left.',
    effects: 'The publish and the ready-task reconcile, both outside the loop.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'tasks/tasks.service.ts#addDependency',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10), then the edge INSERT and the revision it advances (60/70).',
    identity: 'The edge itself — `(taskId, dependsOnTaskId)` is unique.',
    isolation: '',
    attempts: 4,
    replay: 'The cycle check re-reads the whole edge set under the owner mutex on every attempt. A duplicate edge arrives as P2002, which the classifier calls permanent and which is answered on the first attempt.',
    effects: 'The publish, after.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'tasks/tasks.service.ts#removeDependency',
    shape: 'TX_RETRIED',
    locks: 'Same as addDependency.',
    identity: 'The edge being removed.',
    isolation: '',
    attempts: 4,
    replay: 'Removing an edge that is already gone is the same answer either way.',
    effects: 'The publish, after.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'tasks/tasks.service.ts#batchAssign',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10, I1 — a multi-row task write), then the conditional updateMany over ids taken in sorted order.',
    identity: '`ids`, sorted and computed above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt names the same rows and writes the same value.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'tasks/tasks.service.ts#deleteAndStopRuns',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (10), the attached sessions FOR UPDATE (30, the order’s one declared exception), the projects FOR NO KEY UPDATE (40), the task rows FOR UPDATE (50), then the DELETE and its cascades.',
    identity: 'The id list, above the closure.',
    isolation: '',
    attempts: 2,
    replay: 'The surviving links, the occupying runs and the rows the DELETE names are all read inside the closure under the owner mutex.',
    effects: 'The run teardown, deliberately outside the loop and the transaction: a retry must not send a second cancel for a run the first attempt never deleted.',
    answer: 'Typed 503. Capped at 2 attempts with a 60s per-attempt deadline, for the reason TaskListsService.remove gives.',
  },
  {
    at: 'sessions/sessions.service.ts#writeFenced',
    shape: 'TX_RETRIED',
    locks: "The run request's row (`task_run_request`) FOR UPDATE, then whatever the write it wraps takes — for the only caller that passes a fence, a Session insert and its triggers. The receipt is not in the canonical Task/Session order because it is not in that graph: nothing else locks it, and it is taken first and released only at commit, so it adds no edge between the relations that are.",
    identity: "The claim: owner, door, token, lease holder and attempt. The transaction writes nothing unless that exact row is still BOUND to this delivery.",
    isolation: '',
    attempts: 4,
    replay: 'The fence read and the write are the same transaction, so a retry re-proves the claim before re-writing. A delivery that lost its lease between attempts fails closed rather than writing under a claim it no longer has.',
    effects: 'None. The realtime publishes and the runner nudge are outside, after the commit.',
    answer: 'A lost fence is `TASK_RUN_REQUEST_IN_PROGRESS` from the door; anything else is the typed 503 from the global boundary.',
  },
  {
    at: 'workspaces/workspaces.service.ts#reorder',
    shape: 'TX_RETRIED',
    locks: 'workspace rows, one UPDATE each, IN ID ORDER. This is the fix the audit was looking for: the statements used to run in the caller’s drag order, so two drags that move the same workspaces opposite ways took the same rows backwards.',
    identity: '`ranked` and the position map, computed above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'Idempotent: the same positions written again produce the same order.',
    effects: 'None inside.',
    answer: 'Typed 503; the client re-sends the order.',
  },
  {
    at: 'workspaces/workspaces.service.ts#remove',
    shape: 'TX_RETRIED',
    locks: 'workspace FOR UPDATE, then an unlocked count and the update of that same row — no outgoing wait edge, which is why `workspace` is argued rather than ranked (LOCK_ORDER_COMPATIBLE).',
    identity: 'The workspace id.',
    isolation: '',
    attempts: 4,
    replay: 'The row is re-read under its own lock; a delete that already happened is the same answer.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary.',
  },
];

export interface TransactionParticipant {
  /** `<path under src/apiserver/src>#<method>`. */
  at: string;
  /**
   * The units whose transaction this runs inside. Its lock order, its isolation and its retry
   * behaviour are theirs — this is the whole point of listing it separately rather than giving it
   * a decision it does not get to make.
   */
  under: string;
}

/**
 * Methods that write only through a transaction client somebody hands them.
 *
 * They are here so that "not in the inventory" cannot quietly mean "forgotten". A participant that
 * started opening its own transaction would move to `TRANSACTION_UNITS` and have to state a retry
 * decision; the spec detects the move by reading the method's signature, so it cannot be made
 * silently.
 */
export const TRANSACTION_PARTICIPANTS: readonly TransactionParticipant[] = [
  { at: 'common/lock-order.ts#lockOwnerTaskGraph', under: 'every rank-10 caller (I1)' },
  { at: 'common/lock-order.ts#lockCreatorSessions', under: 'every rank-30 caller (I2)' },
  { at: 'common/lock-order.ts#lockTaskLists', under: 'every rank-20 caller (I2)' },
  { at: 'common/session-inbox-fence.ts#retireSessionInboxGeneration', under: 'runner-api takeover/activate/release leases' },
  { at: 'projects/coordinator-convergence.service.ts#lockProject', under: "coordinatorConvergence.judge — the rank-40 lock that unit is ordered by, taken before it reads the state it decides from" },
  { at: 'projects/coordinator-convergence.service.ts#raiseBlocker', under: "coordinatorConvergence.judge — one INSERT ... ON CONFLICT DO NOTHING against `project_blocker_open_dedupe_idx`, inside the transaction that also commits the decision saying why it was raised. The two are one fact and must not be separable: a blocker with no decision behind it is the condition detector this unit replaced." },
  { at: 'projects/convergence-ledger.service.ts#ensureBaseline', under: "convergenceLedger.reviseScope, sessionAttempt.open, verificationFinding.submit — and every caller of `record`, which opens the ledger itself when the task has none" },
  { at: 'projects/convergence-ledger.service.ts#lockAndRead', under: 'convergenceLedger.reviseScope, verificationFinding.submit, and `record` — it takes the rank-50 task lock those units are ordered by, and reads the state they decide from' },
  { at: 'projects/convergence-ledger.service.ts#record', under: 'sessionAttempt.open, projectReconcile.applyDecisionAction, and every caller that judges a task' },
  { at: 'sessions/sessions.service.ts#assertFenceHeld', under: 'sessions.writeFenced and sessions.resume' },
  { at: 'projects/project-acceptance.service.ts#ensureEvidenceVersionTx', under: 'projectAcceptance.openRun, .recordMergeEvidence, and projects.update through ensureCurrentEvidenceVersion — every caller already holds project rank 40; this participant advances the one current evidence version and writes only rank-60 children' },
  { at: 'projects/project-acceptance.service.ts#writeAudit', under: 'projectAcceptance evidence-version, conclusion, merge-evidence and DONE transactions' },
  { at: 'projects/project-handoff.service.ts#spend', under: "tasks.create and tasks.createMany — unit L4's APPLY, one compare-and-set per yes inside the transaction that writes the task it authorises" },
  { at: 'tasks/tasks.service.ts#lockPlanExecutionIdentity', under: 'tasks.create, tasks.createMany — rank 10 then rank 15, before either takes a list or a session' },
  { at: 'tasks/tasks.service.ts#assertPlanAuthorityUnchanged', under: 'tasks.create, tasks.createMany — the preflight facts, re-read under the locks now held and before the first row' },
  { at: 'tasks/tasks.service.ts#assertDependencyCrossingsAtEffect', under: 'tasks.create, tasks.createMany — the cross-project edges, re-judged under a rank-50 lock on the prerequisites' },
  { at: 'projects/session-attempt.service.ts#bySessionId', under: 'sessionAttempt.evaluate, .close — and `chargeSteer`, which is the one caller that hands it the unmanaged client, so there it is a statement of its own' },
  { at: 'projects/projects.service.ts#lockLiveAgent', under: 'projects.update, .remove' },
  { at: 'projects/projects.service.ts#recordExplicitIdentity', under: 'projects.update' },
  { at: 'projects/projects.service.ts#replaceAcceptanceDefinitions', under: 'projects.update — the project row is already locked at rank 40 before these definition child rows are changed' },
  { at: 'projects/projects.service.ts#writeCoordinatorAgent', under: 'projects.update' },
  { at: 'projects/task-aggregation-writer.ts#applyTaskAggregations', under: 'projectReconcile.repeatableRead' },
  { at: 'runner-api/runner-api.controller.ts#lockSessionLeaseOwner', under: 'runnerApi.events, .turnComplete, .finalize' },
  { at: 'sessions/merge-receipt.service.ts#fromRunnerMergeResult', under: 'runnerApi.mergeResult' },
  { at: 'sessions/sessions.service.ts#ensurePromptSeeded', under: 'sessions.resume, queue.buildSession' },
  { at: 'sessions/sessions.service.ts#insertTurnLocked', under: 'sessions.insertTurn, .createTurn, .resume' },
  { at: 'sessions/sessions.service.ts#linkAttachments', under: 'sessions.createTurn, .resume' },
  { at: 'sessions/sessions.service.ts#taskWorkRefusalFor', under: 'sessions.resume, queue.buildSession' },
  { at: 'task-lists/list-events.service.ts#blockFor', under: 'taskLists.writePolicy' },
  { at: 'tasks/task-completion-evidence.service.ts#requestForEvidenceFact', under: 'taskCompletionEvidence.submit/importLegacyComment/backfill — after the rank-50 Task mutex, it inserts the evidence-bound request (whose trigger files inbox/outbox children), supersedes older OPEN requests (whose trigger cancels retryable delivery) and resolves only legacy blockers at rank 60' },
  { at: 'tasks/task-completion-evidence.service.ts#supersedeOpenRequests', under: 'taskCompletionEvidence.requestForEvidenceFact and .reconcileSatisfiedJudgmentRequest — both already hold the rank-50 Task mutex; this helper writes only rank-60 request/delivery rows and records rule, actor and source Session on the same terminal transition' },
  { at: 'tasks/reclaim-stalled-task.ts#reclaimStalledTask', under: 'runnerApi.finalize, reaper.forceFinalize' },
  { at: 'tasks/reclaim-stalled-task.ts#postRunFailureComment', under: 'runnerApi.finalize, reaper.forceFinalize' },
  { at: 'tasks/reclaim-stalled-task.ts#postExecutableAcceptanceComment', under: 'runnerApi.turnComplete — after the rank-40 project and rank-50 task are locked; the first conversation-turn ACK owns both the derived status and its evidence comment' },
  { at: 'tasks/reclaim-stalled-task.ts#postExecutableAcceptanceUnavailableComment', under: 'runnerApi.turnComplete — after the reserved shell turn is ACKed and the rank-50 task is locked; it is the durable needs-human branch mutually exclusive with a comparable result and status derivation' },
  { at: 'tasks/tasks.service.ts#linkSupersededBy', under: 'tasks.create, tasks.update' },
  { at: 'tasks/tasks.service.ts#lockTaskForSupersessionWrite', under: 'tasks.update' },
  // Unit L3's effect-time fence. Rank 40 only — the project row its callers already take at that
  // rank, in the same UUID order and the same mode — so it adds no edge to the lock graph, and the
  // refusal it can raise is an authorization answer that rolls its caller's transaction back whole.
  { at: 'tasks/tasks.service.ts#refenceProjectScope', under: 'tasks.create, tasks.createMany, tasks.update' },
  // Test-only, and reachable only from the harness's own transaction.
];

/** The recurring shapes an autocommit write takes. */
export type StatementClass =
  /** One row named by primary or unique key. */
  | 'ONE_ROW_BY_KEY'
  /** One row, named by key AND a condition it must still satisfy — a compare-and-set. */
  | 'ONE_ROW_CAS'
  /** A predicate that can match many rows in one statement. */
  | 'MANY_ROWS'
  /** An INSERT, of one row or of a batch. */
  | 'INSERT'
  /** A hand-written conditional UPDATE used as a fence. */
  | 'RAW_FENCE'
  /** Not a row write at all. */
  | 'NOT_A_ROW_WRITE';

export interface StatementClassNote {
  /** What PostgreSQL locks for a statement of this shape, including what no SQL here spells. */
  locks: string;
  /** Whether a statement of this shape can be a deadlock victim, and how. */
  exposure: string;
  /** Why it is not retried. */
  why: string;
  /** What the caller gets when it does lose one. */
  answer: string;
}

/**
 * Why none of these is retried, per shape.
 *
 * The short answer for all five is the same and is structural rather than a judgement call: an
 * autocommit statement has no transaction to re-run. Wrapping one in `$transaction` purely so a
 * retry loop had something to hold would change what the statement is — it would start holding its
 * locks across a round trip — and would buy the appearance of coverage rather than the property.
 * The long answer differs by shape, because the shapes differ in whether they can lose a conflict
 * at all.
 */
export const STATEMENT_CLASSES: Record<StatementClass, StatementClassNote> = {
  ONE_ROW_BY_KEY: {
    locks: 'The row itself, plus FOR KEY SHARE on every foreign-key parent the statement names, plus any row an AFTER trigger declared over the written columns takes.',
    exposure: 'Only when a trigger or a foreign key gives it a SECOND lock. With none, the statement takes one row lock and waits for nothing else, and a transaction with no outgoing wait edge cannot be an element of a cycle.',
    why: 'No transaction to re-run. The caller re-issues the request, which is the same statement.',
    answer: 'Typed 503, TRANSIENT_DB_CONFLICT, retryable=true, from the global boundary.',
  },
  ONE_ROW_CAS: {
    locks: 'Same as ONE_ROW_BY_KEY. The extra predicate columns change what the statement WRITES, not what it locks.',
    exposure: 'Same as ONE_ROW_BY_KEY.',
    why: 'No transaction to re-run — and a CAS is the shape a caller can safely re-issue itself, because the second issue either still matches or reports the state it wanted.',
    answer: 'Typed 503 from the global boundary.',
  },
  MANY_ROWS: {
    locks: 'Every matched row, in whatever order the plan produced them, plus each row’s FK and trigger locks.',
    exposure: 'Real. Two sweeps with overlapping selections can take the same rows in opposite orders, which is the one shape here that can deadlock without a trigger being involved.',
    why: 'No transaction to re-run. Where the ordering matters and the caller controls it — the two reorder endpoints — the statements were made ordered instead, which removes the cycle rather than absorbing it (see `orderedIds`).',
    answer: 'Typed 503 from the global boundary. The background sweeps among these (the reaper, the availability reaper, the auto-retry sweep) simply run again on their next tick.',
  },
  INSERT: {
    locks: 'FOR KEY SHARE on every foreign-key parent, in the order the columns are checked, plus whatever an AFTER trigger takes.',
    exposure: 'Only against a writer holding one of those parents FOR UPDATE. FOR KEY SHARE does not conflict with itself, so two INSERTs naming the same parents cannot deadlock with each other.',
    why: 'No transaction to re-run.',
    answer: 'Typed 503 from the global boundary; a duplicate key is a separate, permanent answer and is never retried.',
  },
  RAW_FENCE: {
    locks: 'The rows the WHERE clause matches, plus their FK and trigger locks.',
    exposure: 'Same as the Prisma equivalent — a fence is an UPDATE, and being hand-written changes nothing about its locks.',
    why: 'No transaction to re-run. A fence is by construction safe for the caller to re-issue: it only fires against the state it names.',
    answer: 'Typed 503 from the global boundary.',
  },
  NOT_A_ROW_WRITE: {
    locks: 'None.',
    exposure: 'None — it takes no row lock, so it cannot be in a lock cycle.',
    why: 'Nothing to retry.',
    answer: 'Its own error handling; it never reaches the conflict boundary.',
  },
};

export interface StatementUnit {
  /** `<path under src/apiserver/src>#<method>`. */
  at: string;
  class: StatementClass;
  /**
   * How many statements this method issues outside any transaction. Anything above 1 is a method
   * whose writes are NOT atomic with each other — recorded because that is a fact a reader of this
   * list should not have to re-derive, not because this audit changes it.
   */
  statements: number;
  /** Only where this entry deviates from its class. */
  note?: string;
}

/**
 * Every write that runs outside a transaction, and the class whose argument covers it.
 *
 * None is retried; `STATEMENT_CLASSES` says why per shape, and the answer for all of them when a
 * conflict does escape is the global boundary's typed 503. `statements` above 1 marks a method
 * whose writes are not atomic with each other.
 */
export const STATEMENT_UNITS: readonly StatementUnit[] = [
  { at: "attachments/attachments.service.ts#create", class: "INSERT", statements: 1 },
  { at: "auth/auth.service.ts#bootstrap", class: "INSERT", statements: 1 },
  { at: "auth/auth.service.ts#changePassword", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "auth/auth.service.ts#issueRefreshToken", class: "INSERT", statements: 1 },
  { at: "auth/auth.service.ts#logout", class: "ONE_ROW_CAS", statements: 1 },
  { at: "auth/auth.service.ts#refresh", class: "MANY_ROWS", statements: 2, note: "Two statements: the reuse-detection revoke of every live token for the user, then the CAS claim of this one. Not atomic with each other; the CAS is what makes the outcome unambiguous." },
  { at: "sessions/auto-retry.service.ts#disarmIfStillAggregateParent", class: "ONE_ROW_CAS", statements: 1, note: "The one write is inside `underAggregateParentLock`'s transaction; this method itself only issues the guarded read that decides whether to call it." },
  { at: "sessions/auto-retry.service.ts#refundIfStillAggregateParent", class: "ONE_ROW_CAS", statements: 1, note: "As above: the write belongs to `underAggregateParentLock`, which owns the locks and the compare-and-set." },
  { at: "projects/session-attempt.service.ts#chargeSteer", class: "ONE_ROW_CAS", statements: 1, note: "AU3's charge and its bound are ONE conditional UPDATE, so two coordinators steering at once cannot both read 'one left'. The two `FOR UPDATE` reads around it are each their own implicit transaction and hold nothing between statements — deliberately: the CAS is what decides, and the second read only says WHY it refused." },
  { at: "projects/coordinator-wake.service.ts#insertClaim", class: "INSERT", statements: 1, note: "The wake claim: one INSERT with ON CONFLICT DO NOTHING against the partial unique index of migration 0174, RETURNING the id so the loser of a race learns it lost without a second read. Not in a transaction, deliberately — authorization runs between this statement and the release below, and holding a row lock across a call this unit does not time is how a claim becomes a queue." },
  { at: "projects/coordinator-wake.service.ts#release", class: "ONE_ROW_CAS", statements: 1, note: "Giving the key back. The compare-and-set on CLAIMED is what makes a claim releasable exactly once, so a second refusal cannot rewrite the code the first one recorded. Leaving this write out is the accident it exists to prevent: a refusal that keeps the key welds that fact shut forever (project_action, coordinator rotation)." },
  { at: "projects/coordinator-wake.service.ts#consume", class: "ONE_ROW_CAS", statements: 1, note: "Binding a claimed criterion-input fact to its non-session consumer. The CLAIMED-to-CONSUMED compare-and-set stamps consumer_type/consumed_at together; CONSUMED remains inside the partial unique index, so replay cannot evaluate or deliver the same event + subject + evidence/version twice." },
  { at: "projects/coordinator-judgment.service.ts#open", class: "ONE_ROW_CAS", statements: 1, note: "Binding the one judgment session a wake gets. The compare-and-set on CLAIMED is what makes 'at most one session per wake' a fact of the database rather than of a read — a second caller holding the same wake matches no row, discards its session and says ALREADY_OPEN. The session row itself is written by sessions.create, which is inventoried under its own entry; this statement only names it. The status it writes, SESSION_OPENED, is inside 0174's partial unique index, so the fact goes on holding its key and can never claim a second session." },
  { at: "projects/attempt-ended-unsettled.producer.ts#reconcileResolvedHumanSignals", class: "MANY_ROWS", statements: 1, note: "One explicitly invoked compatibility repair UPDATE over this retired producer's own open signal code. It is no longer a bootstrap/provider path and never treats AWAITING_INPUT as completion input. Reissuing reaches the same resolved rows and writes no status." },
  { at: "projects/attempt-ended-unsettled.producer.ts#resolveHumanSignal", class: "ONE_ROW_CAS", statements: 1, note: "Best-effort close of this Task's one open missing-path blocker after settlement or a successful path. The open-row predicate makes a redelivery a no-op; it never writes Task status." },
  { at: "projects/project-handoff.service.ts#decide", class: "ONE_ROW_CAS", statements: 1, note: "The user's answer, as a compare-and-set on the state it was read in: two clicks produce one answer and one 409. Re-approving a live yes writes nothing at all — it returns the row unchanged, so an approval's own deadline cannot be extended by clicking approve again." },
  { at: "providers/providers.service.ts#create", class: "INSERT", statements: 1 },
  { at: "providers/providers.service.ts#remove", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "providers/providers.service.ts#update", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "push/judgment-delivery.service.ts#claimOne", class: "RAW_FENCE", statements: 1, note: "One due row is selected FOR UPDATE SKIP LOCKED and changed to DELIVERING in the same statement. The lease holder, attempts and database-clock expiry are the fence two replicas share." },
  { at: "push/judgment-delivery.service.ts#expireCrashedDeliveries", class: "MANY_ROWS", statements: 1, note: "Bounds only consecutive expired leases at DEAD. Availability outcomes reset claims, so an offline device cannot be aged out by this repair." },
  { at: "push/judgment-delivery.service.ts#finishDelivery", class: "RAW_FENCE", statements: 1, note: "Records one APNs outcome only while the delivery still has this lease and its request is OPEN. A concurrent decision/supersession changes the row to CANCELLED, so this fenced receipt matches zero and cannot resurrect a retry." },
  { at: "push/push.controller.ts#register", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "push/push.controller.ts#unregister", class: "ONE_ROW_CAS", statements: 1 },
  { at: "push/push.service.ts#deliver", class: "ONE_ROW_CAS", statements: 1, note: "Runs inside the APNs delivery loop: the HTTP call is what decides the delete, so the write is a consequence of an external action rather than the other way round. Nothing about it is transactional and nothing re-sends the notification." },
  { at: "realtime/realtime.service.ts#drainCommitRequests", class: "ONE_ROW_CAS", statements: 1 },
  { at: "realtime/realtime.service.ts#drainMergeRequests", class: "ONE_ROW_CAS", statements: 1 },
  { at: "realtime/realtime.service.ts#failAbandonedWorktreeOperations", class: "MANY_ROWS", statements: 2 },
  { at: "realtime/realtime.service.ts#notifyRaw", class: "NOT_A_ROW_WRITE", statements: 1, note: "pg_notify, not a row write. Listed so the scan has somewhere to put it." },
  { at: "realtime/reaper.service.ts#purgeTrash", class: "MANY_ROWS", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#artifactResult", class: "ONE_ROW_CAS", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#cloneResult", class: "ONE_ROW_CAS", statements: 1, note: "The CAS predicate is the fence as well as the guard: it names a workspace of THIS runner that is still CLONING, so a result arriving after the user retried the clone somewhere else matches nothing and writes nothing." },
  { at: "runner-api/runner-api.controller.ts#createApproval", class: "INSERT", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#createDeviceSession", class: "INSERT", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#deregister", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#devicePoll", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#diffResult", class: "ONE_ROW_CAS", statements: 2 },
  { at: "runner-api/runner-api.controller.ts#drainInstallRequest", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#drainLoginRequest", class: "ONE_ROW_BY_KEY", statements: 2 },
  { at: "runner-api/runner-api.controller.ts#drainRepoCleanupRequest", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#heartbeat", class: "MANY_ROWS", statements: 4, note: "Four separate statements, deliberately: a heartbeat that half-lands is a heartbeat, and making them atomic would put the hot runner row in a transaction with a multi-row workspace sweep." },
  { at: "runner-api/runner-api.controller.ts#installResult", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#loginResult", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#markOpenCodeUpgradeRequired", class: "MANY_ROWS", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#reclaim", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#reconcileReportedBranchMerged", class: "ONE_ROW_CAS", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#register", class: "INSERT", statements: 3, note: "Three statements: the runner upsert and the enrollment-token burn. Re-registering is idempotent on the runner row." },
  { at: "runner-api/runner-api.controller.ts#repoCleanupResult", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#uploadAttachment", class: "INSERT", statements: 1 },
  { at: "runner-api/service-token.authorizer.ts#mint", class: "INSERT", statements: 1 },
  { at: "runner-api/service-token.authorizer.ts#revoke", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#approveDeviceEnrollment", class: "INSERT", statements: 3, note: "Three statements: the runner upsert and the enrollment approval." },
  { at: "runners/runners.service.ts#cancelInstall", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#cancelLogin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#createEnrollmentToken", class: "INSERT", statements: 1 },
  { at: "runners/runners.service.ts#removeRunner", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#rotateToken", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#startEngineUpdate", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#startInstall", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#startLogin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#submitLoginCode", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#updateRunner", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "session-tags/session-tags.service.ts#create", class: "INSERT", statements: 1 },
  { at: "session-tags/session-tags.service.ts#ensureSystemTags", class: "INSERT", statements: 1 },
  { at: "session-tags/session-tags.service.ts#remove", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "session-tags/session-tags.service.ts#update", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/auto-retry.service.ts#copyAttachments", class: "INSERT", statements: 1, note: "One INSERT per image the message being re-sent carried, in a loop — N images, N statements, not atomic with each other. Deliberately: a copy stranded by the next one's failure is turn-less bytes that `discardCopies` deletes and the session's own deletion collects, so there is nothing for atomicity to protect." },
  { at: "sessions/auto-retry.service.ts#disarm", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/auto-retry.service.ts#discardCopies", class: "MANY_ROWS", statements: 1, note: "Deletes only ids this sweep just created and never linked (`turn_id IS NULL`), so the selection cannot overlap another writer's rows — the shape MANY_ROWS is otherwise exposed to." },
  { at: "sessions/auto-retry.service.ts#rearm", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/auto-retry.service.ts#sweep", class: "ONE_ROW_CAS", statements: 2 },
  { at: "sessions/sessions.service.ts#applyAutoTags", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#beautifySessionLater", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/sessions.service.ts#cancelAutoRetry", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#commitWorktree", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/sessions.service.ts#create", class: "INSERT", statements: 2, note: "Two statements: the session INSERT, then the attachment adoption. An attachment left unadopted is orphaned rather than wrongly attached, which is why this has never needed to be atomic." },
  { at: "sessions/sessions.service.ts#createAutoTags", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#decideApproval", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/sessions.service.ts#disableShare", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#enableShare", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#enqueueLegacyArtifactRequest", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#persistLegacyArtifactAttachment", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#pin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#rememberForWorkspace", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#rename", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#spawnFromSession", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#unpin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "task-lists/task-lists.service.ts#console", class: "ONE_ROW_CAS", statements: 1 },
  { at: "task-lists/task-lists.service.ts#create", class: "INSERT", statements: 1 },
  { at: "tasks/tasks.service.ts#addComment", class: "INSERT", statements: 1 },
  { at: "tasks/tasks.service.ts#bindMentionTarget", class: "RAW_FENCE", statements: 1 },
  { at: "tasks/tasks.service.ts#clearFailedForRetry", class: "ONE_ROW_CAS", statements: 1, note: "The documented residual (docs/postgres-lock-order.md §6): it writes `status`, so an AFTER trigger takes the project FOR NO KEY UPDATE while the task row is held — the project/task inversion. Left as one statement deliberately: the inversion is not resolvable from this side, and wrapping four of the fifteen single-statement status writers in transactions would buy the appearance of coverage rather than the property." },
  { at: "tasks/tasks.service.ts#consumeRunAt", class: "ONE_ROW_CAS", statements: 1, note: "`run_at` is in no trigger's column list, so this takes exactly one row lock and waits for nothing." },
  { at: "tasks/tasks.service.ts#deliverMentions", class: "RAW_FENCE", statements: 3 },
  { at: "tasks/tasks.service.ts#deliverOneMention", class: "RAW_FENCE", statements: 1 },
  { at: "tasks/tasks.service.ts#dispatchStalledListForemen", class: "INSERT", statements: 1 },
  { at: "tasks/tasks.service.ts#fileVerification", class: "INSERT", statements: 2, note: "Legacy verification creates a fresh task; an evidence-bound VERIFICATION request upserts the deterministic task whose id is the request id. Both are durable before any dispatch attempt." },
  { at: "tasks/tasks.service.ts#parkMentionDelivery", class: "RAW_FENCE", statements: 1 },
  { at: "tasks/tasks.service.ts#bindRunRequest", class: "ONE_ROW_CAS", statements: 1, note: "Writes the frozen plan onto the run receipt (0137), fenced on `lease_holder` + `attempt` and on `status = 'OPEN'`. A holder that lost its lease matches nothing and reads back the plan the takeover bound instead of its own." },
  { at: "tasks/tasks.service.ts#completeRunReceipt", class: "ONE_ROW_CAS", statements: 1, note: "Freezes the request's answer, fenced the same way. The value returned is read back from the row, never the local one, so a stale holder cannot answer with a result the database does not have." },
  { at: "tasks/tasks.service.ts#leaseRunRequest", class: "RAW_FENCE", statements: 2, note: "One `INSERT … ON CONFLICT DO NOTHING` to open the receipt, then one `UPDATE … RETURNING` that takes the right to evaluate it — expiry and predicate both on `statement_timestamp()`, so two apiservers with different wall clocks cannot take each other's requests over." },
  { at: "tasks/tasks.service.ts#recordListEvent", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "tasks/tasks.service.ts#releaseRunRequest", class: "ONE_ROW_CAS", statements: 1, note: "Hands the right to evaluate back when a request was refused rather than answered, fenced on the same holder + attempt." },
  { at: "tasks/tasks.service.ts#renewRunRequest", class: "ONE_ROW_CAS", statements: 1, note: "Re-proves the lease before each item of a bulk Run. `false` means a takeover has happened and this delivery must stop, which is the one way two evaluators could both write." },
  { at: "tasks/tasks.service.ts#removeComment", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/admin.controller.ts#deleteUser", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/admin.controller.ts#setRole", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/users.controller.ts#updatePreferences", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/users.util.ts#createOrResetUser", class: "INSERT", statements: 2, note: "Two spellings, one write per call — update when the user exists, insert when not." },
  { at: "workspaces/workspaces.service.ts#create", class: "INSERT", statements: 1 },
  { at: "workspaces/workspaces.service.ts#redispatchClone", class: "ONE_ROW_CAS", statements: 1, note: "Re-arms a failed clone. The CAS on provisionState = FAILED is what makes a double-click one dispatch rather than two clones into the same directory." },
  { at: "workspaces/workspaces.service.ts#removePermissionRule", class: "ONE_ROW_CAS", statements: 1 },
  { at: "workspaces/workspaces.service.ts#requestRepoCleanup", class: "ONE_ROW_CAS", statements: 1 },
  { at: "workspaces/workspaces.service.ts#setOrchestrationForAll", class: "MANY_ROWS", statements: 1, note: "A whole-owner sweep. It is the widest single statement here and the one most able to be a deadlock victim; there is no ordering to impose because it names no ids." },
  { at: "workspaces/workspaces.service.ts#update", class: "ONE_ROW_BY_KEY", statements: 1 },
];

export interface TriggerWriteSource {
  /** The relation the trigger fires on. */
  table: string;
  trigger: string;
  /** `AFTER UPDATE OF "a", "b"` — the declaration, because the column list is what decides. */
  event: string;
  /** `CONSTRAINT` for a deferrable constraint trigger, which runs at COMMIT rather than inline. */
  kind: 'ROW/STATEMENT' | 'CONSTRAINT';
  /** The migration that installed the version currently live. */
  since: string;
  /**
   * The rows in OTHER relations this trigger locks or writes, transitively through the functions
   * it calls. Empty means it only touches the row that fired it — a trigger that takes no second
   * relation cannot turn a one-lock statement into a two-lock one, which is what makes it unable
   * to put a statement in a lock cycle it was not already in.
   */
  takes: readonly string[];
}

/**
 * Every trigger the migration history leaves installed, and what each one reaches for.
 *
 * This is the half of the audit no source scan of the TypeScript could find. Both production
 * deadlocks this project started from had at least one edge that appeared in no statement anybody
 * wrote: a foreign key's internal constraint trigger in one, an AFTER trigger reaching for a
 * project row in the other. So the triggers are enumerated the same way the code is — derived,
 * not remembered — by replaying every CREATE and DROP in migration order and following each
 * trigger function's calls. `db-write-inventory.spec.ts` re-derives the whole set from
 * `prisma/migrations` and fails when it stops matching, so a migration cannot add a trigger, widen
 * one's column list, or give one a new cross-relation lock without this list moving with it.
 *
 * `takes` is the deadlock-relevant field. A trigger with an empty `takes` adds no wait edge; the
 * ones that do are exactly the entries `docs/postgres-lock-order.md` derives the canonical order
 * from. Migration 0178 removed the four task/acceptance triggers: task-list state is no longer an
 * acceptance fact and a plain task-status write no longer reaches a project through that path.
 */
export const TRIGGER_WRITE_SOURCES: readonly TriggerWriteSource[] = [
  { table: "model_provider", trigger: "model_provider_builtin_opencode_guard_delete", event: "BEFORE DELETE", kind: "ROW/STATEMENT", since: "0080_opencode_runtime", takes: [] },
  { table: "model_provider", trigger: "model_provider_builtin_opencode_guard_rename", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0080_opencode_runtime", takes: [] },
  { table: "project", trigger: "project_acceptance_advance_epoch", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0150_task_provenance_project_acceptance_epoch", takes: [] },
  { table: "project", trigger: "project_acceptance_criteria_fact", event: "AFTER INSERT OR UPDATE OF \"acceptance_criteria\"", kind: "ROW/STATEMENT", since: "0172_structured_project_acceptance_criteria", takes: ["project_acceptance_audit WRITE", "project_acceptance_criterion_definition WRITE", "project_acceptance_run WRITE"] },
  { table: "project", trigger: "project_acceptance_done_gate", event: "BEFORE UPDATE OF \"status\", \"accepted_run_id\"", kind: "ROW/STATEMENT", since: "0150_task_provenance_project_acceptance_epoch", takes: [] },
  { table: "project", trigger: "project_acceptance_epoch_audit", event: "AFTER UPDATE", kind: "ROW/STATEMENT", since: "0150_task_provenance_project_acceptance_epoch", takes: ["project_acceptance_audit WRITE"] },
  { table: "project", trigger: "project_coordinator_companions_bind", event: "AFTER UPDATE OF \"coordinator_workspace_id\"", kind: "CONSTRAINT", since: "0113_project_coordinator_final_row", takes: ["project_member WRITE", "project_runtime WRITE", "workspace LOCK"] },
  { table: "project", trigger: "project_coordinator_companions_insert", event: "AFTER INSERT", kind: "CONSTRAINT", since: "0113_project_coordinator_final_row", takes: ["project_member WRITE", "project_runtime WRITE", "workspace LOCK"] },
  { table: "project", trigger: "project_coordinator_identity_window_repair", event: "BEFORE UPDATE OF \"coordinator_workspace_id\"", kind: "ROW/STATEMENT", since: "0115_project_coordinator_identity_window_repair", takes: [] },
  { table: "project", trigger: "project_coordinator_pointer_guard", event: "BEFORE INSERT OR UPDATE OF \"coordinator_session_id\", \"coordinator_workspace_id\"", kind: "ROW/STATEMENT", since: "0126_project_coordinator_session_lifecycle", takes: [] },
  { table: "project", trigger: "project_coordinator_rotation_count", event: "AFTER UPDATE OF \"coordinator_session_id\"", kind: "CONSTRAINT", since: "0113_project_coordinator_final_row", takes: ["project_member WRITE", "project_runtime WRITE", "workspace LOCK"] },
  { table: "project", trigger: "project_dispatch_authority_fanout", event: "AFTER UPDATE OF \"coordinator_enabled\"", kind: "ROW/STATEMENT", since: "0122_project_dispatch_boundary", takes: ["task WRITE"] },
  { table: "project_acceptance_audit", trigger: "project_acceptance_audit_append_only", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0127_project_acceptance_run", takes: [] },
  { table: "project_acceptance_conclusion", trigger: "project_acceptance_conclusion_immutable", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0179_project_acceptance_event_projection", takes: [] },
  { table: "project_acceptance_conclusion", trigger: "project_acceptance_conclusion_reconcile", event: "AFTER INSERT", kind: "ROW/STATEMENT", since: "0179_project_acceptance_event_projection", takes: ["project LOCK", "project WRITE", "project_acceptance_audit WRITE"] },
  { table: "project_acceptance_conclusion", trigger: "project_acceptance_conclusion_validate", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0179_project_acceptance_event_projection", takes: ["project LOCK"] },
  { table: "project_acceptance_criteria_confirmation", trigger: "project_acceptance_confirmation_immutable", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0189_project_criteria_automation", takes: [] },
  { table: "project_acceptance_criterion", trigger: "project_acceptance_criterion_immutable_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0127_project_acceptance_run", takes: [] },
  { table: "project_acceptance_criterion_definition", trigger: "project_acceptance_definition_normalize", event: "BEFORE INSERT OR UPDATE OF \"text\", \"verification_method\", \"completion_criterion\", \"acceptance_command\", \"acceptance_expected_exit_code\", \"evidence_task_id\", \"completion_criterion_override_reason\", \"revision\", \"content_hash\"", kind: "ROW/STATEMENT", since: "0189_project_criteria_automation", takes: [] },
  { table: "project_acceptance_run", trigger: "project_acceptance_run_epoch_guard", event: "BEFORE INSERT OR UPDATE", kind: "ROW/STATEMENT", since: "0150_task_provenance_project_acceptance_epoch", takes: [] },
  { table: "project_acceptance_run", trigger: "project_acceptance_run_immutable_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0127_project_acceptance_run", takes: [] },
  { table: "project_action", trigger: "project_action_dispatch_immutable", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0122_project_dispatch_boundary", takes: [] },
  { table: "project_action", trigger: "project_action_dispatch_result_check", event: "AFTER INSERT OR UPDATE OF \"status\", \"result_session_id\"", kind: "CONSTRAINT", since: "0122_project_dispatch_boundary", takes: [] },
  { table: "project_blocker", trigger: "project_blocker_escalation_once", event: "BEFORE UPDATE OF \"escalated_at\"", kind: "ROW/STATEMENT", since: "0125_project_blocker", takes: [] },
  { table: "project_blocker", trigger: "project_blocker_resolution_final", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0125_project_blocker", takes: [] },
  { table: "project_decision", trigger: "project_decision_immutable_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0120_project_decision_audit", takes: [] },
  { table: "project_handoff_approval", trigger: "project_handoff_approval_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0155_project_handoff_approval", takes: [] },
  { table: "session", trigger: "session_admission_lock_order_insert_delete", event: "BEFORE INSERT OR DELETE", kind: "ROW/STATEMENT", since: "0130_task_supersession_dispatch_guard", takes: ["project LOCK", "scope_before LOCK", "task LOCK"] },
  { table: "session", trigger: "session_admission_lock_order_update", event: "BEFORE UPDATE OF \"status\", \"task_id\", \"deleted_at\", \"starts_task_work\"", kind: "ROW/STATEMENT", since: "0134_task_aggregate_parent_dispatch_guard", takes: ["project LOCK", "scope_before LOCK", "task LOCK"] },
  { table: "session", trigger: "session_completed_at_compat", event: "BEFORE INSERT OR UPDATE OF \"completed_at\", \"archived_at\"", kind: "ROW/STATEMENT", since: "0076_session_completed_semantics", takes: [] },
  { table: "session", trigger: "session_merge_projection_checkpoint_authority_trg", event: "BEFORE UPDATE OF \"merge_status\", \"merged_source_sha\", \"branch_merged\"", kind: "ROW/STATEMENT", since: "0152_task_checkpoint", takes: [] },
  { table: "session", trigger: "session_opencode_runner_claim_guard", event: "BEFORE UPDATE OF \"status\"", kind: "ROW/STATEMENT", since: "0080_opencode_runtime", takes: [] },
  { table: "session", trigger: "session_project_capacity_serialize_insert_delete", event: "BEFORE INSERT OR DELETE", kind: "ROW/STATEMENT", since: "0122_project_dispatch_boundary", takes: ["project WRITE"] },
  { table: "session", trigger: "session_project_capacity_serialize_update", event: "BEFORE UPDATE OF \"status\", \"task_id\", \"deleted_at\"", kind: "ROW/STATEMENT", since: "0122_project_dispatch_boundary", takes: ["project WRITE"] },
  { table: "session", trigger: "session_superseded_task_guard", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0130_task_supersession_dispatch_guard", takes: ["task LOCK"] },
  { table: "session", trigger: "session_superseded_task_revive_guard", event: "BEFORE UPDATE OF \"status\", \"task_id\", \"dispatch_origin\", \"deleted_at\", \"starts_task_work\"", kind: "ROW/STATEMENT", since: "0130_task_supersession_dispatch_guard", takes: ["task LOCK"] },
  { table: "session_merge_receipt", trigger: "session_merge_receipt_checkpoint_accepted_trg", event: "BEFORE INSERT OR UPDATE", kind: "ROW/STATEMENT", since: "0152_task_checkpoint", takes: [] },
  { table: "session_merge_receipt", trigger: "session_merge_receipt_immutable_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0128_task_supersession_merge_receipt", takes: [] },
  { table: "task", trigger: "task_aggregate_parent_child_delete_touch", event: "BEFORE DELETE", kind: "ROW/STATEMENT", since: "0134_task_aggregate_parent_dispatch_guard", takes: ["project LOCK"] },
  { table: "task", trigger: "task_aggregate_parent_shape_guard", event: "BEFORE INSERT OR UPDATE OF \"parent_task_id\", \"completion_policy\", \"is_foreman\", \"owner_id\"", kind: "ROW/STATEMENT", since: "0134_task_aggregate_parent_dispatch_guard", takes: ["project LOCK"] },
  { table: "task", trigger: "task_claimed_project_move_guard", event: "BEFORE UPDATE OF \"project_id\"", kind: "ROW/STATEMENT", since: "0122_project_dispatch_boundary", takes: [] },
  { table: "task", trigger: "task_convergence_counters_monotonic", event: "BEFORE UPDATE OF \"convergence_counters\", \"scope_revision\", \"attempt_generation\"", kind: "ROW/STATEMENT", since: "0138_task_convergence_ledger", takes: [] },
  { table: "task", trigger: "task_dependency_revision_seed", event: "AFTER INSERT", kind: "ROW/STATEMENT", since: "0132_task_dependency_revision", takes: ["task_dependency_revision WRITE"] },
  { table: "task", trigger: "task_dispatch_authority_derive", event: "BEFORE INSERT OR UPDATE OF \"project_id\", \"dispatch_authority\"", kind: "ROW/STATEMENT", since: "0122_project_dispatch_boundary", takes: [] },
  { table: "task", trigger: "task_dispatch_epoch_seed", event: "AFTER INSERT", kind: "ROW/STATEMENT", since: "0137_task_run_request_receipt", takes: ["task_dispatch_epoch WRITE"] },
  { table: "task", trigger: "task_dispatch_epoch_update", event: "AFTER UPDATE", kind: "ROW/STATEMENT", since: "0137_task_run_request_receipt", takes: ["task_dispatch_epoch LOCK"] },
  { table: "task", trigger: "task_judgment_verifier_terminal_guard", event: "BEFORE UPDATE OF \"status\", \"verdict\", \"verifies_task_id\"", kind: "ROW/STATEMENT", since: "0181_task_judgment_request", takes: [] },
  { table: "task", trigger: "task_provenance_immutable_guard", event: "BEFORE UPDATE OF \"discovered_from_project_id\", \"trigger_event\", \"source_task_id\", \"source_session_id\"", kind: "ROW/STATEMENT", since: "0150_task_provenance_project_acceptance_epoch", takes: [] },
  { table: "task", trigger: "task_scope_freeze_guard", event: "BEFORE UPDATE OF \"title\", \"description\", \"acceptance_criteria\", \"scope_revision\"", kind: "ROW/STATEMENT", since: "0138_task_convergence_ledger", takes: [] },
  { table: "task", trigger: "task_supersession_guard_insert", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0128_task_supersession_merge_receipt", takes: [] },
  { table: "task", trigger: "task_supersession_guard_update", event: "BEFORE UPDATE OF \"superseded_by_task_id\", \"status\", \"owner_id\", \"project_id\"", kind: "ROW/STATEMENT", since: "0128_task_supersession_merge_receipt", takes: [] },
  { table: "task", trigger: "task_supersession_live_session_guard", event: "BEFORE UPDATE OF \"superseded_by_task_id\", \"terminal_reason\"", kind: "ROW/STATEMENT", since: "0130_task_supersession_dispatch_guard", takes: [] },
  { table: "task", trigger: "task_supersession_project_lock_order", event: "BEFORE UPDATE OF \"superseded_by_task_id\", \"terminal_reason\", \"project_id\"", kind: "ROW/STATEMENT", since: "0130_task_supersession_dispatch_guard", takes: ["project LOCK"] },
  { table: "task", trigger: "task_supersession_successor_move_guard", event: "BEFORE UPDATE OF \"project_id\", \"owner_id\"", kind: "ROW/STATEMENT", since: "0130_task_supersession_dispatch_guard", takes: [] },
  { table: "task", trigger: "task_verdict_revision_advance", event: "BEFORE INSERT OR UPDATE OF \"verdict\"", kind: "ROW/STATEMENT", since: "0124_task_verification_verdict", takes: [] },
  { table: "task", trigger: "task_verdict_revision_monotonic", event: "BEFORE UPDATE OF \"verdict_revision\"", kind: "ROW/STATEMENT", since: "0124_task_verification_verdict", takes: [] },
  { table: "task", trigger: "task_verdict_revoked_on_reopen", event: "BEFORE UPDATE OF \"status\"", kind: "ROW/STATEMENT", since: "0124_task_verification_verdict", takes: [] },
  { table: "task", trigger: "task_verification_subject_guard", event: "BEFORE INSERT OR UPDATE OF \"verifies_task_id\"", kind: "ROW/STATEMENT", since: "0130_task_supersession_dispatch_guard", takes: [] },
  { table: "task", trigger: "task_verification_verdict_atomic_insert", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0141_task_verification_finding", takes: [] },
  { table: "task", trigger: "task_verification_verdict_atomic_update", event: "BEFORE UPDATE OF \"status\", \"verdict\"", kind: "ROW/STATEMENT", since: "0141_task_verification_finding", takes: [] },
  { table: "task_attempt", trigger: "task_attempt_checkpoint_guard", event: "BEFORE INSERT OR UPDATE", kind: "ROW/STATEMENT", since: "0139_task_session_attempt", takes: [] },
  { table: "task_attempt", trigger: "task_attempt_fence", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0139_task_session_attempt", takes: [] },
  { table: "task_attempt", trigger: "task_attempt_result_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0139_task_session_attempt", takes: [] },
  { table: "task_checkpoint", trigger: "task_checkpoint_immutable_trg", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0152_task_checkpoint", takes: [] },
  { table: "task_comment", trigger: "task_comment_mention_delivery_file", event: "AFTER INSERT", kind: "ROW/STATEMENT", since: "0131_task_comment_mention_delivery", takes: ["task_comment_mention_delivery WRITE"] },
  { table: "task_convergence_decision", trigger: "task_convergence_decision_fence", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0138_task_convergence_ledger", takes: [] },
  { table: "task_convergence_decision", trigger: "task_convergence_decision_immutable_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0138_task_convergence_ledger", takes: [] },
  { table: "task_dependency", trigger: "task_dependency_revision_delete", event: "AFTER DELETE", kind: "ROW/STATEMENT", since: "0132_task_dependency_revision", takes: ["task_dependency_revision LOCK"] },
  { table: "task_dependency", trigger: "task_dependency_revision_insert", event: "AFTER INSERT", kind: "ROW/STATEMENT", since: "0132_task_dependency_revision", takes: ["task_dependency_revision LOCK"] },
  { table: "task_dependency", trigger: "task_dependency_revision_update", event: "AFTER UPDATE", kind: "ROW/STATEMENT", since: "0132_task_dependency_revision", takes: ["task_dependency_revision LOCK"] },
  { table: "task_dependency", trigger: "task_dispatch_epoch_edges_delete", event: "AFTER DELETE", kind: "ROW/STATEMENT", since: "0137_task_run_request_receipt", takes: ["task_dispatch_epoch LOCK"] },
  { table: "task_dependency", trigger: "task_dispatch_epoch_edges_insert", event: "AFTER INSERT", kind: "ROW/STATEMENT", since: "0137_task_run_request_receipt", takes: ["task_dispatch_epoch LOCK"] },
  { table: "task_dependency", trigger: "task_dispatch_epoch_edges_update", event: "AFTER UPDATE", kind: "ROW/STATEMENT", since: "0137_task_run_request_receipt", takes: ["task_dispatch_epoch LOCK"] },
  { table: "task_executable_judgment_result", trigger: "task_executable_judgment_result_request_guard", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0181_task_judgment_request", takes: ["task_judgment_request LOCK"] },
  { table: "task_human_signoff", trigger: "task_human_signoff_current_request_guard", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0181_task_judgment_request", takes: ["task_judgment_request LOCK"] },
  { table: "task_judgment_request", trigger: "task_judgment_delivery_file", event: "AFTER INSERT", kind: "ROW/STATEMENT", since: "0182_task_judgment_delivery", takes: ["task_judgment_inbox_item WRITE", "task_judgment_push_delivery WRITE"] },
  { table: "task_judgment_request", trigger: "task_judgment_delivery_stop", event: "AFTER UPDATE OF \"status\"", kind: "ROW/STATEMENT", since: "0182_task_judgment_delivery", takes: [] },
  { table: "task_judgment_request", trigger: "task_judgment_request_migration_metadata_guard", event: "BEFORE UPDATE OF \"origin\", \"device_policy\", \"backfill_batch_id\"", kind: "ROW/STATEMENT", since: "0184_task_signoff_backfill", takes: [] },
  { table: "task_judgment_request", trigger: "task_judgment_request_transition_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0181_task_judgment_request", takes: [] },
  { table: "task_legacy_evidence_import", trigger: "task_legacy_evidence_import_immutable", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0184_task_signoff_backfill", takes: [] },
  { table: "task_scope_revision", trigger: "task_scope_revision_authority_guard", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0138_task_convergence_ledger", takes: [] },
  { table: "task_scope_revision", trigger: "task_scope_revision_immutable_guard", event: "BEFORE UPDATE", kind: "ROW/STATEMENT", since: "0138_task_convergence_ledger", takes: [] },
  { table: "task_verification_finding", trigger: "task_verification_finding_fence", event: "BEFORE INSERT", kind: "ROW/STATEMENT", since: "0141_task_verification_finding", takes: [] },
  { table: "task_verification_finding", trigger: "task_verification_finding_immutable_guard", event: "BEFORE UPDATE OR DELETE", kind: "ROW/STATEMENT", since: "0141_task_verification_finding", takes: [] },
];

export interface ExcludedSource {
  path: string;
  why: string;
}

/**
 * Sources the scan skips, and the argument for each.
 *
 * "Not in the inventory" has to mean "argued", not "forgotten" — the same rule
 * `LOCK_ORDER_COMPATIBLE` follows. The spec asserts these files exist and that nothing else was
 * skipped, so an exclusion cannot be widened by accident.
 */
export const EXCLUDED_SOURCES: readonly ExcludedSource[] = [
  {
    path: 'common/transaction-retry.ts',
    why: 'The retry loop itself. Its `$transaction` call IS the mechanism this inventory is about; listing it as a unit of work would make the loop a member of the set it implements.',
  },
  {
    path: 'deadlock/',
    why: 'Barrier fixtures and baselines. They open their own connections to a disposable server that `coordinator-pg-test-safety` refuses to point at a business database, and they run only from scripts/deadlock-barrier.sh.',
  },
  {
    path: 'tasks/task-run-receipt-fake.ts',
    why: 'The run receipt (0137) as an in-memory row, for the unit fixtures that drive the run doors against a fake Prisma. It IMPLEMENTS the raw-query methods rather than calling any, so the scan sees a write where there is no database at all; every door now opens a receipt, so five fixtures need it, and a sixth copy of the receipt lifecycle would be a sixth thing to keep in step with the migration.',
  },
  {
    path: 'projects/project-e2e-harness.ts',
    why: 'A test harness. Its one transaction seeds a world for the Project specs and is never reachable from an HTTP route; its three writer helpers are listed as participants so the exclusion is of the boundary only.',
  },
];
