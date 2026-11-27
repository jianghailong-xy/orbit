import { IsInt, IsIn, IsOptional, IsString, Min } from 'class-validator';
import { IsPublicId } from '../common/public-id';

/** `POST /drive/folders`: a new folder; a name already taken in the folder gets a suffix (§3.5). */
export class CreateDriveFolderDto {
  /** The folder it goes in; the root when absent. */
  @IsOptional() @IsPublicId() parentId?: string;
  @IsString() name!: string;
}

/** `PATCH /drive/entries/:id`: rename and/or move. A taken name is refused, never overwritten (§4.1). */
export class UpdateDriveEntryDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsPublicId() parentId?: string;
}

/** `POST /drive/versions/:id/restore` (board choice c). */
export class RestoreDriveVersionDto {
  @IsIn(['CURRENT', 'COPY']) as!: 'CURRENT' | 'COPY';
}

/** `POST /drive/chats/:sessionId/questions/:id`: the owner's answer to a Drive chat's overwrite question. */
export class AnswerDriveChatQuestionDto {
  @IsIn(['KEEP_BOTH', 'REPLACE'], { message: 'choice is KEEP_BOTH or REPLACE' }) choice!: 'KEEP_BOTH' | 'REPLACE';
}

/** `POST /drive/uploads`: open a resumable upload (§4.1). */
export class OpenDriveUploadDto {
  /** The folder it lands in; the root when absent. */
  @IsOptional() @IsPublicId() parentId?: string;
  @IsString() name!: string;
  /** The whole file's size in bytes. */
  @IsInt() @Min(0) size!: number;
  /** A dropped file's path within the dropped folder, `Dir/sub/name`. */
  @IsOptional() @IsString() relativePath?: string;
  /** The folder an earlier file of the same drop answered, so the whole drop shares one top folder. */
  @IsOptional() @IsPublicId() dropRootId?: string;
}

/** `POST /drive/entries/:id/download-link`: a URL the browser downloads from itself, for the current version or `versionId`. */
export class DriveDownloadLinkDto {
  /** A version of this file; its current one when absent. */
  @IsOptional() @IsPublicId() versionId?: string;
}
