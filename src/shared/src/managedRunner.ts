/**
 * The managed runner contract the server and the three clients share
 * (docs/managed-runner-design.md, "Server and three client interfaces").
 *
 * The feature is off unless the server sets ORBIT_MANAGED_RUNNERS_ENABLED=true. A client reads
 * `GET /api/auth/capabilities` first: a missing `managedRunners` member, a 404 from a server that
 * predates it, `enabled: false` or a contract version it does not know all mean no managed UI.
 */

/** The contract version this file describes. A client that knows another shows no managed UI. */
export const MANAGED_RUNNER_CONTRACT_VERSION = 1;

/**
 * The refusal of a managed runner write while the feature is off: 404, as a server without the
 * feature answers, sent only after the caller has authenticated and before anything is written.
 */
export const MANAGED_RUNNER_DISABLED = 'MANAGED_RUNNER_DISABLED';

/** The feature is on but this server cannot reconcile (its environment profile is missing or invalid). */
export const MANAGED_RUNNER_UNAVAILABLE = 'MANAGED_RUNNER_UNAVAILABLE';

/** A write that needs the mapping's current revision named another one. */
export const MANAGED_RUNNER_REVISION_CONFLICT = 'MANAGED_RUNNER_REVISION_CONFLICT';

/** A transition the mapping's state does not allow, or one this server version does not perform. */
export const MANAGED_RUNNER_TRANSITION_REFUSED = 'MANAGED_RUNNER_TRANSITION_REFUSED';

/** A managed runner's row is removed only through the managed deletion workflow, never by unregistering. */
export const MANAGED_RUNNER_DELETE_REFUSED = 'MANAGED_RUNNER_DELETE_REFUSED';

/** The server decided this account is not given a managed runner (who is, is the server's decision). */
export const MANAGED_RUNNER_NOT_ELIGIBLE = 'MANAGED_RUNNER_NOT_ELIGIBLE';

/**
 * An administrator disabled the owner's account: its managed runner is not provisioned, woken or
 * kept running — a running one is put to sleep, its data kept — and every managed runner write is
 * refused 403 with this code until the account is enabled again. The same code every other door
 * refuses a disabled account with.
 */
export const ACCOUNT_DISABLED = 'ACCOUNT_DISABLED';

/**
 * The managed runner is up, but none of its runtimes is installed and signed in, so it is not READY
 * and nothing chooses an engine for its first session. Signing a runtime in on the runner clears it.
 * Also the refusal of a first session asked for on a runtime the managed runner cannot run.
 */
export const MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE';

/**
 * A managed runner's credential is issued for one generation and rotated by the manager when the
 * generation advances; the owner's rotate-token refuses it (409), whether or not the feature is on.
 */
export const MANAGED_RUNNER_ROTATE_REFUSED = 'MANAGED_RUNNER_ROTATE_REFUSED';

/**
 * The managed runner instance protocol (docs/managed-runner-design.md, "Identity and durable
 * mapping"). A managed runner sends, on every request it makes with its runner credential, the
 * generation and the Pod UID of the instance it is, and declares this capability in
 * X-Orbit-Runner-Capabilities. A credential that belongs to a managed runner is accepted only from
 * the instance the manager authorized; a self-managed runner declares nothing and is unaffected.
 */
export const MANAGED_RUNNER_INSTANCE_CAPABILITY = 'managed-runner-instance-v1';
export const MANAGED_RUNNER_GENERATION_HEADER = 'x-orbit-managed-runner-generation';
export const MANAGED_RUNNER_POD_UID_HEADER = 'x-orbit-managed-runner-pod-uid';

/** 403: a managed runner's credential sent without the instance protocol (an older runner, or a copy). */
export const MANAGED_RUNNER_INSTANCE_REQUIRED = 'MANAGED_RUNNER_INSTANCE_REQUIRED';
/** 403: a generation the manager has moved past. The instance must stop; it is never authorized again. */
export const MANAGED_RUNNER_INSTANCE_SUPERSEDED = 'MANAGED_RUNNER_INSTANCE_SUPERSEDED';
/** 403: the current generation, but not the Pod the manager recorded for it (or a generation never issued). */
export const MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED = 'MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED';
/** 403: the mapping is FENCING (or being deleted): no instance of it is authorized until a stop is proven. */
export const MANAGED_RUNNER_INSTANCE_FENCED = 'MANAGED_RUNNER_INSTANCE_FENCED';
/** 503, retryable: the manager has not recorded this generation's Pod yet. */
export const MANAGED_RUNNER_INSTANCE_PENDING = 'MANAGED_RUNNER_INSTANCE_PENDING';

/**
 * Idle sleep (docs/managed-runner-design.md, "Provisioning retry wake and sleep" 7 and 8). A managed
 * runner that declares this capability reports its workload in every heartbeat it sends as the
 * authorized instance, and honours a sleep request: when it has nothing to do it stops claiming,
 * drains and exits on its own, so its Pod ends with the kubelet's report of the stop — the proof the
 * manager needs before it releases compute. A runner that does not declare it is never put to sleep.
 */
export const MANAGED_RUNNER_SLEEP_CAPABILITY = 'managed-runner-sleep-v1';

/** What a managed runner's instance says it is doing, in its heartbeat (`managedWorkload`). */
export interface ManagedRunnerWorkload {
  /** Turns in flight: claimed turns, and turns an engine runs on its own. */
  activeTurns: number;
  /** Background processes of its sessions it is tracking: jobs, services and watches. */
  backgroundJobs: number;
  /** Work its heartbeats handed it that is still running (landings, merges, commits, uploads,
   *  scans, resets), and sign-ins and installs in progress. */
  operations: number;
  /** Events buffered for the control plane and not yet acknowledged by it. */
  unflushedEvents: number;
  /** How long, in whole seconds, all four have been zero; 0 while any is not. */
  idleSeconds: number;
  /** The `requestedAt` of a sleep request this instance, idle, is ready to honour: its acceptance.
   *  Sent only while all four counts are zero; it exits only once the answer is `confirmed`. */
  sleepReady?: string;
}

/** In a heartbeat response to the authorized instance of a draining mapping: stop for sleep. */
export interface ManagedRunnerSleepRequest {
  /** When the manager asked, ISO 8601: the request's identity, echoed back in `sleepReady`. */
  requestedAt: string;
  /** True once the control plane has recorded this instance's acceptance: stop claiming, drain and
   *  exit. Until then the request can still be withdrawn, and the instance keeps running. */
  confirmed?: boolean;
}

/** WAITING_CAPACITY: the environment's fixed budget has no room for this runner now. Retryable by itself. */
export const MANAGED_RUNNER_CAPACITY_UNAVAILABLE = 'MANAGED_RUNNER_CAPACITY_UNAVAILABLE';

/** 409 to an explicit sleep: the runner has work in flight or queued, and sleep never interrupts work. */
export const MANAGED_RUNNER_BUSY = 'MANAGED_RUNNER_BUSY';

/** What the owner asked of the managed runner. */
export type ManagedRunnerDesiredState = 'RUNNING' | 'SLEEPING' | 'DELETED';

/** How far the server's manager has got. Only the manager moves it. */
export type ManagedRunnerManagementState =
  | 'REQUESTED'
  | 'WAITING_CAPACITY'
  | 'PROVISIONING'
  | 'STARTING'
  | 'READY'
  | 'DRAINING'
  | 'SLEEPING'
  | 'FENCING'
  | 'FAILED'
  | 'DELETING'
  | 'DELETED';

/** What a read reports: a management state, or that the owner has no mapping at all. */
export type ManagedRunnerReadState = ManagedRunnerManagementState | 'NOT_PROVISIONED';

/** `GET /api/auth/capabilities` → `managedRunners`. Reading it allocates nothing. */
export interface ManagedRunnerCapability {
  enabled: boolean;
  contractVersion: number;
}

export interface ServerCapabilities {
  managedRunners: ManagedRunnerCapability;
}

/** A safe, structured cause. Never a raw infrastructure error, endpoint or credential. */
export interface ManagedRunnerReason {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ManagedRunnerActions {
  canEnsure: boolean;
  canWake: boolean;
  canSleep: boolean;
  canRetry: boolean;
  canDelete: boolean;
}

/**
 * `GET /api/managed-runner`, and the body of every accepted managed runner write: the
 * authenticated owner's mapping, stored and derived, without allocating anything. Ids use the
 * existing public id codec, timestamps ISO 8601; ids are null before the mapping exists.
 */
export interface ManagedRunnerStatus {
  contractVersion: number;
  /** The server's switch. False: management is frozen and every action is refused. */
  enabled: boolean;
  /** The mapping's compare-and-set revision; 0 when there is none. */
  revision: number;
  managementState: ManagedRunnerReadState;
  desiredState: ManagedRunnerDesiredState | null;
  runnerId: string | null;
  workspaceId: string | null;
  /** The runner row's own heartbeat observation (`ONLINE`, `OFFLINE`, `DRAINING`). */
  heartbeatStatus: string | null;
  lastHeartbeatAt: string | null;
  /** READY with a fresh heartbeat: new session turns can be claimed. */
  usable: boolean;
  reason: ManagedRunnerReason | null;
  retryAfter: string | null;
  /** The runtime the runner was found installed and signed in with when it became READY: what a
   *  default workspace with no history starts its first session on. Null until then. */
  initialProvider: string | null;
  actions: ManagedRunnerActions;
}

/** The body of every managed runner write. */
export interface ManagedRunnerWriteRequest {
  /** Required: a retried request with the same key is answered with the same mapping. */
  idempotencyKey: string;
  /** The revision the caller read; required by retry, sleep and delete. */
  revision?: number;
}
