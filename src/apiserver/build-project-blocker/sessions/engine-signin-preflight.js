"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineSignedOutConflict = void 0;
exports.isEngineSignedOut = isEngineSignedOut;
exports.signedOutEngineRefusal = signedOutEngineRefusal;
const common_1 = require("@nestjs/common");
const runner_engines_1 = require("../common/runner-engines");
const session_state_1 = require("./session-state");
/** Engine names as the user sees them elsewhere in Orbit (matches the web's RunnerSignIn). */
const ENGINE_LABELS = {
    claude: 'Claude Code',
    codex: 'Codex',
    kimi: 'Kimi Code',
};
/** What each CLI's own sign-in costs, for a machine whose owner has a terminal on it. */
const LOGIN_COMMANDS = {
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
const CREDENTIAL_ENV_KEYS = {
    claude: {
        any: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
    },
    codex: { any: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] },
    kimi: { all: ['KIMI_MODEL_NAME', 'KIMI_MODEL_API_KEY'] },
};
function bringsOwnEnvCredential(engine, workspaceEnv) {
    if (!workspaceEnv || typeof workspaceEnv !== 'object')
        return false;
    const env = workspaceEnv;
    const has = (key) => typeof env[key] === 'string' && env[key].trim() !== '';
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
/**
 * The refusal above, as a type a caller can recognise without matching on prose.
 *
 * It reads as a hard failure — a 409 — but it is an AVAILABILITY condition: the engine is signed
 * out on a machine that is otherwise up, and signing in clears it with nothing else changing. A
 * caller that retries (the @-mention delivery ledger) has to be able to tell that apart from a
 * refusal that will never succeed, and matching on the message text is how that comes undone the
 * next time the wording is improved.
 */
class EngineSignedOutConflict extends common_1.ConflictException {
    runtime;
    engineSignedOut = true;
    constructor(runtime, message) {
        super(message);
        this.runtime = runtime;
    }
}
exports.EngineSignedOutConflict = EngineSignedOutConflict;
/** Recognise the refusal above without importing Nest's exception hierarchy or matching prose. */
function isEngineSignedOut(error) {
    return error instanceof EngineSignedOutConflict;
}
function signedOutEngineRefusal(args) {
    if (args.bringsOwnCredentials)
        return null;
    if (!(0, runner_engines_1.isLoginEngine)(args.runtime))
        return null;
    if (bringsOwnEnvCredential(args.runtime, args.workspaceEnv))
        return null;
    const heartbeatMs = args.runner.lastHeartbeatAt?.getTime() ?? NaN;
    const online = args.runner.status !== 'OFFLINE' &&
        Number.isFinite(heartbeatMs) &&
        heartbeatMs >= (args.nowMs ?? Date.now()) - session_state_1.SESSION_RUNNER_OFFLINE_AFTER_MS;
    if (!online)
        return null;
    const engines = (0, runner_engines_1.sanitizeRunnerEngines)(args.runner.engines);
    const health = engines?.find((e) => e.engine === args.runtime);
    if (!health?.installed || health.auth !== 'no')
        return null;
    const label = ENGINE_LABELS[args.runtime];
    const machine = args.runner.displayName || args.runner.name || 'this runner';
    return (`${label} is signed out on runner "${machine}" — every session started there fails immediately. ` +
        `Sign in from the Runners page, or run \`${LOGIN_COMMANDS[args.runtime]}\` on that machine, then start this session again.`);
}
//# sourceMappingURL=engine-signin-preflight.js.map