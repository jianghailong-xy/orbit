import { ConflictException } from '@nestjs/common';
import {
  ENGINE_SIGNED_OUT,
  type EngineSignedOutRefusal,
  type LoginEngine,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { isLoginEngine, namedRunnerEngines } from '../common/runner-engines';
import { accountDir } from '@orbit/shared';
import { DEFAULT_ACCOUNT, accountEnvVar, accountOnRunner } from '../providers/account';
import { SESSION_RUNNER_OFFLINE_AFTER_MS } from './session-state';
import { antigravityGoogleLogin } from '../common/antigravity-readiness';

/** Engine names as the user sees them elsewhere in Orbit (matches the web's RunnerSignIn). */
const ENGINE_LABELS: Record<LoginEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  antigravity: 'Antigravity',
};

/** What each CLI's own sign-in costs, for a machine whose owner has a terminal on it. Antigravity
 *  has none: `agy` signed in at a terminal keeps that login where Orbit's sessions never look. */
const LOGIN_COMMANDS: Record<Exclude<LoginEngine, 'antigravity'>, string> = {
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
  antigravity: { any: ['GEMINI_API_KEY'] },
};

/** The runner fields this reads — a subset of the Prisma row. */
export interface EnginePreflightRunner {
  name?: string | null;
  displayName?: string | null;
  status: string;
  lastHeartbeatAt: Date | null;
  /** Heartbeat-reported per-engine health, stored as sent (RunnerEngineHealth[]). */
  engines: unknown;
  /** The names its accounts were given in Orbit (Runner.accountNames), which a refusal names them by. */
  accountNames?: unknown;
  /** What its last heartbeat declared (Runner.capabilities): whether it can sign Antigravity in
   *  with Google, which is the first way out an Antigravity refusal names. */
  capabilities?: readonly string[];
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
  /** The account's own directory, when it is not the runner's: a sign-in typed on the machine has
   *  to run in it — a CODEX_HOME, a CLAUDE_CONFIG_DIR — or it signs in Default instead. */
  dir?: string;
}

/**
 * Which account's sign-in this session runs on, or null when the runner's report cannot say.
 *
 * Resolved the way dispatch resolves it (resolveProviderExec): an account the workspace picked that
 * this runner reports runs the session in that account's own directory, and is found with the same
 * lookup (accountOnRunner); anything else runs in the session's own environment. That is Default,
 * whose sign-in is the engine's own answer: the runner probes the engine in its own environment,
 * which is what selects Default.
 *
 * Not judged:
 *   - a picked account this runner does not report (the workspace moved machines, the slot was
 *     removed, the runner is too old to list accounts). Dispatch falls back to Default for it, and
 *     a refusal over Default's sign-in would be about an account nobody picked;
 *   - a config directory typed into the workspace's environment, with no reported account picked to
 *     replace it: the session runs in that directory, and the runner reports sign-ins by account,
 *     not by directory.
 */
function sessionAccountLogin(
  engine: LoginEngine,
  health: RunnerEngineHealth,
  account: string | null | undefined,
  workspaceEnv: unknown,
  runnerEngines: RunnerEngineHealth[],
): SessionLogin | null {
  const pick = account?.trim();
  if (pick && pick !== DEFAULT_ACCOUNT) {
    const slot = accountOnRunner(engine, pick, runnerEngines);
    if (!slot) return null;
    // Named the way the Providers page names its row, which is never who the account is: its
    // email and id stay on the machine, and the runner reports neither.
    return { auth: slot.auth, name: slot.name ? `"${slot.name}"` : slot.id, dir: accountDir(slot) };
  }
  const env = (workspaceEnv && typeof workspaceEnv === 'object' ? workspaceEnv : {}) as Record<string, unknown>;
  const varName = accountEnvVar(engine);
  if (varName && typeof env[varName] === 'string' && (env[varName] as string).trim() !== '') return null;
  const own = health.accounts?.find((entry) => entry.id === DEFAULT_ACCOUNT)?.name || 'Default';
  return { auth: health.auth, ...((health.accounts?.length ?? 0) > 1 ? { name: `"${own}"` } : {}) };
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
 *   - the session brings its own credential (a configured provider's API key, an account pool member's,
 *     a shared pool's gateway session token, or one set on the workspace's environment) → the CLI's
 *     local login is not what will run it;
 *   - the runtime resolves credentials itself (OpenCode);
 *   - the runner has never reported this engine, or reports `unknown` (its probe couldn't answer —
 *     which is deliberately NOT a claim of a sign-out), or reports a login engine as not installed
 *     (the runner installs engines on demand, so that is a normal first-session state). Antigravity's
 *     explicit `auth=no` is judged whether or not agy is installed: it says the runner has neither a
 *     Google sign-in that answers nor a GEMINI_API_KEY, and a Gemini key is a way out either way;
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

  /** The body is an EngineSignedOutRefusal: the engine and runner it is about, and the sign-in
   *  that clears it when Orbit can start one from the browser (engineSignInAction). */
  constructor(
    readonly runtime: string,
    message: string,
    runnerId: string,
    signIn?: EngineSignedOutRefusal['signIn'],
  ) {
    const body: EngineSignedOutRefusal = {
      code: ENGINE_SIGNED_OUT,
      message,
      engine: runtime,
      runnerId,
      ...(signIn ? { signIn } : {}),
    };
    super(body);
  }
}

/** Recognise the refusal above without importing Nest's exception hierarchy or matching prose. */
export function isEngineSignedOut(error: unknown): error is EngineSignedOutConflict {
  return error instanceof EngineSignedOutConflict;
}

export function signedOutEngineRefusal(args: {
  /** The built-in runtime that will actually execute this session (not the provider identity). */
  runtime: string;
  /** True when dispatch injects a credential of the session's own (custom-provider.ts): a configured
   *  ModelProvider's key, an account pool member's, or — for a shared pool — OPENAI_BASE_URL at the pool
   *  gateway with a session token as OPENAI_API_KEY (QueueService.resolveSharedPool). */
  bringsOwnCredentials: boolean;
  /** The workspace's custom environment, which the runner layers onto the engine process. */
  workspaceEnv?: unknown;
  /** The accounts this session's workspace pins it to, one per engine that keeps accounts
   *  (Workspace.codexAccount / Workspace.claudeAccount). Absent or null is Default. */
  accounts?: { codexAccount?: string | null; claudeAccount?: string | null } | null;
  runner: EnginePreflightRunner;
  nowMs?: number;
}): string | null {
  if (args.bringsOwnCredentials) return null;
  const runtime = args.runtime;
  if (!isLoginEngine(runtime)) return null;
  if (bringsOwnEnvCredential(runtime, args.workspaceEnv)) return null;

  const heartbeatMs = args.runner.lastHeartbeatAt?.getTime() ?? NaN;
  const online =
    args.runner.status !== 'OFFLINE' &&
    Number.isFinite(heartbeatMs) &&
    heartbeatMs >= (args.nowMs ?? Date.now()) - SESSION_RUNNER_OFFLINE_AFTER_MS;
  if (!online) return null;

  // Named as the Providers page names them: with what each account was called in Orbit.
  const engines = namedRunnerEngines({ engines: args.runner.engines, accountNames: args.runner.accountNames });
  const health = engines?.find((e) => e.engine === runtime);
  if (!engines || !health) return null;
  const machine = args.runner.displayName || args.runner.name || 'this runner';
  if (runtime === 'antigravity') {
    return health.auth === 'no' ? antigravityRefusal(health, args.runner, machine) : null;
  }
  if (!health.installed) return null;
  // An engine that keeps one sign-in per account is judged on the account this session runs on;
  // one that keeps a single login is judged on that.
  const account = runtime === 'claude' ? args.accounts?.claudeAccount : args.accounts?.codexAccount;
  const login: SessionLogin | null = accountEnvVar(runtime)
    ? sessionAccountLogin(runtime, health, account, args.workspaceEnv, engines)
    : { auth: health.auth };
  if (login?.auth !== 'no') return null;

  const label = ENGINE_LABELS[runtime];
  if (login.name) {
    // Quoted the way the runner quotes it in its own sign-in hints (loginCommandIn).
    const varName = accountEnvVar(runtime);
    const command =
      login.dir && varName
        ? `${varName}='${login.dir.replace(/'/g, `'"'"'`)}' ${LOGIN_COMMANDS[runtime]}`
        : LOGIN_COMMANDS[runtime];
    return (
      `${label} account ${login.name} is signed out on runner "${machine}" — every session run on that account fails immediately. ` +
      `Sign it in from the Providers page, or run \`${command}\` on that machine, then start this session again.`
    );
  }
  return (
    `${label} is signed out on runner "${machine}" — every session started there fails immediately. ` +
    `Sign in from the Runners page, or run \`${LOGIN_COMMANDS[runtime]}\` on that machine, then start this session again.`
  );
}

/** The Gemini key, the way out of an Antigravity refusal on any runner. */
const GEMINI_KEY_WAY_OUT =
  'connect Gemini in Providers (/providers/new/gemini) — Orbit stores the key encrypted — and start this session on Gemini';

/**
 * Built-in Antigravity has no credential of its own on that runner: no Google sign-in that answers,
 * and no GEMINI_API_KEY. A Google sign-in it had is named as one that has lapsed. What comes first
 * is the way out this runner has: signing in with Google where Orbit can start that, and otherwise
 * why it can't — with the Gemini key, which works on any runner, as the other way.
 */
function antigravityRefusal(health: RunnerEngineHealth, runner: EnginePreflightRunner, machine: string): string {
  const head =
    health.authSource === 'google'
      ? `Antigravity's Google account is signed out on runner "${machine}" — every session started there fails immediately.`
      : `Antigravity has no Google sign-in or Gemini API key on runner "${machine}".`;
  switch (antigravityGoogleLogin(runner)) {
    case 'available':
      return `${head} Sign in with Google from the Providers page, or ${GEMINI_KEY_WAY_OUT}.`;
    case 'unsupported_platform':
      return `${head} Signing in with Google works on Linux runners only for now, so ${GEMINI_KEY_WAY_OUT}.`;
    default:
      return `${head} Signing in with Google needs a newer Orbit runner there; until it updates, ${GEMINI_KEY_WAY_OUT}.`;
  }
}

/**
 * The sign-in that clears a refusal of `runtime` on this runner, when Orbit can start it from the
 * browser: Antigravity's Google sign-in, on a runner that relays it. The other engines' refusals
 * name their Runners-page sign-in in words, as they always have.
 */
export function engineSignInAction(
  runtime: string,
  runner: { capabilities?: readonly string[] },
): EngineSignedOutRefusal['signIn'] {
  return runtime === 'antigravity' && antigravityGoogleLogin(runner) === 'available'
    ? { engine: 'antigravity' }
    : undefined;
}
