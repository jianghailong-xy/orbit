import { IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { PermissionMode } from '@orbit/shared';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  name?: string;

  /** Omit to have a strong password generated and returned once. */
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  /** Reset the password of an existing user instead of failing on conflict. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/**
 * Partial patch of the current user's own preferences. Merged server-side into
 * the stored JSON (omitted fields keep their value).
 */
export class UpdatePreferencesDto {
  @IsOptional()
  @IsIn(['system', 'light', 'dark'])
  theme?: 'system' | 'light' | 'dark';

  @IsOptional()
  @IsString()
  defaultModel?: string;

  @IsOptional()
  @IsEnum(PermissionMode)
  defaultPermissionMode?: PermissionMode;

  /**
   * Default reasoning effort for a new session's composer, remembered account-wide
   * (last-picked-wins). '' = model default; otherwise a Claude/Codex effort level.
   * Kept as a free string (not an enum) so provider-specific levels round-trip.
   */
  @IsOptional()
  @IsString()
  defaultEffort?: string;

  /**
   * Whether a session settling — a run that finished on its own, or failed for good — pushes
   * an alert to this account's registered devices. Default on (an absent key means on), so the
   * switch only ever has to be written to turn it off.
   */
  @IsOptional()
  @IsBoolean()
  notifySessionFinished?: boolean;
}

/** Set a user's access role (admin area). */
export class UpdateRoleDto {
  @IsIn(['MEMBER', 'ADMIN'])
  role!: 'MEMBER' | 'ADMIN';
}
