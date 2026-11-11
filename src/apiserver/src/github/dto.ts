import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `PUT /admin/integrations/github` (docs/github-workspace-design.md §5.1). */
export class UpdateGithubAppDto {
  @IsBoolean()
  enabled!: boolean;

  /** GitHub's numeric App ID, as a string or a number. */
  @Transform(({ value }) => (typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^[1-9][0-9]{0,17}$/, { message: 'appId must be the numeric App ID' })
  appId!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  clientId!: string;

  /** Omit to keep the saved secret. It is never read back. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  clientSecret?: string;

  /** The PEM GitHub generated. Omit to keep the saved key. It is never read back. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  privateKey?: string;
}
