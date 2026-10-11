/**
 * When each of an owner's keys last did work — the "Last used" column of the keys table
 * (GET /providers/mine). The sibling of readKeyUsage, and the difference is the tense: that read
 * answers "what is using this key right now" (the delete and edit dialogs), this one "when did
 * anything last use it", over all of the key's history.
 *
 * A key counts as used when a session RAN on it: the clock is `session.last_turn_at`, which moves
 * with every turn the session takes (runner-api event ingest, and createTurn/resume) and is null
 * until the first one — so a session created but never run does not count, and a key nobody has
 * spent reads as no entry. The column does not decay: a deleted session's rows still count, because
 * the key WAS spent then.
 *
 * Sessions match a key the ways a claim reaches it:
 *  - by the key's own slug (`provider` = slug with `provider_builtin` false — a personal key may
 *    legitimately be slugged `kimi`/`dsh`, and the rows of those slugs that ARE the built-in
 *    engines are not this key), or
 *  - through one of the owner's own account pools (`pool_member_provider_id` = the key, while the
 *    session's `provider` is still one of those pools' slugs — runningMemberIds' rule, so a
 *    session switched off the pool stops crediting the member it left), or
 *  - in the retired OpenCode encoding (`provider` 'opencode' with the model `orbit-<slug>/<model>`),
 *    which readKeyUsage also still counts — one of those rows can be running today.
 *
 * Deliberate divergences from readKeyUsage, so neither read looks like a bug of the other: task
 * pins do not count (a pin names a key but spends nothing), and a retired SLUG does not travel to
 * the key it was folded into (readKeyUsage has that same gap, and a claim rewrites the row soon
 * enough).
 *
 * One owner-scoped read per rule, three fixed queries for the whole list — cheaper than the
 * per-key usage() read the delete dialog already makes, and no index beyond the owner's: not
 * worth a migration on the hottest table for a display column.
 */
import { Prisma } from '@prisma/client';
import { AgentProvider, openCodeKeyOf } from '@orbit/shared';

/** How a session on a configured key names it in its model: `<prefix><slug>/<model>`
 *  (@orbit/shared openCodeKeys, `KEY_PREFIX`), the filter whose parse is openCodeKeyOf. */
const OPEN_CODE_PREFIX = 'orbit-';

export async function readLastUsed(
  db: Pick<Prisma.TransactionClient, 'session' | 'providerPool'>,
  ownerId: string,
  keys: Array<{ id: string; slug: string }>,
): Promise<Map<string, Date>> {
  const used = new Map<string, Date>();
  if (keys.length === 0) return used;
  const bySlug = new Map(keys.map((key) => [key.slug, key.id]));
  const newer = (id: string | null | undefined, at: Date | null) => {
    if (!id || !at) return;
    const held = used.get(id);
    if (!held || at > held) used.set(id, at);
  };

  const direct = await db.session.groupBy({
    by: ['provider'],
    where: {
      ownerId,
      providerBuiltin: false,
      provider: { in: keys.map((key) => key.slug) },
      lastTurnAt: { not: null },
    },
    _max: { lastTurnAt: true },
  });
  for (const row of direct) newer(bySlug.get(row.provider), row._max.lastTurnAt);

  const pools = await db.providerPool.findMany({ where: { ownerId, shared: false }, select: { slug: true } });
  if (pools.length > 0) {
    const throughPools = await db.session.groupBy({
      by: ['poolMemberProviderId'],
      where: {
        ownerId,
        provider: { in: pools.map((pool) => pool.slug) },
        poolMemberProviderId: { in: keys.map((key) => key.id) },
        lastTurnAt: { not: null },
      },
      _max: { lastTurnAt: true },
    });
    for (const row of throughPools) newer(row.poolMemberProviderId, row._max.lastTurnAt);
  }

  const encoded = await db.session.groupBy({
    by: ['model'],
    where: {
      ownerId,
      provider: AgentProvider.OPENCODE,
      model: { startsWith: OPEN_CODE_PREFIX },
      lastTurnAt: { not: null },
    },
    _max: { lastTurnAt: true },
  });
  for (const row of encoded) {
    const named = openCodeKeyOf(row.model);
    newer(named ? bySlug.get(named.slug) : null, row._max.lastTurnAt);
  }

  return used;
}
