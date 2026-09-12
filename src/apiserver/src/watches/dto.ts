import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WATCH_ACTIONS, WATCH_RESOURCE_KINDS, type WatchAction, type WatchResourceKind } from '@orbit/shared';
import { IsPublicId } from '../common/public-id';

export class WatchTargetRefDto {
  @IsIn(WATCH_RESOURCE_KINDS)
  kind!: WatchResourceKind;

  @IsPublicId()
  id!: string;
}

// `predicateVersion`, `predicate`, the target count, the target kinds and the TTL range are left to
// WatchesService on purpose: each has a refusal code in contracts/watch.contract.json, and a
// class-validator message cannot carry one. `@Allow()` only keeps the whitelist from stripping them.
export class CreateWatchDto {
  @Allow()
  predicateVersion?: unknown;

  @Allow()
  predicate?: unknown;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WatchTargetRefDto)
  targets!: WatchTargetRefDto[];

  @IsIn(WATCH_ACTIONS)
  action!: WatchAction;

  @IsOptional()
  @IsIn(['ONE_SHOT'], {
    message: 'mode must be ONE_SHOT: a CONTINUOUS watch needs a debounce and a delivery budget this build does not serve',
  })
  mode?: 'ONE_SHOT';

  @IsOptional()
  @IsPublicId()
  observerSessionId?: string;

  @IsOptional()
  @IsInt()
  ttlSeconds?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  idempotencyKey?: string;
}

export class UpdateWatchDto {
  @Allow()
  predicateVersion?: unknown;

  @Allow()
  predicate?: unknown;

  @IsOptional()
  @IsInt()
  ttlSeconds?: number;
}
