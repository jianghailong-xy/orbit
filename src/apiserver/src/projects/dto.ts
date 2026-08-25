import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
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
export const MAX_PROJECT_ACCEPTANCE_CRITERIA_ITEMS = 100;

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
 * An `acceptanceEpoch` as it travels. Same shape, same reason, as `CONFIG_REVISION_PATTERN`: a
 * 64-bit column served as a decimal string, so what a caller echoes back is validated as the
 * string the read endpoint gave them rather than as a number that would lose its last digits.
 */
export const ACCEPTANCE_EPOCH_PATTERN = /^\d{1,20}$/;

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

/** One structurally bounded project-level criterion. A criterion is deliberately one physical
 * line in this compatibility phase: the legacy text projection can round-trip it without turning
 * a continuation line into a second criterion. Inline Markdown remains valid. */
export class CreateProjectAcceptanceCriterionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS)
  @Matches(/^[^\r\n]+$/u, { message: 'criterion text must be one line' })
  text!: string;
}

/** Stable ids are accepted only on update. Omit one to add a new criterion; retain one returned by
 * project_get to edit or reorder that definition without replacing its identity. */
export class UpdateProjectAcceptanceCriterionDto extends CreateProjectAcceptanceCriterionDto {
  @IsOptional() @IsPublicId() id?: string;
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
  /** Structured authoring source. Mutually exclusive with the legacy text field; the service
   * checks that cross-field invariant and stores a compatibility projection for older clients. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PROJECT_ACCEPTANCE_CRITERIA_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CreateProjectAcceptanceCriterionDto)
  acceptanceCriteriaItems?: CreateProjectAcceptanceCriterionDto[];
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
  /** Whole-collection structured replacement. `[]` explicitly clears every criterion; omission
   * leaves the collection untouched. Existing item ids preserve identity and revision history. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PROJECT_ACCEPTANCE_CRITERIA_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => UpdateProjectAcceptanceCriterionDto)
  acceptanceCriteriaItems?: UpdateProjectAcceptanceCriterionDto[];
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

  /**
   * Unit L7: the acceptance epoch this reopen was decided against.
   *
   * Only read when `status` is OPEN and the project is settled — the one write that starts a new
   * acceptance epoch and makes every PASS the project has stop being current. Sent, it is a
   * compare-and-swap on that epoch: the reopen commits only if the project is still at the number
   * the person was shown, and a 409 otherwise with nothing written.
   *
   * OPTIONAL here for the same compatibility reason `expectedConfigRevision` is, and REQUIRED on
   * `POST /projects/:id/reopen` — the door a person acts through. A confirmation that a repair
   * script has to learn about is a confirmation that stops repair scripts; one the UI cannot skip
   * is one a person cannot spend by accident.
   */
  @IsOptional() @IsString() @Matches(ACCEPTANCE_EPOCH_PATTERN, {
    message:
      'acknowledgedAcceptanceEpoch must be the decimal acceptanceEpoch you read from the project',
  })
  acknowledgedAcceptanceEpoch?: string;
}

/**
 * `POST /projects/:id/reopen` — reopen a settled project, on purpose.
 *
 * One field and it is required, which is the whole difference between this door and `PATCH :id`
 * with `status: OPEN`: a reopen retires every acceptance attempt the project has and starts a new
 * epoch, so the request has to name the epoch it was decided against. Naming it is the second
 * confirmation — not a checkbox, which only proves a second button was pressed, but the number
 * from the preview, which proves it was pressed on the project as it actually stands.
 */
export class ReopenProjectDto {
  @IsString() @Matches(ACCEPTANCE_EPOCH_PATTERN, {
    message:
      'acknowledgedAcceptanceEpoch must be the decimal acceptanceEpoch you read from the project',
  })
  acknowledgedAcceptanceEpoch!: string;

  /** As on UpdateProjectDto: the revision this request was composed against, or nothing. */
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

export class RebindProjectCoordinatorDto {
  /**
   * Where this project's coordinator belongs from now on.
   *
   * Required, and with no `null` spelling. Clearing a landing is not the other half of moving one:
   * it is how a project reaches `COORDINATOR_UNAVAILABLE` — the state this endpoint exists to
   * resolve — and offering it here would be offering the owner a way to break the thing they came
   * to fix. A project that should stop being coordinated turns its coordinator off
   * (`coordinatorEnabled`), which says so where every reader already looks.
   */
  @IsPublicId() workspaceId!: string;
}

// ── Project acceptance (contract §13.4 / §13.5) ──────────────────────────────────────────────

export const MAX_ACCEPTANCE_SUMMARY_CHARS = 4_000;
export const MAX_MERGE_REQUIREMENT_CHARS = 200;
/** A sha256 hex digest of the observed CONTENT of a target branch — never a commit SHA, and never
 *  a `git branch --contains` boolean (§13.4 clause 6: both are false negatives after a squash). */
export const CONTENT_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

const ACCEPTANCE_VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;
const ACCEPTANCE_DECIDERS = ['COORDINATOR_AGENT', 'USER'] as const;

export class OpenAcceptanceRunDto {
  /** Who is concluding — the closed pair `project_decision.decided_by` carries.
   *
   *  Optional at the user door and defaulted to USER, because a person recording an acceptance is
   *  recording their own. The runner door ignores it and writes COORDINATOR_AGENT: there, who
   *  concluded is a fact about the credential rather than a claim in the body. Only a
   *  COORDINATOR_AGENT run opens the DONE gate (§13.4 AE2 step 2), so stating it here is an
   *  explicit claim rather than something anybody gets by accident. */
  @IsOptional() @IsIn(ACCEPTANCE_DECIDERS) decidedBy?: 'COORDINATOR_AGENT' | 'USER';
  /** Historical attribution: which agent, and in which conversation. Recorded, never dereferenced —
   *  rotating or deleting either must not rewrite who ran an acceptance. */
  @IsOptional() @IsPublicId() coordinatorAgentId?: string | null;
  @IsOptional() @IsPublicId() coordinatorSessionId?: string | null;
  @IsOptional() @IsPublicId() projectActionId?: string | null;
}

/** One criterion's conclusion. Addressed by `ordinal` (its position in the snapshot) or by
 *  `criterionKey` (its content), so a caller that re-read the snapshot after an edit cannot answer
 *  criterion 3 while meaning criterion 4. */
export class AcceptanceCriterionOutcomeDto {
  @IsOptional() @IsInt() @Min(1) ordinal?: number;
  @IsOptional() @IsString() @MinLength(1) criterionKey?: string;
  /** Stable authored definition id, available on runs opened after schema 0172. */
  @IsOptional() @IsPublicId() criterionId?: string;
  @IsIn(ACCEPTANCE_VERDICTS) verdict!: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  @IsOptional() @IsString() @MaxLength(MAX_ACCEPTANCE_SUMMARY_CHARS) summary?: string | null;
  /** Commands, key output, SHAs, environment — §13.4 clause 3's evidence, as JSON rather than
   *  prose so that a checker can read it without parsing sentences. */
  @IsOptional() evidence?: Record<string, unknown>;
  @IsOptional() @IsPublicId() evidenceTaskId?: string | null;
  @IsOptional() @IsPublicId() evidenceSessionId?: string | null;
}

export class FinalizeAcceptanceRunDto {
  /** Every criterion in the run's snapshot, each with its own conclusion. The run's verdict is
   *  derived from these and never supplied: a project-level PASS is the conjunction of them. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AcceptanceCriterionOutcomeDto)
  criteria!: AcceptanceCriterionOutcomeDto[];
}

export class RecordMergeEvidenceDto {
  /** What was required, in the words whoever wrote the acceptance criteria used. */
  @IsString() @MinLength(1) @MaxLength(MAX_MERGE_REQUIREMENT_CHARS) requirementId!: string;
  /** Where it had to land. */
  @IsString() @MinLength(1) @MaxLength(MAX_MERGE_REQUIREMENT_CHARS) targetBranch!: string;
  /** The normalized content observation (§13.4 AE9-b). */
  @Matches(CONTENT_HASH_PATTERN, {
    message: 'contentHash must be a 64-character sha256 hex digest of the observed content',
  })
  contentHash!: string;
  @IsOptional() @IsString() @MaxLength(200) source?: string;
  /** The raw observation behind the hash: the command, its output, the blob ids it read. */
  @IsOptional() detail?: Record<string, unknown>;
}

/**
 * `[K5]` §6: the only shape a verification Session may submit.
 *
 * The DTO IS the ownership rule. There is no field here for the subject's acceptance criteria, its
 * title, its description or its scope revision content — §1 OW1 forbids a verifier from touching
 * any of them, and OW2 forbids a worker from approving its own new criterion. What a reporter that
 * wants the scope changed does instead is submit this with `scopeClassification: 'SCOPE_EXPANSION'`
 * and let CL3 answer, which is a freeze and a request rather than a change.
 *
 * `scopeRevision` is required and is not defaulted to "whatever it is now" on purpose (FD4): a
 * finding measured against a revision the task has moved past is an answer to a question nobody is
 * asking, and defaulting it would silently re-address the conclusion to the new question.
 */
/** A full, lowercase, 40-hex object name. An abbreviation resolves against a repository that has
 *  since gained objects, so a value that verified today can name a different commit later. */
const SHA_40 = /^[0-9a-f]{40}$/;

export class SubmitVerificationFindingDto {
  @IsIn(['P0', 'P1', 'P2', 'P3']) severity!: 'P0' | 'P1' | 'P2' | 'P3';
  @IsString() @MinLength(1) @MaxLength(200) violatedInvariant!: string;
  @IsString() @MinLength(1) @MaxLength(4000) minimalRepro!: string;
  @Matches(/^[0-9a-f]{64}$/, {
    message: 'failureFingerprint must be the 64-character sha256 digest §5 defines',
  })
  failureFingerprint!: string;
  @IsIn([
    'TRANSIENT', 'IN_SCOPE_DEFECT', 'PREREQUISITE', 'SCOPE_EXPANSION', 'ENVIRONMENT',
    'HUMAN_REQUIRED',
  ])
  scopeClassification!: string;
  /** Commands, key output, SHAs, environment — as JSON rather than prose, in Base62 ids. */
  evidence!: Record<string, unknown>;
  /** §6 has two values: a check that passed has nothing to report and no consequence to produce. */
  @IsIn(['FAIL', 'INCONCLUSIVE']) verdict!: 'FAIL' | 'INCONCLUSIVE';
  @IsInt() @Min(1) scopeRevision!: number;
  /** Which check is reporting. Recorded for the audit, never dereferenced. */
  @IsOptional() @IsPublicId() reporterTaskId?: string | null;
}

/**
 * `[K6]` §7: what a caller states when it records a checkpoint.
 *
 * The KIND is absent by design. A caller that could name its own kind could call a red tree
 * `ACCEPTED`, and everything §7 grants an accepted point — being the baseline a later task starts
 * from, being mergeable — would rest on that word rather than on a measurement. What a caller
 * states is what it MEASURED; `planCheckpoint` decides what that makes the checkpoint.
 */
export class RecordTaskCheckpointDto {
  @IsString() @MinLength(1) @MaxLength(255) branch!: string;
  @Matches(SHA_40, { message: 'commitSha must be a full 40-character git object name' })
  commitSha!: string;
  /** Not redundant with `commitSha`: two runners replaying one piece of work produce two commits
   *  and one tree, and it is the TREE that answers "is this the same state". */
  @Matches(SHA_40, { message: 'treeSha must be a full 40-character git object name' })
  treeSha!: string;
  @Matches(SHA_40, { message: 'baseSha must be a full 40-character git object name' })
  baseSha!: string;
  @IsInt() @Min(1) scopeRevision!: number;

  /** Absent means known-red: a checkpoint saved so the work is not lost. */
  @IsOptional() evidence?: {
    suite: string;
    treeSha: string;
    passed: number;
    failed: number;
    skipped: number;
  } | null;

  /** CP2. Required for anything not accepted, and never a place on one machine. */
  @IsOptional() artifact?: { kind: string; ref: string; digest: string } | null;

  /** Which run produced it. Recorded for the audit, never dereferenced. */
  @IsOptional() @IsPublicId() attemptId?: string | null;
}

/**
 * Unit L4: the user's answer about one declared cross-project crossing.
 *
 * Only two values, and only from a person. §7 RB2 is explicit that the target project's coordinator
 * is not the approver — an agent signing for another agent is the incident this unit exists for with
 * one more actor in it — so there is no shape of this request an agent can make.
 *
 * A refusal is final for that crossing: §6 gives `ABANDONED` one exit and it is the user filing the
 * work themselves, which is an ordinary write under their own authority. Nothing here revives it.
 */
export class DecideProjectHandoffDto {
  @IsIn(['APPROVE', 'DENY']) decision!: 'APPROVE' | 'DENY';

  /**
   * Unit L7: the crossing this answer is about, echoed back.
   *
   * `crossingKey` is the digest of the two ends and the subject — the identity of the move itself,
   * not of the row that records it — so echoing it says "I am answering the crossing I READ". A
   * different one is refused with `APPROVAL_TARGET_MISMATCH`, which is L1's frozen code for an
   * approval that names another move, rather than with a new fifth way to say the same thing.
   *
   * Optional, because the id in the path already picks the row out and an older client sends
   * nothing. Sent, it is a fence, and the web app and the CLI always send it: a queue of crossings
   * is exactly the screen where a list that reordered under a click turns one considered answer
   * into an answer about somebody else's work.
   */
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{64}$/, {
    message: 'acknowledgedCrossingKey must be the crossingKey you read from the crossing',
  })
  acknowledgedCrossingKey?: string;
}
