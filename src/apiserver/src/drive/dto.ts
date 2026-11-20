import { IsIn, IsOptional, IsString } from 'class-validator';
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
