import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
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
 * A `configRevision` as it travels: decimal digits, no sign, no separators.
 *
 * It is a `bigint` column and it is served as a STRING for that reason, so the validator has to be
 * a string one. `@IsInt()` would silently cap the value a caller can express at 2^53 and reject
 * the exact spelling the read endpoint hands them.
 */
export const CONFIG_REVISION_PATTERN = /^\d{1,20}$/;

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

  /**
   * The `configRevision` this edit was composed against. Sent, it is a compare-and-swap: the write
   * commits only if the project is still at that revision, and a 409 `STALE_CONFIG_REVISION`
   * otherwise, with nothing written.
   *
   * It exists because the authorization set is edited from several places at once — the web app,
   * the user API, a coordinator's own session — and last-write-wins on those four fields is not a
   * merge, it is one person silently undoing another's revoke. The revision is bumped by every
   * write of that set, so stating the one you read turns "I did not see your change" from an
   * outcome into a refusal.
   *
   * OPTIONAL, and that is the compatibility rule: a client that does not send it keeps the
   * behaviour it has always had (last write wins). Nothing existing breaks by adding it, and
   * nothing new has to guess a revision it has no way to know.
   */
  @IsOptional() @IsString() @Matches(CONFIG_REVISION_PATTERN, {
    message: 'expectedConfigRevision must be the decimal configRevision you read from the project',
  })
  expectedConfigRevision?: string;
}

/**
 * `POST /projects/:id/coordinator/trigger` — "look at this project now".
 *
 * Both fields are optional, and both are about being able to press a button twice safely: the
 * revision fences the request against a policy change the caller has not seen, and `triggerId`
 * makes a retry the SAME request rather than a second one.
 */
export class TriggerProjectCoordinatorDto {
  /** As on UpdateProjectDto: the revision this request was composed against, or nothing. */
  @IsOptional() @IsString() @Matches(CONFIG_REVISION_PATTERN, {
    message: 'expectedConfigRevision must be the decimal configRevision you read from the project',
  })
  expectedConfigRevision?: string;

  /**
   * This request's identity, in the id spelling everything else on this API uses (Base62, or the
   * raw UUID). Two calls carrying the same one are one request — the durable signal coalesces on
   * it — so a client that retries a timed-out POST does not queue a second coordination run.
   *
   * Omitted, the server allocates one and returns it, which is the honest default: a caller that
   * did not name its request cannot have meant "the same one as last time".
   */
  @IsOptional() @IsPublicId() triggerId?: string;
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
