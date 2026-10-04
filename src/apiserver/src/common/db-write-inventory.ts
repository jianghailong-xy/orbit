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
 * attempt, so retried units keep every such action after commit. Nothing is exempt from that
 * today: the constrained Action Executor was the one deliberate exception, and 0219 removed it
 * along with the only `TX_BARE` unit. The shape stays in the vocabulary for whatever next has to
 * state a one-attempt decision, and the checks below still hold such a unit to one attempt.
 *
 * ISOLATION
 * ---------
 * The deployment default is READ COMMITTED, so `isolation` is blank except where a unit asks for
 * something else. REPEATABLE READ and SERIALIZABLE units declare that exact choice here because
 * either can raise 40001; under READ COMMITTED the ordinary transient conflict is 40P01.
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
 * Ordinary database-only units are retried. A unit that cannot be re-run appears here as
 * `TX_BARE`, with its one-attempt decision and recovery path stated explicitly. Every unit below
 * is `TX_RETRIED`; the one `TX_BARE` entry belonged to the Action Executor 0219 deleted.
 */
export const TRANSACTION_UNITS: readonly TransactionUnit[] = [
  {
    at: 'runner-api/integration-job-relay.ts#applyIntegrationJobResult',
    shape: 'TX_RETRIED',
    locks: 'project_integration_job (rank 60) by primary key, then whatever the writes it implies take: session_merge_receipt (rank 60) for a landing, task_comment (rank 30\'s child, locked through its task foreign key FOR KEY SHARE) for the signal a no-commit answer leaves, project_open_item (rank 60) for a failure, the project_promotion row (rank 60) and its project_open_item card (rank 60) for a promotion\'s transition — and, when that transition takes it out of the live states (a MERGED one, or the candidate `refileCandidateBehindTheWork` retires), the OPEN failure items about it (rank 60, `closePromotionItems`) — and — for a landing that answered ALREADY_LANDED about a branch the task work did not end on — one more project_integration_job row (rank 60) for the generation that branch is owed (`queueLandingBehindTheWork`), as there are one project_promotion row (rank 60), one project_open_item card (rank 60) and one CHECK_PROMOTION row (rank 60) for the candidate a task\'s work is owed when a check found it was looking at a branch the work did not end on (`refileCandidateBehindTheWork`). Nothing above rank 60 is locked — the foreign keys of those children take `session`, `task` and `project` FOR KEY SHARE, which no status write conflicts with, and the job row itself is the only thing two runners could both want.',
    identity: "The job, and the claim it was reported under: `(id, claim_lease_owner, claim_generation)`. A result from a process whose claim was taken over matches no row and is refused STALE_CLAIM; a result whose response was lost and is resent finds the job already terminal and is answered `accepted: false` rather than applied twice — which is also what keeps the comment at one per job, the terminal check being the only thing between a resend and a second copy. The receipt below it carries its own key (`mr:v1` over session, source SHA, target branch and result), so even a second application would add no second receipt.",
    isolation: '',
    attempts: 4,
    replay: "Everything is re-read inside the closure: the job row, its lease, and whether it is already terminal. A re-run after a conflict therefore re-decides against the committed world rather than replaying a decision made outside it. The writes it implies are idempotent in their own right — `createMany({ skipDuplicates })` on the receipt, and the partial unique index over OPEN items on the exception — except the comment, which is not keyed and does not need to be: a rolled-back attempt takes it with it, and the terminal check above means the only path that could write a second one is already spent. The reads it adds — the task's work sessions, for whether a no-commit answer is a fact about the task or about the branch it was handed, and the state of the candidate a promotion job's failure is about, for whether it is still live and owed an item at all (§4.2) — are inside the same closure and re-decided with it. Closing a moved-on candidate's failures is a conditional UPDATE over its OPEN items, idempotent in its own right like the rest.",
    effects: 'None inside. The receipt and the item are rows; delivering the item and dispatching what the landing released happen in the controller, after this commits, and both are re-derivable from the committed rows.',
    answer: 'Typed 503 from the global boundary, which the runner treats as "not delivered" and resends. The work itself already happened in the repository, so nothing is lost by making it say so again; what the resend must not do is land a second time, and the terminal check above is what stops it.',
  },
  {
    at: 'projects/project-promotion.service.ts#considerCandidate',
    shape: 'TX_RETRIED',
    locks: 'project_codebase (rank 55) and project_integration_job (rank 60) are read unlocked, then the rows it writes: project_promotion (rank 60) for the new candidate and for whichever older one it supersedes, project_integration_job (rank 60) for that one\'s queued check, project_open_item (rank 60) for that one\'s card and the failures about it it had open (`closePromotionItems`, §4.2). Nothing above rank 60 is locked — the foreign keys take `project`, `task` and `session` FOR KEY SHARE, which no status write conflicts with.',
    identity: 'The candidate\'s source: the partial unique index over `(project_id, source_ref)` on live states. Two landings finishing together therefore produce one live candidate whichever order they commit in — the loser of the index is the transaction that is re-run, and its re-run finds the winner already covering the same tip and makes nothing.',
    isolation: '',
    attempts: 4,
    replay: 'Everything is re-read inside the closure: whether the queue is empty, which landing is newest, whether a promotion is already in flight, and whether this tip is already covered. A re-run after a conflict therefore re-decides against the committed world; it cannot make a second candidate for a tip that now has one, and it cannot make one for a tip a concurrently committed landing has already moved past.',
    effects: 'None inside. The check job it queues is a row; the runner picks it up on its next heartbeat, from the committed queue.',
    answer: 'Nothing is answered — no request is waiting on this. The caller logs the failure and the next landing considers the same rows again, which is why the exhausted case is a warning rather than a 503.',
  },
  {
    at: 'projects/project-promotion.service.ts#decide',
    shape: 'TX_RETRIED',
    locks: 'project_promotion (rank 60) by primary key, then what the decision implies: project_integration_job (rank 60) for the landing it queues or the job it asks to stop, and project_open_item (rank 60) for the owner\'s card and — when the candidate is declined or cancelled — the failures about it it had open (`closePromotionItems`, §4.2), after the card. The project row is read for its owner BEFORE the transaction and is not locked — the answer to "whose account is this" cannot change under a confirmation.',
    identity: 'The promotion and the state it must still be in: every write is a conditional UPDATE naming it (`state = \'READY\'` for a confirmation, the state just read for the rest). Two presses of one button therefore queue one landing — the second matches no row and is answered 409 PROMOTION_NOT_READY — and a press against a card an older candidate was drawn from is refused by the source SHA before any of it.',
    isolation: '',
    attempts: 4,
    replay: 'The promotion row is re-read inside the closure and every refusal is re-decided from it, so a re-run after a conflict answers what the committed world says rather than what the first attempt read. The landing job it queues carries the idempotency key `ij:v1:LAND_PROMOTION:<promotionId>:<generation>`, so a re-run that has already inserted one inserts none.',
    effects: 'None inside. What follows the commit is the runner claiming the queued job on its own beat.',
    answer: 'Typed 503 from the global boundary; the owner presses again, and the CAS above is what makes that safe.',
  },
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
    at: 'projects/wake-disposition.service.ts#raiseBlocker',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_blocker (rank 60). Monotone and short: the five observations the disposition is a function of are read before the transaction opens, because they are rows this unit does not write and locking them would be holding the project against readers for the length of a decision it has already made.',
    identity: 'The open episode key `<kind>:<reason>:<taskId>`, enforced by the partial unique blocker index over unresolved rows. A redelivery of the same unlanded-criterion fact finds the question already asked and inserts nothing, which is what keeps "a person has to look at this" one notification rather than one per delivery.',
    isolation: '',
    attempts: 4,
    replay: 'Nothing is derived inside the closure: the disposition is decided before it opens, and the statement is one conditional INSERT. A re-run after a conflict re-issues the same INSERT under the same key and either wins it once or finds the winner. `lifecycleGeneration` is allocated from MAX inside the statement, so a re-run cannot skip a generation either.',
    effects: 'None. One database row; the caller returns the kind to the delivery it came from and performs no merge, no dispatch and no task write.',
    answer: 'The post-commit caller logs the exhausted conflict. The fact stays exactly as true as it was — the work is still finished and still off `main` — so the next delivery of it asks the same question again.',
  },
  {
    at: 'projects/coordinator-convergence.service.ts#judge',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_convergence_decision (rank 60). Monotone, and nothing above the project is reached for: the measurement reads `task`, `task_verification_finding`, `project_acceptance_criterion_definition` and `project_blocker` without locking any of them, because the only writer it has to be serialised against is another judgment of the same project — which is holding the same project row.',
    identity: 'The FACT, above the closure: `wakeConvergenceKey(projectId, scopeHash, wake.idempotencyKey)`, where the wake key is T2\'s identity of the committed fact. A re-run re-derives the same key from the same fact, reads the committed judgment and writes nothing — which is what stops a redelivery from recording a second judgment of the same fact.',
    isolation: '',
    attempts: 4,
    replay: 'Everything the judgment is a function of is read inside the closure under the project row lock: the resolved thresholds, the last committed decision (counters, previous vector, previous outcome) and the four evidence projections. `planWakeConvergence` is pure and reads no clock, so a re-run against the same committed world plans the same decision; a re-run against a world that moved plans the newer one, which is the answer that should be committed.',
    effects: 'None inside. The ledger INSERT is a database write and is not visible outside the transaction until it commits.',
    answer: 'Typed 503 from the global boundary. A wake that could not be judged is not a wake that was allowed: T2 releases the key on a throw, so the fact stays deliverable and the next pass judges it.',
  },
  {
    at: 'projects/project-fuse.service.ts#evaluate',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), then project_fuse_episode and project_open_item (rank 60), whose foreign keys re-check `project` FOR KEY SHARE. Monotone, and the same order the judgment ledger takes: the only writer this has to be serialised against is a second crossing fact of the same project.',
    identity: 'The PROJECT, not the crossing fact: at most one episode of a project is open (the partial unique index), and the closure re-reads it under the lock before inserting. Two crossing facts arriving together therefore open one pause and both return it — which is right, because a pause is a state of the coordinator and not a record of the row that revealed it.',
    isolation: '',
    attempts: 4,
    replay: 'The reading is taken BEFORE the closure and passed in, so a re-run writes the same episode from the same numbers rather than re-measuring a world that moved by a millisecond. Everything inside is re-derived under the lock: whether a pause is already open, the owner, and the next generation.',
    effects: 'None. Notifying the owner is not this unit\'s and is not done here.',
    answer: 'Typed 503 from the global boundary to whichever post-commit edge asked — all of which swallow and log it, because a fuse that could not be read must not fail the event batch or task write it was read on. The next crossing fact reads it again.',
  },
  {
    at: 'projects/project-fuse.service.ts#holdIfPaused',
    shape: 'TX_RETRIED',
    locks: 'project_fuse_episode FOR NO KEY UPDATE (rank 60), then project_fuse_held_action and project_open_item (rank 60). Nothing above rank 60 is taken: the episode row is what `seq` is allocated under and what a concurrent resume contends with, and the card is this episode\'s own child.',
    identity: 'The `seq` allocated under the episode row lock. A door that asks twice holds twice, deliberately: two spawn requests are two things the coordinator asked for, and dropping the second would lose it rather than hold it.',
    isolation: '',
    attempts: 4,
    replay: 'The episode is re-read under its lock each attempt, so an action arriving as the owner resumes either holds under the still-open episode or finds it gone and returns null — in which case the caller performs the action, which is what a resumed fuse means.',
    effects: 'None inside. The caller performs or withholds its action on the answer.',
    answer: 'Typed 503 to the door the agent knocked on. Nothing was held and nothing was performed, so a retried call is one request again.',
  },
  {
    at: 'projects/project-fuse.service.ts#resume',
    shape: 'TX_RETRIED',
    locks: 'project_fuse_episode FOR NO KEY UPDATE (rank 60), then project_open_item (rank 60), then project (rank 40) only when the owner raised a limit. The project write is last and is the owner\'s own request rather than a lock this unit is ordered by; nothing else in this unit reaches above rank 60.',
    identity: 'The EPISODE, and the `resumed_at` it either has or does not: the read is FOR NO KEY UPDATE and a second resume of the same episode answers 409 rather than resuming it twice. Migration 0284\'s trigger refuses the rewrite as well, so a path that skipped this door still cannot.',
    isolation: '',
    attempts: 4,
    replay: 'Every decision is re-read under the episode lock — whether it is still open, which items are still OPEN, what the project\'s overrides are. The replay and the re-derivation deliberately sit OUTSIDE the closure: an attempt that rolled back must not have spawned sessions.',
    effects: 'After commit, and only then: each held action goes back through its own door, and each fact refused during the pause is re-derived through the router. Both are idempotent against the rows this transaction wrote — a replayed action is no longer HELD, and a re-derived fact is claimed by its own key.',
    answer: 'Typed 503 to the account owner. Nothing was resumed, nothing was replayed, and the card is still on their screen to press again.',
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
    at: 'projects/project-acceptance.service.ts#start',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40) — the lock projects.update takes before it writes the same authorization columns — under which the criteria definitions are read for the seal; then this project’s binding FOR UPDATE (rank 55) through projects/project-integration-line.ts#startProjectLine and #configureProjectIntegration, which also inserts the binding ON CONFLICT DO NOTHING when the project has none and its coordination workspace names a repository; then the project row it already holds, written once (`coordinator_enabled` and `max_concurrent_tasks` where they change, `config_revision`, `started_at`) — the completion-contract trigger takes project_completion_contract when an authorization column moves; then one project_standard_set_confirmation row (rank 60), whose foreign key takes the held project FOR KEY SHARE; then the project’s OPEN start request, if it has one (project_open_item, rank 60), resolved APPROVED through projects/project-start-request.ts#answerStartRequests.',
    identity: 'The project id, the criteria digest and the settings — the owner’s, or for the older confirmation door the defaults derived inside the closure — all fixed before or re-derived within each attempt. `started_at IS NULL` is both the refusal read under the rank-40 lock and the predicate of the write, so a second start of one project matches no row: the first to commit is the start, and every later attempt or press is 409 PROJECT_ALREADY_STARTED with nothing written.',
    isolation: '',
    attempts: 4,
    replay: 'Every input is re-read under the locks on each attempt: whether the project has started, the seal the digest is compared with, whether the line has started integrating and where it is, and the current Automatic and concurrency values the bump is decided against. A retried attempt that finds the project started, the seal moved or the line locked answers exactly as a first attempt against those rows would have — refused before its first write, or with the line left where it is.',
    effects: 'None inside. After it resolves the coordinator conversation is told (projects/project-started.ts#tellCoordinatorProjectStarted, one `sessions.createTurn` keyed by the confirmation this transaction wrote) and `project.status` is re-projected (projects/project-done-derived.ts#storeDerivedProjectStatus); a telling or a projection that fails is logged and costs the start nothing.',
    answer: 'Typed 503 from the global boundary. A start that has committed is a 409 PROJECT_ALREADY_STARTED on the re-issue, never a second start.',
  },
  {
    at: 'projects/project-acceptance.service.ts#recordProjectDone',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40), the lock `start` takes; the criteria are read under it (rank 60, read, not locked); then the DONE_REQUEST the press answers, when it names one, by SELECT … FOR UPDATE (rank 60). Then one UPDATE of the project row this transaction holds, and one UPDATE of the project\'s OPEN DONE_REQUEST items (rank 60, projects/project-done-request.ts#answerDoneRequests). Ascending throughout.',
    identity: 'The owner, the project, the seal the owner read and the request the card was drawn from (or none, for a press nobody asked for). The project lock makes concurrent presses one decision after the other: the later one re-reads the seal and the request, so it records again or is refused.',
    isolation: '',
    attempts: 4,
    replay: 'Every fact the press is refused on — a cancelled project, a seal that is not the current one, a request that is gone, no longer OPEN or about another seal — is re-read under the locks inside the closure, before the first write, so a retried attempt refuses or writes exactly as a first one would. The two UPDATEs roll back together.',
    effects: 'None inside, and none after: the record is what the projection reads on its next edge (projects/project-done-derived.ts#storeDerivedProjectStatus), and nobody is told of the owner\'s own press.',
    answer: 'Typed 503 from the global boundary. A refusal is a 403 (an acting session, before the closure) or a 409 with nothing written; a re-press after a commit records again, at its own instant.',
  },
  {
    at: 'projects/project-open-item.service.ts#requestStart',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40) — the lock projects/project-acceptance.service.ts#start takes first, so a request and a start of one project are ordered and no request is filed about a project that has just started — under which the plan is read unlocked (the criteria definitions, the tasks, their dependency edges, and the binding or the coordination workspace for the repository); then project_open_item (rank 60): the request already open, if there is one, superseded by primary key, and one new START_REQUEST row, whose foreign key takes the held project FOR KEY SHARE.',
    identity: 'The project id, the acting session, the suggested settings and the reason, all fixed before the closure. A project holds at most one OPEN request — every request shares one dedupe key under 0278’s partial unique index on OPEN items — and a request identical to the open one (settings, reason, digests and warnings) is answered with that row and writes nothing, so a call retried after a lost response files no second request.',
    isolation: '',
    attempts: 4,
    replay: 'Every input is re-read under the project lock on each attempt: whether the project has started, which conversation coordinates it, the plan the readiness check and both digests are computed from, and the request open now. A retried attempt refuses, supersedes or answers with the open row exactly as a first attempt against those rows would have.',
    effects: 'None.',
    answer: 'Typed 503 from the global boundary. A request that committed is answered with the same row on a re-issue (alreadyOpen), never a second one.',
  },
  {
    at: 'projects/project-open-item.service.ts#retryIntegration',
    shape: 'TX_RETRIED',
    locks: 'task FOR NO KEY UPDATE (rank 50) — the row lock the DONE transaction holds when it queues a landing (projects/project-integration-job.ts#enqueueForDoneTask), so a rerun and a DONE of one task are ordered and read one generation counter — under which the project, the task\'s newest LAND_TASK, its OPEN integration items, its open owner blockers, its work sessions and the project_codebase (rank 55) are read unlocked; then project_integration_job (rank 60): one new LAND_TASK through projects/project-integration-job.ts#queueLandTask, whose foreign keys take the held task and the session FOR KEY SHARE; then project_open_item (rank 60): the coordinator\'s OPEN integration items of that task, marked as being handled by that generation through projects/project-open-item.ts#markOpenItemsHandling — still OPEN, ended by the generation\'s own result (§4.7 H1).',
    identity: 'The task, the acting session and the reason, all fixed before the closure. One task holds at most one QUEUED-or-RUNNING landing — J3\'s partial unique index — and a generation is keyed `ij:v1:LAND_TASK:<taskId>:<generation>`, so a call retried after a lost response finds the generation it queued in flight and is refused INTEGRATION_RETRY_IN_FLIGHT rather than queueing a second.',
    isolation: '',
    attempts: 4,
    replay: 'Every input is re-read under the task lock on each attempt: the task\'s status, which conversation coordinates the project and whether it is Automatic, the newest landing and its state, the open items and blockers, and the branch the task\'s work is on. A retried attempt refuses or queues exactly as a first attempt against those rows would have.',
    effects: 'None. The landing it queued is handed out by the next heartbeat (runner-api/integration-job-relay.ts#dispatchIntegrationJobs) from the committed row.',
    answer: 'Typed 503 from the global boundary. A rerun that committed is refused INTEGRATION_RETRY_IN_FLIGHT on a re-issue, never queued twice.',
  },
  {
    at: 'projects/project-open-item.service.ts#retryPromotionCheck',
    shape: 'TX_RETRIED',
    locks: 'project_promotion FOR NO KEY UPDATE (rank 60) — the row every other writer of a candidate takes by updating it (the job-result transaction through applyPromotionJobResult, the owner\'s doors, the supersession of a new landing), so a re-check and any of them are ordered — under which the project, the candidate\'s newest job and its OPEN integration items are read unlocked; then project_integration_job (rank 60): one new CHECK_PROMOTION through projects/project-promotion.service.ts#requeuePromotionCheck, whose foreign keys take the held candidate and the session FOR KEY SHARE, and the held candidate written back to CHECKING; then project_open_item (rank 60): the coordinator\'s OPEN items about the candidate, marked as being handled by that check (projects/project-open-item.ts#markOpenItemsHandling).',
    identity: 'The candidate, the acting session and the reason, all fixed before the closure. The candidate leaves BLOCKED in the same transaction and its new check is QUEUED, so a call retried after a lost response finds the check in flight and is refused INTEGRATION_RETRY_IN_FLIGHT rather than queueing a second.',
    isolation: '',
    attempts: 4,
    replay: 'Every input is re-read under the candidate lock on each attempt: its state, which conversation coordinates the project and whether it is Automatic, the newest job and its state, and the open items. A retried attempt refuses or queues exactly as a first attempt against those rows would have.',
    effects: 'None. The check it queued is handed out by the next heartbeat (runner-api/integration-job-relay.ts#dispatchIntegrationJobs) from the committed row.',
    answer: 'Typed 503 from the global boundary. A re-check that committed is refused INTEGRATION_RETRY_IN_FLIGHT on a re-issue, never queued twice.',
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
    locks: 'For a title write with a bound coordinator: that Session FOR UPDATE first (rank 30), then project FOR NO KEY UPDATE (rank 40). A write carrying integration settings then takes this project’s binding FOR UPDATE (rank 55). Every path then takes project_acceptance_criterion_definition children (rank 60) as needed and writes only rows it already holds. A pointer that changed between the rank-30 pre-read and rank-40 validation aborts and retries with the new Session.',
    identity: 'The project id and the DTO, both outside the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The row is re-read under its own lock and every derived decision — coordinator rebind, managed title sync, whether the older Automatic switch pauses the project or lifts the pause it wrote (`paused_at`/`paused_reason`, projects/project-pause.ts#legacySwitchPauseWrite, from the `started_at` and pause read under that lock), and whether this write turned the project on — comes from that read. A requested status other than DONE clears the DONE record in the same statement (`done_*`, `accepted_gaps`), from the DTO alone. Pointer drift is retried from a fresh pre-read rather than locking downward.',
    effects: 'None inside; the control-plane publishes (`project.changed` when the older switch paused or resumed the project), and — when this write turned the project on — the one turn telling its conversation (projects/project-started.ts#tellCoordinatorProjectStarted), are after this resolves.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'projects/projects.service.ts#pause',
    shape: 'TX_RETRIED',
    locks: 'Through projects/projects.service.ts#writePause: project FOR NO KEY UPDATE (rank 40) — the lock projects.update and the start take before they write the same row — and then that row, written once (`paused_at`, `paused_reason`). No trigger on `project` fires on either column.',
    identity: 'The project id, outside the closure, and the door itself: this is pause and never resume. Idempotent by value: pausing a paused project writes nothing (a pause the older Automatic switch wrote becomes the owner’s, same instant).',
    isolation: '',
    attempts: 4,
    replay: 'Whether the project has started, whether it is paused and by whom are read under the lock on every attempt, and the write is decided from them (projects/project-pause.ts#ownerPauseWrite). A retried attempt that finds the project already where the press would put it writes nothing, which is what a first attempt against those rows would have done; one that finds it unstarted is the same 409.',
    effects: 'None inside. After this resolves, and only when a row changed, the `project.changed` publish is sent and the project’s existing live coordinator conversation gets one ordinary turn keyed by the project id and the pause episode’s `paused_at` (projects/project-started.ts#tellCoordinatorProjectPaused). A telling that fails is logged and costs the pause nothing.',
    answer: 'Typed 503 from the global boundary; an unstarted project is the explicit 409 PROJECT_NOT_STARTED; a request from a session is the 403 before anything is read.',
  },
  {
    at: 'projects/projects.service.ts#resume',
    shape: 'TX_RETRIED',
    locks: 'Through projects/projects.service.ts#writePause: project FOR NO KEY UPDATE (rank 40) — the lock projects.update and the start take before they write the same row — and then that row, written once (`paused_at`, `paused_reason`). No trigger on `project` fires on either column.',
    identity: 'The project id, outside the closure, and the door itself: this is resume and never pause. Idempotent by value: resuming a project that is not paused writes nothing.',
    isolation: '',
    attempts: 4,
    replay: 'Whether the project has started, whether it is paused and by whom are read under the lock on every attempt, and the write is decided from them (projects/project-pause.ts#resumeWrite). A retried attempt that finds the project already where the press would put it writes nothing, which is what a first attempt against those rows would have done.',
    effects: 'None inside. After this resolves, and only when a row changed, the `project.changed` publish is sent and the project’s existing live coordinator conversation gets one ordinary turn keyed by the project id and the lifted pause episode’s `paused_at` (projects/project-started.ts#tellCoordinatorProjectStarted with RESUME). A telling that fails is logged and costs the resume nothing.',
    answer: 'Typed 503 from the global boundary; a request from a session is the 403 before anything is read.',
  },
  {
    at: 'projects/projects.service.ts#configureIntegration',
    shape: 'TX_RETRIED',
    locks: 'This project’s binding FOR UPDATE (rank 55), and nothing else: ownership is established before the transaction opens, and the write touches one `project_codebase` row. A project with no binding yet inserts one ON CONFLICT DO NOTHING and then locks the row that insert — or a concurrent binder’s — left.',
    identity: 'The project id and the settings, both outside the closure. The binding is unique on (project_id, slot), so two configures of one project serialise on that row instead of making a second binding.',
    isolation: '',
    attempts: 4,
    replay: 'Every decision is re-derived inside the closure from the row the attempt locked: which line is decided, whether integration has started, and where the settings would move it. A retried attempt that finds the line started refuses with INTEGRATION_LINE_LOCKED, which is the answer a first attempt against those rows would have given.',
    effects: 'None inside. The view the caller gets back is the row this transaction wrote.',
    answer: 'Typed 503 from the global boundary; a line that has started stays the explicit 409.',
  },
  {
    at: 'projects/projects.service.ts#decideCriteriaChange',
    shape: 'TX_RETRIED',
    locks: 'project FOR NO KEY UPDATE (rank 40) — the same lock and the same order projects.update takes before touching definitions — then, for an APPROVE only, project_acceptance_criterion_definition children (rank 60) and — when the newest confirmation named the seal the edit started from — one project_standard_set_confirmation row (rank 60) naming the seal it produced, and inserts into project_criteria_decision and project_ratified_action_commit keyed by the intent this transaction already read.',
    identity: 'The project id, the intent id and the commit token, all three outside the closure. `project_criteria_decision.intent_id` is the primary key, so a second decision for one proposal is refused by the database rather than by the read above.',
    isolation: '',
    attempts: 4,
    replay: 'Every input is re-read under the project lock on each attempt: the intent, whether it is already settled, and the seal the decision is checked against. A retried attempt that finds the seal moved or the proposal settled refuses instead of applying — which is the same answer a first attempt would have given against those rows.',
    effects: 'None inside. The derived-status re-projection, the reply to the proposing session (projects/criteria-decision-reply.ts#sendCriteriaDecisionReply) and the confirmation read are after this resolves; none of them can undo the decision.',
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
    at: 'sessions/sessions.service.ts#importSession',
    shape: 'TX_RETRIED',
    locks: 'pg_advisory_xact_lock(4000274, hash of the Claude session id) — the import-claim serializer, one session-wide key rather than a row — then the live-session claimed check and the one new session INSERT.',
    identity: 'The Claude session id: the claimed check under the advisory lock makes a re-run of the same import find the committed row and answer the 409, and a re-run of two concurrent imports of the same transcript serializes to one row.',
    isolation: '',
    attempts: 4,
    replay: 'Nothing is derived inside the closure — title, branch, permission and effort were resolved above it. The refusal path (an id already imported) is re-derived from the fresh snapshot and thrown on every attempt alike.',
    effects: 'None inside. `notifySessionQueued` and the created publish are after the transaction resolves.',
    answer: 'Typed 503 from the global boundary; every refusal (bad id, wrong workspace, claimed) is already a 400/403/409 with its own sentence.',
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
    at: 'providers/pool-notice.ts#carrier',
    shape: 'TX_RETRIED',
    locks: "session FOR UPDATE (rank 30), then one conversation_turn INSERT (the session's child), whose foreign key re-check is on the row already held.",
    identity: "The session, and a clientTurnId minted once per call outside the closure's reads: a re-run inserts the one `reload` the aborted attempt did not commit, at the seq read again under the lock.",
    isolation: '',
    attempts: 4,
    replay: "The seq is max(seq)+1 read under the Session lock inside the closure, as every producer of a turn allocates it, so a re-run after a conflict takes the sequence the winner left. Two callers, both a claim (buildSession): QueueService.resolveSharedPool, when it moved a shared-pool session onto another key, and QueueService.resolveLoginPool, when it moved a login-pool session onto another account or the login pools' gateway had owed the session a line (its account spent or signed out). A second carrier queued before the first is answered earns a second `resumed` that carries nothing. Retried under the label it had as QueueService.queueSwitchNoticeCarrier, so its metric reads on.",
    effects: "After commit: realtime.notifyInbox, which only wakes the runner's inbox poll and is re-derivable from the committed row.",
    answer: 'Typed 503 from the global boundary, which fails the claim that asked; the runner claims again.',
  },
  {
    at: 'providers/pool-login-gateway.service.ts#rotate',
    shape: 'TX_BARE',
    locks: "One pool_codex_login row FOR UPDATE — the account being refreshed — then an UPDATE of that same row. No trigger on pool_codex_login; its foreign key to provider_pool is not re-checked by an UPDATE that leaves (pool_id, user_id) alone. No session, task or runner row.",
    identity: "The (pool_id, account_id) row, and the access token the caller was refused on: a caller that finds a different token there sends on it rather than refreshing again.",
    isolation: '',
    attempts: 1,
    replay: "Not retried, on purpose: the closure spends the row's refresh token at OpenAI's token endpoint, and a refresh token is good ONCE — a re-run after a conflict would send it again and be refused `refresh_token_reused`, signing a good login out. It cannot deadlock with anything (one row lock, taken first), and the row lock is what makes a second process — or a second request of this one, which PoolLoginGatewayService.refresh already coalesces — wait and then use the pair the first one stored. The lock is held across the token endpoint's answer (bounded by REFRESH_TIMEOUT_MS) and never while a response streams.",
    effects: "Inside, deliberately: the HTTPS POST to the token endpoint, which is the whole point of holding the lock. After: the request is sent to the Codex backend on the new token; a refusal is recorded by CodexLoginService.markSignedOut outside this transaction.",
    answer: "Any failure — the endpoint unreachable, a lock not granted within maxWait, the transaction's own timeout — is `UNREACHABLE`: the codex request that needed the refresh is answered 502 and its codex's own retries ask again. Nothing is marked; the pair stored before stays.",
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
    locks: 'session FOR UPDATE (rank 30), then conversation_turn FOR UPDATE SKIP LOCKED and the claim UPDATE (rank 60). The wiki context this delivery may carry (wiki/wiki-push.ts) writes only wiki_exposure rows (rank 60) under the KEY SHARE its entry foreign keys take, so it adds no edge above the lock already held. Every other read the delivery makes — the session context, the references, a list\'s conditions, the background jobs, a coordinator\'s role — is a plain SELECT on the row already locked.',
    identity: 'The runner and lease generation asking; the claimed turn is chosen inside.',
    isolation: '',
    attempts: 4,
    replay: "A deadlock victim's claim never happened — the row is still queued — so a re-run claims from the state that exists rather than reporting a turn it does not own. Each block appended to the delivery is re-decided from rows read inside the closure, and the wiki exposure rows a rolled-back attempt wrote go with it, so a retry records the same deliveries once.",
    effects: 'None. Nothing is sent to the runner until this returns.',
    answer: 'Typed 503; the runner polls again and the turn is still queued.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#turnComplete',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE via lockSessionLeaseOwner (rank 30); conversation_turn ACK and blocker/comment children (rank 60), then the database-maintained task dispatch epoch (rank 70). Since 2026-09-02 an acceptance callback writes no criterion fact and no task status at all, so it reaches neither the project nor the task row. Later llm_usage and session_diff writes add no wait edge because their Session parent is already held. One write of the Session row per transaction (I3).',
    identity: 'The turn id, usage and shell result in the request body are outside the closure. The OPEN request is already uniquely bound to criterion revision and evidence digest; its executable result is unique by request. A queued acceptance turn binds its expected exit code in client_turn_id, so a retry compares the same evidence rather than a declaration edited while it ran. The callback uses `legacy-v1-turn-complete:<turnId>:<evidenceDigest>` plus the unique request fact and request-result keys, and retains the Session/turn/runner/lease identity.',
    isolation: '',
    attempts: 4,
    replay: 'The duplicate-ack check, park, merge-state clear and billing accrual are all taken from rows read under their locks inside the closure. The command result, request decision, derived task status and raw-output comment — or the mutually exclusive unavailable signal — are written only by the same first ACK; a victim leaves all of them absent, and a retry re-locks the current declaration/request before deriving anything. The bridge finds-or-creates the exact evidence/request fact inside the same transaction and verifies a standing result byte-for-byte before deciding it, so a rollback exposes none and an OPEN+result retry never attempts a second unique result. The acceptance shell turn a message turn owes is queued only by the completion that ANSWERS that turn, and is looked up by its `(session_id, client_turn_id)` key before it is inserted: a turn put back in the queue completes a second time, and a round already standing for it is its round rather than a unique violation that fails the whole ACK.',
    effects: 'None inside; attempt-budget accounting, EXECUTABLE_RESULT_RECORDED consumption and realtime publication are after commit. The input route is replayed even for a duplicate ACK so an authorization refusal does not burn the immutable result fact. A failed transaction appends CONTROL_PLANE_COMMIT_REJECTED only from a separate best-effort transaction after rollback; a committed ACK appends recovery outside the monitored transaction. Neither observation can turn the callback result into another 5xx, and the independent watchdog derives the same stable obligation if either edge write is absent.',
    answer: 'Typed 503; the runner re-posts the completion, which the duplicate-ack check absorbs.',
  },
  {
    at: 'runner-api/runner-api.controller.ts#events',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE via lockSessionLeaseOwner (rank 30), then run_event / tool_call / approval child rows (rank 60), then ONE session UPDATE (I3).',
    identity: 'The batch itself: `run_event` is unique on `(sessionId, seq)` with skipDuplicates, tool_call outcomes — and the PENDING approvals a returned call collects — are keyed by tool_use id, and the running sets are set-valued.',
    isolation: '',
    attempts: 4,
    replay: 'Every write in it is already idempotent, `durable` and `events` are derived from the request body above the closure, and the single Session write is accumulated from a row re-read under its lock on every attempt.',
    effects: 'The live broadcast, outside the loop — so a retried batch is published once, after the attempt that committed. That includes one approval_resolved frame per card the batch collected.',
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
    at: 'runner-api/runner-api.controller.ts#pinSessionSource',
    shape: 'TX_RETRIED',
    locks: 'session (rank 30) by primary key, through the conditional UPDATE that is the SOURCE pin or its refusal (`freezeSessionSourcePin`). Nothing above rank 30 is locked: the reads either side are plain, migration 0231\'s freeze guard is a trigger on the same row, and when the refusal is a WIN one task row (rank 50) is written by `recordDispatchRefusal` in the same transaction — ascending, and the `task_creator_session_id_fkey` re-check that write takes is on the session row already held.',
    identity: 'The compare-and-set itself. A re-issue of a request whose response was lost finds `sourceState` no longer SELECTED, matches no row, and is answered `wonRace: false` with the winner\'s pin or refusal — so a second attempt writes neither a second session state nor (having not won) a second task record.',
    isolation: '',
    attempts: 4,
    replay: 'The session row is re-read inside the closure on every attempt, so a re-run decides against the committed world: a pin another runner froze first is read back and adopted (SR30) rather than overwritten, and a refusal already frozen is reported without recording anything. The task write rides on the same conditional UPDATE — it happens only in the attempt that won it, so a rolled-back attempt leaves neither half.',
    effects: 'None inside. After commit: the session update is published to connected clients, and a refusal that won also publishes the task and hands it to `deliverDispatchRefusalAfterCommit` (the wake ledger, then a turn on the project\'s coordinator conversation).',
    answer: 'Typed 503; the runner re-sends the pin request, which the compare-and-set absorbs. The run stays unspawned meanwhile, and a later claim resolves again from scratch — allowed to reach a different commit, because nothing was frozen (§6.4, first row).',
  },
  {
    at: 'runner-api/runner-api.controller.ts#importResult',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE via lockSessionLeaseOwner (rank 30), then the session row writes (rank 30).',
    identity: 'The lease owner plus the ok/failure branch in the request; the ok branch is additionally keyed by the importSourceCwd CAS and the RUNNING status, which is what makes a retried ok a no-op rather than a re-applied title and a re-parked session.',
    isolation: '',
    attempts: 4,
    replay: 'The ok branch reads one thing inside the closure — whether an executable turn is already queued, which decides whether the session parks at AWAITING_INPUT or goes back to PENDING for it. That is a fresh read under the row lock, so a re-run cannot apply a stale answer. The branch matches only a row that still carries the marker and is still RUNNING, so after a committed first attempt the re-run applies nothing; the failure branch re-writes the same FAILED + deletedAt shape, which the LIVE filter already excludes.',
    effects: 'publishSessionUpdated is outside the loop — a retried attempt publishes once, after the attempt that committed.',
    answer: 'Typed 503; the runner re-posts the import result.',
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
    at: 'runner-api/runner-api.controller.ts#scheduledWakeup',
    shape: 'TX_RETRIED',
    locks: "session_scheduled_wakeup only (rank 60): the session's waiting wakeup, if there is one, is marked SUPERSEDED and the new one inserted. No parent row is locked — the session is never waited on here — and the delivery that settles a wakeup (createTurn's coalesce, under the Session lock) reaches the same child row after its parent, so the two meet on that row alone.",
    identity: 'None above the closure: every request is a new wakeup. The partial unique index over PENDING rows keeps one waiting wakeup per session.',
    isolation: '',
    attempts: 4,
    replay: 'Both statements are re-issued from the request alone; an aborted attempt committed neither, so a re-run supersedes the same waiting row and inserts once.',
    effects: 'None inside. The receipt is returned after commit; nothing is queued or broadcast, because nothing is due yet.',
    answer: "The global typed 503. The agent's schedule_wakeup call reports the failure, and the wakeup it would have replaced is still waiting.",
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
    at: 'runners/codex-rate-limit-reset.repository.ts#transition',
    shape: 'TX_RETRIED',
    locks: 'The one codex_rate_limit_reset_operation row, FOR UPDATE, then its UPDATE. No key column changes, so no foreign key is re-checked, and 0255\'s guard trigger reads only OLD and NEW of that row.',
    identity: 'The operation id. The state to write is decided by `decide` from the row read under the lock, on every attempt.',
    isolation: '',
    attempts: 4,
    replay: '`decide` and `codexResetTransitionViolations` run against the locked row rather than anything read before the transaction, so a re-run decides against the state that is actually there.',
    effects: 'None inside.',
    answer: 'Typed 503; the caller re-issues the transition, which is decided again against the current row.',
  },
  {
    at: 'runners/codex-rate-limit-reset.service.ts#create',
    shape: 'TX_RETRIED',
    locks: 'Reads until the one INSERT, which takes FOR KEY SHARE on its user and runner rows through the two foreign keys, and waits on a unique-index entry that a concurrent confirmation of the same request, or of the same runner and account, has not committed yet. No runner row is locked by name, so a heartbeat writing it is never waited for.',
    identity: '`clientRequestId`, chosen by the client once per confirmation and reused by every retry. The operation id and the provider idempotency key are generated per attempt, and an attempt that rolled back never wrote either.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-reads the request id, the active operation and the runner before inserting, and the INSERT is ON CONFLICT DO NOTHING, so a re-run finds what an earlier or concurrent attempt committed (a replay, or the operation in flight) or inserts the one row.',
    effects: 'None inside.',
    answer: 'Typed 503; the client re-sends the same clientRequestId and is answered with the replayed operation.',
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
    at: 'watches/watches.service.ts#create',
    shape: 'TX_RETRIED',
    locks: 'Unlocked reads of the named task (with its progress row), session and approval rows first — the permission check and the snapshot are the same read — then the new watch row, whose foreign keys take FOR KEY SHARE on the owner user (rank 10) and, for a SESSION observer, on that session (rank 30), in that order, and whose idempotency key is where two creates with one key meet; then the owner\'s transaction-scoped advisory lock (assertCapacity), taken by nothing else and never waited for: it is `pg_try_advisory_xact_lock`, and a create that finds it held rolls back and asks again between attempts, outside any transaction (awaitOwnerTurn), so no create waits on that lock while it holds a row or a connection; then unlocked reads of the live watches of that owner and of their targets; then watch_target, watch_match and watch_delivery rows only this transaction can see. Monotone, and no row another transaction can see is written.',
    identity: 'The account-scoped `idempotencyKey` when the request carries one, enforced by `watch_owner_idempotency_key`: a concurrent twin that loses the insert, and a later retry, both read the committed watch back instead of making a second. Without a key every request is a new watch.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-reads the targets and decides the predicate again inside the closure, and writes only rows it creates, so a rolled-back attempt leaves nothing for the next one to meet. The same argument covers the runs outside the retry: a unit rolled back because another create of the account held its turn, or ended by a P2028 that wrote nothing (it could not start in time, or its timeout rolled it back before the commit), runs again whole once the turn is free.',
    effects: 'None inside. The delivery it records is a PENDING row for the delivery worker; the response is read after commit, and the `watch.changed` announcement is published after that — never on the idempotent replay, which changed nothing, and never from inside the closure, where a retried attempt would publish one per attempt.',
    answer: 'Typed 503; the client re-sends, and a key makes the re-send the same watch. A create that has not had its turn when its wait runs out (10s by default) answers the same TRANSIENT_DB_CONFLICT body itself, having written nothing.',
  },
  {
    at: 'tasks/task-progress.service.ts#report',
    shape: 'TX_RETRIED',
    locks: 'The task row FOR KEY SHARE (rank 50), which a status write\'s FOR NO KEY UPDATE does not wait on, then the task\'s one task_progress row (rank 60): inserted empty when missing, then FOR UPDATE, then updated. The same order as `task_progress_epoch_advance`, which writes that row while the status UPDATE that fired it holds the task row.',
    identity: 'The task id: one progress row per task. A report carrying `expectedRevision` is a compare-and-set on the revision read under the row lock, so of two reports with one expectation exactly one lands and the other answers 409.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-reads the task status and the progress row under their locks and merges the report into what it reads, so a re-run decides from the rows as they now are; a report that changes nothing writes nothing.',
    effects: 'None inside. The task.changed hint is published after the commit.',
    answer: 'Typed 503; the reporter re-sends, and `expectedRevision` makes the re-send land at most once.',
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
    at: 'sessions/sessions.service.ts#seedOpeningTurn',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the conversation_turn insert and the attachment rows it links to that turn (rank 60).',
    identity: "The opening turn's fixed `initial-<session id>` clientTurnId — the one the claim and every other seeder of that turn use.",
    isolation: '',
    attempts: 4,
    replay: 'A victim wrote no turn and linked nothing, so a re-run seeds once. Whether the turn already exists is read under the Session lock inside the closure (`ensurePromptSeeded`), so a re-run that finds a seeder got there first writes nothing.',
    effects: 'None inside. `create` wakes the claim queue after this commits.',
    answer: "Typed 503 from the global boundary, after `create` has committed the session — create's own statements are not atomic with this one.",
  },
  {
    at: 'sessions/sessions.service.ts#createTurn',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30) — deliberately blocking, because this is where a user turn serializes against the claim and against turnComplete — then the optional orchestration task_attempt charge, the background_job_wake a coalescing wake files, the session_scheduled_wakeup a due wakeup settles, and conversation_turn/startup receipt children (rank 60); for a Watch wake, the delivery row its acknowledgement writes through `participateSendTransaction`, which no transaction holding a delivery row waits on a session for.',
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
    locks: 'session FOR UPDATE (rank 30), then the optional orchestration task_attempt charge and conversation_turn children (rank 60).',
    identity: 'The session id plus the derived interrupt clientTurnId; a follow-up stores its full payload on that durable control receipt.',
    isolation: '',
    attempts: 4,
    replay: 'Decided from the Session row re-read under its lock.',
    effects: 'None inside; the runner is told after commit.',
    answer: 'Typed 503; the client re-presses.',
  },
  {
    at: 'sessions/sessions.service.ts#cancelQueuedTurn',
    shape: 'TX_RETRIED',
    locks: "session FOR UPDATE (rank 30), then the withdrawn turn's own children (rank 60) — the Watch delivery its wake acknowledged, the background_job_wake rows and session_scheduled_wakeup a `bg-wake:` turn carried — and the conversation_turn delete.",
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
    at: 'sessions/sessions.service.ts#switchAccount',
    shape: 'TX_RETRIED',
    locks: 'session FOR UPDATE (rank 30), then the session write and, on a live session that moves, the reload turn.',
    identity: 'The account the request names, above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'A locked re-read decides where the session is and whether it moves.',
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
    at: 'sessions/sessions.service.ts#move',
    shape: 'TX_RETRIED',
    locks: "The workspace the move names FOR SHARE (rank 15) when it names one — only a live, enabled workspace of the caller's, as rebindCoordinator holds its landing, so it cannot be deleted or disabled under a move into it — then the target session_folder FOR KEY SHARE (rank 25) when the move names one, then the session FOR NO KEY UPDATE (rank 30), then the one UPDATE of that row (here, or in moveToWorkspaceLocked for a move to another workspace) — whose workspace and folder foreign-key checks find those locks already held, whose runner check takes only the FOR KEY SHARE every session write takes (LOCK_ORDER_COMPATIBLE), and which re-checks each key once (I3: the row is written once). The reverse of nothing: a folder delete takes the folder (25) and then, through ON DELETE SET NULL, its sessions (30); a rename takes only the folder; a workspace delete takes the workspace FOR UPDATE and then waits on nothing.",
    identity: 'The session id and the requested workspaceId and folderId, read from the request outside the closure.',
    isolation: '',
    attempts: 4,
    replay: 'Every refusal, and whether the session is already where it was asked to go, is decided from the rows locked inside the closure — for a move to another workspace, every §5.2 condition asked again of the locked session; the write sets the columns to values derived from those rows and the request. A re-run writes the same row, or nothing.',
    effects: 'None inside. After commit: publishSessionUpdated when the folder changed; for a move to another workspace, forgetSessionOwner, publishSessionUpdated and publishWorkspaceChanged for the workspace left and the one joined.',
    answer: 'Typed 503 from the global boundary; the client sends the same move again.',
  },
  {
    at: 'task-lists/task-lists.service.ts#writePolicy',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10, I1 — kept after the task sweep left this transaction: the projector\'s chunks take the same mutex before writing task rows of this list, and remove() writes this row and those rows under it), task_list FOR UPDATE (rank 20), then session FOR NO KEY UPDATE (rank 30, one row per unfinished session of this list, and only when the ceiling itself changed — a list has as many of those as it has had dispatches in flight, not as many as it has tasks, over session_batch_id_status_idx), then task_list_revision (rank 60). It writes no task row at all, which is the point: the pause is a counter here and the rows are converged afterwards.',
    identity: 'The list id and the policy data, above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'The revision number, the seeded before-state, the stored `paused` and `maxConcurrent` each new value is compared against, and the epoch it is bumped from are all derived inside the closure from rows read under the two locks. The session convergence is decided from that same locked read, so a re-run re-decides the comparison rather than replaying it, and rows already carrying the value are not written again.',
    effects: 'None inside; the list-changed publish and the projector kick are after.',
    answer: 'Typed 503 from the global boundary.',
  },
  {
    at: 'task-lists/task-list-pause-projector.service.ts#sweepChunk',
    shape: 'TX_RETRIED',
    locks: 'task_list read UNLOCKED twice (the owner, then the decision after the lock below), then user FOR UPDATE (rank 10, I1 — a page writes more than one task row), then task FOR NO KEY UPDATE (rank 50, one keyset page taken in ascending id order), and on the page that completes a pass task_list FOR NO KEY UPDATE (rank 20, the watermark) — after rank 10, which is the order I1 states. A lock ON task_list is deliberately not taken: FOR UPDATE there is what the PATCH needs, and holding it for a page would put the request path behind the sweep, which is the shape this unit exists to remove.',
    identity: 'The page itself: list id, the epoch the pass started at, and the cursor id. Nothing is carried in from before the closure — the owner, the decision and the page are read inside it, after the locks — so a re-run names the rows of the world that won.',
    isolation: '',
    attempts: 4,
    replay: 'Every input is re-read inside the closure. If the decision moved while the attempt waited for the mutex, the epoch comparison returns without writing anything; otherwise the same keyset page is re-derived and `dispatch_hold <> target` makes the UPDATE a no-op for every row already carrying the value. The watermark UPDATE is guarded `pause_applied_epoch < epoch`, so a re-run cannot move it backwards either.',
    effects: 'None. One page of task rows, and on the final page of a completed pass the watermark. No publish and no notification: the resync a pause needs was published by the request that decided it, after that request committed.',
    answer: 'Typed 503 from the global boundary. A chunk that could not be retried loses no work — the watermark still names the list, so the next kick or the next catch-up tick re-claims it and re-runs the page. That is the same property that makes a projector killed mid-sweep resume. Its own wall-clock budget is declared (60s, `PAUSE_PROJECTION_CHUNK_TIMEOUT_MS`) rather than left at Prisma\'s 5s default: a page of records on a 27-index table is allowed to be slow, and a chunk that exceeds its budget kills only that chunk.',
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
    locks: 'task FOR UPDATE (rank 50), then task_completion_evidence and task_completion_evidence_idempotency (rank 60). The Session and optional TaskAttempt provenance reads take no row lock and no FK is written to either snapshot id.',
    identity: 'The evidence uses the caller idempotency key when supplied, otherwise the stable tuple (task, actor type/id, source Session, criterion revision, evidence digest). The request uses (task, criterion revision, evidence digest, request kind). All are unique in PostgreSQL, and the task mutex makes a concurrent new digest supersede the old OPEN request exactly once.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the Task, verifies the source Session belongs to it, derives the criterion snapshot, allocates MAX(revision)+1 and routes the request inside the closure. A committed retry key returns its original evidence/request even if criteria later changed; an older fact is never reopened or allowed to supersede the current request. If the locked Task is DONE, both a new fact and an exact replay converge every OPEN request to the audited no-successor terminal rule.',
    effects: 'None outside PostgreSQL inside. The transaction never updates Task/Session lifecycle state, comments, notifications or realtime; a EVIDENCE_JUDGMENT request insert trigger files its inbox item and device outbox in this same transaction but performs no push. After commit the evidence revision is consumed by the request derivation route, EVIDENCE_JUDGMENT request/supersession facts feed HUMAN_INBOX and nudge the durable delivery worker when needed, and only VERIFICATION is handed to the deterministic verifier-task upsert/dispatch. Replay converges on the same fact keys and request/task or request/version ledger key.',
    answer: 'Typed 503 from the global boundary after retry exhaustion; reused keys with different facts are an explicit 409.',
  },
  {
    at: 'tasks/task-completion-evidence.service.ts#decide',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50), then task_evidence_decision (rank 60), then the derived status back onto the task row this unit already holds. The deciding Session, the task\'s evidence rows and the project criterion definition are all read without a row lock: none of them is written here, and the only one a concurrent writer could move under this unit — the latest evidence revision — is allocated under the same task mutex this unit holds.',
    identity: 'The decision row is keyed by (task, evidence id), unique in PostgreSQL. There is deliberately no caller retry key: a decision names one immutable evidence revision, so that pair already IS the request identity and a second key could only let one version be answered twice.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the Task and re-derives all four checks inside the closure — the deciding session\'s independence, MAX(revision), the live criterion text and the existing decision. A committed decision replays as itself when the retry says the same thing and is a 409 when it does not, so a retried transport never turns one decision into two and never overwrites one.',
    effects: 'One derived Task status inside PostgreSQL and one dispatch outside it, both only for a CONFIRM that settles the EVIDENCE_JUDGMENT criterion this task declared: the compare-and-set writes status DONE under the mutex above, and after commit the committed completion is handed to the successor dispatch the other two criteria already use. Nothing else — no Session state, no comment, no notification, no realtime event, and no completion input routed: 0228 removed the request ledger, inbox, device outbox and delivery worker, and this unit rebuilds none of them.',
    answer: 'Typed 503 from the global boundary after retry exhaustion. A superseded revision, a rewritten criterion and an already-decided version are explicit 409s; a deciding session that did this work is a 403.',
  },
  {
    at: 'tasks/task-completion-evidence.service.ts#importLegacyComment',
    shape: 'TX_RETRIED',
    locks: 'user FOR KEY SHARE (rank 10, pre-acquired for the reviewer FK), task FOR UPDATE (rank 50), then task_completion_evidence / idempotency / task_legacy_evidence_import (rank 60). The source TaskComment is read before its later FK check; source Session/Attempt are immutable provenance snapshots and are not referenced by a new FK.',
    identity: 'Both (task, source comment) and (task, caller idempotency key) are unique audit identities. The evidence stable-fact tuple and request fact tuple remain independently unique; source and structured SHA-256 digests bind the exact reviewed inputs.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the Task and re-reads the exact comment, source Session, current criterion and latest evidence revision. A committed exact replay returns the original import/evidence/request; reusing either source or key with changed actor, provenance, digest, review note or delivery policy is a 409.',
    effects: 'No comment parsing or external action occurs inside. The request trigger files inbox and delivery rows in the same transaction. After commit an explicitly IMMEDIATE human request only nudges the durable worker; IN_APP_ONLY has a terminal zero-attempt delivery row and causes no nudge.',
    answer: 'Typed 503 after retry exhaustion; invalid ownership/input is 400/404 and conflicting import identity is 409.',
  },
  {
    at: 'tasks/task-owner-confirmation.service.ts#claim',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50), then one task_owner_confirmation_claim INSERT (rank 60, whose composite foreign key re-checks the task row this unit already holds). The declaring session and its in-flight turn are read WITHOUT a lock, inside the same closure: they are the statement\'s subject, not a row this unit writes, and the task lock is what orders a declaration against the owner\'s decision about the same task.',
    identity: '(session, turn): a declaration is the run\'s statement about the turn it made it in, so a retried tool call finds the row it wrote and reports it as already declared rather than writing a second one, and task_owner_confirmation_claim_turn_key is the same fact in the database.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the task and re-reads its criterion, its status, the declaring session\'s task and that session\'s newest in-flight turn inside the closure, so a re-run declares against the same facts or is refused; a rolled-back attempt leaves no claim behind.',
    effects: 'None outside the database: nothing is published, because a declaration changes no view — the question it leads to is recorded later, by the completion that ends the run.',
    answer: 'Typed 503 after retry exhaustion. A task declaring another criterion, a settled task, a declaration from outside the task\'s own run and one made between turns are explicit 409s.',
  },
  {
    at: 'tasks/task-owner-confirmation.service.ts#confirm',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50), then the task\'s newest task_owner_confirmation_request and its review read unlocked, one task_owner_decision INSERT (rank 60, whose foreign keys re-check the task row this unit already holds, the request row it names and the review record it was made against), the task_comment that records the owner\'s answers to the review\'s questions when there are any (rank 60, keyed by the decision, docs/owner-confirmation-review-contract.md §7 Q5), then the derived status back onto the same task row. The decision\'s time is read with clock_timestamp() after the task lock is held, so decisions about one task are ordered as they were made.',
    identity: 'The confirmation request the decision answers, or none for a task no run is waiting on. The door compares it with the request waiting now under the task lock, so a second press of the same card finds that request already decided and is refused as stale, and task_owner_decision_request_key makes one decision per request a database fact.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the task and re-reads its criterion, status and newest request inside the closure, so a re-run decides against the same facts or refuses; a rolled-back attempt leaves no decision and no status behind.',
    effects: 'After commit only: a task.changed nudge, a session row refresh for the session whose run was answered, the successor dispatch when the CONFIRM settled the task — the same dispatch the other criteria use — and, when it answered a review\'s questions, the reviewer told so on a turn of its own (`OwnerConfirmationReviewService.deliverAnswers`, best-effort).',
    answer: 'Typed 503 after retry exhaustion. A task declaring another criterion, a settled task and a stale answer are explicit 409s, and so is a card whose review is out of date or whose questions are unanswered; an agent session is a 403 before the transaction opens.',
  },
  {
    at: 'tasks/owner-confirmation-review.service.ts#review',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50) first (`reviewerStanding`), then the request, its review row and records, the reviewing session and its in-flight turn read unlocked, then one task_owner_confirmation_review_record INSERT (rank 60, whose foreign keys re-check the review row and the task row this unit already holds). Its time is read with clock_timestamp() after the task lock is held.',
    identity: '(review, kind) and the reviewing session\'s turn: a retried tool call in the same turn finds the REVIEW record that turn wrote and answers it as already recorded (§3.5 row 4), and task_owner_confirmation_review_record_kind_key keeps one REVIEW per request in the database.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the task and re-reads every row of §3.5\'s table inside the closure — the reviewer, the turn, whether the request is still the newest, what it already has — so a re-run records against the same facts or is refused; a rolled-back attempt leaves no record.',
    effects: 'After commit only: a task.changed nudge and a session row refresh for the run whose card the review moved (§5 N5).',
    answer: 'Typed 503 after retry exhaustion. A caller that is not the request\'s reviewer, or no session, is a 403; outside a turn, a superseded request and one already reviewed are 409s; malformed input and needsYou after the owner decided are 400s.',
  },
  {
    at: 'tasks/owner-confirmation-review.service.ts#recordProblems',
    shape: 'TX_RETRIED',
    locks: 'task FOR UPDATE (rank 50) first (`reviewerStanding`), the rows of §8 B8\'s table read unlocked, then one PROBLEMS task_owner_confirmation_review_record INSERT (rank 60), timed with clock_timestamp() after the task lock.',
    identity: '(review, kind) and the reviewing session\'s turn, as `review` above: a retry in the same turn answers the record it wrote, and one PROBLEMS record per request is task_owner_confirmation_review_record_kind_key.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-locks the task and re-reads B8\'s table inside the closure, so a re-run writes against the same facts or is refused; a rolled-back attempt leaves no record.',
    effects: 'After commit only: a task.changed nudge and a session row refresh for the run whose receipt it hangs under, and the owner\'s push when the task is DONE (§9 L5) — sent once per record, and lost rather than re-sent if the process dies first.',
    answer: 'Typed 503 after retry exhaustion; the refusals are B8\'s 403s, 409s and 400s.',
  },
  {
    at: 'tasks/tasks.service.ts#create',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10, whenever it restructures), task_list FOR KEY SHARE (20), the creator and predecessor Sessions FOR KEY SHARE (30), project FOR NO KEY UPDATE (40 when it retires a predecessor), then the successor/source task rows (50), dependency edges (60), and dependency revision triggers (70).',
    identity: 'The key built from `(session, turn, title, description)` above the closure.',
    isolation: '',
    attempts: 4,
    replay: 'Everything the closure decides is re-read under the locks it takes; `data` and the key are computed once outside. A supersession links the predecessor with a compare-and-set against a row still unlinked, so a rollback leaves nothing and a concurrent winner is read back instead of inserting a second Task.',
    effects: 'Realtime publication is outside the loop, after commit.',
    answer: 'Typed 503 from the global boundary after transient retry exhaustion; mismatched provenance is a typed conflict.',
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
    at: 'tasks/tasks.service.ts#update',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (10, when it restructures), task_list (20), creator Session (30, when it writes the task row twice), a conservative project FOR NO KEY UPDATE pre-lock (40, retained in application code after the task-acceptance triggers were retired), then Task rows in UUID order (50; verifier plus subject for a verdict, with NOWAIT on supersession/move paths), followed by dependency edges (60) and the derived subject status trigger boundary (70).',
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
    at: 'sessions/session-request.service.ts#holdForRetry',
    shape: 'TX_RETRIED',
    locks: "the ASKER's session row FOR SHARE (rank 30), which an UPDATE of that row waits for, then one compare-and-set of one session_request row (rank 60) through holdReply — ascending, and nothing else.",
    identity: 'The request read above the closure: its id, its asker and owner.',
    isolation: '',
    attempts: 4,
    replay: "The asker's state is read inside the closure under its lock, and the hold is a compare-and-set on an outcome still on no turn and not held, so a re-run judges the state the winner left and holds at most once.",
    effects: 'The two sessions\' realtime refresh, after the transaction and only when it held.',
    answer: 'Typed 503 to a session_reply caller would be wrong once REPLIED committed, so the hand-off runs under handOffQuietly there; everywhere else the request worker hands the outcome off again on its next pass.',
  },
  {
    at: 'sessions/session-request.service.ts#waitForRetry',
    shape: 'TX_RETRIED',
    locks: "the ASKER's session row FOR SHARE (rank 30), which an UPDATE of that row waits for, then one compare-and-set of one session_request row (rank 60) clearing its mark — ascending, and nothing else.",
    identity: 'The request read above the closure: its id, its asker and owner, and the mark as it was read.',
    isolation: '',
    attempts: 4,
    replay: "The asker's state is read inside the closure under its lock, and the clear is a compare-and-set on the mark as it was read and on the outcome still being on no turn, so a re-run judges the state the winner left and clears at most once; a retry given up after the lock is released marks the outcome again through 0352's trigger.",
    effects: 'None: the answer is whether the asker was still waiting.',
    answer: 'The request worker logs it and reads the row again on its next pass; nothing reaches a client.',
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
    at: 'tasks/tasks.service.ts#pinMany',
    shape: 'TX_RETRIED',
    locks: 'user FOR UPDATE (rank 10, I1 — a multi-row task write), then one UPDATE over at most TASK_BATCH_PIN_CHUNK task rows, in `id` order because the subquery it selects through is `ORDER BY "id" LIMIT` and every chunk after the first starts above the previous chunk. Taken per chunk, not around the loop, so the owner mutex is never held for the length of a whole-project re-pin.',
    identity: 'The selector and the pin, computed above the closure; `after` is the greatest id the previous chunk returned, which strictly increases and is what makes the loop terminate.',
    isolation: '',
    attempts: 4,
    replay: 'Every attempt re-runs the same statement, and the statement is idempotent by construction: it writes only rows whose provider/model are `IS DISTINCT FROM` the target, so a re-run after a lost answer selects fewer rows and reports the same set.',
    effects: 'The resync publish, after the loop and only when something was written.',
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
    at: 'watches/watch-evaluator.service.ts#evaluate',
    shape: 'TX_RETRIED',
    locks: 'watch FOR UPDATE (one row), then watch_target and watch_match writes whose only foreign-key parent is that row, already held, and one watch_delivery row: either the row of a Match it records, whose parent is that new Match, or the row of the end it lands (an expiry, a revocation or an unresolvable end), whose parent is the watch row it already holds. task, session and approval are read without a lock. Unranked in lock-order.ts because it cannot close a cycle: the unit holds nothing but its one watch row, and nothing holding a task or session lock waits on it except a session or user delete cascading into watch — which this unit never waits on in return.',
    identity: 'The watch id, and the state and generation read under the row lock: the closing UPDATE is a compare-and-set on both, and `watch_match_watch_generation_key` makes a second Match of one generation a constraint rather than a race.',
    isolation: '',
    attempts: 4,
    replay: 'Everything the decision is a function of is read inside the closure under the row lock — the watch, its targets, every source column its leaves name, and the clock (`now()`). A re-run against the world the aborted attempt saw decides the same; against a world that moved it decides the newer one, which is the one to land. A watch another landing already settled is left alone.',
    effects: 'None inside. The next pass is started by the caller, outside any transaction, and the `watch.changed` announcement for a landing that MATCHED, EXPIRED, REVOKED or ended UNRESOLVABLE is published after the commit — an attempt that rolled back announced nothing.',
    answer: 'The pass logs it and goes on to the next watch; the claim lapses and the watch is due again on a later pass.',
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
  // ── Orbit Wiki (migration 0307, docs/wiki-design.md §4). Every unit below locks wiki rows and
  //    nothing else: 0307's header works through why the wiki's children reach their owner through
  //    the space rather than the user row, so a propose or a decide takes no rank-10 key lock and
  //    adds no edge to the canonical order (docs/postgres-lock-order.md). Only the two space units
  //    below touch the user relation at all, and they take it FOR KEY SHARE in a transaction that
  //    holds nothing else — which is what makes them safe to run from a runner door. ─────────────
  {
    at: 'wiki/wiki.service.ts#submitChangeset',
    shape: 'TX_RETRIED',
    locks: 'wiki_changeset (rank 60, the row this call creates) then wiki_changeset_op (60) then, for the ops that write now, wiki_entry and its children: wiki_entry_revision (60), wiki_source (60) and the entry rows a supersede or a retire names. Every entry row is taken by a plain UPDATE — FOR NO KEY UPDATE — never FOR UPDATE, because an op or an exposure that names it takes KEY SHARE through its foreign key and FOR UPDATE would block that. The entry self-references (supersedes_id, superseded_by_id) and the op-to-entry keys take the same KEY SHARE, and a supersede updates the two entries in one direction only. Reads of session, workspace, conversation_turn, run_event, tool_call, task and task_comment happen unlocked and before any write: at READ COMMITTED they take no lock at all, and they are what decides the writes that follow. The near neighbours of every draft, with the reasons the rejected among them were rejected, are read before the transaction opens, unlocked; the closure re-reads the entries they list, and those reasons, unlocked and before its first write.',
    identity: 'The owner and the idempotency key, through the unique index over (owner_id, idempotency_key), plus the digest of the normalized request stored beside it. A key that arrives again with the same digest is answered from the changeset it recorded and writes nothing; a key that arrives with another digest is refused WIKI_IDEMPOTENCY_KEY_REUSED. Two identical requests racing insert the same key: one loses the unique index, which is a permanent answer rather than a transient one, and the caller that re-issues it then reads the winner\'s recorded answer.',
    isolation: '',
    attempts: 4,
    replay: 'Everything a second attempt needs is re-read inside the closure: the space and its settings, the entry an op names and its current revision, the sources it cites and their text, whether the calling session read the web, and how many ops the space already has waiting. The one thing read before the transaction is every draft\'s near neighbours (wiki-neighbours.ts), and it decides nothing on its own: each attempt first re-reads the revision, status, trust and rejections of every neighbour listed, and looks a draft up again inside the closure when one of them moved, when an earlier op of the same attempt wrote a lineage the draft would meet or changed an entry it lists, or after an applied amend rewrote an entry. Nothing else is decided from a value read before the transaction. The writes are therefore a function of the committed world at the attempt, and the first attempt\'s changeset, ops, revisions and sources all roll back with it — the changeset INSERT included, which is why a re-run cannot record the same submission twice.',
    effects: 'None inside. The `wiki.changed` announcement a recorded changeset will publish belongs after the commit, is not implemented yet (T7), and nothing depends on it either way: a client re-reads on focus and on reconnect.',
    answer: 'Typed 503 from the global boundary. The request is safe to issue again: the idempotency key is the caller\'s, and a caller that sent none gets one changeset per issue, which is what it asked for.',
  },
  {
    at: 'wiki/wiki.service.ts#decide',
    shape: 'TX_RETRIED',
    locks: 'wiki_changeset (60) and its ops (60), then the wiki_entry each decided op names, by plain UPDATE, and whatever the op applies: wiki_entry_revision (60), wiki_source (60), the entry a supersede names, and the ops of an entry that left active (withdrawn in the same statement that wrote the status). A challenge decision takes the entry row twice for the same reason every other branch does — once to write the flag and once to recompute it from the decision just recorded. A challenge answered Re-confirm or Amend writes the entry\'s next revision, the owner\'s, through applyOp as an accepted amend does; one answered Retire records the owner\'s own retire through recordChangeset in the same transaction — its changeset (60) and op (60), then the entry by plain UPDATE and the challenge withdrawn behind it — the order `wiki.submitChangeset` takes them in.',
    identity: 'The changeset and each op id, with the op\'s own decision as the compare-and-set: only an op still PENDING is decidable, and a second press, another window pressing the same card, or a decision racing the op\'s expiry matches no row and is told the op is already decided. The changeset settles in the same transaction, from a count of the ops still pending.',
    isolation: '',
    attempts: 4,
    replay: 'The changeset, its ops and the entry each op names are re-read inside the closure, so a retried attempt re-decides against the committed world; a compare-and-set that no longer holds is recorded as `conflict` and applies nothing, which is the same answer a second attempt reaches. Nothing outside the transaction was told anything before it committed.',
    effects: 'None inside. The owner\'s answer is the fact; a client waiting on it re-reads.',
    answer: 'Typed 503 from the global boundary; the owner presses again, and an op already decided is told so rather than decided twice.',
  },
  {
    at: 'wiki/wiki.service.ts#createSpace',
    shape: 'TX_RETRIED',
    locks: 'wiki_space, with its foreign key to the user row taken FOR KEY SHARE (rank 10) — the only wiki write that touches that relation, and it holds nothing else, so it cannot be the second edge of a cycle. The `owner_id` of every wiki table is what 0307 argues keeps it that way.',
    identity: 'The owner and the repository URL norm, through the unique index over (owner_id, repo_url_norm); the slug is made unique within the owner by the same transaction that reads the taken ones.',
    isolation: '',
    attempts: 4,
    replay: 'The taken slugs and the existing space for that repository are read inside the closure, so a re-run after a conflict re-decides both against the committed set. A second creator of the same space loses the unique index, which is a permanent answer.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary; the owner is told the space already exists when it does.',
  },
  {
    at: 'wiki/wiki.service.ts#bindOnFirstUse',
    shape: 'TX_RETRIED',
    locks: 'wiki_space and wiki_space_workspace, the space under the user foreign key FOR KEY SHARE (rank 10) and the binding under both of its own; the workspace row is read unlocked first and is not written.',
    identity: 'The workspace id (`workspace_id` is unique over the binding) and the owner plus repository URL for the space. A workspace that already has a binding finds its own row; a space that already exists is found rather than made.',
    isolation: '',
    attempts: 4,
    replay: 'Both lookups happen inside the closure, so a re-run after a conflict finds what the winner committed rather than making a second space or a second binding.',
    effects: 'None inside.',
    answer: 'Typed 503 from the global boundary; the next call binds or finds the row.',
  },
  // The owner's two answers to what a space's review mode applied at once (contracts/wiki.contract.json
  // `reviewModes.revert` and `reviewModes.entryReject`, migration 0311). Both are owner-channel only and
  // write wiki rows alone, in the order `submitChangeset` and `decide` already take them.
  {
    at: 'wiki/wiki.service.ts#revertChangeset',
    shape: 'TX_RETRIED',
    locks: 'wiki_changeset_op (60) — the reverted changeset\'s open spot checks, withdrawn by one UPDATE, and each of its ops still waiting for a verdict, withdrawn one by one after an add\'s proposed lineage is rejected by plain UPDATE (the order `wiki.decide` takes an entry and then its op) — and wiki_changeset (60), settled if nothing of it waits any more; then exactly the locks `wiki.submitChangeset` states, for the owner\'s own changeset that does the undoing: that changeset and its ops, then each entry a retire or an amend names by plain UPDATE (FOR NO KEY UPDATE), its revision and its sources, and the ops withdrawn behind an entry that left active. Reads of the reverted changeset, its entries and the revisions it puts back are unlocked and happen before those writes.',
    identity: 'The reverted changeset, through the idempotency key `revert:<its id>` on the owner\'s changeset that undoes it — the unique index over (owner_id, idempotency_key). A second revert finds that changeset and answers with it, writing nothing; two racing each other insert the same key and one loses the unique index, a permanent answer, after which a re-issue reads the winner\'s.',
    isolation: '',
    attempts: 4,
    replay: 'Everything is re-read inside the closure: the changeset and its ops, whether a revert of it is already recorded, each entry\'s status and current revision, and the revision each amend puts back. The undoing is decided against the committed world at the attempt, and the first attempt\'s withdrawals, changeset, ops and revisions roll back with it, so a re-run cannot take a run back twice.',
    effects: 'After the commit and outside the closure: one `wiki.changed` for the space (nothing depends on it). A replayed revert announces nothing.',
    answer: 'Typed 503 from the global boundary; the owner presses again, and a revert already recorded answers with itself.',
  },
  {
    at: 'wiki/wiki.service.ts#rejectEntry',
    shape: 'TX_RETRIED',
    locks: 'The wiki_entry (60) by plain UPDATE — the reject predicate is its compare-and-set — then the ops withdrawn behind it (60), the op that made it (60) by one UPDATE of its decision, its changeset (60) when that settles it, and, when the op was a spot check whose rejection takes the space\'s reject rate over the line, the wiki_space row (60) by one UPDATE whose WHERE is the compare-and-set on its review mode. Reads of the entry and of the op that made it are unlocked and come first.',
    identity: 'The entry and its status: only an active entry with the machine\'s trust is rejected, so a second press — or a Review decision on its spot check racing this one — matches no row, and the one that finds the op already decided is told so.',
    isolation: '',
    attempts: 4,
    replay: 'The entry, its trust, the op that made it and the space\'s mode are re-read inside the closure, so a retried attempt decides against the committed world, and whether this call is the one that sent the space back to Manual is re-decided with it.',
    effects: 'After the commit and outside the closure: one `wiki.changed` for the space, and — only when this call\'s compare-and-set moved the space to Manual — one push notification to the owner (`PushService.notifyWikiReviewModeTripped`). Neither is inside the closure, so a retried attempt sends neither twice.',
    answer: 'Typed 503 from the global boundary; the owner presses again, and an entry already rejected answers 409.',
  },
  // Automatic's verdicts (contracts/wiki.contract.json `reviewModes.verification`, migration 0312):
  // the runner door's report and the one-off import's own call. ONE TRANSACTION PER VERDICT, so what
  // one verifier call decided stands whatever the next verdict of the same request meets.
  {
    at: 'wiki/wiki.service.ts#recordVerifications',
    shape: 'TX_RETRIED',
    locks: 'Per verdict, wiki rows alone and in the order `wiki.decide` takes them: the entry the verdict applies to by plain UPDATE (FOR NO KEY UPDATE) — an add\'s proposed lineage promoted or rejected, an amend\'s entry written, a duplicate\'s named entry reinforced (for an op a maintenance run adopted, the live entry holding its very content when there is one: `reviewModes.verification.adoption`) — with the revision (60) and sources (60) that brings and the ops withdrawn behind an entry that left active; then the op itself (60) by one UPDATE, its changeset (60) when that settles it, and — when an unsupported verdict takes the space\'s rate over the line — the wiki_space row (60) by one UPDATE whose WHERE is the compare-and-set on its mode. Reads of the space, the op, its sources and its neighbours — and for an adopted op the session that proposed it and its live twin — are unlocked and come first.',
    identity: 'The op and its decision: the op is written by one UPDATE predicated on `decision = verifying`, so of two verdicts for one op only one lands — the other matches no row, and its whole transaction (the entry writes before it included) rolls back and answers 409. A verdict sent again for an op already verified the same way reads the recorded verdict and writes nothing.',
    isolation: '',
    attempts: 4,
    replay: 'Everything is re-read inside the closure: the op and whether it still waits, the space\'s mode and settings, the entry an amend names and its revision, the entry a duplicate names, an adopted op\'s proposing session and live twin, and the verdicts the fallback counts. A retried attempt decides against the committed world, and the first attempt\'s writes roll back with it, so a verdict cannot apply twice.',
    effects: 'After the commit and outside the closure: one `wiki.changed` for the space once any verdict of the request was recorded, and — only for the verdict whose compare-and-set moved the space to Tiered — one push notification to the owner (`PushService.notifyWikiVerificationTripped`). Neither is inside a closure, so a retried attempt sends neither twice.',
    answer: 'Typed 503 from the global boundary; the verifier reports again, and a verdict already recorded answers with itself.',
  },
  // The anchor re-verification (contracts/wiki.contract.json `anchorRules.verify`, criterion 4): what a
  // maintenance run's `orbit wiki anchors verify` found on origin/main. ONE TRANSACTION PER ENTRY, as a
  // verdict is, so what one entry's check recorded stands whatever the next entry of the report meets.
  {
    at: 'wiki/wiki.service.ts#recordAnchorChecks',
    shape: 'TX_RETRIED',
    locks: 'Per entry, wiki rows alone: the wiki_entry (60) by one plain UPDATE (FOR NO KEY UPDATE) whose WHERE is the compare-and-set — still active, still at the revision the list handed out — writing the anchors\' checks and the anchor state, and a second UPDATE of the same row, already held, when a Tiered pitfall becomes auto; then, only when the check leaves it changed or missing and no challenge of it is open, exactly the locks `wiki.submitChangeset` states for the system challenge it files: that changeset (60) and its op (60), whose foreign key takes the entry KEY SHARE — compatible with the lock this transaction already holds — and the entry again, held, to write the flag. Reads of the entry, the space, the Tiered op and its sources, and the open challenges are unlocked; the open-challenge count comes after the entry UPDATE, so a second report racing this one waits on the row and then sees the challenge this one filed.',
    identity: 'The entry and its revision: the check is written by an UPDATE predicated on the entry being active at the revision the report names, so a report against a revision that moved matches no row and is answered stale. The system challenge is filed only while no challenge of the entry is pending, read under the row lock, so a report sent twice files one; the checks it rewrites are the same values again.',
    isolation: '',
    attempts: 4,
    replay: 'Everything is re-read inside the closure: the entry, its revision and anchors, the space\'s mode, the op that applied a Tiered pitfall and its sources, and the open challenges. The checks and the state are a pure function of those and the report, and a rolled-back attempt takes its entry write and its challenge changeset with it, so a re-run cannot file two.',
    effects: 'After the commits and outside every closure: one `wiki.changed` for the space once any entry of the report was recorded. Nothing depends on it.',
    answer: 'Typed 503 from the global boundary; the maintenance run reports again, and what it reports again writes the same checks and files no second challenge.',
  },
  // Criterion 7, revision 4 (contracts/wiki.contract.json `reviewModes.entryConfirm` and
  // `reviewModes.verification.reopen`, migration 0314): the owner's Confirm of what a review mode
  // applied, and the reopening of what a verdict decided without being able to read its evidence.
  // Wiki rows alone, in the order `wiki.decide` takes them.
  {
    at: 'wiki/wiki.service.ts#confirmEntry',
    shape: 'TX_RETRIED',
    locks: 'The wiki_entry (60) by plain UPDATE (FOR NO KEY UPDATE) — the owner\'s revision of it, whose WHERE on the current revision is its compare-and-set — with the wiki_entry_revision (60) and wiki_source (60) rows that revision brings; then each op the review mode applied to it and nobody had answered (60), by one UPDATE each, and their changesets (60) when that settles them. Reads of the entry, its current revision\'s sources and those ops are unlocked and come first.',
    identity: 'The entry and its trust: only an active entry whose trust is auto or unreviewed is confirmed, and the write that confirms it moves its trust off both, so a second press finds a confirmed entry and answers 409 without writing.',
    isolation: '',
    attempts: 4,
    replay: 'The entry, its trust and revision, its current sources and the ops it answers are re-read inside the closure, so a retried attempt decides against the committed world and the first attempt\'s writes roll back with it.',
    effects: 'After the commit and outside the closure: one `wiki.changed` for the space (nothing depends on it).',
    answer: 'Typed 503 from the global boundary; the owner presses again, and an entry already confirmed answers 409.',
  },
  {
    at: 'wiki/wiki.service.ts#reopenVerifications',
    shape: 'TX_RETRIED',
    locks: 'Per op, in a transaction of its own and wiki rows alone. A rejected op: its add\'s lineage (wiki_entry, 60) by plain UPDATE whose WHERE is the rejection still standing, then the op (60) by one UPDATE predicated on the same, then its changeset (60) by one UPDATE when it had settled. A tainted op: the op (60) by one UPDATE predicated on it still waiting for the owner. Reads of the space, the op, its sources and an amend\'s entry are unlocked and come first.',
    identity: 'Each op and its decision: a rejected op is reopened by an UPDATE predicated on `decision = rejected` with its unsupported verdict, and a tainted op moved by one predicated on `decision = pending`, so of two calls racing only one moves it — the other matches no row, its transaction rolls back, and the op is named in `skipped`. A second call finds nothing left to move.',
    isolation: '',
    attempts: 4,
    replay: 'The op, whether it still stands as it did, the space\'s settings and an amend\'s entry are re-read inside each closure, so a retried attempt decides against the committed world and the first attempt\'s writes roll back with it.',
    effects: 'After the last commit and outside every closure: one `wiki.changed` for the space when anything moved (nothing depends on it).',
    answer: 'Typed 503 from the global boundary; the caller calls again, and what already moved is not found a second time.',
  },
  // The Wiki maintenance run (contracts/wiki.contract.json `maintenance`, migration 0315): the owner's
  // maintenance settings with the hidden list they make, and what a dossier page records it handed out.
  {
    at: 'wiki/wiki-maintenance-settings.ts#setWikiMaintenance',
    shape: 'TX_RETRIED',
    locks: 'When maintenance is being turned on and the space has no list yet: the task_list INSERT first, whose owner foreign key takes the user row FOR KEY SHARE (rank 10) and which creates the list row (rank 20); then the wiki_space row FOR UPDATE (rank 60), read again under that lock; then, only for the loser of two first enables, the DELETE of the list it just made (the same rank-20 row, its own); then one UPDATE of that wiki_space row, merging the maintenance key alone; then, only when this write turns maintenance on and the look-back is a number of days, one INSERT … ON CONFLICT (space_id, source) DO UPDATE … WHERE position_at IS NULL of the space\'s wiki_cursor row (rank 60, a child of the space row this transaction already holds, whose foreign key re-check therefore waits on nothing). Ascending throughout: the list is written before the space row is locked, never after, and the cursor after the space.',
    identity: 'The space and its owner. The list is recorded in the settings only when the locked row has none, so two first enables leave one list: the second finds the first one\'s and deletes its own. The cursor starts only where it has no position — the upsert\'s WHERE — and only for the write whose locked row read maintenance off, so of two enables racing one starts it and the other finds maintenance on; a cursor that has a position is never moved by it.',
    isolation: '',
    attempts: 4,
    replay: 'The settings are re-read under the row lock inside the closure, and the merge, the list decision and whether this write turns maintenance on are re-derived from them, so a re-run after a conflict reaches what the committed row says. A rolled-back attempt takes the list it made, and the cursor start it wrote, with it; the start\'s moment is the request\'s, taken before the closure, so a re-run writes the same start.',
    effects: 'None inside, and none after: the list is hidden, so no list-index event is owed.',
    answer: 'Typed 503 from the global boundary; the owner saves the setting again.',
  },
  {
    at: 'wiki/wiki-maintenance.ts#recordIssue',
    shape: 'TX_RETRIED',
    locks: 'The space\'s wiki_cursor row (rank 60) by one conditional UPDATE, then one wiki_dossier row (rank 60) per dossier by upsert on (space_id, session_id). Both reach wiki_space through (space_id, owner_id) and take it FOR KEY SHARE, which no wiki write conflicts with; no session, task or other row is locked — they were read before, unlocked.',
    identity: 'The page\'s end position and the space. The cursor\'s furthest issued position only moves forward — the UPDATE\'s WHERE is that compare-and-set — and each dossier row is keyed by its space and session, so a re-run writes the same rows with the same hashes.',
    isolation: '',
    attempts: 4,
    replay: 'The closure writes values computed before it and reads nothing: re-running it re-applies the same forward-only issue and the same upserts, which is the same outcome.',
    effects: 'None inside. The page is returned to the maintenance run after the commit.',
    answer: 'Typed 503 from the global boundary; the maintenance run asks for the page again, and what it is handed is recorded then.',
  },
  // The maintenance job (contracts/wiki.contract.json `maintenance.job`, migration 0320): the task a
  // committed fact makes for a due space, made under its list's lock.
  {
    at: 'wiki/wiki-maintenance-run.ts#makeTask',
    shape: 'TX_RETRIED',
    locks: 'The space\'s maintenance task_list row (rank 20) by SELECT … FOR NO KEY UPDATE — the one maker of a maintenance task at a time — before any task of it is read or written; then the list\'s unended tasks, the space\'s queued plan jobs (wiki_plan_job, read, not locked) and today\'s count are read under it; then one task INSERT (its foreign keys take the user, the list this transaction already holds and the workspace FOR KEY SHARE), one wiki_maintenance_run INSERT (rank 60, reaching wiki_space through (space_id, owner_id) FOR KEY SHARE), and one UPDATE of the space\'s wiki_cursor row by id (60). Ascending throughout: the list before the task, the task before the wiki rows.',
    identity: 'The space\'s maintenance list. Under its lock a task of the list that has not ended, a plan job of the space that waits for the list (contract `plan.jobs.staggered`), or a day whose runs are used up — unless the run is made in active catch-up on a local endpoint, which the day does not count (contract `maintenance.job.catchUp.dailyLimit`) — makes the closure write nothing and answer why, so of two facts arriving together one makes the task and the other finds it, and a job queued meanwhile goes first.',
    isolation: '',
    attempts: 4,
    replay: 'The unended task, the queued plan job and the day\'s count are re-read under the list lock inside the closure, and the rows written are built before it from reads that do not change with a retry, so a re-run either finds its own committed task (and writes nothing) or writes the same task, run row and cursor update.',
    effects: 'None inside. After the commit and outside the closure: one `task.changed` for the task made (nothing depends on it; the dispatcher reads runAt).',
    answer: 'Typed 503 from the global boundary is never reached: the trigger runs off the request path, logs the failure, and the next fact of the space asks again.',
  },
  // A maintenance task that died (contracts/wiki.contract.json `maintenance.job.recovery`, migration
  // 0356): started again once by a runAt the dispatcher keeps, or closed FAILED, under the list's lock.
  {
    at: 'wiki/wiki-maintenance-run.ts#settle',
    shape: 'TX_RETRIED',
    locks: 'The space\'s maintenance task_list row (rank 20) by SELECT … FOR NO KEY UPDATE — the lock `makeTask` takes, so a dead task is settled and a task made one at a time — then the task (read), its sessions (read, not locked) and its wiki_maintenance_run row (read) under it; then one conditional UPDATE of the task row (rank 50: its runAt, or its status to FAILED), whose AFTER triggers move its dispatch epoch and the list\'s counts as any task write does, and at most one UPDATE of the run row by id (rank 60). Ascending throughout: the list before the task, the task before the wiki row.',
    identity: 'The task, and the state it must still be in: OPEN or IN_PROGRESS with no runAt and nothing able to work it, re-read under the list lock and asserted again by both conditional UPDATEs. A second settling of the same death finds the runAt set (a rerun waits) or the task FAILED, and writes nothing.',
    isolation: '',
    attempts: 4,
    replay: 'Everything the decision reads — the task, its sessions, its run row — is read inside the closure under the list lock, so a re-run decides against the committed world: a task started, ended or settled meanwhile is left as it now is, and otherwise the same runAt or the same FAILED and run end are written.',
    effects: 'None inside. After the commit and outside the closure: one `task.changed` for the tasks settled, published by the trigger (the dispatcher reads runAt; a plan job reads its task\'s end from it).',
    answer: 'Typed 503 from the global boundary is never reached: the trigger runs off the request path, logs the failure, and the next hint settles the task again.',
  },
  // The plan's jobs (contracts/wiki.contract.json `plan.jobs`, migration 0338): the space's hidden
  // maintenance list a job needs, made when maintenance was never turned on, and the job's task, made
  // under that list's lock like a maintenance task.
  {
    at: 'wiki/wiki-maintenance-settings.ts#ensureList',
    shape: 'TX_RETRIED',
    locks: 'The task_list INSERT first, whose owner foreign key takes the user row FOR KEY SHARE (rank 10) and which creates the list row (rank 20); then the wiki_space row FOR UPDATE (rank 60), read again under that lock; then either the DELETE of the list it just made (the same rank-20 row, its own) when the locked row names one already, or one UPDATE of that wiki_space row merging the maintenance key alone. Ascending throughout, as `setWikiMaintenance`: the list is written before the space row is locked, never after.',
    identity: 'The space and its owner. The list is recorded only when the locked row names none, so two first asks leave one list: the second finds the first one\'s and deletes its own.',
    isolation: '',
    attempts: 4,
    replay: 'The settings are re-read under the row lock inside the closure and the decision is re-derived from them, so a re-run reaches what the committed row says. A rolled-back attempt takes the list it made with it.',
    effects: 'None inside, and none after: the list is hidden, so no list-index event is owed.',
    answer: 'Typed 503 from the global boundary; the plan job stays queued or held, and the owner\'s next request or settings change asks again.',
  },
  {
    at: 'wiki/wiki-plan-job.ts#make',
    shape: 'TX_RETRIED',
    locks: 'The space\'s maintenance task_list row (rank 20) by SELECT … FOR NO KEY UPDATE — the lock the maintenance trigger takes, so a job and a maintenance run make their tasks one at a time — before any task of it is read or written; then the job (read, not locked) and the list\'s unended tasks are read under it; then one task INSERT (its foreign keys take the user, the list this transaction already holds and the workspace FOR KEY SHARE) and one UPDATE of the wiki_plan_job row by id (rank 60, reaching wiki_space through (space_id, owner_id) FOR KEY SHARE). Ascending throughout: the list before the task, the task before the wiki row.',
    identity: 'The job and the space\'s maintenance list. Under the list lock a job no longer queued or held, or a task of the list that has not ended, makes the closure write nothing and answer why, so of two facts asking together one makes the task and the other finds it.',
    isolation: '',
    attempts: 4,
    replay: 'The job\'s state and the unended task are re-read under the list lock inside the closure, and the task written is built before it from reads that do not change with a retry, so a re-run either finds its own committed task (and writes nothing) or writes the same task and job update.',
    effects: 'None inside. After the commit and outside the closure: one `task.changed` for the task made, published by the caller (nothing depends on it; the dispatcher reads runAt).',
    answer: 'Typed 503 from the global boundary; the job stays queued or held and the next fact asks again.',
  },
  // The articles (contracts/wiki.contract.json `articles`, migration 0317): one topic's articles
  // replaced together, by a maintenance run of the space or the server's own import.
  {
    at: 'wiki/wiki-articles.ts#write',
    shape: 'TX_RETRIED',
    locks: 'The topic\'s wiki_topic row (rank 60) by SELECT … FOR NO KEY UPDATE — the one writer of a topic at a time — then its wiki_topic_summary rows (60): one DELETE of every part, then one INSERT per part, part 0 first and each subtopic part after it, whose composite foreign keys take KEY SHARE on the topic row this transaction already holds and on the part 0 row it just wrote. The entries, the topics and the stored fingerprint were read before, unlocked; the fingerprint is read again under the lock.',
    identity: 'The topic and the fingerprint of the entries the parts were written from. Under the lock, a part 0 that already carries that fingerprint means the write happened: the closure writes nothing and the call answers unchanged.',
    isolation: '',
    attempts: 4,
    replay: 'The stored fingerprint is re-read under the topic lock inside the closure, and the parts written are computed before it from the request and the entries, so a re-run either finds its own committed write (unchanged) or replaces the same rows with the same content.',
    effects: 'None inside. After the commit and outside the closure: one `wiki.changed` for the space (nothing depends on it).',
    answer: 'Typed 503 from the global boundary; the maintenance run asks for its plan again, and a topic still changed is written then.',
  },
  // The plan (contracts/wiki.contract.json `plan`, migration 0325): a version stored, whoever made it —
  // a drafting job's draft, the owner's edit, or an accepted proposal (whose settling runs inside it).
  {
    at: 'wiki/wiki-plan.ts#store',
    shape: 'TX_RETRIED',
    locks: 'The space\'s wiki_space row (rank 60) by SELECT … FOR NO KEY UPDATE — the one writer of a space\'s plan at a time — then its wiki_plan rows (60): for a draft under an idempotency key, the version its key stored read first; the newest number read, the space\'s draft UPDATEd to superseded, one INSERT of the new version (its foreign key takes KEY SHARE on the space row this transaction holds), one INSERT of its wiki_plan_doc rows and one of their wiki_plan_section rows (60, KEY SHARE on the version and the documents just written); and, for an accepted proposal, one UPDATE of that wiki_plan_proposal row by id and status (60).',
    identity: 'A draft\'s idempotency key, then the version the caller built on. Under the lock a version the key stored already is read first: the same request\'s is the answer, replayed, and the closure writes nothing (another request\'s is WIKI_IDEMPOTENCY_KEY_REUSED). Then the newest draft or confirmed version is read again; any other one means the plan moved, and the closure throws WIKI_PLAN_STALE having written nothing. So of two writers built on the same version the second finds the first\'s and is refused — or, the same draft under its key, answered with it.',
    isolation: '',
    attempts: 4,
    replay: 'Everything written is computed before the closure from the request and the version it was built on, and the key\'s version, the newest version and the next number are re-read under the space lock inside it, so a re-run writes the same version, finds its key\'s version, or finds the plan moved and writes nothing.',
    effects: 'None inside. After the commit and outside the closure: one `wiki.changed` for the space (nothing depends on it), and none for a replay.',
    answer: 'Typed 503 from the global boundary; the drafting job, the owner or the acceptance sends it again: a draft under its key that was stored meanwhile is answered with its version, and a plan that moved otherwise is WIKI_PLAN_STALE then.',
  },
  // The owner's confirmation of a space's draft.
  {
    at: 'wiki/wiki-plan.ts#confirm',
    shape: 'TX_RETRIED',
    locks: 'The space\'s wiki_space row (rank 60) by SELECT … FOR NO KEY UPDATE, then its wiki_plan rows (60): the version read by number, the confirmed one UPDATEd to superseded, and the draft UPDATEd to confirmed by id — in that order, since a space has one confirmed version at a time.',
    identity: 'The version number. Under the lock a version that is no longer a draft means it was confirmed or superseded already: the closure throws WIKI_PLAN_STALE and writes nothing.',
    isolation: '',
    attempts: 4,
    replay: 'The version\'s status is re-read under the space lock inside the closure, so a re-run either confirms the same draft or finds it already confirmed and writes nothing.',
    effects: 'None inside. After the commit and outside the closure: one `wiki.changed` for the space (nothing depends on it).',
    answer: 'Typed 503 from the global boundary; the owner confirms again.',
  },
  // The owner's rejection of a plan proposal. (An acceptance is `store`'s, with the settling inside it.)
  {
    at: 'wiki/wiki-plan.ts#decide',
    shape: 'TX_RETRIED',
    locks: 'The space\'s wiki_space row (rank 60) by SELECT … FOR NO KEY UPDATE, then one UPDATE of the wiki_plan_proposal row by id and status pending (60).',
    identity: 'The proposal and its status: the UPDATE matches only a pending proposal, and one that matched none was decided already — the closure throws WIKI_PLAN_STALE.',
    isolation: '',
    attempts: 4,
    replay: 'A compare-and-set on the proposal\'s status, re-evaluated by the statement itself, so a re-run settles the same pending proposal or finds it settled.',
    effects: 'None inside. After the commit and outside the closure: one `wiki.changed` for the space (nothing depends on it).',
    answer: 'Typed 503 from the global boundary; the owner answers again.',
  },
  // The documents (contracts/wiki.contract.json `docs`, migration 0326): sections of one document written
  // by a maintenance run of the space, or the server's own import, and the whole document classified again.
  {
    at: 'wiki/wiki-docs.ts#write',
    shape: 'TX_RETRIED',
    locks: 'The via entries the write\'s footnotes name, wiki_entry (rank 60) by one SELECT … FOR SHARE in id order — so a rejection, retirement or broken anchor of one waits for this to commit and then withdraws what it wrote (wiki-doc-withdrawal.ts#withdrawDocSentences, which takes the entry before the document too); then the wiki_doc row (60): one INSERT … ON CONFLICT DO NOTHING (its foreign key takes KEY SHARE on the wiki_space row, which no wiki write takes more than FOR NO KEY UPDATE on) and a SELECT … FOR NO KEY UPDATE of it — the one writer of a document at a time; then its wiki_doc_section rows (60): one DELETE of the sections replaced and of those the plan no longer has, whose cascade takes their wiki_doc_sentence and wiki_doc_footnote rows (60), one INSERT per section written and one each of its sentences and footnotes (KEY SHARE on the rows just written), one UPDATE per sentence that stayed and reads differently now, and one UPDATE of the document row it holds. The plan (requireConfirmedPlan) is read again inside, unlocked; the records a footnote names were read and checked before the closure, unlocked.',
    identity: 'The document and the fingerprints of the sections it names. Under the document lock the stored fingerprints are read again: a section already written from the same material, and not withdrawn from since, is left as it is, so a re-run of a committed write writes nothing and answers unchanged.',
    isolation: '',
    attempts: 4,
    replay: 'Everything a section is — its blocks, sentences, footnotes and their verdicts — is computed before the closure from the request and the records; inside it the via entries\' standing, the confirmed plan, the stored sections and the sentences that stay are re-read under the locks, so a re-run replaces the same sections with the same rows or finds them written.',
    effects: 'None inside. After the commit and outside the closure: one `wiki.changed` for the space when a section was written (nothing depends on it).',
    answer: 'Typed 503 from the global boundary; the maintenance run writes the document again, and a section still changed is written then.',
  },
  // What cites a repository file gone from origin/main (contracts/wiki.contract.json `docs.withdrawal.paths`,
  // migration 0340): a maintenance run names the paths, and every sentence citing one is withdrawn.
  {
    at: 'wiki/wiki-docs.ts#withdrawPaths',
    shape: 'TX_RETRIED',
    locks: 'The space\'s documents whose sentences cite one of the paths, wiki_doc (rank 60) by SELECT … FOR NO KEY UPDATE in id order — the lock wiki.writeDoc and the entry withdrawal take a document by, in the same order; then their wiki_doc_sentence rows (60) by one UPDATE to withdrawn and their wiki_doc_section rows (60) by one UPDATE of stale_at. No entry is locked: a path withdraws through no entry.',
    identity: 'The sentences citing the paths that are not withdrawn yet: a re-run finds them withdrawn and withdraws nothing more.',
    isolation: '',
    attempts: 4,
    replay: 'The documents and sentences are read again inside the closure, and the UPDATE matches only sentences not withdrawn, so a re-run of a committed withdrawal writes nothing.',
    effects: 'None inside. After the commit and outside the closure: one `wiki.changed` for the space when a sentence was withdrawn (nothing depends on it).',
    answer: 'Typed 503 from the global boundary; the maintenance run fails, and the next one names the paths again.',
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
  { at: 'projects/convergence-ledger.service.ts#ensureBaseline', under: "convergenceLedger.reviseScope, sessionAttempt.open, verificationFinding.submit — and every caller of `record`, which opens the ledger itself when the task has none" },
  { at: 'projects/convergence-ledger.service.ts#lockAndRead', under: 'convergenceLedger.reviseScope, verificationFinding.submit, and `record` — it takes the rank-50 task lock those units are ordered by, and reads the state they decide from' },
  { at: 'projects/convergence-ledger.service.ts#record', under: 'sessionAttempt.open, projectReconcile.applyDecisionAction, and every caller that judges a task' },
  { at: 'sessions/sessions.service.ts#assertFenceHeld', under: 'sessions.writeFenced and sessions.resume' },
  { at: 'projects/project-acceptance.service.ts#lockProject', under: 'projectAcceptance.recordMergeEvidence — the rank-40 project lock that write is ordered by, taken before it reads or writes any rank-60 child' },
  { at: 'projects/project-start-request.ts#answerStartRequests', under: "projectAcceptance.start — the start's own transaction, after its rank-40 project lock and its confirmation row: one UPDATE of the project's OPEN START_REQUEST item (rank 60) — at most one row, by the dedupe key every request shares — resolved APPROVED by the owner at the start's instant. A start that is refused never reaches it, so a refused start answers no request" },
  { at: 'projects/project-done-request.ts#answerDoneRequests', under: "projectAcceptance.recordProjectDone — the record's own transaction, after its rank-40 project lock and the rank-60 lock on the request it names: one UPDATE of the project's OPEN DONE_REQUEST item (rank 60) — the one named, or, for a press nobody asked for, whichever is open, at most one by the dedupe key every request shares — resolved APPROVED by the owner at the record's instant, with the gaps accepted as its answer. A refused press never reaches it" },
  { at: 'projects/project-handoff.service.ts#spend', under: "tasks.create and tasks.createMany — unit L4's APPLY, one compare-and-set per yes inside the transaction that writes the task it authorises" },
  { at: 'tasks/tasks.service.ts#lockPlanExecutionIdentity', under: 'tasks.create, tasks.createMany — rank 10 then rank 15, before either takes a list or a session' },
  { at: 'tasks/tasks.service.ts#assertPlanAuthorityUnchanged', under: 'tasks.create, tasks.createMany — the preflight facts, re-read under the locks now held and before the first row' },
  { at: 'tasks/tasks.service.ts#assertDependencyCrossingsAtEffect', under: 'tasks.create, tasks.createMany — the cross-project edges, re-judged under a rank-50 lock on the prerequisites' },
  { at: 'tasks/tasks.service.ts#copyAttachmentsToTask', under: 'tasks.create, tasks.createMany — the input files copied onto the new task, in the transaction that inserts it and after its row; a source deleted after the preflight fails the recheck and rolls the task back with them' },
  { at: 'projects/session-attempt.service.ts#bySessionId', under: 'sessionAttempt.evaluate, .close and chargeSteer' },
  { at: 'projects/session-attempt.service.ts#chargeSteer', under: 'sessions.createTurn and sessions.interrupt — only as an explicit transaction participant after the Session idempotency receipt check; lock order is Session rank 30 then task_attempt child rank 60' },
  { at: 'projects/projects.service.ts#lockLiveAgent', under: 'projects.update, .remove' },
  { at: 'projects/projects.service.ts#recordExplicitIdentity', under: 'projects.update' },
  { at: 'projects/projects.service.ts#recordCriterionAuthorship', under: 'projects.create, projects.update and projects.decideCriteriaChange, through replaceAcceptanceDefinitions — one INSERT ... ON CONFLICT DO NOTHING per criterion version, in the same transaction that wrote the versions it names. The two are one fact: an authored criterion whose author was not recorded is exactly what project acceptance §6 cannot then decide about. It writes only rows keyed by definitions the same transaction has just written, so it takes no lock of its own and adds none to the order.' },
  { at: 'projects/projects.service.ts#replaceAcceptanceDefinitions', under: 'projects.update — the project row is already locked at rank 40 before these definition child rows are changed' },
  { at: 'projects/projects.service.ts#holdWeakeningAcceptanceEdit', under: 'projects.update — the loosening edit that is NOT applied; one proposal row under the same rank-40 project lock the classification was made under, so the baseline it names is the set that stood when it was composed' },
  { at: 'projects/projects.service.ts#writeCoordinatorAgent', under: 'projects.update' },
  { at: 'projects/projects.service.ts#writePause', under: 'projects.pause and projects.resume — the rank-40 project row they lock is the one it reads and writes, and nothing else' },
  { at: 'projects/task-aggregation-writer.ts#applyTaskAggregations', under: 'projectReconcile.repeatableRead' },
  { at: "projects/session-source.ts#freezeSessionSourcePin", under: "runnerApi.pinSessionSource — the closure IS this call: the conditional UPDATE that freezes the pin or freezes the refusal, plus the reads either side (the session row and the codebase binding it was resolved against). It writes NOTHING else; the task record a won refusal implies is written by the door that owns the transaction (`tasks/task-dispatch-refusal.ts#recordDispatchRefusal`), so a rollback of this unit takes both halves" },
  { at: 'runner-api/runner-api.controller.ts#lockSessionLeaseOwner', under: 'runnerApi.events, .turnComplete, .finalize' },
  { at: 'runner-api/background-job-wake.ts#fileBackgroundJobWake', under: "sessions.createTurn's coalesce hook, for runnerApi.backgroundWake — under the rank-30 Session lock createTurn already holds. It writes one background_job_wake child row of that session, keyed by session, wake turn and job (a read, then one INSERT or one UPDATE of that row), so it adds no lock outside the one its caller holds, and a retried createTurn re-runs it from the same read" },
  { at: 'runner-api/background-job-wake.ts#foldQueuedWakeTurnsInto', under: "runnerApi.turnComplete — the requeue at a target's completion (through foldRequeuedWakeTurns) and the runner's steer_requeue — inside the rank-30 Session transaction that just turned a missed steer wake back into a queued wake turn. It writes only that session's own children: the background_job_wake rows and DELIVERED session_scheduled_wakeup rows of the other queued, never-announced bg-wake turns, moved onto the kept turn, and then those turns' PENDING rows deleted — the shape a withdrawal leaves. So it adds no lock outside the one its caller holds, and a retried completion re-runs it from the same reads" },
  { at: 'runner-api/background-job-wake.ts#takeJobOffNextTurnQueue', under: "sessions.createTurn's coalesce hook, for runnerApi.backgroundWake when a job's exit is steered into the running turn — under the rank-30 Session lock createTurn already holds. It writes only that session's own children: the one job's background_job_wake row on a queued, never-announced bg-wake turn, moved onto the steer (through moveJobWake), and that queued turn's PENDING row deleted when nothing is left on it — the shape a withdrawal leaves. So it adds no lock outside the one its caller holds, and a retried createTurn re-runs it from the same reads" },
  { at: 'runner-api/background-job-wake.ts#moveJobWake', under: "foldQueuedWakeTurnsInto and takeJobOffNextTurnQueue, inside the rank-30 Session transaction either one runs in. It moves one background_job_wake row of that session to another of its wake turns — an UPDATE of the row, or an UPDATE of the row already there plus a DELETE of the moved one — so it adds no lock outside the one its caller holds" },
  { at: 'runner-api/scheduled-wakeup.ts#markScheduledWakeupDelivered', under: "sessions.createTurn's coalesce hook, for ScheduledWakeupWorker.deliver — under the rank-30 Session lock createTurn already holds. One compare-and-set of that session's session_scheduled_wakeup child row, PENDING to DELIVERED, so it adds no lock outside the one its caller holds; a lost CAS throws, which rolls the turn back with it, and a retried createTurn re-runs the same CAS" },
  { at: 'runner-api/scheduled-wakeup.ts#scheduleWakeup', under: 'runnerApi.scheduledWakeup' },
  { at: 'runners/codex-rate-limit-reset.repository.ts#insertIfAbsent', under: 'codexRateLimitReset.create — one INSERT ... ON CONFLICT DO NOTHING of the operation that transaction just decided to create. Losing to a concurrent confirmation writes nothing and aborts nothing, and the caller reads what won in the same transaction.' },
  { at: 'sessions/merge-receipt.service.ts#fromRunnerMergeResult', under: 'runnerApi.mergeResult' },
  { at: 'sessions/sessions.service.ts#ensurePromptSeeded', under: 'sessions.resume, .seedOpeningTurn, queue.buildSession' },
  { at: 'sessions/sessions.service.ts#insertTurnLocked', under: 'sessions.insertTurn, .createTurn, .resume' },
  { at: 'sessions/sessions.service.ts#linkAttachments', under: 'sessions.createTurn, .resume' },
  { at: 'sessions/sessions.service.ts#moveToWorkspaceLocked', under: "sessions.move — a move to another workspace, under the rank-15 workspace, rank-25 folder and rank-30 session locks that unit already holds: plain reads of the locked session and of what it is judged by, then the move's one UPDATE of that session row. It takes no lock of its own" },
  { at: 'sessions/sessions.service.ts#assertLinkableAttachments', under: "sessions.createTurn, .interrupt, .resume — after the receipt lookup and under the Session lock those units already hold. One INSERT ... SELECT, and only when the request names a file an earlier turn of the session carries: the copy of it that the new turn is linked to. The copy's id is derived from the request's clientTurnId, so a unit re-run after a conflict writes the same row it rolled back, and a replay of a committed request is answered from the receipt before reaching here" },
  { at: 'sessions/sessions.service.ts#taskWorkRefusalFor', under: 'sessions.resume, queue.buildSession' },
  { at: 'queue/queue.service.ts#resolvePoolMember', under: "runnerApi.dequeueTurn through reloadProviderEnv — inside the rank-30 Session transaction that already holds this session's row FOR UPDATE — and, through the unmanaged client, queue.buildSession after the claim committed and runnerApi.reclaim, where a hydration or reclaim asked again chooses from the rows as they then stand and writes that choice. One UPDATE of that session row by its key: the account-pool member chosen, with the transcript line owed when that moves the session off another member. Neither column is one a session trigger fires on, so it adds no lock beyond the row its callers hold" },
  { at: 'queue/queue.service.ts#resolveSharedPool', under: "runnerApi.dequeueTurn through reloadProviderEnv — inside the rank-30 Session transaction that already holds this session's row FOR UPDATE — and, through the unmanaged client, queue.buildSession after the claim committed and runnerApi.reclaim, the same three callers as resolvePoolMember. One UPDATE of that session row by its key, and only when the key chosen for it moved or the row still names a ChatGPT account: `pool_key_id`, with the transcript line owed when that moves the session off another key (`pool_switch_notice`, as resolvePoolMember writes it), and `pool_codex_account_id` cleared — a person's session on a pool runs on its keys alone (migration 0358); none of them a column a session trigger fires on, so it adds no lock beyond the row its callers hold. The token it hands the engine is minted by mintPoolGatewayToken, under the same client. At the claim alone (buildSession, `atClaim`), a move also queues the no-op reload a resident engine says the line on, in PoolNotices.carrier's own transaction (providers/pool-notice.ts) — after this UPDATE, which the unmanaged client has already committed, so the two never nest" },
  { at: 'queue/queue.service.ts#resolveLoginPool', under: "runnerApi.dequeueTurn through reloadProviderEnv — inside the rank-30 Session transaction that already holds this session's row FOR UPDATE — and, through the unmanaged client, queue.buildSession after the claim committed and runnerApi.reclaim, the same three callers as resolveSharedPool. One UPDATE of that session row by its key, and only when what it runs on moved: `pool_codex_account_id` (migration 0324) — or, when none of the pool's ChatGPT accounts can run, `pool_key_id`, a key of the pool chosen for its owner (migration 0358), the other of the two cleared — with the transcript line owed when that moves the session off another account or key (`pool_switch_notice`, as resolveSharedPool writes it); none of them a column a session trigger fires on, so it adds no lock beyond the row its callers hold. The pool's keys are read for that choice, never locked. The token it hands the engine is minted by mintPoolLoginToken, under the same client. At the claim alone (buildSession, `atClaim`), that line or one the gateway owed the session gets its carrier, in PoolNotices.carrier's own transaction — after this UPDATE, which the unmanaged client has already committed, so the two never nest" },
  { at: 'providers/shared-pool.ts#mintPoolLoginToken', under: "queue.resolveLoginPool, and so the same three callers. Three statements on the session's own pool_login_token rows (migration 0324), mintPoolGatewayToken's three: a DELETE of its tokens for another pool and of its expired or revoked ones, an UPDATE moving the expiry of the rest, and one INSERT. The INSERT takes FOR KEY SHARE on the session row — held FOR UPDATE already inside the reload's transaction — and on the pool row (provider_pool(id, owner_id)); it names no account since migration 0355, so it takes no lock on a pool_codex_login row. The pool is written only by its owner's own edits and its deletion, neither of which waits on a session row, so the edge it adds cannot close a cycle" },
  { at: 'providers/shared-pool.ts#mintPoolGatewayToken', under: "queue.resolveSharedPool, and so the same three callers. Three statements on the session's own pool_gateway_token rows (migration 0321): a DELETE of its tokens for another pool and of its expired or revoked ones, an UPDATE moving the expiry of the rest, and one INSERT. The INSERT takes FOR KEY SHARE on the session row — held FOR UPDATE already inside the reload's transaction — and on the person's provider_pool_person row, which only a removal of that person or of the pool writes; that removal cascades through tokens, keys and ledger rows and waits on no session, so the edge it adds cannot close a cycle. A person removed first makes the INSERT a foreign-key refusal rather than a token" },
  { at: 'sessions/current-work-delivery.ts#requeueUnreadCurrentWorkSteers', under: 'runnerApi turn-complete — inside the same rank-30 Session transaction that settles the target turn; it converts only that target\'s unacknowledged steer children, so it adds no row outside the lock its caller already holds' },
  { at: 'sessions/current-work-delivery.ts#terminalizePendingCurrentWorkSteers', under: 'runnerApi turn-complete/finalize/release, sessions interrupt/end and realtime reaper — each caller already owns the rank-30 Session transaction; this participant settles only matching unacknowledged turn children' },
  { at: 'sessions/abandoned-approvals.ts#reapApprovalsOfEndedTurns', under: "runnerApi turn-complete/finalize — each caller already owns the rank-30 Session transaction that just settled the turns this reads, and it writes only that session's approval children that can no longer be answered — the turn that asked them is no longer live, or, for a card that names no turn at all, the call that asked it has returned — so it adds no row and no lock outside the one its caller holds. It is a participant and not a unit on purpose: what it collects has to be decided by the same transaction that ended the turn, or a reader could see a turn ANSWERED with the calls it can no longer answer still counted" },
  { at: 'sessions/abandoned-approvals.ts#reapApprovalsOfReturnedCalls', under: "runnerApi.events — inside the same rank-30 Session transaction that records the tool results it is handed, and after them; it writes only that session's own PENDING approval children whose call is among those results and that name no background job, so it adds no row and no lock outside the one its caller holds. A participant for the same reason as the reapers beside it: a card stops being answerable exactly when its call returns, so a reader that could see the call finished with its card still PENDING would count a question nothing can hear" },
  { at: 'sessions/abandoned-approvals.ts#reapApprovalsOfReplacedSupervisor', under: "runnerApi.takeoverLeases — inside the same rank-30 Session transaction that rotates the inbox lease, which is holding that session's row FOR UPDATE; it writes only that session's own approval children that are still PENDING, so it adds no row and no lock outside the one its caller holds. A participant for the same reason as the reaper above: a card stops being answerable exactly when the process that was reading it is replaced, so a reader that could see the rotation without the collection would see cards it can still press and nothing can hear" },
  { at: 'task-lists/list-events.service.ts#blockFor', under: 'taskLists.writePolicy' },
  // The exception items of the integration-line contract (§4.3, §4.4 X-D5). Each writes only through
  // the transaction that wrote the fact it is about — a task's FAILED, or the drain that takes an
  // item's turn off a conversation's queue — so its lock order is that caller's: the Session (rank 30)
  // and the Task (rank 50) are already held, and these add item and delivery rows (rank 60) whose
  // foreign keys take `project` and `task` FOR KEY SHARE, which no status write conflicts with.
  // The integration line's own writers (`docs/project-integration-line-contract.md` §2). Each runs
  // inside a transaction its caller owns, and each takes only rank-60 child rows: the queue row in
  // the transaction that wrote a task's DONE, the exception item and the receipt in the transaction
  // that wrote a job's terminal state.
  { at: 'projects/project-integration-job.ts#queueLandTask', under: 'runnerApi.turnComplete, taskCompletionEvidence.decide, taskOwnerConfirmation.confirm and tasks aggregation — the transaction that wrote the task DONE, which already holds the rank-50 task and the rank-55 project_codebase the line was started under — and projectOpenItem.retryIntegration (`integration_retry`, §2.3 J-T1b) through queueLandingRetry, which holds the same rank-50 task row and reads the codebase unlocked; the generation it writes carries the retry columns 0344 added' },
  { at: 'projects/project-open-item.ts#recordPromotionApproval', under: "runnerApi.integrationJobResult through applyIntegrationJobResult — the transaction that wrote the promotion check's READY, or an automatic landing's READY when it was handed back (M-T12), which runnerApi.heartbeat also writes for a claim whose Automatic authorization is gone (integration-job-relay's finishHandedBack); one project_open_item child row (rank 60), assigned to the account owner and never escalated, whose project and task foreign keys take FOR KEY SHARE" },
  { at: 'projects/project-promotion.service.ts#candidateIn', under: 'projectPromotion.considerCandidate — the whole of that unit, split out so its own transaction is opened in one place' },
  { at: 'projects/project-promotion.service.ts#supersedeLiveCandidates', under: 'projectPromotion.considerCandidate — retiring the candidate that was standing, inside the transaction that makes the new one (M-T6) — and runnerApi.integrationJobResult, through refileCandidateBehindTheWork, retiring a candidate whose check found it was looking at a branch the task work did not end on (J-T1e)' },
  { at: 'projects/project-integration-job.ts#queuePromotionJob', under: 'projectPromotion.considerCandidate for a CHECK_PROMOTION, projectPromotion.decide for a LAND_PROMOTION, applyPromotionJobResult for the LAND_PROMOTION the project\'s Automatic setting confirms (M-T11), enqueueForDoneTask for the candidate a MAIN-line task\'s DONE makes (M-F2), and projectOpenItem.retryPromotionCheck through requeuePromotionCheck for the CHECK_PROMOTION a coordinator asked to run again (§4.7 H1, carrying the retry columns) — one project_integration_job row (rank 60), idempotent on `ij:v1:<kind>:<promotionId>:<generation>`' },
  { at: 'projects/project-integration-job.ts#queueTaskBranchCandidate', under: 'projects/project-integration-job.ts#enqueueForDoneTask — the transaction that wrote the task DONE, which already holds the rank-50 task and the rank-55 project_codebase the line was started under; one project_promotion row (rank 60) plus the project_integration_job its check runs as, both idempotent against the partial unique index on (project_id, source_ref) over live states' },
  { at: 'projects/project-promotion.service.ts#applyConfirm', under: 'projectPromotion.decide — the owner confirming, as a CAS on `state = READY`' },
  { at: 'projects/project-promotion.service.ts#applyDecline', under: 'projectPromotion.decide — the owner declining, as a CAS on the state just read' },
  { at: 'projects/project-promotion.service.ts#applyCancel', under: 'projectPromotion.decide — the owner calling a confirmed merge back, as a CAS on the landing job not having reached PUSH' },
  { at: 'projects/project-promotion.service.ts#resolveApprovalItem', under: "projectPromotion.decide — closing the owner's own card in the transaction that recorded what they decided" },
  { at: 'projects/project-promotion.service.ts#closePromotionItems', under: "every transition that takes a candidate out of the live states, in the transaction that writes it (§4.2 PROMOTION_MOVED_ON): projectPromotion.considerCandidate and runnerApi.integrationJobResult (refileCandidateBehindTheWork) through supersedeLiveCandidates, as SUPERSEDED; projectPromotion.decide through applyDecline, after the owner's card is answered, and through applyCancel when its CAS moved the row, as RESOLVED; and runnerApi.integrationJobResult through applyPromotionJobResult for a MERGED one, as RESOLVED. One conditional UPDATE over that candidate's OPEN INTEGRATION_* items (rank 60), found by `promotion_id` through 0353's partial index, after the promotion row (rank 60) it closes them for; never the approval card, which is answered by its own close" },
  { at: 'projects/project-promotion.service.ts#requeuePromotionCheck', under: "projectOpenItem.retryPromotionCheck — the coordinator's re-check of a BLOCKED candidate, under the candidate row lock that door holds (§4.7 H1); one project_integration_job row through queuePromotionJob carrying the retry columns 0344 added and 0368 admitted for a check, then the held candidate (rank 60) back to CHECKING" },
  { at: 'projects/project-promotion.service.ts#applyPromotionJobResult', under: "runnerApi.integrationJobResult through applyIntegrationJobResult — the transaction that wrote the promotion job's terminal state; the promotion row (rank 60) and, for a MERGED one, the session_merge_receipt rows (rank 60) that say its tasks are on the upstream" },
  { at: 'projects/project-promotion.service.ts#blockPromotion', under: 'runnerApi.integrationJobResult through applyPromotionJobResult — the same transaction, for a candidate whose checks did not pass (M-T3, M-T9)' },
  { at: 'projects/project-promotion.service.ts#handBackToOwner', under: "runnerApi.integrationJobResult through applyPromotionJobResult — the same transaction, for a landing the Automatic setting confirmed that found main moved and landed nothing (M-T12); and runnerApi.heartbeat through integration-job-relay's finishHandedBack, for a claim of one whose authorization was gone when it was about to be handed out — both through applyIntegrationJobResult; one UPDATE of the promotion row (rank 60) back to READY, whose card the relay then opens beside it" },
  { at: 'projects/project-open-item.ts#recordIntegrationFailure', under: "runnerApi.integrationJobResult, and runnerApi.heartbeat for a claim with nowhere to run it (integration-job-relay's finishUnworkable) — both through applyIntegrationJobResult, in the transaction that wrote the job's CONFLICT, CHECK_FAILED or ERROR; one project_open_item child row (rank 60) whose project and task foreign keys take FOR KEY SHARE" },
  { at: 'projects/project-open-item.ts#markOpenItemsHandling', under: "projectOpenItem.retryIntegration and projectOpenItem.retryPromotionCheck — the transaction that queued the rerun, after the job it names (§4.7 H1); one UPDATE of the coordinator's OPEN items about that failure (rank 60), by primary key, writing the four handling columns 0368 added and leaving the item OPEN" },
  { at: 'projects/project-open-item.ts#resolveHandledItems', under: "runnerApi.integrationJobResult through applyIntegrationJobResult — the transaction that wrote the rerun's LANDED or ALREADY_LANDED (before resolveIntegrationItemsOnLanding), or a re-check's READY (before applyPromotionJobResult, so M-T11 does not count the item that check answered); one UPDATE of the OPEN items still the coordinator's that name the job as their handling job (rank 60, through 0368's partial index), to RESOLVED / HANDLED with the handling session, reason and job copied onto the ending (§4.7 H2)" },
  { at: 'projects/project-open-item.ts#supersedeHandledItems', under: "runnerApi.integrationJobResult, and runnerApi.heartbeat for a claim with nowhere to run it — both through applyIntegrationJobResult, right after recordIntegrationFailure opened the rerun's own failure; one UPDATE of the OPEN items that name the job as their handling job (rank 60), to SUPERSEDED / RETRIED pointing at the new item (§4.7 H3)" },
  { at: 'projects/project-open-item.ts#resolveIntegrationItemsOnLanding', under: "runnerApi.integrationJobResult through applyIntegrationJobResult — the transaction that wrote the job's LANDED or ALREADY_LANDED, beside the receipt that says the work is on the line (J-T5); one project_open_item write over the OPEN INTEGRATION_* items of that task (rank 60), whose task foreign key takes FOR KEY SHARE" },
  { at: 'sessions/merge-receipt.service.ts#fromIntegrationJob', under: "runnerApi.integrationJobResult through applyIntegrationJobResult — the transaction that wrote the job's LANDED or ALREADY_LANDED, so the landing and its receipt commit together or not at all" },
  { at: 'projects/project-open-item.ts#recordTaskFailure', under: 'runnerApi.turnComplete and runnerApi.finalize, realtime reaper.forceFinalize (all three through reclaimStalledTask), tasks.update — the transaction that wrote the failure' },
  { at: 'projects/project-open-item.ts#returnQueuedTurns', under: 'runnerApi turn-complete/finalize, sessions end/interrupt/cancelQueuedTurn and realtime reaper — each caller already owns the rank-30 Session transaction that takes the item turn off the queue unrun' },
  { at: 'projects/project-open-item.service.ts#acknowledgeDelivery', under: "sessions.createTurn — the delivery's ledger row is written in the turn's own transaction, under the Session lock it already holds" },
  { at: 'projects/coordinator-delivery.service.ts#bindQueuedDelivery', under: "sessions.createTurn — `CoordinatorDeliveryService.queue` binds the wake it holds to DELIVERED in the turn's own transaction, under the Session lock that transaction already holds, after re-reading that the conversation has not ended" },
  { at: 'projects/project-open-item.service.ts#acknowledgeAnswer', under: "sessions.createTurn — the same hook and the same lock as acknowledgeDelivery above, for the ANSWER delivery of a question the owner answered (§5.2 R10). It upserts one delivery row (rank 60) keyed by item, session and purpose, so a generation told twice keeps the row it already had; it refuses inside the transaction when that conversation has ended, which is what stops a platform turn from reviving one" },
  { at: 'tasks/reclaim-stalled-task.ts#reclaimStalledTask', under: 'runnerApi.finalize, reaper.forceFinalize' },
  { at: 'tasks/reclaim-stalled-task.ts#postRunFailureComment', under: 'runnerApi.finalize, reaper.forceFinalize' },
  { at: 'tasks/reclaim-stalled-task.ts#postWorkNotOnBranchComment', under: "runnerApi.finalize — inside the same rank-30 Session transaction that settles the run, beside postRunFailureComment and taking the same locks: one task_comment child row whose task foreign key is FOR KEY SHARE on the rank-50 task. It says on the task's own timeline that the run's work never reached its branch, which is the only place that fact can be read once the acceptance command has already derived DONE" },
  { at: 'tasks/reclaim-stalled-task.ts#postExecutableAcceptanceComment', under: 'runnerApi.turnComplete — after the rank-40 project and rank-50 task are locked; the first conversation-turn ACK owns both the derived status and its evidence comment' },
  { at: 'tasks/reclaim-stalled-task.ts#postExecutableAcceptanceUnavailableComment', under: 'runnerApi.turnComplete — after the reserved shell turn is ACKed and the rank-50 task is locked; it is the durable needs-human branch mutually exclusive with a comparable result and status derivation' },
  { at: 'tasks/task-dispatch-refusal.ts#recordDispatchRefusal', under: "two doors, holding the same rank-30 Session row and taking the same locks in the same order. runnerApi.finalize — inside the transaction that settles a run the runner refused at its CHECKOUT, in place of postRunFailureComment. runnerApi.pinSessionSource — inside the transaction that freezes a refusal at RESOLUTION onto the session's `source_state`, which is the only attempt that won that compare-and-set. One UPDATE of the rank-50 task's `dispatch_refusal` (a column no trigger's column list names, so the statement-level AFTER UPDATE triggers find no status or run_at change and write nothing) and one task_comment child row whose task foreign key is FOR KEY SHARE on that same row, after two plain reads (the task's prerequisite edges and their landing receipts) that name the prerequisite behind each missing commit" },
  { at: 'tasks/tasks.service.ts#linkSupersededBy', under: 'tasks.create, tasks.update' },
  { at: 'tasks/tasks.service.ts#lockTaskForSupersessionWrite', under: 'tasks.update' },
  // OWNER_CONFIRMED. The question is recorded in the transaction that acknowledges the successful
  // turn; a decision is recorded under the task's row lock, and a send-back's inside the transaction
  // that files its reason as the next message, after that transaction's Session lock.
  { at: 'tasks/owner-confirmation-read.ts#recordOwnerConfirmationClaim', under: 'taskOwnerConfirmation.claim — one task_owner_confirmation_claim child row under the rank-50 task lock the door already holds, keyed by (session, turn) so a retried declaration is the same row' },
  { at: 'tasks/owner-confirmation-read.ts#recordOwnerConfirmationRequest', under: 'runnerApi.turnComplete — after the SUCCEEDED message turn is ACKed under the rank-30 Session lock; one task_owner_confirmation_request child row per turn (unique on session and turn) and per declaration (unique on the claim it names), whose task foreign key takes FOR KEY SHARE on the rank-50 task and nothing else' },
  { at: 'tasks/task-owner-confirmation.service.ts#lockedStanding', under: "taskOwnerConfirmation.confirm, and sessions.createTurn's participateSendTransaction hook for a send-back — the rank-50 task lock a decision is ordered by, taken after createTurn's rank-30 Session lock on the send-back path" },
  { at: 'tasks/task-owner-confirmation.service.ts#lockedClaimStanding', under: 'taskOwnerConfirmation.claim — the rank-50 task lock a declaration of completion is ordered by, which is the same lock the owner\'s decision about that task is ordered by; the declaring session and its in-flight turn are read beside it, unlocked' },
  { at: 'tasks/task-owner-confirmation.service.ts#writeDecision', under: "taskOwnerConfirmation.confirm, and sessions.createTurn's participateSendTransaction hook for a send-back — one task_owner_decision child row under the rank-50 task lock lockedStanding already took, so a send-back's decision commits with the turn that delivers its reason" },
  { at: 'tasks/owner-confirmation-review.ts#recordOwnerConfirmationReview', under: 'runnerApi.turnComplete — beside recordOwnerConfirmationRequest, under the rank-30 Session lock of the run that asked: one task_owner_confirmation_review child row per request (unique on the request), whose foreign keys take FOR KEY SHARE on the request just written and on the rank-50 task, and nothing else (docs/owner-confirmation-review-contract.md §2 D1)' },
  { at: 'tasks/owner-confirmation-review.ts#abandonUnansweredReviews', under: "runnerApi.turnComplete — beside closeUnansweredRequests, under the rank-30 Session lock of the reviewer that parked: one conditional UPDATE of the review rows (rank 60) it was handed, read and left unanswered, only while nothing will wake it (T5)" },
  { at: 'tasks/owner-confirmation-review.service.ts#bindReviewDelivery', under: "sessions.createTurn — `OwnerConfirmationReviewService.deliver` binds the review it delivers to DELIVERED in the turn's own transaction, under the reviewer's Session lock that transaction already holds, after re-reading D2's six conditions; one compare-and-set on `delivery = 'PENDING'`" },
  { at: 'tasks/owner-confirmation-review.service.ts#reviewerStanding', under: "ownerConfirmationReview.review, ownerConfirmationReview.recordProblems, and sessions.createTurn's participateSendTransaction hook for a return — the rank-50 task lock every review record of the task is written under, taken first in the two units and after createTurn's rank-30 Session lock of the run in the hook, as the owner's send-back takes it" },
  { at: 'tasks/owner-confirmation-review.service.ts#writeReviewRecord', under: "ownerConfirmationReview.review, ownerConfirmationReview.recordProblems, and sessions.createTurn's participateSendTransaction hook for a return — one task_owner_confirmation_review_record child row under the rank-50 task lock reviewerStanding already took, so a return's record commits with the turn that carries it to the run" },
  { at: 'tasks/owner-confirmation-review-turn.ts#writeOwnerAnswersComment', under: 'taskOwnerConfirmation.confirm — one task_comment child row, keyed by the decision (skipDuplicates), under the rank-50 task lock the confirmation already holds: the answers are recorded in the transaction that records them (§7 Q5)' },
  // Unit L3's effect-time fence. Rank 40 only — the project row its callers already take at that
  // rank, in the same UUID order and the same mode — so it adds no edge to the lock graph, and the
  // refusal it can raise is an authorization answer that rolls its caller's transaction back whole.
  { at: 'tasks/tasks.service.ts#refenceProjectScope', under: 'tasks.create, tasks.createMany, tasks.update' },
  // A Watch wake's acknowledgement, written inside the turn's own transaction so the two commit
  // together. It takes only the delivery's row, after createTurn holds the observer session, and
  // nothing holding a delivery row waits on a session. Also issued on its own, as one compare-and-set
  // on the lease generation, for a notification and for a turn an earlier attempt already queued.
  { at: 'watches/watch-delivery.service.ts#acknowledgeDelivery', under: "sessions.createTurn — or, for a notification and for a turn an earlier attempt already queued, on its own as one compare-and-set on the claim's lease generation. Its caller announces `watch.changed` after it commits, which for a NOTIFY_USER delivery is the only thing that tells the owner's other clients anything: that delivery writes no task and no session row" },
  // A Watch wake taken off its observer's queue unrun — drained by an ending, deleted by an interrupt or
  // a withdrawal: the delivery that acknowledged it becomes a dead letter in the transaction that takes
  // the turn off. It takes only the delivery rows of that session's own wakes, after the caller holds
  // the session, and nothing holding a delivery row waits on a session.
  { at: 'watches/watch-wake-drain.ts#deadLetterQueuedWatchWakes', under: 'runnerApi turn-complete/finalize, sessions end/interrupt/cancelQueuedTurn and realtime reaper — each caller already owns the rank-30 Session transaction that takes the wake off the queue unrun' },
  // The `bg-wake:` half of the same thing: a control-plane wake turn deleted from a live session's
  // queue takes the payload kept beside it with it — the job wakes it carried are deleted, the due
  // wakeup settled onto it is CANCELLED. Both are children of that session (rank 60), written after
  // the caller holds its row and before the turns they belong to are deleted.
  { at: 'runner-api/wake-turn-withdraw.ts#settleUnrunWakeTurns', under: 'sessions.cancelQueuedTurn and sessions.interrupt — the rank-30 Session transaction that deletes the turn withdrawn by name, or every turn queued behind the one an interrupt stops' },
  { at: 'watches/watch-evaluator.service.ts#land', under: 'watchEvaluator.evaluate' },
  // A Watch create's capacity checks. Its one lock-shaped statement is `pg_try_advisory_xact_lock` on the owner, taken
  // after the create's watch row and before its targets, and never waited for: a create that finds it held rolls back
  // and asks again outside its transaction. The rest are unlocked reads of that owner's live watches, so two creates of
  // one account decide one after the other and nothing waits on that lock.
  { at: 'watches/watches.service.ts#assertCapacity', under: 'watches.create' },
  // The project's integration line, written under the rank-55 lock on its own binding and nothing
  // else. `lockCodebase` takes that lock for both writers before either derives anything from the
  // row; `bind` is the insert they lock and read back, and a concurrent binder wins it once.
  { at: 'projects/project-integration-line.ts#lockCodebase', under: 'configureProjectIntegration, startProjectLine and startOnFirstIntegration' },
  { at: 'projects/project-integration-line.ts#bind', under: 'configureProjectIntegration and startOnFirstIntegration' },
  { at: 'projects/project-integration-line.ts#configureProjectIntegration', under: "projects.configureIntegration, projects.update and projectAcceptance.start (through startProjectLine) — the account owner's integration settings, under the binding lock taken after the project row when that write holds one" },
  { at: 'projects/project-integration-line.ts#startOnFirstIntegration', under: 'the transaction that queues a project’s first integration — it takes the same binding lock and writes only that row' },
  // Orbit Wiki (0307). Every one of these runs inside `submitChangeset`, `decide`,
  // `createSpace`, `bindOnFirstUse` or `recordAnchorChecks` above, in the order that unit states, and takes no lock its
  // caller did not already take. `applyOp` and `recomputeFlags` are the ONLY two that write
  // `wiki_entry.status`, `trust`, `challenged` and `unsupported` — contracts/wiki.contract.json
  // `storage.singleWriter` — which is why they are listed as participants with their caller named
  // rather than left to the scan's own reading.
  { at: 'wiki/wiki.service.ts#createSpaceRow', under: 'wiki.createSpace and wiki.bindOnFirstUse — it is the one statement pair that makes a space, and it does it under the same user-key read both of those units argue for' },
  { at: 'wiki/wiki.service.ts#recordChangeset', under: 'wiki.submitChangeset and wiki.revertChangeset — one transaction per submission, so the changeset and every op of it are written under the idempotency identity that unit states or not at all; and inside wiki.decide (a Retire answering a challenge is the owner\'s own retire) and wiki.recordAnchorChecks (the system challenge a broken anchor files), in the order those units state' },
  { at: 'wiki/wiki.service.ts#recordOp', under: 'wiki.submitChangeset, wiki.revertChangeset, wiki.decide and wiki.recordAnchorChecks, through recordChangeset — one op\'s row and the effect the contract\'s policy and the space\'s review mode give it, decided against the reads the same closure made' },
  { at: 'wiki/wiki.service.ts#applyOp', under: 'wiki.submitChangeset, wiki.decide, wiki.revertChangeset, wiki.rejectEntry, wiki.confirmEntry, wiki.recordVerifications, wiki.reopenVerifications and wiki.recordAnchorChecks — THE writer of an entry\'s status, trust, challenged and unsupported (storage.singleWriter), reached identically by an agent\'s proposal that applies at once, what a review mode applies, what a verdict applies, the owner\'s own write, the owner\'s answer to any of them, and what an anchor re-verification found (its anchors\' checks and anchor state, and a Tiered pitfall made auto)' },
  { at: 'wiki/wiki.service.ts#recomputeFlags', under: 'wiki.submitChangeset, wiki.decide, wiki.revertChangeset, wiki.rejectEntry, wiki.confirmEntry, wiki.recordVerifications, wiki.reopenVerifications and wiki.recordAnchorChecks, through applyOp — the second and last writer of those four columns: it derives them from what is now true of the entry (its live sources, its open challenges) rather than from what the op asked for; and, for an entry rejected, retired, superseded or whose anchor broke, it withdraws the document sentences that came through it (wiki-doc-withdrawal.ts#withdrawDocSentences)' },
  // The documents' withdrawal (contracts/wiki.contract.json `docs.withdrawal`, 0326): reached only from
  // recomputeFlags, after it has updated the entry's row — so the entry is held before any document is.
  { at: 'wiki/wiki-doc-withdrawal.ts#withdrawDocSentences', under: 'every unit recomputeFlags runs in (wiki.submitChangeset, wiki.decide, wiki.revertChangeset, wiki.rejectEntry, wiki.confirmEntry, wiki.recordVerifications, wiki.reopenVerifications and wiki.recordAnchorChecks), after the entry row that unit already holds: the documents that cite through the entry, wiki_doc (60) by SELECT … FOR NO KEY UPDATE in id order — entries before documents, the order wiki.writeDoc takes them in — then their wiki_doc_sentence rows (60) by one UPDATE to withdrawn and their wiki_doc_section rows (60) by one UPDATE of stale_at; nothing at all when no document cites through it' },
  { at: 'wiki/wiki.service.ts#insertRevision', under: 'wiki.submitChangeset, wiki.decide, wiki.revertChangeset, wiki.confirmEntry and wiki.recordVerifications, through applyOp — the append-only revision a change adds, never a rewrite of one (storage.appendOnly); its foreign key to the entry takes that row KEY SHARE and the entry is already held BY the same transaction' },
  { at: 'wiki/wiki.service.ts#insertSources', under: 'wiki.submitChangeset, wiki.decide, wiki.revertChangeset, wiki.confirmEntry and wiki.recordVerifications, through applyOp and insertRevision — the first-hand records a revision rests on, written once with the revision they support' },
  { at: 'wiki/wiki.service.ts#writeOpDecision', under: 'wiki.decide, wiki.rejectEntry, wiki.confirmEntry and wiki.revertChangeset — the owner\'s answer on one op row, after whatever it applied, so what the op did and what was decided about it are one fact; a revert withdraws with it the ops of its run still waiting for a verdict' },
  { at: 'wiki/wiki.service.ts#settleChangeset', under: 'wiki.decide, wiki.rejectEntry, wiki.confirmEntry, wiki.revertChangeset and wiki.recordVerifications — the changeset\'s own terminal marker, written in the same transaction as the last decision or verdict that left nothing of it waiting' },
  // The review modes' one space write (0311): a space whose spot checks' reject rate passed the line
  // goes back to Manual, by a compare-and-set on its mode merged into its settings in SQL, in the
  // transaction of the rejection that took it over — so the switch and the fact that caused it are
  // one commit, and a second rejection racing it finds the space already Manual and writes nothing.
  { at: 'wiki/wiki.service.ts#tripIfRejecting', under: 'wiki.decide and wiki.rejectEntry — after the op decisions and entry writes those units state, the wiki_space row (60) by one UPDATE; it takes no other lock, and its caller announces the switch only after the commit' },
  // Automatic's verdicts (0312): one verdict applied and recorded, and the fallback to Tiered it may
  // trip, each inside `recordVerifications`' per-verdict transaction and in the order it states.
  { at: 'wiki/wiki.service.ts#applyVerdict', under: 'wiki.recordVerifications — the entry writes through applyOp, then the op\'s decision and trail by one UPDATE predicated on the op still verifying (the compare-and-set that makes a verdict land once), then its changeset settled' },
  { at: 'wiki/wiki.service.ts#tripIfUnsupported', under: 'wiki.recordVerifications — after the verdict\'s own writes, the wiki_space row (60) by one UPDATE whose WHERE is the compare-and-set on the mode being automatic; it takes no other lock, and its caller announces the switch only after the commit' },
  // Revision 4's reopening (0314): one op at a time, each inside `reopenVerifications`' own
  // per-op transaction and in the order it states.
  { at: 'wiki/wiki.service.ts#reopenRejectedOp', under: 'wiki.reopenVerifications — an add\'s lineage proposed again through applyOp, then the op\'s verdict moved into its history by one UPDATE predicated on the rejection still standing, then its changeset opened again' },
  { at: 'wiki/wiki.service.ts#verifyTaintedOp', under: 'wiki.reopenVerifications — the op by one UPDATE predicated on it still waiting for the owner, after the unlocked reads of the space and an amend\'s entry that decide whether Automatic takes it' },
  // The documents' write (0326): the one transaction `wiki.writeDoc` states, in its order.
  { at: 'wiki/wiki-docs-affected.ts#withdrawDocSentencesByPath', under: 'wiki.withdrawDocPaths — the documents citing the paths locked in id order, then their sentences withdrawn and their sections marked stale, in the order that unit states; it takes no lock above rank 60 and none its caller did not state' },
  { at: 'wiki/wiki-docs.ts#store', under: 'wiki.writeDoc — the via entries FOR SHARE, the document row made and locked, its sections replaced, its sentences classified again, all in the order that unit states; it takes no lock above rank 60 and none its caller did not state' },
  // The wiki's opening context, appended to what `dequeueTurn` is about to deliver (design §7.1).
  // It runs inside that unit's rank-30 Session transaction and reads unlocked: the session's
  // workspace binding, its space's settings, the space's eligible entries, and the task or first
  // message its relevance is weighed against — all plain SELECTs before any row is written. Its
  // one write is the exposure ledger, one row per line sent, and 0307's own comment is why it is
  // safe there: the composite `(entry_id, owner_id)` foreign key takes KEY SHARE on the rank-60
  // entry row rather than reaching the rank-10 user row this transaction must never wait on.
  { at: 'wiki/wiki-push.ts#appendWikiContext', under: 'runnerApi.dequeueTurn — inside the rank-30 Session transaction that already holds this session\'s row FOR UPDATE; it writes only wiki_exposure rows (rank 60) under the entry keys their foreign key takes, so its locks are ascending and its caller\'s retry re-runs it from the rows as the committed world leaves them' },
  // Session requests (sessions/session-request.ts, migration 0350). Every one of them writes
  // `session_request` rows only (rank 60), and none takes a second session: a request is written and
  // judged under its RECIPIENT's lock, its outcome is handed back under its ASKER's in a transaction of
  // its own, and the table has no foreign key to the asker or the owner for exactly that reason.
  { at: 'sessions/session-request.ts#recordSessionRequest', under: "sessions.createTurn and sessions.resume (its revive), through their onTurnWritten hook, for the two session-to-session doors (runnerSessions.sendMessage, projects.sendToCoordinator) — under the rank-30 Session lock of the RECIPIENT those transactions already hold, after the turn row is written. One INSERT of a session_request child row (rank 60) whose one foreign key is that same session row, so it takes no lock outside the one its caller holds; a replay of a committed clientTurnId never reaches it, and a refusal after it rolls it back with the turn" },
  { at: 'sessions/session-request.ts#settleUnrunSessionRequests', under: "sessions.interrupt, sessions.cancelQueuedTurn and sessions.transitionEnd, runnerApi.turnComplete (a failed turn) and runnerApi.finalize, and reaper.forceFinalize — each caller already owns the rank-30 Session transaction that takes the turns off the queue unrun (the last three the turn in flight too), and calls this beside deadLetterQueuedWatchWakes and returnQueuedTurns, before the delete or retire. At most three UPDATEs of session_request rows (rank 60): the asker's outcomes on the turns being taken and on the turn whose failure ends the run, let go or held; the requests on the queued turns being dropped, closed UNDELIVERED by a compare-and-set on OPEN; and, through closeUnreadSteerRequests, the requests on a steer in flight the engine never confirmed, the same way" },
  { at: 'sessions/session-request.ts#closeUnreadSteerRequests', under: "runnerApi.turnComplete, as a steer the runner failed to deliver settles, and settleUnrunSessionRequests for a drain that takes a steer in flight — inside the caller's rank-30 Session transaction for the RECIPIENT: one compare-and-set UPDATE of the session_request rows those steers carry (rank 60), OPEN to UNDELIVERED, so it adds no lock outside the one its caller holds and an outcome that landed first stands" },
  { at: 'sessions/session-request.ts#closeUnansweredRequests', under: "runnerApi.turnComplete — inside the rank-30 Session transaction that parks the session, after the park. Plain reads of the turns carrying the requests and of the wake sources (watch, session_scheduled_wakeup, session_request, project_open_item), then one UPDATE of the session_request rows naming this session as the recipient (rank 60), a compare-and-set on OPEN, so an answer racing it meets it on the row and only one is the outcome" },
  { at: 'sessions/session-request.ts#appendSessionRepliesContext', under: "runnerApi.dequeueTurn — inside the rank-30 Session transaction that already holds this session's row FOR UPDATE: one UPDATE of the session_request rows naming this session as the asker whose outcome is on no turn of its yet (rank 60), putting them on the turn being handed out, then reads. Ascending, and the claim's retry re-runs it from the rows as the committed world leaves them" },
  { at: 'sessions/session-request.ts#attachReplyToTurn', under: "sessions.createTurn's coalesce hook, for SessionRequestService.handOff — under the rank-30 Session lock of the ASKER that createTurn already holds. One compare-and-set of one session_request row (rank 60) onto the reply turn, so it adds no lock outside the one its caller holds; a lost CAS throws SessionReplyHandedOff, which rolls the turn back with it" },
  { at: 'sessions/session-request.ts#replyToSessionRequest', under: "SessionRequestService.reply, with the unmanaged client: a read, then ONE compare-and-set UPDATE of the one session_request row (rank 60, OPEN to REPLIED), so it is an autocommit CAS that takes that row and nothing else — no session row is locked, and an answer racing a NO_REPLY judgment or an expiry meets it on that row's lock, the second finding it no longer OPEN" },
  { at: 'sessions/session-request.ts#expireSessionRequest', under: "SessionRequestWorker.drain, with the unmanaged client: two plain reads, then ONE compare-and-set UPDATE of one session_request row (rank 60, OPEN and past its deadline to EXPIRED) — an autocommit CAS on that row alone; an outcome that landed first stands" },
  { at: 'sessions/session-request.ts#holdReply', under: "SessionRequestService.handOff, with the unmanaged client, after createTurn refused the asker — and SessionRequestService.holdForRetry, inside its transaction after the asker's row FOR SHARE (rank 30): ONE compare-and-set UPDATE of one session_request row (rank 60) whose outcome is on no turn and not yet held — on its own an autocommit CAS on that row alone; another pass that got there first makes it write nothing" },
  { at: 'sessions/session-request.ts#holdTurnRepliesForRetry', under: "runnerApi.turnComplete — inside the rank-30 Session transaction that parks the session idle with an auto-retry armed, after the park. One UPDATE of the session_request rows naming this session as the asker that the completed turn carried (rank 60), taking them off it and holding them, so it adds no lock outside the one its caller holds" },
  { at: 'sessions/session-request.ts#attachHeldReplies', under: "sessions.createTurn and sessions.resume (its revive), through their onTurnWritten hook, for the auto-retry sweep's re-send of a failed reply turn — under the rank-30 Session lock of the ASKER those transactions already hold, after the turn row is written. One UPDATE of the session_request rows naming this session as the asker whose outcome is on no turn (rank 60), putting them on the new turn; none to put there throws NothingHeldToResend, which rolls the turn back with it" },
  { at: 'sessions/session-request.ts#moveSessionRequestToTurn', under: "sessions.createTurn and sessions.resume (its revive), through their onTurnWritten hook, for AutoRetryService.resend — the auto-retry sweep's re-send and the failure card's Retry asking the server for it — under the rank-30 Session lock of the RECIPIENT those transactions already hold, after the re-sent turn is written. One UPDATE of the session_request row the re-sent turn carried (rank 60), pointing it at the new turn, so it takes no lock outside the one its caller holds; a replay of a committed clientTurnId never reaches it" },
  // §2.4's hourly limit (sessions/session-message.ts, migration 0351): what one session sent another,
  // written as it is sent, under the RECIPIENT's lock — the table has no key to the sender, as
  // `session_request` has none to the asker.
  { at: 'sessions/session-message.ts#chargeSessionMessage', under: "sessions.createTurn and sessions.resume (its revive) through participateSendTransaction, and sessions.interrupt through participateFollowUpTransaction, for the three session-to-session doors (runnerSessions.sendMessage, runnerSessions.interruptSession, projects.sendToCoordinator) — under the rank-30 Session lock of the RECIPIENT those transactions already hold, before the turn row is written. A DELETE of this pair's session_message_charge rows whose hour is over, a count of the rest, and one INSERT when the message is admitted (rank 60, its one foreign key that same session row), so it takes no lock outside the one its caller holds; a replay of a committed clientTurnId never reaches it, and a refusal after it rolls it back with the turn" },
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
  { at: "runner-api/integration-job-relay.ts#receiveIntegrationJobProgress", class: "ONE_ROW_CAS", statements: 1, note: "A claimed integration job's lease renewal and the step it reached (contract §2.2 J-T4). One conditional UPDATE whose predicate is the job, this runner, RUNNING, and the exact (leaseOwner, claimGeneration) the report names: a process whose claim was taken over matches no row and is told STALE_CLAIM, which is how it learns to stop rather than going on working against a job that is no longer its. Deliberately no transaction — it writes two columns of one row, holds nothing, and a renewal that does not arrive costs only the lease, whose expiry is the takeover this fence exists to make safe." },
  { at: "projects/project-promotion.service.ts#markPromotionRechecking", class: "ONE_ROW_CAS", statements: 1, note: "A confirmed promotion whose landing job found the upstream had moved, so the merge and the checks are being redone on the new tip (contract §3.3 M-T7). One conditional UPDATE predicated on `state = 'CONFIRMED'`, which is what makes a progress report arriving twice, or arriving after the owner cancelled, write nothing. Deliberately no transaction: it runs on a heartbeat-sized progress report whose only other effect is a lease renewal, and a report that does not arrive costs the reader the word RECHECKING while the landing carries on regardless — the upstream the job actually merged onto is in the result either way." },
  { at: "attachments/attachments.service.ts#create", class: "INSERT", statements: 1 },
  { at: "wiki/wiki-import.ts#registerWikiNote", class: "INSERT", statements: 1, note: "One imported file as a wiki note (migration 0316, contract `import.note`): one INSERT of the redacted text and its sha256 into one of the owner's spaces, whose foreign key takes that space row FOR KEY SHARE and nothing else — a wiki write that locks wiki rows only. The note is read first by (space, content hash); two imports of the same text racing to write it meet the unique index, and the loser's P2002 is answered by reading the winner's row, so it is the same note either way. Deliberately no transaction: nothing else is written with it, and a registration that does not arrive is made again by the next run of the import." },
  { at: "attachments/attachments.service.ts#removeTaskInput", class: "MANY_ROWS", statements: 1, note: "Deletes at most one row — the id is a primary key — but written as a filtered deleteMany because the tenancy and scope predicates (`owner_id`, `task_id IS NOT NULL`) are what make a foreign id and a transcript's image indistinguishable 404s. The selection can overlap no other writer: a task input is deleted by its owner or by its task's CASCADE, and both remove the same row." },
  { at: "auth/auth.service.ts#bootstrap", class: "INSERT", statements: 1 },
  { at: "auth/auth.service.ts#changePassword", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "auth/auth.service.ts#issueRefreshToken", class: "INSERT", statements: 1 },
  { at: "auth/auth.service.ts#logout", class: "ONE_ROW_CAS", statements: 1 },
  { at: 'queue/queue.service.ts#accountsForClaim', class: 'ONE_ROW_CAS', statements: 2, note: "At most two UPDATEs of the claimed session's row by its key, from buildSession after the claim committed, and only when the session is on Automatic and its runner's own snapshot reports its account spent. The move is the compare-and-set: predicated on the account the claim read and on the session not being pinned, so a pick made in between writes nothing here and the engine is built where that pick put it. The second writes the transcript line owed, only while none is (`pool_switch_notice IS NULL`), as PoolNotices.owe does. Deliberately no transaction: each statement stands alone, and one that does not land costs only the move, which the usage-limit failure then makes as it always did." },
  // The three writes exception items make outside anybody's transaction. All of them run after the
  // fact they are about has committed, and none of them may cost it: a delivery that could not be
  // made is re-derived from the same rows the next time the conversation's turn ends (§4.4 X-D4).
  { at: "projects/project-fuse.service.ts#replay", class: "ONE_ROW_CAS", statements: 1, note: "Records what became of one held action after its door was asked again. Outside any transaction because the door it calls opens a session of its own, and one CAS per action so a resume that dies part-way leaves every action it did replay marked as replayed: the predicate is `state = 'HELD'`, which is exactly the set a second pass would try again." },
  { at: "tasks/owner-confirmation-review.service.ts#deliver", class: "ONE_ROW_CAS", statements: 1, note: "Binds a review to the turn its delivery queued when `createTurn` replayed that turn without running the hook (docs/owner-confirmation-review-contract.md §2 D2) — a no-op after the hook, whose own compare-and-set already wrote DELIVERED. Predicated on `delivery = 'PENDING'`, so a re-issue matches nothing; the review row is the only one written." },
  { at: "tasks/owner-confirmation-review.service.ts#refuseDelivery", class: "ONE_ROW_CAS", statements: 1, note: "Writes a delivery's refusal and its code after the turn's transaction rolled back (§2 D2, D4). Predicated on `delivery = 'PENDING'`, so a refusal is written once and never over a delivery that won: a refused review is final, and the owner's card is what covers it." },
  { at: "projects/project-open-item.service.ts#deliver", class: "ONE_ROW_CAS", statements: 1, note: "Names the turn its delivery queued. The row itself is written inside `createTurn`'s transaction, before the turn exists, so this is the one thing left to say afterwards; `turnId: null` in the predicate makes a re-issue a no-op, and a process that dies here leaves a delivery whose turn is still found by its key — which is what every read of one uses anyway." },
  { at: "projects/project-open-item.service.ts#handToOwner", class: "ONE_ROW_CAS", statements: 1, note: "Moves one item to the account owner when the conversation it was owed to has ended, or the project has none. The predicate repeats the assignment this delivery was for, so an item something else reassigned in the meantime is left exactly as that left it — and asks that the item is still owed (`openItemOwed`), so one about a candidate or a task that has moved on is left for the escalation tick's backstop to close rather than handed to a person." },
  { at: "projects/project-open-item.service.ts#resolveByFact", class: "MANY_ROWS", statements: 2, note: "Closes the items of tasks that moved on, re-derived from the task rows: done, cancelled, replaced, or being attempted again — and, in a second statement over the same task ids, the integration items of a task that was cancelled or replaced (§4.2 answers those two facts and not the other two). Each predicate is what makes a re-issue safe — it matches only OPEN items whose task already says so — and the rows they take are one project's items, never a cross-owner selection." },
  // The three writes a question to the account owner makes (§5.2 R7–R11). Asking and answering are
  // each one statement outside any transaction, because neither is part of somebody else's fact: the
  // question is the coordinator's own call, and the answer is the owner's.
  { at: "projects/project-open-item.service.ts#askOwner", class: "INSERT", statements: 1, note: "The question itself: one createManyAndReturn with skipDuplicates against the partial unique index on (project, dedupe key) for OPEN items, so a tool call retried after a lost response files one question rather than asking the owner the same thing twice. The key is the caller's own `clientQuestionId`, or a fresh one when it sent none — one call, one question. Losing the race returns the row that won; a key held by a question that has since been ANSWERED matches neither and is refused, because filing nothing and reporting success is how a coordinator ends up waiting on an answer nobody was asked for." },
  { at: "projects/project-open-item.service.ts#answerOpenItem", class: "ONE_ROW_CAS", statements: 1, note: "The owner's answer, and the end of the question in the same statement: an UPDATE whose predicate is the item and `state = 'OPEN'`, writing RESOLVED/ANSWERED with the answer beside it. A question gets one answer — a second press, or one racing another window, matches no row and is told so rather than replacing an answer the coordinator may already have acted on. The delivery that follows is `deliverAnswer`, after this has committed, because who is coordinating the project is read after the answer is a fact." },
  { at: "projects/project-open-item.service.ts#returnToCoordinator", class: "ONE_ROW_CAS", statements: 1, note: "The owner handing an escalated item back (§4.7), and the restart of its clock in the same statement: an UPDATE whose predicate is the item, `state = 'OPEN'` and the assignment the press was read from, writing COORDINATOR/DEFAULT with `assigned_at`, `waiting_since` and `escalate_at` moved together. A second press, or one racing the coordinator's own recovery on the same row, matches nothing and is told to read the project again rather than reporting a hand-back it did not make. The delivery that follows is `deliver`, after this has committed — and across the two reads the project's coordinator is resolved twice on purpose: the refusal in front of the write asks whether there is a conversation to hand the item TO, and the delivery asks which one it is NOW, which a rotation between them can have changed." },
  { at: "projects/project-open-item.service.ts#resolveOpenItem", class: "ONE_ROW_CAS", statements: 1, note: "The assignee closing an item it handled (§4.7's \"标记已处理\"), and the last ending of an item that no fact produces: an UPDATE whose predicate is the item and `state = 'OPEN'`, writing RESOLVED with the resolution the kind has (HANDLED, or WITHDRAWN for a question the conversation that asked it takes back), the moment, the side that pressed (USER with the owner id, or COORDINATOR with the acting session), and the reason — which is the whole of what a hand-closed item adds to the record, since the platform could not verify the ending. A second press, or one racing a platform fact on the same row, matches nothing and is told to read the project again rather than reporting a close it did not make; the row's own terminal guard refuses a rewrite under either." },
  { at: "projects/project-start-request.ts#supersedeStaleStartRequest", class: "ONE_ROW_CAS", statements: 1, note: "A start request whose plan moved under it — the criteria seal or the plan digest it names is no longer the project's — superseded the first time a reader is about to show it (`GET /projects/:id/open-items`). One conditional UPDATE whose predicate is the item and `state = 'OPEN'`, so a request a newer request or a start already ended is left as that ending wrote it, and the row's terminal guard refuses a rewrite of either. Outside any transaction and unlocked on purpose: the digests are recomputed from committed rows, a plan edit racing the read only means the next read supersedes it, and the request door (projects/project-open-item.service.ts#requestStart) and the start take the project lock this does not need." },
  { at: "projects/project-open-item.service.ts#deliverAnswer", class: "ONE_ROW_CAS", statements: 1, note: "Names the turn the answer's delivery queued, the same one thing `deliver` above has left to say: the delivery row is written inside `createTurn`'s transaction by acknowledgeAnswer, before the turn exists. `turnId: null` in the predicate makes a re-issue a no-op. Nothing here fails its caller — a conversation that ended, or a key this generation already holds, leaves the answer on the item for the next coordinator to be told (R11), which is the whole point of keying a delivery by session rather than by moment." },
  { at: "projects/open-item-escalation.service.ts#sweep", class: "MANY_ROWS", statements: 1, note: "The escalation clock (§4.6 X-E1), and the only write in this system a timer issues rather than a committed fact. It hands items that waited out their project's window to the account owner and writes nothing else — no turn, no session, no wake, no delivery — which is what keeps a clock out of agent work. Selection and effect are the same statement: it takes rows that are OPEN, still the coordinator's and already due — past `escalate_at`, and not carried by a live coordinator conversation that has moved within the item's window since the item was put on it (`escalatesAt`, which reads `conversation_turn` and never writes it) — and moves them out of that set, so two apiservers ticking together escalate each row once and a tick a minute for an hour escalates it on the first one. It overlaps `resolveByFact` and `handToOwner` on one project's items; whichever commits first wins, and neither can turn a resolved item back into an open one — the terminal guard trigger refuses a resolved row outright. An item nobody owes any more (`openItemOwed`, which reads `project_promotion` and `task` and writes neither) is outside its selection, whether or not `reconcile` has closed it yet." },
  { at: "projects/open-item-escalation.service.ts#reconcile", class: "MANY_ROWS", statements: 1, note: "The backstop the escalation tick runs before `sweep` (§4.2), on that tick and no clock of its own (§8.3). It closes every OPEN item nobody owes any more (`openItemOwed`: a merge card whose candidate is not READY, an INTEGRATION_* item whose candidate left the live states or whose task was cancelled or replaced) with the ending the missed edge would have written — PROMOTION_MOVED_ON (SUPERSEDED when the candidate was) or TASK_CLOSED, by the PLATFORM, with a `resolution_note` that starts `backstop:` — and writes nothing else: no turn, no session, no wake, no delivery. Selection and effect are one statement, the selection re-checked on `state = 'OPEN'`, so two apiservers ticking together close each row once and the next tick finds nothing; `project_promotion` and `task` are read, never locked. It overlaps the edges it backs up (`closePromotionItems`, `resolveByFact`) and every hand-close on the same rows; whichever commits first wins, and the terminal guard trigger refuses a rewrite of the loser's row. What follows the statement is a read and a log line: the integration items whose task landed after they were opened stay open and are reported." },
  { at: "auth/auth.service.ts#refresh", class: "MANY_ROWS", statements: 2, note: "Two statements: the reuse-detection revoke of every live token for the user, then the CAS claim of this one. Not atomic with each other; the CAS is what makes the outcome unambiguous." },
  { at: "sessions/auto-retry.service.ts#disarmIfStillAggregateParent", class: "ONE_ROW_CAS", statements: 1, note: "The one write is inside `underAggregateParentLock`'s transaction; this method itself only issues the guarded read that decides whether to call it." },
  { at: "sessions/auto-retry.service.ts#refundIfStillAggregateParent", class: "ONE_ROW_CAS", statements: 1, note: "As above: the write belongs to `underAggregateParentLock`, which owns the locks and the compare-and-set." },
  { at: "projects/coordinator-wake.service.ts#insertClaim", class: "INSERT", statements: 1, note: "The wake claim: one INSERT with ON CONFLICT DO NOTHING against the partial unique index of migration 0174, RETURNING the id so the loser of a race learns it lost without a second read. Not in a transaction, deliberately — authorization runs between this statement and the release below, and holding a row lock across a call this unit does not time is how a claim becomes a queue." },
  { at: "projects/coordinator-wake.service.ts#release", class: "ONE_ROW_CAS", statements: 1, note: "Giving the key back. The compare-and-set on CLAIMED is what makes a claim releasable exactly once, so a second refusal cannot rewrite the code the first one recorded. Leaving this write out is the accident it exists to prevent: a refusal that keeps the key welds that fact shut forever (project_action, coordinator rotation)." },
  { at: "projects/coordinator-wake.service.ts#consume", class: "ONE_ROW_CAS", statements: 1, note: "Binding a claimed criterion-input fact to its non-session consumer. The CLAIMED-to-CONSUMED compare-and-set stamps consumer_type/consumed_at together; CONSUMED remains inside the partial unique index, so replay cannot evaluate or deliver the same event + subject + evidence/version twice." },
  { at: "projects/coordinator-judgment.service.ts#open", class: "ONE_ROW_CAS", statements: 1, note: "Binding the one judgment session a wake gets. The compare-and-set on CLAIMED is what makes 'at most one session per wake' a fact of the database rather than of a read — a second caller holding the same wake matches no row, discards its session and says ALREADY_OPEN. The session row itself is written by sessions.create, which is inventoried under its own entry; this statement only names it. The status it writes, SESSION_OPENED, is inside 0174's partial unique index, so the fact goes on holding its key and can never claim a second session." },
  { at: "projects/coordinator-delivery.service.ts#send", class: "ONE_ROW_CAS", statements: 1, note: "Binding a wake to the message it put on the project's standing coordinator conversation. The compare-and-set on CLAIMED is the same rule the judgment bind uses, and for the same reason: a caller that lost matches no row and says ALREADY_DELIVERED rather than writing a second terminal. It writes `delivery` in the same statement, because what a delivery handed over only exists once the wake is authorized and `detail` is written by the INSERT that claims the key, before that. The turn itself is written by sessions.resume, which is inventoried under its own entry; this statement only names its key. DELIVERED is inside 0174's partial unique index, so the fact goes on holding its key and can never send a second message." },
  { at: "projects/coordinator-delivery.service.ts#enqueue", class: "ONE_ROW_CAS", statements: 1, note: "The same CLAIMED-to-DELIVERED compare-and-set as `send`, for the queued carrier. The bind normally happens inside the turn's own transaction (`bindQueuedDelivery`); this statement covers the one path that skips that hook — `createTurn` replaying a turn already written under the fact's key — so a replay cannot leave the key CLAIMED for ever. Matching no row is the ordinary answer when the hook already bound it. DELIVERED is inside 0174's partial unique index, so the fact keeps its key and never writes a second message." },
  { at: "sessions/session-request.service.ts#commentOnAskerTask", class: "INSERT", statements: 1, note: "The outcome of a session request whose asking session had ended — or stopped for good with the outcome held for it, the auto-retry it waited on given up — written on the task that session ran (docs/session-request-reply-contract.md §4.3, §8 criterion 17): one INSERT ... ON CONFLICT DO NOTHING whose primary key is derived from the request id, so the hand-off or the worker processing it again — in sequence or at once — finds the one row instead of adding a second. Written before the hold, or the clearing of the mark, that says it is done, so a pass cut off between the two writes it again as nothing. Not in a transaction, deliberately: the outcome it reports has already committed, and holding nothing here keeps it from waiting on a task lock with a row of its own held." },
  { at: "sessions/session-request.service.ts#clearMark", class: "ONE_ROW_CAS", statements: 1, note: "Answers migration 0352's mark, once the outcome it stood for has been said: §4.3's comment on the task an ended asker ran, or — for an asker that turned out to be merely idle (§8 criterion 21) — the hold released for the ordinary hand-off. One compare-and-set on the mark as it was read and on the outcome still being on no turn, so a mark set again in between is left for the next pass. The comment and the hand-off it follows are their own units (commentOnAskerTask, handOff); this is the statement that says the pass is done, written after them so a pass cut off between the two finds the row and says it again as nothing. It is also the answer for a request whose asker's row is gone, which nothing else would ever clear." },
  { at: "sessions/session-request.service.ts#releaseHeld", class: "ONE_ROW_CAS", statements: 1, note: "Lets go of an outcome held for an asker whose retry was given up while it stayed parked and live (§4.2, §8 criterion 21), so the ordinary hand-off queues the reply turn it would have queued had the outcome arrived a moment later. One compare-and-set whose predicate is the outcome on no turn and still held, so a pass racing another (or a turn that took it first) writes nothing; the mark migration 0352 set goes with the hold, in the same statement, because what it stood for is exactly what this decided is not true." },
  { at: "projects/criteria-decision-reply.ts#sendCriteriaDecisionReply", class: "INSERT", statements: 1, note: "The answer to a decided criteria proposal, written on the task its proposing session ran when that session had ended: one INSERT ... ON CONFLICT DO NOTHING whose primary key is derived from the intent id, so the reply processed again — in sequence or at once — finds the one row and reads it back instead of adding a second. The answer to a session that has not ended is a turn written by sessions.createTurn, inventoried under its own entry; this unit only names that turn's clientTurnId, derived from the same intent. Not in a transaction, deliberately: the decision it reports has already committed, and holding nothing across createTurn is what keeps the reply from waiting on a session lock with a row of its own held." },
  { at: "projects/attempt-ended-unsettled.producer.ts#reconcileResolvedHumanSignals", class: "MANY_ROWS", statements: 1, note: "One explicitly invoked compatibility repair UPDATE over this retired producer's own open signal code. It is no longer a bootstrap/provider path and never treats AWAITING_INPUT as completion input. Reissuing reaches the same resolved rows and writes no status." },
  { at: "projects/attempt-ended-unsettled.producer.ts#resolveHumanSignal", class: "ONE_ROW_CAS", statements: 1, note: "Best-effort close of this Task's one open missing-path blocker after settlement or a successful path. The open-row predicate makes a redelivery a no-op; it never writes Task status." },
  { at: "projects/project-blocker-resolution.ts#resolveProjectBlocker", class: "ONE_ROW_CAS", statements: 1, note: "The account owner ending one open blocker with a reason (0269). One conditional UPDATE whose predicate is the row's own id and project, the project's owner and `resolved_at IS NULL`: a second press, a concurrent automatic resolution or somebody else's request matches nothing, and the read that follows says which of those it was. `project_blocker_resolution_final` refuses any later rewrite of what it wrote." },
  { at: "projects/wake-disposition.service.ts#resolveLandedBlockers", class: "ONE_ROW_CAS", statements: 1, note: "Post-commit, once per open blocker a delivery raised whose work now has a landing receipt: resolved_by = AUTO with the branch it landed on. Each statement is a compare-and-set on `resolved_at IS NULL`, so a redelivery, a second receipt for the same landing or an owner who resolved it first writes nothing; nothing here re-opens a row." },
  { at: "projects/project-acceptance.service.ts#confirmStandardSet", class: "INSERT", statements: 1, note: "The account owner confirming that one VERSION of a project's acceptance criteria expresses its goal (migration 0245), on a project that has been started. (On one that has not, the same press starts it — with the default settings, through projects/project-acceptance.service.ts#start, the transaction `POST /projects/:id/start` uses — and this statement is not reached; a start that finds the project started by a concurrent press lands here instead.) The other writers of the relation are that start and projects/projects.service.ts#decideCriteriaChange, carrying a confirmation over an edit the owner approved there, inside that decision's transaction. Deliberately no transaction and no project lock: an edit landing between the digest comparison and the INSERT can only make the row non-current, which the read reports by comparing the stored digest with the criteria as they stand. Nothing UPDATEs or DELETEs this relation, so a second confirmation is a second row rather than a rewrite of the first. Re-issuing a lost request writes a second row naming the same version, which says exactly what happened and changes no answer. It writes nothing to the project: until migration 0331 a second statement turned `coordinator_enabled` on here, because confirming was how a project started; a start is its own fact now (`project.started_at`), and re-confirming criteria is not a decision about Automatic." },
  { at: "projects/project-done-derived.ts#storeDerivedProjectStatus", class: "ONE_ROW_CAS", statements: 1, note: "The projection of `project.status` from committed facts — every stated criterion satisfied, landed and not written by the session producing its own evidence, and a confirmation naming the version of the criteria that stands today — and of the DONE record beside it (`done_by`, `done_at`, `done_criteria_digest`, `accepted_gaps`, migration 0345). One conditional UPDATE, whose predicate is the status and the record the row must currently hold, as read: OPEN to write DONE recorded DERIVED, a DONE the projection or a status write left to write OPEN with no record, and a DONE the owner recorded only when one of its two facts moved — the seal it was recorded against is not the current one, or a task serving a criterion started a lifecycle epoch after it (`task_progress.epoch_started_at`, read) — to write OPEN, or DERIVED when the facts now prove it. That is what makes two post-commit edges deriving the same answer write the row once rather than race to write the same value twice, why an owner's record committed between the read and this statement is never projected over, and why CANCELLED is unreachable in both directions without a second statement to say so. Deliberately no transaction and no project lock: everything it reads is already committed, and a task write or a confirmation landing between the read and this statement only means the next edge re-derives from the newer rows — the answer is a function of the rows, so a stale one is corrected rather than compounded. Re-issuing it is the same statement against the same rows and writes nothing the first one did not; the coordinator is told of a reopened owner record only by the edge whose statement wrote it, under a turn keyed by that record (projects/project-started.ts#tellCoordinatorProjectReopened)." },
  { at: "projects/project-handoff.service.ts#decide", class: "ONE_ROW_CAS", statements: 1, note: "The user's answer, as a compare-and-set on the state it was read in: two clicks produce one answer and one 409. Re-approving a live yes writes nothing at all — it returns the row unchanged, so an approval's own deadline cannot be extended by clicking approve again." },
  { at: "providers/codex-login.service.ts#store", class: "ONE_ROW_BY_KEY", statements: 1, note: "One of the ChatGPT logins a personal Codex pool holds (migration 0323), written by the poll that finds the sign-in confirmed: one upsert keyed by (pool_id, account_id), whose primary key is what makes a re-login of the same account take its row over rather than write a second — and another account a row of its own. Two statements' worth of locks are avoided by that key alone — the read before it only decides between this and the 409 for an account the pool already runs on. Its foreign key (pool_id, user_id) → provider_pool(id, owner_id) takes FOR KEY SHARE on the pool row, which only its owner's writes to the pool or provider_pool_engine_check-adjacent DDL touch; no session, task or runner row is involved. No transaction of its own, deliberately: the tokens are in memory until this statement lands, and a lost one leaves the sign-in to be run again, which is the same cheap flow." },
  { at: "providers/codex-login.service.ts#signOut", class: "ONE_ROW_BY_KEY", statements: 1, note: "The owner taking one account out of their pool: one DELETE by (pool_id, account_id) — the account its fingerprint names, or the pool's first, read just before — over pool_codex_login, as deleteMany so an account already taken out answers removed: 0 rather than an error. The pool's other accounts are not in its selection. Nothing else goes with it: a session token (pool_login_token) names no account since migration 0355, so no session, task or runner row is touched and none is locked — a session that was running on this account is answered by the gateway as a pool holding no account, and its next claim is what moves it." },
  { at: "providers/codex-login.service.ts#markSignedOut", class: "ONE_ROW_CAS", statements: 1, note: "ACTIVE to SIGNED_OUT on one account of one pool, by (pool_id, account_id), for the pool gateway on an upstream 401 (P3-b): an account already signed out, or one signed in again meanwhile, matches nothing, and the pool's other accounts are not in its selection. One conditional UPDATE; no trigger on pool_codex_login fires on `state`." },
  { at: "providers/codex-login.service.ts#markSpent", class: "ONE_ROW_BY_KEY", statements: 1, note: "The Codex backend's 429 `usage_limit_reached` recorded on the account it names (migration 0324): one UPDATE by (pool_id, account_id) of `spent_until` — the reset the backend named — and the window reading that came with it, awaited by the login pools' gateway before the 429 goes back so the retry its turn arms reads it. updateMany rather than update so an account taken out of the pool meanwhile is a no-op, not an error. No trigger on pool_codex_login; the publish that follows is outside any transaction." },
  { at: "providers/codex-login.service.ts#clearSpent", class: "ONE_ROW_CAS", statements: 1, note: "The backend took a request on an account marked spent: `spent_until` back to NULL on that one row, conditioned on its being set, so an account never marked writes nothing. Issued off the stream's path, after its end; one lost only leaves a mark whose time has passed, which no reader counts." },
  { at: "providers/providers.service.ts#addPoolMember", class: "INSERT", statements: 1, note: "One INSERT ... ON CONFLICT DO NOTHING (createMany with skipDuplicates) on the member's primary key, so adding a member twice leaves one row. Both of the row's foreign keys carry owner_id (migration 0265), so a pool or provider of another owner, or a shared provider, fails the insert itself." },
  { at: "providers/providers.service.ts#create", class: "INSERT", statements: 1, note: "Migration 0265's BEFORE trigger also takes a transaction-scoped advisory lock on the slug and reads provider_pool; a slug a pool took first is a P2002, which withFreeSlug answers by re-picking, exactly as it answers another provider taking it first." },
  { at: "providers/providers.service.ts#createPool", class: "INSERT", statements: 1, note: "One nested create: the pool row and its member rows — and, for a Codex pool, its owner's ADMIN provider_pool_person row (migration 0358) — go in as one Prisma write, atomic with each other. The slug guard and the P2002 re-pick are the ones create's entry describes." },
  { at: "providers/providers.service.ts#remove", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "providers/providers.service.ts#removePool", class: "ONE_ROW_BY_KEY", statements: 1, note: "The pool's member rows go with it by CASCADE; no provider row is written." },
  { at: "providers/providers.service.ts#removePoolMember", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "providers/pool-usage-ledger.ts#write", class: "MANY_ROWS", statements: 1, note: "The pool gateway's ledger batch (pool_usage, migration 0321): ONE INSERT … ON CONFLICT DO UPDATE adding every answer gathered since the last write, per (key, person, month). Its rows are sorted by that key, so two writers take their row locks in one order and cannot deadlock each other; the JOINs drop a row whose key or person is gone instead of failing the batch on its foreign key. Not retried here: a failed write puts its rows back to be added with the next batch, two seconds on, which is safe because the statement is all-or-nothing." },
  { at: "providers/pool-login-ledger.ts#write", class: "MANY_ROWS", statements: 2, note: "The login pools' ledger batch (migration 0324), PoolUsageLedger's twin on its clock: ONE INSERT … ON CONFLICT DO UPDATE adding every answer gathered since the last write per (session, account, UTC hour) into pool_login_usage — sorted by that key so two writers take their row locks in one order, and joined to provider_pool and session so a row whose pool or session was deleted meanwhile is dropped rather than failing the batch — and ONE UPDATE of pool_codex_login's `usage`/`usage_read_at` from the latest window reading of each account, sorted by (pool, account) and conditioned on being no older than the one stored. Neither table has a trigger. Each statement is atomic; one that fails puts its rows back for the next batch. The gateway never waits on either: it hands entries over and returns." },
  { at: "providers/pool-notice.ts#owe", class: "ONE_ROW_CAS", statements: 1, note: "A login pool's transcript line owed to the session the gateway just refused or passed a spent answer to: one conditional UPDATE of that session's `pool_switch_notice`, only while it owes none (NULL), so a second request of the same kind owes nothing twice. No Session lock is taken first and none is needed: the column is written here, by the claim (resolvePoolMember / resolveSharedPool / resolveLoginPool) and cleared by the events transaction, and a race between them leaves either the older line or this one owed — never a torn one. Not a column a session trigger fires on. No carrier is queued with it: the turn it is about is still running and its failure drains the queue, so the next claim queues one (QueueService.resolveLoginPool). A failure is logged by the gateway and the request answered all the same." },
  { at: "providers/providers.service.ts#update", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "providers/shared-pools.service.ts#addKey", class: "INSERT", statements: 1, note: "One key of a shared pool (migration 0321). Its composite foreign key names the contributor's provider_pool_person row, so a contributor who is not in the pool fails the insert itself; `pool_api_key_pool_id_key_fingerprint_key` refuses a second add of the same key to the pool, a P2002 answered as the 409 a check before it gives." },
  { at: "providers/shared-pools.service.ts#addPerson", class: "INSERT", statements: 1, note: "One INSERT ... ON CONFLICT DO NOTHING (createMany with skipDuplicates) on the person's primary key, so adding someone already in leaves their row, and their role, as it was. The pool may be a shared one or a Codex pool of its owner's own (migration 0358); either way the row's foreign keys are the pool and the user, and nothing else is written." },
  { at: "providers/shared-pools.service.ts#create", class: "INSERT", statements: 1, note: "One nested create: the shared pool and its creator's ADMIN row go in as one Prisma write. The slug guard and the P2002 re-pick are the ones providers.service.ts#create's entry describes." },
  { at: "providers/shared-pools.service.ts#leave", class: "ONE_ROW_BY_KEY", statements: 1, note: "The caller's own provider_pool_person row; their keys, those keys' ledger rows and their session tokens go with it by CASCADE." },
  { at: "providers/shared-pools.service.ts#markKeyInvalid", class: "ONE_ROW_CAS", statements: 1, note: "ACTIVE to INVALID on one key, for the pool gateway on a 401: a key already refused, or replaced meanwhile, matches nothing." },
  { at: "providers/shared-pools.service.ts#markKeySpent", class: "ONE_ROW_BY_KEY", statements: 1, note: "The out-of-budget reset on one key (migration 0322), for the pool gateway on `insufficient_quota`. Awaited before OpenAI's answer goes back, before any stream: no connection is held while one flows. A key removed meanwhile matches nothing." },
  { at: "providers/shared-pools.service.ts#clearKeySpent", class: "ONE_ROW_CAS", statements: 1, note: "Clears one key's out-of-budget mark when OpenAI took a request on it after all; only a marked key moves. Issued after the stream ended, off its path." },
  { at: "providers/shared-pools.service.ts#remove", class: "ONE_ROW_BY_KEY", statements: 1, note: "The shared pool; its people, keys, ledger rows and session tokens go with it by CASCADE." },
  { at: "providers/shared-pools.service.ts#removeKey", class: "ONE_ROW_BY_KEY", statements: 1, note: "One key; its ledger rows go with it by CASCADE. A session whose pool_key_id named it chooses again at its next claim." },
  { at: "providers/shared-pools.service.ts#removePerson", class: "ONE_ROW_BY_KEY", statements: 1, note: "One provider_pool_person row, by its primary key; the person's keys, those keys' ledger rows and their session tokens go with it by CASCADE." },
  { at: "providers/shared-pools.service.ts#replaceKey", class: "ONE_ROW_BY_KEY", statements: 1, note: "A new secret, fingerprint and hint for one key, and ACTIVE again; the fingerprint index refuses a secret already in the pool under another key." },
  { at: "providers/shared-pools.service.ts#setRole", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "providers/shared-pools.service.ts#update", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "providers/shared-pools.service.ts#updateKey", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "push/push.controller.ts#register", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "push/push.controller.ts#unregister", class: "ONE_ROW_CAS", statements: 1 },
  { at: "push/push.service.ts#deliver", class: "ONE_ROW_CAS", statements: 1, note: "Runs inside the APNs delivery loop: the HTTP call is what decides the delete, so the write is a consequence of an external action rather than the other way round. Nothing about it is transactional and nothing re-sends the notification." },
  { at: "realtime/realtime.service.ts#drainCommitRequests", class: "ONE_ROW_CAS", statements: 1 },
  { at: "realtime/realtime.service.ts#drainMergeRequests", class: "ONE_ROW_CAS", statements: 1 },
  { at: "realtime/realtime.service.ts#failAbandonedWorktreeOperations", class: "MANY_ROWS", statements: 2 },
  { at: "realtime/realtime.service.ts#notifyRaw", class: "NOT_A_ROW_WRITE", statements: 1, note: "pg_notify, not a row write. Listed so the scan has somewhere to put it." },
  { at: "realtime/reaper.service.ts#purgeTrash", class: "MANY_ROWS", statements: 1 },
  { at: "runner-api/codex-reset-plan-usage.ts#storeHeartbeatPlanUsage", class: "ONE_ROW_CAS", statements: 1, note: "A heartbeat's planUsage, compare-and-set on the stored value its Codex reset block was merged against (docs/codex-rate-limit-reset-contract.md §8). A lost race re-reads and merges again, at most PLAN_USAGE_CAS_ATTEMPTS times, then writes nothing and leaves the next heartbeat to report again; no attempt can store an older block over a newer one. Kept out of the heartbeat's own update, which stays one plain write to the hot runner row." },
  { at: "runner-api/codex-reset-plan-usage.ts#storeRefreshedCodexResetBlock", class: "ONE_ROW_CAS", statements: 1, note: "The block of a REFRESHED Codex reset result, compare-and-set into the stored Codex snapshot on the same terms as the heartbeat's planUsage write (docs/codex-rate-limit-reset-contract.md §6.3, §8): written only while planUsage is still the value it was ordered against, re-read at most PLAN_USAGE_CAS_ATTEMPTS times, never over a newer block and never into a runner with no Codex snapshot. The operation row was already settled by its own transition; this write is the planUsage half only." },
  { at: "runner-api/runner-api.controller.ts#artifactResult", class: "ONE_ROW_CAS", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#claudeHistoryResult", class: "ONE_ROW_CAS", statements: 1, note: "What one runner found under the directory it was asked about. The predicate is the asked-for path, not just the runner id: a scan that finishes after the person typing moved on matches no row, so an answer about an abandoned directory is dropped instead of becoming the verdict on the one in the field now. Re-POSTing the same answer writes the same values." },
  { at: "runner-api/runner-api.controller.ts#applyAccountRemoveResult", class: "ONE_ROW_CAS", statements: 2, note: "What one account removal came to, as the runner reports it. The predicate is the removal the report names — `pending`, the engine whose store it is in, the account, and the `codex_account_remove_at` it was asked at — not just the runner id: a report about a removal the row has moved past (the person asked again), about a different account, or about another engine's store, matches no row and is dropped. A success clears the failure message the last one left; re-POSTing the same outcome writes the same values. A success that applied then takes the removed account's key out of `account_names` with a second, hand-written UPDATE of the same row (fenced on the key being there, so a re-POST matches nothing): not atomic with the first, and it need not be — a name left behind names an account no report lists, which nothing shows." },
  { at: "runner-api/runner-api.controller.ts#createApproval", class: "INSERT", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#createDeviceSession", class: "INSERT", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#deregister", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#devicePoll", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#diffResult", class: "ONE_ROW_CAS", statements: 2 },
  { at: "runner-api/runner-api.controller.ts#drainClaudeHistoryRequest", class: "ONE_ROW_CAS", statements: 1, note: "Handing the directory scan to exactly one heartbeat. The compare-and-set on `pending` plus the path it was read at is what makes two API replicas draining the same moment give the work to one runner process; the loser matches no row and sends no command. Unlike the relays beside it this is never redelivered — a request nobody answers expires, and retyping the path asks again." },
  { at: "runner-api/runner-api.controller.ts#drainAccountRemoveRequest", class: "ONE_ROW_BY_KEY", statements: 2, note: "Two statements, one slot: the removal a runner is handed on its heartbeat, and the row that gives up on it. The request is redelivered while it is `pending`, like the sign-in relay's start, so re-reading it every beat is the mechanism rather than a hazard. The second write is the terminal one — a runner that does not declare that engine's account-removal capability (it would ignore the request and leave the account behind), or one that has not answered past the relay window, both of which settle the row as failed with the reason the page shows. Neither writes while another removal is in flight: the predicate is the row's own `pending` status." },
  { at: "runner-api/runner-api.controller.ts#drainAccountRemoveRequest", class: "ONE_ROW_BY_KEY", statements: 2, note: "Two statements, one slot: the removal a runner is handed on its heartbeat, and the row that gives up on it. The request is redelivered while it is `pending`, like the sign-in relay's start, so re-reading it every beat is the mechanism rather than a hazard. The second write is the terminal one — a runner that does not declare that engine's account-removal capability (it would ignore the request and leave the account behind), or one that has not answered past the relay window, both of which settle the row as failed with the reason the page shows. Neither writes while another removal is in flight: the predicate is the row's own `pending` status." },
  { at: "runner-api/runner-api.controller.ts#drainInstallRequest", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#drainLoginRequest", class: "ONE_ROW_BY_KEY", statements: 3 },
  { at: "runner-api/runner-api.controller.ts#drainModelCatalogRefresh", class: "ONE_ROW_CAS", statements: 1, note: "The clear is the claim: whoever's UPDATE matches the pending timestamp is the beat that carries the request." },
  { at: "runner-api/runner-api.controller.ts#drainRepoCleanupRequest", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#heartbeat", class: "MANY_ROWS", statements: 5, note: "Five separate statements, deliberately: a heartbeat that half-lands is a heartbeat, and making them atomic would put the hot runner row in a transaction with a multi-row workspace sweep. The fifth drops a settled commit error the runner reports expired, matched on its exact operation id so a newer click or a later failure is never the one cleared." },
  { at: "runner-api/runner-api.controller.ts#installResult", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#loginResult", class: "ONE_ROW_CAS", statements: 1, note: "One step of the sign-in relay, as the runner reports it. The predicate is the start the report names (`login_at`), not just the runner id: a report about a sign-in the row has moved past — cancelled, or replaced by another account's — matches no row and is dropped. A runner too old to name its start is applied by the runner id alone, as before." },
  { at: "runner-api/runner-api.controller.ts#markProviderUpgradeRequired", class: "MANY_ROWS", statements: 1, note: "The upgrade notice on the PENDING rows of one runtime the claim SQL withholds from a runner that has not advertised it (OpenCode, Antigravity: ADVERTISED_RUNTIMES), called once per such runtime. Display only — it sets `error`, which the claim that finally takes the row clears." },
  { at: "runner-api/runner-api.controller.ts#markSourceProtocolUnsupported", class: "MANY_ROWS", statements: 1, note: "SR35's explanation, written onto the PENDING rows the claim SQL is withholding from a runner without `source-pin/v1`. Display only — it sets `error`, never `source_state`, so the session stays dispatchable to a newer runner." },
  { at: "runner-api/runner-api.controller.ts#reclaim", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#reconcileReportedBranchMerged", class: "ONE_ROW_CAS", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#register", class: "INSERT", statements: 3, note: "Three statements: the runner upsert and the enrollment-token burn. Re-registering is idempotent on the runner row." },
  { at: "runner-api/runner-api.controller.ts#repoCleanupResult", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runner-api/runner-api.controller.ts#uploadAttachment", class: "INSERT", statements: 1 },
  { at: "runner-api/scheduled-wakeup.ts#cancelScheduledWakeup", class: "ONE_ROW_CAS", statements: 1, note: "The session's waiting wakeup, PENDING to CANCELLED. A filtered updateMany because the waiting row is found by its session rather than by id; the partial unique index over PENDING rows means it settles at most one." },
  { at: "runner-api/scheduled-wakeup.ts#dropScheduledWakeup", class: "ONE_ROW_CAS", statements: 1, note: "A due wakeup whose session had ended, PENDING to DROPPED by id. A lost CAS means a replacement, a stop or another pass settled it first." },
  { at: "runner-api/service-token.authorizer.ts#mint", class: "INSERT", statements: 1 },
  { at: "runner-api/service-token.authorizer.ts#revoke", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#approveDeviceEnrollment", class: "INSERT", statements: 3, note: "Three statements: the runner upsert and the enrollment approval." },
  { at: "runners/runners.service.ts#cancelInstall", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#cancelLogin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#createEnrollmentToken", class: "INSERT", statements: 1 },
  { at: "runners/runners.service.ts#removeAccount", class: "ONE_ROW_BY_KEY", statements: 1, note: "Asking one machine to delete one account slot of one engine. One removal per runner, like the sign-in relay: a second ask replaces the first, and it answers whatever engine and account were named last. The account itself is not read or written here — it lives on the runner — so this is the request row and nothing else; a runner that has not declared that engine's account-removal capability is refused before the write." },
  { at: "runners/runners.service.ts#removeRunner", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#renameAccount", class: "ONE_ROW_BY_KEY", statements: 1, note: "One hand-written UPDATE of one runner by id and owner: the account's name goes into its own key of `account_names` with jsonb operators inside the statement (or that key comes out, for a name the account carries anyway), so two renames of the same runner's accounts cannot overwrite each other the way reading the object and writing it back would. No trigger names the column; re-issuing it writes the same key again." },
  { at: "runners/runners.service.ts#requestClaudeHistory", class: "ONE_ROW_BY_KEY", statements: 1, note: "Asking one machine what Claude Code history sits under a path. One slot per runner, like the sign-in and install relays: a second ask replaces the first, because it answers whatever directory was typed last. The previous answer is deliberately left in the row — the read only returns one whose path matches what was asked — so re-asking about the same directory shows the last answer at once while a fresh scan runs." },
  { at: "runners/runners.service.ts#requestModelCatalogRefresh", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#rotateToken", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#startEngineUpdate", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#startInstall", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#startLogin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#submitLoginCode", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "runners/runners.service.ts#updateRunner", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "session-folders/session-folders.service.ts#create", class: "INSERT", statements: 1, note: "One INSERT, whose foreign keys take the owner (rank 10) and the workspace (rank 15) FOR KEY SHARE. A name the workspace already has meets UNIQUE (workspace_id, name), a permanent answer (409) that is never retried. The user-scoped `folder.changed` announcement follows the INSERT that wrote, and a refused create publishes none." },
  { at: "session-folders/session-folders.service.ts#remove", class: "ONE_ROW_BY_KEY", statements: 1, note: "One DELETE by key, scoped to the owner in the statement — and through `session_folder_id_fkey` ON DELETE SET NULL, an UPDATE of every session filed in the folder (rank 30, FOR NO KEY UPDATE, in plan order) after the folder row (rank 25, FOR UPDATE). Ascending, and SessionsService.move takes the same two in the same order. What it can still meet is the MANY_ROWS exposure on those sessions — a sweep holding two of them in the opposite order — answered with the boundary's 503; the owner deletes again. The user-scoped `folder.changed` announcement follows the DELETE that removed the row; the sessions it put back in the list are not announced one by one, and a folder that was not there publishes nothing." },
  { at: "session-folders/session-folders.service.ts#rename", class: "ONE_ROW_BY_KEY", statements: 1, note: "One UPDATE by key, scoped to the owner in the statement. `name` is in a unique index, so the row is taken FOR UPDATE: it waits for the FOR KEY SHARE a move or a session create holds on the folder, and holds nothing else while it does. A clashing name is a permanent 409. The user-scoped `folder.changed` announcement follows the UPDATE that wrote, and a refused rename publishes none." },
  { at: "session-tags/session-tags.service.ts#create", class: "INSERT", statements: 1 },
  { at: "session-tags/session-tags.service.ts#ensureSystemTags", class: "INSERT", statements: 1 },
  { at: "session-tags/session-tags.service.ts#remove", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "session-tags/session-tags.service.ts#update", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/auto-retry.service.ts#copyAttachments", class: "INSERT", statements: 1, note: "One INSERT per image the message being re-sent carried, in a loop — N images, N statements, not atomic with each other. Deliberately: a copy stranded by the next one's failure is turn-less bytes that `discardCopies` deletes and the session's own deletion collects, so there is nothing for atomicity to protect." },
  { at: "sessions/auto-retry.service.ts#disarm", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/auto-retry.service.ts#giveUpClaim", class: "ONE_ROW_CAS", statements: 1, note: "Hands back the attempt this sweep's own claim spent, by a compare-and-set on exactly what that claim wrote, so a session revived in between is left alone." },
  { at: "sessions/auto-retry.service.ts#releaseExpiredClaims", class: "ONE_ROW_CAS", statements: 1, note: "Gives up a retry claim whose re-send was never written once its lease (RETRY_CLAIM_WINDOW_MS) has run out (docs/session-request-reply-contract.md §8 criterion 24): per lapsed row, one compare-and-set on the claim exactly as it was read — its instant, the attempt count it wrote, `retry_at` still NULL and the session still parked as it was — that hands back the attempt the claim spent and clears the claim, the statement `giveUpClaim` writes. A session revived, re-armed, taken back or ended in between matches nothing. One autocommit statement per row and no transaction: each row is its own decision, and the triggers that read the give-up (0350's, 0352/0366's, 0370's) run inside that statement." },
  { at: "sessions/auto-retry.service.ts#discardCopies", class: "MANY_ROWS", statements: 1, note: "Deletes only ids this sweep just created and never linked (`turn_id IS NULL`), so the selection cannot overlap another writer's rows — the shape MANY_ROWS is otherwise exposed to." },
  { at: "sessions/auto-retry.service.ts#rearm", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/auto-retry.service.ts#sweep", class: "ONE_ROW_CAS", statements: 2 },
  { at: "sessions/sessions.service.ts#applyAutoTags", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#beautifySessionLater", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/sessions.service.ts#cancelAutoRetry", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#commitWorktree", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/sessions.service.ts#create", class: "INSERT", statements: 2, note: "Two statements: the session INSERT, then the attachment adoption. An attachment left unadopted is orphaned rather than wrongly attached, which is why this has never needed to be atomic. A session created in a folder (0348) takes that folder FOR KEY SHARE through its foreign key, like every other parent the INSERT names; a folder deleted between the check and the INSERT fails that key, and is answered with the same 400 as naming one that was never there." },
  { at: "sessions/sessions.service.ts#createAutoTags", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#decideApproval", class: "ONE_ROW_CAS", statements: 1 },
  { at: "sessions/sessions.service.ts#enqueueLegacyArtifactRequest", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#persistLegacyArtifactAttachment", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#pin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#rememberForWorkspace", class: "INSERT", statements: 1 },
  { at: "sessions/sessions.service.ts#rename", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#spawnFromSession", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "sessions/sessions.service.ts#unpin", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "share-links/share-links.service.ts#change", class: "ONE_ROW_CAS", statements: 1, note: "Guarded on `revoked_at IS NULL`: a link turned off between the owner's read and this write matches nothing, and the PUT reads again rather than changing a link that has ended." },
  { at: "share-links/share-links.service.ts#end", class: "MANY_ROWS", statements: 2, note: "Two statements, not atomic with each other: the links past their expiry are settled EXPIRED, then the rest are TURNED_OFF. Each only matches rows still open, so a re-issue changes nothing, and a link that expires between the two is recorded TURNED_OFF — ended either way. One root has at most one open link; only the bulk turn-off (an explicit id list, `POST /share-links/turn-off`) matches several." },
  { at: "share-links/share-links.service.ts#insert", class: "INSERT", statements: 1, note: "A second link for a root that already has an open one is a unique violation on that root's partial index (0306), answered by reading again and finding the winner — the one way two PUTs racing on the same root converge on one link without a transaction." },
  { at: "share-links/share-links.service.ts#recordView", class: "ONE_ROW_BY_KEY", statements: 1, note: "`view_count + 1` in the statement itself, so concurrent visitors each count; `updated_at` is deliberately not touched — it records the owner's changes, not visits." },
  { at: "task-lists/task-lists.service.ts#console", class: "ONE_ROW_CAS", statements: 1 },
  { at: "task-lists/task-lists.service.ts#create", class: "INSERT", statements: 1 },
  { at: "tasks/tasks.service.ts#addComment", class: "INSERT", statements: 1 },
  { at: "tasks/tasks.service.ts#bindMentionTarget", class: "RAW_FENCE", statements: 1 },
  { at: "tasks/tasks.service.ts#clearFailedForRetry", class: "ONE_ROW_CAS", statements: 1, note: "The documented residual (docs/postgres-lock-order.md §6): it writes `status`, so an AFTER trigger takes the project FOR NO KEY UPDATE while the task row is held — the project/task inversion. Left as one statement deliberately: the inversion is not resolvable from this side, and wrapping four of the fifteen single-statement status writers in transactions would buy the appearance of coverage rather than the property." },
  { at: "tasks/tasks.service.ts#consumeRunAt", class: "ONE_ROW_CAS", statements: 1, note: "`run_at` is in no trigger's column list, so this takes exactly one row lock and waits for nothing." },
  { at: "tasks/task-route-decision.ts#recordTaskRouteDecision", class: "INSERT", statements: 1, note: "A fresh run's Route Decision (docs/model-routing-design.md §8.1), written by both run doors after the request's plan is bound and before its effect. `createMany({ skipDuplicates })` is `INSERT … ON CONFLICT DO NOTHING` on `UNIQUE (task_id, request_token)`, so a takeover replaying the same bound plan adds nothing; its foreign keys take the owner and task rows FOR KEY SHARE and nothing else, and no trigger fires on the table. Deliberately no transaction: the decision is a record about the run, and one that does not land costs only that record — the caller logs it and dispatches regardless." },
  { at: "tasks/task-dispatch-refusal.ts#clearDispatchRefusal", class: "RAW_FENCE", statements: 1, note: "Clears the refusal a task's previous start met, once another run is away on it (called by `TasksService.applyWorkspaceRun` after the run's own write committed). One UPDATE by primary key, fenced on `dispatch_refusal` naming a different session: `dispatch_refusal` and `updated_at` are in no trigger's column list, so it takes the one row lock and waits for nothing, and the fence is what makes it safe against the run it follows — a refusal recorded for that very run is left standing — and makes a re-issue match nothing." },
  { at: "tasks/tasks.service.ts#copyTaskAttachments", class: "INSERT", statements: 1, note: "One INSERT per input file the task carries, in a loop — N files, N statements, not atomic with each other. The same trade `auto-retry.service.ts#copyAttachments` makes and for the same reason: a copy stranded by the next one's failure is scope-less bytes that `discardTaskAttachmentCopies` deletes on every non-landing exit, so there is nothing for atomicity to protect. Reads the task-scoped templates and writes copies; it never touches the templates, so a concurrent dispatch of the same task takes no lock this one wants." },
  { at: "tasks/tasks.service.ts#discardTaskAttachmentCopies", class: "MANY_ROWS", statements: 1, note: "Deletes only ids this dispatch just created and never linked to a turn (`turn_id IS NULL`), so the selection cannot overlap another writer's rows — the shape MANY_ROWS is otherwise exposed to. Mirrors `auto-retry.service.ts#discardCopies`." },
  { at: "tasks/tasks.service.ts#deliverMentions", class: "RAW_FENCE", statements: 3 },
  { at: "tasks/tasks.service.ts#deliverOneMention", class: "RAW_FENCE", statements: 1 },
  { at: "tasks/tasks.service.ts#dispatchStalledListForemen", class: "INSERT", statements: 1 },
  { at: "tasks/tasks.service.ts#parkMentionDelivery", class: "RAW_FENCE", statements: 1 },
  { at: "tasks/tasks.service.ts#bindRunRequest", class: "ONE_ROW_CAS", statements: 1, note: "Writes the frozen plan onto the run receipt (0137), fenced on `lease_holder` + `attempt` and on `status = 'OPEN'`. A holder that lost its lease matches nothing and reads back the plan the takeover bound instead of its own." },
  { at: "tasks/tasks.service.ts#completeRunReceipt", class: "ONE_ROW_CAS", statements: 1, note: "Freezes the request's answer, fenced the same way. The value returned is read back from the row, never the local one, so a stale holder cannot answer with a result the database does not have." },
  { at: "tasks/tasks.service.ts#leaseRunRequest", class: "RAW_FENCE", statements: 2, note: "One `INSERT … ON CONFLICT DO NOTHING` to open the receipt, then one `UPDATE … RETURNING` that takes the right to evaluate it — expiry and predicate both on `statement_timestamp()`, so two apiservers with different wall clocks cannot take each other's requests over." },
  { at: "tasks/tasks.service.ts#rearmAutoRunMoment", class: "ONE_ROW_CAS", statements: 1, note: "The retry policy moving one Task's dispatch moment on after its run ended: `task_dispatch_epoch` (rank 70), the row 0137's triggers advance. Fenced on the epoch the sweep read, so two passes re-arming the same ended run advance it once and the loser matches nothing; no trigger fires on the table, and the occupancy re-check only reads." },
  { at: "tasks/tasks.service.ts#recordListEvent", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "tasks/tasks.service.ts#releaseRunRequest", class: "ONE_ROW_CAS", statements: 1, note: "Hands the right to evaluate back when a request was refused rather than answered, fenced on the same holder + attempt." },
  { at: "tasks/tasks.service.ts#renewRunRequest", class: "ONE_ROW_CAS", statements: 1, note: "Re-proves the lease before each item of a bulk Run. `false` means a takeover has happened and this delivery must stop, which is the one way two evaluators could both write." },
  { at: "tasks/tasks.service.ts#removeComment", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/admin.controller.ts#deleteUser", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/admin.controller.ts#setRole", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/users.controller.ts#removeAvatar", class: "ONE_ROW_BY_KEY", statements: 1, note: "Removing one's profile photo (migration 0335): one DELETE by user_avatar's primary key, the caller's own user id — at most one row, and none when there was no photo, which is the same answer." },
  { at: "users/users.controller.ts#setAvatar", class: "ONE_ROW_BY_KEY", statements: 1, note: "Setting one's profile photo (migration 0335): one upsert keyed by user_avatar's primary key, the caller's own user id, so a second photo takes the row over rather than writing another. Its foreign key to user(id) takes FOR KEY SHARE on the caller's user row, which only an admin deleting that account would conflict with; nothing else is locked." },
  { at: "users/users.controller.ts#updatePreferences", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/users.controller.ts#updateProfile", class: "ONE_ROW_BY_KEY", statements: 1 },
  { at: "users/users.util.ts#createOrResetUser", class: "INSERT", statements: 2, note: "Two spellings, one write per call — update when the user exists, insert when not." },
  { at: "watches/watch-delivery.service.ts#claimDue", class: "MANY_ROWS", statements: 1, note: "The delivery lease: a batch of due PENDING deliveries moved to IN_FLIGHT, each under its own lease generation. `FOR UPDATE SKIP LOCKED` passes over a row another claim or settlement holds instead of waiting for it, so the statement has no wait edge; a delivery it skips is still due on the next pass." },
  { at: "watches/watch-delivery.service.ts#defer", class: "ONE_ROW_CAS", statements: 1, note: "A wake a continuous watch may not give yet, put back to PENDING until its window ends, only while the claim's lease generation is still the row's. No attempt is counted; a lost CAS means a takeover holds the row and settles it." },
  { at: "watches/watch-delivery.service.ts#fail", class: "ONE_ROW_CAS", statements: 1, note: "A failed attempt, recorded only while the claim's lease generation is still the row's: back to PENDING on the backoff, or a dead letter at the attempt cap or on a refusal. A lost CAS means a takeover holds the row and settles it. Its caller announces `watch.changed` for the attempt that made the row a dead letter, and for none that still has a retry to come." },
  { at: "watches/watch-delivery.service.ts#reclaimExpired", class: "MANY_ROWS", statements: 1, note: "The lease-expiry sweep: in-flight deliveries whose lease ran out go back to PENDING with the lost attempt counted, or become dead letters. `FOR UPDATE SKIP LOCKED`, so a row whose worker is still settling it is left to that worker's CAS." },
  { at: "watches/watch-evaluator.service.ts#claimDueWithDelay", class: "MANY_ROWS", statements: 1, note: "The evaluation lease: a batch of due watches, each moved forward by the lease. `FOR UPDATE SKIP LOCKED` passes over any row a claim, hint or landing holds instead of waiting for it, so the statement has no wait edge and cannot be a deadlock victim; a watch it skips is still due on the next pass." },
  { at: "watches/watch-evaluator.service.ts#markDue", class: "MANY_ROWS", statements: 1, note: "A hint: the live watches targeting a few rows are made due now. `FOR UPDATE SKIP LOCKED` passes over a row a landing, claim, transition or other hint holds instead of waiting for it, so the statement has no wait edge, cannot be a deadlock victim, and holds its pooled connection no longer than itself. A watch it passed over is asked about again by the same statement after a pause, until it is found free or a reconciliation period has passed, and is then made due only if a landing that began before the first ask has moved its `last_evaluated_at` since. A conflict it loses is a lost hint, which the reconciliation sweep already absorbs." },
  { at: "watches/watches.service.ts#awaitOwnerTurn", class: "NOT_A_ROW_WRITE", statements: 1, note: "A create's ask whether its account's turn is free, made between two attempts and outside any transaction: `pg_try_advisory_xact_lock` on the owner, which never waits and is let go as its own statement ends. It locks no row and waits on nothing, so nothing waits on it for longer than the statement." },
  { at: "watches/watches.service.ts#retryDelivery", class: "ONE_ROW_CAS", statements: 1, note: "An owner's redrive of one dead letter: back to PENDING, due at once, its attempts from zero, only while the row is still the DEAD_LETTER with the last_error the decision read. A lost CAS answers 409." },
  { at: "watches/watches.service.ts#transition", class: "ONE_ROW_CAS", statements: 1, note: "One compare-and-set per attempt, on the state and expiry the decision was read from. A lost CAS re-reads and decides again, at most three times, then answers 409. The `watch.changed` announcement follows the CAS that wrote, and a decision that changed nothing publishes none." },
  { at: "workspaces/workspaces.service.ts#create", class: "INSERT", statements: 1 },
  { at: "workspaces/workspaces.service.ts#removePermissionRule", class: "ONE_ROW_CAS", statements: 1 },
  { at: "workspaces/workspaces.service.ts#requestRepoCleanup", class: "ONE_ROW_CAS", statements: 1 },
  { at: "workspaces/workspaces.service.ts#update", class: "ONE_ROW_BY_KEY", statements: 1 },
  // The wiki's two owner-settings writes (0307). Both are deliberately outside a transaction: each
  // touches one row of one of the owner's own spaces, neither is part of anybody else's fact, and a
  // settings write that does not arrive changes nothing a reader decides from — the space's entries
  // and its review queue are untouched by either.
  { at: "wiki/wiki.service.ts#updateSpace", class: "ONE_ROW_BY_KEY", statements: 1, note: "The space's settings (push, autoAcceptReinforce, automaticSpotChecks, and the review mode with when and by whom it last changed) and its title. One UPDATE predicated on the space and its owner, which is what makes another account's id write nothing; the keys it writes are merged into the stored settings in SQL (`settings || $patch`) and never include `maintenance`, so a concurrent write of the maintenance key — `wiki.setWikiMaintenance`, the unit this method calls first when a request names maintenance — survives it." },
  { at: "wiki/wiki.service.ts#bindWorkspace", class: "ONE_ROW_CAS", statements: 1, note: "The manual half of the binding (§2.1): one upsert keyed by the workspace, whose unique index is what makes a workspace belong to at most one space. The workspace and the space are read first, each owner-scoped, so another account's workspace or space is a 404 rather than a row written; the upsert's `update` half is what re-binds a workspace the owner moved to another space." },
  { at: 'wiki/wiki-maintenance.ts#cursorRow', class: 'ONE_ROW_BY_KEY', statements: 1, note: 'The space\'s cursor row, made the first time anything reads it: one upsert keyed by (space_id, source), whose unique index makes it one row per space; the empty update writes nothing to a row that exists.' },
  { at: 'wiki/wiki-maintenance.ts#stateOf', class: 'ONE_ROW_BY_KEY', statements: 1, note: 'The backlog as just counted from the facts, written back onto the cursor row by id so that a reader that does not count (the Wiki home page\'s status line) reads it. A later count overwrites it; nothing decides anything from this copy.' },
  { at: 'wiki/wiki-maintenance.ts#advanceCursor', class: 'ONE_ROW_CAS', statements: 2, note: 'At most two statements on the space\'s cursor row. A run that did not succeed: one UPDATE … RETURNING by id that counts the failure and reads the count back — the report that reads exactly `maintenance.health.notify.afterFailures` sends the owner\'s one push for the streak, after the statement and outside any transaction (`WikiMaintenance.announceFailing`), so it is never sent twice for one count. One that succeeded: the move itself is one UPDATE whose WHERE is the compare-and-set — the watermark still behind the token and the furthest issued position not behind it — so of two runs the later position wins; a token at the watermark, or a move another run made first, is one UPDATE by id that records the success. Refusals write nothing.' },
  { at: 'wiki/wiki-maintenance.ts#advanceRecorded', class: 'ONE_ROW_CAS', statements: 1, note: 'A maintenance run recorded its ops and moves the cursor past their sessions (contract `maintenance.job.run.steps`, advance; criterion 3 revision 4): one UPDATE of the space\'s cursor row whose WHERE is the compare-and-set `advanceCursor` moves by — the watermark still behind the token and the furthest issued position not behind it — writing the position alone, never the run\'s health. A token at or behind the watermark, or one another writer passed first, writes nothing; refusals write nothing.' },
  { at: 'wiki/wiki-maintenance-run.ts#cursorOf', class: 'ONE_ROW_BY_KEY', statements: 1, note: 'The space\'s cursor row, made the first time a fact asks about the space: one upsert keyed by (space_id, source) whose empty update writes nothing to a row that exists — the same statement `wiki-maintenance.ts#cursorRow` makes. Two first facts racing: the loser\'s unique violation reads the winner\'s row.' },
  { at: 'wiki/wiki-maintenance-run.ts#hold', class: 'ONE_ROW_BY_KEY', statements: 1, note: 'Why a due space made no task (contract `maintenance.job.held`), written onto its cursor row by id, and only when the reason is not already the one it holds. The next task made clears it.' },
  { at: 'wiki/wiki-maintenance-run.ts#runOfSession', class: 'ONE_ROW_BY_KEY', statements: 1, note: 'A maintenance session\'s run row: one upsert keyed by its task id (unique), whose empty update writes nothing to the row the trigger made; a task somebody else put in the list gets its row the first time its run asks.' },
  { at: 'wiki/wiki-maintenance-run.ts#wikiMaintenanceRunContext', class: 'ONE_ROW_BY_KEY', statements: 1, note: 'The run started: the calling session, the first start kept and the latest written, one more attempt counted, and what the attempt before it said of its end cleared (contract `maintenance.job.recovery.attempts`) — written onto the run row by id. A retried session or a platform rerun is one more start.' },
  { at: 'wiki/wiki-maintenance-run.ts#noteWikiMaintenanceRunEnd', class: 'ONE_ROW_BY_KEY', statements: 1, note: 'How the run ended — outcome, whose a failure was, error, report and the ops the server refused — written onto the run row by id after the cursor was advanced or refused. A later end of the same run overwrites it; `orbit wiki check` reads what is there.' },
  { at: 'wiki/wiki-maintenance-run.ts#closeOrphanRuns', class: 'MANY_ROWS', statements: 1, note: 'The space\'s run rows with no outcome whose tasks have ended, given outcome failed, failure kind infra and `WIKI_RUN_NOT_REPORTED` (contract `maintenance.job.recovery.orphan`): one UPDATE … FROM task over one space\'s rows, matching none at almost every hint. The trigger is its only caller, off the request path, and the next hint asks again.' },
  { at: 'wiki/wiki-articles.ts#plan', class: 'INSERT', statements: 1, note: 'A space with no topic is given the default ones (contracts/wiki.contract.json `articles.seeding`): one INSERT of the batch, ON CONFLICT DO NOTHING on (space_id, slug), so two first plans leave one set. Only when a count found none; a space that has topics is never written. Outside a transaction on purpose: the rows are names and path prefixes, nothing reads them as a fact about anything else, and a plan that loses the race simply reads the winner\'s.' },
  { at: 'wiki/wiki-plan-job.ts#requestWikiPlanJob', class: 'INSERT', statements: 1, note: 'A plan job a fact asked for (contracts/wiki.contract.json `plan.jobs`): one INSERT, queued, when the space has no draft or revision that has not ended. Outside a transaction on purpose: the partial unique index on the space\'s open drafts is the fence, and the loser of two requests at once reads the winner\'s job and answers with it.' },
  { at: 'wiki/wiki-plan-job.ts#requestWikiPlanBuild', class: 'INSERT', statements: 3, note: 'The build of a confirmed version\'s documents (contracts/wiki.contract.json `plan.jobs`, kind build, migration 0340): one INSERT, queued, when the space has no build that waits — or, when it has one, one UPDATE of that row by id, only while it still waits, pointing it at the newer version (a second statement of the same UPDATE when two confirmations raced and the loser reads the winner\'s row). Outside a transaction on purpose: the partial unique index on the space\'s waiting builds is the fence, and the loser of two requests at once reads the winner\'s job and answers with it.' },
  { at: 'wiki/wiki-plan-job.ts#holdJob', class: 'ONE_ROW_CAS', statements: 1, note: 'Why a job was not made (contract `plan.jobs.held`), written onto its row by id and only while it is still queued or held, and only when the reason is not the one it already holds, so the time it first held for that reason is kept. The task made clears it.' },
  { at: 'wiki/wiki-plan-job.ts#queueJob', class: 'ONE_ROW_CAS', statements: 1, note: 'A job that waits behind an unended task of its list: its row by id, only while it is still queued or held, its held reason cleared.' },
  { at: 'wiki/wiki-plan-job.ts#endJobWhoseTaskIsOver', class: 'ONE_ROW_CAS', statements: 1, note: 'A made job whose task ended or is gone before its run said how it went: its row by id, only while it is still made, ended failed with why. A job its run ended already is not matched and keeps what the run said.' },
  { at: 'wiki/wiki-plan-job.ts#startWikiPlanJob', class: 'ONE_ROW_CAS', statements: 1, note: 'A job\'s run started (contract `plan.jobs.context`): the calling session, and the first time it said so (coalesce), on its row by id while it is made. A retried session of the same task overwrites the session and keeps the time.' },
  { at: 'wiki/wiki-plan-job.ts#progressWikiPlanJob', class: 'ONE_ROW_CAS', statements: 1, note: 'The gate round a job\'s run is on (contract `plan.jobs.progress`), on its row by id while it is made; a later round overwrites it. A job ended meanwhile is not matched, and the door answers WIKI_PLAN_NO_JOB.' },
  { at: 'wiki/wiki-plan-job.ts#progressWikiPlanBuild', class: 'ONE_ROW_CAS', statements: 1, note: 'How far a build\'s run has got (contract `plan.jobs.progress`): the documents it went through and the one it writes now, on its row by id while it is made and a build; a later report overwrites it. A job ended meanwhile is not matched, and the door answers WIKI_PLAN_NO_JOB.' },
  { at: 'wiki/wiki-plan-job.ts#finishWikiPlanJob', class: 'ONE_ROW_CAS', statements: 1, note: 'How a job\'s run ended (contract `plan.jobs.finish`): its row by id while it is made, ended with the outcome, the version or the gate\'s errors, the report and the last draft. A job ended already is not matched, so a second end keeps the first.' },
  { at: 'wiki/wiki-plan.ts#propose', class: 'INSERT', statements: 1, note: 'A maintenance run\'s proposed change to the plan (contracts/wiki.contract.json `plan.proposals`): one INSERT, pending, after the gate passed it against the confirmed version. Outside a transaction on purpose: it changes no version, and the owner\'s acceptance gates it again against the plan as it stands then.' },
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
  {"table":"codex_rate_limit_reset_operation","trigger":"codex_rate_limit_reset_operation_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0255_codex_rate_limit_reset_operation","takes":[]},
  {"table":"executable_dead_man_event","trigger":"executable_dead_man_event_append_only","event":"BEFORE UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0200_executable_acceptance_runtime_contract","takes":[]},
  {"table":"executable_dead_man_event","trigger":"executable_dead_man_expectation_guard","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0202_completion_ack_persistent_coordinator","takes":["executable_runtime_expectation LOCK"]},
  {"table":"executable_runtime_expectation","trigger":"executable_runtime_expectation_append_only","event":"BEFORE UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0202_completion_ack_persistent_coordinator","takes":[]},
  {"table":"executable_runtime_expectation","trigger":"executable_runtime_expectation_insert_guard","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0202_completion_ack_persistent_coordinator","takes":[]},
  {"table":"executable_runtime_expectation_event","trigger":"executable_runtime_expectation_event_append_only","event":"BEFORE UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0202_completion_ack_persistent_coordinator","takes":[]},
  {"table":"executable_runtime_expectation_event","trigger":"executable_runtime_expectation_event_insert_guard","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0202_completion_ack_persistent_coordinator","takes":["executable_runtime_expectation LOCK"]},
  {"table":"executable_runtime_heartbeat","trigger":"executable_runtime_heartbeat_append_only","event":"BEFORE UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0200_executable_acceptance_runtime_contract","takes":[]},
  {"table":"executable_runtime_heartbeat","trigger":"executable_runtime_heartbeat_expectation_guard","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0202_completion_ack_persistent_coordinator","takes":[]},
  {"table":"model_provider","trigger":"model_provider_builtin_antigravity_guard_delete","event":"BEFORE DELETE","kind":"ROW/STATEMENT","since":"0367_antigravity_runtime","takes":[]},
  {"table":"model_provider","trigger":"model_provider_builtin_antigravity_guard_rename","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0367_antigravity_runtime","takes":[]},
  {"table":"model_provider","trigger":"model_provider_builtin_opencode_guard_delete","event":"BEFORE DELETE","kind":"ROW/STATEMENT","since":"0080_opencode_runtime","takes":[]},
  {"table":"model_provider","trigger":"model_provider_builtin_opencode_guard_rename","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0080_opencode_runtime","takes":[]},
  {"table":"model_provider","trigger":"model_provider_dispatch_slug_guard","event":"BEFORE INSERT OR UPDATE OF \"slug\"","kind":"ROW/STATEMENT","since":"0265_provider_pool","takes":[]},
  {"table":"project","trigger":"project_coordinator_companions_bind","event":"AFTER UPDATE OF \"coordinator_workspace_id\"","kind":"CONSTRAINT","since":"0113_project_coordinator_final_row","takes":["project_member WRITE","project_runtime WRITE","workspace LOCK"]},
  {"table":"project","trigger":"project_coordinator_companions_insert","event":"AFTER INSERT","kind":"CONSTRAINT","since":"0113_project_coordinator_final_row","takes":["project_member WRITE","project_runtime WRITE","workspace LOCK"]},
  {"table":"project","trigger":"project_coordinator_identity_window_repair","event":"BEFORE UPDATE OF \"coordinator_workspace_id\"","kind":"ROW/STATEMENT","since":"0115_project_coordinator_identity_window_repair","takes":[]},
  {"table":"project","trigger":"project_coordinator_pointer_guard","event":"BEFORE INSERT OR UPDATE OF \"coordinator_session_id\", \"coordinator_workspace_id\"","kind":"ROW/STATEMENT","since":"0126_project_coordinator_session_lifecycle","takes":[]},
  {"table":"project","trigger":"project_coordinator_rotation_count","event":"AFTER UPDATE OF \"coordinator_session_id\"","kind":"CONSTRAINT","since":"0113_project_coordinator_final_row","takes":["project_member WRITE","project_runtime WRITE","workspace LOCK"]},
  {"table":"project","trigger":"zz_project_completion_contract_project","event":"AFTER INSERT OR UPDATE OF \"goal\", \"instructions\", \"coordinator_enabled\", \"max_concurrent_tasks\", \"session_budget_per_day\", \"config_revision\", \"convergence_thresholds\", \"attempt_budget\", \"unbounded_authorized_by\"","kind":"ROW/STATEMENT","since":"0292_drop_project_automation_policy","takes":["project_completion_contract LOCK","project_completion_contract WRITE"]},
  {"table":"project_acceptance_criterion_definition","trigger":"project_acceptance_definition_normalize","event":"BEFORE INSERT OR UPDATE OF \"text\", \"verification_method\", \"completion_criterion_override_reason\", \"revision\", \"content_hash\", \"semantic_revision\", \"semantic_hash\"","kind":"ROW/STATEMENT","since":"0234_project_acceptance_evaluation_plan_lane_removal","takes":[]},
  {"table":"project_acceptance_criterion_definition","trigger":"zz_project_completion_contract_definition","event":"AFTER INSERT OR UPDATE OR DELETE","kind":"CONSTRAINT","since":"0195_project_owner_ratification","takes":["project LOCK","project_completion_contract LOCK","project_completion_contract WRITE"]},
  {"table":"project_blocker","trigger":"project_blocker_escalation_once","event":"BEFORE UPDATE OF \"escalated_at\"","kind":"ROW/STATEMENT","since":"0125_project_blocker","takes":[]},
  {"table":"project_blocker","trigger":"project_blocker_resolution_final","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0125_project_blocker","takes":[]},
  {"table":"project_codebase","trigger":"project_codebase_config_guard","event":"BEFORE INSERT OR UPDATE","kind":"ROW/STATEMENT","since":"0231_project_codebase_session_source","takes":[]},
  {"table":"project_codebase","trigger":"project_codebase_integration_lock","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0270_project_integration_line","takes":[]},
  {"table":"project_fuse_episode","trigger":"project_fuse_episode_resumed_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0284_project_fuse_pause","takes":[]},
  {"table":"project_handoff_approval","trigger":"project_handoff_approval_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0155_project_handoff_approval","takes":[]},
  {"table":"project_integration_job","trigger":"project_integration_job_terminal_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0281_project_integration_job","takes":[]},
  {"table":"project_member","trigger":"project_member_ratification_project_lock","event":"BEFORE INSERT OR UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0195_project_owner_ratification","takes":["project LOCK"]},
  {"table":"project_member","trigger":"zz_project_completion_contract_member","event":"AFTER INSERT OR UPDATE OR DELETE","kind":"CONSTRAINT","since":"0195_project_owner_ratification","takes":["project LOCK","project_completion_contract LOCK","project_completion_contract WRITE"]},
  {"table":"project_open_item","trigger":"project_open_item_terminal_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0278_project_open_item","takes":[]},
  {"table":"project_promotion","trigger":"project_promotion_terminal_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0286_project_promotion","takes":[]},
  {"table":"project_ratified_action_commit","trigger":"project_ratified_action_commit_immutable","event":"BEFORE UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0195_project_owner_ratification","takes":[]},
  {"table":"project_ratified_action_intent","trigger":"project_action_intent_bind_full_revision","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0196_outcome_binding_version_invalidation","takes":[]},
  {"table":"project_ratified_action_intent","trigger":"project_ratified_action_intent_immutable","event":"BEFORE UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0195_project_owner_ratification","takes":[]},
  {"table":"provider_pool","trigger":"provider_pool_dispatch_slug_guard","event":"BEFORE INSERT OR UPDATE OF \"slug\"","kind":"ROW/STATEMENT","since":"0265_provider_pool","takes":[]},
  {"table":"run_event","trigger":"run_event_ingestion_provenance_guard","event":"BEFORE INSERT OR UPDATE OF ingested_at, ingested_by_runner_id, ingested_under_lease_generation","kind":"ROW/STATEMENT","since":"0220_completion_ack_removal","takes":[]},
  {"table":"session","trigger":"session_admission_lock_order_insert_delete","event":"BEFORE INSERT OR DELETE","kind":"ROW/STATEMENT","since":"0130_task_supersession_dispatch_guard","takes":["project LOCK","scope_before LOCK","task LOCK"]},
  {"table":"session","trigger":"session_admission_lock_order_update","event":"BEFORE UPDATE OF \"status\", \"task_id\", \"deleted_at\", \"starts_task_work\"","kind":"ROW/STATEMENT","since":"0134_task_aggregate_parent_dispatch_guard","takes":["project LOCK","scope_before LOCK","task LOCK"]},
  {"table":"session","trigger":"session_antigravity_runner_claim_guard","event":"BEFORE UPDATE OF \"status\"","kind":"ROW/STATEMENT","since":"0367_antigravity_runtime","takes":[]},
  {"table":"session","trigger":"session_completed_at_compat","event":"BEFORE INSERT OR UPDATE OF \"completed_at\", \"archived_at\"","kind":"ROW/STATEMENT","since":"0076_session_completed_semantics","takes":[]},
  {"table":"session","trigger":"session_dispatch_dependency_check","event":"AFTER INSERT","kind":"CONSTRAINT","since":"0200_executable_acceptance_runtime_contract","takes":[]},
  {"table":"session","trigger":"session_merge_projection_checkpoint_authority_trg","event":"BEFORE UPDATE OF \"merge_status\", \"merged_source_sha\", \"branch_merged\"","kind":"ROW/STATEMENT","since":"0152_task_checkpoint","takes":[]},
  {"table":"session","trigger":"session_opencode_runner_claim_guard","event":"BEFORE UPDATE OF \"status\"","kind":"ROW/STATEMENT","since":"0080_opencode_runtime","takes":[]},
  {"table":"session","trigger":"session_project_capacity_serialize_insert_delete","event":"BEFORE INSERT OR DELETE","kind":"ROW/STATEMENT","since":"0122_project_dispatch_boundary","takes":["project WRITE"]},
  {"table":"session","trigger":"session_project_capacity_serialize_update","event":"BEFORE UPDATE OF \"status\", \"task_id\", \"deleted_at\"","kind":"ROW/STATEMENT","since":"0122_project_dispatch_boundary","takes":["project WRITE"]},
  {"table":"session","trigger":"session_request_asker_stopped","event":"AFTER UPDATE OF \"status\", \"end_reason\", \"retry_at\", \"retry_attempts\", \"retry_claimed_at\", \"completed_at\", \"archived_at\", \"deleted_at\"","kind":"ROW/STATEMENT","since":"0366_session_retry_claim_lease","takes":["session_request WRITE"]},
  {"table":"session","trigger":"session_request_recipient_ended","event":"AFTER UPDATE OF \"status\", \"end_reason\", \"retry_at\", \"retry_attempts\", \"completed_at\", \"archived_at\", \"deleted_at\"","kind":"ROW/STATEMENT","since":"0350_session_request","takes":["session_request WRITE"]},
  {"table":"session","trigger":"session_source_freeze_guard","event":"BEFORE UPDATE OF \"source_state\", \"source_kind\", \"source_codebase_id\", \"source_repo_url\", \"source_root_commit_sha\", \"source_ref\", \"source_revision_sha\", \"source_config_revision\", \"source_ref_authority\", \"source_required_contains\", \"source_base_sha\", \"source_resolved_at\", \"source_resolved_by_runner_id\"","kind":"ROW/STATEMENT","since":"0231_project_codebase_session_source","takes":[]},
  {"table":"session","trigger":"session_superseded_task_guard","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0130_task_supersession_dispatch_guard","takes":["task LOCK"]},
  {"table":"session","trigger":"session_superseded_task_revive_guard","event":"BEFORE UPDATE OF \"status\", \"task_id\", \"dispatch_origin\", \"deleted_at\", \"starts_task_work\"","kind":"ROW/STATEMENT","since":"0130_task_supersession_dispatch_guard","takes":["task LOCK"]},
  {"table":"session","trigger":"task_owner_confirmation_review_reviewer_ended","event":"AFTER UPDATE OF \"status\", \"end_reason\", \"retry_at\", \"retry_attempts\", \"completed_at\", \"archived_at\", \"deleted_at\"","kind":"ROW/STATEMENT","since":"0370_owner_confirmation_review","takes":["task_owner_confirmation_review WRITE"]},
  {"table":"session_merge_receipt","trigger":"session_merge_receipt_checkpoint_accepted_trg","event":"BEFORE INSERT OR UPDATE","kind":"ROW/STATEMENT","since":"0152_task_checkpoint","takes":[]},
  {"table":"session_merge_receipt","trigger":"session_merge_receipt_immutable_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0128_task_supersession_merge_receipt","takes":[]},
  {"table":"session_request","trigger":"session_request_outcome_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0350_session_request","takes":[]},
  {"table":"task","trigger":"project_task_status_count_delete","event":"AFTER DELETE","kind":"ROW/STATEMENT","since":"0282_project_task_status_count","takes":["project_task_status_count WRITE"]},
  {"table":"task","trigger":"project_task_status_count_insert","event":"AFTER INSERT","kind":"ROW/STATEMENT","since":"0282_project_task_status_count","takes":["project_task_status_count WRITE"]},
  {"table":"task","trigger":"project_task_status_count_move","event":"AFTER UPDATE","kind":"ROW/STATEMENT","since":"0282_project_task_status_count","takes":["project_task_status_count WRITE"]},
  {"table":"task","trigger":"task_aggregate_parent_child_delete_touch","event":"BEFORE DELETE","kind":"ROW/STATEMENT","since":"0134_task_aggregate_parent_dispatch_guard","takes":["project LOCK"]},
  {"table":"task","trigger":"task_aggregate_parent_shape_guard","event":"BEFORE INSERT OR UPDATE OF \"parent_task_id\", \"completion_policy\", \"is_foreman\", \"owner_id\"","kind":"ROW/STATEMENT","since":"0134_task_aggregate_parent_dispatch_guard","takes":["project LOCK"]},
  {"table":"task","trigger":"task_claimed_project_move_guard","event":"BEFORE UPDATE OF \"project_id\"","kind":"ROW/STATEMENT","since":"0122_project_dispatch_boundary","takes":[]},
  {"table":"task","trigger":"task_convergence_counters_monotonic","event":"BEFORE UPDATE OF \"convergence_counters\", \"scope_revision\", \"attempt_generation\"","kind":"ROW/STATEMENT","since":"0138_task_convergence_ledger","takes":[]},
  {"table":"task","trigger":"task_dependency_revision_seed","event":"AFTER INSERT","kind":"ROW/STATEMENT","since":"0132_task_dependency_revision","takes":["task_dependency_revision WRITE"]},
  {"table":"task","trigger":"task_dispatch_epoch_seed","event":"AFTER INSERT","kind":"ROW/STATEMENT","since":"0137_task_run_request_receipt","takes":["task_dispatch_epoch WRITE"]},
  {"table":"task","trigger":"task_dispatch_epoch_update","event":"AFTER UPDATE","kind":"ROW/STATEMENT","since":"0137_task_run_request_receipt","takes":["task_dispatch_epoch LOCK"]},
  {"table":"task","trigger":"task_done_canonical_writer_fence","event":"BEFORE UPDATE OF \"status\", \"completion_fence_revision\"","kind":"ROW/STATEMENT","since":"0193_task_done_writer_fence","takes":[]},
  {"table":"task","trigger":"task_list_task_count_delete","event":"AFTER DELETE","kind":"ROW/STATEMENT","since":"0280_task_list_task_count","takes":["task_list WRITE"]},
  {"table":"task","trigger":"task_list_task_count_insert","event":"AFTER INSERT","kind":"ROW/STATEMENT","since":"0280_task_list_task_count","takes":["task_list WRITE"]},
  {"table":"task","trigger":"task_list_task_count_relist","event":"AFTER UPDATE","kind":"ROW/STATEMENT","since":"0280_task_list_task_count","takes":["task_list WRITE"]},
  {"table":"task","trigger":"task_progress_epoch_advance","event":"AFTER UPDATE OF \"status\"","kind":"ROW/STATEMENT","since":"0271_watch_progress_continuous","takes":["task_progress WRITE"]},
  {"table":"task","trigger":"task_provenance_immutable_guard","event":"BEFORE UPDATE OF \"discovered_from_project_id\", \"trigger_event\", \"source_task_id\", \"source_session_id\"","kind":"ROW/STATEMENT","since":"0150_task_provenance_project_acceptance_epoch","takes":[]},
  {"table":"task","trigger":"task_scope_freeze_guard","event":"BEFORE UPDATE OF \"title\", \"description\", \"acceptance_criteria\", \"scope_revision\"","kind":"ROW/STATEMENT","since":"0138_task_convergence_ledger","takes":[]},
  {"table":"task","trigger":"task_supersession_guard_insert","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0128_task_supersession_merge_receipt","takes":[]},
  {"table":"task","trigger":"task_supersession_guard_update","event":"BEFORE UPDATE OF \"superseded_by_task_id\", \"status\", \"owner_id\", \"project_id\"","kind":"ROW/STATEMENT","since":"0128_task_supersession_merge_receipt","takes":[]},
  {"table":"task","trigger":"task_supersession_live_session_guard","event":"BEFORE UPDATE OF \"superseded_by_task_id\", \"terminal_reason\"","kind":"ROW/STATEMENT","since":"0130_task_supersession_dispatch_guard","takes":[]},
  {"table":"task","trigger":"task_supersession_project_lock_order","event":"BEFORE UPDATE OF \"superseded_by_task_id\", \"terminal_reason\", \"project_id\"","kind":"ROW/STATEMENT","since":"0130_task_supersession_dispatch_guard","takes":["project LOCK"]},
  {"table":"task","trigger":"task_supersession_successor_move_guard","event":"BEFORE UPDATE OF \"project_id\", \"owner_id\"","kind":"ROW/STATEMENT","since":"0130_task_supersession_dispatch_guard","takes":[]},
  {"table":"task","trigger":"task_verdict_revision_advance","event":"BEFORE INSERT OR UPDATE OF \"verdict\"","kind":"ROW/STATEMENT","since":"0124_task_verification_verdict","takes":[]},
  {"table":"task","trigger":"task_verdict_revision_monotonic","event":"BEFORE UPDATE OF \"verdict_revision\"","kind":"ROW/STATEMENT","since":"0124_task_verification_verdict","takes":[]},
  {"table":"task","trigger":"task_verdict_revoked_on_reopen","event":"BEFORE UPDATE OF \"status\"","kind":"ROW/STATEMENT","since":"0124_task_verification_verdict","takes":[]},
  {"table":"task","trigger":"task_verification_carrier_status_derive_insert","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0192_verifier_role_completion","takes":[]},
  {"table":"task","trigger":"task_verification_carrier_status_derive_update","event":"BEFORE UPDATE OF \"status\", \"verdict\", \"verifies_task_id\", \"completion_criterion\", \"completion_policy\", \"completion_criterion_override_reason\", \"terminal_reason\", \"superseded_by_task_id\"","kind":"ROW/STATEMENT","since":"0192_verifier_role_completion","takes":[]},
  {"table":"task","trigger":"task_verification_subject_guard","event":"BEFORE INSERT OR UPDATE OF \"verifies_task_id\"","kind":"ROW/STATEMENT","since":"0130_task_supersession_dispatch_guard","takes":[]},
  {"table":"task","trigger":"task_verification_verdict_atomic_insert","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0141_task_verification_finding","takes":[]},
  {"table":"task","trigger":"task_verification_verdict_atomic_update","event":"BEFORE UPDATE OF \"status\", \"verdict\"","kind":"ROW/STATEMENT","since":"0141_task_verification_finding","takes":[]},
  {"table":"task_attempt","trigger":"task_attempt_checkpoint_guard","event":"BEFORE INSERT OR UPDATE","kind":"ROW/STATEMENT","since":"0139_task_session_attempt","takes":[]},
  {"table":"task_attempt","trigger":"task_attempt_fence","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0139_task_session_attempt","takes":[]},
  {"table":"task_attempt","trigger":"task_attempt_result_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0139_task_session_attempt","takes":[]},
  {"table":"task_checkpoint","trigger":"task_checkpoint_immutable_trg","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0152_task_checkpoint","takes":[]},
  {"table":"task_comment","trigger":"task_comment_mention_delivery_file","event":"AFTER INSERT","kind":"ROW/STATEMENT","since":"0131_task_comment_mention_delivery","takes":["task_comment_mention_delivery WRITE"]},
  {"table":"task_convergence_decision","trigger":"task_convergence_decision_fence","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0138_task_convergence_ledger","takes":[]},
  {"table":"task_convergence_decision","trigger":"task_convergence_decision_immutable_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0138_task_convergence_ledger","takes":[]},
  {"table":"task_dependency","trigger":"task_dependency_revision_delete","event":"AFTER DELETE","kind":"ROW/STATEMENT","since":"0132_task_dependency_revision","takes":["task_dependency_revision LOCK"]},
  {"table":"task_dependency","trigger":"task_dependency_revision_insert","event":"AFTER INSERT","kind":"ROW/STATEMENT","since":"0132_task_dependency_revision","takes":["task_dependency_revision LOCK"]},
  {"table":"task_dependency","trigger":"task_dependency_revision_update","event":"AFTER UPDATE","kind":"ROW/STATEMENT","since":"0132_task_dependency_revision","takes":["task_dependency_revision LOCK"]},
  {"table":"task_dependency","trigger":"task_dispatch_epoch_edges_delete","event":"AFTER DELETE","kind":"ROW/STATEMENT","since":"0137_task_run_request_receipt","takes":["task_dispatch_epoch LOCK"]},
  {"table":"task_dependency","trigger":"task_dispatch_epoch_edges_insert","event":"AFTER INSERT","kind":"ROW/STATEMENT","since":"0137_task_run_request_receipt","takes":["task_dispatch_epoch LOCK"]},
  {"table":"task_dependency","trigger":"task_dispatch_epoch_edges_update","event":"AFTER UPDATE","kind":"ROW/STATEMENT","since":"0137_task_run_request_receipt","takes":["task_dispatch_epoch LOCK"]},
  {"table":"task_legacy_evidence_import","trigger":"task_legacy_evidence_import_immutable","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0184_task_signoff_backfill","takes":[]},
  {"table":"task_scope_revision","trigger":"task_scope_revision_authority_guard","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0138_task_convergence_ledger","takes":[]},
  {"table":"task_scope_revision","trigger":"task_scope_revision_immutable_guard","event":"BEFORE UPDATE","kind":"ROW/STATEMENT","since":"0138_task_convergence_ledger","takes":[]},
  {"table":"task_verification_finding","trigger":"task_verification_finding_fence","event":"BEFORE INSERT","kind":"ROW/STATEMENT","since":"0141_task_verification_finding","takes":[]},
  {"table":"task_verification_finding","trigger":"task_verification_finding_immutable_guard","event":"BEFORE UPDATE OR DELETE","kind":"ROW/STATEMENT","since":"0141_task_verification_finding","takes":[]},
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
  {
    path: 'tasks/task-completion-test-helper.ts',
    why: 'A PostgreSQL-spec fixture helper. It deliberately writes the production EVIDENCE_JUDGMENT evidence, request, decision and terminal task facts so integration tests exercise canonical completion instead of bypassing its trigger; no application provider imports it.',
  },
  {
    path: 'projects/project-contract-test-helper.ts',
    why: 'A PostgreSQL-spec fixture helper. It seeds a goal and one acceptance criterion so a fixture has a real completion contract, and is not reachable from an application module or HTTP route.',
  },
];
