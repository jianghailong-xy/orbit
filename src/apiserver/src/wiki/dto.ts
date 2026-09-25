import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WIKI_DECIDE_ACTIONS, WIKI_REJECT_REASONS, type WikiDecideAction, type WikiRejectReason } from '@orbit/shared';
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
}

/** PATCH /api/wiki/spaces/:id — the two settings phase 1 reads (§2.1 settings). */
export class UpdateWikiSpaceDto {
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @IsOptional()
  @IsBoolean()
  autoAcceptReinforce?: boolean;

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

/** The owner's answer to one pending op, or to several of one changeset in one call. */
export class WikiDecideDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => WikiOpDecisionDto)
  decisions!: WikiOpDecisionDto[];
}
