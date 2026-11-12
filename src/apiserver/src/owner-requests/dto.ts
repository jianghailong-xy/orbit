import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmpty,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';
import {
  MAX_OWNER_REQUEST_IF_UNANSWERED,
  MAX_OWNER_REQUEST_NOTE,
  MAX_OWNER_REQUEST_OPTIONS,
  MAX_OWNER_REQUEST_STEPS,
  MAX_OWNER_REQUEST_TITLE,
  MAX_OWNER_REQUEST_VERIFY_HINT,
  MAX_OWNER_REQUEST_WHY,
  OWNER_REQUEST_KINDS,
  type OwnerRequestKind,
} from './owner-request';

export class OwnerRequestOptionDto {
  @IsString() @MinLength(1) @MaxLength(200) label!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class OwnerRequestStepDto {
  @IsString() @MinLength(1) @MaxLength(1_000) text!: string;
  @IsOptional() @IsString() @MaxLength(2_000) command?: string;
  @IsOptional() @IsString() @MaxLength(2_000) link?: string;
}

/**
 * Where a secret goes. The value itself is refused here: it never travels with the request. The runner is the asking
 * session's own (design §4.1); `runnerId` is accepted only as a stale caller's assertion of that one.
 */
export class OwnerRequestSecretSpecDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsPublicId() runnerId?: string;
  @IsOptional() @IsString() @MaxLength(200) envVar?: string;
  @IsOptional() @IsString() @MaxLength(1_000) filePath?: string;
  @IsEmpty({ message: 'a secret request never carries the secret value; the owner provides it' })
  value?: unknown;
}

/** A session filing a request (`POST /runner/owner-requests`). Per-kind rules are `normalizeOwnerRequest`'s. */
export class FileOwnerRequestDto {
  @IsIn(OWNER_REQUEST_KINDS) kind!: OwnerRequestKind;
  /** Every kind's but WIKI_CREATE's, whose title Orbit writes (`normalizeOwnerRequest` holds each kind to it). */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(MAX_OWNER_REQUEST_TITLE) title?: string;
  @IsString() @MinLength(1) @MaxLength(MAX_OWNER_REQUEST_WHY) why!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsPublicId({ each: true }) blocksTaskIds?: string[];
  @IsOptional() @IsString() @MaxLength(MAX_OWNER_REQUEST_IF_UNANSWERED) ifUnanswered?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_OWNER_REQUEST_OPTIONS)
  @ValidateNested({ each: true }) @Type(() => OwnerRequestOptionDto)
  options?: OwnerRequestOptionDto[];
  @IsOptional() @IsInt() @Min(0) @Max(MAX_OWNER_REQUEST_OPTIONS - 1) recommendedOption?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_OWNER_REQUEST_STEPS)
  @ValidateNested({ each: true }) @Type(() => OwnerRequestStepDto)
  steps?: OwnerRequestStepDto[];
  @IsOptional() @ValidateNested() @Type(() => OwnerRequestSecretSpecDto) secretSpec?: OwnerRequestSecretSpecDto;
  @IsOptional() @IsString() @MaxLength(MAX_OWNER_REQUEST_VERIFY_HINT) verifyHint?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) clientRequestId?: string;
  @IsOptional() @IsPublicId() projectId?: string;
}

/** The owner marking a request done. A DECISION needs an option or words; the other kinds may add a note. */
export class CompleteOwnerRequestDto {
  @IsOptional() @IsInt() @Min(0) @Max(MAX_OWNER_REQUEST_OPTIONS - 1) option?: number;
  @IsOptional() @IsString() @MaxLength(4_000) text?: string;
}

/** The owner declining a request: the reason is required, because the asking session acts on it. */
export class DeclineOwnerRequestDto {
  @IsString() @MinLength(1) @MaxLength(MAX_OWNER_REQUEST_NOTE) reason!: string;
}

/** The asking session withdrawing its own request. */
export class WithdrawOwnerRequestDto {
  @IsOptional() @IsString() @MaxLength(MAX_OWNER_REQUEST_NOTE) reason?: string;
}

/**
 * The owner entering a SECRET request's value (`POST /owner-requests/:id/secret`): the value, optionally saved under a
 * label, or a saved secret's id. Validation messages here never quote what was sent.
 */
export class SubmitOwnerSecretDto {
  @IsOptional() @IsString({ message: 'value must be a string' }) @MaxLength(16_384, { message: 'the key may be at most 16384 characters' })
  value?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) saveAs?: string;
  @IsOptional() @IsPublicId() savedSecretId?: string;
}

/** Replacing a saved secret's value (`PUT /account-secrets/:id`). */
export class ReplaceAccountSecretDto {
  @IsString({ message: 'value must be a string' }) @MaxLength(16_384, { message: 'the key may be at most 16384 characters' })
  value!: string;
}

/** The runner's word on a delivery (`POST /runner/secret-grants/:id/ack`). Never carries the value. */
export class SecretGrantAckDto {
  @IsIn(['DELIVERED', 'FAILED']) outcome!: 'DELIVERED' | 'FAILED';
  @IsOptional() @IsString() @MaxLength(100) code?: string;
  @IsOptional() @IsString() @MaxLength(500) message?: string;
}

/** The runner's word that its copy is gone (`POST /runner/secret-grants/:id/removed`). */
export class SecretGrantRemovedDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
