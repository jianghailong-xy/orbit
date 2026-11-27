import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
import { DRIVE_SYNC_FAILED_MAX, DRIVE_SYNC_STATUSES, type DriveSyncStatus } from './drive-syncs.service';

/**
 * The bodies of the runner drive door (docs/drive-technical-design.md §4.2). An entry is named by its drive
 * path (`/Proj/r.md`, from the drive's root) or by its id; the owner is always the credential's.
 */

/** Who a write comes from (§3.6, §5.8): the session is kept only when it is the owner's and runs on this runner. */
export class RunnerDriveWriterDto {
  @IsOptional() @IsPublicId() sessionId?: string;
  /** Which burst of deletes a delete joins (§3.4); a mount that sends none gets its own 2 s window. */
  @IsOptional() @IsString() @MaxLength(200) burstKey?: string;
}

class WithWriter {
  @IsOptional() @ValidateNested() @Type(() => RunnerDriveWriterDto) writer?: RunnerDriveWriterDto;
}

/** An entry by its path or its id. */
class NamesEntry extends WithWriter {
  @IsOptional() @IsString() @MaxLength(4096) path?: string;
  @IsOptional() @IsPublicId() id?: string;
}

/** `POST /runner/drive/create`: a new file with an empty first version, bound to the handle that will fill it (§3.1). */
export class RunnerDriveCreateDto extends WithWriter {
  @IsString() @MaxLength(4096) path!: string;
  @IsOptional() @IsUUID() handleId?: string;
}

/** `POST /runner/drive/mkdir`: with `parents`, `mkdir -p`. */
export class RunnerDriveMkdirDto extends WithWriter {
  @IsString() @MaxLength(4096) path!: string;
  @IsOptional() @IsBoolean() parents?: boolean;
}

/**
 * `POST /runner/drive/stagings`: a staging for the write of one handle or one tool call, or with no entry a batch's, whose
 * chunks one `POST /runner/drive/batch` commits into several files.
 */
export class RunnerDriveStagingDto {
  @IsOptional() @IsPublicId() entryId?: string;
}

/** A chunk by its content: what `chunks/held` is asked about. */
export class RunnerDriveChunkRefDto {
  @Matches(/^[0-9a-f]{64}$/, { message: 'sha256 is 64 lowercase hex characters' }) sha256!: string;
  @IsInt() @Min(1) size!: number;
}

/** `POST /runner/drive/chunks/held`: which of these chunks this account already holds. */
export class RunnerDriveHeldDto {
  @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => RunnerDriveChunkRefDto)
  chunks!: RunnerDriveChunkRefDto[];
}

/** One file of a batch: its path, its whole content as held chunks, and its modification time. */
export class RunnerDriveBatchItemDto {
  @IsString() @MaxLength(4096) path!: string;
  @IsString() @MaxLength(200) commitId!: string;
  @IsArray() chunks!: Array<{ idx: number; sha256: string; size: number }>;
  @IsOptional() @IsDateString() mtime?: string;
}

/**
 * `POST /runner/drive/batch`: several files written in one request, each made or overwritten with content the account
 * holds (sent to `stagingId`, or already in Drive). Each file is its own commit, answered on its own.
 */
export class RunnerDriveBatchDto extends WithWriter {
  @IsOptional() @IsPublicId() stagingId?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RunnerDriveBatchItemDto)
  items!: RunnerDriveBatchItemDto[];
}

/** `POST /runner/drive/stagings/:id/keepalive`: the handle still holds bytes no commit has taken (§8.1). */
export class RunnerDriveKeepaliveDto {
  @IsOptional() @IsBoolean() dirty?: boolean;
}

/** `POST /runner/drive/commit` (§3.1): the chunk list is checked by the name layer itself. */
export class RunnerDriveCommitDto extends WithWriter {
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

/** `POST /runner/drive/rename`: `from` (or `id`) to the path `to`; onto a file it makes a version of it, unless `noReplace`. */
export class RunnerDriveRenameDto extends WithWriter {
  @IsOptional() @IsString() @MaxLength(4096) from?: string;
  @IsOptional() @IsPublicId() id?: string;
  @IsString() @MaxLength(4096) to!: string;
  @IsOptional() @IsBoolean() noReplace?: boolean;
}

/** `POST /runner/drive/delete`: to the owner's Trash, which no agent sees (D11). */
export class RunnerDriveDeleteDto extends NamesEntry {}

/** `POST /runner/drive/utimens`. */
export class RunnerDriveUtimensDto extends NamesEntry {
  @IsDateString() mtime!: string;
}

/** `POST /runner/drive/syncs`: an agent's directory sync starts (docs/drive-directory-sync-design.md S4). */
export class RunnerDriveSyncOpenDto {
  /** The local directory's last segment, never a whole runner path. */
  @IsString() @MaxLength(255) @Matches(/^[^/]+$/, { message: 'sourceName is one path segment' }) sourceName!: string;
  @IsString() @MaxLength(4096) destPath!: string;
  @IsOptional() @IsPublicId() sessionId?: string;
}

export class RunnerDriveSyncFailureDto {
  @IsString() @MaxLength(4096) path!: string;
  @IsString() @MaxLength(500) error!: string;
}

/** `PATCH /runner/drive/syncs/:id`: the counts as they are now. An ending status ends the sync. */
export class RunnerDriveSyncReportDto {
  @IsIn(DRIVE_SYNC_STATUSES) status!: DriveSyncStatus;
  @IsOptional() @IsInt() @Min(0) filesSeen?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() @Min(0) filesTotal?: number | null;
  @IsOptional() @IsInt() @Min(0) filesDone?: number;
  @IsOptional() @IsInt() @Min(0) filesSame?: number;
  @IsOptional() @IsInt() @Min(0) filesDeleted?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() @Min(0) bytesTotal?: number | null;
  @IsOptional() @IsInt() @Min(0) bytesSent?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(4096) currentPath?: string | null;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsPublicId() destEntryId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(DRIVE_SYNC_FAILED_MAX) @ValidateNested({ each: true }) @Type(() => RunnerDriveSyncFailureDto)
  failed?: RunnerDriveSyncFailureDto[];
  @IsOptional() @IsInt() @Min(0) failedCount?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(1000) error?: string | null;
}
