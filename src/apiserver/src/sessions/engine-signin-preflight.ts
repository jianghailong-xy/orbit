import { ConflictException } from '@nestjs/common';
import { type LoginEngine, type RunnerEngineHealth } from '@orbit/shared';
import { isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import { CODEX_DEFAULT_ACCOUNT, codexAccountOnRunner } from '../providers/codex-account';
import { SESSION_RUNNER_OFFLINE_AFTER_MS } from './session-state';

/** Engine names as the user sees them elsewhere in Orbit (matches the web's RunnerSignIn). */
const ENGINE_LABELS: Record<LoginEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
};

/** What each CLI's own sign-in costs, for a machine whose owner has a terminal on it. */
const LOGIN_COMMANDS: Record<LoginEngine, string> = {
  claude: 'claude auth login',
  codex: 'codex login --device-auth',
  kimi: 'kimi login',
};

/**
 * Environment that makes an engine's own sign-in irrelevant, because the session arrives carrying
 * a credential of its own. Mirrors the runner's `hasInjectedCredentials` (engineinstall.go) — the
 * two have to agree, or this refuses sessions that would have run perfectly.
 *
 * Kimi needs BOTH: the CLI only synthesizes its environment-backed provider when the model switch
 * and the key are present together, and a lone conventional KIMI_API_KEY is config-file-only.
 */
const CREDENTIAL_ENV_KEYS: Record<LoginEngine, { any: string[] } | { all: string[] }> = {
  claude: {
    any: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
  },
  codex: { any: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] },
  kimi: { all: ['KIMI_MODEL_NAME', 'KIMI_MODEL_API_KEY'] },
};

/** The runner fields this reads — a subset of the Prisma row. */
export interface EnginePreflightRunner {
  name?: string | null;
  displayName?: string | null;
  status: string;
  lastHeartbeatAt: Date | null;
  /** Heartbeat-reported per-engine health, stored as sent (RunnerEngineHealth[]). */
  engines: unknown;
}

function bringsOwnEnvCredential(engine: LoginEngine, workspaceEnv: unknown): boolean {
  if (!workspaceEnv || typeof workspaceEnv !== 'object') return false;
  const env = workspaceEnv as Record<string, unknown>;
  const has = (key: string) => typeof env[key] === 'string' && env[key].trim() !== '';
  const spec = CREDENTIAL_ENV_KEYS[engine];
  return 'all' in spec ? spec.all.every(has) : spec.any.some(has);
}

/** The sign-in a session runs on, as the runner reported it. */
interface SessionLogin {
  auth: RunnerEngineHealth['auth'];
  /** Codex only: how the refusal names the account. Absent when the machine has just the one, so
   *  a refusal there reads exactly as it did before accounts. */
  name?: string;
  /** Codex only: the account's CODEX_HOME when it is not the runner's own. A sign-in typed on the
   *  machine has to run in it, or it signs in Default instead. */
  codexHome?: string;
}

/**
 * Which Codex sign-in this session runs on, or null when the runner's report cannot say.
 *
 * Resolved the way dispatch resolves it (resolveProviderExec): an account the workspace picked
 * that this runner reports runs the session in that account's CODEX_HOME, and is found with the
 * same lookup (codexAccountOnRunner); anything else runs in the session's own environment. That is
 * Default, whose sign-in is the engine's own answer: the runner probes the engine in its own
 * environment, which is what selects Default.
 *
 * Not judged:
 *   - a picked account this runner does not report (the workspace moved machines, the slot was
 *     removed, the runner is too old to list accounts). Dispatch falls back to Default for it, and
 *     a refusal over Default's sign-in would be about an account nobody picked;
 *   - a CODEX_HOME typed into the workspace's environment, with no reported account picked to
 *     replace it: the session runs in that directory, and the runner reports sign-ins by account,
 *     not by directory.
 */
function codexSessionLogin(
  codex: RunnerEngineHealth,
  account: string | null | undefined,
  workspaceEnv: unknown,
  runnerEngines: unknown,
): SessionLogin | null {
  const pick = account?.trim();
  if (pick && pick !== CODEX_DEFAULT_ACCOUNT) {
    const slot = codexAccountOnRunner(pick, runnerEngines);
    if (!slot) return null;
    // Named the way the Providers page names its row, which is never who the account is: its
    // email and id stay on the machine, and the runner reports neither.
    return { auth: slot.auth, name: slot.name ? `"${slot.name}"` : slot.id, codexHome: slot.codexHome };
  }
  const env = (workspaceEnv && typeof workspaceEnv === 'object' ? workspaceEnv : {}) as Record<string, unknown>;
  if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== '') return null;
  return { auth: codex.auth, ...((codex.accounts?.length ?? 0) > 1 ? { name: '"Default"' } : {}) };
}

/**
 * Why this session cannot run on the machine it is bound for — or null when it can, which is also
 * the answer to every question this cannot settle from here.
 *
 * A runtime that is signed out fails EVERY session started against it, a second or two after
 * creation, until a human signs it back in. That is a state the control plane already knows: the
 * runner probes each engine's own auth command every five minutes (and immediately after anything
 * changes it) and reports the result on its heartbeat — the same fact the Runners page draws and
 * the sign-out push announces. Answering at create time turns hours of identically-dead sessions,
 * each holding a git checkout, into one refusal the caller can act on: an overnight OAuth
 * expiry produced 50 of them here before anyone noticed.
 *
 * Everything ambiguous stays a `null` — a session that fails at spawn with an actionable message
 * is a far better outcome than one refused for a state we misread:
 *   - the session brings its own credential (a configured provider's API key, or one set on the
 *     workspace's environment) → the CLI's local login is not what will run it;
 *   - the runtime has no local sign-in at all (OpenCode resolves credentials itself);
 *   - the runner has never reported this engine, or reports `unknown` (its probe couldn't answer —
 *     which is deliberately NOT a claim of a sign-out), or reports it as not installed (the runner
 *     installs engines on demand, so that is a normal first-session state);
 *   - the runner is offline: its last report describes whenever it was last alive, and a session
 *     queued for a machine that is coming back is ordinary use;
 *   - a Codex session whose account the report cannot place (codexSessionLogin). Codex keeps one
 *     sign-in per account, and what is judged is the account the session runs on, never simply
 *     the machine's Default.
 */
/**
 * The refusal above, as a type a caller can recognise without matching on prose.
 *
 * It reads as a hard failure — a 409 — but it is an AVAILABILITY condition: the engine is signed
 * out on a machine that is otherwise up, and signing in clears it with nothing else changing. A
 * caller that retries (the @-mention delivery ledger) has to be able to tell that apart from a
 * refusal that will never succeed, and matching on the message text is how that comes undone the
 * next time the wording is improved.
 */
export class EngineSignedOutConflict extends ConflictException {
  readonly engineSignedOut = true;

  constructor(readonly runtime: string, message: string) {
    super(message);
  }
}

/** Recognise the refusal above without importing Nest's exception hierarchy or matching prose. */
export function isEngineSignedOut(error: unknown): error is EngineSignedOutConflict {
  return error instanceof EngineSignedOutConflict;
}

export function signedOutEngineRefusal(args: {
  /** The built-in runtime that will actually execute this session (not the provider identity). */
  runtime: string;
  /** True when a configured ModelProvider will inject its key at dispatch (custom-provider.ts). */
  bringsOwnCredentials: boolean;
  /** The workspace's custom environment, which the runner layers onto the engine process. */
  workspaceEnv?: unknown;
  /** The Codex account this session runs on (Workspace.codexAccount today); absent or null is
   *  Default. Only a Codex session reads it. */
  codexAccount?: string | null;
  runner: EnginePreflightRunner;
  nowMs?: number;
}): string | null {
  if (args.bringsOwnCredentials) return null;
  if (!isLoginEngine(args.runtime)) return null;
  if (bringsOwnEnvCredential(args.runtime, args.workspaceEnv)) return null;

  const heartbeatMs = args.runner.lastHeartbeatAt?.getTime() ?? NaN;
  const online =
    args.runner.status !== 'OFFLINE' &&
    Number.isFinite(heartbeatMs) &&
    heartbeatMs >= (args.nowMs ?? Date.now()) - SESSION_RUNNER_OFFLINE_AFTER_MS;
  if (!online) return null;

  const engines = sanitizeRunnerEngines(args.runner.engines);
  const health = engines?.find((e) => e.engine === args.runtime);
  if (!health?.installed) return null;
  // Codex keeps one sign-in per account, and the one judged is the one this session runs on.
  const login: SessionLogin | null =
    args.runtime === 'codex'
      ? codexSessionLogin(health, args.codexAccount, args.workspaceEnv, args.runner.engines)
      : { auth: health.auth };
  if (login?.auth !== 'no') return null;

  const label = ENGINE_LABELS[args.runtime];
  const machine = args.runner.displayName || args.runner.name || 'this runner';
  if (login.name) {
    // Quoted the way the runner quotes it in its own sign-in hints (loginCommandIn).
    const command = login.codexHome
      ? `CODEX_HOME='${login.codexHome.replace(/'/g, `'"'"'`)}' ${LOGIN_COMMANDS[args.runtime]}`
      : LOGIN_COMMANDS[args.runtime];
    return (
      `${label} account ${login.name} is signed out on runner "${machine}" — every session run on that account fails immediately. ` +
      `Sign it in from the Providers page, or run \`${command}\` on that machine, then start this session again.`
    );
  }
  return (
    `${label} is signed out on runner "${machine}" — every session started there fails immediately. ` +
    `Sign in from the Runners page, or run \`${LOGIN_COMMANDS[args.runtime]}\` on that machine, then start this session again.`
  );
}
