import { IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateBy } from 'class-validator';
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

  /**
   * Create the account without a password: it signs in with Google only (docs/google-sign-in-design.md
   * §5.4). Refused together with `password`, and with `force`, which would otherwise erase an existing
   * account's password.
   */
  @IsOptional()
  @IsBoolean()
  passwordless?: boolean;
}

/** The longest display name an account may give itself. */
export const USER_NAME_MAX_CHARS = 80;

/**
 * The current user's own profile. The display name is the one thing on it they change themselves:
 * the email is the sign-in, and stays as the account was created. Trimmed server-side, where a name
 * that is blank once trimmed is refused.
 */
export class UpdateProfileDto {
  @IsString()
  @MaxLength(USER_NAME_MAX_CHARS)
  name!: string;
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

  /** Last-picked model per provider; a patch updates only the named providers. */
  @IsOptional()
  @ValidateBy({
    name: 'defaultModels',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        Object.values(value).every((model) => typeof model === 'string'),
      defaultMessage: () => 'defaultModels must map provider names to model strings',
    },
  })
  defaultModels?: Record<string, string>;

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

  /**
   * Whether an agent may push a line of its own to this account's devices (the `notify` tool /
   * `orbit notify`). Its own switch rather than a share of the one above: that alert is Orbit
   * reporting an outcome, this one is a model deciding you should be interrupted, and a person
   * who wants the first does not necessarily want the second. Default on (absent = on), so the
   * switch is only ever written to turn it off.
   */
  @IsOptional()
  @IsBoolean()
  notifyAgentMessage?: boolean;

  /**
   * Whether this account's sessions may orchestrate — spawn and drive other sessions via the
   * orbit MCP session tools. One switch for every workspace, read live on each claim, spawn and
   * call (common/orchestration-switch.ts), so turning it off revokes the grant everywhere at once.
   * Default on (absent = on), so the switch is only ever written to turn it off.
   */
  @IsOptional()
  @IsBoolean()
  enableOrchestration?: boolean;

  /**
   * Whether smart model selection is on for this account: the master switch over the whole
   * feature, read wherever it acts (common/model-routing-switch.ts). Default OFF (absent = off),
   * unlike the switches above, so it is only ever written to turn it on — or back off.
   */
  @IsOptional()
  @IsBoolean()
  modelRouting?: boolean;
}

/** Set a user's access role (admin area). */
export class UpdateRoleDto {
  @IsIn(['MEMBER', 'ADMIN'])
  role!: 'MEMBER' | 'ADMIN';
}

/** Disable an account, or enable it again (admin area, docs/google-sign-in-design.md §5.5). */
export class SetDisabledDto {
  @IsBoolean()
  disabled!: boolean;
}
