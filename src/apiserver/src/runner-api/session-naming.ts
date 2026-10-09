import { IsString, MaxLength } from 'class-validator';

/** The title the engine running a session gave it (runner-go `reportSessionNaming`). */
export class SessionNamingDto {
  /** The title the claim carried, which the session must still read for this one to land. */
  @IsString()
  @MaxLength(1_000)
  replaces!: string;

  /** The engine's title: kept to one line and capped like every title (sanitizeTitle). */
  @IsString()
  @MaxLength(1_000)
  title!: string;
}
