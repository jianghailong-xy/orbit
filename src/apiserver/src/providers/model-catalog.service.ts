import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RunEventType } from '@orbit/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { catalogFingerprint, parseModelCatalog, setModelCatalog } from './model-catalog';

/** The third-party provider → models mapping the vendor lists refresh from. Overridable so a
 *  deployment can point at a mirror (or a pinned copy) instead of reaching the public one. */
const CATALOG_URL = process.env.MODEL_CATALOG_URL || 'https://models.dev/api.json';
/** Vendors ship a model every few weeks, so this only has to be faster than a release. Twice a day
 *  keeps a new flagship at most half a day out of the pickers. */
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Keeps the third-party vendor model lists current (see model-catalog.ts).
 *
 * Failure is not exceptional here — a deployment may sit behind a firewall that can't reach
 * models.dev at all — so a failed refresh is logged and dropped: reads fall back to the lists this
 * build shipped, which is exactly the behaviour before any of this existed. A refresh that changes
 * what the pickers offer pushes PROVIDER_CHANGED, the same event a provider edit sends, so open
 * clients pick the new models up without a reload.
 */
@Injectable()
export class ModelCatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ModelCatalog');
  private timer?: ReturnType<typeof setInterval>;
  private fingerprint = '';

  constructor(private readonly realtime: RealtimeService) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    let catalog;
    try {
      const resp = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      catalog = parseModelCatalog(await resp.json());
    } catch (e) {
      this.log.warn(`model catalogue refresh failed (${(e as Error).message}) — keeping current lists`);
      return;
    }
    // An empty result means we understood nothing in the payload; the shipped lists are better.
    if (catalog.size === 0) {
      this.log.warn('model catalogue refresh returned no usable vendors — keeping current lists');
      return;
    }
    const next = catalogFingerprint(catalog);
    if (next === this.fingerprint) return;
    const first = this.fingerprint === '';
    this.fingerprint = next;
    setModelCatalog(catalog);
    this.log.log(`model catalogue refreshed for ${catalog.size} vendors`);
    // Nothing to tell anyone on the first fetch of a fresh process: it lands seconds after boot,
    // before a client has read a catalogue that this would correct.
    if (!first) this.realtime.publishForAllUsers(RunEventType.PROVIDER_CHANGED, 'catalog');
  }
}
