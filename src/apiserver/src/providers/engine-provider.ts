/**
 * One resolution for every door that takes an engine and a provider (docs/provider-engine-contract.md
 * §3): session create, resume, config and retry, task create, update and batch pin, the wiki maintenance
 * setting, preferences and the @-mention delivery's seed. Each door used to read a provider slug on its
 * own, and each read the engine off it; now the engine is an axis of its own and the slug only says
 * where the credential comes from, so the two are resolved together, here, by one set of rules:
 *
 *   engine + provider  the pair, when the credential can run on that engine (shared providerEngines.ts);
 *   provider only      the engine the credential ran on before the split — the one every old caller got;
 *   engine only        that engine's own sign-in on the runner, OpenCode's own configuration, or for
 *                      DeepSeek Harness the owner's first enabled DeepSeek key;
 *   neither            what the workspace last ran a session on (workspace-provider.ts).
 *
 * Two old spellings are read here and written in the new one: an OpenCode model naming a key
 * (`provider: opencode`, `model: orbit-<slug>/<model>`) is that key on OpenCode, and the built-in `dsh`
 * slug is DeepSeek Harness on the owner's default DeepSeek key. A retired provider name (a
 * `deepseek-harness` row's old slug, provider_slug_alias) is the key it was folded into, on the engine
 * the old slug ran on.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AgentProvider,
  ALL_ENGINES,
  ENGINE_CLI_NAMES,
  credentialEngines,
  isEngine,
  isEngineCompatible,
  openCodeKeyOf,
  type LoginEngine,
} from '@orbit/shared';
import { Prisma, type ModelProvider } from '@prisma/client';
import {
  accountPoolRuntime,
  adminOnlyProviderRefusal,
  engineIncompatible,
  isBuiltinProvider,
  keyCredential,
  usableProviderScope,
} from './custom-provider';
import { SESSION_ENGINE_UNKNOWN_MESSAGE, sessionEngine, type SessionEngineFacts } from './session-engine';

/** A configured key's row. */
export type KeyRow = ModelProvider;

/** Where a session's credential comes from, as a slug resolved to it (§1.3). */
export type ResolvedCredential =
  /** The engine's own sign-in on the runner; the slug is the engine's name. */
  | { kind: 'login'; engine: LoginEngine }
  /** OpenCode's own provider configuration on the runner. */
  | { kind: 'opencode' }
  /** A configured key — named by its own slug, or by a retired name (`alias`) that resolves to it.
   *  `slug` is the key's own, which is what a session or a task stores. */
  | { kind: 'key'; row: KeyRow; slug: string; alias: { slug: string; engine: AgentProvider } | null }
  /** An account pool, which runs on the engine it was made on. */
  | { kind: 'pool'; slug: string; engine: AgentProvider }
  /** The built-in `dsh` slug: a legacy session's whose key is its workspace's ORBIT_DSH_API_KEY. A new
   *  write never stores it — it becomes the owner's default DeepSeek key (§3.3). */
  | { kind: 'legacy-dsh' };

/** The engines a resolved credential can run on, its default first (the shared compatibility table). */
export function resolvedCredentialEngines(credential: ResolvedCredential): AgentProvider[] {
  switch (credential.kind) {
    case 'login':
      return [credential.engine as AgentProvider];
    case 'opencode':
      return [AgentProvider.OPENCODE];
    case 'pool':
      return [credential.engine];
    case 'legacy-dsh':
      return [AgentProvider.DSH];
    case 'key':
      return credentialEngines(keyCredential(credential.row));
  }
}

/** The slug a session or a task stores for a resolved credential: a key's own, never a retired name. */
export function storedSlug(credential: ResolvedCredential): { provider: string; providerBuiltin: boolean } {
  switch (credential.kind) {
    case 'login':
      return { provider: credential.engine, providerBuiltin: true };
    case 'opencode':
      return { provider: AgentProvider.OPENCODE, providerBuiltin: true };
    case 'legacy-dsh':
      return { provider: AgentProvider.DSH, providerBuiltin: true };
    case 'pool':
      return { provider: credential.slug, providerBuiltin: false };
    case 'key':
      return { provider: credential.slug, providerBuiltin: false };
  }
}

// ---------------------------------------------------------------------------------------------------
// The refusals (§3.7). Codes and wording are the contract's; clients and tests match them verbatim.
// ---------------------------------------------------------------------------------------------------

export function engineUnknown(value: unknown): BadRequestException {
  return new BadRequestException({
    code: 'ENGINE_UNKNOWN',
    message: `engine "${String(value)}" is not one of ${ALL_ENGINES.join(', ')}`,
  });
}

/** Only a provider was named, and nothing can run it: a key on a protocol no engine speaks, or a
 *  Claude subscription token on an endpoint that is not Anthropic's protocol. */
export function providerRunsNowhere(slug: string): BadRequestException {
  return new BadRequestException({
    code: 'PROVIDER_ENGINE_INCOMPATIBLE',
    message: `provider "${slug}" cannot run on any engine`,
    engine: null,
    provider: slug,
    engines: [],
  });
}

export function engineImmutable(engine: AgentProvider, requested: AgentProvider): BadRequestException {
  return new BadRequestException({
    code: 'ENGINE_IMMUTABLE',
    message:
      `this session runs on ${ENGINE_CLI_NAMES[engine]}, and a session's engine never changes; ` +
      `start a new session to use ${ENGINE_CLI_NAMES[requested]}`,
    engine,
  });
}

export const DEEPSEEK_KEY_REQUIRED_MESSAGE =
  'DeepSeek Harness runs on a DeepSeek API key; connect one, then try again';

export function deepSeekKeyRequired(): BadRequestException {
  return new BadRequestException({ code: 'DEEPSEEK_KEY_REQUIRED', message: DEEPSEEK_KEY_REQUIRED_MESSAGE });
}

export function sessionEngineUnknown(): ConflictException {
  return new ConflictException({ code: 'SESSION_ENGINE_UNKNOWN', message: SESSION_ENGINE_UNKNOWN_MESSAGE });
}

/**
 * An engine a request named: one of the six, or absent (`undefined`, `null` and `''` all name none).
 * Anything else is ENGINE_UNKNOWN — the DTOs only check that it is a string (§6.2).
 */
export function requestedEngine(value: unknown): AgentProvider | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isEngine(value)) throw engineUnknown(value);
  return value;
}

// ---------------------------------------------------------------------------------------------------
// What a slug names (§3.1).
// ---------------------------------------------------------------------------------------------------

/**
 * Which door asks. Each kept the words it already had for a provider it cannot use: a new session
 * names the slug (`provider not available: "<slug>"`), a task pin and a switch target do not.
 */
export type ProviderDoor = 'session' | 'pin' | 'switch';

function notAvailable(door: ProviderDoor, slug: string): string {
  return door === 'session' ? `provider not available: "${slug}"` : 'provider not available';
}

export interface EngineProviderDeps {
  db: Prisma.TransactionClient;
  /** Why one of the owner's account pools can take no session, or null (QueueService.accountPoolRefusal). */
  poolRefusal: (ownerId: string, slug: string, db: Prisma.TransactionClient) => Promise<string | null>;
}

/** The key a retired provider name resolves to, when the owner may use that key (§1.5). */
export async function aliasedKey(
  db: Prisma.TransactionClient,
  ownerId: string,
  slug: string,
): Promise<{ row: KeyRow; engine: AgentProvider } | null> {
  const alias = await db.providerSlugAlias.findUnique({ where: { slug }, select: { engine: true, providerId: true } });
  if (!alias || !isEngine(alias.engine)) return null;
  const row = await db.modelProvider.findFirst({
    where: { id: alias.providerId, ...(await usableProviderScope(db, ownerId)) },
  });
  return row ? { row, engine: alias.engine } : null;
}

/**
 * The key a session's stored slug spends, whatever its state: the owner's (or, for an admin, a shared)
 * row of that slug, else the key a retired name of it resolves to. Disabled rows included — dispatch
 * holds those with their own reason; null is a slug no key answers.
 */
export async function keyRowForSlug(
  db: Prisma.TransactionClient,
  ownerId: string,
  slug: string,
): Promise<KeyRow | null> {
  const row = await db.modelProvider.findFirst({ where: { slug, ...(await usableProviderScope(db, ownerId)) } });
  return row ?? (await aliasedKey(db, ownerId, slug))?.row ?? null;
}

/**
 * What `slug` names for `ownerId`, in the order of §3.1, for a door about to write it:
 *
 *  1. `claude`, `codex`, `kimi`, `antigravity` — the engine's sign-in; `opencode` — OpenCode's own
 *     configuration. A named `kimi` is never looked up as a configured row (0077).
 *  2. a key they may use (usableProviderScope): disabled, it is refused in the door's words.
 *  3. one of their account pools, refused with its reason when it can take no session.
 *  4. a retired name whose key they may use.
 *  5. `dsh`: the built-in DeepSeek Harness slug — after the above, which a configured `dsh` keeps (0377).
 *  6. nothing: refused, naming the admins for a shared row they may not use.
 *
 * `builtin` is a stored row's providerBuiltin, for a slug read back off a session or a seed: false keeps
 * a configured `kimi` or `dsh` configured, true keeps the built-in one built-in. A new request leaves it
 * undefined.
 */
export async function classifyProvider(
  deps: EngineProviderDeps,
  ownerId: string,
  slug: string,
  door: ProviderDoor,
  builtin?: boolean,
): Promise<ResolvedCredential> {
  const { db } = deps;
  if (slug === AgentProvider.CLAUDE || slug === AgentProvider.CODEX || slug === AgentProvider.ANTIGRAVITY) {
    return { kind: 'login', engine: slug };
  }
  if (slug === AgentProvider.KIMI && builtin !== false) return { kind: 'login', engine: AgentProvider.KIMI };
  if (slug === AgentProvider.OPENCODE) return { kind: 'opencode' };
  if (slug === AgentProvider.DSH && builtin === true) return { kind: 'legacy-dsh' };
  // An enabled row is what a slug names; under the `dsh` keyword a disabled one is looked for too, so a
  // configured `dsh` that is turned off is refused rather than read as the built-in engine (0377).
  const row = await db.modelProvider.findFirst({
    where: {
      slug,
      ...(slug === AgentProvider.DSH ? {} : { enabled: true }),
      ...(await usableProviderScope(db, ownerId)),
    },
  });
  if (row) {
    if (row.enabled === false) throw new BadRequestException(notAvailable(door, slug));
    return { kind: 'key', row, slug, alias: null };
  }
  const poolEngine = await accountPoolRuntime(db, ownerId, slug);
  if (poolEngine) {
    const refusal = await deps.poolRefusal(ownerId, slug, db);
    if (refusal) throw new BadRequestException(refusal);
    return { kind: 'pool', slug, engine: poolEngine };
  }
  const alias = await aliasedKey(db, ownerId, slug);
  if (alias) {
    if (alias.row.enabled === false) throw new BadRequestException(notAvailable(door, slug));
    return { kind: 'key', row: alias.row, slug: alias.row.slug, alias: { slug, engine: alias.engine } };
  }
  if (slug === AgentProvider.DSH && builtin === undefined) return { kind: 'legacy-dsh' };
  throw new BadRequestException((await adminOnlyProviderRefusal(db, ownerId, slug)) ?? notAvailable(door, slug));
}

/**
 * The owner's default DeepSeek key (§3.3): the first enabled key they may use that DeepSeek Harness can
 * run — a DeepSeek key on Anthropic's protocol holding an API key, not a subscription token — by
 * position (unset last), then age, then id: the order /providers lists them in. A row still on the
 * retired `dsh` runtime counts; it is a DeepSeek key by its preset.
 */
export async function defaultDeepSeekKey(db: Prisma.TransactionClient, ownerId: string): Promise<KeyRow | null> {
  const rows = await db.modelProvider.findMany({
    where: { enabled: true, ...(await usableProviderScope(db, ownerId)) },
    orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.find((row) => isEngineCompatible(AgentProvider.DSH, keyCredential(row))) ?? null;
}

// ---------------------------------------------------------------------------------------------------
// The resolution (§3.2–§3.4).
// ---------------------------------------------------------------------------------------------------

/** What a door resolved: the engine, the credential and how it is stored, and the model. */
export interface EngineProviderResolution {
  engine: AgentProvider;
  provider: string;
  providerBuiltin: boolean;
  credential: ResolvedCredential;
  /** The model as asked, an OpenCode-encoded one (`orbit-<slug>/<model>`) written as its bare id. */
  model: string | null | undefined;
}

/** What a workspace's next session starts on when nothing is named (workspace-provider.ts). */
export interface EngineProviderSeed {
  engine: AgentProvider | null;
  provider: string;
  providerBuiltin: boolean;
}

export interface EngineProviderRequest {
  ownerId: string;
  engine?: unknown;
  provider?: string | null;
  model?: string | null;
  door: ProviderDoor;
  /** Read only when neither an engine nor a provider is named. */
  seed?: () => Promise<EngineProviderSeed>;
}

/**
 * The model and credential an old OpenCode request names in its model (§3.3): `provider: opencode`
 * with `orbit-<slug>/<model>` is the key `<slug>` on OpenCode running `<model>`. Null for anything else.
 */
export function openCodeEncoded(
  provider: string | null | undefined,
  model: string | null | undefined,
): { slug: string; model: string } | null {
  return provider === AgentProvider.OPENCODE ? openCodeKeyOf(model) : null;
}

/** The key an old OpenCode model names, resolved: missing or disabled keeps its old refusal. */
async function openCodeEncodedKey(
  deps: EngineProviderDeps,
  ownerId: string,
  slug: string,
): Promise<ResolvedCredential> {
  try {
    const credential = await classifyProvider(deps, ownerId, slug, 'pin', false);
    if (credential.kind === 'key') return credential;
  } catch {
    // Refused below in the words this spelling always had.
  }
  throw new BadRequestException(
    (await adminOnlyProviderRefusal(deps.db, ownerId, slug)) ?? `provider not available on OpenCode: "${slug}"`,
  );
}

/** The engine a credential runs on when nothing else is named, or the refusal for one nothing runs. */
function defaultEngine(credential: ResolvedCredential, slug: string): AgentProvider {
  if (credential.kind === 'key' && credential.alias) return credential.alias.engine;
  const engine = resolvedCredentialEngines(credential)[0];
  if (!engine) throw providerRunsNowhere(slug);
  return engine;
}

/** `engine` on `credential`, or PROVIDER_ENGINE_INCOMPATIBLE naming the engines it does run on. */
export function assertCompatible(engine: AgentProvider, credential: ResolvedCredential, slug: string): void {
  const engines = resolvedCredentialEngines(credential);
  if (!engines.includes(engine)) throw engineIncompatible(slug, engine, engines);
}

/**
 * Resolve a door's (engine?, provider?, model?) to the engine, the credential and the model it writes.
 *
 * The built-in `dsh` is resolved to the default DeepSeek key here, since every caller writes something
 * new: only a session that already stores it keeps it (resolveSessionSwitch).
 */
export async function resolveEngineProvider(
  deps: EngineProviderDeps,
  request: EngineProviderRequest,
): Promise<EngineProviderResolution> {
  const { ownerId, door } = request;
  const named = requestedEngine(request.engine);
  let model = request.model;
  let slug = request.provider || null;
  let credential: ResolvedCredential | null = null;
  const encoded = openCodeEncoded(slug, model);
  if (encoded) {
    // An old OpenCode request names its key inside its model; the engine it means is OpenCode.
    if (named && named !== AgentProvider.OPENCODE) {
      throw engineIncompatible(AgentProvider.OPENCODE, named, [AgentProvider.OPENCODE]);
    }
    credential = await openCodeEncodedKey(deps, ownerId, encoded.slug);
    model = encoded.model;
    slug = encoded.slug;
    assertCompatible(AgentProvider.OPENCODE, credential, slug);
    return { engine: AgentProvider.OPENCODE, ...storedSlug(credential), credential, model };
  }
  if (slug) {
    credential = await classifyProvider(deps, ownerId, slug, door);
    const engine = named ?? defaultEngine(credential, slug);
    if (credential.kind === 'legacy-dsh') {
      if (engine !== AgentProvider.DSH) throw engineIncompatible(slug, engine, [AgentProvider.DSH]);
      return dshOnDefaultKey(deps.db, ownerId, model);
    }
    assertCompatible(engine, credential, slug);
    return { engine, ...storedSlug(credential), credential, model };
  }
  if (named) return engineOnly(deps.db, ownerId, named, model);
  const seed = request.seed ? await request.seed() : null;
  if (!seed) return engineOnly(deps.db, ownerId, AgentProvider.CLAUDE, model);
  return fromSeed(deps, ownerId, seed, model);
}

/** Only an engine was named (§3.2): its own sign-in, OpenCode's own configuration, or for DeepSeek
 *  Harness the default DeepSeek key. */
async function engineOnly(
  db: Prisma.TransactionClient,
  ownerId: string,
  engine: AgentProvider,
  model: string | null | undefined,
): Promise<EngineProviderResolution> {
  if (engine === AgentProvider.DSH) return dshOnDefaultKey(db, ownerId, model);
  const credential: ResolvedCredential =
    engine === AgentProvider.OPENCODE ? { kind: 'opencode' } : { kind: 'login', engine: engine as LoginEngine };
  return { engine, ...storedSlug(credential), credential, model };
}

async function dshOnDefaultKey(
  db: Prisma.TransactionClient,
  ownerId: string,
  model: string | null | undefined,
): Promise<EngineProviderResolution> {
  const row = await defaultDeepSeekKey(db, ownerId);
  if (!row) throw deepSeekKeyRequired();
  const credential: ResolvedCredential = { kind: 'key', row, slug: row.slug, alias: null };
  return { engine: AgentProvider.DSH, ...storedSlug(credential), credential, model };
}

/**
 * Neither was named: the workspace's seed (§3.4) — re-checked, since the credential it names may have
 * been disabled or deleted since (refused as it always was), or edited onto a protocol the seed's
 * engine does not speak (its default engine instead, as if only the provider had been named).
 */
async function fromSeed(
  deps: EngineProviderDeps,
  ownerId: string,
  seed: EngineProviderSeed,
  model: string | null | undefined,
): Promise<EngineProviderResolution> {
  const credential = await classifyProvider(deps, ownerId, seed.provider, 'session', seed.providerBuiltin);
  if (credential.kind === 'legacy-dsh') return dshOnDefaultKey(deps.db, ownerId, model);
  const engines = resolvedCredentialEngines(credential);
  const engine = seed.engine && engines.includes(seed.engine) ? seed.engine : defaultEngine(credential, seed.provider);
  return { engine, ...storedSlug(credential), credential, model };
}

// ---------------------------------------------------------------------------------------------------
// A session that exists: resume, config, retry-message (§3.5).
// ---------------------------------------------------------------------------------------------------

/** The session fields a switch reads. */
export interface SwitchingSession extends SessionEngineFacts {
  provider: string;
  providerBuiltin: boolean;
  model: string | null;
  runtimeSessionId: string | null;
}

export interface SessionSwitch {
  /** The engine the session runs on, before the write and after it. */
  engine: AgentProvider;
  /** Whether the row has no engine recorded yet, so the write records `engine` first (§1.1). */
  recordsEngine: boolean;
  /** The credential the session is on after the write, and how it is stored. */
  provider: string;
  providerBuiltin: boolean;
  credential: ResolvedCredential | null;
  /** The key behind it, disabled or not; null for a built-in credential and a pool. */
  customRow: KeyRow | null;
  changed: boolean;
  /** The model the request named, an OpenCode-encoded one written as its bare id. */
  model: string | null | undefined;
}

/**
 * The credential a session moves to, if any, on the engine it already runs on.
 *
 * The engine never changes: a request naming another one is ENGINE_IMMUTABLE. Naming only a provider —
 * what every older client sends — moves the credential, which has to be one the session's engine can
 * run (PROVIDER_ENGINE_INCOMPATIBLE); a retired name gives its key, never its engine. Staying where it
 * is, on a key that was disabled, is `provider is disabled`; leaving a disabled or deleted key for
 * another is how such a session recovers (§3.6). A session whose engine was never recorded and whose
 * credential is gone is placed by the credential it moves to while it has never run, and refused
 * SESSION_ENGINE_UNKNOWN once it has.
 */
export async function resolveSessionSwitch(
  deps: EngineProviderDeps,
  session: SwitchingSession,
  request: { engine?: unknown; provider?: string; model?: string | null },
): Promise<SessionSwitch> {
  const { db } = deps;
  const named = requestedEngine(request.engine);
  const recorded = isEngine(session.engine) ? session.engine : null;
  const derived = recorded ?? (await sessionEngine(db, session));
  if (named && derived && named !== derived) throw engineImmutable(derived, named);
  let model = request.model;
  let requested = request.provider;
  // An old OpenCode request names its key in the model.
  const encoded = openCodeEncoded(requested ?? session.provider, model);
  let target: ResolvedCredential | null = null;
  if (encoded && (requested !== undefined || model !== undefined)) {
    target = await openCodeEncodedKey(deps, session.ownerId, encoded.slug);
    model = encoded.model;
    requested = storedSlug(target).provider;
  }
  const current = await storedCredential(db, session);
  const stays = requested === undefined || (requested === session.provider && !target);
  if (stays) {
    if (!current) {
      throw new BadRequestException(
        (await adminOnlyProviderRefusal(db, session.ownerId, session.provider)) ??
          `provider not available: "${session.provider}"`,
      );
    }
    if (current.kind === 'key' && current.row.enabled === false) throw new BadRequestException('provider is disabled');
    const engine = derived ?? named;
    if (!engine) {
      // A key still there that names no engine speaks a protocol none does: said in its own words (§3.7).
      if (current.kind === 'key') throw new BadRequestException(`provider runtime not available: "${current.row.runtime}"`);
      throw sessionEngineUnknown();
    }
    return {
      engine,
      recordsEngine: !recorded,
      provider: session.provider,
      providerBuiltin: session.providerBuiltin,
      credential: current,
      customRow: current.kind === 'key' ? current.row : null,
      changed: false,
      model,
    };
  }
  target ??= await classifyProvider(deps, session.ownerId, requested!, 'switch');
  if (target.kind === 'legacy-dsh') {
    // Naming the built-in dsh moves onto the default DeepSeek key, as a new write would.
    const row = await defaultDeepSeekKey(db, session.ownerId);
    if (!row) throw deepSeekKeyRequired();
    target = { kind: 'key', row, slug: row.slug, alias: null };
  }
  let engine = derived;
  if (!engine) {
    // Never recorded, and its credential gone: placed by where it goes, only while it has never run.
    if (session.runtimeSessionId) throw sessionEngineUnknown();
    engine = named ?? defaultEngine(target, requested!);
  }
  assertCompatible(engine, target, requested!);
  const stored = storedSlug(target);
  return {
    engine,
    recordsEngine: !recorded,
    ...stored,
    credential: target,
    customRow: target.kind === 'key' ? target.row : null,
    changed: stored.provider !== session.provider || stored.providerBuiltin !== session.providerBuiltin,
    model,
  };
}

/**
 * The credential a session is stored on, disabled rows included, or null when nothing answers its slug
 * any more (a deleted key, a pool that is gone). A stored `kimi`/`dsh` is built-in or configured as the
 * row says; a stored built-in `dsh` stays the legacy credential (its workspace's key), never the default
 * DeepSeek key — §3.3, the arbitration of 2026-10-09.
 */
export async function storedCredential(
  db: Prisma.TransactionClient,
  session: { ownerId: string; provider: string | null; providerBuiltin: boolean | null },
): Promise<ResolvedCredential | null> {
  const slug = session.provider || AgentProvider.CLAUDE;
  const builtin = session.providerBuiltin ?? true;
  if (slug === AgentProvider.CLAUDE || slug === AgentProvider.CODEX || slug === AgentProvider.ANTIGRAVITY) {
    return { kind: 'login', engine: slug };
  }
  if (slug === AgentProvider.OPENCODE) return { kind: 'opencode' };
  if (slug === AgentProvider.KIMI && builtin) return { kind: 'login', engine: AgentProvider.KIMI };
  if (slug === AgentProvider.DSH && builtin) return { kind: 'legacy-dsh' };
  const row = await db.modelProvider.findFirst({ where: { slug, ...(await usableProviderScope(db, session.ownerId)) } });
  if (row) return { kind: 'key', row, slug, alias: null };
  const poolEngine = await accountPoolRuntime(db, session.ownerId, slug);
  if (poolEngine) return { kind: 'pool', slug, engine: poolEngine };
  const alias = await aliasedKey(db, session.ownerId, slug);
  return alias ? { kind: 'key', row: alias.row, slug: alias.row.slug, alias: { slug, engine: alias.engine } } : null;
}

/**
 * The slug a switch onto `slug` stores (resolveSessionSwitch): a key's own for a retired name, the
 * default DeepSeek key's for the built-in `dsh`, the slug itself otherwise — and the slug as named when
 * it resolves to nothing, which the switch itself has already refused.
 */
export async function switchTargetSlug(deps: EngineProviderDeps, ownerId: string, slug: string): Promise<string> {
  try {
    const credential = await classifyProvider(deps, ownerId, slug, 'switch');
    if (credential.kind !== 'legacy-dsh') return storedSlug(credential).provider;
    return (await defaultDeepSeekKey(deps.db, ownerId))?.slug ?? slug;
  } catch {
    return slug;
  }
}

/**
 * How a refusal names two (engine, credential) pairs that collide (§3.5): by their slugs, which is what
 * the wording always held — and, when the slugs are the same and only the engines differ, each as
 * `<slug> on <CLI>`, since the slug alone would name the same thing twice.
 */
export function credentialPairLabels(
  a: { engine: AgentProvider | null; provider: string },
  b: { engine: AgentProvider | null; provider: string },
): [string, string] {
  if (a.provider !== b.provider || a.engine === b.engine) return [a.provider, b.provider];
  const on = (pair: { engine: AgentProvider | null; provider: string }) =>
    pair.engine ? `${pair.provider} on ${ENGINE_CLI_NAMES[pair.engine]}` : pair.provider;
  return [on(a), on(b)];
}

// ---------------------------------------------------------------------------------------------------
// A task's pins (§1.2, §3.5): `Task.engine` beside `Task.provider` and `Task.model`.
// ---------------------------------------------------------------------------------------------------

/**
 * What a task's stored provider pin names, without refusing anything — for a pin kept while its engine
 * changes, which may name a key disabled since (still judged by the protocol it speaks). A task has no
 * providerBuiltin: `dsh` is a configured row or pool of that name before it is the built-in slug, as on
 * a new session. Null when nothing answers the slug any more.
 */
export async function taskPinCredential(
  db: Prisma.TransactionClient,
  ownerId: string,
  slug: string,
): Promise<ResolvedCredential | null> {
  if (slug === AgentProvider.CLAUDE || slug === AgentProvider.CODEX || slug === AgentProvider.ANTIGRAVITY
    || slug === AgentProvider.KIMI) {
    return { kind: 'login', engine: slug };
  }
  if (slug === AgentProvider.OPENCODE) return { kind: 'opencode' };
  const row = await db.modelProvider.findFirst({ where: { slug, ...(await usableProviderScope(db, ownerId)) } });
  if (row) return { kind: 'key', row, slug, alias: null };
  const poolEngine = await accountPoolRuntime(db, ownerId, slug);
  if (poolEngine) return { kind: 'pool', slug, engine: poolEngine };
  const alias = await aliasedKey(db, ownerId, slug);
  if (alias) return { kind: 'key', row: alias.row, slug: alias.row.slug, alias: { slug, engine: alias.engine } };
  return slug === AgentProvider.DSH ? { kind: 'legacy-dsh' } : null;
}

/** The pins a task write stores; an absent field is left as it is. */
export interface TaskPinWrite {
  engine?: AgentProvider | null;
  provider?: string | null;
  model?: string | null;
}

/** The engine a task write names: absent (`undefined`), cleared (`null` or `''`), or one of the six. */
function pinnedEngine(value: unknown): AgentProvider | null | undefined {
  if (value === undefined) return undefined;
  return requestedEngine(value);
}

/**
 * Resolve a task write's engine, provider and model pins (§3.5) against what the task holds now
 * (`current`; null for a new task). Each field is three-state — absent leaves it, null clears it, a
 * value sets it — and the two pins are written together by these rules:
 *
 *  - engine + provider: checked compatible, both written.
 *  - provider alone: the provider and its default engine — an older client re-pinning a provider gets
 *    the engine that provider ran on before the split.
 *  - engine alone: the engine; the provider pin is kept, and checked when there is one.
 *  - `provider: null` clears only the provider pin, `engine: null` only the engine pin.
 *
 * A provider is resolved as a new session's is (classifyProvider, in the pin door's words): a retired
 * name is stored as its key, the built-in `dsh` as the default DeepSeek key, and an old OpenCode model
 * naming a key (`provider: opencode`, `model: orbit-<slug>/<model>`) as that key on OpenCode. The model
 * is otherwise stored as asked: dispatch fits it to the engine's model space.
 */
export async function resolveTaskPin(
  deps: EngineProviderDeps,
  ownerId: string,
  request: { engine?: unknown; provider?: string | null; model?: string | null },
  current: { engine: string | null; provider: string | null } | null,
): Promise<TaskPinWrite> {
  let engine = pinnedEngine(request.engine);
  let provider = request.provider === '' ? null : request.provider;
  let model = request.model;
  const out: TaskPinWrite = {};
  // An old OpenCode pin names its key in the model.
  const encoded = model !== undefined
    ? openCodeEncoded(provider === undefined ? current?.provider : provider, model)
    : null;
  if (encoded) {
    if (engine && engine !== AgentProvider.OPENCODE) {
      throw engineIncompatible(AgentProvider.OPENCODE, engine, [AgentProvider.OPENCODE]);
    }
    const credential = await openCodeEncodedKey(deps, ownerId, encoded.slug);
    assertCompatible(AgentProvider.OPENCODE, credential, encoded.slug);
    return { engine: AgentProvider.OPENCODE, provider: storedSlug(credential).provider, model: encoded.model };
  }
  if (model !== undefined) out.model = model;
  if (typeof provider === 'string') {
    const credential = await classifyProvider(deps, ownerId, provider, 'pin');
    if (credential.kind === 'legacy-dsh') {
      // The built-in dsh is DeepSeek Harness on the default DeepSeek key, for a pin as for a session.
      if (engine && engine !== AgentProvider.DSH) throw engineIncompatible(provider, engine, [AgentProvider.DSH]);
      const row = await defaultDeepSeekKey(deps.db, ownerId);
      if (!row) throw deepSeekKeyRequired();
      return { ...out, engine: AgentProvider.DSH, provider: row.slug };
    }
    const resolved = engine ?? (engine === null ? null : defaultEngine(credential, provider));
    if (resolved) assertCompatible(resolved, credential, provider);
    return { ...out, engine: resolved, provider: storedSlug(credential).provider };
  }
  if (provider === null) out.provider = null;
  if (engine === undefined) return out;
  out.engine = engine;
  // An engine alone keeps the provider pin, which has to run on it.
  const kept = provider === null ? null : current?.provider ?? null;
  if (engine && kept) {
    const credential = await taskPinCredential(deps.db, ownerId, kept);
    if (credential) assertCompatible(engine, credential, kept);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Dispatch (§4.1): the key a session's credential spends when its run is built.
// ---------------------------------------------------------------------------------------------------

/** Whether a workspace's own environment carries the key a legacy built-in `dsh` session runs on. */
export function workspaceHoldsDshKey(env: unknown): boolean {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  const key = (env as Record<string, unknown>).ORBIT_DSH_API_KEY;
  return typeof key === 'string' && key.trim() !== '';
}

/**
 * The key a session's credential spends when its run is built (docs/provider-engine-contract.md §4.1):
 * the owner's (or, for an admin, a shared) key of its slug — disabled ones included, which dispatch
 * refuses in its own words — else the key a retired name of it resolves to; and for a legacy built-in
 * `dsh` session, the owner's default DeepSeek key, unless its workspace's own environment carries the
 * key it has always run on (§3.3: that one is never replaced). Null for an engine's own sign-in,
 * OpenCode's own configuration, a legacy `dsh` session on its workspace's key or with no DeepSeek key
 * to run on (it fails on the runner as it always did), and a slug no key answers — an account pool,
 * which the claim resolves to a member, or nothing at all.
 */
export async function dispatchKeyRow(
  db: Prisma.TransactionClient,
  session: { ownerId: string; provider: string | null; providerBuiltin: boolean | null },
  workspaceEnv: unknown,
): Promise<KeyRow | null> {
  const slug = session.provider;
  if (!slug) return null;
  if (!isBuiltinProvider(slug, session.providerBuiltin ?? true)) return keyRowForSlug(db, session.ownerId, slug);
  if (slug !== AgentProvider.DSH || workspaceHoldsDshKey(workspaceEnv)) return null;
  return defaultDeepSeekKey(db, session.ownerId);
}

// ---------------------------------------------------------------------------------------------------
// Preferences (§3.5, §6.5): the model last picked per (engine, provider), `User.preferences.defaultModels`.
// ---------------------------------------------------------------------------------------------------

/** The key a model picked for `engine` on `provider` is remembered under. */
export function defaultModelKey(engine: string, provider: string): string {
  return `${engine}:${provider}`;
}

/**
 * The entries a `defaultModels` PATCH writes. A key in the new form, `<engine>:<provider>`, has to name
 * a pair that can run — refused otherwise, ENGINE_UNKNOWN or PROVIDER_ENGINE_INCOMPATIBLE — and is
 * stored under the provider's own slug (a retired name is its key's). A key an older client writes in
 * the old form is stored exactly as written, so that client reads its own choice back, and is mirrored
 * under the new key it means: a bare slug on the engine it runs on by default, `opencode/<slug>` (whose
 * value is `orbit-<slug>/<model>`) and an `opencode` entry naming a key as that key on OpenCode with the
 * bare model, any other `opencode` entry as OpenCode's own configuration. An old key nothing resolves
 * is kept and mirrored nowhere: an older client is never refused for what it remembers.
 */
export async function normalizeDefaultModels(
  db: Prisma.TransactionClient,
  ownerId: string,
  entries: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const mirrors: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    const colon = key.indexOf(':');
    if (colon >= 0) {
      const engine = requestedEngine(key.slice(0, colon));
      const slug = key.slice(colon + 1);
      if (!engine) throw engineUnknown(key.slice(0, colon));
      const credential = slug ? await taskPinCredential(db, ownerId, slug) : null;
      if (!credential) throw new BadRequestException(`provider not available: "${slug}"`);
      assertCompatible(engine, credential, slug);
      out[defaultModelKey(engine, storedSlugOrDefault(credential, slug))] = value;
      continue;
    }
    out[key] = value;
    const mirror = await mirrorOldDefaultModel(db, ownerId, key, value);
    if (mirror) mirrors[mirror.key] = mirror.value;
  }
  // A new key the same PATCH names itself wins over one mirrored from an old key.
  return { ...mirrors, ...out };
}

/** A key's own slug for a resolved credential; the legacy built-in `dsh` keeps its name. */
function storedSlugOrDefault(credential: ResolvedCredential, slug: string): string {
  return credential.kind === 'legacy-dsh' ? slug : storedSlug(credential).provider;
}

async function mirrorOldDefaultModel(
  db: Prisma.TransactionClient,
  ownerId: string,
  key: string,
  value: string,
): Promise<{ key: string; value: string } | null> {
  const onKey = async (slug: string, model: string) => {
    const credential = await taskPinCredential(db, ownerId, slug);
    if (credential?.kind !== 'key' || !resolvedCredentialEngines(credential).includes(AgentProvider.OPENCODE)) return null;
    return { key: defaultModelKey(AgentProvider.OPENCODE, credential.slug), value: model };
  };
  if (key.startsWith(`${AgentProvider.OPENCODE}/`)) {
    const slug = key.slice(AgentProvider.OPENCODE.length + 1);
    const named = openCodeKeyOf(value);
    return named && named.slug === slug ? onKey(slug, named.model) : null;
  }
  if (key === AgentProvider.OPENCODE) {
    const named = openCodeKeyOf(value);
    return named
      ? onKey(named.slug, named.model)
      : { key: defaultModelKey(AgentProvider.OPENCODE, AgentProvider.OPENCODE), value };
  }
  const credential = await taskPinCredential(db, ownerId, key);
  if (!credential) return null;
  if (credential.kind === 'legacy-dsh') {
    const row = await defaultDeepSeekKey(db, ownerId);
    return row ? { key: defaultModelKey(AgentProvider.DSH, row.slug), value } : null;
  }
  const engine = credential.kind === 'key' && credential.alias
    ? credential.alias.engine
    : resolvedCredentialEngines(credential)[0];
  return engine ? { key: defaultModelKey(engine, storedSlug(credential).provider), value } : null;
}
