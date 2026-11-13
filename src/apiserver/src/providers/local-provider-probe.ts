import { Prisma } from '@prisma/client';
import {
  isCloudModelId,
  LOCAL_PROBE_MAX_TARGETS,
  sanitizeLocalProviderProbe,
  type LocalProviderTarget,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The runner's probe of its local model servers, on the heartbeat (docs/ollama-local-provider-contract.md §6).
 *
 * The control plane never reaches a local endpoint itself: it hands each runner the runner-scoped providers bound
 * to it (localProviderTargets, the heartbeat answer's `localProviders`), and stores what that runner reports
 * (localProviderProbesSql, the heartbeat body's `localProviderProbes`). A report is kept only on a row that is
 * runner-scoped, bound to the reporting runner, owned by that runner's owner, and still pointed at the endpoint the
 * runner probed: a runner cannot write another runner's provider, another account's, or one that has moved on.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** At most this many model names a target carries. */
const MAX_TARGET_MODELS = 50;

/** The models a row names, to be checked on its server: its list and its default, no cloud model, each once. */
export function targetModels(models: unknown, defaultModel: string | null): string[] {
  const names = [
    ...(Array.isArray(models) ? models.map((m) => (m as { value?: unknown } | null)?.value) : []),
    defaultModel,
  ];
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const value = name.trim();
    if (!value || value.length > 200 || isCloudModelId(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length >= MAX_TARGET_MODELS) break;
  }
  return out;
}

/** The runner-scoped providers bound to `runnerId` that the runner should probe: enabled, and its owner's own. */
export async function localProviderTargets(
  prisma: Pick<PrismaService, 'modelProvider'>,
  runnerId: string,
): Promise<LocalProviderTarget[]> {
  const rows = await prisma.modelProvider.findMany({
    where: { runnerId, scope: 'runner', enabled: true },
    select: { id: true, ownerId: true, baseUrl: true, models: true, defaultModel: true, runner: { select: { ownerId: true } } },
    orderBy: { createdAt: 'asc' },
    take: LOCAL_PROBE_MAX_TARGETS,
  });
  return rows
    .filter((row) => row.ownerId !== null && row.runner?.ownerId === row.ownerId)
    .map((row) => ({ providerId: row.id, baseUrl: row.baseUrl, models: targetModels(row.models, row.defaultModel) }));
}

/**
 * The probes a runner reported, as one UPDATE of the rows they may land on; null when none is well formed. Each
 * report is sanitized first (sanitizeLocalProviderProbe): an unknown state, a missing id or endpoint drops it; the
 * catalogue keeps well-formed names and bounded fields only. `probed_at` is the runner's own checkedAt, never later
 * than now, so a report sent again unchanged does not make an old probe look fresh (STALE reads it). A report that
 * carried no catalogue keeps the stored one.
 */
export function localProviderProbesSql(runnerId: string, probes: readonly unknown[], after: Prisma.Sql = Prisma.sql`true`): Prisma.Sql | null {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of probes.slice(0, LOCAL_PROBE_MAX_TARGETS)) {
    const probe = sanitizeLocalProviderProbe(entry);
    if (!probe || !UUID_RE.test(probe.providerId)) continue;
    const id = probe.providerId.toLowerCase();
    byId.set(id, {
      providerId: id,
      baseUrl: probe.baseUrl,
      state: probe.state,
      version: probe.version,
      reason: probe.reason,
      latencyMs: probe.latencyMs,
      checkedAt: probe.checkedAt?.toISOString() ?? null,
      modelsGiven: probe.models !== null,
      models: probe.models ?? [],
    });
  }
  if (byId.size === 0) return null;
  const rows = [...byId.values()].sort((a, b) => String(a.providerId).localeCompare(String(b.providerId)));
  return Prisma.sql`
    UPDATE "model_provider" p
       SET "probe_state" = v."state",
           "probe_version" = v."version",
           "probe_message" = v."reason",
           "probe_latency_ms" = v."latencyMs",
           "probed_at" = LEAST(COALESCE(v."checkedAt", now()), now()),
           "instance_models" = CASE WHEN v."modelsGiven" THEN v."models" ELSE p."instance_models" END
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(
             "providerId" uuid, "baseUrl" text, "state" text, "version" text, "reason" text, "latencyMs" integer,
             "checkedAt" timestamptz, "modelsGiven" boolean, "models" jsonb),
           "runner" r
     WHERE p."id" = v."providerId"
       AND p."runner_id" = ${runnerId}::uuid
       AND p."scope" = 'runner'
       AND p."base_url" = v."baseUrl"
       AND r."id" = p."runner_id"
       AND r."owner_id" = p."owner_id"
       AND ${after}
    RETURNING 1`;
}

/** Store a runner's probes (the heartbeat route's write); how many rows they landed on. */
export async function storeLocalProviderProbes(
  prisma: Pick<PrismaService, '$queryRaw'>,
  runnerId: string,
  probes: readonly unknown[],
): Promise<number> {
  const sql = localProviderProbesSql(runnerId, probes);
  if (!sql) return 0;
  const rows = await prisma.$queryRaw<unknown[]>(sql);
  return rows.length;
}
