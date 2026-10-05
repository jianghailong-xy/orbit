import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

/** Register APNs (default) or an Android FCM installation for the current user. */
export class RegisterDeviceTokenDto {
  /** APNs hex token or opaque FCM registration token. Never trim or rewrite it. */
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: string;

  /** Which APNs host this token belongs to. */
  @IsOptional()
  @IsIn(['production', 'sandbox'])
  environment?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  bundleId!: string;

  @ValidateIf((dto) => dto.platform === 'android' || dto.installationId !== undefined)
  @IsUUID('4')
  installationId?: string;
}

/** Drop a device token (sign-out). */
export class UnregisterDeviceTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: string;

  /** Echo the Android register response; a late logout cannot remove a newer binding. */
  @ValidateIf((dto) => dto.platform === 'android' || dto.registrationKey !== undefined)
  @IsUUID()
  registrationKey?: string;
}
