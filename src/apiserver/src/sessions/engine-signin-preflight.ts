import { type LoginEngine } from '@orbit/shared';
import { isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
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
 *     queued for a machine that is coming back is ordinary use.
 */
export function signedOutEngineRefusal(args: {
  /** The built-in runtime that will actually execute this session (not the provider identity). */
  runtime: string;
  /** True when a configured ModelProvider will inject its key at dispatch (custom-provider.ts). */
  bringsOwnCredentials: boolean;
  /** The workspace's custom environment, which the runner layers onto the engine process. */
  workspaceEnv?: unknown;
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
  if (!health?.installed || health.auth !== 'no') return null;

  const label = ENGINE_LABELS[args.runtime];
  const machine = args.runner.displayName || args.runner.name || 'this runner';
  return (
    `${label} is signed out on runner "${machine}" — every session started there fails immediately. ` +
    `Sign in from the Runners page, or run \`${LOGIN_COMMANDS[args.runtime]}\` on that machine, then start this session again.`
  );
}
