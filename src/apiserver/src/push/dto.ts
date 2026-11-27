import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, IsUrl, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';

/** A browser subscription's two keys (base64url): the P-256 public key and the 16-byte auth secret. */
export class WebPushKeysDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{86,88}={0,2}$/)
  p256dh!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{22}={0,2}$/)
  auth!: string;
}

/** Register APNs (default), an Android FCM installation, or a browser's Web Push subscription for the current user. */
export class RegisterDeviceTokenDto {
  /** APNs hex token or opaque FCM registration token. Never trim or rewrite it. */
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android', 'web'])
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

  /** platform 'web': the subscription's keys; `token` is its endpoint (docs/web-push-design.md). */
  @ValidateIf((dto) => dto.platform === 'web' || dto.webKeys !== undefined)
  @ValidateNested()
  @Type(() => WebPushKeysDto)
  webKeys?: WebPushKeysDto;
}

/** Drop a device token (sign-out). */
export class UnregisterDeviceTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  token!: string;

  @IsOptional()
  @IsIn(['ios', 'android', 'web'])
  platform?: string;

  /** Echo the Android register response; a late logout cannot remove a newer binding. */
  @ValidateIf((dto) => dto.platform === 'android' || dto.registrationKey !== undefined)
  @IsUUID()
  registrationKey?: string;
}

/**
 * The longest fields POST /notify takes. A push carries at most 4 KB (APNs, and FCM's data), and these keep the whole
 * payload under that even in a script where a character takes three bytes; anything longer is refused, not cut.
 */
export const NOTIFY_LIMITS = { title: 100, message: 800, url: 500 } as const;
export const NOTIFY_PRIORITIES = ['low', 'normal', 'high'] as const;
export type NotifyPriority = (typeof NOTIFY_PRIORITIES)[number];

/** POST /notify: a notification for the token owner's Orbit apps (docs/api-reference.md, "Sending a notification"). */
export class SendNotificationDto {
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(NOTIFY_LIMITS.title)
  title!: string;

  @IsString()
  @Matches(/\S/, { message: 'message must not be blank' })
  @MaxLength(NOTIFY_LIMITS.message)
  message!: string;

  /** `low` is silent, `normal` (the default) sounds, `high` also asks iOS to break through Focus (time-sensitive). */
  @IsOptional()
  @IsIn(NOTIFY_PRIORITIES)
  priority?: NotifyPriority;

  /** A link carried in the push payload as `url`, for whoever reads it there. */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  @MaxLength(NOTIFY_LIMITS.url)
  url?: string;
}
