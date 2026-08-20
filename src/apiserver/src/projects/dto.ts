import {
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
} from 'class-validator';
import { ProjectAutomationPolicy, ProjectStatus } from '@orbit/shared';
import { IsPublicId } from '../common/public-id';

const PROJECT_STATUSES = Object.values(ProjectStatus);
const PROJECT_AUTOMATION_POLICIES = Object.values(ProjectAutomationPolicy);

/**
 * Bounds on a project's prose fields.
 *
 * Same reasoning as `MAX_TASK_LIST_INSTRUCTIONS_CHARS`, and the same number for `instructions`:
 * these are meant to be spliced into a prompt eventually, and an oversized value accepted here
 * would fail far from the edit that caused it. `goal` and `acceptanceCriteria` are capped lower
 * because a goal that needs four thousand characters is not a goal — it is the project.
 */
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 10_000;
export const MAX_PROJECT_GOAL_CHARS = 4_000;
export const MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS = 4_000;

/**
 * Bounds on the two budgets.
 *
 * Both are the owner's own numbers, so the bounds are generous rather than opinionated — they are
 * here to catch the value nobody meant (a pasted timestamp, an extra zero) at the edit that made
 * it, instead of letting it be stored as a limit that never limits anything. A cap of one is the
 * lowest that still admits work; zero would spell "run nothing", which is what
 * `coordinatorEnabled: false` and MANUAL already spell, with a state a reader can tell apart.
 */
export const MAX_PROJECT_CONCURRENT_TASKS = 100;
export const MAX_PROJECT_SESSION_BUDGET_PER_DAY = 10_000;

/**
 * Validate this field when the caller SENT it — including when what they sent was `null`.
 *
 * `@IsOptional()` skips `undefined` and `null` alike, which is right for a field whose `null`
 * means "clear it" and wrong for one whose column is NOT NULL: the value sails past every
 * validator on the property and reaches Prisma, which rejects it as a client validation error
 * with no status and no code — a 500 for a request that was simply invalid (validation 04, P1-05).
 *
 * Omission stays optional, which is the distinction being drawn: not sending a field means "leave
 * it alone", sending `null` means "make it null", and only the second is a claim about the value.
 * A field that CAN be nulled (`sessionBudgetPerDay`, the prose fields) keeps `@IsOptional()`.
 */
function IsSent(): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined);
}

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  title!: string;

  /** What this project is trying to achieve. */
  @IsOptional() @IsString() @MaxLength(MAX_PROJECT_GOAL_CHARS) goal?: string;
  /** What would settle that the goal was reached. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string;
  /** How this project's work is to be done. Recorded only — nothing assembles it into a run
   *  prompt in this phase (see the Project model). */
  @IsOptional() @IsString() @MaxLength(MAX_PROJECT_INSTRUCTIONS_CHARS) instructions?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  /** null clears the field, as on the task list's `instructions`: blank and absent must not be
   *  two different stored states. */
  @IsOptional() @IsString() @MaxLength(MAX_PROJECT_GOAL_CHARS) goal?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS)
  acceptanceCriteria?: string | null;
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PROJECT_INSTRUCTIONS_CHARS)
  instructions?: string | null;
  /** Where the work stands: OPEN, DONE (the goal was reached) or CANCELLED (it will not be). Not
   *  a filing state — moving a project out of somebody's way is a separate concern that must not
   *  be spelled by overwriting what happened to the work. */
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;

  // ── What the project's coordinator is allowed to do ────────────────────────────────────────
  // The four fields below are the authorization set: they are the only fields whose value decides
  // whether an action the coordinator wants to take may happen. Writing any of them bumps
  // `configRevision` by one (see ProjectsService.update), which is what makes a revoke that races
  // an action readable afterwards. Everything else on this DTO is prose or filing.

  /** Whether the coordinator may act at all. Turning it ON requires `automationPolicy` in the same
   *  request: "carry on with the safe default" is spelled by not sending this at all, so switching
   *  a project into automation is a choice someone made rather than one it inherited. */
  @IsSent() @IsBoolean() coordinatorEnabled?: boolean;
  /** How far it may go when it runs: MANUAL, GUARDED_AUTO or AUTO. */
  @IsSent() @IsIn(PROJECT_AUTOMATION_POLICIES) automationPolicy?: ProjectAutomationPolicy;
  /** How many of this project's tasks may be in flight at once. An admission limit: lowering it
   *  never stops anything already running. */
  @IsSent() @IsInt() @Min(1) @Max(MAX_PROJECT_CONCURRENT_TASKS) maxConcurrentTasks?: number;
  /** How many sessions the coordinator itself may start in a rolling 24h. `null` clears the limit;
   *  sessions a person starts are never counted by it. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PROJECT_SESSION_BUDGET_PER_DAY)
  sessionBudgetPerDay?: number | null;

  /** Which agent coordinates this project — the identity that outlives every coordinator SESSION.
   *  `null` removes it. Not part of the authorization set above: it says WHO decides, not what a
   *  decider is permitted to do, and the two are revoked and audited separately. */
  @IsOptional() @IsPublicId() coordinatorAgentId?: string | null;
}

export class OpenProjectCoordinatorDto {
  /**
   * Where to run the conversation. Optional: it falls back to the workspace most of this project's
   * tasks already run in.
   *
   * On a project that already HAS a coordinator this is not a request to move it — a value that
   * differs from where the binding was made is a 409, so passing one is a way of stating which
   * workspace you believed you were opening, not of changing it.
   */
  @IsOptional() @IsPublicId() workspaceId?: string;
}
