// The System model the wiki's server-side execution calls (contracts/wiki.contract.json `systemModel`,
// docs/wiki-server-execution-design.md §2.1, §5.3 and §6): the deployment's own endpoint speaking the
// Anthropic Messages API, configured in `.env` and handed to the wiki-worker service alone. The API
// process never holds its address or key; it reads the model's name and state from the one row the
// worker writes. wikiContract.spec.ts holds every constant below to the contract JSON.

import type { WikiExecutorView } from './wikiJobs';

/**
 * The worker's environment (contract `systemModel.env`). The first three together are the System model:
 * with any of them missing it is `unconfigured`. None is an `ANTHROPIC_*` name, which an agent session's
 * own environment would override when Compose is run from inside one (wiki-compose-env.spec.ts).
 */
export const WIKI_SYSTEM_MODEL_ENV = {
  baseUrl: 'ORBIT_WIKI_MODEL_BASE_URL',
  apiKey: 'ORBIT_WIKI_MODEL_API_KEY',
  model: 'ORBIT_WIKI_MODEL',
  concurrency: 'ORBIT_WIKI_MODEL_CONCURRENCY',
} as const;

/** The numbers the worker calls and probes the System model by (contract `systemModel.request`, `.health`, `.status`). */
export const WIKI_SYSTEM_MODEL = {
  /** Model requests in flight at once across every space, when ORBIT_WIKI_MODEL_CONCURRENCY is unset. */
  defaultConcurrency: 4,
  /** Appended to the base URL for every call. */
  messagesPath: '/v1/messages',
  anthropicVersion: '2023-06-01',
  /** A call that receives no byte for this long is disconnected, whatever its own budget. */
  idleTimeoutSeconds: 300,
  /** Appended to the base URL for the probe; an answer of any of `healthUpStatuses` is up. */
  healthPath: '/health',
  healthUpStatuses: [200, 404],
  /** How often the worker probes and writes its state and heartbeat, and how long one probe may take. */
  probeIntervalSeconds: 10,
  probeTimeoutSeconds: 5,
  /** A heartbeat older than this reads as `worker_not_running`. */
  workerStaleSeconds: 60,
} as const;

/**
 * What the worker writes into `wiki_model_status.state` (contract `systemModel.status.states`): `up`, the
 * probe answered; `down`, it did not, or answered something else; `auth_failed`, the endpoint refused the
 * key (401), which holds until the worker restarts; `unconfigured`, the environment does not name a model.
 */
export const WIKI_SYSTEM_MODEL_STATES = ['up', 'down', 'auth_failed', 'unconfigured'] as const;
export type WikiSystemModelState = (typeof WIKI_SYSTEM_MODEL_STATES)[number];

/** What the read answers: the stored state, or `worker_not_running` when no worker has written lately. */
export const WIKI_SYSTEM_MODEL_READ_STATES = [...WIKI_SYSTEM_MODEL_STATES, 'worker_not_running'] as const;
export type WikiSystemModelReadState = (typeof WIKI_SYSTEM_MODEL_READ_STATES)[number];

/**
 * How a failed call is classed (contract `systemModel.request.errors`): `retryable` — 5xx, 429, a
 * connection that failed or went idle, an SSE overloaded/api/rate-limit error; `unauthorized` — 401, the
 * key was refused; `other` — everything else, the call's own budget running out and a cancel among them.
 */
export const WIKI_SYSTEM_MODEL_ERROR_KINDS = ['retryable', 'unauthorized', 'other'] as const;
export type WikiSystemModelErrorKind = (typeof WIKI_SYSTEM_MODEL_ERROR_KINDS)[number];

/**
 * `GET /api/wiki/system-model` (contract `systemModel.read`): what the settings page and the health line
 * show — the model's name and its state, never its address or its key. `since` is when that state began;
 * for `worker_not_running` it is the last heartbeat. All null when no worker has ever written.
 */
export interface WikiSystemModelStatus {
  state: WikiSystemModelReadState;
  model: string | null;
  since: string | null;
  checkedAt: string | null;
  workerSeenAt: string | null;
}

/**
 * The user door's answer (contract `systemModel.read`): the state above, and what the executor switch says for
 * the account that asks — the deployment's mode, and whether the server executes this account's wiki.
 */
export interface WikiSystemModelRead extends WikiSystemModelStatus {
  executor: WikiExecutorView;
}

/** Whether a worker wrote its heartbeat within `workerStaleSeconds` of `now`. */
export function wikiWorkerRunning(workerSeenAt: Date | string | null, now: Date): boolean {
  if (workerSeenAt === null) return false;
  const seen = new Date(workerSeenAt).getTime();
  return Number.isFinite(seen) && now.getTime() - seen <= WIKI_SYSTEM_MODEL.workerStaleSeconds * 1000;
}
