import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsPublicId } from '../common/public-id';

// A folder's name is judged after its surrounding whitespace is dropped, so "  Notes " is stored
// as "Notes" and a name of spaces alone is refused as empty (docs/session-folders-move-design.md
// §3.2). MaxLength counts a surrogate pair as one character, so 60 is 60 as a person counts them.
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateSessionFolderDto {
  /** The workspace the folder belongs to: the caller's own, and not deleted. */
  @IsPublicId() workspaceId!: string;
  @Transform(trimmed) @IsString() @MinLength(1) @MaxLength(60) name!: string;
}

export class RenameSessionFolderDto {
  @Transform(trimmed) @IsString() @MinLength(1) @MaxLength(60) name!: string;
}
