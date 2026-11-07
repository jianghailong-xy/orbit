/**
 * The Feishu module's clocks (docs/feishu-bot-design.md §4.4, §7.1). A spec speeds every one of them up at once with
 * ORBIT_TEST_FEISHU_TIME_SCALE (a divisor, e.g. 100), which nothing reads under NODE_ENV=production — what the
 * apiserver image sets — so a deployment always runs at these values.
 */
export const FEISHU_TEST_TIME_SCALE_ENV = 'ORBIT_TEST_FEISHU_TIME_SCALE';

const BASE = {
  /** The first wait after a failed connection; it doubles with each failure in a row (§4.4: from 1 minute). */
  backoffBaseMs: 60_000,
  /** The longest wait between attempts (§4.4: at most 1 hour). */
  backoffCapMs: 60 * 60_000,
  /** How long one attempt may take before it counts as failed: Feishu neither connected nor refused. */
  attemptTimeoutMs: 30_000,
  /** How often a live connection's state is looked at, to notice a drop. */
  watchMs: 5_000,
  /** How often each replica compares the apps it connects with the apps that should be connected. */
  reconcileMs: 15_000,
  /** How often a replica renews the heartbeat of its feishu_link rows. */
  heartbeatMs: 30_000,
  /** A feishu_link row whose heartbeat is older than this is not counted as connected. */
  staleMs: 90_000,
  /** How often the inbox worker looks for work it was not woken for. */
  inboxPollMs: 2_000,
  /** How long a claimed inbox row is held by its worker. */
  inboxLeaseMs: 60_000,
  /** How often the leader deletes inbox rows older than the retention. */
  inboxPurgeMs: 60 * 60_000,
  /** How long a processed or given-up inbox row is kept (§7.1: 7 days). Not scaled. */
  inboxRetentionMs: 7 * 24 * 60 * 60_000,
  /** The wait a 429 is retried after when Feishu does not say how long. */
  rateLimitDefaultMs: 1_000,
  /** The longest a 429's suggested wait is honoured for; longer gives up. */
  rateLimitCapMs: 60_000,
};

export type FeishuTiming = typeof BASE;

export function feishuTiming(): FeishuTiming {
  const raw = process.env.NODE_ENV === 'production' ? undefined : process.env[FEISHU_TEST_TIME_SCALE_ENV];
  const scale = raw ? Number(raw) : 1;
  if (!Number.isFinite(scale) || scale <= 1) return { ...BASE };
  const out = { ...BASE };
  for (const key of Object.keys(out) as (keyof FeishuTiming)[]) {
    if (key !== 'inboxRetentionMs') out[key] = Math.max(10, Math.round(BASE[key] / scale));
  }
  return out;
}

/** The wait before attempt `failures + 1`, after `failures` failures in a row (≥ 1): 1, 2, 4, … minutes, at most an hour. */
export function backoffMs(failures: number, timing: FeishuTiming): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 20);
  return Math.min(timing.backoffBaseMs * 2 ** exponent, timing.backoffCapMs);
}
