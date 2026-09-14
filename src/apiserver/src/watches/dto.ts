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
import {
  WATCH_ACTIONS,
  WATCH_MODES,
  WATCH_RESOURCE_KINDS,
  type WatchAction,
  type WatchMode,
  type WatchResourceKind,
} from '@orbit/shared';
import { IsPublicId } from '../common/public-id';

export class WatchTargetRefDto {
  @IsIn(WATCH_RESOURCE_KINDS)
  kind!: WatchResourceKind;

  @IsPublicId()
  id!: string;
}

// `predicateVersion`, `predicate`, the target count, the target kinds, the TTL range and a CONTINUOUS
// watch's debounce and wake budget ranges are left to WatchesService on purpose: each has a refusal
// code in contracts/watch.contract.json, and a class-validator message cannot carry one. `@Allow()`
// only keeps the whitelist from stripping them.
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
  @IsIn(WATCH_MODES)
  mode?: WatchMode;

  @IsOptional()
  @IsInt()
  debounceSeconds?: number;

  @IsOptional()
  @IsInt()
  wakeBudget?: number;

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

/**
 * A watch an agent asks for from inside its session (RunnerWatchesController). CreateWatchDto's fields
 * without the observer, which is the session asking, so no field can name another; the action defaults
 * to waking that session.
 */
export class RunnerCreateWatchDto {
  @Allow()
  predicateVersion?: unknown;

  @Allow()
  predicate?: unknown;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WatchTargetRefDto)
  targets!: WatchTargetRefDto[];

  @IsOptional()
  @IsIn(WATCH_ACTIONS)
  action?: WatchAction;

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
