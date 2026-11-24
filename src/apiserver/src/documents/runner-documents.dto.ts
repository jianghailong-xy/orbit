import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';

/**
 * The bodies of the runner drive door (docs/documents-drive-technical-design.md §4.2). An entry is named by its drive
 * path (`/Proj/r.md`, from the drive's root) or by its id; the owner is always the credential's.
 */

/** Who a write comes from (§3.6, §5.8): the session is kept only when it is the owner's and runs on this runner. */
export class RunnerDocumentsWriterDto {
  @IsOptional() @IsPublicId() sessionId?: string;
  /** Which burst of deletes a delete joins (§3.4); a mount that sends none gets its own 2 s window. */
  @IsOptional() @IsString() @MaxLength(200) burstKey?: string;
}

class WithWriter {
  @IsOptional() @ValidateNested() @Type(() => RunnerDocumentsWriterDto) writer?: RunnerDocumentsWriterDto;
}

/** An entry by its path or its id. */
class NamesEntry extends WithWriter {
  @IsOptional() @IsString() @MaxLength(4096) path?: string;
  @IsOptional() @IsPublicId() id?: string;
}

/** `POST /runner/documents/create`: a new file with an empty first version, bound to the handle that will fill it (§3.1). */
export class RunnerDocumentsCreateDto extends WithWriter {
  @IsString() @MaxLength(4096) path!: string;
  @IsOptional() @IsUUID() handleId?: string;
}

/** `POST /runner/documents/mkdir`: with `parents`, `mkdir -p`. */
export class RunnerDocumentsMkdirDto extends WithWriter {
  @IsString() @MaxLength(4096) path!: string;
  @IsOptional() @IsBoolean() parents?: boolean;
}

/** `POST /runner/documents/stagings`: a staging for the write of one handle or one tool call. */
export class RunnerDocumentsStagingDto {
  @IsPublicId() entryId!: string;
}

/** `POST /runner/documents/stagings/:id/keepalive`: the handle still holds bytes no commit has taken (§8.1). */
export class RunnerDocumentsKeepaliveDto {
  @IsOptional() @IsBoolean() dirty?: boolean;
}

/** `POST /runner/documents/commit` (§3.1): the chunk list is checked by the name layer itself. */
export class RunnerDocumentsCommitDto extends WithWriter {
  @IsString() @MaxLength(200) commitId!: string;
  @IsPublicId() entryId!: string;
  @IsOptional() @IsUUID() handleId?: string;
  @IsIn(['OVERWRITE', 'APPEND', 'CONTINUE']) mode!: 'OVERWRITE' | 'APPEND' | 'CONTINUE';
  @IsOptional() @IsPublicId() baseVersionId?: string;
  @IsOptional() @IsInt() @Min(0) baseSize?: number;
  @IsArray() chunks!: Array<{ idx: number; sha256: string; size: number }>;
  @IsOptional() @IsObject() replaceTail?: { idx: number; oldSha256: string };
  @IsOptional() @IsPublicId() stagingId?: string;
}

/** `POST /runner/documents/rename`: `from` (or `id`) to the path `to`; onto a file it makes a version of it, unless `noReplace`. */
export class RunnerDocumentsRenameDto extends WithWriter {
  @IsOptional() @IsString() @MaxLength(4096) from?: string;
  @IsOptional() @IsPublicId() id?: string;
  @IsString() @MaxLength(4096) to!: string;
  @IsOptional() @IsBoolean() noReplace?: boolean;
}

/** `POST /runner/documents/delete`: to the owner's Trash, which no agent sees (D11). */
export class RunnerDocumentsDeleteDto extends NamesEntry {}

/** `POST /runner/documents/utimens`. */
export class RunnerDocumentsUtimensDto extends NamesEntry {
  @IsDateString() mtime!: string;
}
