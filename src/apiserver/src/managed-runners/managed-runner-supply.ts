import { ConflictException } from '@nestjs/common';
import { AgentProvider, ENGINE_CLI_NAMES, MODEL_UNAVAILABLE, defaultEngineOf, type LoginEngine } from '@orbit/shared';

import { usedRunnerEngines } from '../common/runner-engines';
import type { PrismaService } from '../prisma/prisma.service';
import { isBuiltinProvider, keyCredential } from '../providers/custom-provider';
import { ADVERTISED_RUNTIMES } from '../runner-api/runner-provider-support';
import { bringsOwnEnvCredential } from '../sessions/engine-signin-preflight';

/**
 * Model supply on a managed runner (docs/managed-runner-design.md, "Provisioning retry wake and
 * sleep" 3 and "Resource admission model supply and isolation"): the runtimes its last heartbeat
 * reported installed and signed in, or else one of its owner's own model keys that a runtime it
 * reported installed can run (`managedKeySupply`). A mounted volume and a heartbeat without either
 * is not READY, and the managed image installs nothing on demand, so an engine the runner does not
 * report ready is one a session cannot start on there.
 *
 * Only the CLI's own `auth: yes` counts as a sign-in: `unknown` is a probe that could not answer, not
 * a sign-in. OpenCode (which is never signed in) and DeepSeek Harness (whose readiness is reported
 * apart) are not counted as supply in this version.
 */

/** The runtimes that count, in the order a first session takes them: Orbit's own default first. */
export const MANAGED_SUPPLY_RUNTIMES: readonly LoginEngine[] = ['claude', 'codex', 'kimi', 'antigravity'];

/** The runner fields this reads — a subset of the Prisma row. */
export interface ManagedSupplyRunner {
  /** Heartbeat-reported per-engine health, stored as sent (RunnerEngineHealth[]). */
  engines: unknown;
  /** The engines whose Default its owner removed from Orbit (`runner.default_removed`): such an engine is
   *  signed in as the accounts that remain are (usedRunnerEngines). Required, so a select that forgets
   *  it does not compile. */
  defaultRemoved: unknown;
  /** What its last heartbeat declared: a runtime the claim needs advertised has to be in it. */
  capabilities?: readonly string[] | null;
}

const ENGINE_LABELS: Record<LoginEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  antigravity: 'Antigravity',
  cursor: ENGINE_CLI_NAMES[AgentProvider.CURSOR],
};

/**
 * Whether `runtime` can start a session on this runner by its last report: installed without an
 * installation error, signed in — or bringing a credential of the session's own — and, for a
 * runtime the claim only hands to a runner that advertises it, advertised.
 */
export function managedRuntimeReady(
  runner: ManagedSupplyRunner,
  runtime: string,
  options: { bringsOwnCredentials?: boolean } = {},
): boolean {
  if (!(MANAGED_SUPPLY_RUNTIMES as readonly string[]).includes(runtime)) return false;
  const health = usedRunnerEngines({ engines: runner.engines, accountNames: null, defaultRemoved: runner.defaultRemoved })
    ?.find((engine) => engine.engine === runtime);
  if (!health?.installed || health.installationError) return false;
  if (health.auth !== 'yes' && !options.bringsOwnCredentials) return false;
  const advertised = ADVERTISED_RUNTIMES.some(({ provider }) => provider === runtime);
  return !advertised || (runner.capabilities ?? []).includes(`provider:${runtime}`);
}

/** Every runtime ready on this runner, preferred first; empty when none is or nothing was reported. */
export function managedRuntimeSupply(runner: ManagedSupplyRunner): LoginEngine[] {
  return MANAGED_SUPPLY_RUNTIMES.filter((runtime) => managedRuntimeReady(runner, runtime));
}

/**
 * The model key a managed runner with no runtime signed in is ready with, by the slug a first session
 * names it with, or null. It is the first of its owner's own enabled keys, in the order the owner
 * arranged them (`position`, unset last, then age), whose engine this runner reported installed,
 * without an installation error and advertised where the claim needs it. That engine is the one a
 * session naming only the key starts on. A session on a key brings its own credential, so the engine
 * needs no sign-in of its own.
 *
 * Only the owner's own keys count. Another account's key is not theirs to run, and a shared key (no
 * owner) is an administrator's, dispatchable for administrators only. A disabled key counts for
 * nothing. A key whose slug is also a built-in runtime's name (a configured `kimi` or `dsh`) is passed
 * over: `initial_provider` holds the name alone, which would read as that runtime's own sign-in.
 */
export async function managedKeySupply(
  prisma: Pick<PrismaService, 'modelProvider'>,
  ownerId: string,
  runner: ManagedSupplyRunner,
): Promise<string | null> {
  for (const key of await ownerManagedKeys(prisma, ownerId)) {
    if (managedRuntimeReady(runner, key.engine, { bringsOwnCredentials: true })) return key.slug;
  }
  return null;
}

/**
 * The key a first session in a managed default workspace starts on while its runner has not been
 * found ready (no `initialProvider` yet), or null: the first of the owner's own keys that
 * `managedKeySupply` would consider, before the runner has said which engines it has. It is the key READY
 * records when the runner has that key's engine and no runtime of its own signed in, as a brand-new
 * runner has none. A session on it is queued and waits for the runner (`assertManagedFirstSessionRuntime`).
 */
export async function managedFirstSessionKey(prisma: Pick<PrismaService, 'modelProvider'>, ownerId: string): Promise<string | null> {
  return (await ownerManagedKeys(prisma, ownerId))[0]?.slug ?? null;
}

/**
 * What a first session in a managed default workspace, sent with nothing named, starts on now — the
 * status's `firstSessionProvider` (docs/managed-runner-design.md, "Server and three client interfaces"),
 * so a client offers that session exactly when this server would take it. Once the runner has been
 * READY it is `initialProvider`, which `lastProviderByWorkspace` answers for a workspace with no
 * history. Before that the default is the owner's first key (`managedFirstSessionKey`), and the
 * session is queued on it while the runner has not reported its engines, or taken at once when it
 * reported that key's engine ready; with no key, or a report without that engine, there is none
 * (`assertManagedFirstSessionRuntime` refuses it MODEL_UNAVAILABLE).
 */
export function managedFirstSessionProvider(
  initialProvider: string | null,
  firstKey: { slug: string; engine: LoginEngine } | null,
  runner: ManagedSupplyRunner | null,
): string | null {
  if (initialProvider) return initialProvider;
  if (!firstKey) return null;
  if (runner?.engines == null) return firstKey.slug;
  return managedRuntimeReady(runner, firstKey.engine, { bringsOwnCredentials: true }) ? firstKey.slug : null;
}

/** The owner's own enabled keys, in the owner's order, that run on a runtime counted as supply, with that runtime. */
export async function ownerManagedKeys(prisma: Pick<PrismaService, 'modelProvider'>, ownerId: string): Promise<Array<{ slug: string; engine: LoginEngine }>> {
  const keys = await prisma.modelProvider.findMany({
    where: { ownerId, enabled: true },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { slug: true, runtime: true, baseUrl: true, apiKeyEnc: true, presetSlug: true },
  });
  const usable: Array<{ slug: string; engine: LoginEngine }> = [];
  for (const key of keys) {
    if (isBuiltinProvider(key.slug)) continue;
    const engine = defaultEngineOf(keyCredential(key));
    if (engine && (MANAGED_SUPPLY_RUNTIMES as readonly string[]).includes(engine)) usable.push({ slug: key.slug, engine: engine as LoginEngine });
  }
  return usable;
}

/**
 * The first session of a managed runner's default workspace runs on a runtime that runner has ready,
 * or is refused with MODEL_UNAVAILABLE before anything is created — never started on an engine it
 * does not have, which is what the provider floor (Claude) or a client echoing it would otherwise
 * pick. The default it should start on is the mapping's `initialProvider`, which
 * `lastProviderByWorkspace` already answers for a workspace with no history — and before the runner
 * was ever ready, the owner's own key (`managedFirstSessionKey`), which is queued for the runner
 * rather than refused while it has reported nothing (docs/managed-runner-design.md, "Implementation
 * record: capacity, wake and sleep").
 *
 * "First" is the workspace provider seed's own measure: no session a person started there yet (task
 * runs and spawned children do not count). Once there is one, the workspace's history decides, as
 * it does for every workspace, and this is not asked.
 */
export async function assertManagedFirstSessionRuntime(
  prisma: Pick<PrismaService, 'session'>,
  args: {
    workspaceId: string;
    /** The built-in runtime that will execute the session (not the provider identity). */
    runtime: string;
    /** A configured provider's key, an account pool member's or a shared pool's: the CLI's own
     *  sign-in is not what runs it. */
    bringsOwnCredentials: boolean;
    workspaceEnv?: unknown;
    runner: ManagedSupplyRunner;
  },
): Promise<void> {
  const ownCredentials = args.bringsOwnCredentials
    || ((MANAGED_SUPPLY_RUNTIMES as readonly string[]).includes(args.runtime)
      && bringsOwnEnvCredential(args.runtime as LoginEngine, args.workspaceEnv));
  if (managedRuntimeReady(args.runner, args.runtime, { bringsOwnCredentials: ownCredentials })) return;
  // A runner that has never reported its engines — waiting for capacity, being provisioned, or started
  // and not yet heard from; the heartbeat stores a report, an empty one included, as sent — has not said
  // what it lacks. A session that brings its own credential, such as one of the owner's model keys,
  // needs only its engine there: it is queued, and the runner runs it once it is READY. One that needs a
  // runtime's own sign-in has none to wait for on a runner nobody could sign in to yet.
  if (ownCredentials && args.runner.engines == null && (MANAGED_SUPPLY_RUNTIMES as readonly string[]).includes(args.runtime)) return;
  const ran = await prisma.session.findFirst({
    // `kind` is the seed's own measure (workspace-provider.ts): a LANDING row is not a session a
    // person started, and its provider is the reserved `orbit` slug no engine runs.
    where: { workspaceId: args.workspaceId, taskId: null, parentSessionId: null, sessionKind: 'CONVERSATION' },
    select: { id: true },
  });
  if (ran) return;
  const ready = managedRuntimeSupply(args.runner).map((runtime) => ENGINE_LABELS[runtime]);
  const asked = ENGINE_LABELS[args.runtime as LoginEngine] ?? args.runtime;
  throw new ConflictException({
    code: MODEL_UNAVAILABLE,
    message: ready.length
      ? `${asked} is not installed and signed in on your managed runner, so this first session cannot start there. ` +
        `Start it on ${ready.join(' or ')}.`
      : 'No runtime is installed and signed in on your managed runner yet, so this first session cannot start. ' +
        'Sign one in, or add a model key, from Infrastructure, then start the session again.',
  });
}
