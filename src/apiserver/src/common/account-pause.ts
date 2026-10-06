import { BadRequestException } from '@nestjs/common';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';

/** Null resumes; omission is not a request to resume. */
export class PauseAccountDto {
  @ValidateIf((_object, value) => value !== null)
  @IsInt() @Min(1) @Max(10080)
  durationMinutes!: number | null;
}

export function accountPauseUntil(durationMinutes: number | null, now = new Date()): Date | null {
  if (durationMinutes === null) return null;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) {
    throw new BadRequestException('Pause duration must be between 1 minute and 7 days');
  }
  return new Date(now.getTime() + durationMinutes * 60_000);
}

/** Server-owned runner settings, independent of heartbeat reports and quota cooldowns. */
export function runnerAccountPausedUntil(
  pauses: unknown,
  engine: string,
  account: string | null | undefined,
  now = new Date(),
): Date | null {
  if (!account || !pauses || typeof pauses !== 'object' || Array.isArray(pauses)) return null;
  const entries = (pauses as Record<string, unknown>)[engine];
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  const value = (entries as Record<string, unknown>)[account];
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return time > now.getTime() ? new Date(time) : null;
}
