import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';
import { PAT_EXPIRY_CHOICES, PAT_SCOPE_PRESETS, type PatScopePreset } from './pat.service';
import { SIGNUP_POLICIES, type SignupPolicy } from './sign-in-providers.service';

// A pasted client ID or secret often carries a stray space or newline; it is judged without them.
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

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

/**
 * `POST /access-tokens/device/start`, what `orbit login` asks for (docs/personal-access-token-design.md
 * §7.3): the token's name, its scopes — listed, or a preset of them, one of the two — its lifetime as
 * `POST /access-tokens` takes one, and the host the CLI runs on, shown on the approval page.
 */
export class StartPatDeviceLoginDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsIn(Object.keys(PAT_SCOPE_PRESETS))
  preset?: PatScopePreset;

  @IsOptional()
  @IsIn(PAT_EXPIRY_CHOICES)
  expiresInDays?: (typeof PAT_EXPIRY_CHOICES)[number] | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  hostname?: string;
}

/** `POST /access-tokens/device/poll`: the device code `start` answered, which only the CLI holds. */
export class PollPatDeviceLoginDto {
  @IsString()
  deviceCode!: string;
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

/** `PUT /admin/sign-in/google` (docs/google-sign-in-design.md §6, §7.1): the whole setting. */
export class UpdateGoogleSignInDto {
  @IsBoolean()
  enabled!: boolean;

  /** Empty saves none, and Google sign-in stays off until there is one. */
  @Transform(trimmed)
  @IsString()
  clientId!: string;

  /** Omit to keep the saved secret; provide to replace it. It is never read back. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  clientSecret?: string;

  @IsIn(SIGNUP_POLICIES)
  signupPolicy!: SignupPolicy;
}
