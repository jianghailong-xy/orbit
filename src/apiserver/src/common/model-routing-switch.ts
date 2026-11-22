import { Prisma } from '@prisma/client';

/**
 * Whether an account has smart model selection on (Settings → Smart model selection): the master
 * switch over the whole feature (docs/model-routing-design.md).
 *
 * Off, and the feature is as if it did not exist: a coordinator's standing instructions say nothing
 * about suggesting a tier, a task's fresh run records no Route Decision and is dispatched exactly as
 * before routing, a SubAgent runs on its parent's model, and the sweep's quota gate judges the engine
 * the run's pins give it. On, and every task run on every Agent is routed: there is no per-Agent
 * switch (owner, 2026-11-20; `workspace.modelRouting` is no longer read). Nothing is cleared by
 * turning it off: a task's suggestion is kept, so turning it back on restores it.
 *
 * On unless the owner turned it off (owner, 2026-11-20): an account that never wrote it reads on, like
 * the orchestration and notification switches. `owner` is the row's own read, null when there is none,
 * which reads off.
 */
export function modelRoutingEnabled(owner: { preferences: unknown } | null): boolean {
  if (!owner) return false;
  const prefs = (owner.preferences ?? {}) as { modelRouting?: unknown };
  return prefs.modelRouting !== false;
}

/**
 * The account's Optimize For (owner, 2026-11-19): one for every Agent, SubAgents and smart-selected task runs
 * alike. Absent, or anything else, is Balance. The per-Agent column (workspace.model_routing_optimize_for)
 * is no longer read.
 */
export function optimizeForOf(owner: { preferences: unknown } | null): 'cost' | 'balance' | 'intelligence' {
  const value = ((owner?.preferences ?? {}) as { optimizeFor?: unknown }).optimizeFor;
  return value === 'cost' || value === 'intelligence' ? value : 'balance';
}

/**
 * The same switch read in SQL, for a scan that wants it beside its rows rather than as a query of
 * its own: `ownerId` names the column holding the account's id. Exactly `modelRoutingEnabled` —
 * anything but the JSON value `false` is on; no account row is off.
 */
export function modelRoutingEnabledSql(ownerId: string): Prisma.Sql {
  return Prisma.sql`COALESCE((
    SELECT COALESCE(u.preferences -> 'modelRouting' <> 'false'::jsonb, true) FROM "user" u WHERE u.id = ${Prisma.raw(ownerId)}
  ), false)`;
}
