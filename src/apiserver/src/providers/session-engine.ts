/**
 * The engine a session runs on: the CLI on the runner that produced (or is about to produce) its
 * runtimeSessionId, recorded in `Session.engine` and never changed (docs/provider-engine-contract.md
 * §1.1). Its provider is only where the credential comes from, so nothing that asks "which CLI is
 * this?" reads the slug any more: it reads the column, and only a row the column has not reached yet
 * — one an older API replica wrote, or one the backfill could not settle — is derived, by the rules
 * dispatch followed before the split (§5.4).
 *
 * The derivation differs from the old one (execRuntime) in exactly one place: a key that is disabled
 * or out of the owner's reach still answers its row's runtime, and a key that is gone answers
 * nothing, where execRuntime answered Claude. That fallback is what moved a session onto another CLI
 * when its key was disabled or deleted; a session whose engine nobody can tell is not guessed at.
 */
import { AgentProvider, isEngine } from '@orbit/shared';
import { Prisma } from '@prisma/client';
import { accountPoolRuntime, builtinSessionEngine, keyRowEngine } from './custom-provider';

/** The fields the derivation reads off a session row. */
export interface SessionEngineFacts {
  engine?: string | null;
  provider: string | null;
  providerBuiltin?: boolean | null;
  ownerId: string;
}

/**
 * §5.4: the engine of a session whose column is NULL, or null when nobody can tell.
 *
 * 1–2. a built-in slug names itself (builtinSessionEngine);
 * 3. a key of the session's owner, or a shared one, disabled or not, whether or not the owner may
 *    use it: its row's runtime, when that is an engine;
 * 4. an account pool: the engine it was made on (accountPoolRuntime — one of the owner's own, or a
 *    Codex pool they are one of the people of);
 * 5. a retired provider name (provider_slug_alias, migration 0415): the engine the old slug ran on;
 * 6. anything else — a key that is gone — is unknown.
 */
export async function legacySessionEngine(
  db: Prisma.TransactionClient,
  session: SessionEngineFacts,
): Promise<AgentProvider | null> {
  const builtin = builtinSessionEngine(session.provider, session.providerBuiltin);
  if (builtin) return builtin;
  const slug = session.provider!;
  const row = await db.modelProvider.findFirst({
    where: { slug, OR: [{ ownerId: session.ownerId }, { ownerId: null }] },
    select: { runtime: true },
  });
  if (row) return keyRowEngine(row.runtime);
  const pooled = await accountPoolRuntime(db, session.ownerId, slug);
  if (pooled) return pooled;
  const alias = await db.providerSlugAlias.findUnique({ where: { slug }, select: { engine: true } });
  return recordedEngine(alias?.engine);
}

/**
 * The engine `session` runs on: its recorded one, else the derivation above (null = unknown). Every
 * runtime-shaped question about a session — dispatch, reclaim, reload, steer, move, meta, the reaper —
 * asks this, so none of them can disagree with the column.
 */
export async function sessionEngine(
  db: Prisma.TransactionClient,
  session: SessionEngineFacts,
): Promise<AgentProvider | null> {
  return recordedEngine(session.engine) ?? legacySessionEngine(db, session);
}

/** The column's value when it holds an engine, else null. */
export function recordedEngine(engine: string | null | undefined): AgentProvider | null {
  return isEngine(engine) ? engine : null;
}

/**
 * docs/provider-engine-contract.md §3.7 SESSION_ENGINE_UNKNOWN: a session that already ran — it has a
 * runtimeSessionId — whose engine was never recorded and whose credential is gone. Nothing can say
 * which CLI its conversation belongs to, and reattaching the id to another is worse than refusing.
 */
export const SESSION_ENGINE_UNKNOWN_MESSAGE =
  "this session's engine was never recorded and its provider is gone, so Orbit cannot tell which engine its conversation belongs to; start a new session";

/**
 * The engine every read reports for each of these sessions (docs/provider-engine-contract.md §6.1): the
 * recorded one, else the old rules' derivation, else null when nobody can tell. A row without one is
 * rare after the backfill — one an older replica wrote — and a page of them shares a few credentials,
 * so each derivation is asked once per credential.
 */
export async function sessionEnginesOf(
  db: Prisma.TransactionClient,
  sessions: Array<SessionEngineFacts & { id: string }>,
): Promise<Map<string, AgentProvider | null>> {
  const engines = new Map<string, AgentProvider | null>();
  const derived = new Map<string, Promise<AgentProvider | null>>();
  for (const session of sessions) {
    const recorded = recordedEngine(session.engine);
    if (recorded) {
      engines.set(session.id, recorded);
      continue;
    }
    const key = `${session.ownerId}\u0000${session.provider ?? ''}\u0000${session.providerBuiltin ? 1 : 0}`;
    if (!derived.has(key)) derived.set(key, legacySessionEngine(db, session));
    engines.set(session.id, await derived.get(key)!);
  }
  return engines;
}
