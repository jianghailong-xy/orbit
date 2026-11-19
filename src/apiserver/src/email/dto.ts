import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// A pasted key or address often carries a stray space or newline; it is judged without them.
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `PUT /admin/email` (docs/welcome-email-design.md §3.1): the whole setting. */
export class UpdateEmailSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  /** Omit to keep the saved key; provide to replace it. It is never read back. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  apiKey?: string;

  /** Like `Orbit <orbit@example.com>`; its domain must be verified in Resend. Empty saves none. */
  @Transform(trimmed)
  @IsString()
  @MaxLength(320)
  fromAddress!: string;

  /** Empty: the earliest administrator's address. */
  @Transform(trimmed)
  @IsString()
  @MaxLength(320)
  replyTo!: string;

  @IsBoolean()
  welcomeEnabled!: boolean;
}
