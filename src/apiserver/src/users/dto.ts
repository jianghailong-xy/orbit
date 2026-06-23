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
}

/** Set a user's access role (admin area). */
export class UpdateRoleDto {
  @IsIn(['MEMBER', 'ADMIN'])
  role!: 'MEMBER' | 'ADMIN';
}
