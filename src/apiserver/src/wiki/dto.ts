import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  WIKI_DECIDE_ACTIONS,
  WIKI_MAINTENANCE_DAILY_RUN_LIMIT,
  WIKI_MAINTENANCE_LOOKBACK_DAYS,
  WIKI_REJECT_REASONS,
  WIKI_REVIEW_MODES,
  type WikiDecideAction,
  type WikiRejectReason,
  type WikiReviewMode,
} from '@orbit/shared';
import { IsPublicId } from '../common/public-id';

/**
 * The bodies the two wiki doors take (contracts/wiki.contract.json `agentSurface.doors`).
 *
 * `ops`, `entry`, `changes`, `edited`, `sources` and `rationale` are deliberately `@Allow()`d and left
 * to WikiService: each has a refusal code in the contract (WIKI_SCHEMA reports every failing field by
 * path, which a class-validator message cannot carry), and `@Allow()` only keeps the whitelist from
 * stripping them. Everything below is checked here: what is left has no code of its own, and a 400
 * naming the field is the honest answer for it.
 */

/**
 * `maintenance` in PATCH /api/wiki/spaces/:id, and in POST /api/wiki/spaces (contract
 * `space.settings.maintenance`): any of the four the owner sets. Declared before the two bodies that
 * carry it, whose decorator metadata names it as they are defined. `listId` is the server's and is not a field here — the whitelist drops it,
 * as it drops `provider`, which a client that predates server execution still sends and nothing runs on.
 */
export class WikiMaintenanceSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** The workspace the runs take place in; null clears it (and maintenance cannot then be on). */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsPublicId()
  workspaceId?: string | null;

  /** How many maintenance runs the space may make in one UTC day (contract `space.settings.maintenance.bounds`). */
  @IsOptional()
  @IsInt()
  @Min(WIKI_MAINTENANCE_DAILY_RUN_LIMIT.min)
  @Max(WIKI_MAINTENANCE_DAILY_RUN_LIMIT.max)
  dailyRunLimit?: number;

  /** How many days back the cursor starts when maintenance is turned on; null is all of history. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(WIKI_MAINTENANCE_LOOKBACK_DAYS.min)
  @Max(WIKI_MAINTENANCE_LOOKBACK_DAYS.max)
  lookbackDays?: number | null;
}

/** POST /api/wiki/spaces — the owner's own space, for a codebase or for nothing in particular. */
export class CreateWikiSpaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  /** The repository as the owner states it; normalized on the way in (§2.1). */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  repoUrl?: string;

  /** Left out, the slug is derived from the repository and, with none, from the title. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string;

  /**
   * The space's Wiki maintenance from the start (contract `space.settings.maintenance`), as a PATCH sets
   * it: a space created with a maintenance workspace has its plan's first draft made at once (contract
   * `plan.jobs.trigger`). The owner channel's alone, like the PATCH.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => WikiMaintenanceSettingsDto)
  maintenance?: WikiMaintenanceSettingsDto;
}

/** PATCH /api/wiki/spaces/:id — the owner's settings (§2.1 settings, contract `space.settings`). */
export class UpdateWikiSpaceDto {
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @IsOptional()
  @IsBoolean()
  autoAcceptReinforce?: boolean;

  /** The owner channel's alone: a request that carries a session header is refused WIKI_OWNER_CHANNEL_ONLY. */
  @IsOptional()
  @IsIn(WIKI_REVIEW_MODES)
  reviewMode?: WikiReviewMode;

  /** Whether an Automatic space sends its owner spot checks at all. The owner channel's alone, like the mode. */
  @IsOptional()
  @IsBoolean()
  automaticSpotChecks?: boolean;

  /** The space's Wiki maintenance run. The owner channel's alone, like the mode: WIKI_OWNER_CHANNEL_ONLY otherwise. */
  @IsOptional()
  @ValidateNested()
  @Type(() => WikiMaintenanceSettingsDto)
  maintenance?: WikiMaintenanceSettingsDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;
}

/** POST /api/wiki/spaces/:id/workspaces — binding a workspace the owner named (§2.1 binding). */
export class BindWikiWorkspaceDto {
  @IsPublicId()
  workspaceId!: string;
}

/**
 * POST /api/wiki/spaces/:id/changesets (the owner's own write) and POST /api/runner/wiki/changesets
 * (an agent's proposal). One body, because it is one entry point underneath (§4.1).
 */
export class WikiProposeDto {
  @Allow()
  ops?: unknown;

  @Allow()
  rationale?: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /**
   * The space to propose into, for a HEADLESS runner call: no calling session means no workspace, and
   * so nothing to derive the space from. A call that names a session leaves this out — the session's
   * bound workspace decides, and a body field may never widen what that session can reach.
   */
  @IsOptional()
  @IsPublicId()
  spaceId?: string;
}

/** One op's answer in `POST /api/wiki/changesets/:id/decide` (contract `effectPolicy.decide`). */
export class WikiOpDecisionDto {
  @IsPublicId()
  opId!: string;

  @IsIn(WIKI_DECIDE_ACTIONS)
  action!: WikiDecideAction;

  /** `edit`: the owner's version, shaped as an amend's changes over the proposal. */
  @Allow()
  edited?: unknown;

  /** `reject`: the closed set Review shows as Not true / Not useful / Duplicate / Too specific. */
  @IsOptional()
  @IsIn(WIKI_REJECT_REASONS)
  reason?: WikiRejectReason;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string;
}

/**
 * POST /api/wiki/entries/:id/reject — the owner's Reject of an entry a review mode applied and nobody
 * has confirmed (contract `reviewModes.entryReject`). The reason is checked by the service too, so
 * the contract's WIKI_SCHEMA answer is the one a caller that sends none is given.
 */
export class WikiEntryRejectDto {
  @IsOptional()
  @IsIn(WIKI_REJECT_REASONS)
  reason?: WikiRejectReason;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string;
}

/** The owner's answer to one pending op, or to several of one changeset in one call. */
export class WikiDecideDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => WikiOpDecisionDto)
  decisions!: WikiOpDecisionDto[];
}
