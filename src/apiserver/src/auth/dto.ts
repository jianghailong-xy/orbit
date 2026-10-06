import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';
import { PAT_EXPIRY_CHOICES } from './pat.service';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

/** Body for POST /auth/refresh and POST /auth/logout — the opaque refresh token. */
export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;

  /** Also revoke every personal access token the account has (§11.3). Left out, they keep working. */
  @IsOptional()
  @IsBoolean()
  revokeAccessTokens?: boolean;
}

/**
 * `POST /access-tokens` (docs/personal-access-token-design.md §6.5). `expiresInDays` is 30, 90 or
 * 365; null is a token that never expires; left out, it is 90 (§11.1).
 */
export class IssueAccessTokenDto {
  @IsString()
  name!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  scopes!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsPublicId({ each: true })
  workspaceIds?: string[];

  @IsOptional()
  @IsIn(PAT_EXPIRY_CHOICES)
  expiresInDays?: (typeof PAT_EXPIRY_CHOICES)[number] | null;
}

export class BootstrapDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
