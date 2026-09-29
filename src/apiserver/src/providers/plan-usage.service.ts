import { Injectable, Logger } from '@nestjs/common';
import { RunEventType, type PlanUsageSnapshot } from '@orbit/shared';
import { RealtimeService } from '../realtime/realtime.service';
import {
  OAUTH_USAGE_BETA,
  OAUTH_USAGE_URL,
  parseSubscriptionUsage,
  probesSubscriptionUsage,
  usageErrorMessage,
  usageFailureKind,
  type UsageFailureKind,
} from './plan-usage';
import { decryptSecret } from './provider-crypto';

/** How long a good snapshot is served before the next read refreshes it. Matches the cadence a
 *  runner polls its own login at, which is what the same gauge shows for a built-in engine. */
const FRESH_MS = 2 * 60 * 1000;
/** A credential that failed for a reason outside itself (the endpoint was unreachable, or answered
 *  with a server error) is retried, just far more slowly. */
const RETRY_MS = 10 * 60 * 1000;
/** A credential the endpoint turned away is never asked again, whichever way it turned it away
 *  (usageFailureKind): both are a property of the credential — the wrong kind of token, or one minted
 *  without the `user:profile` scope — so no number of retries can change the answer, and each one is a
 *  request to Anthropic on the user's behalf. Saving a new key re-enables it: the cache is keyed by the
 *  stored ciphertext. */
const NEVER = Number.POSITIVE_INFINITY;
const FETCH_TIMEOUT_MS = 8000;

/** Why a fetch did not produce a snapshot, and whether asking again could ever help. */
interface UsageFailure {
  message: string;
  /** What the endpoint said about the credential (usageFailureKind), or null when the failure was
   *  outside it — the only kind asking again can change. */
  kind: UsageFailureKind | null;
}

interface Entry {
  usage: PlanUsageSnapshot | null;
  /** The ciphertext the snapshot was fetched with — a rotated key invalidates it immediately
   *  rather than serving the old account's numbers for up to FRESH_MS. */
  keyEnc: string;
  refreshAt: number;
  /** Last failure reason, so a repeated one is logged only once. */
  failure: string;
  /** What the last read ended in for this credential, null once one succeeds — refused by the
   *  endpoint, or readable only by a request this token is not scoped for. */
  standing: UsageFailureKind | null;
}

export interface UsageProviderRow {
  id: string;
  ownerId: string | null;
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
}

/**
 * Subscription quota per *credential*, for configured (BYOK) providers.
 *
 * Demand-driven rather than swept: a row is probed when something actually reads it (the picker
 * catalog), and a row nobody opens is never asked about. Reads never block on the network — the
 * cached value is returned immediately and the refresh runs behind it, publishing PROVIDER_CHANGED
 * when the numbers move so an open client picks them up without a reload.
 *
 * Everything here is best-effort: a provider that cannot answer (not Anthropic, a metered API key,
 * a token without the profile scope) simply has no quota to show, which is what the clients
 * rendered before any of this existed. A provider configured with an API key is never asked at all
 * — see probesSubscriptionUsage — and one the endpoint refuses is asked exactly once.
 */
@Injectable()
export class ProviderPlanUsageService {
  private readonly log = new Logger('ProviderPlanUsage');
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly realtime: RealtimeService) {}

  /** This row's cached quota, refreshing behind the response when it has gone stale. */
  snapshot(row: UsageProviderRow): PlanUsageSnapshot | null {
    const entry = this.cache.get(row.id);
    const rotated = entry && entry.keyEnc !== row.apiKeyEnc;
    if (rotated) this.cache.delete(row.id);
    if (rotated || !entry || Date.now() >= entry.refreshAt) void this.refresh(row);
    return rotated ? null : (entry?.usage ?? null);
  }

  /** What the last read of this row's quota ended in for the credential, or null when it produced one
   *  (or has yet to be tried). The two refusals are the ones usageFailureKind tells apart, and an
   *  account pool reads them differently: a key the endpoint refused is no member that can run, while a
   *  token it will not report on — a setup token without the profile scope — is a member whose quota is
   *  unknown, which the pool still runs on when nothing with a readable quota is left. A replaced key
   *  carries neither until the endpoint says so about it. */
  usageStanding(row: UsageProviderRow): UsageFailureKind | null {
    const entry = this.cache.get(row.id);
    return entry?.keyEnc === row.apiKeyEnc ? (entry.standing ?? null) : null;
  }

  /** Refresh this row's quota. Concurrent callers share the one request in flight — and get a
   *  promise that resolves when it lands, rather than one that resolves immediately. */
  refresh(row: UsageProviderRow): Promise<void> {
    const existing = this.inFlight.get(row.id);
    if (existing) return existing;
    const cached = this.cache.get(row.id);
    // Refused with this exact credential: asking again would send the same token to the same
    // endpoint for the same answer.
    if (cached?.keyEnc === row.apiKeyEnc && cached.refreshAt === NEVER) return Promise.resolve();
    // Never rejects: callers fire this behind a response and would otherwise leave an unhandled
    // rejection behind.
    const run = this.fetchInto(row)
      .catch((e: unknown) => this.log.warn(`provider ${row.id} usage refresh failed: ${String(e)}`))
      .finally(() => this.inFlight.delete(row.id));
    this.inFlight.set(row.id, run);
    return run;
  }

  private async fetchInto(row: UsageProviderRow): Promise<void> {
    let apiKey: string;
    try {
      apiKey = decryptSecret(row.apiKeyEnc);
    } catch {
      // A row whose key predates the current PROVIDER_SECRET_KEY can't be read here; its
      // sessions surface that on their own.
      return;
    }
    if (!probesSubscriptionUsage(row, apiKey)) return;
    const previous = this.cache.get(row.id);
    const result = await this.fetchUsage(apiKey);
    if (result && 'message' in result) {
      // Keep the last good numbers through a blip, exactly as the runner probe does; only the
      // retry clock moves — or stops, when the endpoint turned the credential away.
      if (previous?.failure !== result.message) {
        this.log.warn(
          `provider ${row.id} usage unavailable: ${result.message}` +
            (result.kind ? ' — not asking again with this key' : ''),
        );
      }
      this.cache.set(row.id, {
        usage: previous?.usage ?? null,
        keyEnc: row.apiKeyEnc,
        refreshAt: result.kind ? NEVER : Date.now() + RETRY_MS,
        failure: result.message,
        standing: result.kind,
      });
      return;
    }
    if (previous?.failure) this.log.log(`provider ${row.id} usage recovered`);
    this.cache.set(row.id, {
      usage: result,
      keyEnc: row.apiKeyEnc,
      refreshAt: Date.now() + FRESH_MS,
      failure: '',
      standing: null,
    });
    // First fetch included: before it the client had no gauge at all, so this is the push that
    // makes one appear.
    if (JSON.stringify(previous?.usage ?? null) !== JSON.stringify(result)) this.publish(row);
  }

  /** The snapshot, or why there isn't one. */
  private async fetchUsage(apiKey: string): Promise<PlanUsageSnapshot | null | UsageFailure> {
    let resp: Response;
    try {
      resp = await fetch(OAUTH_USAGE_URL, {
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'anthropic-beta': OAUTH_USAGE_BETA,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = (e as Error).name === 'TimeoutError';
      return { message: timedOut ? 'timed out' : 'could not reach the endpoint', kind: null };
    }
    if (!resp.ok) {
      // Carry the endpoint's own words: the usual refusal here is a scope problem, and reading
      // `HTTP 403` alone sends you looking for a broken key instead.
      const detail = usageErrorMessage(await resp.text().catch(() => ''));
      return {
        message: `HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`,
        kind: usageFailureKind(resp.status, detail),
      };
    }
    try {
      return parseSubscriptionUsage(await resp.json(), new Date().toISOString());
    } catch {
      return { message: 'unreadable response', kind: null };
    }
  }

  /** Same channel a provider edit uses: the owner for a personal row, everyone for a shared one. */
  private publish(row: UsageProviderRow): void {
    if (row.ownerId) this.realtime.publishForUser(row.ownerId, RunEventType.PROVIDER_CHANGED, row.id);
    else this.realtime.publishForAllUsers(RunEventType.PROVIDER_CHANGED, row.id);
  }
}
