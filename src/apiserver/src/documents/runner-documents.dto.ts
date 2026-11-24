import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';
import { DOCUMENTS_SYNC_FAILED_MAX, DOCUMENTS_SYNC_STATUSES, type DocumentsSyncStatus } from './documents-syncs.service';

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

/** `POST /runner/drive/syncs`: an agent's directory sync starts (docs/documents-directory-sync-design.md S4). */
export class RunnerDocumentsSyncOpenDto {
  /** The local directory's last segment, never a whole runner path. */
  @IsString() @MaxLength(255) @Matches(/^[^/]+$/, { message: 'sourceName is one path segment' }) sourceName!: string;
  @IsString() @MaxLength(4096) destPath!: string;
  @IsOptional() @IsPublicId() sessionId?: string;
}

export class RunnerDocumentsSyncFailureDto {
  @IsString() @MaxLength(4096) path!: string;
  @IsString() @MaxLength(500) error!: string;
}

/** `PATCH /runner/drive/syncs/:id`: the counts as they are now. An ending status ends the sync. */
export class RunnerDocumentsSyncReportDto {
  @IsIn(DOCUMENTS_SYNC_STATUSES) status!: DocumentsSyncStatus;
  @IsOptional() @IsInt() @Min(0) filesSeen?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() @Min(0) filesTotal?: number | null;
  @IsOptional() @IsInt() @Min(0) filesDone?: number;
  @IsOptional() @IsInt() @Min(0) filesSame?: number;
  @IsOptional() @IsInt() @Min(0) filesDeleted?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() @Min(0) bytesTotal?: number | null;
  @IsOptional() @IsInt() @Min(0) bytesSent?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(4096) currentPath?: string | null;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsPublicId() destEntryId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(DOCUMENTS_SYNC_FAILED_MAX) @ValidateNested({ each: true }) @Type(() => RunnerDocumentsSyncFailureDto)
  failed?: RunnerDocumentsSyncFailureDto[];
  @IsOptional() @IsInt() @Min(0) failedCount?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(1000) error?: string | null;
}
