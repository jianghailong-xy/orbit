// The wiki's server-side jobs and the model request queue they call through (contracts/wiki.contract.json
// `jobs` and `modelQueue`, docs/wiki-server-execution-design.md §5.1 and §5.2): the wiki-worker claims a
// job, runs it, and every model call it makes goes through the persisted queue so that a deployment's
// model answers at most ORBIT_WIKI_MODEL_CONCURRENCY requests at once. wikiContract.spec.ts holds every
// constant below to the contract JSON.

/**
 * What a job is (contract `jobs.kinds`): the seven pipelines, and `smoke` — a job that makes one model
 * call and writes the answer into its report, which is the queue's own end-to-end probe and runs no
 * pipeline at all. The pipeline kinds arrive with the phases that implement them (P3–P8); until then a
 * worker runs the kinds it knows and leaves the others queued.
 */
export const WIKI_JOB_KINDS = ['verify', 'articles', 'import', 'plan_draft', 'plan_revise', 'docs_build', 'maintain', 'smoke'] as const;
export type WikiJobKind = (typeof WIKI_JOB_KINDS)[number];

/** Where a job is (contract `jobs.states`): `waiting` is on something outside it — a repo operation or the model. */
export const WIKI_JOB_STATES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;
export type WikiJobState = (typeof WIKI_JOB_STATES)[number];

/** What a waiting job waits for (contract `jobs.waitingFor`). */
export const WIKI_JOB_WAITING_FOR = ['repo', 'model'] as const;
export type WikiJobWaitingFor = (typeof WIKI_JOB_WAITING_FOR)[number];

/** Whose a failed job was (contract `jobs.failureKinds`): the platform's (`infra`) or the work's (`content`). */
export const WIKI_JOB_FAILURE_KINDS = ['infra', 'content'] as const;
export type WikiJobFailureKind = (typeof WIKI_JOB_FAILURE_KINDS)[number];

/** The numbers the job worker claims, leases and retries by (contract `jobs.lease`, `.retry`). */
export const WIKI_JOB = {
  /** How long one claim keeps a job from every other worker. Far longer than one step of a job. */
  leaseSeconds: 60,
  /** Renewed this often while the job runs, so a live holder never loses its lease. */
  renewSeconds: 20,
  /** How many jobs one worker runs at once; a space's own limit — one running job — is the claim's. */
  maxConcurrentPerWorker: 4,
  /** The retryable backoff for an infra failure, in seconds, by the attempts already made (0, 10, 30). */
  retryBackoffSeconds: [0, 10, 30],
  /** How often the loop looks for due work when nothing has nudged it. */
  pollSeconds: 5,
} as const;

/** What a model request is doing (contract `modelQueue.states`). */
export const WIKI_MODEL_REQUEST_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type WikiModelRequestState = (typeof WIKI_MODEL_REQUEST_STATES)[number];

/**
 * The retryable-failure backoff in seconds (contract `modelQueue.retry.backoffSeconds`), read by how many
 * attempts the row has already made: the first retry goes out at once, the second after 10 s, the third and
 * every one after it after 30.
 */
export function wikiModelRetryDelaySeconds(attempts: number): number {
  const schedule = WIKI_MODEL_QUEUE.retryBackoffSeconds;
  return schedule[Math.min(Math.max(attempts, 0), schedule.length - 1)];
}

/** The numbers the request queue claims, leases, writes back and retries by (contract `modelQueue`). */
export const WIKI_MODEL_QUEUE = {
  /** How long one claim keeps a request from every other scheduler; renewed while the call runs. */
  leaseSeconds: 60,
  /** Renewed this often while a call runs. */
  renewSeconds: 20,
  /** How often the text received so far is written back while a call runs (only when it grew). */
  partialSeconds: 5,
  /** How many requests one job may have in flight at once, so no one job takes the whole queue. */
  maxInFlightPerJob: 4,
  /** The retryable-failure backoff, in seconds, by attempts already made (see wikiModelRetryDelaySeconds). */
  retryBackoffSeconds: [0, 10, 30],
  /** How often a worker's loop looks for due work, and how often a job polls while it waits on a request. */
  pollSeconds: 2,
  /** How long a request may wait before it fails and its job fails as infra, by step (design §5.3). */
  defaultWaitLimitSeconds: 900,
  waitLimitSeconds: {
    extract: 180,
    docs: 180,
    import: 600,
    plan: 1200,
  },
  /** One call's own budget, by step (design §6): the call is disconnected when it runs out. */
  defaultCallBudgetSeconds: 900,
  callBudgetSeconds: {
    docs: 1200,
    plan: 3600,
  },
} as const;

/** How long a request of `step` may wait, in seconds: the step's own limit, or the default. */
export function wikiModelWaitLimitSeconds(step: string): number {
  // A step's own name or one of its stages: `plan_draft` and `plan_revise` are the plan's, `docs_build` the docs'.
  const limits: Record<string, number> = WIKI_MODEL_QUEUE.waitLimitSeconds;
  for (const [key, seconds] of Object.entries(limits)) {
    if (step === key || step.startsWith(`${key}_`)) return seconds;
  }
  return WIKI_MODEL_QUEUE.defaultWaitLimitSeconds;
}

/** How long a request of `step` may run, in seconds: the step's own budget, or the default (design §6). */
export function wikiModelCallBudgetSeconds(step: string): number {
  const budgets: Record<string, number> = WIKI_MODEL_QUEUE.callBudgetSeconds;
  if (step in budgets) return budgets[step];
  for (const [key, seconds] of Object.entries(budgets)) {
    if (step.startsWith(`${key}_`)) return seconds;
  }
  return WIKI_MODEL_QUEUE.defaultCallBudgetSeconds;
}

/** The retryable backoff for an infra failure, in seconds, by the attempts already made (0, 10, 30). */
export function wikiJobRetryDelaySeconds(attempts: number): number {
  const schedule = WIKI_JOB.retryBackoffSeconds;
  return schedule[Math.min(Math.max(attempts, 0), schedule.length - 1)];
}

/** What the executor switch's environment names are called (contract `jobs.executor.*`). */
export const WIKI_EXECUTOR_ENV = {
  /** runner | canary | server. */
  mode: 'ORBIT_WIKI_EXECUTOR',
  canaryOwners: 'ORBIT_WIKI_EXECUTOR_CANARY_OWNERS',
} as const;

/**
 * How far the server-side execution is switched on (contract `jobs.executor.modes`): `runner` is the
 * default and the path that has always run — nothing the server executes; `canary` gives it only to the
 * accounts the canary list names; `server` gives it to every account.
 */
export const WIKI_EXECUTOR_MODES = ['runner', 'canary', 'server'] as const;
export type WikiExecutorMode = (typeof WIKI_EXECUTOR_MODES)[number];
