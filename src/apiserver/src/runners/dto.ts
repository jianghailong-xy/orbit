import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { InstallEngine, LoginEngine } from '@orbit/shared';

export class CreateEnrollmentTokenDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) ttlHours?: number;
}

export class UpdateRunnerDto {
  // Empty string clears the alias and falls back to the machine name.
  @IsOptional() @IsString() @MaxLength(60) displayName?: string;
  // Max sessions the runner runs at once; the claim queue gates on this. Floor of
  // 1 (0 would stall the runner); 64 is a sanity ceiling against a fat-fingered value.
  @IsOptional() @IsInt() @Min(1) @Max(64) maxConcurrent?: number;
  // Free-space floor in MB: below it, the auto-run sweep dispatches nothing onto this machine.
  // null clears the floor (no gate), and 0 is spelled that way rather than accepted as a
  // disabling value, so "gate at zero bytes" can never be typed by accident. No ceiling — the
  // right reserve on a 30TB archive volume is not the right one on a laptop.
  @IsOptional() @IsInt() @Min(1) minFreeDiskMb?: number | null;
}

// The requested runner order. The service filters this list against the caller's
// current runners and appends omitted runners, so stale clients cannot drop rows.
export class ReorderRunnersDto {
  @IsArray() @IsString({ each: true }) @ArrayUnique() ids!: string[];
}

/** The authorization code the user pasted back from the hosted OAuth callback page. */
export class SubmitLoginCodeDto {
  @IsString() @MinLength(1) code!: string;
}

/**
 * An account a runner has, of any engine that keeps one login per directory: `default`, the
 * directory its own environment selects, or the id of a slot it added — 4 random bytes in lowercase
 * hex (src/runner-go/account_slot.go).
 */
export const ACCOUNT_ID_PATTERN = /^(?:default|[0-9a-f]{8})$/;

/** Which CLI to sign in. Absent from an older client, which only ever signed in claude. */
export class StartLoginDto {
  @IsOptional() @IsIn(['claude', 'codex', 'kimi', 'antigravity']) engine?: LoginEngine;
  /** Sign in this account the runner already has, of an engine that keeps accounts. Absent: the
   *  runner's own login. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) account?: string;
  /** Codex only: sign in a NEW account, which the runner adds under this name. */
  @IsOptional() @IsString() @MaxLength(60) accountName?: string;
}

/** A new name for an account a runner reports, Default included. The limit is the one an account
 *  is added under (StartLoginDto.accountName). */
export class RenameAccountDto {
  @IsString() @MaxLength(60) name!: string;
}

/** Which CLI to install on the runner. Required — there is no historical default here. */
export class StartInstallDto {
  @IsIn(['claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh']) engine!: InstallEngine;
}
