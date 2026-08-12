import { Injectable, Logger } from '@nestjs/common';
import { RunEventType, type PlanUsageSnapshot } from '@orbit/shared';
import { RealtimeService } from '../realtime/realtime.service';
import {
  OAUTH_USAGE_BETA,
  OAUTH_USAGE_URL,
  parseSubscriptionUsage,
  probesSubscriptionUsage,
} from './plan-usage';
import { decryptSecret } from './provider-crypto';

/** How long a good snapshot is served before the next read refreshes it. Matches the cadence a
 *  runner polls its own login at, which is what the same gauge shows for a built-in engine. */
const FRESH_MS = 2 * 60 * 1000;
/** A failing credential is retried far more slowly: the usual causes (a token minted without the
 *  `user:profile` scope, a revoked key) do not fix themselves, and each attempt is a request to
 *  Anthropic on the user's behalf. */
const RETRY_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

interface Entry {
  usage: PlanUsageSnapshot | null;
  /** The ciphertext the snapshot was fetched with — a rotated key invalidates it immediately
   *  rather than serving the old account's numbers for up to FRESH_MS. */
  keyEnc: string;
  refreshAt: number;
  /** Last failure reason, so a repeated one is logged only once. */
  failure: string;
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
 * rendered before any of this existed.
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

  /** Refresh this row's quota. Concurrent callers share the one request in flight — and get a
   *  promise that resolves when it lands, rather than one that resolves immediately. */
  refresh(row: UsageProviderRow): Promise<void> {
    const existing = this.inFlight.get(row.id);
    if (existing) return existing;
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
    if (typeof result === 'string') {
      // Keep the last good numbers through a blip, exactly as the runner probe does; only the
      // retry clock moves.
      if (previous?.failure !== result) this.log.warn(`provider ${row.id} usage unavailable: ${result}`);
      this.cache.set(row.id, {
        usage: previous?.usage ?? null,
        keyEnc: row.apiKeyEnc,
        refreshAt: Date.now() + RETRY_MS,
        failure: result,
      });
      return;
    }
    if (previous?.failure) this.log.log(`provider ${row.id} usage recovered`);
    this.cache.set(row.id, {
      usage: result,
      keyEnc: row.apiKeyEnc,
      refreshAt: Date.now() + FRESH_MS,
      failure: '',
    });
    // First fetch included: before it the client had no gauge at all, so this is the push that
    // makes one appear.
    if (JSON.stringify(previous?.usage ?? null) !== JSON.stringify(result)) this.publish(row);
  }

  /** The snapshot, or a short reason string when the endpoint could not be read. */
  private async fetchUsage(apiKey: string): Promise<PlanUsageSnapshot | null | string> {
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
      return (e as Error).name === 'TimeoutError' ? 'timed out' : 'could not reach the endpoint';
    }
    if (!resp.ok) {
      // 403 here is the common one and it is not a broken key: a token minted by
      // `claude setup-token` carries inference scope only, while the usage endpoint wants
      // `user:profile` — which the browser login flow grants.
      return `HTTP ${resp.status}`;
    }
    try {
      return parseSubscriptionUsage(await resp.json(), new Date().toISOString());
    } catch {
      return 'unreadable response';
    }
  }

  /** Same channel a provider edit uses: the owner for a personal row, everyone for a shared one. */
  private publish(row: UsageProviderRow): void {
    if (row.ownerId) this.realtime.publishForUser(row.ownerId, RunEventType.PROVIDER_CHANGED, row.id);
    else this.realtime.publishForAllUsers(RunEventType.PROVIDER_CHANGED, row.id);
  }
}
