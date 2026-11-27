import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { IsPublicId } from '../common/public-id';

/** The layers a PUT may set. Which of them a link has depends on its root (share-link.ts
 *  LAYER_DEFAULTS); the service refuses one the root does not have. */
export class ShareLinkIncludeDto {
  @IsOptional() @IsBoolean() taskPages?: boolean;
  @IsOptional() @IsBoolean() commentsAndFiles?: boolean;
  @IsOptional() @IsBoolean() conversations?: boolean;
  @IsOptional() @IsBoolean() toolOutput?: boolean;
  @IsOptional() @IsBoolean() footnotes?: boolean;
}

/**
 * `PUT /{sessions|tasks|projects|wiki/spaces}/:id/share`: open the link, or change the one that is
 * open. Both fields are optional and a field left out is left as it is; `expiresAt: null` means Never.
 */
export class PutShareLinkDto {
  @IsOptional() @ValidateNested() @Type(() => ShareLinkIncludeDto) include?: ShareLinkIncludeDto;
  @IsOptional() @IsDateString() expiresAt?: string | null;
}

/** `POST /share-links/turn-off`: end these links (Settings → Shared links, "Turn off these N").
 *  An id that is not one of the caller's links, or is already ended, is passed over. */
export class TurnOffShareLinksDto {
  @IsArray() @ArrayMaxSize(1000) @IsPublicId({ each: true }) shareLinkIds!: string[];
}

/**
 * `POST /share-links`: share one drive file, pinned to its current version (docs/drive-technical-design.md §9).
 * Posting again for a file that is already shared moves its link to the file's current version ("Share this version").
 */
export class ShareDriveFileDto {
  @IsIn(['DRIVE_FILE']) kind!: 'DRIVE_FILE';
  @IsPublicId() driveEntryId!: string;
  @IsOptional() @IsDateString() expiresAt?: string | null;
}
