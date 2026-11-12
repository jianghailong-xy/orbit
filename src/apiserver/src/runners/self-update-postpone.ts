import { BadRequestException } from '@nestjs/common';

/**
 * The owner's Later (docs/runner-update-drain-design.md §4, D2): a postponement lasts at most until
 * 09:00 tomorrow in the owner's zone. The clients send the device's IANA zone with the request; a
 * request without one is capped in UTC.
 */

/** The offset of `zone` from UTC at `at`, in milliseconds (local minus UTC). */
function zoneOffsetMs(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return local - Math.floor(at / 1000) * 1000;
}

/** Whether `zone` is an IANA zone this server knows. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 09:00 on the calendar day after `now`'s, in `zone`. */
export function tomorrowNineIn(now: Date, zone: string): Date {
  const local = new Date(now.getTime() + zoneOffsetMs(now.getTime(), zone));
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 9);
  // Twice: the offset at 09:00 tomorrow can differ from today's across a DST change.
  let at = guess - zoneOffsetMs(guess, zone);
  at = guess - zoneOffsetMs(at, zone);
  return new Date(at);
}

/** The time a Later asks the runner to wait until: `until` in the future, capped at tomorrowNineIn. */
export function postponeUntil(now: Date, body: { until?: unknown; timeZone?: unknown } | undefined): { until: Date; capped: boolean } {
  const raw = body?.until;
  const until = typeof raw === 'string' ? new Date(raw) : null;
  if (!until || Number.isNaN(until.getTime())) {
    throw new BadRequestException('until must be an ISO time');
  }
  if (until.getTime() <= now.getTime()) {
    throw new BadRequestException('until must be in the future');
  }
  const zone = body?.timeZone === undefined || body.timeZone === null ? 'UTC' : body.timeZone;
  if (typeof zone !== 'string' || !isKnownTimeZone(zone)) {
    throw new BadRequestException('timeZone must be an IANA time zone, such as Asia/Shanghai');
  }
  const cap = tomorrowNineIn(now, zone);
  return until.getTime() > cap.getTime() ? { until: cap, capped: true } : { until, capped: false };
}
