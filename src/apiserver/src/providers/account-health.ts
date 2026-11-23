import type { RunFailureKind, RunFailureScope } from '@orbit/shared';
import { QUOTA_BLIND_RETRY_BACKOFF_MS } from '../tasks/task-retry-policy';

/**
 * Account health: the rules (docs/routing-account-health-design.md §6, as amended in §11). Pure: what a run's end
 * does to an account's live row. AccountHealthService (account-health.service.ts) reads and writes the rows.
 */

/**
 * The failure kind of a released run (§4), as `runFailureKind` of @orbit/shared answers it: the runner's structured
 * kind (the shared RunFailureKind), else what the legacy markers say of the error text; null when it is not
 * classified. The enum's values, so a stored kind and an enum member are both one.
 */
export type HealthFailureKind = `${RunFailureKind}`;

export type AccountHealthState = 'SUSPECT' | 'BLOCKED' | 'COOLDOWN';

/**
 * What health did with one failed run, as the run records it (session.account_health_effect, §7.4): it struck or
 * blocked the account (the row it left is SUSPECT or BLOCKED), or the run was the account's trial and was refused.
 * A run with an effect is not counted against its task: the failure was the account's.
 */
export type AccountHealthEffect = 'SUSPECT' | 'BLOCKED' | 'TRIAL';

/** The effect a failure's step leaves on its run: none for a cool-down or no change. */
export function failureEffect(step: AccountHealthStep, heldTrial: boolean): AccountHealthEffect | null {
  const state = step.next?.state;
  if (state !== 'SUSPECT' && state !== 'BLOCKED') return null;
  return heldTrial && state === 'BLOCKED' ? 'TRIAL' : state;
}

/** The kind the breaker writes: an unclassified zero-cost admission failure. */
export const UNCLASSIFIED_ADMISSION = 'UNCLASSIFIED_ADMISSION';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** §6.4, the classified ladder: 1 h for the first trip, doubling to a 24 h cap at trip 6. */
export const CLASSIFIED_LADDER_MS: readonly number[] = [1 * HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, 24 * HOUR];
/** §6.4 as amended (A2), the breaker ladder: 30 min, doubling to the same 24 h cap one trip later (trip 7). */
export const BREAKER_LADDER_MS: readonly number[] = [30 * MINUTE, 1 * HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, 24 * HOUR];
/** §6.4, Q6: a model at capacity is set aside on that account for 5 minutes. */
export const CAPACITY_COOLDOWN_MS = 5 * MINUTE;
/** §6.4: a usage limit with no reading that covers the account, and no reset the provider named. */
export const USAGE_LIMIT_COOLDOWN_MS = QUOTA_BLIND_RETRY_BACKOFF_MS;
/** §6.4: a suspect account is healthy again after this long without another strike. */
export const SUSPECT_WINDOW_MS = 60 * MINUTE;
/** §6.5: a trial claim whose session never started is released after this long. */
export const TRIAL_CLAIM_STALE_MS = 15 * MINUTE;

const CLASSIFIED: ReadonlySet<string> = new Set(['ACCOUNT_ACTION_REQUIRED', 'CREDENTIAL_REFUSED', 'ACCESS_DENIED']);

export type Ladder = 'CLASSIFIED' | 'BREAKER';

/** §8: the breaker's alert point. A classified refusal alerts at its first occurrence; a guess waits for the third trip. */
export const BREAKER_ALERT_TRIP = 3;

/** Whether `kind` is one the provider stated in its own words (§4): the three that alert at their first occurrence. */
export function isClassifiedKind(kind: string): boolean {
  return CLASSIFIED.has(kind);
}

/**
 * §8: does the row `next`, just written, owe the owner an `account-needs-action` push? `notifiedKind` is what the live
 * row last alerted for (null: not yet). A cleared row is gone, so the next streak starts with null and alerts at its own
 * alert point; a still-blocked account alerts again only when refused with a different classified kind. Not a later
 * trip of the same kind, not a refused trial, not a classified streak turning unclassified, not a cool-down.
 */
export function alertDue(next: Pick<AccountHealthRow, 'state' | 'kind' | 'trips'>, notifiedKind: string | null): boolean {
  if (next.state !== 'BLOCKED') return false;
  if (CLASSIFIED.has(next.kind)) return notifiedKind !== next.kind;
  return next.kind === UNCLASSIFIED_ADMISSION && notifiedKind === null && next.trips === BREAKER_ALERT_TRIP;
}

/**
 * How long trip `trip` (1-based, consecutive) blocks the account on `ladder`. The step is read from the column of
 * the kind that caused THIS trip at the shared count (§6.4), so a breaker streak followed by a classified refusal
 * continues on the classified column. Past the end of a column it stays at the cap.
 */
export function blockMs(ladder: Ladder, trip: number): number {
  if (!Number.isInteger(trip) || trip < 1) throw new RangeError(`trip must be a positive integer, got ${trip}`);
  const column = ladder === 'CLASSIFIED' ? CLASSIFIED_LADDER_MS : BREAKER_LADDER_MS;
  return column[Math.min(trip, column.length) - 1];
}

/** What a run spends (§6.1). Health is per runner: one provider account signed in on two runners is two subjects. */
export type AccountHealthSubject =
  | { type: 'runner'; runnerId: string; engine: string; account: string }
  | { type: 'provider'; providerId: string }
  | { type: 'pool-login'; poolId: string; accountId: string };

export function subjectKey(subject: AccountHealthSubject): string {
  switch (subject.type) {
    case 'runner':
      return `runner:${subject.runnerId}:${subject.engine}:${subject.account}`;
    case 'provider':
      return `provider:${subject.providerId}`;
    case 'pool-login':
      return `pool-login:${subject.poolId}:${subject.accountId}`;
  }
}

/**
 * The account part of a runner subject, from what runAccount (plan-usage-accounts.ts) answers for the run: the
 * account it names; `default` for an engine whose CLI keeps one login for the machine (undefined); none (null) for
 * a run whose workspace env brings a credential of its own, which spends no account of the runner's.
 */
export function runnerSubjectAccount(account: string | null | undefined): string | null {
  if (account === null) return null;
  return account ?? 'default';
}

/** The key's parts, stored beside it for joins and cascade delete. */
export function subjectColumns(subject: AccountHealthSubject): {
  runnerId: string | null; engine: string | null; account: string | null; providerId: string | null; poolId: string | null;
} {
  switch (subject.type) {
    case 'runner':
      return { runnerId: subject.runnerId, engine: subject.engine, account: subject.account, providerId: null, poolId: null };
    case 'provider':
      return { runnerId: null, engine: null, account: null, providerId: subject.providerId, poolId: null };
    case 'pool-login':
      return { runnerId: null, engine: null, account: subject.accountId, providerId: null, poolId: subject.poolId };
  }
}

/** The columns of a live row the rules read and write. */
export interface AccountHealthRow {
  state: AccountHealthState;
  kind: string;
  said: string | null;
  strikes: number;
  trips: number;
  firstAt: Date;
  lastAt: Date;
  lastSessionId: string | null;
  blockedUntil: Date | null;
  trialSessionId: string | null;
  trialClaimedAt: Date | null;
}

/**
 * What the router sees of a live row at `now` (§7.1): a cool-down or a suspect period that ran out reads as healthy,
 * and an expired block reads as a trial due until a run claims it.
 */
export type AccountHealthView = 'healthy' | 'suspect' | 'cooldown' | 'blocked' | 'trial-due' | 'trial-running';

/**
 * `trialRunning`: the trial's session is RUNNING. A claim holds while it is, or for 15 minutes from the claim
 * whatever the session does; after that a claim whose session never started is free to take (§6.5).
 */
export function healthView(row: AccountHealthRow | null, now: Date, trialRunning = false): AccountHealthView {
  if (!row) return 'healthy';
  const at = now.getTime();
  switch (row.state) {
    case 'SUSPECT':
      return row.lastAt.getTime() + SUSPECT_WINDOW_MS > at ? 'suspect' : 'healthy';
    case 'COOLDOWN':
      return row.blockedUntil && row.blockedUntil.getTime() > at ? 'cooldown' : 'healthy';
    case 'BLOCKED':
      if (row.blockedUntil && row.blockedUntil.getTime() > at) return 'blocked';
      return trialHeld(row, now, trialRunning) ? 'trial-running' : 'trial-due';
  }
}

/** Whether a claimed trial still holds the account (§6.5). */
export function trialHeld(row: Pick<AccountHealthRow, 'trialSessionId' | 'trialClaimedAt'>, now: Date, trialRunning: boolean): boolean {
  if (!row.trialSessionId || !row.trialClaimedAt) return false;
  return trialRunning || row.trialClaimedAt.getTime() + TRIAL_CLAIM_STALE_MS > now.getTime();
}

/** A run that ended FAILED, as the ingest hands it over (§6.3). */
export interface AccountHealthFailure {
  sessionId: string;
  /** runFailureKind's output. */
  kind: HealthFailureKind | null;
  /** The adapter's scope; absent is the whole account. */
  scope?: RunFailureScope | null;
  /** The model the run asked for: the row a CAPACITY or one-model ACCESS_DENIED writes. */
  model?: string | null;
  /** When the provider says it can run again; only read with USAGE_LIMIT or CAPACITY. */
  until?: Date | null;
  /** The provider's own words. */
  said?: string | null;
  /** The turn ended before any reply, tool call or billed token (§5.2). */
  admission: boolean;
  /** The runner was online when the run ended: a breaker strike needs it (§6.4). */
  runnerOnline: boolean;
  /** A usage reading covers the account: a usage limit then writes nothing, the reading is the better source. */
  usageReadingCovers?: boolean;
}

/** Which row of the subject a failure is about: '' for the whole account, a model id for one model; null for none. */
export function failureScopeModel(failure: AccountHealthFailure): string | null {
  const model = failure.model?.trim() || null;
  switch (failure.kind) {
    case 'CAPACITY':
      // Always one model on the account (Q6). With no model named there is no row it could cool.
      return model;
    case 'ACCESS_DENIED':
      return failure.scope === 'model' ? model : failure.scope === 'request' ? null : '';
    case 'ACCOUNT_ACTION_REQUIRED':
    case 'CREDENTIAL_REFUSED':
    case 'USAGE_LIMIT':
      return failure.scope === 'request' ? null : '';
    case 'TRANSPORT':
    case 'REQUEST_REFUSED':
      return null;
    case null:
      return isBreakerStrike(failure) ? '' : null;
  }
}

/**
 * §6.4: a breaker strike is an admission failure with no kind, while the runner was online. `TRANSPORT` by the legacy
 * markers already arrives as a kind (runFailureKind maps isConnectionFailureText to it), so it is never one.
 */
export function isBreakerStrike(failure: AccountHealthFailure): boolean {
  return failure.kind === null && failure.admission && failure.runnerOnline;
}

/**
 * What a failure does to the live row of its scope. `next` null: nothing changes. `expirePrevious`: the live row ran
 * out before this failure (a cool-down or suspect period), so it is stamped EXPIRED and `next` is a new live row.
 */
export interface AccountHealthStep {
  next: AccountHealthRow | null;
  expirePrevious: boolean;
}

const NO_CHANGE: AccountHealthStep = { next: null, expirePrevious: false };

/**
 * The transition of §6.4 and §6.5 for one failure on the row `row` (the live row of the scope
 * failureScopeModel names, or null). Idempotent per session: a failure from the session that last wrote the row
 * changes nothing.
 */
export function stepOnFailure(row: AccountHealthRow | null, failure: AccountHealthFailure, now: Date): AccountHealthStep {
  if (row?.lastSessionId === failure.sessionId) return NO_CHANGE;
  const view = healthView(row, now);
  // A row that ran out is history: the failure starts from nothing.
  const live = view === 'healthy' ? null : row;
  const expirePrevious = row !== null && live === null;
  const said = failure.said?.trim() ? failure.said.trim().slice(0, 300) : null;
  const fresh = (state: AccountHealthState, kind: string, blockedUntil: Date | null, strikes = 0, trips = 0): AccountHealthStep => ({
    next: {
      // The provider's words carry over a streak of one kind when a later refusal brings none.
      state, kind, said: said ?? (live?.kind === kind ? live.said : null), strikes, trips,
      firstAt: live?.firstAt ?? now, lastAt: now, lastSessionId: failure.sessionId,
      blockedUntil, trialSessionId: null, trialClaimedAt: null,
    },
    expirePrevious,
  });
  const at = now.getTime();
  const kind = failure.kind;

  if (kind !== null && CLASSIFIED.has(kind)) {
    if (live?.state === 'BLOCKED') {
      // Still inside its block: the account was already out. Not a trip; only the evidence moves.
      if (view === 'blocked') return evidence(live, failure, now, said);
      // Trial due or running: a refused trial is the next trip at once (§6.5).
      const trips = live.trips + 1;
      return fresh('BLOCKED', kind, new Date(at + blockMs('CLASSIFIED', trips)), 0, trips);
    }
    // Healthy, suspect or cooling down: the first trip. One is enough for a classified kind.
    return fresh('BLOCKED', kind, new Date(at + blockMs('CLASSIFIED', 1)), 0, 1);
  }

  if (kind === null) {
    if (!isBreakerStrike(failure)) return NO_CHANGE;
    if (!live) return fresh('SUSPECT', UNCLASSIFIED_ADMISSION, null, 1, 0);
    if (live.state === 'SUSPECT') {
      // The second strike in a row is a trip.
      return fresh('BLOCKED', UNCLASSIFIED_ADMISSION, new Date(at + blockMs('BREAKER', 1)), 0, 1);
    }
    if (live.state === 'BLOCKED') {
      if (view === 'blocked') return evidence(live, failure, now, live.said);
      const trips = live.trips + 1;
      return fresh('BLOCKED', UNCLASSIFIED_ADMISSION, new Date(at + blockMs('BREAKER', trips)), 0, trips);
    }
    // A live cool-down already keeps the account out; an unclassified failure there says nothing new.
    return NO_CHANGE;
  }

  if (kind === 'USAGE_LIMIT' || kind === 'CAPACITY') {
    if (kind === 'USAGE_LIMIT' && failure.usageReadingCovers) return NO_CHANGE;
    const named = failure.until && failure.until.getTime() > at ? failure.until : null;
    const end = named ?? new Date(at + (kind === 'CAPACITY' ? CAPACITY_COOLDOWN_MS : USAGE_LIMIT_COOLDOWN_MS));
    if (live?.state === 'BLOCKED') {
      // A cool-down is never a trip (§6.4): the ladder is kept, and its next trial waits for the cool-down too.
      const blockedUntil = live.blockedUntil && live.blockedUntil > end ? live.blockedUntil : end;
      return {
        next: { ...live, said: said ?? live.said, lastAt: now, lastSessionId: failure.sessionId, blockedUntil, trialSessionId: null, trialClaimedAt: null },
        expirePrevious: false,
      };
    }
    // From this failure: a second one while the row is live moves the end, never beyond its own length.
    return fresh('COOLDOWN', kind, end);
  }

  return NO_CHANGE;
}

function evidence(row: AccountHealthRow, failure: AccountHealthFailure, now: Date, said: string | null): AccountHealthStep {
  return { next: { ...row, said: said ?? row.said, lastAt: now, lastSessionId: failure.sessionId }, expirePrevious: false };
}
