import {
  CLAUDE_REGION_V1,
  CLAUDE_REGIONS_AS_OF,
  effectiveRegionVerdict,
  regionVerdictFor,
  type ClaudeRegionCheckRequest,
  type ClaudeRegionCheckResponse,
  type RunnerRegion,
  type RunnerRegionView,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The Claude region check on the control plane (docs/claude-region-check-contract.md §3–§7): what one check answers,
 * how its result is kept in runner.region, what the runner list says of it, and how long the owner's Check again is
 * handed to the runner.
 *
 * The verdict comes only from Cloudflare's headers on a request a trusted proxy passed on (§3), decided against
 * @orbit/shared's list (claude-regions.ts). The runner carries no list of its own, so a change to Anthropic's list
 * ships with one server release. runner.region is written here alone (§4).
 */

/**
 * How long the owner's Check again is handed to a runner's heartbeats while no check answers it (§7). The runner checks
 * on its own every five minutes; a request two of those could not answer is one its checks cannot reach the route
 * with, and handing it on would only keep a link runner reconciling in full on every beat.
 */
export const REGION_CHECK_REQUEST_TTL_MS = 10 * 60_000;

/**
 * What GET /runner/region-check answers (§3). `trusted` says the request came through a proxy TRUSTED_PROXIES names
 * (public-surface.guard.ts cameThroughTrustedProxy), so CF-IPCountry and cf-region-code are Cloudflare's; from any
 * other request they are the client's own words, and the answer is unknown. Cloudflare's XX and T1, and anything that
 * names no country, are unknown too (regionVerdictFor).
 */
export function regionCheckAnswer(input: {
  trusted: boolean;
  country: string | string[] | undefined;
  regionCode: string | string[] | undefined;
  viaProxy: boolean;
}): ClaudeRegionCheckResponse {
  const result = input.trusted ? regionVerdictFor(single(input.country), single(input.regionCode)) : regionVerdictFor(null);
  return { ...result, viaProxy: input.viaProxy, asOf: CLAUDE_REGIONS_AS_OF };
}

/** A header given more than once is no single statement of where the request came from. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** runner.region as stored, or null for none and for anything that is not a RunnerRegion: only a decided check keeps
 *  one (§4). */
export function parseRunnerRegion(value: unknown): RunnerRegion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.verdict !== 'allowed' && r.verdict !== 'blocked') return null;
  if (typeof r.country !== 'string' || typeof r.name !== 'string' || typeof r.viaProxy !== 'boolean') return null;
  if (r.regionCode !== null && typeof r.regionCode !== 'string') return null;
  if (typeof r.decidedAt !== 'string' || typeof r.checkedAt !== 'string') return null;
  if (typeof r.blockedChecks !== 'number' || !Number.isInteger(r.blockedChecks) || r.blockedChecks < 0) return null;
  return {
    verdict: r.verdict,
    country: r.country,
    regionCode: r.regionCode,
    name: r.name,
    viaProxy: r.viaProxy,
    decidedAt: r.decidedAt,
    checkedAt: r.checkedAt,
    blockedChecks: r.blockedChecks,
  };
}

/**
 * `region` on GET /runners and GET /runners/:id (§6): the effective verdict (§5, effectiveRegionVerdict) beside the
 * stored row's place and the time of its last check. null for a runner that does not declare claude-region/v1, which
 * has no effective verdict and is never gated, and for one no check has decided yet. `capabilities` is what the
 * runner's latest heartbeat declared (runner.capabilities).
 */
export function runnerRegionView(
  runner: { region: unknown; capabilities: readonly string[] | null | undefined },
  now: Date,
): RunnerRegionView | null {
  if (!runner.capabilities?.includes(CLAUDE_REGION_V1)) return null;
  const region = parseRunnerRegion(runner.region);
  if (!region) return null;
  return {
    verdict: effectiveRegionVerdict(region, now),
    country: region.country,
    regionCode: region.regionCode,
    name: region.name,
    viaProxy: region.viaProxy,
    checkedAt: region.checkedAt,
  };
}

/**
 * The Check again a heartbeat hands over (§7): `{ requestedAt }` while the owner's request waits for a check, until
 * REGION_CHECK_REQUEST_TTL_MS has passed. The check route clears the request (recordRegionCheck).
 */
export function regionCheckRequestOf(requestedAt: Date | null | undefined, now: Date): ClaudeRegionCheckRequest | undefined {
  if (!requestedAt || now.getTime() - requestedAt.getTime() > REGION_CHECK_REQUEST_TTL_MS) return undefined;
  return { requestedAt: requestedAt.toISOString() };
}

/**
 * Keeps one check's answer in runner.region (§4), in one statement, so two checks arriving together are both counted:
 *
 *   - a decided answer (allowed, blocked) replaces verdict, country, regionCode, name, viaProxy and decidedAt, and
 *     moves checkedAt; blockedChecks counts consecutive blocked answers, and an allowed one resets it;
 *   - an unknown answer moves checkedAt alone, and writes nothing where no check has decided yet.
 *
 * The row is built from the answer's fields alone, so it holds those eight and nothing else: no address, no header.
 * The same statement clears the owner's Check again when this check came at or after it (§7), whatever it answered.
 * Answers the row as it now stands, or null where none is kept.
 */
export async function recordRegionCheck(
  prisma: Pick<PrismaService, '$queryRaw'>,
  runnerId: string,
  answer: Pick<ClaudeRegionCheckResponse, 'verdict' | 'country' | 'regionCode' | 'name' | 'viaProxy'>,
  now: Date,
): Promise<RunnerRegion | null> {
  const at = now.toISOString();
  const decided = answer.verdict === 'unknown'
    ? null
    : JSON.stringify({
        verdict: answer.verdict,
        country: answer.country,
        regionCode: answer.regionCode,
        name: answer.name,
        viaProxy: answer.viaProxy,
        decidedAt: at,
        checkedAt: at,
      });
  // The stored count, or none: a row written before blockedChecks, or by hand, counts from nothing.
  const rows = await prisma.$queryRaw<Array<{ region: unknown }>>`
    UPDATE "runner" r
       SET "region" = CASE
             WHEN ${decided}::jsonb IS NOT NULL THEN ${decided}::jsonb || jsonb_build_object('blockedChecks',
               CASE
                 WHEN ${answer.verdict}::text <> 'blocked' THEN 0
                 WHEN jsonb_typeof(r."region" -> 'blockedChecks') = 'number' THEN (r."region" ->> 'blockedChecks')::int + 1
                 ELSE 1
               END)
             WHEN jsonb_typeof(r."region") = 'object' THEN jsonb_set(r."region", '{checkedAt}', to_jsonb(${at}::text))
           END,
           "region_check_requested_at" = CASE
             WHEN r."region_check_requested_at" <= ${at}::timestamp(3) THEN NULL
             ELSE r."region_check_requested_at"
           END
     WHERE r."id" = ${runnerId}::uuid
       AND (${decided}::jsonb IS NOT NULL
         OR jsonb_typeof(r."region") = 'object'
         OR r."region_check_requested_at" <= ${at}::timestamp(3))
    RETURNING r."region"`;
  return parseRunnerRegion(rows[0]?.region);
}
