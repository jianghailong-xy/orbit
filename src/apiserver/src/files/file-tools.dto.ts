import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { IsPublicId } from '../common/public-id';
import { MAX_BUNDLE_FILES, MAX_BUNDLE_PATH_CHARS, MAX_FILE_LABEL_CHARS } from './files.service';
import { TEST_REPORT_UPLOAD } from './test-report';

/**
 * Text a row keeps: a NUL reaches Postgres as an error after the bytes are stored, so it is refused at the door with the
 * rest of the control characters.
 */
// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARACTERS = /^[^\x00-\x1f\x7f]*$/;

/** The text fields beside the file of `POST /runner/sessions/:id/files`. */
export class UploadFileDto {
  /** The task this session is running: FilesService.uploadFile refuses any other. */
  @IsOptional()
  @IsPublicId()
  taskId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FILE_LABEL_CHARS)
  @Matches(NO_CONTROL_CHARACTERS, { message: 'label must not hold control characters' })
  label?: string;

  /** Read this file as a test report, and keep what it says with it (FilesService.uploadFile). */
  @IsOptional()
  @IsIn([TEST_REPORT_UPLOAD])
  as?: typeof TEST_REPORT_UPLOAD;
}

export class FileBundleEntryDto {
  /** Relative to the folder, with / between its parts. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_BUNDLE_PATH_CHARS)
  path!: string;

  @IsPublicId()
  id!: string;
}

/** The body of `POST /runner/sessions/:id/file-bundles`: a folder's files, already uploaded. */
export class CreateFileBundleDto {
  /** The folder's own name, not a path; the manifest is kept as `<name>.json`. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  // eslint-disable-next-line no-control-regex
  @Matches(/^[^/\\\x00-\x1f\x7f]*$/, { message: 'name must be one folder name' })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FILE_LABEL_CHARS)
  @Matches(NO_CONTROL_CHARACTERS, { message: 'label must not hold control characters' })
  label?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BUNDLE_FILES)
  @ValidateNested({ each: true })
  @Type(() => FileBundleEntryDto)
  files!: FileBundleEntryDto[];
}
