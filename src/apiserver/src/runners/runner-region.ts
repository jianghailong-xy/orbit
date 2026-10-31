import {
  CLAUDE_REGION_CARRY_OVER_MS,
  CLAUDE_REGION_UNSUPPORTED,
  CLAUDE_REGION_V1,
  CLAUDE_REGIONS_AS_OF,
  claudeRegionRefusedError,
  effectiveRegionVerdict,
  regionVerdictFor,
  type ClaudeRegionCheckRequest,
  type ClaudeRegionCheckResponse,
  type AnthropicBoundCredential,
  type ClaudeRegionRefusal,
  type RunnerRegion,
  type RunnerRegionView,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { ResolvedCredential } from '../providers/engine-provider';

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

/**
 * How every region sentence on `session.error` begins (§9, §10): the refused turn's and the stopped turn's alike. The
 * claim clears an error that starts so (QueueService.trySessionClaim), as it clears every other hold's.
 */
export const CLAUDE_REGION_ERROR_PREFIX = `${CLAUDE_REGION_UNSUPPORTED}: `;

/** Whether `error` is one of the region sentences (§9, §10). Clients read the place from runner.region; the server
 *  reads only the code in front of the sentence. */
export function isClaudeRegionError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.startsWith(CLAUDE_REGION_ERROR_PREFIX);
}

/** {machine} in the sentences the server writes (§9, §12, the push): the runner as Orbit names it. */
export function regionMachineName(runner: { name: string; displayName?: string | null }): string {
  return runner.displayName?.trim() || runner.name;
}

/** What the server's region rules read of a runner: its name, its stored row and what its last heartbeat declared. */
export interface RegionGatedRunner {
  name: string;
  displayName?: string | null;
  region: unknown;
  capabilities?: readonly string[] | null;
}

/**
 * The decided row behind a runner's blocked effective verdict (§5), or null when the runner gates nothing: it does not
 * declare claude-region/v1 (⑤), no check has decided, the row is allowed, or its blocked verdict is 24 hours old.
 */
export function blockedRunnerRegion(runner: Omit<RegionGatedRunner, 'name'>, now: Date): RunnerRegion | null {
  if (!runner.capabilities?.includes(CLAUDE_REGION_V1)) return null;
  const region = parseRunnerRegion(runner.region);
  return region && effectiveRegionVerdict(region, now) === 'blocked' ? region : null;
}

/**
 * Why the claim holds an Anthropic-bound Claude session on `runner` (§8, §11), or null when it takes it. The caller
 * has judged the session's engine and credential; this judges the runner.
 *
 *   - The runner's effective verdict is blocked: board 04's refusal sentence (claudeRegionRefusedError), naming the
 *     runner and the decided place.
 *   - The runner refused the claim that last took the session (`region_refused`, §10) while its row reads allowed: the
 *     sentence it refused with, until a check newer than that claim reaches the route, and for no longer than the
 *     carry-over (③). The runner refuses only on an answer the route gave it a minute ago, so its row reads blocked
 *     whenever it refuses unless another check came in between — one through another account's proxy, which the
 *     runner keeps a verdict of its own for. Without this, that disagreement would be a claim and a refusal as fast as
 *     the runner can make them, until its own answer aged; with it, a refused session is tried again once per check.
 *
 * Holds nothing on a runner that does not declare claude-region/v1 (⑤).
 */
export function claudeRegionHold(
  runner: RegionGatedRunner,
  session: { error: string | null; runClaimedAt: Date | null },
  now: Date,
): string | null {
  if (!runner.capabilities?.includes(CLAUDE_REGION_V1)) return null;
  const region = parseRunnerRegion(runner.region);
  if (region && effectiveRegionVerdict(region, now) === 'blocked') {
    return claudeRegionRefusedError(regionMachineName(runner), region.name);
  }
  const claimed = session.runClaimedAt?.getTime();
  const refused = isClaudeRegionError(session.error) && claimed !== undefined
    && now.getTime() - claimed < CLAUDE_REGION_CARRY_OVER_MS;
  if (!refused) return null;
  // No check has reached the route since the claim the runner refused.
  return !region || Date.parse(region.checkedAt) <= claimed ? session.error : null;
}

/** What credentialIsAnthropicBound reads of a credential a door resolved (§8): a key by its preset and endpoint, the
 *  built-in DeepSeek Harness slug as the DeepSeek key it is. */
export function regionCredentialOf(credential: ResolvedCredential): AnthropicBoundCredential {
  switch (credential.kind) {
    case 'key':
      return { kind: 'key', presetSlug: credential.row.presetSlug ?? null, baseUrl: credential.row.baseUrl };
    case 'legacy-dsh':
      return { kind: 'key', presetSlug: null, baseUrl: null };
    default:
      return credential;
  }
}

/** Board 04's "new session 409" sentence (§12). */
export function claudeRegionCreateRefusalMessage(machine: string, region: string): string {
  return `Claude Code can’t use Anthropic on ${machine}: its connection is in ${region}, where Anthropic doesn’t offer Claude. Pick a key from another provider, or a workspace on another machine.`;
}

/** Board 04's "sign-in refused" sentence (§12), which the runner refuses `claude auth login` with as well. */
export function claudeRegionSignInRefusal(machine: string, region: string): string {
  return `Claude sign-in isn’t available on ${machine}: its connection to Anthropic is in ${region}, where Anthropic doesn’t offer Claude.`;
}

/** Board 04's push (flip) sentence (§10). */
export function claudeRegionPushBody(machine: string, region: string): string {
  return `Claude Code can’t use Anthropic on ${machine} — its connection is now in ${region}. Sessions on Anthropic accounts or keys there wait until you switch provider or move them.`;
}

/** The 409 body of a create refused for the region (§12, ClaudeRegionRefusal), or null when `runner` gates nothing. */
export function claudeRegionCreateRefusal(
  runner: RegionGatedRunner,
  runnerId: string,
  now: Date,
): ClaudeRegionRefusal | null {
  const region = blockedRunnerRegion(runner, now);
  if (!region) return null;
  return {
    code: CLAUDE_REGION_UNSUPPORTED,
    message: claudeRegionCreateRefusalMessage(regionMachineName(runner), region.name),
    runnerId,
  };
}

/**
 * Whether a check is the confirmed flip the push announces (§10, board 04 "push (flip)"): a blocked answer that took
 * blockedChecks to 2, read off the row recordRegionCheck answered for it. blockedChecks counts consecutive blocked
 * answers and an allowed one resets it, so a run of them reaches 2 once; recordRegionCheck counts in one statement, so
 * two checks arriving together cannot both read 2; and an unknown answer leaves the count where it was, so it is never
 * the flip, even right after one. One blocked check alone is not a flip.
 */
export function regionFlipConfirmed(verdict: ClaudeRegionCheckResponse['verdict'], region: RunnerRegion | null): boolean {
  return verdict === 'blocked' && region?.verdict === 'blocked' && region.blockedChecks === 2;
}
