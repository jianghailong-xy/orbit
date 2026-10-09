/**
 * What Web, macOS and iOS show for the signed-in owner's managed runner
 * (docs/managed-runner-design.md, "Server and three client interfaces"): one reading of the server's
 * capability and status answers, so the three clients say the same thing about the same state.
 *
 * `managed-runner-states.fixture.json` holds the server's answers for every state with the display
 * each one gets. The apiserver derives every answer in it from stored inputs, the shared spec holds
 * this function to the displays, the web renders them, and OrbitKit's mirror of this function is
 * held to the same file: a state the server can answer cannot be drawn two ways.
 *
 * Only the capability and the status fields are read — never a runner's name or its heartbeat.
 * With the capability missing, switched off or of a contract this file does not know, or a status
 * that says the switch is off, there is no managed UI at all and every client behaves as before.
 */
import {
  MANAGED_RUNNER_CONTRACT_VERSION,
  MANAGED_RUNNER_UNAVAILABLE,
  MODEL_UNAVAILABLE,
  type ManagedRunnerReadState,
  type ManagedRunnerStatus,
} from './managedRunner';

/**
 * `GET /api/auth/capabilities`, as a client reads it: managed UI only for this contract, switched on.
 * A missing member, `enabled: false`, another contract version, a malformed body and a failed read
 * (`null`/`undefined`, a pre-feature server's 404 included) all mean none.
 */
export function managedRunnersOffered(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const member = (capabilities as { managedRunners?: unknown }).managedRunners;
  if (!member || typeof member !== 'object') return false;
  const { enabled, contractVersion } = member as { enabled?: unknown; contractVersion?: unknown };
  return enabled === true && contractVersion === MANAGED_RUNNER_CONTRACT_VERSION;
}

export type ManagedRunnerDisplayKind =
  /** NOT_PROVISIONED, and the server offers one: Set up. */
  | 'setup'
  /** NOT_PROVISIONED, and the server does not give this account one (the reason says why). */
  | 'notOffered'
  /** REQUESTED, PROVISIONING or STARTING before the runner was ever ready. */
  | 'preparing'
  /** Asleep with work asking for it, or starting up again after it had been ready. */
  | 'waking'
  /** Starting, but no runtime is installed and signed in on it (MODEL_UNAVAILABLE). */
  | 'modelUnavailable'
  | 'waitingCapacity'
  /** READY and usable. */
  | 'available'
  /** READY, but its heartbeat is not fresh: unavailable, not proven dead. */
  | 'unresponsive'
  /** DRAINING. */
  | 'stopping'
  | 'sleeping'
  /** FENCING: no safe retry exists; an operator's proof is awaited. */
  | 'waitingOperator'
  | 'failed'
  /** DELETING. */
  | 'removing'
  /** DELETED. */
  | 'removed';

export interface ManagedRunnerDisplay {
  kind: ManagedRunnerDisplayKind;
  title: string;
  /** The server's reason sentence when it gave one, else the state's own sentence. */
  detail: string;
  /** Offer Retry — POST /managed-runner/retry with the read revision: FAILED, and the server allows it. */
  retry: boolean;
  /** Offer Set up — POST /managed-runner/ensure: no mapping, and the server offers one. */
  ensure: boolean;
  /** Point at the runner's runtimes in Infrastructure: what it lacks is a runtime signed in. */
  signIn: boolean;
  /**
   * Messages and turns sent now are accepted and wait for the runner: the states the server's own
   * demand hook answers as coming back by themselves (managed-runner-demand.ts). Work sent while it
   * is FAILED, FENCING or being removed would wait for an owner or an operator, so it is not offered;
   * nor while the server reports MANAGED_RUNNER_UNAVAILABLE, when no manager runs to start it; nor to
   * a runner asleep or going to sleep that the server offers no wake for (`canWake`), as for a
   * disabled account, whose demand it no longer records.
   */
  acceptsWork: boolean;
  /**
   * A first session in the managed default workspace can start. It starts on the runtime the runner
   * was found ready with (`initialProvider`); before there is one the server refuses that session
   * with MODEL_UNAVAILABLE, so no client offers a default engine for it.
   */
  startsNewSession: boolean;
  /** The state moves by itself: read the status again soon. */
  moving: boolean;
}

/** The fixed words. `managed-runner-states.fixture.json` carries the same for every state. */
export const MANAGED_RUNNER_COPY = {
  title: {
    setup: 'Set up a managed runner',
    notOffered: 'No managed runner',
    preparing: 'Preparing your managed runner',
    waking: 'Waking your managed runner',
    modelUnavailable: 'Your managed runner needs a model',
    waitingCapacity: 'Waiting for capacity',
    available: 'Managed runner ready',
    unresponsive: 'Managed runner not responding',
    stopping: 'Managed runner going to sleep',
    sleeping: 'Managed runner asleep',
    waitingOperator: 'Waiting for an operator',
    failed: 'Managed runner failed',
    removing: 'Removing managed runner',
    removed: 'Managed runner removed',
  } satisfies Record<ManagedRunnerDisplayKind, string>,
  /** Said when the server gave no reason. */
  detail: {
    setup: 'This Orbit server can run a runner for you, so you can start sessions without setting up a machine of your own.',
    notOffered: 'This Orbit server does not give your account a managed runner. Your own runners are unaffected.',
    preparing: 'Orbit is setting up a runner for you. Sessions can start here once it is ready.',
    waking: 'It is starting again. Messages sent meanwhile wait for it and run once it is up.',
    modelUnavailable: 'None of its runtimes is installed and signed in yet, so it cannot start a session. Sign one in from Infrastructure.',
    waitingCapacity: 'The managed environment has no room for it right now. It starts by itself when room frees up.',
    available: 'Sessions here run on the runner Orbit manages for you.',
    unresponsive: 'Orbit has not heard from it recently. Messages sent meanwhile wait for it.',
    stopping: 'It was idle and is stopping. Work sent now waits, and starts it again once it has stopped.',
    sleeping: 'It went to sleep while idle. Send a message to wake it; its workspace and files are kept.',
    waitingOperator: 'Nothing proves its previous instance stopped, so no new one starts and its data is kept until an operator acts.',
    failed: 'It could not be started.',
    removing: 'It is being removed and is not recreated.',
    removed: 'It was removed. Signing in again does not recreate it.',
  } satisfies Record<ManagedRunnerDisplayKind, string>,
  retry: 'Retry',
  ensure: 'Set up',
  signIn: 'Open Infrastructure',
  registerOwn: 'Register your own machine',
} as const;

/** How often a client reads the status again: soon while it moves by itself, rarely otherwise. */
export const MANAGED_RUNNER_STATUS_POLL_SECONDS = { moving: 5, settled: 30 } as const;

/** The states the server's demand hook queues work for (managed-runner-demand.ts COMING_BACK). */
const COMING_BACK: ReadonlySet<ManagedRunnerReadState> = new Set<ManagedRunnerReadState>([
  'REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY', 'DRAINING', 'SLEEPING',
]);

const SLEEP_STATES: ReadonlySet<ManagedRunnerReadState> = new Set<ManagedRunnerReadState>(['DRAINING', 'SLEEPING']);

const MOVING: ReadonlySet<ManagedRunnerDisplayKind> = new Set<ManagedRunnerDisplayKind>([
  'preparing', 'waking', 'modelUnavailable', 'waitingCapacity', 'unresponsive', 'stopping', 'removing',
]);

function displayKind(status: ManagedRunnerStatus): ManagedRunnerDisplayKind | null {
  switch (status.managementState) {
    case 'NOT_PROVISIONED':
      return status.actions.canEnsure ? 'setup' : 'notOffered';
    case 'REQUESTED':
    case 'PROVISIONING':
    case 'STARTING':
      if (status.reason?.code === MODEL_UNAVAILABLE) return 'modelUnavailable';
      // `initialProvider` is recorded when the runner becomes READY and kept: starting with one is
      // starting again.
      return status.initialProvider ? 'waking' : 'preparing';
    case 'WAITING_CAPACITY':
      return 'waitingCapacity';
    case 'READY':
      return status.usable ? 'available' : 'unresponsive';
    case 'DRAINING':
      return 'stopping';
    case 'SLEEPING':
      // Demand sets the desired state back to RUNNING before the manager's next pass moves it.
      return status.desiredState === 'RUNNING' ? 'waking' : 'sleeping';
    case 'FENCING':
      return 'waitingOperator';
    case 'FAILED':
      return 'failed';
    case 'DELETING':
      return 'removing';
    case 'DELETED':
      return 'removed';
    default:
      // A state this contract does not name: no managed UI rather than a guess.
      return null;
  }
}

/** The display for a status, or null when there is no managed UI for it. */
export function managedRunnerDisplay(status: ManagedRunnerStatus | null | undefined): ManagedRunnerDisplay | null {
  if (!status || status.enabled !== true || status.contractVersion !== MANAGED_RUNNER_CONTRACT_VERSION) return null;
  const kind = displayKind(status);
  if (!kind) return null;
  const reason = status.reason ?? null;
  // Switched on without a usable environment: nothing reconciles, so nothing moves by itself.
  const frozen = reason?.code === MANAGED_RUNNER_UNAVAILABLE;
  // Asleep, or going to sleep, it comes back only on a wake the server would perform.
  const wakeable = !SLEEP_STATES.has(status.managementState) || status.actions.canWake;
  const acceptsWork = !frozen && wakeable && COMING_BACK.has(status.managementState);
  return {
    kind,
    title: MANAGED_RUNNER_COPY.title[kind],
    detail: (kind !== 'available' && reason?.message) || MANAGED_RUNNER_COPY.detail[kind],
    retry: status.managementState === 'FAILED' && status.actions.canRetry,
    ensure: status.managementState === 'NOT_PROVISIONED' && status.actions.canEnsure,
    signIn: reason?.code === MODEL_UNAVAILABLE && !!status.runnerId,
    acceptsWork,
    startsNewSession: acceptsWork && !!status.initialProvider,
    moving: !frozen && MOVING.has(kind),
  };
}
