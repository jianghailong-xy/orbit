import { Prisma } from '@prisma/client';

/**
 * Whether an account has smart model selection on (Settings → Smart model selection): the master
 * switch over the whole feature (docs/model-routing-design.md).
 *
 * Off, and the feature is as if it did not exist: a coordinator's standing instructions say nothing
 * about suggesting a tier, a task's fresh run records no Route Decision and is dispatched exactly as
 * before routing — whatever its Agent's own switch (`workspace.modelRouting`) says — and the sweep's
 * quota gate judges the engine the run's pins give it. On, and each Agent's own switch decides as
 * before. Nothing is cleared by turning it off: a task's suggestion and an Agent's switch and engines
 * are kept, so turning it back on restores them.
 *
 * Off unless the owner turned it on — the opposite of the orchestration and notification switches,
 * so only turning it on is ever written. `owner` is the row's own read, null when there is none.
 */
export function modelRoutingEnabled(owner: { preferences: unknown } | null): boolean {
  const prefs = (owner?.preferences ?? {}) as { modelRouting?: unknown };
  return prefs.modelRouting === true;
}

/**
 * The same switch read in SQL, for a scan that wants it beside its rows rather than as a query of
 * its own: `ownerId` names the column holding the account's id. Exactly `modelRoutingEnabled` —
 * the JSON value `true` and nothing else.
 */
export function modelRoutingEnabledSql(ownerId: string): Prisma.Sql {
  return Prisma.sql`COALESCE((
    SELECT u.preferences -> 'modelRouting' = 'true'::jsonb FROM "user" u WHERE u.id = ${Prisma.raw(ownerId)}
  ), false)`;
}
