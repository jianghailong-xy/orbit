import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsString, ValidateNested } from 'class-validator';
import { LINK_PREVIEW_KINDS, LINK_PREVIEW_MAX_REFS, type LinkPreviewKind } from '@orbit/shared';

export class LinkPreviewRefDto {
  @IsIn(LINK_PREVIEW_KINDS) kind!: LinkPreviewKind;
  // A string and nothing more: an id that names nothing is answered `unavailable`, like one that
  // names somebody else's object, so it must not be refused here as a malformed request. Hence not
  // `@IsPublicId`; the service decodes it (see DECODED_BY_THE_SERVICE in public-id-body-coverage.spec.ts).
  @IsString() id!: string;
}

export class LinkPreviewsDto {
  @IsArray() @ArrayMaxSize(LINK_PREVIEW_MAX_REFS)
  @ValidateNested({ each: true }) @Type(() => LinkPreviewRefDto)
  refs!: LinkPreviewRefDto[];
}
