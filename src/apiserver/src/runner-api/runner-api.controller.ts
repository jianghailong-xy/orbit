import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile as UploadedFileParam,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { MachineProtocol } from '../common/machine-protocol';
import { TasksService } from '../tasks/tasks.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import {
  bgJobActivityAfterReports,
  sameBgJobActivity,
} from '../sessions/background-job-activity';
import {
  checkpointIdForCommit,
  reportedLandingAuthority,
} from '../projects/task-checkpoint.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { CreatorType, Prisma, RunStatus, TaskStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PLAN_USAGE_CAS_ATTEMPTS, storeHeartbeatPlanUsage } from './codex-reset-plan-usage';
import { dispatchCodexResetCommand, receiveCodexResetResult } from './codex-reset-relay';
import {
  INTEGRATION_RESULT_REFUSAL_STATUS,
  IntegrationJobRefused,
  IntegrationJobRelay,
} from './integration-job-relay';
import {
  AgentProvider,
  AgentExecConfig,
  ActivateTurnLeasesRequest,
  ArtifactResultRequest,
  ApprovalCreateRequest,
  ApprovalDecisionResponse,
  ApprovalStatus,
  ClaimedSession,
  ConversationTurnKind,
  DevicePollRequest,
  DevicePollResponse,
  DeviceStartRequest,
  DeviceStartResponse,
  apiErrorRetryAt,
  isAsyncAgentLaunchAck,
  isRetryableApiErrorText,
  IntegrationJobProgressRequest,
  IntegrationJobResultRequest,
  IntegrationJobResultResponse,
  isUsageLimitErrorText,
  parseQuotaResetAt,
  planUsageBlockedUntil,
  type PlanUsage,
  PermissionMode,
  QuestionAnswers,
  ReclaimResponse,
  ReclaimSession,
  ReleaseTurnLeasesRequest,
  RunEventBatch,
  RunEventType,
  RunStatus as SharedRunStatus,
  RunInboxResponse,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  InstallCommand,
  InstallResult,
  LoginCommand,
  LoginResult,
  OrchestrationCredentialResponse,
  RepoCleanupCommand,
  CLAUDE_HISTORY_MAX_TRANSCRIPTS,
  ClaudeHistoryTranscript,
  RunnerClaudeHistoryResult,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  RunnerRepoCleanupResult,
  SessionCommitResultRequest,
  RunFinalizeRequest,
  RunFinalizeResponse,
  SessionDiffResultRequest,
  SessionEndReason,
  SessionMergeResultRequest,
  SESSION_SOURCE_PIN_V1,
  SourcePinRequest,
  SourcePinResponse,
  TakeoverTurnLeasesRequest,
  TakeoverTurnLeasesResponse,
  TurnAttachment,
  TurnCompleteRequest,
  WorktreesRemovableRequest,
  WorktreesRemovableResponse,
  gracefulEndStatus,
  supportsMidTurnSteer,
  supportsTargetBoundCurrentWorkSteer,
  TURN_COMPLETE_STEER_REQUEUE,
  AbandonedSteer,
  ActivateTurnLeasesResponse,
  fastModeAvailable,
  type CodexRateLimitResetResultRequest,
  type RunnerModelCatalog,
} from '@orbit/shared';
import { lastProviderByWorkspace, withProviderSeed } from '../workspaces/workspace-provider';
import { generateToken, generateUserCode, sha256 } from '../common/crypto.util';
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForRuntimeModel,
  normalizeRuntimeProvider,
} from '../common/runtime-provider';
import { OPEN_SESSION_STATUSES, statusAfterTurnCompleted } from '../common/session-scheduling';
import { assertValidUpload, MAX_UPLOAD_BYTES, toBytes, UploadedFile } from '../attachments/attachments.media';
import {
  loggedRetry,
  RUNNER_POLL_TRANSACTION_MAX_WAIT_MS,
  withTransactionRetry,
} from '../common/transaction-retry';
import { TransactionSurface } from '../common/prisma-transaction-surface';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import {
  appendCoordinatorDeliveryContext,
  buildCoordinatorDeliveryContextKey,
  hasCoordinatorOpening,
  wrapCoordinatorDeliveryContext,
} from '../projects/coordinator-opening';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../push/push.service';
import { normalizeStoredRememberRules } from '../sessions/remember-rules';
import {
  APPROVAL_ABANDONED_STATUS,
  reapApprovalsOfEndedTurns,
  reapApprovalsOfReplacedSupervisor,
} from '../sessions/abandoned-approvals';
import {
  CURRENT_WORK_RUNTIME_REJECTED,
  CURRENT_WORK_SESSION_FINALIZED,
  CURRENT_WORK_TARGET_COMPLETED,
  acknowledgedRuntimeTurnIds,
  requeueUnreadCurrentWorkSteers,
  terminalizePendingCurrentWorkSteers,
} from '../sessions/current-work-delivery';
import { deadLetterQueuedWatchWakes } from '../watches/watch-wake-drain';
import { currentWatchRollout, watchClaimFields } from '../watches/watch-rollout';
import { type TaskFailure, recordTaskFailure, returnQueuedTurns } from '../projects/project-open-item';
import { enqueueForDoneTask } from '../projects/project-integration-job';
import { ProjectFuseService } from '../projects/project-fuse.service';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import {
  TASK_ACCEPTANCE_CLIENT_TURN_PREFIX,
  executableAcceptanceFailureReason,
} from '../tasks/executable-acceptance-round';
import {
  postExecutableAcceptanceUnavailableComment,
  postRunFailureComment,
  postWorkNotOnBranchComment,
  reclaimStalledTask,
} from '../tasks/reclaim-stalled-task';
import { CurrentRunner } from './current-runner.decorator';
import { reclaimRuntimeIds } from './reclaim-runtime';
import {
  RUNTIME_STARTED_EVENT_TYPES,
  RUNTIME_STARTED_SYSTEM_SUBTYPE,
  buildResumeContinuation,
} from './resume-continuation';
import { appendBackgroundJobsContext } from './background-jobs-context';
import {
  appendBackgroundWakeContext,
  BACKGROUND_WAKE_TURN_PREFIX,
  BackgroundWakeDto,
  type BackgroundWakeReceipt,
  fileBackgroundJobWake,
  isBackgroundWakeTurn,
  sessionHasEnded,
  undeliveredWakeTurn,
} from './background-job-wake';
import {
  appendScheduledWakeupContext,
  cancelScheduledWakeup,
  ScheduledWakeupDto,
  type ScheduledWakeupReceipt,
  scheduleWakeup,
} from './scheduled-wakeup';
import { nextAutoRetryAt } from '../sessions/auto-retry.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { recordOwnerConfirmationRequest } from '../tasks/owner-confirmation-read';
import { OWNER_CONFIRMATION_UNSETTLED_STATUSES } from '../tasks/task-owner-confirmation';
import { withControlPlaneNote } from './control-plane-note';
import { isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { runtimeInitSessionId } from './runtime-init';
import { enginePhaseAfter, enginePhaseSinceAfter, engineTurnActiveAfter } from './engine-turn';
import { hasSessionActivity } from './session-activity';
import { stripNul } from './strip-nul';
import { normalizeToolOutputEvent } from './tool-output';
import {
  deriveTaskCompletionStatus,
  type TaskCompletionCriterionValue,
} from '../tasks/task-completion-criterion';
import {
  completionCriterionSnapshot,
  completionDigest,
  normalizeCompletionEvidence,
  type CompletionCriterionSnapshotInput,
} from '../tasks/task-completion-evidence.service';
import { RunnerAuthGuard } from './runner-auth.guard';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { ListEventsService } from '../task-lists/list-events.service';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import {
  isNoiseSystemEvent,
  NON_REPLAYABLE_EVENT_TYPES,
  replayableEventSql,
} from '../common/system-noise';
import { isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import { readRunnerRepoHealth, sanitizeRunnerRepoHealth } from '../common/runner-repo-health';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { ALWAYS_ALLOWED_TOOLS, resolvePermissionMode } from '../common/permission-mode';
import {
  AUTO_ALLOWED_MESSAGE,
  dispatchAllowedTools,
  ruleCoversApproval,
  serverMatchedRuntime,
} from '../common/permission-rules';
import {
  isTerminalResumeHandoffOwner,
  pendingWorktreeOperationMayBeExecuting,
  retireSessionInboxGeneration,
} from '../common/session-inbox-fence';
import {
  OPENCODE_RUNNER_UPGRADE_ERROR,
  SOURCE_PROTOCOL_UNSUPPORTED_ERROR,
  advertisedRunnerProviders,
  runnerAdvertisesProvider,
} from './runner-provider-support';
import {
  freezeSessionSourcePin,
  hasResolvedSource,
  sessionSourceSnapshot,
} from '../projects/session-source';
import { sessionExecRuntime } from '../providers/custom-provider';

// Must stay >= the runner's own loginRelayTimeout (login.go): the runner kills its CLI at that
// point, so anything still marked in-flight past this window has no process behind it.
const LOGIN_RELAY_TIMEOUT_MS = 11 * 60_000;
// Same contract for installs, against the runner's engineInstallTimeout (10 min) plus the
// heartbeat it takes to pick the request up.
const INSTALL_RELAY_TIMEOUT_MS = 12 * 60_000;
// The checkout repair is seconds of local git, so this window only has to cover a runner that
// went away between the click and picking the request up.
const REPO_CLEANUP_TIMEOUT_MS = 3 * 60_000;
// The durable event batch is the one transaction whose size grows with what the runner queued
// while it could not reach us: a runner treats 5xx as retryable without a ceiling and flushes its
// whole backlog per POST, so a long outage backlogs thousands of events into a single batch whose
// compile, serialize and insert outlast the 5s interactive default long before the statement
// itself would. Expired means the batch can never commit, the runner retries the same giant
// batch, and the queue never drains — the 2026-09-15 wedge. Every write in this transaction is
// retry-idempotent (see the events() comment), so a long timeout costs nothing but the timeout
// itself. maxWait uses the same value: a batch that already burned its compile should queue for
// a pool slot instead of failing fast and paying the compile again.
const EVENTS_INGEST_TRANSACTION_TIMEOUT_MS = 120_000;
// The WASM query compiler and the wire bind cost grow super-linearly with the row count, and a
// backlogged batch holds thousands: one 32k-parameter createMany compiles for minutes, while 256
// rows stay in the milliseconds. Chunked inside the same transaction, so the retry-idempotency
// the whole batch relies on is unchanged.
const CREATE_MANY_CHUNK_ROWS = 256;

/** Run one createMany in bounded chunks so no single compile can stall the event loop. */
async function chunkedCreateMany(
  insert: (data: never[]) => Promise<unknown>,
  data: never[],
): Promise<void> {
  for (let offset = 0; offset < data.length; offset += CREATE_MANY_CHUNK_ROWS) {
    await insert(data.slice(offset, offset + CREATE_MANY_CHUNK_ROWS));
  }
}
const LONG_POLL_MS = 25_000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_INTERVAL_S = 3;
// Three missed 30s heartbeats — must match RunnersService's offline window.
const OFFLINE_AFTER_MS = 90_000;
// Interactive sessions (Route B): per-session input long-poll + at-least-once lease.
const INBOX_LONG_POLL_MS = 25_000;
const INBOX_LEASE_MS = 300_000;
// Tool-permission approvals: the orbit MCP permission tool blocks on this long-poll
// until a human decides. DB-polled (approvals are low-frequency; no NOTIFY needed).
const APPROVAL_LONG_POLL_MS = 25_000;
const APPROVAL_POLL_INTERVAL_MS = 1_500;
// Spread over which quota retries are scattered past their reset. See retryPlanFor.
const QUOTA_RETRY_JITTER_MS = 60_000;
const LEASE_GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Session primary keys are UUIDv7, while older rows may still be UUIDv4. Keep
// entity-ID validation separate from the stricter runner-generated lease UUID
// validation above so adding a UUID version cannot take the heartbeat offline.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE: RunStatus[] = [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];
const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];
// PENDING is also open/resumable. In the active-turn model it can briefly coexist with
// a still-warm runtime (a new message arrived after the prior turn released its slot), so
// late event tails and heartbeat snapshots must remain streamable while it waits to claim.
// Keep this distinct from LIVE: /complete must never finalize a freshly queued PENDING turn.
const OPEN = OPEN_SESSION_STATUSES;
// Events that count as the workspace *answering* the pending user message. Two things read it: the
// frontier reduction below clears the denormalized `lastUserText` the session list previews on one,
// and turn-complete settles the person's turn as ANSWERED on one. Deliberately narrow: a turn
// ending, a user interrupt, an error or a system/status handshake all end the turn without
// answering, and clearing on those left a session interrupted before its first reply with nothing
// to preview.
// A tool is not an answer either: while one is in flight the row shows it (`lastToolUse` outranks
// the message), but the gaps between tools are the workspace still working on that message, and
// clearing there dropped the row back to the PREVIOUS turn's reply for the rest of the turn —
// the one thing that reads as "already answered".
const ANSWERS_USER_TURN: ReadonlySet<RunEventType> = new Set([
  RunEventType.ASSISTANT,
  RunEventType.RESULT,
]);
const RUNNER_CAPABILITIES_HEADER = 'x-orbit-runner-capabilities';
// Distinct from the named-capability header above: this one advertises which built-in
// runtimes the runner binary can actually drive (runner 0.1.82+).
const RUNNER_PROVIDERS_HEADER = 'x-orbit-supported-providers';
export const SESSION_ORCHESTRATION_CREDENTIAL_V1 = 'session-orchestration-credential-v1';
export const SESSION_TERMINAL_HANDOFF_V1 = 'session-terminal-handoff-v1';
export const SESSION_WORKTREE_OPS_V1 = 'session-worktree-ops-v1';
/** Runner guarantees a durable compaction boundary before the next Claude top-level turn. */
export const SESSION_CLAUDE_COORDINATOR_CONTEXT_V1 =
  'session-claude-coordinator-context-v1';
/** Runner guarantees a durable compaction boundary before the next Codex top-level turn. */
export const SESSION_CODEX_COORDINATOR_CONTEXT_V1 =
  'session-codex-coordinator-context-v1';
const COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES = new Set([
  'compact_boundary',
  'compact_summary',
  'context_compacted',
]);

function supportsSparseCoordinatorContext(
  runtime: AgentProvider,
  capabilities: readonly string[],
  leaseGeneration: string | null,
): leaseGeneration is string {
  if (!leaseGeneration) return false;
  const capability = runtime === AgentProvider.CLAUDE
    ? SESSION_CLAUDE_COORDINATOR_CONTEXT_V1
    : runtime === AgentProvider.CODEX
      ? SESSION_CODEX_COORDINATOR_CONTEXT_V1
      : null;
  return capability != null && capabilities.includes(capability);
}

// A normal task starts OPEN and stays there while its run does the work. IN_PROGRESS exists only
// for the retry of a prior FAILED run. Neither is an assertion about completion, so both are valid
// inputs to the same mechanical EXECUTABLE evaluator; no actor has to write an interim status.
const EXECUTABLE_ACCEPTANCE_PENDING_STATUSES: readonly TaskStatus[] = [
  TaskStatus.OPEN,
  TaskStatus.IN_PROGRESS,
];

function awaitsExecutableAcceptance(status: TaskStatus): boolean {
  return EXECUTABLE_ACCEPTANCE_PENDING_STATUSES.includes(status);
}

function taskAcceptanceClientTurnId(
  completedTurnId: string,
  expectedExitCode: number,
): string {
  // The expectation is part of the queued work's identity. If somebody edits it while the shell
  // is running, that old result must not be judged against the new declaration.
  return `${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}${completedTurnId}:${expectedExitCode}`;
}

function taskAcceptanceExpectedExitCode(
  clientTurnId: string | null | undefined,
): number | null {
  if (!clientTurnId?.startsWith(TASK_ACCEPTANCE_CLIENT_TURN_PREFIX)) return null;
  const identity = clientTurnId.slice(TASK_ACCEPTANCE_CLIENT_TURN_PREFIX.length);
  const separator = identity.lastIndexOf(':');
  if (separator <= 0) return null;
  const encoded = identity.slice(separator + 1);
  if (!/^-?\d+$/.test(encoded)) return null;
  const expected = Number(encoded);
  return Number.isSafeInteger(expected) ? expected : null;
}

function isTaskAcceptanceClientTurnId(clientTurnId: string | null | undefined): boolean {
  return taskAcceptanceExpectedExitCode(clientTurnId) != null;
}

/**
 * The wall-clock budget this task declared for its acceptance command, or null for the runner's
 * own default.
 *
 * One column read, and deliberately nothing else: there is no admission to run, no ceiling to
 * check it against and nothing to record. A task that has since been deleted, or a session with no
 * task at all, answers null and the runner falls back to its default — which is what every task
 * that declares no budget gets anyway, so there is no failure mode here worth a refusal.
 */
async function acceptanceBudgetSeconds(
  tx: Prisma.TransactionClient,
  taskId: string | null,
): Promise<number | null> {
  if (!taskId) return null;
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { acceptanceTimeoutSeconds: true },
  });
  return task?.acceptanceTimeoutSeconds ?? null;
}

export function runnerSupportsCapability(
  header: string | string[] | undefined,
  capability: string,
): boolean {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return values.some((value) =>
    value
      .split(',')
      .some((item) => item.trim().toLowerCase() === capability.toLowerCase()),
  );
}

/**
 * An integration-job refusal as HTTP (contract §2.3): 409 for a claim that moved on or a job already
 * written down, 404 for one this runner cannot see, 400 for a body that is not a result. Anything
 * else is a real fault and is raised as it is, so it is logged as one rather than answered as a
 * refusal the runner would stop on.
 */
function integrationJobHttpError(error: unknown): unknown {
  if (error instanceof IntegrationJobRefused) {
    return new HttpException(
      { code: error.refusal, message: error.message },
      INTEGRATION_RESULT_REFUSAL_STATUS[error.refusal],
    );
  }
  return error;
}

/** A heartbeat capability header is a declarative machine report, never an authorization token. */
export function parseRunnerCapabilities(
  header: string | string[] | undefined,
): string[] | undefined {
  if (header === undefined) return undefined;
  const values = Array.isArray(header) ? header : [header];
  return [...new Set(values.flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && value.length <= 120))]
    .sort()
    .slice(0, 128);
}

function parseLeaseGeneration(value?: string, field = 'leaseGeneration'): string | null {
  if (value == null || value === '') return null;
  if (!LEASE_GENERATION_RE.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

/**
 * A disk figure from a heartbeat, as a value the BigInt column accepts — or null when the
 * runner reported none.
 *
 * Rejecting rather than coercing anything malformed is deliberate: this is advisory telemetry
 * that a gate then acts on, so a negative or non-finite reading has to become "unknown" (gate
 * off) instead of a number that could hold a whole fleet. Fractions are floored because a
 * filesystem cannot have a fraction of a byte free, and BigInt() would throw on one.
 */
function toDiskBytes(value: number | undefined): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return BigInt(Math.floor(value));
}

function parseSupervisedSessionId(value: string): string {
  if (!SESSION_ID_RE.test(value)) {
    throw new BadRequestException('supervised session IDs must be UUIDs');
  }
  return value.toLowerCase();
}

/**
 * Did this run fail without ever producing anything? Every reason a session dies between getting
 * its checkout and its first turn — the engine isn't installed, isn't signed in, or the account's
 * quota is spent — lands here with no turns and an empty diff, and its branch holds nothing but
 * the fork point it started from.
 *
 * Such a run's checkout is a full second copy of the repo standing in for no work at all, and one
 * signed-out runtime makes that the shape of every session started while it lasts: an overnight
 * expiry left a headless caller minting a hundred of them, 1.5GB, for work that never started.
 *
 * Deliberately narrow. Zero turns is not on its own enough — a shell-first session can have
 * changed files before any turn ran — and neither is failure: a run that failed on its tenth turn
 * has work on its branch and a checkout someone may still resume into. Only both together, and
 * only when the runner reports nothing changed, mean there is provably nothing to keep. The branch
 * is left alone either way, so a resume re-creates the checkout from it (setupWorktree).
 */
function producedNothingBeforeFailing(
  numTurns: number,
  status: RunStatus,
  dto: RunFinalizeRequest,
): boolean {
  return status === RunStatus.FAILED && numTurns === 0 && !dto.changedFiles?.length;
}

/**
 * Whether a running-set survived a batch unchanged — the test that keeps an ordinary tool_result
 * out of the Session write. Order matters: these arrays are append-on-launch, so a set that has
 * the same members in a different order is a set the batch reordered and has to be stored.
 */
function sameIds(next: readonly string[], stored: readonly string[]): boolean {
  return next.length === stored.length && next.every((v, i) => v === stored[i]);
}

/** `runner.findUnique` is the whole of the quota snapshot read, and was itself a drift point. */
export type QuotaRetryTransaction = TransactionSurface<{ runner: ['findUnique'] }>;

/** The retry plan reads the session, then hands the same transaction to the quota snapshot read. */
export type RetryPlanTransaction = TransactionSurface<{ session: ['findUnique'] }> & QuotaRetryTransaction;

@MachineProtocol()
@Controller('runner')
export class RunnerApiController {
  private readonly logger = new Logger(RunnerApiController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
    private readonly references: ReferenceExpansionService,
    private readonly listEvents?: ListEventsService,
    /**
     * Unit T5: the six-dimension attempt budget, charged where the spend is COMMITTED.
     *
     * Resolved by Nest from `ProjectsModule`, which this module imports; optional in the signature
     * for the ~40 specs that construct this controller directly, exactly as `listEvents` above is.
     * A spec that does not pass one is a spec about something else, and a budget that is not
     * charged on a turn is re-derived from the same columns on the next one.
     */
    private readonly attemptBudgets?: AttemptBudgetMeterService,
    /** Project EXECUTABLE criteria consume the Task's exact durable typed-attempt fact. */
    private readonly projectAcceptance?: ProjectAcceptanceService,
    /**
     * The exact Task=DONE commit made by an executable callback must release its dependents just
     * like the interactive completion doors in TasksService. Optional only for direct unit
     * fixtures; RunnerApiModule imports the one shared TasksService instance in production.
     */
    private readonly tasks?: TasksService,
    /**
     * The receipt writer, held for its post-commit delivery alone — the row itself is written by
     * `MergeReceiptService.fromRunnerMergeResult` inside `mergeResult`'s own transaction.
     *
     * Injected rather than reaching `CompletionInputRouter` directly (which this module CAN see,
     * through ProjectsModule's re-export) so that all three receipt writers knock on the delivery
     * doors through one method: three call sites deciding for themselves which doors a receipt
     * moves is how two of them end up moving different ones. Optional for the ~40 specs that
     * construct this controller directly, exactly as `tasks` above is.
     */
    private readonly mergeReceipts?: MergeReceiptService,
    /**
     * Files a background job's wake as a turn of its session (`backgroundWake`), through the same
     * createTurn every other turn takes. `@Optional()` for the specs that build this controller
     * through Nest without one; RunnerApiModule imports SessionsModule, so production always has it.
     */
    @Optional() private readonly sessions?: SessionsService,
    /**
     * Hands a project's exception items to the conversation that coordinates it, after the
     * transaction that opened them (contract §4.4). `@Optional()` for the same reason as the rest of
     * this list: the specs that build this controller by hand pass what their case is about.
     */
    @Optional() private readonly openItems?: ProjectOpenItemService,
    /**
     * The heartbeat's half of the integration queue (contract §2.2, §2.3). `@Optional()` for the
     * same reason as everything else down here: the specs that construct this controller directly
     * pass none, and a required parameter would make every one of them a compile error about a
     * queue they do not exercise. RunnerApiModule provides it, so production always has it — and
     * the two routes that need it say so rather than answering as though a runner had nothing to
     * report.
     */
    @Optional() private readonly integrationJobs?: IntegrationJobRelay,
    /**
     * The coordinator's spend fuse, read on the two facts an event batch can commit (contract §6.1
     * F5). `@Optional()` for the same reason as the rest of this list, and harmless when absent: a
     * reading not taken here is taken on the next batch that carries the same kind of spend.
     */
    @Optional() private readonly fuse?: ProjectFuseService,
    /**
     * Whether a landing has left the project branch ready to be offered to its owner (contract §3.4
     * M-F1, M-F4). `@Optional()` for the same reason as the rest of this list; a queue with no
     * promotion service simply offers nothing, and the next landing asks again.
     */
    @Optional() private readonly promotions?: ProjectPromotionService,
  ) {}

  /** `orbit register` — exchange a one-time enrollment token for a runner credential. */
  @Post('register')
  async register(@Body() dto: RunnerRegisterRequest): Promise<RunnerRegisterResponse> {
    if (!dto?.enrollmentToken || !dto?.name) {
      throw new UnauthorizedException('enrollmentToken and name are required');
    }
    const enrollment = await this.prisma.enrollmentToken.findUnique({
      where: { tokenHash: sha256(dto.enrollmentToken) },
    });
    if (!enrollment) throw new UnauthorizedException('invalid enrollment token');
    if (enrollment.usedAt) throw new UnauthorizedException('enrollment token already used');
    if (enrollment.expiresAt && enrollment.expiresAt < new Date()) {
      throw new UnauthorizedException('enrollment token expired');
    }

    // One Runner for the machine, reused if it already exists. Workspaces are
    // registered separately, not here. The token is single-use.
    const ownerId = enrollment.ownerId;
    const runnerName = dto.name;
    const runnerToken = generateToken(32);
    const runnerData = {
      hostname: dto.hostname,
      labels: dto.labels ?? [],
      maxConcurrent: dto.maxConcurrent ?? 16,
      version: dto.version,
      tokenHash: sha256(runnerToken),
      status: 'ONLINE' as const,
      lastHeartbeatAt: new Date(),
    };
    const existing = await this.prisma.runner.findFirst({
      where: { ownerId, name: runnerName },
      orderBy: { enrolledAt: 'desc' },
    });
    const runner = existing
      ? await this.prisma.runner.update({
          where: { id: existing.id },
          data: runnerData,
        })
      : await this.prisma.runner.create({
          data: { ...runnerData, name: runnerName, ownerId },
        });

    await this.prisma.enrollmentToken.update({
      where: { id: enrollment.id },
      data: { usedAt: new Date() },
    });

    return { runnerId: runner.id, runnerToken, name: runner.name };
  }

  /** `orbit register` (no token) — open a device-login session for browser approval. */
  @Post('device/start')
  async deviceStart(@Body() dto: DeviceStartRequest): Promise<DeviceStartResponse> {
    if (!dto?.name) throw new BadRequestException('name is required');
    const deviceCode = generateToken(32);
    const userCode = await this.createDeviceSession(dto, deviceCode);
    return {
      deviceCode,
      userCode,
      interval: DEVICE_POLL_INTERVAL_S,
      expiresIn: DEVICE_TTL_MS / 1000,
    };
  }

  /** The CLI polls this until the user approves the session in the browser. */
  @Post('device/poll')
  @HttpCode(200)
  async devicePoll(@Body() dto: DevicePollRequest): Promise<DevicePollResponse> {
    if (!dto?.deviceCode) throw new BadRequestException('deviceCode is required');
    const session = await this.prisma.deviceEnrollment.findUnique({
      where: { deviceCodeHash: sha256(dto.deviceCode) },
    });
    if (!session) throw new NotFoundException('unknown device code');
    if (session.expiresAt < new Date()) return { status: 'expired' };
    if (session.status !== 'APPROVED' || !session.runnerId || !session.runnerToken) {
      return { status: 'pending' };
    }
    // Approved — hand the machine runner credential to the CLI exactly once, then
    // wipe the secret.
    await this.prisma.deviceEnrollment.update({
      where: { id: session.id },
      data: { runnerToken: null },
    });
    return {
      status: 'approved',
      runnerId: session.runnerId,
      runnerToken: session.runnerToken,
      name: session.name,
    };
  }

  /** Insert a device session, regenerating the short code on the rare collision. */
  private async createDeviceSession(dto: DeviceStartRequest, deviceCode: string): Promise<string> {
    const expiresAt = new Date(Date.now() + DEVICE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = generateUserCode();
      try {
        await this.prisma.deviceEnrollment.create({
          data: {
            deviceCodeHash: sha256(deviceCode),
            userCode,
            name: dto.name,
            hostname: dto.hostname,
            labels: dto.labels ?? [],
            maxConcurrent: dto.maxConcurrent ?? 16,
            version: dto.version,
            agents: [],
            workDir: dto.workDir,
            expiresAt,
          },
        });
        return userCode;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new Error('could not allocate a unique user code');
  }

  /** `orbit status` — the runner's own record + derived online flag + its workspaces. */
  @UseGuards(RunnerAuthGuard)
  @Get('me')
  async me(
    @CurrentRunner()
    runner: {
      id: string;
      name: string;
      status: string;
      lastHeartbeatAt: Date | null;
      version: string | null;
      labels: string[];
      maxConcurrent: number;
    },
  ) {
    const fresh = !!runner.lastHeartbeatAt && Date.now() - runner.lastHeartbeatAt.getTime() < OFFLINE_AFTER_MS;
    const workspaces = await this.prisma.workspace.findMany({
      where: { runnerId: runner.id, deletedAt: null },
      select: {
        id: true,
        name: true,
        agentKey: true,
        workDir: true,
      },
      orderBy: { name: 'asc' },
    });
    // `orbit status` prints a provider per workspace, and the column is gone (migration 0088), so
    // derive it the same way every other workspace payload does rather than dropping the field —
    // a runner in the field reads it (RunnerWorkspace.Provider) and would just print nothing.
    const seeded = withProviderSeed(
      workspaces,
      await lastProviderByWorkspace(this.prisma, workspaces.map((a) => a.id)),
    );
    return {
      id: runner.id,
      name: runner.name,
      status: runner.status,
      online: runner.status !== 'OFFLINE' && fresh,
      lastHeartbeatAt: runner.lastHeartbeatAt,
      version: runner.version,
      labels: runner.labels,
      maxConcurrent: runner.maxConcurrent,
      workspaces: seeded.map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider,
        agentKey: a.agentKey ?? undefined,
        workDir: a.workDir ?? undefined,
      })),
    };
  }

  /** `orbit unregister` — the runner deletes itself from the control plane. */
  @UseGuards(RunnerAuthGuard)
  @Post('deregister')
  @HttpCode(200)
  async deregister(@CurrentRunner() runner: { id: string }) {
    await this.prisma.runner.delete({ where: { id: runner.id } });
    return { ok: true };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('heartbeat')
  async heartbeat(
    @CurrentRunner() runner: { id: string; version: string | null },
    @Body() dto: RunnerHeartbeatRequest,
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
  ): Promise<RunnerHeartbeatResponse> {
    const heartbeatLeaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    const reportedCapabilities = parseRunnerCapabilities(capabilities);
    const supportsWorktreeOps = runnerSupportsCapability(capabilities, SESSION_WORKTREE_OPS_V1);
    if ((dto?.supervisedSessionIds?.length ?? 0) > 10_000) {
      throw new BadRequestException('too many supervised session IDs');
    }
    const supervisedSessionIds = heartbeatLeaseOwner
      ? [
          ...new Set(
            (dto?.supervisedSessionIds ?? []).map((id) => parseSupervisedSessionId(id)),
          ),
        ]
      : [];
    const reportedEngines = dto?.engines == null ? null : (sanitizeRunnerEngines(dto.engines) ?? []);
    // Read the engine health this heartbeat is about to overwrite, but only when the incoming
    // report actually claims a signed-out engine — otherwise there is no transition to find and
    // every beat would pay for the lookup.
    const priorEngines = reportedEngines?.some((e) => e.installed && e.auth === 'no')
      ? sanitizeRunnerEngines(
          (
            await this.prisma.runner.findUnique({
              where: { id: runner.id },
              select: { engines: true },
            })
          )?.engines,
        )
      : null;
    const updated = await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        status: dto?.status ?? 'ONLINE',
        version: dto?.version ?? runner.version ?? undefined,
        lastHeartbeatAt: new Date(),
        // Refresh the `/` autocomplete catalog; older runners omit these (leave as-is).
        // Cast: a typed interface[] isn't structurally an InputJsonValue (no index sig).
        // Stripped (see strip-nul): these are read off the machine's disk — a command or skill
        // file that turns out to be binary would otherwise fail every heartbeat this runner
        // sends, and a runner that cannot heartbeat goes OFFLINE and stays there.
        availableCommands: stripNul(dto?.commands ?? undefined) as Prisma.InputJsonValue | undefined,
        availableSkills: stripNul(dto?.skills ?? undefined) as Prisma.InputJsonValue | undefined,
        // Runtime model catalog; older runners omit it (leave as-is).
        modelCatalog: stripNul(dto?.modelCatalog ?? undefined) as Prisma.InputJsonValue | undefined,
        // Capabilities belong to THIS authenticated process heartbeat, not to the machine forever.
        // Omission is an old/downgraded process and clears the prior process's declaration; keeping
        // the stale snapshot could admit CURRENT_WORK that the poller now owning the lease cannot
        // acknowledge. Inbox dequeue rechecks the request header as the second fence.
        capabilities: reportedCapabilities ?? [],
        capabilitiesReportedAt: new Date(),
        // What Codex rate-limit reset admission reads about the process sending this heartbeat
        // (docs/codex-rate-limit-reset-contract.md §4). Overwritten every beat, so a runner too old
        // to send a leaseOwner or a draining flag writes NULL: no active lease, not draining.
        heartbeatLeaseOwner,
        heartbeatDraining: typeof dto?.draining === 'boolean' ? dto.draining : null,
        // Per-engine health for the Providers page. Sanitized on the way in as well as out, so a
        // malformed report can't be stored as a claim about this machine; an older runner omits
        // the field entirely and keeps whatever was last known.
        engines:
          reportedEngines == null
            ? undefined
            : (reportedEngines as unknown as Prisma.InputJsonValue),
        // Whether that process is root, which withdraws Bypass on this machine (see
        // ROOT_REFUSED_PERMISSION_MODES). Omitted by a runner too old to report it, which keeps
        // the stored value — NULL there means "never told us" and stays unrestricted.
        runsAsRoot: dto?.runsAsRoot ?? undefined,
        // The directory this machine clones into, under which a workspace created from a git URL
        // gets its checkout. An empty string is treated as no report, exactly like the omission an
        // older runner sends: NULL here means "this machine never told us where it clones", and
        // the answer to that is to leave it off the clone targets — not to store a root nobody
        // named and then write a checkout to it.
        reposRoot: dto?.reposRoot || undefined,
        // Runtime-owned default snapshot. Omission means an older runner and preserves the
        // previous value; an explicit {} clears stale values so catalog/static fallback applies.
        runtimeDefaultModels:
          dto?.runtimeDefaultModels == null
            ? undefined
            : (sanitizeRuntimeDefaultModels(dto.runtimeDefaultModels) as Prisma.InputJsonValue),
        // State of the shared checkouts this machine's workspaces work in, so the UI can warn once
        // that a wedged checkout is blocking every merge here. Omitted by older runners (keep the
        // last snapshot); sanitized in as well as out, since it drives a claim about a machine.
        repoHealth:
          dto?.repos == null
            ? undefined
            : ((sanitizeRunnerRepoHealth(dto.repos) ?? []) as unknown as Prisma.InputJsonValue),
      },
    });
    // Latest provider plan-usage snapshot; older runners omit it (leave as-is). Written on its own by
    // compare-and-set, so the Codex reset block in it only moves forwards: a block relayed by another
    // process, an older read, an old process or a late heartbeat never takes a newer one back.
    if (dto?.planUsage != null) {
      try {
        if (!(await storeHeartbeatPlanUsage(this.prisma, runner.id, dto.planUsage, heartbeatLeaseOwner))) {
          this.logger.warn(`runner ${runner.id}: planUsage not stored after ${PLAN_USAGE_CAS_ATTEMPTS} compare-and-set attempts; the next heartbeat reports it again`);
        }
      } catch (error) {
        // Advisory telemetry, like the live diffs below: never fail the heartbeat for it.
        this.logger.warn(`runner ${runner.id}: planUsage not stored (${(error as { code?: string })?.code ?? (error as Error)?.name})`);
      }
    }
    // Codex rate-limit reset (docs/codex-rate-limit-reset-contract.md §6.2, §6.5): this runner's active
    // operations expired, settled, claimed or redelivered for the process THIS heartbeat speaks for —
    // its leaseOwner, its draining flag and the capabilities its own header declared — against the block
    // the compare-and-set above left stored. Every heartbeat runs it, an old runner's too, because the
    // deadlines settle there. On its own try, so a failure here costs only the reset step, which the
    // next heartbeat hands over again from the row.
    let codexRateLimitResetRequest: RunnerHeartbeatResponse['codexRateLimitResetRequest'];
    try {
      codexRateLimitResetRequest = await dispatchCodexResetCommand(this.prisma, {
        runnerId: runner.id,
        leaseOwner: heartbeatLeaseOwner,
        draining: dto?.draining === true,
        capabilities: reportedCapabilities,
      });
    } catch (error) {
      this.logger.warn(`runner ${runner.id}: codex reset relay skipped this heartbeat (${(error as { code?: string })?.code ?? (error as Error)?.name})`);
    }
    // The platform's own git work, claimed the same way and for the same reason: the claim is a
    // compare-and-set on a row, so a job named here is already RUNNING and is nobody else's to take
    // (contract §2.3 J-T2). On its own try, like the relay above — a failure costs this beat's jobs,
    // which the next beat claims again from the queue.
    let integrationJobs: RunnerHeartbeatResponse['integrationJobs'];
    try {
      const claimed = (await this.integrationJobs?.dispatch({
        runnerId: runner.id,
        leaseOwner: heartbeatLeaseOwner,
        draining: dto?.draining === true,
        capabilities: reportedCapabilities,
      })) ?? [];
      if (claimed.length > 0) integrationJobs = claimed;
    } catch (error) {
      this.logger.warn(`runner ${runner.id}: integration jobs skipped this heartbeat (${(error as { code?: string })?.code ?? (error as Error)?.name})`);
    }
    // An engine that was signed in and now isn't: tell the owner while it is still news, rather
    // than letting them find out from the next session that refuses to start. Only the yes -> no
    // edge counts — 'unknown' means the probe couldn't answer, which is not a claim of a sign-out,
    // and an engine that was already signed out was reported last beat too.
    if (priorEngines) {
      for (const current of reportedEngines ?? []) {
        if (!current.installed || current.auth !== 'no') continue;
        if (!isLoginEngine(current.engine)) continue;
        if (priorEngines.find((was) => was.engine === current.engine)?.auth !== 'yes') continue;
        void this.push.notifyEngineSignedOut(runner.id, current.engine);
      }
    }
    // A finished install stops being news the moment the probe confirms it: clear the slot so the
    // row goes back to speaking from engine health (which then says "signed out", with the sign-in
    // that actually comes next) rather than sitting on a terminal status nobody has to act on.
    //
    // A finished update is the opposite: its summary — what moved, what was skipped and why — is
    // the answer to the button the user pressed, and exists nowhere else. It stays until dismissed.
    if (updated.installStatus === 'done' && updated.installMode !== 'update' && dto?.engines) {
      const reported = sanitizeRunnerEngines(dto.engines) ?? [];
      if (reported.some((e) => e.engine === updated.installEngine && e.installed)) {
        await this.prisma.runner.update({
          where: { id: runner.id },
          data: {
            installStatus: null,
            installEngine: null,
            installCommand: null,
            installMessage: null,
            installAt: null,
            // Retire the whole slot, mode included — the same set cancelInstall clears. A
            // leftover mode is invisible today (installStateOf gates it on the status), which
            // is exactly what would make it outlive the next reader who doesn't.
            installMode: null,
          },
        });
      }
    }
    // A cold supervisor never polls /inbox, so endpoint-level 409 fencing alone
    // cannot tell an overlapping old process to detach it. Echo every locally
    // supervised id and cancel anything that is no longer both open and owned by
    // this exact process. Legacy heartbeats omit leaseOwner and skip this fence.
    let ownershipLostSessionIds: string[] = [];
    if (heartbeatLeaseOwner && supervisedSessionIds.length) {
      try {
        const matching = await this.prisma.session.findMany({
          where: {
            id: { in: supervisedSessionIds },
            assignedRunnerId: runner.id,
            status: { in: OPEN },
            inboxLeaseOwner: heartbeatLeaseOwner,
          },
          select: { id: true },
        });
        const matchingIds = new Set(matching.map((session) => session.id));
        ownershipLostSessionIds = supervisedSessionIds.filter((id) => !matchingIds.has(id));
      } catch {
        // Do not cancel on an indeterminate DB read; the next heartbeat retries.
      }
    }
    // Persist each running session's live worktree diff so the composer's status bar can
    // appear mid-turn, not just at turn-complete. The `status in OPEN` guard stops a
    // straggler heartbeat from overwriting a just-finalized session's committed diff;
    // the try/catch keeps a DB hiccup here from failing the heartbeat (→ reads as offline).
    if (dto?.sessions?.length) {
      try {
        await Promise.all(
          dto.sessions.map(async (s) => {
            const branchMerged = await this.reconcileReportedBranchMerged(
              s.sessionId,
              runner.id,
              s.branchMerged,
              s.branchSha,
              heartbeatLeaseOwner ?? undefined,
            );
            await this.prisma.session.updateMany({
              where: {
                id: s.sessionId,
                assignedRunnerId: runner.id,
                status: { in: OPEN },
                ...(heartbeatLeaseOwner ? { inboxLeaseOwner: heartbeatLeaseOwner } : {}),
              },
              data: {
                isolationStatus: s.isolationStatus,
                ...(s.baseSha !== undefined ? { baseSha: s.baseSha } : {}),
                changedFiles: (s.changedFiles ?? []) as unknown as Prisma.InputJsonValue,
                // Drives the status bar's Commit-vs-Merge action (older runners omit it →
                // left untouched, so the bar falls back to the session lifecycle).
                ...(s.worktreeDirty !== undefined ? { worktreeDirty: s.worktreeDirty } : {}),
                // Candidate branches for the "Merge to…" dropdown (older runners omit it).
                ...(s.mergeTargets !== undefined ? { mergeTargets: s.mergeTargets } : {}),
                // Whether the branch already landed in main → bar shows "✓ In main", not a
                // redundant Merge button (older runners omit it → left untouched).
                ...(branchMerged !== undefined ? { branchMerged } : {}),
                // The worktree's actual HEAD branch → the bar flags divergence from the tracked
                // `branch` and offers Adopt (older runners omit it → left untouched).
                ...(s.worktreeBranch !== undefined ? { worktreeBranch: s.worktreeBranch } : {}),
              },
            });
          }),
        );
      } catch {
        // Next heartbeat retries; the status bar tolerates a one-cycle lag.
      }
    }
    // Record what the runner found at each workspace's working directory, so the config form can
    // report a bad path at edit time. Scoped to this runner's own workspaces: a probe names an
    // workspace id, and only the machine that runs it can say anything about its disk.
    if (dto?.agentDirProbes?.length) {
      try {
        await Promise.all(
          dto.agentDirProbes.slice(0, 200).map((p) =>
            this.prisma.workspace.updateMany({
              where: { id: p.agentId, runnerId: runner.id, deletedAt: null },
              data: {
                workDirExists: p.exists,
                // Only meaningful when the directory is there; a missing path reports neither.
                workDirIsGit: p.exists ? p.isGitRepo : null,
                // Written straight through, including back to null when the runner reports no
                // figure (missing path, platform without an answer, or a binary too old to
                // measure). Keeping the last known number would be worse than having none: the
                // disk gate would then hold or release work on a reading nobody stands behind.
                workDirFreeBytes: toDiskBytes(p.freeBytes),
                workDirTotalBytes: toDiskBytes(p.totalBytes),
                workDirProbedAt: new Date(),
              },
            }),
          ),
        );
      } catch {
        // Advisory telemetry — never fail the heartbeat (that would read as offline).
      }
    }
    let cancelSessionIds: string[] = [];
    let mergeRequests: RunnerHeartbeatResponse['mergeRequests'] = [];
    let commitRequests: RunnerHeartbeatResponse['commitRequests'] = [];
    let artifactRequests: RunnerHeartbeatResponse['artifactRequests'] = [];
    let loginRequest: RunnerHeartbeatResponse['loginRequest'];
    let installRequest: RunnerHeartbeatResponse['installRequest'];
    let agentDirs: RunnerHeartbeatResponse['agentDirs'] = [];
    let repoCleanupRequest: RunnerHeartbeatResponse['repoCleanupRequest'];
    let claudeHistoryRequest: RunnerHeartbeatResponse['claudeHistoryRequest'];
    let refreshModelCatalog: RunnerHeartbeatResponse['refreshModelCatalog'];
    try {
      cancelSessionIds = await this.realtime.drainCancellations(runner.id);
      // Manual git mutations are fail-closed during rolling upgrades. A capable
      // runner must advertise its process owner; older binaries leave requests
      // pending until upgraded instead of executing an unfenced operation.
      if (supportsWorktreeOps && heartbeatLeaseOwner) {
        // A claimed request whose owning process died between claim and result would
        // otherwise stay pending forever, fencing takeover/messages/resume for its session.
        await this.realtime.failAbandonedWorktreeOperations(runner.id, heartbeatLeaseOwner);
        // A draining process still heartbeats (so the reaper spares its sessions) but no
        // longer dispatches git work. Claiming for it would pin the session to an epoch
        // that is about to be replaced, which is what the staleness backstop then has to
        // clean up minutes later — the successor process claims these instead.
        if (!dto?.draining) {
          mergeRequests = await this.realtime.drainMergeRequests(runner.id, heartbeatLeaseOwner);
          commitRequests = await this.realtime.drainCommitRequests(runner.id, heartbeatLeaseOwner);
        }
      }
      artifactRequests = await this.realtime.drainArtifactRequests(runner.id);
      loginRequest = await this.drainLoginRequest(runner.id);
      installRequest = await this.drainInstallRequest(runner.id);
      repoCleanupRequest = await this.drainRepoCleanupRequest(runner.id);
      claudeHistoryRequest = await this.drainClaudeHistoryRequest(runner.id);
      // The directories to stat before the next heartbeat. Sent every cycle rather than on
      // change, so an edited path is picked up without any invalidation to get wrong, and the
      // runner never has to hold a workspace list of its own. After the relays on purpose: it is
      // a plain listing rather than a one-slot relay, and everything after a throw in this try is
      // skipped until the next heartbeat.
      agentDirs = (
        await this.prisma.workspace.findMany({
          where: { runnerId: runner.id, deletedAt: null, workDir: { not: null } },
          select: { id: true, workDir: true },
          take: 200,
        })
      ).map((a) => ({ agentId: a.id, workDir: a.workDir as string }));
      // Last, after everything this beat owes the runner anyway. It is the one entry here whose
      // request survives being skipped — the timestamp stays on the row until a beat claims it —
      // so a hiccup while draining it costs a heartbeat, where a hiccup IN it, drained earlier,
      // would have cost the directory listing behind it.
      refreshModelCatalog = await this.drainModelCatalogRefresh(runner.id);
    } catch {
      // A transient DB hiccup shouldn't fail the heartbeat; all arrive next cycle.
    }
    // Hand back the authoritative max-concurrent (the editable DB value) so the runner
    // syncs its self-gate to a UI/API change without needing a restart. The free-space floor
    // rides along for the same reason: the runner reclaims its own session checkouts under disk
    // pressure, and that has to be the floor the owner set here, not a second number.
    return {
      cancelSessionIds,
      leaseLostSessionIds: ownershipLostSessionIds,
      maxConcurrent: updated.maxConcurrent,
      minFreeDiskMb: updated.minFreeDiskMb,
      mergeRequests,
      commitRequests,
      artifactRequests,
      loginRequest,
      installRequest,
      agentDirs,
      repoCleanupRequest,
      refreshModelCatalog,
      // Only when a claim holds a command for this process: an older runner's response stays the shape
      // it always was, and a direct caller comparing responses sees no new key.
      ...(codexRateLimitResetRequest ? { codexRateLimitResetRequest } : {}),
      // Same reasoning as the reset command above: present only while somebody is actually waiting
      // on an answer, so a runner that never asked sees the response shape it always had.
      ...(claudeHistoryRequest ? { claudeHistoryRequest } : {}),
      // Present only when this beat claimed something, for the same reason.
      ...(integrationJobs ? { integrationJobs } : {}),
    };
  }

  /** The queue, or the reason a request about one cannot be answered without it. */
  private integrationQueue(): IntegrationJobRelay {
    if (!this.integrationJobs) {
      throw new HttpException(
        { code: 'INTEGRATION_QUEUE_UNAVAILABLE', message: 'this control plane runs no integration queue' },
        503,
      );
    }
    return this.integrationJobs;
  }

  /**
   * A claimed integration job is still being worked on (contract §2.3, §2.2 J-T4): the phase it
   * reached, and the lease renewal that keeps another runner from taking it over. Fenced on
   * (leaseOwner, claimGeneration) and on the runner token, so a process whose claim was taken over
   * gets 409 STALE_CLAIM and stops rather than reporting into a job that is no longer its.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('integration-jobs/:jobId/progress')
  @HttpCode(200)
  async integrationJobProgress(
    @CurrentRunner() runner: { id: string },
    @Param('jobId', PublicIdPipe) jobId: string,
    @Body() body: IntegrationJobProgressRequest,
  ) {
    try {
      return await this.integrationQueue().progress(runner.id, jobId, body);
    } catch (error) {
      throw integrationJobHttpError(error);
    }
  }

  /**
   * What one claimed integration job came to (§2.2 J-T5 to J-T7).
   *
   * Everything the result implies is written in the transaction that writes the state: the receipt
   * for a landing, the exception item for a failure. What follows the commit — delivering that item
   * and dispatching the tasks the landing released — happens here, after it, and is re-derivable
   * from the committed rows by the next receipt or the 60-second sweep if this process dies first.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('integration-jobs/:jobId/result')
  @HttpCode(200)
  async integrationJobResult(
    @CurrentRunner() runner: { id: string },
    @Param('jobId', PublicIdPipe) jobId: string,
    @Body() body: IntegrationJobResultRequest,
  ): Promise<IntegrationJobResultResponse> {
    let applied: Awaited<ReturnType<IntegrationJobRelay['applyResult']>>;
    try {
      applied = await this.integrationQueue().applyResult(jobId, runner.id, body);
    } catch (error) {
      throw integrationJobHttpError(error);
    }
    const after = applied.after;
    if (after) {
      // J10: the receipt is the fact the tasks downstream were waiting for, and the item is what
      // somebody has to look at. Both are announcements of rows that are already committed, so a
      // failure here is logged and never raised — the runner's result was taken either way.
      await this.mergeReceipts
        ?.deliverProjectFactsAfterCommit(after.projectId, after.landedTaskId)
        .catch((error) => this.logger.warn(`integration landing facts not delivered: ${(error as Error)?.message}`));
      if (after.openItemTaskIds.length > 0) {
        await this.openItems?.deliverForTasks(after.openItemTaskIds)
          .catch((error) => this.logger.warn(`integration exception item not delivered: ${(error as Error)?.message}`));
      }
      if (after.considerPromotionProjectId) {
        // M-F1 / M-F4, after the commit and from the committed rows: "the queue is empty" is only
        // true of rows that landed, and this job's own is one of them. The service logs and swallows
        // its own failures — a candidate not made now is made by the next landing.
        await this.promotions?.considerCandidate(after.considerPromotionProjectId);
      }
    }
    return applied.answer;
  }

  /**
   * What one claimed Codex rate-limit reset step came to (docs/codex-rate-limit-reset-contract.md §6.3,
   * §6.5): 200 with the receipt when the result was applied or restated a fact already recorded, and
   * otherwise the refusal as 400 / 404 / 409 `{ code }`, after which the claim that sent it stops.
   * Scoped by the runner token alone — another runner's operation is not found — and not gated on the
   * capability header: a result answers a claim this machine already holds, whatever its process
   * declares now. The body is typed for what it claims to be and carries no public id; nothing trusts
   * that claim before `codexResetResultViolations` has checked it.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('codex-rate-limit-reset-result')
  @HttpCode(200)
  async codexRateLimitResetResult(
    @CurrentRunner() runner: { id: string },
    @Body() body: CodexRateLimitResetResultRequest,
  ) {
    const answer = await receiveCodexResetResult(this.prisma, runner.id, body);
    if (answer.status !== 200) throw new HttpException(answer.body, answer.status);
    return answer.body;
  }

  /**
   * Whether this runner should re-read its runtime CLIs' model lists on this beat.
   *
   * Claimed, not redelivered — unlike the repairs above, and for the opposite reason: there is no
   * outcome to wait for. The refreshed catalog comes back as `modelCatalog` on a later heartbeat,
   * so a request that is handed over and then lost costs the user one press, while a request left
   * pending until an outcome arrived would re-trigger the CLI spawns on every beat forever.
   *
   * The clear IS the claim: one conditional UPDATE, so two heartbeats racing each other hand the
   * request to exactly one of them instead of both re-reading the same lists.
   */
  private async drainModelCatalogRefresh(runnerId: string): Promise<true | undefined> {
    const claimed = await this.prisma.runner.updateMany({
      where: { id: runnerId, modelCatalogRefreshAt: { not: null } },
      data: { modelCatalogRefreshAt: null },
    });
    return claimed.count > 0 ? true : undefined;
  }

  /**
   * The checkout repair this runner should run, if one is in flight.
   *
   * `pending` is re-delivered every heartbeat until the runner reports an outcome — the repair is
   * idempotent (a clean checkout is a no-op) and short, so redelivery is cheaper than a claim
   * protocol. An abandoned request is swept on the same principle as the sign-in/install relays:
   * past the window nothing is running it, and leaving it pending would block the next attempt.
   */
  private async drainRepoCleanupRequest(runnerId: string): Promise<RepoCleanupCommand | undefined> {
    const r = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { repoCleanupStatus: true, repoCleanupRoot: true, repoCleanupAt: true },
    });
    if (r?.repoCleanupStatus !== 'pending' || !r.repoCleanupRoot) return undefined;
    const started = r.repoCleanupAt?.getTime() ?? 0;
    if (started && Date.now() - started > REPO_CLEANUP_TIMEOUT_MS) {
      await this.prisma.runner.update({
        where: { id: runnerId },
        data: {
          repoCleanupStatus: 'failed',
          repoCleanupMessage: 'Clean-up timed out — the runner never picked it up. Try again.',
        },
      });
      return undefined;
    }
    return { root: r.repoCleanupRoot, requestedAt: r.repoCleanupAt?.toISOString() ?? '' };
  }

  /**
   * The directory this runner should report local Claude Code history for, if anyone is asking.
   *
   * Handed over ONCE rather than redelivered until answered, unlike the relays above. What waits
   * on this is a person with a form open: an unanswered request should expire quietly — retyping
   * the path asks again — instead of being retried forever at a runner too old to know the field,
   * or scanned twice because the answer's own POST crossed the next heartbeat.
   *
   * The hand-over is a compare-and-set on the state it was read in, so two API replicas draining
   * the same moment give the scan to one runner process rather than both.
   */
  private async drainClaudeHistoryRequest(
    runnerId: string,
  ): Promise<RunnerHeartbeatResponse['claudeHistoryRequest']> {
    const r = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { claudeHistoryStatus: true, claudeHistoryPath: true, claudeHistoryAt: true },
    });
    if (r?.claudeHistoryStatus !== 'pending' || !r.claudeHistoryPath) return undefined;
    const claimed = await this.prisma.runner.updateMany({
      where: { id: runnerId, claudeHistoryStatus: 'pending', claudeHistoryPath: r.claudeHistoryPath },
      data: { claudeHistoryStatus: 'scanning' },
    });
    if (claimed.count === 0) return undefined;
    return { workDir: r.claudeHistoryPath, requestedAt: r.claudeHistoryAt?.toISOString() ?? '' };
  }

  /**
   * Runner → control plane: how the checkout repair went.
   *
   * The reported state also corrects the stored health snapshot for that root, so the warning
   * clears the moment the repair lands instead of lingering until the runner's next scan (a minute
   * of a banner insisting merges are blocked when they aren't).
   */
  @UseGuards(RunnerAuthGuard)
  @Post('repo-cleanup-result')
  @HttpCode(200)
  async repoCleanupResult(
    @CurrentRunner() runner: { id: string },
    @Body() body: RunnerRepoCleanupResult,
  ) {
    const status = body?.status;
    if (status !== 'done' && status !== 'failed') {
      throw new BadRequestException('Unknown repo cleanup status');
    }
    const current = await this.prisma.runner.findUnique({
      where: { id: runner.id },
      select: { repoHealth: true },
    });
    const reports = readRunnerRepoHealth(current?.repoHealth);
    const repaired =
      body.root && body.state
        ? reports.map((r) => (r.root === body.root ? { ...r, state: body.state!, paths: [] } : r))
        : reports;
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        repoCleanupStatus: status,
        repoCleanupBranch: body.rescueBranch ?? null,
        repoCleanupMessage: body.message ?? null,
        repoHealth: repaired as unknown as Prisma.InputJsonValue,
      },
    });
    return { ok: true };
  }

  /**
   * Runner → control plane: what Claude Code history that machine holds under the directory it was
   * asked about.
   *
   * Stored only while the relay still names that same path. Someone typing a directory asks about
   * several in a row, and an answer that arrives after the field moved on must be dropped rather
   * than become the verdict on what is there now — offering to import a different project's
   * conversations is the one mistake this feature cannot make.
   *
   * The body is re-read rather than trusted: it crosses the runner boundary, which nothing
   * validates on the way in, and it is rendered as a number of conversations and a list of titles.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('claude-history-result')
  @HttpCode(200)
  async claudeHistoryResult(
    @CurrentRunner() runner: { id: string },
    @Body() body: RunnerClaudeHistoryResult,
  ) {
    const workDir = typeof body?.workDir === 'string' ? body.workDir.trim() : '';
    if (!workDir) throw new BadRequestException('workDir is required');
    const count = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const text = (value: unknown, max: number): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
    // Filled to the cap with entries that could actually be imported, rather than capped first and
    // then filtered: an entry with no session id is one no import could ever be keyed on, and a
    // body padded with them must not shrink the answer below what one scan is allowed to carry.
    // Bounded either way — it stops at the cap however long the list is.
    const transcripts: ClaudeHistoryTranscript[] = [];
    for (const t of Array.isArray(body?.transcripts) ? body.transcripts : []) {
      if (transcripts.length >= CLAUDE_HISTORY_MAX_TRANSCRIPTS) break;
      const claudeSessionId = text(t?.claudeSessionId, 64);
      if (!claudeSessionId) continue;
      const title = text(t?.title, 200);
      transcripts.push({
        claudeSessionId,
        ...(title ? { title } : {}),
        lastActiveAt: text(t?.lastActiveAt, 40) ?? '',
        messages: count(t?.messages),
      });
    }
    const result: RunnerClaudeHistoryResult = {
      workDir,
      windowDays: count(body?.windowDays),
      conversations: Math.max(count(body?.conversations), transcripts.length),
      bytes: count(body?.bytes),
      events: count(body?.events),
      transcripts,
      ...(text(body?.error, 500) ? { error: text(body?.error, 500) } : {}),
    };
    const stored = await this.prisma.runner.updateMany({
      where: { id: runner.id, claudeHistoryPath: workDir },
      data: {
        claudeHistoryStatus: result.error ? 'failed' : 'done',
        claudeHistoryResult: result as unknown as Prisma.InputJsonValue,
      },
    });
    return { ok: true, applied: stored.count > 0 };
  }

  /**
   * The engine install this runner should be running, if one is in flight.
   *
   * `pending` re-delivers every heartbeat until the runner's first report moves the row to
   * `installing` — the runner's own guard makes the repeat a no-op. An abandoned install is swept
   * here for the same reason sign-ins are: the runner's installer times out on its own, so a row
   * still in flight past that window has no process behind it and would block the next attempt.
   */
  private async drainInstallRequest(runnerId: string): Promise<InstallCommand | undefined> {
    const r = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { installStatus: true, installEngine: true, installAt: true, installMode: true },
    });
    if (!r?.installStatus) return undefined;
    const update = r.installMode === 'update';
    const started = r.installAt?.getTime() ?? 0;
    if (started && Date.now() - started > INSTALL_RELAY_TIMEOUT_MS) {
      if (r.installStatus === 'pending' || r.installStatus === 'installing') {
        await this.prisma.runner.update({
          where: { id: runnerId },
          data: {
            installStatus: 'failed',
            installMessage: update
              ? 'Update timed out — start it again, or run `orbit engine-update` on that machine.'
              : 'Install timed out — start it again, or run the command by hand.',
          },
        });
      }
      return undefined;
    }
    if (r.installStatus !== 'pending') return undefined;
    // An update names no engine — it does every CLI already on the machine, like the daily loop.
    if (update) return { attempt: r.installAt?.toISOString() ?? '', mode: 'update' };
    if (!isLoginEngine(r.installEngine)) return undefined;
    return { engine: r.installEngine, attempt: r.installAt?.toISOString() ?? '', mode: 'install' };
  }

  /** Runner → control plane: one step of the engine-install relay, scoped to the runner itself. */
  @UseGuards(RunnerAuthGuard)
  @Post('install-result')
  @HttpCode(200)
  async installResult(@CurrentRunner() runner: { id: string }, @Body() body: InstallResult) {
    const status = body?.status;
    if (status !== 'installing' && status !== 'done' && status !== 'failed') {
      throw new BadRequestException('Unknown install status');
    }
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        installStatus: status,
        // The command survives the outcome: on failure it is what the user runs by hand.
        installCommand: body.command ?? undefined,
        installMessage: body.message ?? null,
      },
    });
    return { ok: true };
  }

  /**
   * The next step of this runner's sign-in relay, if one is in flight.
   *
   * `pending` re-delivers `start` every heartbeat until the runner's first status report moves
   * the row to `awaiting_code` — the runner's own guard makes the repeat a no-op. A pasted code
   * is delivered exactly once and cleared immediately: it is single-use, so re-sending it after
   * the CLI consumed it would only ever fail, and holding it longer keeps a credential at rest
   * for no reason.
   *
   * An abandoned relay is swept here rather than by a timer: the runner kills its own CLI after
   * loginRelayTimeout, so a row still `pending`/`awaiting_code` past that window has no process
   * behind it and would otherwise block sign-in forever.
   */
  private async drainLoginRequest(runnerId: string): Promise<LoginCommand | undefined> {
    const r = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: {
        loginStatus: true,
        loginEngine: true,
        loginCode: true,
        loginAt: true,
      },
    });
    if (!r?.loginStatus) return undefined;
    const started = r.loginAt?.getTime() ?? 0;
    if (started && Date.now() - started > LOGIN_RELAY_TIMEOUT_MS) {
      if (r.loginStatus === 'pending' || r.loginStatus === 'awaiting_code' || r.loginStatus === 'awaiting_approval') {
        await this.prisma.runner.update({
          where: { id: runnerId },
          data: {
            loginStatus: 'failed',
            loginCode: null,
            loginUserCode: null,
            loginMessage: 'Sign-in timed out — start it again.',
          },
        });
      }
      return undefined;
    }
    if (r.loginStatus === 'pending')
      return {
        action: 'start',
        // NULL predates the relay driving anything but claude.
        engine: (r.loginEngine as LoginCommand['engine']) ?? 'claude',
        attempt: r.loginAt?.toISOString() ?? '',
      };
    if (r.loginStatus === 'awaiting_code' && r.loginCode) {
      await this.prisma.runner.update({
        where: { id: runnerId },
        data: { loginCode: null },
      });
      return { action: 'code', code: r.loginCode };
    }
    return undefined;
  }

  /**
   * Runner → control plane: one step of the sign-in relay. Authenticated as the runner, and
   * scoped to it, so a runner can only ever move its own row.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('login-result')
  @HttpCode(200)
  async loginResult(@CurrentRunner() runner: { id: string }, @Body() body: LoginResult) {
    const status = body?.status;
    if (status !== 'awaiting_code' && status !== 'awaiting_approval' && status !== 'done' && status !== 'failed') {
      throw new BadRequestException('Unknown login status');
    }
    const waiting = status === 'awaiting_code' || status === 'awaiting_approval';
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        loginStatus: status,
        // A retry after a rejected code republishes the same still-valid URL, so just take
        // whatever the runner reported; clear any code still queued behind it either way.
        loginUrl: waiting ? (body.url ?? null) : null,
        // Only the device flow carries one, and it dies with the attempt it belongs to.
        loginUserCode: status === 'awaiting_approval' ? (body.userCode ?? null) : null,
        loginCode: null,
        loginMessage: body.message ?? null,
      },
    });
    return { ok: true };
  }

  /**
   * Mark pending OpenCode work visibly before refusing a legacy runner. The conditional update
   * repeats the scheduling predicates, so a capable claim/cancel racing this check can never have
   * its now-live/ended row stamped with a stale upgrade error.
   */
  private async markOpenCodeUpgradeRequired(
    runnerId: string,
    candidates?: Array<{ id: string; error: string | null }>,
  ): Promise<boolean> {
    const pending =
      candidates ??
      (await this.prisma.session.findMany({
        where: {
          assignedRunnerId: runnerId,
          status: RunStatus.PENDING,
          provider: AgentProvider.OPENCODE,
          cancelRequestedAt: null,
        },
        select: { id: true, error: true },
      }));
    if (pending.length === 0) return false;
    const unmarked = pending
      .filter((session) => session.error !== OPENCODE_RUNNER_UPGRADE_ERROR)
      .map((session) => session.id);
    if (unmarked.length > 0) {
      const marked = await this.prisma.session.updateMany({
        where: {
          id: { in: unmarked },
          assignedRunnerId: runnerId,
          status: RunStatus.PENDING,
          provider: AgentProvider.OPENCODE,
          cancelRequestedAt: null,
        },
        data: { error: OPENCODE_RUNNER_UPGRADE_ERROR },
      });
      if (marked.count > 0) {
        for (const id of unmarked) this.realtime.publishSessionCreated(id);
      }
    }
    return true;
  }

  /**
   * SR35, said out loud on the rows it applies to.
   *
   * Mirrors `markOpenCodeUpgradeRequired` exactly, because the situation is the same one: a session
   * this machine's binary cannot drive, withheld by the claim SQL, which would otherwise sit PENDING
   * with nothing on it to say why. What differs is only that "cannot drive" here means "would drive
   * it from the wrong commit" — a runner without `source-pin/v1` does not fail on the payload, it
   * ignores the field and starts from the workDir's HEAD, which is worse than failing.
   *
   * `error` and NOT `source_refusal_code`: the refusal column is welded to `sourceState = 'REFUSED'`
   * by migration 0231, and REFUSED is terminal. This row is not terminal — a newer runner makes it
   * runnable — so it stays SELECTED and the explanation rides on the display column instead (§10.1's
   * note on why this one dispatch-path code never lands in the state machine).
   */
  private async markSourceProtocolUnsupported(runnerId: string): Promise<boolean> {
    const pending = await this.prisma.session.findMany({
      where: {
        assignedRunnerId: runnerId,
        status: RunStatus.PENDING,
        cancelRequestedAt: null,
        sourceState: { not: 'UNBOUND' },
      },
      select: { id: true, error: true },
    });
    if (pending.length === 0) return false;
    const unmarked = pending
      .filter((session) => session.error !== SOURCE_PROTOCOL_UNSUPPORTED_ERROR)
      .map((session) => session.id);
    if (unmarked.length > 0) {
      const marked = await this.prisma.session.updateMany({
        where: {
          id: { in: unmarked },
          assignedRunnerId: runnerId,
          status: RunStatus.PENDING,
          cancelRequestedAt: null,
          sourceState: { not: 'UNBOUND' },
        },
        data: { error: SOURCE_PROTOCOL_UNSUPPORTED_ERROR },
      });
      if (marked.count > 0) {
        for (const id of unmarked) this.realtime.publishSessionCreated(id);
      }
    }
    return true;
  }

  // ── Interactive sessions (Route B) ──

  /** Long-poll: returns one claimed session, or null when nothing is available. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/claim')
  async claim(
    @CurrentRunner() runner: { id: string },
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
    @Headers(RUNNER_PROVIDERS_HEADER) providerHeader?: string,
  ): Promise<ClaimedSession | null> {
    const supportsTerminalHandoff = runnerSupportsCapability(capabilities, SESSION_TERMINAL_HANDOFF_V1);
    const supportsSourcePin = runnerSupportsCapability(capabilities, SESSION_SOURCE_PIN_V1);
    const supportedProviders = advertisedRunnerProviders(providerHeader);
    if (!supportedProviders.includes(AgentProvider.OPENCODE)) {
      // Explain the stall on the OpenCode rows themselves and then carry on: the claim SQL
      // (plus migration 0080's trigger) already keeps them away from a legacy runner, so
      // failing the request would only strand this runner's Claude/Codex work as well.
      await this.markOpenCodeUpgradeRequired(runner.id);
    }
    if (!supportsSourcePin) {
      // Same shape, same reason (SR35): the claim SQL already withholds these rows, and failing the
      // whole long-poll over one row this process cannot drive would strand every other session
      // assigned to this machine. What the marking adds is the WHY — without it the row sits
      // PENDING forever with nothing on it to explain that the machine, not the queue, is the
      // reason.
      await this.markSourceProtocolUnsupported(runner.id);
    }
    const job = await this.queue.claimSessionForRunner(
      { id: runner.id, supportedProviders },
      LONG_POLL_MS,
      supportsTerminalHandoff,
      supportsSourcePin,
    );
    if (job?.allowOrchestration) {
      if (runnerSupportsCapability(capabilities, SESSION_ORCHESTRATION_CREDENTIAL_V1)) {
        job.orchestrationToken = await this.orchestration.issue(runner.id, job.sessionId);
      } else {
        // Older runners only understand the boolean and would expose orchestration tools
        // without being able to authenticate them. Negotiate the whole feature off.
        job.allowOrchestration = false;
        job.orchestrationToken = undefined;
      }
    }
    // A claimed session may already have a warm process whose inbox long-poll is asleep.
    // Wake it only after the authoritative PENDING->RUNNING transition acquired a slot.
    if (job) this.realtime.notifyInbox(job.sessionId);
    return job;
  }

  /** Retain every open checkout on restart; the payload status tells the runner which is active. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/reclaim')
  async reclaim(
    // runsAsRoot rides the authenticated row (RunnerAuthGuard loads it whole): the claim below has
    // to withdraw Bypass for the machine that is about to spawn the process, not for some other.
    @CurrentRunner() runner: { id: string; ownerId: string; runsAsRoot?: boolean | null },
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
    @Headers(RUNNER_PROVIDERS_HEADER) providerHeader?: string,
  ): Promise<ReclaimResponse> {
    const supportsOrchestrationCredential = runnerSupportsCapability(
      capabilities,
      SESSION_ORCHESTRATION_CREDENTIAL_V1,
    );
    const supportsTerminalHandoff = runnerSupportsCapability(
      capabilities,
      SESSION_TERMINAL_HANDOFF_V1,
    );
    const supportsSourcePin = runnerSupportsCapability(capabilities, SESSION_SOURCE_PIN_V1);
    const sessions = await this.prisma.session.findMany({
      where: { assignedRunnerId: runner.id, ownerId: runner.ownerId, status: { in: OPEN } },
      include: {
        // Same standing "always allow" grants the claim path sends: a reclaimed session must
        // not start re-asking about calls this workspace already approved permanently.
        workspace: { include: { permissionRules: { orderBy: { createdAt: 'asc' } } } },
        assignedRunner: { select: { runtimeDefaultModels: true, modelCatalog: true } },
        // The account-level permission default, which replaced the per-workspace one.
        owner: { select: { preferences: true } },
      },
    });
    const openCodeSessions = sessions.filter(
      (session) =>
        (session.provider ?? AgentProvider.CLAUDE) === AgentProvider.OPENCODE,
    );
    const legacyOpenCode =
      openCodeSessions.length > 0 &&
      !runnerAdvertisesProvider(providerHeader, AgentProvider.OPENCODE);
    if (legacyOpenCode) {
      await this.markOpenCodeUpgradeRequired(
        runner.id,
        openCodeSessions
          .filter(
            (session) =>
              session.status === RunStatus.PENDING && session.cancelRequestedAt == null,
          )
          .map((session) => ({ id: session.id, error: session.error })),
      );
      // Omit the rows rather than failing the request. A 426 is not retryable on the runner, so
      // refusing here shuts the whole process down over one session it merely cannot drive. The
      // checkouts stay safe: worktree GC asks `sessions/worktrees-removable`, which keeps every
      // non-terminal session, and the claim SQL never hands an OpenCode row to a legacy runner.
    }
    const reclaimable = legacyOpenCode
      ? sessions.filter((session) => !openCodeSessions.includes(session))
      : sessions;
    // How to ASK each authority, read once for the whole response rather than per session: the
    // frozen identity travels on each session row, and only the remote's local name and the
    // `RUNNER_LOCAL` machine come from the binding (§3.2 freezes neither). A binding that has been
    // deleted since is simply absent here, and `sessionSourceSnapshot` falls back to `origin` —
    // deleting a binding must not rewrite a snapshot frozen against it (SR29).
    const sourceBindings = new Map<string, { remoteName: string; authorityRunnerId: string | null }>();
    const bindingIds = [
      ...new Set(sessions.map((s) => s.sourceCodebaseId).filter((id): id is string => !!id)),
    ];
    if (bindingIds.length > 0) {
      for (const binding of await this.prisma.projectCodebase.findMany({
        where: { id: { in: bindingIds } },
        select: { id: true, remoteName: true, authorityRunnerId: true },
      })) {
        sourceBindings.set(binding.id, binding);
      }
    }
    // Reclaim never mutates lifecycle/lease ownership. The runner takes each row over with an
    // expected-owner CAS after receiving the snapshot; therefore a timed-out, delayed request
    // cannot retire a generation activated from a newer response. The only write below is an
    // unset-only model snapshot, which prevents a rolling-upgrade session from drifting again.
    const watchRollout = currentWatchRollout();
    const out: ReclaimSession[] = [];
    for (const s of reclaimable) {
      if (!supportsTerminalHandoff && isTerminalResumeHandoffOwner(s.inboxLeaseOwner)) {
        continue;
      }
      // SR35 again, on the other door. A downgraded runner must not re-attach a session whose
      // baseline it cannot honour: reclaim is where a process rebuilds supervisors from checkouts,
      // and one rebuilt without the pin is one that resumes from whatever the shared checkout says
      // now. Omitted rather than refused, for the same reason the OpenCode rows are.
      if (!supportsSourcePin && hasResolvedSource(s.sourceState)) {
        continue;
      }
      const workspace = s.workspace;
      const declared = s.provider ?? null;
      // Custom provider borrows a built-in runtime — resolve the runner-facing provider, model,
      // and injected env so a resumed session keeps talking to the configured endpoint. Owner
      // scope mirrors the claim path: a personal provider resolves only for its owner's sessions.
      const declaredIsBuiltin = isBuiltinProvider(declared, s.providerBuiltin);
      const customRow = declaredIsBuiltin
        ? null
        : await this.prisma.modelProvider.findFirst({
            where: {
              slug: declared!,
              OR: [{ ownerId: null }, { ownerId: s.ownerId }],
            },
          });
      const resolveExec = (sessionModel: string | null) =>
        resolveProviderExec({
          declaredProvider: declared,
          declaredProviderBuiltin: s.providerBuiltin,
          customRow,
          sessionModel,
          usesRuntimeDefaultModel: s.usesRuntimeDefaultModel,
          runtimeDefaultModels: s.assignedRunner?.runtimeDefaultModels,
          workspaceModel: workspace?.model,
          modelCatalog: s.assignedRunner?.modelCatalog,
          workspaceEnv: workspace?.env as Record<string, string> | null,
        });
      let exec = resolveExec(s.model);
      // Same materialization as the claim path: an unset model is snapshotted, and one the runtime
      // has retired is refreshed to what this session now actually runs.
      if (s.model === null || s.model.trim() === '' || exec.retiredPin) {
        const materialized = await this.prisma.$executeRaw`
          UPDATE "session"
          SET "model" = ${exec.model}
          WHERE "id" = ${s.id}::uuid
            AND "model" IS NOT DISTINCT FROM ${s.model}
        `;
        if (materialized === 0) {
          // A simultaneous Session config edit owns the value. Return that winner to the runner
          // rather than the stale inherited default from the reclaim snapshot.
          const winner = await this.prisma.session.findUniqueOrThrow({
            where: { id: s.id },
            select: { model: true },
          });
          exec = resolveExec(winner.model);
        }
      }
      const provider = exec.provider;
      const permissionMode = resolvePermissionMode(s.permissionMode, s.owner);
      const runtime = reclaimRuntimeIds({
        provider,
        sessionId: s.id,
        runtimeSessionId: s.runtimeSessionId,
      });
      if (!runtime) continue;
      const agg = await this.prisma.runEvent.aggregate({
        where: { sessionId: s.id },
        _max: { seq: true },
      });
      // The stored session model wins over Runtime/ModelProvider defaults, so a resumed process
      // keeps the model it was created with; cross-provider ids are still coerced safely.
      const workspaceCfg: AgentExecConfig = {
        provider,
        model: exec.model,
        appendSystemPrompt: workspace?.appendSystemPrompt ?? undefined,
        systemPrompt: workspace?.systemPrompt ?? undefined,
        allowedTools: dispatchAllowedTools(
          provider,
          ALWAYS_ALLOWED_TOOLS,
          workspace?.permissionRules ?? [],
        ),
        disallowedTools: (workspace?.disallowedTools as string[] | null) ?? [],
        permissionMode: normalizeBuiltinPermissionMode(
          provider,
          exec.model,
          permissionMode,
          customRow?.enabled === true,
          runner.runsAsRoot,
        ),
        // Whether the fast lane is actually on. Policed HERE rather than where it was picked,
        // for the same reason an OpenCode variant is: the constraint is about the model this
        // session dispatches with, which a create request that named none does not know. A
        // session carrying the flag onto a model with no fast lane runs without it — both engines
        // would drop the setting in silence anyway (Claude ignores the key, Codex omits a tier its
        // catalogue does not advertise), and the runner would have sent something that does
        // nothing. For Codex the catalogue is this runner's own report, the same row the picker
        // drew the pill from.
        fastMode:
          s.fastMode &&
          fastModeAvailable(provider, exec.model, s.assignedRunner?.modelCatalog as RunnerModelCatalog | null),
        // Per-session effort wins; otherwise use the workspace's effort setting.
        // Same dispatch-time variant check as the queue claim: an OpenCode variant is only
        // valid against the assigned runner's reported catalog for this model.
        effort: normalizeEffortForRuntimeModel(
          provider,
          s.effort ?? workspace?.effort,
          exec.model,
          s.assignedRunner?.modelCatalog,
        ),
        // Includes a custom provider's injected baseUrl/key (else just the workspace's env).
        env: exec.env,
      };
      // Reclaim must still return a cancelled/deleted live runtime so the runner can drain it,
      // but orchestration discovery and credential issuance use the authorizer's exact live
      // eligibility conditions. This prevents tools from appearing only to fail every call.
      const allowOrchestration =
        supportsOrchestrationCredential &&
        s.ownerId === runner.ownerId &&
        s.assignedRunnerId === runner.id &&
        s.deletedAt === null &&
        s.cancelRequestedAt === null &&
        OPEN.includes(s.status) &&
        workspace?.deletedAt === null &&
        workspace.enableOrchestration;
      out.push({
        sessionId: s.id,
        status: s.status as SharedRunStatus,
        provider,
        runtimeSessionId: runtime.runtimeSessionId,
        leaseOwner: s.inboxLeaseOwner ?? undefined,
        title: s.title,
        sessionUuid: runtime.sessionUuid,
        maxSeq: agg._max.seq ?? 0,
        // cf. the claim path: non-null = import PENDING, and the runner performs the import step
        // inside this claim before the spawn (a runner restarted mid-import resumes it here).
        importSourceCwd: s.importSourceCwd ?? undefined,
        // …and, cf. the claim path, an import this control plane settles without an engine: a
        // runner that comes back to an unfinished import finishes it and goes cold the same way.
        importOnly: s.importSourceCwd != null,
        agent: workspaceCfg,
        workDir: workspace?.workDir ?? undefined,
        branch: s.branch ?? undefined,
        autoInitGit: workspace?.autoInitGit ?? undefined,
        // cf. the claim path: the branch this session merges into, so a restarted runner
        // still judges "already merged" against it rather than main.
        mergeTarget: s.mergeTarget ?? workspace?.defaultMergeTarget ?? undefined,
        agentId: s.workspaceId ?? undefined,
        taskId: s.taskId ?? undefined,
        allowOrchestration,
        orchestrationToken: allowOrchestration
          ? await this.orchestration.issue(runner.id, s.id)
          : undefined,
        // cf. the claim path: a reclaimed session is spawned again, and Watch may have been switched since its claim.
        ...watchClaimFields(watchRollout, s.ownerId),
        // Read, never re-derived (SR29). A session already PINNED comes back on the SHA its first
        // claim froze, whatever the binding's configuration or the ref's tip have done since —
        // that is what makes a runner restart a continuation of the same run rather than a new one
        // that happens to have the same id.
        source: sessionSourceSnapshot(
          s,
          s.sourceCodebaseId ? (sourceBindings.get(s.sourceCodebaseId) ?? null) : null,
        ),
      });
    }
    return { sessions: out };
  }

  /**
   * §6.3 step 3: the runner reports the commit it resolved (or the gate's refusal), and this freezes
   * it by compare-and-set. `freezeSessionSourcePin` holds the argument and the statements; this
   * route is the door and the one side effect the door owes its clients.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/source/pin')
  @HttpCode(200)
  async pinSessionSource(
    @CurrentRunner() runner: { id: string; ownerId: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SourcePinRequest,
  ): Promise<SourcePinResponse> {
    const result = await freezeSessionSourcePin(
      this.prisma,
      { sessionId, runnerId: runner.id, ownerId: runner.ownerId },
      dto,
    );
    // Only the winner changed anything, so only the winner announces it. A loser publishing would
    // make the same freeze look like two events to every connected client.
    if (result.wonRace) this.realtime.publishSessionUpdated(sessionId);
    return result;
  }

  /** Hand inbox activation authority from the owner observed in claim/reclaim to this process. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/takeover-leases')
  @HttpCode(200)
  async takeoverLeases(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: TakeoverTurnLeasesRequest,
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
  ): Promise<TakeoverTurnLeasesResponse> {
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    if (!leaseOwner) throw new BadRequestException('leaseOwner is required');
    const expectedLeaseOwner = parseLeaseGeneration(dto?.expectedLeaseOwner ?? undefined);
    // Retried whole. Every fence this evaluates — the lease owner, the generation, the session's
    // status — is re-read under the row lock inside the closure, so a re-run judges the state the
    // winning transaction left rather than replaying a takeover decided against a discarded
    // snapshot. `dto` and the parsed generations are computed above and identical on every attempt.
    const taken = await withTransactionRetry(this.prisma, async (tx) => {
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
          status: RunStatus;
          mergeStatus: string | null;
          mergeOperationId: string | null;
          mergeOperationOwner: string | null;
          mergeRequestedAt: Date | null;
          commitStatus: string | null;
          commitOperationId: string | null;
          commitOperationOwner: string | null;
          commitRequestedAt: Date | null;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner", status,
               "merge_status" AS "mergeStatus",
               "merge_operation_id" AS "mergeOperationId",
               "merge_operation_owner" AS "mergeOperationOwner",
               "merge_requested_at" AS "mergeRequestedAt",
               "commit_status" AS "commitStatus",
               "commit_operation_id" AS "commitOperationId",
               "commit_operation_owner" AS "commitOperationOwner",
               "commit_requested_at" AS "commitRequestedAt"
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      if (!OPEN.includes(owned[0].status)) {
        throw new ConflictException('session is no longer open');
      }
      const currentOwner = owned[0].inboxLeaseOwner;
      if (
        isTerminalResumeHandoffOwner(currentOwner) &&
        !runnerSupportsCapability(capabilities, SESSION_TERMINAL_HANDOFF_V1)
      ) {
        throw new ConflictException('runner does not support terminal session handoff');
      }
      if (currentOwner === leaseOwner) return { status: owned[0].status, orphanedApprovals: [] };
      if (
        pendingWorktreeOperationMayBeExecuting(
          owned[0].mergeStatus,
          owned[0].mergeOperationId,
          owned[0].mergeOperationOwner,
          owned[0].mergeRequestedAt,
        ) ||
        pendingWorktreeOperationMayBeExecuting(
          owned[0].commitStatus,
          owned[0].commitOperationId,
          owned[0].commitOperationOwner,
          owned[0].commitRequestedAt,
        )
      ) {
        // A different process may still be mutating this checkout/repository.
        // Claimed modern operations and ambiguous legacy NULL/NULL attempts are
        // deliberately fail-closed; never rotate their supervisor owner.
        throw new ConflictException('wait for the pending worktree operation to finish');
      }
      if (currentOwner !== expectedLeaseOwner) {
        throw new ConflictException('inbox lease owner changed; refresh the session snapshot');
      }

      const fence = owned[0].inboxLeaseGeneration ?? randomUUID();
      await tx.$executeRaw`
        INSERT INTO "inbox_lease_generation"
          ("generation", "session_id", "lease_owner", "retired_at")
        VALUES (${fence}::uuid, ${sessionId}::uuid, ${currentOwner}::uuid, now())
        ON CONFLICT ("generation") DO UPDATE
          SET "retired_at" = COALESCE("inbox_lease_generation"."retired_at", now())
        WHERE "inbox_lease_generation"."session_id" = EXCLUDED."session_id"
      `;
      // Rotating the owner means a different process now supervises this session, so the one
      // that launched its background shells and sub-workspaces is gone and took them with it. Clear
      // the running sets here as well as on a runtime handshake (see bgReset): `init`/`resumed`
      // only fire when an engine actually starts, which for a session that parks and is never
      // resumed is never — leaving it reading "N background processes running" for the rest of
      // its life. Takeover is the one point where the handoff is observable without the user
      // having to touch the session. The one background process a predecessor hands on — a
      // runner-hosted job, across a self-update — comes back through the `running` report the new
      // process sends when it adopts the job (see bgRunning in events).
      //
      // engineTurnActive is the same kind of claim about the predecessor's engine process, and
      // dies with it for the same reason. A runner killed mid-turn (crash, restart, self-update)
      // emits no turn_end, so the flag stays true and the session reads as generating forever —
      // it is what makes a parked session count toward the running set in the UI.
      await tx.$executeRaw`
        UPDATE "session"
        SET "inbox_lease_generation" = ${fence}::uuid,
            "inbox_lease_owner" = ${leaseOwner}::uuid,
            "running_bg_shells" = '{}'::text[],
            "running_bg_jobs" = '{}'::text[],
            "running_bg_job_activity" = '{}'::jsonb,
            "running_subagents" = '{}'::text[],
            "engine_turn_active" = false
        WHERE id = ${sessionId}::uuid
      `;
      await tx.$executeRaw`
        UPDATE "conversation_turn"
        SET "lease_deadline_at" = now() - interval '1 second'
        WHERE "session_id" = ${sessionId}::uuid
          AND kind IN ('message', 'shell')
          AND status = 'IN_FLIGHT'
      `;
      // The pending approval cards are the same kind of claim about the predecessor: the poll loops
      // that would carry their answers back ran inside it. Unlike the background shells, a card
      // keeps a person in front of it — it stays on screen, pressable, and answering it does
      // nothing at all — so it is collected here rather than left for the turn to end, which for a
      // turn that is about to be RE-DELIVERED to the new process may be hours away or never.
      // Only with a predecessor to have lost: see reapApprovalsOfReplacedSupervisor.
      const orphanedApprovals = currentOwner
        ? await reapApprovalsOfReplacedSupervisor(tx, sessionId)
        : [];
      return { status: owned[0].status, orphanedApprovals };
    }, loggedRetry(this.logger, 'runnerApi.takeoverLeases'));
    // After commit, and one frame per card: a client holds these from the `approval_request` it was
    // sent live, and nothing it can see changes at a takeover, so without this the card it is
    // drawing stays answerable-looking until the session is next opened from scratch.
    for (const id of taken.orphanedApprovals) {
      this.realtime.publish(sessionId, {
        seq: 0,
        type: RunEventType.APPROVAL_RESOLVED,
        payload: { id, status: APPROVAL_ABANDONED_STATUS },
        ts: new Date().toISOString(),
      });
    }
    this.realtime.notifyInbox(sessionId);
    return { ok: true, status: taken.status as SharedRunStatus };
  }

  /** Activate one freshly reserved engine as this session's sole inbox consumer. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/activate-leases')
  @HttpCode(200)
  async activateLeases(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: ActivateTurnLeasesRequest,
  ): Promise<ActivateTurnLeasesResponse> {
    const generation = parseLeaseGeneration(dto?.leaseGeneration);
    if (!generation) throw new BadRequestException('leaseGeneration is required');
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    if (!leaseOwner) throw new BadRequestException('leaseOwner is required');

    // Idempotency fast path: if this exact generation is already installed, skip the
    // FOR UPDATE lock. A reclaim storm may call takeover-leases on the same session
    // hundreds of times per minute; each call would otherwise acquire a row lock that
    // starves the claim queue's FOR UPDATE SKIP LOCKED, preventing new PENDING
    // sessions from ever being claimed.
    const preflight = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { inboxLeaseOwner: true, inboxLeaseGeneration: true, status: true },
    });
    if (
      preflight &&
      OPEN.includes(preflight.status) &&
      preflight.inboxLeaseOwner === leaseOwner &&
      preflight.inboxLeaseGeneration === generation
    ) {
      // Still answered with the handover: this path is also where a RETRY of a committed
      // activation lands (the generation is installed, the response never arrived), and a
      // stranded steer that is only reported on the attempt that installs the generation is
      // one that is never reported at all.
      return { ok: true, abandonedSteers: await this.abandonedSteers(sessionId, generation) };
    }

    // Retried whole, for the same reason as the takeover above: the ownership fence is re-read
    // under the row lock on each attempt, and nothing outside the closure moves between them.
    await withTransactionRetry(this.prisma, async (tx) => {
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
          status: RunStatus;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner", status
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      if (!OPEN.includes(owned[0].status)) {
        throw new ConflictException('session is no longer open');
      }
      if (owned[0].inboxLeaseOwner !== leaseOwner) {
        throw new ConflictException('this runner process does not own inbox activation');
      }
      const current = owned[0].inboxLeaseGeneration;
      if (current && current !== generation) {
        const currentState = await tx.$queryRaw<Array<{ retiredAt: Date | null }>>`
          SELECT "retired_at" AS "retiredAt"
          FROM "inbox_lease_generation"
          WHERE "generation" = ${current}::uuid AND "session_id" = ${sessionId}::uuid
        `;
        // Missing metadata is an unknown active consumer, not permission to replace it.
        if (currentState.length === 0 || currentState[0].retiredAt === null) {
          throw new ConflictException('another inbox generation is active');
        }
      }

      // Register before making the generation current. ON CONFLICT makes a lost committed
      // response idempotent, while the verification below rejects a generation that release
      // tombstoned before this delayed activation reached the Session lock.
      await tx.$executeRaw`
        INSERT INTO "inbox_lease_generation"
          ("generation", "session_id", "lease_owner")
        VALUES (${generation}::uuid, ${sessionId}::uuid, ${leaseOwner}::uuid)
        ON CONFLICT ("generation") DO NOTHING
      `;
      const registered = await tx.$queryRaw<
        Array<{
          sessionId: string;
          leaseOwner: string | null;
          retiredAt: Date | null;
        }>
      >`
        SELECT "session_id" AS "sessionId", "lease_owner" AS "leaseOwner",
               "retired_at" AS "retiredAt"
        FROM "inbox_lease_generation"
        WHERE "generation" = ${generation}::uuid
      `;
      if (
        registered.length !== 1 ||
        registered[0].sessionId !== sessionId ||
        registered[0].leaseOwner !== leaseOwner ||
        registered[0].retiredAt !== null
      ) {
        throw new ConflictException('inbox generation has already been retired or reused');
      }
      await tx.$executeRaw`
        UPDATE "session"
        SET "inbox_lease_generation" = ${generation}::uuid
        WHERE id = ${sessionId}::uuid
      `;
      // A legacy NULL poll or a predecessor may have leased after reclaim but before this
      // activation acquired the Session lock. Make every non-current executable turn visible
      // now, rather than letting it block the new engine for the normal five-minute deadline.
      await tx.$executeRaw`
        UPDATE "conversation_turn"
        SET "lease_deadline_at" = now() - interval '1 second'
        WHERE "session_id" = ${sessionId}::uuid
          AND kind IN ('message', 'shell')
          AND status = 'IN_FLIGHT'
          AND "lease_generation" IS DISTINCT FROM ${generation}::uuid
      `;
    }, loggedRetry(this.logger, 'runnerApi.activateLeases'));
    // A steer is deliberately NOT included above: expiring its lease would re-deliver it, and
    // the one thing mid-turn delivery must never do is write a message the engine may already
    // have acted on a second time. It is handed to the incoming process to report instead.
    return { ok: true, abandonedSteers: await this.abandonedSteers(sessionId, generation) };
  }

  /**
   * The mid-turn messages a dying process left leased, for the process replacing it to answer.
   *
   * A steer is delivered exactly once and never re-leased, so a runner that died holding one
   * leaves a row nothing else will ever come back for: not the inbox (which only hands out a
   * PENDING steer), not the lease expiry above, and not the completion of the turn it was aimed
   * at (which only re-files a steer that was still PENDING). Without this the message is simply
   * gone — no event, no queue entry, no failure — which is the single outcome mid-turn sending
   * is not allowed to produce.
   *
   * Reported rather than settled here, and read rather than written, because activation is
   * retried on transport errors: a response nobody received has to leave these rows exactly as
   * they were, so the next attempt hands the same ones over again. The runner settles each one
   * (`subtype: 'steer'`, FAILED) once it has said so on the event stream, which is what takes it
   * out of this set.
   *
   * They are reported as FAILED and not re-filed: whether the message reached the engine before
   * the process died is not knowable from here, and Codex does not de-duplicate
   * (docs/codex-turn-steer-contract.md §4.3b).
   */
  private async abandonedSteers(sessionId: string, generation: string | null): Promise<AbandonedSteer[]> {
    const stranded = await this.prisma.conversationTurn.findMany({
      where: {
        sessionId,
        kind: 'steer',
        status: 'IN_FLIGHT',
        ...(generation ? { NOT: { leaseGeneration: generation } } : {}),
      },
      select: { id: true, content: true },
      orderBy: { seq: 'asc' },
    });
    if (stranded.length === 0) return [];
    // Whether the dead process got as far as putting a bubble in the transcript decides what the
    // report has to do: amend the one that is there, or open one. Emitting a second `user` event
    // for a turn that already has one shows the same message twice.
    const announced = await this.prisma.runEvent.findMany({
      where: { sessionId, turnId: { in: stranded.map((t) => t.id) }, type: RunEventType.USER },
      select: { turnId: true },
    });
    const hasBubble = new Set(announced.map((e) => e.turnId));
    return stranded.map((t) => ({
      turnId: t.id,
      content: t.content ?? '',
      announced: hasBubble.has(t.id),
    }));
  }

  /** Expire input leases abandoned when a warm runtime is evicted. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/release-leases')
  @HttpCode(200)
  async releaseLeases(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto?: ReleaseTurnLeasesRequest,
  ): Promise<{ ok: true }> {
    const generation = parseLeaseGeneration(dto?.leaseGeneration);
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    // Retried whole. A release is idempotent by construction — it clears an ownership this
    // transaction re-reads under the row lock — so a re-run against a fresh snapshot either
    // clears it or finds it already clear, which is the same answer.
    await withTransactionRetry(this.prisma, async (tx) => {
      // Use the same Session row lock as dequeueTurn. Whichever request arrives
      // last observes the other's generation, so a delayed release from a dead
      // process can never expire its replacement's lease.
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner" FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      if (generation) {
        // Upsert a tombstone even when release beats activation to the lock. A delayed
        // activate(G1) then observes retired_at and cannot make G1 current again.
        await tx.$executeRaw`
          INSERT INTO "inbox_lease_generation"
            ("generation", "session_id", "lease_owner", "retired_at")
          VALUES (${generation}::uuid, ${sessionId}::uuid, ${leaseOwner}::uuid, now())
          ON CONFLICT ("generation") DO UPDATE
            SET "retired_at" = COALESCE("inbox_lease_generation"."retired_at", now())
          WHERE "inbox_lease_generation"."session_id" = EXCLUDED."session_id"
        `;
      }
      // A legacy runner omits both generation and owner. Preserve its NULL session state so
      // the replacement legacy engine can continue polling; modern runners are fenced by
      // takeover before they start a supervisor and always release a concrete generation.
      await tx.$executeRaw`
        UPDATE "conversation_turn"
        SET "lease_deadline_at" = now() - interval '1 second'
        WHERE "session_id" = ${sessionId}::uuid
          AND kind IN ('message', 'shell')
          AND status = 'IN_FLIGHT'
          AND "lease_generation" IS NOT DISTINCT FROM ${generation}::uuid
      `;
    }, loggedRetry(this.logger, 'runnerApi.releaseLeases'));
    this.realtime.notifyInbox(sessionId);
    return { ok: true };
  }

  /** Replace a missing/stale in-process proof without restarting the session runtime. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/orchestration-credential')
  @HttpCode(200)
  async refreshOrchestrationCredential(
    @CurrentRunner() runner: { id: string; ownerId: string },
    @Param('id', PublicIdPipe) sessionId: string,
  ): Promise<OrchestrationCredentialResponse> {
    return { orchestrationToken: await this.orchestration.reissue(runner, sessionId) };
  }

  /** Per-session long-poll: the next user turn to feed the live claude process. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/inbox')
  async inbox(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Query('leaseGeneration') leaseGeneration?: string,
    /** This poller understands `steer` — a message written into the turn already running.
     *  A runner that predates the kind does not send it, and must not be handed one: its
     *  inbox switch has no case for it, so the turn would be leased and then ignored, and a
     *  steer's lease is never reclaimed. Left unclaimed it is not lost — turn-complete
     *  re-files a still-PENDING steer as an ordinary message once its turn ends — so the
     *  message runs a turn later instead of vanishing. This is what makes the control plane
     *  safe to deploy ahead of the runners rather than only after them. */
    @Query('acceptsSteer') acceptsSteer?: string,
    /** …and knowing the kind is not the same as being able to deliver it for THIS session's
     *  engine. Every runner that speaks `steer` at all can write one into a claude turn;
     *  codex needs `turn/steer`, which arrived later, so an older binary answers that same
     *  kind by refusing it in front of the user. The declaration is re-read from the poller
     *  on every poll rather than trusted from the heartbeat snapshot createTurn used: this
     *  is the process that will actually execute the turn, and it may have been downgraded
     *  since. */
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
  ): Promise<RunInboxResponse> {
    const generation = parseLeaseGeneration(leaseGeneration);
    const declared = parseRunnerCapabilities(capabilities) ?? [];
    const deadline = Date.now() + INBOX_LONG_POLL_MS;
    for (;;) {
      const turn = await this.dequeueTurn(
        sessionId,
        runner.id,
        generation,
        acceptsSteer === '1',
        declared,
      );
      if (turn) return turn;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { turnId: '', seq: 0, kind: 'message' };
      await this.realtime.waitForInbox(sessionId, Math.min(remaining, 5000));
    }
  }

  /**
   * Fetch one of a turn's image attachments as raw bytes, for the runner to base64-encode
   * into a claude `image` content block (the ids/mimes arrive on the inbox). Runner-scoped
   * (not the user-JWT /api/attachments/:id): the attachment must belong to a session this
   * runner owns, so a runner can't read another tenant's blobs.
   */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/attachments/:attId')
  async attachment(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('attId', PublicIdPipe) attId: string,
  ): Promise<StreamableFile> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const att = await this.prisma.attachment.findFirst({
      where: { id: attId, sessionId },
      select: { data: true, mimeType: true },
    });
    if (!att) throw new NotFoundException('attachment not found');
    const data = Buffer.from(att.data);
    return new StreamableFile(data, {
      type: att.mimeType,
      disposition: 'inline',
      length: data.length,
    });
  }

  /**
   * Persist a runner-produced artifact (currently assistant markdown images) as a normal
   * session attachment. The browser cannot read `/root/...` paths from the runner, so the
   * runner uploads bytes here and rewrites the transcript markdown to `orbit-attachment:<id>`.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async uploadAttachment(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @UploadedFileParam() file: UploadedFile | undefined,
  ): Promise<{ id: string }> {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    assertValidUpload(file);
    const f = file as UploadedFile;
    const row = await this.prisma.attachment.create({
      data: {
        ownerId: session.ownerId,
        sessionId,
        mimeType: f.mimetype,
        sizeBytes: f.size,
        fileName: f.originalname || null,
        data: toBytes(f.buffer),
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/artifacts/result')
  async artifactResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: ArtifactResultRequest,
  ): Promise<{ ok: true }> {
    await this.assertSessionOwnership(sessionId, runner.id);
    if (!dto?.requestId) throw new BadRequestException('requestId is required');
    await this.prisma.conversationTurn.updateMany({
      where: { id: dto.requestId, sessionId, kind: 'artifact' },
      data: { status: 'ANSWERED', answeredAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Atomically lease the next deliverable turn for a session: interrupt/end before
   * message, and PENDING or an expired IN_FLIGHT lease (at-least-once). Executable
   * messages are gated on the claim path having already set the Session to RUNNING.
   */
  private async dequeueTurn(
    sessionId: string,
    runnerId: string,
    leaseGeneration: string | null,
    /** Whether this poller can act on a steer at all — see the inbox route. */
    acceptsSteer = false,
    /** What that poller declared it can do, which decides whether "a steer" means one for
     *  THIS session's engine. Absent is a runner that declared nothing: claude steers as it
     *  always has, and every gated runtime withholds. */
    declaredCapabilities: readonly string[] = [],
  ): Promise<RunInboxResponse | null> {
    // Retried whole. This is the inbox claim: it selects a queued turn under the Session row lock
    // and marks it in flight. A deadlock victim's claim never happened — the row is still queued —
    // so a re-run claims from the state that actually exists rather than reporting a turn it does
    // not own. The response is built from the winning attempt's read, and nothing is sent to the
    // runner until this returns.
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      // More than one inbox poller can briefly exist around a warm activation or runner
      // restart. Serialize them on the Session row so their NOT EXISTS(in-flight) checks
      // cannot both lease different messages from the same snapshot.
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
          status: RunStatus;
          ownerId: string;
          provider: string;
          providerBuiltin: boolean;
          taskId: string | null;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner", status,
               "owner_id" AS "ownerId", provider, "provider_builtin" AS "providerBuiltin"
               , "task_id" AS "taskId"
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runnerId}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      // Check lifecycle before generation compatibility. In particular, a legacy
      // NULL poller must receive the same terminal 409 as a modern engine instead
      // of taking the historical empty-poll path forever.
      if (!OPEN.includes(owned[0].status)) {
        throw new ConflictException('session is no longer open');
      }
      if (owned[0].inboxLeaseGeneration !== leaseGeneration) {
        // A modern poller carries a concrete generation. Once takeover/activation has
        // replaced it, returning an empty poll would let the dead engine keep looping
        // indefinitely. Tell it explicitly that its ownership was lost. Legacy NULL
        // pollers retain the old empty-poll compatibility behavior during upgrades.
        if (leaseGeneration) {
          throw new ConflictException('inbox lease generation is no longer current');
        }
        return null;
      }
      if (leaseGeneration) {
        const active = await tx.$queryRaw<Array<{ generation: string }>>`
          SELECT "generation"
          FROM "inbox_lease_generation"
          WHERE "generation" = ${leaseGeneration}::uuid
            AND "session_id" = ${sessionId}::uuid
            AND "lease_owner" IS NOT DISTINCT FROM ${owned[0].inboxLeaseOwner}::uuid
            AND "retired_at" IS NULL
        `;
        if (active.length === 0) {
          throw new ConflictException('inbox lease generation is missing or retired');
        }
      }
      // "Can this poller act on a steer" is not a property of the poller alone: it is this
      // runner's word about the runtime this session actually executes on. A binary that
      // knows the kind but not this engine's mid-turn call refuses every steer it is handed,
      // so withholding one here is what keeps a half-upgraded fleet on the behaviour it has
      // today. A legacy steer is re-filed after the turn; explicit CURRENT_WORK instead reaches
      // a visible failed-delivery terminal. Resolved per poll, through the same runtime resolution
      // dispatch and createTurn use, so a configured (BYOK) session is judged by the runtime it
      // borrows rather than by its slug.
      const execRuntime = await sessionExecRuntime(tx, owned[0]);
      // Legacy steer predates routing-v1 and retains its provider-specific behaviour. Explicit
      // CURRENT_WORK is narrower: only an exact-target primitive may dequeue it, otherwise a
      // Claude stdin frame could cross the target result boundary and become the next turn.
      const deliverLegacySteer =
        acceptsSteer && supportsMidTurnSteer(execRuntime, declaredCapabilities);
      const deliverCurrentWorkSteer =
        acceptsSteer
        && supportsTargetBoundCurrentWorkSteer(execRuntime, declaredCapabilities);
      // Only runtimes whose runner can durably report history compaction may stop repeating the
      // coordinator block on every turn. A null generation is a legacy poller and cannot prove a
      // process boundary either, so it stays on the correctness-first legacy path.
      const sparseCoordinatorContext = supportsSparseCoordinatorContext(
        execRuntime,
        declaredCapabilities,
        leaseGeneration,
      );
      const rows = await tx.$queryRaw<Array<{
        id: string;
        seq: number;
        kind: string;
        content: string | null;
        clientTurnId: string;
        sendIntent: string | null;
        targetTurnId: string | null;
        coordinatorContextKey: string | null;
      }>>`
        UPDATE "conversation_turn"
          SET status = 'IN_FLIGHT',
              "delivered_at" = now(),
              "lease_deadline_at" = now() + (${INBOX_LEASE_MS} * interval '1 millisecond'),
              "lease_generation" = ${leaseGeneration}::uuid
        WHERE id = (
          SELECT turn.id FROM "conversation_turn" turn
          WHERE turn."session_id" = ${sessionId}::uuid
            AND (
              -- interrupt/end land immediately, even mid-message (interrupt is the point).
              -- diff is read-only and runtime-independent, so it may land while idle too.
              -- setconfig is here for the same reason: model and permission mode are said to a
              -- resident engine rather than built into it, so nothing about the frame needs the
              -- engine to be idle, and waiting for it would be the whole delay this kind exists
              -- to remove. Its spawn-only sibling reload stays gated below: that one really
              -- does have to replace the process the running turn is executing in.
              (turn."kind" IN ('interrupt', 'end', 'diff', 'setconfig')
                AND (turn."status" = 'PENDING' OR (turn."status" = 'IN_FLIGHT' AND turn."lease_deadline_at" < now())))
              -- A reload is ordered between executable turns, but does not itself consume
              -- an active-turn slot. A cold runtime can leave it queued until the next claim.
              OR (turn."kind" = 'reload' AND turn."status" = 'PENDING' AND NOT EXISTS (
                SELECT 1 FROM "conversation_turn" inflight
                WHERE inflight."session_id" = ${sessionId}::uuid
                  AND inflight."kind" IN ('message', 'shell')
                  AND inflight."status" = 'IN_FLIGHT'
              ))
              -- A steer is the mirror image of an executable turn: it is deliverable
              -- BECAUSE one is already running, and it is written into that turn instead of
              -- waiting for its result. It neither occupies the single in-flight slot (the
              -- NOT EXISTS below counts message/shell only) nor is gated by it. Only a live
              -- lease counts as running — an expired one belongs to an engine that stopped
              -- answering, and there is nothing resident to steer.
              --
              -- Delivered once and never re-leased: an expired steer lease means the runner
              -- died holding it, and re-writing a message the engine may already have acted
              -- on is the one thing mid-turn delivery must not do. A legacy steer left PENDING
              -- when its turn ends is re-filed; explicit CURRENT_WORK is terminalized visibly.
              OR (turn."kind" = 'steer' AND turn."status" = 'PENDING'
                AND (
                  (turn."send_intent" IS NULL AND ${deliverLegacySteer}::boolean)
                  OR (turn."send_intent" = 'CURRENT_WORK' AND ${deliverCurrentWorkSteer}::boolean)
                )
                AND EXISTS (
                  SELECT 1 FROM "session" active
                  WHERE active.id = ${sessionId}::uuid
                    AND active.status = 'RUNNING'
                    AND active."cancel_requested_at" IS NULL
                )
                AND EXISTS (
                  SELECT 1 FROM "conversation_turn" inflight
                  WHERE inflight."session_id" = ${sessionId}::uuid
                    AND inflight."kind" = 'message'
                    AND inflight."status" = 'IN_FLIGHT'
                    AND inflight."lease_deadline_at" > now()
                    -- New CURRENT_WORK steers name the exact turn observed while createTurn held
                    -- this Session lock. Null retains only the rolling legacy row shape.
                    AND (turn."target_turn_id" IS NULL OR turn."target_turn_id" = inflight.id)
                ))
              -- User executable turns are deliverable only after claim changed the Session
              -- to RUNNING. An AWAITING_INPUT process may remain warm, but its inbox cannot
              -- bypass maxConcurrent merely because it is already resident.
              OR (turn."kind" IN ('message', 'shell')
                AND EXISTS (
                  SELECT 1 FROM "session" active
                  WHERE active.id = ${sessionId}::uuid
                    AND active.status = 'RUNNING'
                    AND active."cancel_requested_at" IS NULL
                )
                AND (
                  (turn."status" = 'IN_FLIGHT' AND turn."lease_deadline_at" < now())
                  OR (turn."status" = 'PENDING' AND NOT EXISTS (
                    SELECT 1 FROM "conversation_turn" inflight
                    WHERE inflight."session_id" = ${sessionId}::uuid
                      AND inflight."kind" IN ('message', 'shell')
                      AND inflight."status" = 'IN_FLIGHT'
                  ))
                ))
            )
          ORDER BY (CASE WHEN turn."kind" IN ('interrupt', 'end', 'diff') THEN 0 WHEN turn."kind" = 'setconfig' THEN 1 WHEN turn."kind" IN ('reload', 'steer') THEN 2 ELSE 3 END), turn."seq" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, seq, kind, content, "client_turn_id" AS "clientTurnId",
                  "send_intent" AS "sendIntent",
                  "target_turn_id" AS "targetTurnId",
                  "coordinator_context_key" AS "coordinatorContextKey"
      `;
      if (rows.length === 0) return null;
      const t = rows[0];
      let attachments: TurnAttachment[] | undefined;
      let content = t.content ?? undefined;
      if (t.kind === 'message' || t.kind === 'steer') {
        // Context derived from the Session is expanded at delivery, never written over the text
        // the person sent. Besides giving #references their tenant, this is where an existing
        // conversation promoted by project_create acquires the same user-level coordinator
        // opening as a dedicated project-page conversation. Reading it per delivery covers a warm
        // provider, a queued follow-up that skips claim, and runner reclaim with one path.
        const sessionContext = await tx.session.findUnique({
          where: { id: sessionId },
          select: {
            ownerId: true,
            prompt: true,
            titleBeforeProjectManagement: true,
            coordinatorContextEpoch: true,
            coordinatorContextAckKey: true,
            coordinatorForProject: { select: { id: true } },
          },
        });
        // A message turn that already produced runtime output is a lease re-delivery.
        // Resume with a continuation nudge instead of replaying its side effects. A steer is
        // never re-delivered (its lease is not reclaimable above), so it never takes this.
        const runtimeStarted = t.kind !== 'steer' && (await tx.runEvent.findFirst({
          where: {
            turnId: t.id,
            OR: [
              { type: { in: [...RUNTIME_STARTED_EVENT_TYPES] } },
              {
                type: 'system',
                payload: {
                  path: ['subtype'],
                  equals: RUNTIME_STARTED_SYSTEM_SUBTYPE,
                },
              },
            ],
          },
          select: { id: true },
        }));
        if (runtimeStarted) {
          content = buildResumeContinuation(t.content);
        } else {
          const atts = await tx.attachment.findMany({
            where: { turnId: t.id },
            select: { id: true, mimeType: true, fileName: true },
            orderBy: { createdAt: 'asc' },
          });
          if (atts.length > 0) {
            attachments = atts.map((a) => ({
              id: a.id,
              mimeType: a.mimeType,
              fileName: a.fileName ?? undefined,
            }));
          }
          // `#`-references become context here, at delivery, rather than when the message was
          // stored: the transcript keeps what the person typed, and the summary is computed at
          // the moment the run receives it. A 500-task list's counts move every minute, so one
          // expanded at send time would arrive already stale with no way for the agent to tell.
          //
          // Only on the first delivery of a message turn. A re-delivery is replaced wholesale by
          // buildResumeContinuation above, and interrupt/end/diff/shell turns are instructions to
          // the runner rather than text a model reads.
          // Scoped to the session's owner, not the runner: a reference resolves only against
          // what the person sending it may already see, so a stray id from elsewhere expands to
          // nothing rather than leaking another tenant's list into a prompt.
          if (sessionContext) {
            content = (await this.references.expand(sessionContext.ownerId, content)) ?? content;
          }
          // A list's console also carries back what the control plane noticed while nobody was
          // talking to it. Piggybacked here rather than pushed as its own turn — see
          // ListEventsService for why a second waking path is the thing being avoided.
          //
          // Not on a steer: this consumes a delivered-stamp and reads as the opening context of
          // a turn, and a steer joins a turn that is already under way.
          if (t.kind !== 'steer') {
            content = (await this.listEvents?.appendFor(tx, sessionId, content)) ?? content;
          }
        }
        // A turn filed to wake the session for its background jobs, or for a wakeup it scheduled,
        // carries nobody's words: what it says is those wakes, written in here at delivery so that all
        // of it is recorded as the control plane's note (control-plane-note.ts). Outside the branch
        // above for the reason the block below gives — a wake handed out again after its runner died
        // still has to say why. Not best-effort: this block is the turn, and one delivered without it
        // wakes the agent for nothing, so a failure rolls the claim back and leaves the turn queued.
        if (t.kind === 'message' && isBackgroundWakeTurn(t.clientTurnId)) {
          content = (await appendBackgroundWakeContext(tx, sessionId, t.clientTurnId, content)) ?? content;
          content = (await appendScheduledWakeupContext(tx, sessionId, t.clientTurnId, content)) ?? content;
        }
        // The background work this session left running, said to the engine that comes back to it.
        // Outside the branch above on purpose: a re-delivery replaced the person's text with a
        // continuation nudge, and an engine that had to be restarted is the most literal case of
        // one that never saw its job finish.
        //
        // Best-effort, exactly like the list conditions: a note about a build must never be the
        // reason the turn carrying it fails to be delivered.
        if (t.kind !== 'steer') {
          try {
            content = (await appendBackgroundJobsContext(
              tx,
              sessionId,
              t.id,
              leaseGeneration,
              content,
              owned[0].inboxLeaseOwner,
            )) ?? content;
          } catch (e) {
            this.logger.warn(
              `could not attach background jobs to session ${sessionId}: `
              + `${e instanceof Error ? e.message : e}`,
            );
          }
        }
        if (sessionContext) {
          if (!sparseCoordinatorContext) {
            // Rolling-upgrade and runtimes without a reliable compaction signal retain the old
            // behaviour. Repetition is expensive, but losing a coordinator's boundary is worse.
            content = appendCoordinatorDeliveryContext(
              content,
              sessionContext.prompt,
              sessionContext.titleBeforeProjectManagement,
              sessionContext.coordinatorForProject,
            );
          } else if (t.kind !== 'steer' && sessionContext.coordinatorForProject) {
            const projectId = sessionContext.coordinatorForProject.id;
            const contextKey = buildCoordinatorDeliveryContextKey(
              projectId,
              leaseGeneration!,
              sessionContext.coordinatorContextEpoch,
            );
            if (sessionContext.coordinatorContextAckKey !== contextKey) {
              // A dedicated project-page coordinator's initial turn already IS the canonical
              // opening. Stamp it for acknowledgement without appending a second copy. A resumed
              // delivery is not treated as that opening: its content is a continuation nudge and
              // the replacement engine must receive the standing context again.
              const openingAlreadyPresent =
                !runtimeStarted
                && t.clientTurnId === `initial-${sessionId}`
                && sessionContext.titleBeforeProjectManagement == null
                && hasCoordinatorOpening(sessionContext.prompt, projectId);
              if (!openingAlreadyPresent) {
                content = wrapCoordinatorDeliveryContext(content, projectId);
              }
              if (t.coordinatorContextKey !== contextKey) {
                await tx.conversationTurn.updateMany({
                  where: { id: t.id, sessionId, status: 'IN_FLIGHT' },
                  data: { coordinatorContextKey: contextKey },
                });
              }
            }
          }
        }
      } else if (t.kind !== 'shell') {
        // Control turns are fire-and-forget: ack on delivery so a stale one cannot
        // repeatedly jump ahead of real messages after each lease window.
        await tx.conversationTurn.updateMany({
          where: { id: t.id, status: { not: 'ANSWERED' } },
          data: { status: 'ANSWERED', answeredAt: new Date() },
        });
      }
      return {
        turnId: t.id,
        targetTurnId: t.targetTurnId ?? undefined,
        seq: t.seq,
        kind: t.kind as ConversationTurnKind,
        content,
        attachments,
        env: t.kind === 'reload' ? await this.reloadProviderEnv(tx, sessionId, t.content) : undefined,
        // Said on the delivery itself, because it is only ever true of THIS control plane and
        // is only needed while this one message is being answered for: a steer that provably
        // never reached the engine can come back here as an ordinary message (see turnComplete)
        // instead of being reported as a failure the person has to re-send by hand.
        // Explicit CURRENT_WORK gets the same answer. It was an at-most-this-turn instruction only
        // in the sense that steering was the route it asked for; a message the engine PROVABLY
        // never read has not been steered anywhere, and reporting that as a refusal leaves the
        // sender re-typing what they already sent. Same rule as the target-completion boundary,
        // reached from the other direction — see requeueUnreadCurrentWorkSteers.
        steerRequeue: t.kind === 'steer' ? true : undefined,
        taskAcceptance:
          t.kind === 'shell' && isTaskAcceptanceClientTurnId(t.clientTurnId)
            ? true
            : undefined,
        // Read here rather than frozen into the clientTurnId beside the expectation, because the
        // two answer different questions. The expectation is what the result will be JUDGED
        // against, so it is pinned at enqueue and an edit mid-run must not reach it. The budget is
        // only how long this process may run: the latest declaration is the right one, and there
        // is nothing later that compares against it.
        acceptanceTimeoutSeconds:
          t.kind === 'shell' && isTaskAcceptanceClientTurnId(t.clientTurnId)
            ? (await acceptanceBudgetSeconds(tx, owned[0].taskId)) ?? undefined
            : undefined,
      };
    }, loggedRetry(this.logger, 'runnerApi.dequeueTurn', {
      transaction: { maxWait: RUNNER_POLL_TRANSACTION_MAX_WAIT_MS },
    }));
    return outcome ?? null;
  }

  /**
   * The environment a `reload` re-spawns with, for the one reload that needs it: a provider switch
   * (see SessionsService.updateConfig). Every other reload — model, permission mode, effort — runs
   * on the environment the engine already has, and returns undefined so the runner leaves its
   * process alone beyond the flags.
   *
   * Resolved here rather than stored on the turn: the injected environment carries the provider's
   * decrypted key, and `conversation_turn.content` is neither encrypted nor short-lived. The queued
   * turn names the provider; this reads the session as it stands now and builds the rest.
   */
  private async reloadProviderEnv(
    tx: Prisma.TransactionClient,
    sessionId: string,
    content: string | null,
  ): Promise<Record<string, string> | undefined> {
    let declared: unknown;
    try {
      declared = (JSON.parse(content ?? '{}') as { provider?: unknown }).provider;
    } catch {
      return undefined;
    }
    if (typeof declared !== 'string' || !declared) return undefined;
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: {
        ownerId: true,
        model: true,
        provider: true,
        providerBuiltin: true,
        usesRuntimeDefaultModel: true,
        workspace: { select: { model: true, env: true } },
        assignedRunner: { select: { runtimeDefaultModels: true, modelCatalog: true } },
      },
    });
    if (!session) return undefined;
    const customRow = isBuiltinProvider(session.provider, session.providerBuiltin)
      ? null
      : await tx.modelProvider.findFirst({
          where: {
            slug: session.provider!,
            OR: [{ ownerId: null }, { ownerId: session.ownerId }],
          },
        });
    const exec = resolveProviderExec({
      declaredProvider: session.provider,
      declaredProviderBuiltin: session.providerBuiltin,
      customRow,
      sessionModel: session.model,
      usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
      runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
      workspaceModel: session.workspace?.model,
      modelCatalog: session.assignedRunner?.modelCatalog,
      workspaceEnv: session.workspace?.env as Record<string, string> | null,
    });
    // A built-in engine authenticates itself, so moving onto one injects nothing — but the
    // previous provider's variables must still go, which an empty map is how the runner is told.
    return exec.env ?? {};
  }

  /**
   * Register a tool-permission request from claude's --permission-prompt-tool (served
   * by the orbit MCP server) and surface it to the UI. Idempotent on toolUseId so a
   * retried call returns the same approval. The MCP tool then polls /approvals/:id.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/approvals')
  async createApproval(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: ApprovalCreateRequest,
  ): Promise<{ id: string; status: ApprovalStatus }> {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    // Stripped before the lookup, not only before the write, so a retry finds the row the first
    // call created: the idempotency key and the column it was stored in have to agree.
    const toolUseId = stripNul(dto.toolUseId);
    const existing = toolUseId
      ? await this.prisma.approval.findUnique({
          where: {
            sessionId_toolUseId: { sessionId, toolUseId },
          },
        })
      : null;
    // A call this workspace has permanently allowed is answered here instead of waking a human
    // to re-answer a settled question. Recorded as a decided approval with no decider, which is
    // what makes an automatic allow tellable from a human one afterwards.
    const autoAllowed = existing ? false : await this.standingGrantCovers(session, dto);
    // Which turn is asking. Derived here rather than sent by the runner: the MCP server knows only
    // its session, and the server already knows which turn it leased to that session — the runner
    // has been polling inside it since the dequeue. It is what makes an abandoned call provable
    // later (`sessions/abandoned-approvals.ts`), and null when there is no turn to name, which the
    // reaper reads as "unknown" and leaves alone.
    const openingTurn = existing
      ? null
      : await this.prisma.conversationTurn.findFirst({
          where: { sessionId, status: 'IN_FLIGHT' },
          orderBy: { seq: 'desc' },
          select: { id: true },
        });
    // The other reader a card can have, and the one the turn is NOT a proxy for: an ask made from a
    // runner-hosted job is consumed by that process, which outlives the turn — so the turn above is
    // recorded beside it and not instead of it. Sent by the asker because only the asker knows what
    // it is: the runner exports the job id to the job's own environment and the CLI hands it back,
    // and an in-turn MCP call has none (`sessions/abandoned-approvals.ts` reads it back against the
    // jobs the runner says are still up).
    const backgroundJobId = stripNul(dto.backgroundJobId ?? '').trim();
    const approval =
      existing ??
      (await this.prisma.approval.create({
        data: {
          sessionId,
          // Stripped for the same reason the event batch is (see strip-nul): a tool argument is
          // whatever the workspace typed into it, Postgres refuses U+0000 in text and jsonb with
          // 22P05, and the runner retries a 5xx forever. An approval that cannot be written is an
          // agent that waits for a card nobody can ever be shown.
          toolName: stripNul(dto.toolName),
          input: stripNul(dto.input ?? {}) as Prisma.InputJsonValue,
          toolUseId: toolUseId ?? null,
          turnId: openingTurn?.id ?? null,
          backgroundJobId: backgroundJobId === '' ? null : backgroundJobId,
          ...(autoAllowed
            ? { status: 'ALLOWED', decidedAt: new Date(), message: AUTO_ALLOWED_MESSAGE }
            : {}),
        },
      }));
    // An already-answered approval raises no card and buzzes no phone: not interrupting is the
    // entire point of having granted it.
    if (!existing && !autoAllowed) {
      this.realtime.publish(sessionId, {
        seq: 0,
        type: RunEventType.APPROVAL_REQUEST,
        payload: {
          id: approval.id,
          toolName: approval.toolName,
          input: approval.input,
          toolUseId: approval.toolUseId ?? undefined,
          // The reader that outlives the turn, to a client that has to answer "is this still a
          // question" itself: a card raised by a runner-hosted job is live while that process is
          // up, whatever the conversation is doing, and a client that reads only the turn would
          // take the card down the moment the turn ended (`WorkspaceView`'s local predicate).
          backgroundJobId: approval.backgroundJobId ?? undefined,
        },
        ts: new Date().toISOString(),
      });
      // Fire-and-forget: nudge the owner's iOS devices that a reply is needed. Not awaited so a
      // slow APNs round-trip can't delay the runner's approval-create response.
      void this.push.notifyApprovalRequest(sessionId, approval.toolName);
    }
    return { id: approval.id, status: approval.status as ApprovalStatus };
  }

  /**
   * Whether this session's workspace already permanently allows the call being asked about.
   *
   * The rules are the same rows claude receives as `--allowedTools`; this is how the runtimes
   * that take no allowlist get the same standing grants. Every uncertain case answers false and
   * the human is asked, exactly as before.
   */
  private async standingGrantCovers(
    session: { workspaceId: string | null; provider: string | null; providerBuiltin: boolean; ownerId: string },
    dto: ApprovalCreateRequest,
  ): Promise<boolean> {
    if (!session.workspaceId) return false;
    // A configured (BYOK) slug borrows a built-in runtime, and it is the runtime that will run
    // the command — so resolve it rather than judging the label the session was created with.
    let runtime = normalizeRuntimeProvider(session.provider, session.providerBuiltin);
    if (!isBuiltinProvider(session.provider, session.providerBuiltin)) {
      const customRow = await this.prisma.modelProvider.findFirst({
        where: { slug: session.provider!, OR: [{ ownerId: null }, { ownerId: session.ownerId }] },
        select: { runtime: true },
      });
      runtime = normalizeRuntimeProvider(customRow?.runtime, true);
    }
    if (!serverMatchedRuntime(runtime)) return false;
    const rules = await this.prisma.workspacePermissionRule.findMany({
      where: { workspaceId: session.workspaceId },
      select: { toolName: true, ruleContent: true },
    });
    return ruleCoversApproval(runtime, dto.toolName, dto.input, rules);
  }

  /** Long-poll one approval until a human decides (window elapsed undecided → PENDING). */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/approvals/:approvalId')
  async pollApproval(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('approvalId', PublicIdPipe) approvalId: string,
  ): Promise<ApprovalDecisionResponse> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const deadline = Date.now() + APPROVAL_LONG_POLL_MS;
    for (;;) {
      const a = await this.prisma.approval.findFirst({
        where: { id: approvalId, sessionId },
      });
      if (!a)
        return {
          id: approvalId,
          status: 'DENIED',
          behavior: 'deny',
          message: 'approval not found',
        };
      if (a.status !== 'PENDING') {
        return {
          id: a.id,
          status: a.status as ApprovalStatus,
          behavior: a.status === 'ALLOWED' ? 'allow' : 'deny',
          message: a.message ?? undefined,
          answers: (a.answers as QuestionAnswers | null) ?? undefined,
          ...normalizeStoredRememberRules(a.rememberRule),
        };
      }
      if (Date.now() >= deadline) return { id: a.id, status: 'PENDING' };
      await new Promise((r) => setTimeout(r, APPROVAL_POLL_INTERVAL_MS));
    }
  }

  /**
   * A runner-hosted background job asks to wake its session: it exited, or it wrote something new,
   * and it was started with bg_run's wakeOnExit / wakeOnOutput (runner-go background_job.go).
   *
   * The wake becomes a turn of the session through createTurn, so it is queued, claimed and delivered
   * the way any turn is — into the engine that is resident, or into one resumed for it, which is the
   * point: the engine that started the wait may have been recycled long before the wait ended. The
   * turn's content stays empty and the wake is kept beside it, written into what the runner is handed
   * at delivery (background-job-wake.ts), so none of it is recorded as the person's words.
   *
   * Wakes nobody has been handed yet are one turn: a wake arriving while one is queued files itself
   * onto it (MERGED). A session that has ended is neither woken nor revived (DROPPED), answered with a
   * 200 because there is nothing for the runner to try again.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/background-wake')
  @HttpCode(200)
  async backgroundWake(
    @CurrentRunner() runner: { id: string; ownerId: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: BackgroundWakeDto,
  ): Promise<BackgroundWakeReceipt> {
    await this.assertSessionOwnership(sessionId, runner.id);
    if (!this.sessions) throw new Error('background wakes are filed through SessionsService, which this controller was built without');
    const clientTurnId = `${BACKGROUND_WAKE_TURN_PREFIX}${dto.wakeId}`;
    let merged = false;
    try {
      const turn = await this.sessions.createTurn(
        runner.ownerId,
        sessionId,
        { clientTurnId, content: '', intent: 'NEXT_TURN' },
        {
          coalesce: async (tx, session) => {
            if (sessionHasEnded(session)) throw new SessionNotSendable('the session has ended');
            const queued = await undeliveredWakeTurn(tx, sessionId);
            merged = queued !== null;
            await fileBackgroundJobWake(tx, sessionId, queued?.clientTurnId ?? clientTurnId, dto);
            return queued;
          },
        },
      );
      return { outcome: merged ? 'MERGED' : 'ENQUEUED', turnId: turn.turnId };
    } catch (e) {
      // Ended (SessionNotSendable), or no longer there to wake (NotFoundException).
      if (e instanceof SessionNotSendable || e instanceof NotFoundException) return { outcome: 'DROPPED' };
      throw e;
    }
  }

  /**
   * The agent in this session asks to be woken later — or, with `stop`, no longer (runner-go
   * `schedule_wakeup`). Claude Code's own ScheduleWakeup keeps that timer inside the engine process,
   * which Orbit recycles and a runner restart kills; held here instead, the wakeup outlives both. When
   * it is due, the scheduled-wakeup worker files it onto the session's wake turn
   * (scheduled-wakeup.worker.ts), and no runner is involved until one claims that turn.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/scheduled-wakeup')
  @HttpCode(200)
  async scheduledWakeup(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: ScheduledWakeupDto,
  ): Promise<ScheduledWakeupReceipt> {
    await this.assertSessionOwnership(sessionId, runner.id);
    if (dto.stop === true) return cancelScheduledWakeup(this.prisma, sessionId);
    return withTransactionRetry(
      this.prisma,
      (tx) => scheduleWakeup(tx, sessionId, dto),
      loggedRetry(this.logger, 'runnerApi.scheduledWakeup'),
    );
  }

  /** A single interactive turn finished; retain or release its active-turn slot. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/turn-complete')
  @HttpCode(200)
  async turnComplete(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    // `turnId` is normalized but `leaseOwner` deliberately is not: the runner echoes back a
    // conversation-turn id the server handed it (a public id, and the only body field here that
    // addresses a row) alongside a lease token that is compared byte-for-byte and cast `::uuid`
    // in raw SQL. TurnCompleteRequest is an interface, so the global ValidationPipe never sees
    // this body — without the pipe the id reaches `where: { id: dto.turnId }` exactly as sent.
    @Body(PublicIdPipe.forFields('turnId')) body: TurnCompleteRequest,
  ) {
    // Stripped once, at the edge, rather than at each write: `result` alone reaches the session's
    // `error`, a turn's `deliveryFailureReason` and two different task comments below, and the
    // worktree snapshot reaches two rows more — a per-write strip is a list to keep in sync, which
    // is how the approval path came to be missed. Postgres stores no U+0000 and the runner retries
    // a 5xx without a ceiling; see strip-nul.
    const dto = stripNul(body);
    // The pipe decodes a turnId that is there and passes an absent one through. To Prisma
    // `where: { id: undefined }` is no condition at all, so the ACK below would answer every
    // unanswered turn of the session — queued messages and Watch wakes, none of them run. Refused
    // before the lock, so a completion that names no turn changes nothing.
    if (typeof dto?.turnId !== 'string' || dto.turnId.trim() === '') {
      throw new BadRequestException(
        'turnId is required: a turn completion must name the turn it completes',
      );
    }
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    const usage = dto.usage;
    // Go's legacy `omitempty` encoding can omit an empty changedFiles slice. A new runner's
    // baseSha still proves that it computed a worktree snapshot, so normalize that shape to the
    // empty snapshot instead of advancing the base while retaining the previous file list.
    const changedFilesSnapshot =
      dto.changedFiles ?? (dto.baseSha !== undefined ? [] : undefined);
    // Retried whole. Every decision — the duplicate-ack check, the park, the merge-state clear, the
    // billing accrual — is taken from the Session row read under its own lock inside the closure,
    // so a re-run cannot accrue against a turn the winner already closed. `dto` and its usage are
    // outside, so a retry books the same numbers and not a second set.
    const finalized = await withTransactionRetry(this.prisma, async (tx) => {
      // Serialize completion with createTurn's enqueue transition. Whichever locks the
      // Session first determines whether a follow-up is already queued; this prevents the
      // lost-wakeup state AWAITING_INPUT + PENDING conversation turn. The same lock also
      // fences every write below to the runner process that currently owns the Session.
      await this.lockSessionLeaseOwner(tx, sessionId, runner.id, leaseOwner);
      const current = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
          status: true,
          taskId: true,
          ownerId: true,
          creatorId: true,
          workspaceId: true,
          assignedRunnerId: true,
          inboxLeaseGeneration: true,
          coordinatorContextEpoch: true,
          coordinatorForProject: { select: { id: true } },
          mergeStatus: true,
          mergedSourceSha: true,
          // Armed by the event batch that carried this turn's error (the runner flushes events
          // before it reports the turn), so by now it answers "is this failure one the server
          // intends to undo by itself" — which is what keeps the STATUS published below from
          // announcing a settlement that hasn't happened.
          retryAt: true,
          // How much of that budget is spent, for the one failure class whose wait is decided
          // here rather than by a reply's text — see `retryArmAt` below.
          retryAttempts: true,
        },
      });
      // Read the row being completed before changing it. A reserved shell turn is the one path
      // below that may write its Task, so it pre-locks project → task now — before the
      // conversation-turn ACK — and later applies the derived outcome only if that ACK wins.
      const completedTurn = await tx.conversationTurn.findFirst({
        where: { id: dto.turnId, sessionId },
        select: {
          id: true,
          kind: true,
          clientTurnId: true,
          content: true,
          sendIntent: true,
          targetTurnId: true,
          leaseGeneration: true,
          coordinatorContextKey: true,
        },
      });
      // A dequeue only proposes that context was delivered. The successful top-level turn is its
      // acknowledgement. Recompute from current state under the Session lock: a late completion
      // from an old process, a pre-compaction turn, a re-bound project or an older instruction
      // body cannot acknowledge the context needed now.
      const expectedCoordinatorContextKey =
        current.coordinatorForProject && current.inboxLeaseGeneration
          ? buildCoordinatorDeliveryContextKey(
              current.coordinatorForProject.id,
              current.inboxLeaseGeneration,
              current.coordinatorContextEpoch,
            )
          : null;
      const acknowledgedCoordinatorContextKey =
        dto.status === RunStatus.SUCCEEDED
        && completedTurn?.kind === 'message'
        && completedTurn.leaseGeneration === current.inboxLeaseGeneration
        && completedTurn.coordinatorContextKey != null
        && completedTurn.coordinatorContextKey === expectedCoordinatorContextKey
          ? completedTurn.coordinatorContextKey
          : null;
      const queuedAcceptanceExpectedExitCode =
        taskAcceptanceExpectedExitCode(completedTurn?.clientTurnId);
      const taskAcceptanceTurn =
        completedTurn?.kind === 'shell'
        && queuedAcceptanceExpectedExitCode != null;
      let lockedAcceptanceTask: {
        id: string;
        ownerId: string;
        title: string;
        status: TaskStatus;
        projectId: string | null;
        acceptanceCriteria: string | null;
        acceptanceCommand: string | null;
        acceptanceExpectedExitCode: number | null;
        completionCriterion: TaskCompletionCriterionValue;
        completionPolicy: string;
        verifiesTaskId: string | null;
      } | null = null;
      let acceptanceTaskAwaitingResult = false;
      if (taskAcceptanceTurn && current.taskId) {
        // The first read only tells us which rank-40 project row to take. If the task moves while
        // we wait, the locked re-read below disagrees and this attempt stays unsettled for L2;
        // taking the new project after the task would invert the canonical order.
        const taskProject = await tx.task.findUnique({
          where: { id: current.taskId },
          select: { projectId: true },
        });
        if (taskProject?.projectId) {
          await tx.$queryRaw`
            SELECT "id" FROM "project"
            WHERE "id" = ${taskProject.projectId}::uuid
            FOR NO KEY UPDATE`;
        }
        const rows = await tx.$queryRaw<Array<{
          id: string;
          ownerId: string;
          title: string;
          status: TaskStatus;
          projectId: string | null;
          acceptanceCriteria: string | null;
          acceptanceCommand: string | null;
          acceptanceExpectedExitCode: number | null;
          completionCriterion: TaskCompletionCriterionValue;
          completionPolicy: string;
          verifiesTaskId: string | null;
        }>>`
          SELECT "id", "owner_id" AS "ownerId", "title", "status",
                 "project_id" AS "projectId",
                 "acceptance_criteria" AS "acceptanceCriteria",
                 "acceptance_command" AS "acceptanceCommand",
                 "acceptance_expected_exit_code" AS "acceptanceExpectedExitCode",
                 "completion_criterion"::text AS "completionCriterion",
                 "completion_policy"::text AS "completionPolicy",
                 "verifies_task_id" AS "verifiesTaskId"
          FROM "task"
          WHERE "id" = ${current.taskId}::uuid
          FOR UPDATE`;
        acceptanceTaskAwaitingResult = rows[0] != null
          && awaitsExecutableAcceptance(rows[0].status);
        if (rows[0] && rows[0].ownerId !== current.ownerId) {
          throw new ConflictException('acceptance task and session belong to different tenants');
        }
        if (rows[0]?.projectId === (taskProject?.projectId ?? null)) {
          lockedAcceptanceTask = rows[0] ?? null;
        }
      }
      // A steer settles only itself. It joined a turn that is still running — the `result`
      // that ends that turn belongs to the message it was folded into, and the slot, the
      // billing and the session's status all belong there too. So this acks the steer's own
      // row and stops: no numTurns, no parking, no terminal transition, and in particular no
      // FAILED session when a steer merely failed to reach the engine (the runner reports
      // that as a user_delivery event, which is where a person can act on it).
      // Keep the explicit kind-qualified read: besides making the steer boundary self-contained,
      // it preserves the narrow query shape every caller and regression fixture has always relied
      // on. The completed-turn read above serves the L0 shell path; neither query mutates the row.
      const steering = await tx.conversationTurn.findFirst({
        where: { id: dto.turnId, sessionId, kind: 'steer' },
        select: { id: true, sendIntent: true, targetTurnId: true, deliveryStatus: true },
      });
      // `turnComplete` is retried when the response is lost. After the first successful
      // steer_requeue the SAME row is already a `message` (and may even have been leased for its
      // real execution) by the time that retry arrives, so looking only at its current kind and
      // falling through to the ordinary-turn path would ACK the requeued message without running
      // it. The subtype is a completion *operation*, not a claim that a non-steer row completed:
      // once there is no steer left to requeue, the only idempotent answer is a no-op.
      if (!steering && dto.subtype === TURN_COMPLETE_STEER_REQUEUE) {
        return {
          applied: false,
          steer: true,
          requeued: false,
          status: current.status,
          failSession: false,
          retryAt: current.retryAt,
        };
      }
      // A steer the engine PROVABLY never read is un-filed rather than acked: it becomes the
      // ordinary message it would have been had it arrived a moment later, on the same row,
      // with the same seq and the same clientTurnId — the kind was the only thing about it that
      // was ever a matter of timing. This is the same transition turn-complete already applies
      // to a steer still PENDING when its turn ends, reached from the other direction: there,
      // because there is no longer a turn to join; here, because the runner came back and said
      // it could not join the one there was.
      //
      // Only for provable non-delivery, which is the runner's judgement to make (see
      // TURN_COMPLETE_STEER_REQUEUE): re-filing a message Codex may already have taken is how
      // one prompt gets run twice, and Codex does not de-duplicate. The runner withholds the
      // subtype for anything less certain — an abandoned lease is reported undelivered, never
      // re-filed — which is what makes this safe for an explicit CURRENT_WORK row too.
      if (steering && dto.subtype === TURN_COMPLETE_STEER_REQUEUE) {
        // Idempotent by the kind itself: the update changes one leased steer at most once. The
        // guard above is the other half of that invariant — a retry which now observes the row as
        // a message must stop here rather than settling that message as an ordinary completed turn.
        // This is also safe against the turn ending underneath it: that path only touches steers
        // that are still PENDING, and this one only a leased one.
        const requeued = await tx.conversationTurn.updateMany({
          where: { id: dto.turnId, sessionId, kind: 'steer', status: 'IN_FLIGHT' },
          data: {
            kind: 'message',
            status: 'PENDING',
            deliveredAt: null,
            leaseDeadlineAt: null,
            leaseGeneration: null,
            // The two columns only a steer may carry. A legacy row has neither and is left
            // exactly as it always was; an explicit one has to shed both, or the row shape
            // constraints reject the message it is becoming.
            ...(steering.sendIntent === 'CURRENT_WORK'
              ? { sendIntent: 'NEXT_TURN', targetTurnId: null }
              : {}),
          },
        });
        if (requeued.count > 0) {
          // The turn this message was aimed at may already have completed — the two race by
          // construction, since "there was no turn to steer" is the commonest reason to get
          // here. That completion counted the executable turns before this row became one, so
          // it may have parked the session with a message now queued behind nothing. Waking it
          // is the same transition an ordinary send makes.
          await tx.session.updateMany({
            where: { id: sessionId, status: RunStatus.AWAITING_INPUT, cancelRequestedAt: null },
            data: { status: RunStatus.PENDING, lastTurnAt: new Date() },
          });
        }
        return {
          applied: requeued.count > 0,
          steer: true,
          requeued: requeued.count > 0,
          status: current.status,
          failSession: false,
          retryAt: current.retryAt,
        };
      }
      if (steering) {
        const failedCurrentWork =
          steering.sendIntent === 'CURRENT_WORK'
          && steering.deliveryStatus !== 'ACKNOWLEDGED'
          && dto.status === RunStatus.FAILED;
        const now = new Date();
        const acked = await tx.conversationTurn.updateMany({
          where: { id: dto.turnId, sessionId, status: { not: 'ANSWERED' } },
          data: {
            status: 'ANSWERED',
            answeredAt: now,
            ...(failedCurrentWork
              ? {
                  deliveryStatus: 'FAILED',
                  deliveryFailureCode: CURRENT_WORK_RUNTIME_REJECTED,
                  deliveryFailureReason:
                    dto.result || 'The runtime rejected CURRENT_WORK before acknowledging it.',
                  deliveryTerminalAt: now,
                }
              : {}),
          },
        });
        return {
          applied: acked.count > 0,
          steer: true,
          requeued: false,
          status: current.status,
          failSession: false,
          retryAt: current.retryAt,
        };
      }
      // A turn that failed mid-run (e.g. an API/content-filter error the workspace couldn't
      // recover from — the runner reports such turns as FAILED) would otherwise park at
      // AWAITING_INPUT, which is indistinguishable from an ordinary idle session: the list
      // says "Waiting for your reply" and the failure is invisible until you open the
      // session. So the run outcome settles FAILED — that IS what happened to the run, and
      // it's what the list must show. The session stays resumable, so retrying is still one
      // message away. A task-bound session additionally reclaims its task as FAILED (it
      // would otherwise sit IN_PROGRESS with nothing watching).
      let failSession = dto.status === RunStatus.FAILED;
      // A reserved L0 turn that cannot produce a comparison is unsettled, not a guessed task
      // failure. An ordinary failed model/shell turn retains the existing FAILED behaviour.
      const failTask = failSession && !!current.taskId && !taskAcceptanceTurn;
      // Keep this formerly post-transaction cleanup behind the same process fence. It is
      // valid for duplicate completions too, so apply it before the idempotent ack check.
      let branchMerged = dto.branchMerged;
      let clearsMergedState = false;
      if (dto.branchMerged === false && current.mergeStatus === 'merged') {
        if (current.mergedSourceSha && (!dto.branchSha || current.mergedSourceSha === dto.branchSha)) {
          // A rebase merge can produce a different patch-id from its source commit when it
          // adapts overlapping target changes. The exact source tip proves this is still the
          // branch snapshot that was merged, so keep the successful state authoritative. A
          // missing report SHA is inconclusive (legacy runner or transient ref lookup failure),
          // so it must not erase an exact marker captured by the successful merge.
          branchMerged = true;
        } else {
          // Recorded, not written yet. This transaction gets one write of the Session row
          // (common/lock-order.ts, I3): a second one re-runs every Session foreign key and takes
          // FOR KEY SHARE on `user`, `workspace`, `runner` and `task` while holding the Session
          // FOR UPDATE — the reverse of the order a Task write takes them in. The CAS this used
          // to carry (`mergeStatus = 'merged'` at this exact `mergedSourceSha`, for this runner)
          // is the state just read under that lock and cannot move underneath it, so evaluating
          // it here is the same test.
          clearsMergedState = true;
        }
      }
      const CLEARED_MERGE_STATE = {
        mergeStatus: null,
        mergeOperationId: null,
        mergeOperationOwner: null,
        mergeError: null,
        mergedSourceSha: null,
      } as const;
      // A turn is ANSWERED because something answered it — not because the engine stopped. The
      // workspace's own reply is the only thing that can (ANSWERS_USER_TURN, the same set the
      // preview line reads), so a message turn with none of those events under it produced no
      // answer at all, whatever ended it: an engine that never came up, a `--resume` on a
      // conversation that was never opened, or the next failure nobody has enumerated yet.
      // ANSWERED consumes the person's message for good — with the attachments hanging off the
      // row — so an unanswered one goes back to PENDING and is delivered again instead.
      //
      // An interrupt is the other way a question stops being owed: somebody asked this turn to
      // stop, and re-running what they stopped is the one thing a requeue must never do. It ends
      // a turn WITHOUT answering it (which is why it is not in the set above), so it is named
      // here rather than added there. Only `message` turns are asked for a reply at all: a shell
      // turn is answered by its exit code, and a control turn is acked on delivery.
      const unanswered =
        completedTurn?.kind === 'message'
        && (await tx.runEvent.findFirst({
          where: {
            sessionId,
            turnId: dto.turnId,
            type: { in: [...ANSWERS_USER_TURN, RunEventType.INTERRUPT] },
          },
          select: { id: true },
        })) == null;
      // ...and of those, the one the server can undo BY ITSELF is the turn that produced nothing
      // at all: no engine turn ran and nothing was billed for one, which is an engine that never
      // came up (`--resume` on a conversation that was never opened, a runtime refusing its own
      // flags). The person neither got an answer nor paid for one, so this is not an error to act
      // on but a pause: the same message succeeds as soon as a runtime starts, and the wait is
      // armed on the sweeper's own ladder (auto-retry.service), which is what turns it into a
      // countdown rather than a hot loop of re-spawns.
      //
      // Said as the two counters the report carries, and not as a failure subtype: a user
      // interrupt is the other way a turn ends with nothing said, and it is excluded above where
      // the requeue decision is. `numTurns` is compared against 0 exactly and never `?? 0` — a
      // runner too old to report it omits the field, and reading that omission as "produced
      // nothing" would arm a retry on every failure of every older runner.
      //
      // Never over an arm already standing: one is set by the failure this turn is repeating, it
      // is closer to firing than anything computed now, and re-deciding it here would restart the
      // countdown on every attempt — the one shape that makes a bounded ladder unbounded.
      const retryArmAt =
        unanswered && dto.numTurns === 0 && (dto.costUsd ?? 0) === 0 && current.retryAt == null
          ? nextAutoRetryAt(current.retryAttempts, new Date())
          : null;
      // Idempotent ack: only the first turn-complete for this turn applies. `deliveredAt` is the
      // other half of that compare-and-set now that a completion can leave the row un-ANSWERED: a
      // turn put back in the queue is no longer out on a delivery, so a retried completion for it
      // matches nothing and cannot book a second set of numbers. A duplicate completion still
      // clears the stale merge state — that was true before this was folded into one write, and
      // it is the reason the clear cannot simply ride along with the park below. Nothing has
      // written the Session row on this path, so this IS the one write.
      const ack = await tx.conversationTurn.updateMany({
        where: {
          id: dto.turnId,
          sessionId,
          status: { not: 'ANSWERED' },
          deliveredAt: { not: null },
        },
        data: unanswered
          ? { status: 'PENDING', deliveredAt: null, leaseDeadlineAt: null, leaseGeneration: null }
          : { status: 'ANSWERED', answeredAt: new Date() },
      });
      if (ack.count === 0) {
        if (clearsMergedState) {
          await tx.session.update({ where: { id: sessionId }, data: { ...CLEARED_MERGE_STATE } });
        }
        return { applied: false, steer: false, requeued: false, status: current.status, failSession, retryAt: current.retryAt };
      }
      let acceptanceTaskChanged = false;
      let acceptanceTaskCompleted = false;
      let acceptanceFailureReason: string | null = null;
      let acceptanceFailure: TaskFailure | null = null;
      // The whole EXECUTABLE decision, restored on 2026-09-03 at the account owner's direction:
      // one comparison between the code this callback reports and the code the declaration asks
      // for. Every input is already in hand under the rank-50 task lock taken above, so this
      // reads nothing further and writes nothing but `task.status` — no attempt row, no result
      // ledger, no evidence. The exit code exists for the length of this block.
      //
      // The guards around it are the identity checks, not evidence: the turn must be the reserved
      // shell turn this session queued, the declaration must not have been edited since it was
      // queued (the expectation is part of the turn's client id), and the command must still be
      // the one that ran. A declaration that moved falls through to the unavailable signal, which
      // is the honest answer — that result is about a question nobody is asking any more.
      if (
        taskAcceptanceTurn
        && lockedAcceptanceTask != null
        && awaitsExecutableAcceptance(lockedAcceptanceTask.status)
        && lockedAcceptanceTask.completionCriterion === 'EXECUTABLE'
        && lockedAcceptanceTask.acceptanceCommand != null
        && lockedAcceptanceTask.acceptanceExpectedExitCode != null
        && lockedAcceptanceTask.acceptanceExpectedExitCode === queuedAcceptanceExpectedExitCode
        && completedTurn?.content === lockedAcceptanceTask.acceptanceCommand
        && dto.status === RunStatus.SUCCEEDED
        // -1 is what the runner reports for a start failure, a timeout kill or a signal. It is
        // compared like any other code, because since 0227 removed the typed termination nothing
        // can tell those apart from a command that ran and disagreed — the owner accepted that,
        // so they all become FAILED rather than a second, quieter "unavailable" class.
        && Number.isInteger(dto.shellExitCode)
      ) {
        const actualExitCode = dto.shellExitCode!;
        const expectedExitCode = lockedAcceptanceTask.acceptanceExpectedExitCode;
        const completed = deriveTaskCompletionStatus({
          completionCriterion: lockedAcceptanceTask.completionCriterion,
          acceptanceExpectedExitCode: expectedExitCode,
          executableExitCode: actualExitCode,
        });
        // FAILED remains the conservative L0 outcome when the declared command returns a
        // comparable non-matching exit code. Only the optimistic branch is criterion-derived.
        const derivedStatus = completed ?? TaskStatus.FAILED;
        // The command, expectation and pending state are repeated in the write even though their
        // row is locked: they make the compare-and-set visible in SQL and fail closed if this code
        // is ever moved away from the lock without its guard.
        const changed = await tx.task.updateMany({
          where: {
            id: lockedAcceptanceTask.id,
            status: { in: [...EXECUTABLE_ACCEPTANCE_PENDING_STATUSES] },
            acceptanceCommand: lockedAcceptanceTask.acceptanceCommand,
            acceptanceExpectedExitCode: expectedExitCode,
            completionCriterion: 'EXECUTABLE',
          },
          data: { status: derivedStatus },
        });
        if (changed.count > 0) {
          acceptanceTaskChanged = true;
          acceptanceTaskCompleted = derivedStatus === TaskStatus.DONE;
          if (derivedStatus === TaskStatus.FAILED) {
            failSession = true;
            // The one place the two numbers are written down, and it is the session's own run
            // outcome rather than a record about the task. Diagnosis is reading the session.
            acceptanceFailureReason =
              executableAcceptanceFailureReason(actualExitCode, expectedExitCode);
            // And the project's own record of it: an exception with an assignee. Captured here but
            // opened below, past the end of this block: the comparison stays one status write and
            // no other database touch (executable-exit-code-judgment.spec.ts holds it to that, at
            // the account owner's direction), while the item is still opened in the transaction
            // that wrote the FAILED (contract §4.3 A).
            acceptanceFailure = {
              taskId: lockedAcceptanceTask.id,
              sessionId,
              how: 'ACCEPTANCE_EXIT_MISMATCH',
              exitCode: actualExitCode,
              expectedExitCode,
            };
          }
        }
      }
      // A reserved turn whose result cannot be compared is a transport failure, not a criterion
      // input. End the Session, but leave the Task in its existing pending state: nothing was
      // compared, so nothing may be concluded. This is an older runner omitting the field, a turn
      // that never produced one, or a declaration edited while its old command was still running.
      // Persist the human-facing signal in this same first-ACK transaction so the failure can
      // never become a silent OPEN task.
      if (taskAcceptanceTurn && acceptanceTaskAwaitingResult && !acceptanceTaskChanged) {
        failSession = true;
        acceptanceFailureReason = dto.status === RunStatus.FAILED
          ? (dto.result || 'acceptance command did not return a comparable result')
          : 'acceptance command result no longer matches the current declaration';
        await postExecutableAcceptanceUnavailableComment(
          tx,
          current.taskId!,
          completedTurn?.content ?? lockedAcceptanceTask?.acceptanceCommand ?? '(unknown command)',
          lockedAcceptanceTask?.acceptanceExpectedExitCode
            ?? queuedAcceptanceExpectedExitCode
            ?? 0,
          acceptanceFailureReason,
        );
      }
      // The exception the comparison above decided on, opened here so that block reaches the
      // database exactly once. Still this transaction, so the FAILED and the project's record of
      // it commit together or not at all (contract §4.3 A).
      if (acceptanceFailure) await recordTaskFailure(tx, acceptanceFailure);
      // And the mirror of it, for the comparison that PASSED: a code task whose acceptance held on
      // the merged tree is what the platform integrates, and the queueing happens in the same
      // transaction as the DONE so the two commit together (contract §2.3 J-T1a). Outside the
      // comparison block for the same reason `recordTaskFailure` is.
      if (acceptanceTaskCompleted && current.taskId) {
        await enqueueForDoneTask(tx, current.ownerId, current.taskId);
      }
      // A successful model turn on a task with L0 acceptance queues exactly one existing shell
      // turn in this same transaction. The message ACK and unique clientTurnId are the idempotency
      // boundary: either both commit or neither does, so retrying /turn-complete cannot run the
      // command twice. Tasks without the pair do not enter this branch.
      if (
        completedTurn?.kind === 'message'
        && dto.status === RunStatus.SUCCEEDED
        && current.taskId
      ) {
        const executable = await tx.task.findUnique({
          where: { id: current.taskId },
          select: {
            status: true,
            acceptanceCommand: true,
            acceptanceExpectedExitCode: true,
            completionCriterion: true,
          },
        });
        if (
          executable != null
          && awaitsExecutableAcceptance(executable.status)
          && executable.completionCriterion === 'EXECUTABLE'
          && executable.acceptanceCommand != null
          && executable.acceptanceExpectedExitCode != null
        ) {
          const last = await tx.conversationTurn.aggregate({
            where: { sessionId },
            _max: { seq: true },
          });
          await tx.conversationTurn.create({
            data: {
              sessionId,
              seq: (last._max.seq ?? 0) + 1,
              clientTurnId: taskAcceptanceClientTurnId(
                completedTurn.id,
                executable.acceptanceExpectedExitCode,
              ),
              kind: 'shell',
              content: executable.acceptanceCommand,
              status: 'PENDING',
            },
          });
        }
        // OWNER_CONFIRMED: a run of the task ended a turn successfully, so its owner is asked. This
        // is the only place that knows the turn succeeded — the runner's turn_end event carries no
        // outcome — so the question is recorded here, in the same transaction as the acknowledgement
        // that makes it happen once. Nothing is concluded: the owner's own decision is.
        if (
          executable != null
          && executable.completionCriterion === 'OWNER_CONFIRMED'
          && (OWNER_CONFIRMATION_UNSETTLED_STATUSES as readonly string[]).includes(executable.status)
        ) {
          await recordOwnerConfirmationRequest(tx, {
            taskId: current.taskId,
            ownerId: current.ownerId,
            sessionId,
            turnId: completedTurn.id,
          });
        }
      }
      // A `!`-shell turn runs on the runner, not in claude, so it must NOT advance numTurns:
      // that counter gates --resume on respawn (queue.buildSession). Counting a shell turn
      // would make a shell-first session (claude never received a message) try to --resume a
      // conversation that was never established, failing with "No conversation found".
      const turnInc = completedTurn?.kind === 'shell' ? 0 : (dto.numTurns ?? 1);
      // Explicit CURRENT_WORK whose exact target won the completion boundary before the engine
      // read it goes back in the queue as an ordinary next turn, exactly like the legacy sweep
      // below does for the no-intent rows it replaced. Nothing read the message, so nothing about
      // it needs preserving — and the alternative, a durable "not delivered" the sender can only
      // answer by retyping, is a worse account of what happened than simply saying it late.
      //
      // Dequeue commit is not a runtime ACK either: if its HTTP response was lost, the row is
      // IN_FLIGHT and would stay that way forever, so this boundary settles those too.
      let currentWorkTerminalized = 0;
      let currentWorkRequeued = 0;
      if (completedTurn && !failSession) {
        currentWorkRequeued = (
          await requeueUnreadCurrentWorkSteers(tx, sessionId, [completedTurn.id])
        ).length;
      } else if (completedTurn) {
        // A failing turn takes the session with it, and the drain below answers every queued row.
        // Requeueing into a queue about to be emptied would lose the message with nothing said;
        // the undelivered receipt is what survives that teardown.
        const terminalized = await terminalizePendingCurrentWorkSteers(tx, sessionId, {
          targetTurnIds: [completedTurn.id],
          includeInFlight: true,
          code: CURRENT_WORK_TARGET_COMPLETED,
          reason: 'The target turn completed before CURRENT_WORK could be delivered.',
        });
        currentWorkTerminalized = terminalized.terminalizedTurnIds.length;
      }
      // Rolling legacy steers keep their historical recovery: rows with no explicit intent become
      // an ordinary message. New clients never create this shape, and NEXT_TURN is born a message.
      await tx.conversationTurn.updateMany({
        where: { sessionId, kind: 'steer', status: 'PENDING', sendIntent: null },
        data: { kind: 'message' },
      });
      // If a follow-up arrived before this completion acquired the Session lock, the
      // current active slot passes directly to it and the inbox may deliver it next. With
      // no executable follow-up, release the slot while the runtime remains warm.
      const pendingExecutable = failSession
        ? 0
        : await tx.conversationTurn.count({
            where: {
              sessionId,
              kind: { in: ['message', 'shell'] },
              status: 'PENDING',
            },
          });
      const nextStatus = failSession
        ? RunStatus.FAILED
        : statusAfterTurnCompleted(pendingExecutable > 0);
      // Settle + bill only if this is still the active turn and is not being torn down,
      // so a late/retried completion cannot resurrect a finalized session or double-bill.
      const parked = await tx.session.updateMany({
        where: {
          id: sessionId,
          cancelRequestedAt: null,
          status: RunStatus.RUNNING,
        },
        data: {
          status: nextStatus,
          engineTurnActive: false,
          // On a failed turn claude is still alive (the turn errored, the process didn't
          // exit), so finalizing FAILED here would leak its runner concurrency slot — the
          // process lingers, holding a slot, until the runner restarts. Set
          // cancelRequestedAt so the next heartbeat's cancel-drain tells the runner to
          // tear that process down and reclaim the slot (mirrors reaper forceFinalize).
          ...(failSession
            ? {
                error: (acceptanceFailureReason ?? dto.result) || 'run failed',
                finishedAt: new Date(),
                cancelRequestedAt: new Date(),
              }
            : {}),
          // Live worktree state for the composer's status bar, refreshed each turn (the
          // runner reports the worktree's uncommitted diff and the exact healed base used to
          // compute it on every turn-complete). Keep both in this one write so a rebase cannot
          // leave the stored file list and its merge anchor describing different snapshots.
          isolationStatus: dto.isolationStatus ?? undefined,
          ...(changedFilesSnapshot !== undefined
            ? {
                ...(dto.baseSha !== undefined ? { baseSha: dto.baseSha } : {}),
                changedFiles: changedFilesSnapshot as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(dto.worktreeDirty !== undefined ? { worktreeDirty: dto.worktreeDirty } : {}),
          // Whether the branch already landed in main — the turn-end snapshot an idle session
          // shows, so the bar offers "✓ In main" not a redundant Merge (older runners omit it).
          ...(branchMerged !== undefined ? { branchMerged } : {}),
          // The worktree's actual HEAD branch → flags divergence / offers Adopt (older runners omit).
          ...(dto.worktreeBranch !== undefined ? { worktreeBranch: dto.worktreeBranch } : {}),
          runtimeSessionId: dto.runtimeSessionId ?? undefined,
          lastTurnAt: new Date(),
          numTurns: { increment: turnInc },
          costUsd: { increment: dto.costUsd ?? 0 },
          sumInputTokens: { increment: usage?.input_tokens ?? 0 },
          sumOutputTokens: { increment: usage?.output_tokens ?? 0 },
          sumCacheRead: { increment: usage?.cache_read_input_tokens ?? 0 },
          sumCacheWrite: { increment: usage?.cache_creation_input_tokens ?? 0 },
          // Folded into the park for the same reason the merge-state clear is: one write, and
          // conditional on the row still being the one this turn ran on. A turn put back in the
          // queue with no arm behind it is what the "engine never came up" case used to look
          // like — the message owed an answer, sitting where nothing would deliver it.
          ...(retryArmAt ? { retryAt: retryArmAt } : {}),
          ...(acknowledgedCoordinatorContextKey
            ? { coordinatorContextAckKey: acknowledgedCoordinatorContextKey }
            : {}),
          // Folded into the park so the row is written once (I3). The park is conditional, so
          // the branch below covers the case where it matched nothing.
          ...(clearsMergedState ? CLEARED_MERGE_STATE : {}),
        },
      });
      if (parked.count === 0) {
        // Nothing was written above — an UPDATE that matches no row leaves the tuple, and its
        // xmin, exactly as it was — so this is still this transaction's first Session write.
        if (clearsMergedState || acknowledgedCoordinatorContextKey) {
          await tx.session.update({
            where: { id: sessionId },
            data: {
              ...(clearsMergedState ? CLEARED_MERGE_STATE : {}),
              ...(acknowledgedCoordinatorContextKey
                ? { coordinatorContextAckKey: acknowledgedCoordinatorContextKey }
                : {}),
            },
          });
        }
        const latest = await tx.session.findUnique({
          where: { id: sessionId },
          select: { status: true },
        });
        return {
          applied: false,
          steer: false,
          currentWorkTerminalized,
          currentWorkRequeued,
          status: latest?.status ?? current.status,
          failSession,
          retryAt: current.retryAt,
        };
      }
      if (failSession) {
        await retireSessionInboxGeneration(tx, sessionId);
      }
      // Per-file unified diffs to the side table (never on the session row, so the detail/
      // list payload stays small) — fetched on demand when the user opens a file's diff.
      if (dto.changedDiff !== undefined) {
        await tx.sessionDiff.upsert({
          where: { sessionId },
          create: {
            sessionId,
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
          update: {
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
        });
      }
      if (dto.modelUsage) {
        const rows = Object.entries(dto.modelUsage).map(([model, mu]) => ({
          sessionId,
          model,
          inputTokens: mu.inputTokens ?? 0,
          outputTokens: mu.outputTokens ?? 0,
          cacheCreationInputTokens: mu.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: mu.cacheReadInputTokens ?? 0,
          costUsd: mu.costUSD ?? 0,
        }));
        if (rows.length > 0) await tx.llmUsage.createMany({ data: rows });
      }
      if (failSession) {
        const terminalized = await terminalizePendingCurrentWorkSteers(tx, sessionId, {
          includeInFlight: true,
          code: CURRENT_WORK_SESSION_FINALIZED,
          reason: 'CURRENT_WORK was not delivered before its session turn failed.',
        });
        currentWorkTerminalized += terminalized.terminalizedTurnIds.length;
        // A Watch wake queued behind the failed turn goes with the drain below, unrun: its delivery
        // stops reading DELIVERED first (watches/watch-wake-drain.ts).
        await deadLetterQueuedWatchWakes(tx, sessionId, {
          code: 'OBSERVER_SESSION_ENDED',
          ending: 'its running turn failed',
        });
        // An exception item queued for this conversation goes the same way: taken back unrun, and —
        // because this run is over — to the account owner (projects/project-open-item.ts).
        await returnQueuedTurns(tx, sessionId, { code: 'SESSION_ENDED', ending: true });
        // Drain queued turns so nothing can be leased after the session ends.
        await tx.conversationTurn.updateMany({
          where: { sessionId, status: { not: 'ANSWERED' } },
          data: { status: 'ANSWERED', answeredAt: new Date() },
        });
      }
      let taskReclaimed = false;
      if (failTask) {
        // Surface the abandoned task for a human, and open its project's exception item in this same
        // transaction (contract §4.3 B).
        taskReclaimed = await reclaimStalledTask(tx, current.taskId!, TaskStatus.FAILED, {
          sessionId,
          how: 'RUN_FAILED',
          error: dto.result || 'run failed',
        });
        await postRunFailureComment(tx, current.taskId!, dto.result || 'run failed');
      }
      taskReclaimed = taskReclaimed || acceptanceTaskChanged;
      // Last, because it reads which turns are still live and everything above is what settled
      // them. A tool call whose turn just ended can never be answered — the poll loop that would
      // have consumed the answer ran inside it — so the approval stops being a question here, on
      // that fact, rather than on how long it has been waiting.
      await reapApprovalsOfEndedTurns(tx, sessionId);
      return {
        applied: true,
        steer: false,
        requeued: false,
        currentWorkTerminalized,
        currentWorkRequeued,
        status: nextStatus,
        failSession,
        retryAt: current.retryAt,
        taskReclaimed,
        taskId: current.taskId,
        taskOwnerId: current.ownerId,
        taskCompleted: acceptanceTaskCompleted,
      };
    }, loggedRetry(this.logger, 'runnerApi.turnComplete'));
    // The immediate completion edge for a task the comparison above just settled DONE. The ACK
    // transaction is authoritative and idempotent: only its first compare-and-set reports
    // taskCompleted. A process crash here loses latency, not work, because the periodic READY
    // sweep observes the same dependency watermark.
    if (
      'taskCompleted' in finalized
      && finalized.taskCompleted
      && finalized.taskOwnerId
      && finalized.taskId
    ) {
      await this.tasks?.dispatchDependentsAfterCompletion(
        finalized.taskOwnerId,
        finalized.taskId,
      ).catch((error) => this.logger.warn(
        `successor dispatch after executable completion ${finalized.taskId} failed: `
        + `${error instanceof Error ? error.message : error}`,
      ));
      // A task that is done answers whatever exception was open about it (contract §4.2).
      await this.openItems?.resolveByFact([finalized.taskId]);
    }
    // The exception half of that same edge. `taskCompleted` is true only for a DERIVED DONE, so
    // three real endings reach nothing above: an acceptance code that disagreed and derived FAILED,
    // a reserved acceptance turn whose result could not be compared at all (the task stays open and
    // the session does not), and an ordinary task turn that failed and reclaimed its task. All
    // three are this transaction ENDING the session, which is exactly what `failSession` says, and
    // what an attempt ending with its task unsettled means. Nothing is decided here: the producer
    // behind this door re-reads what committed and owes the coordinator nothing for a task that
    // settled after all.
    if (
      finalized.applied
      && !finalized.steer
      && finalized.failSession
      && 'taskId' in finalized
      && finalized.taskId
    ) {
      await this.tasks?.deliverTaskExceptionsAfterCommit(finalized.taskId)
        .catch((error) => this.logger.warn(
          `task exception delivery after turn completion ${finalized.taskId} failed: `
          + `${error instanceof Error ? error.message : error}`,
        ));
      // The exception item that same transaction opened, handed to whoever is responsible for it
      // (contract §4.4 X-D4 1).
      await this.openItems?.deliverForTasks([finalized.taskId]);
    }
    // TURN_END events are flushed before /turn-complete, so their control summary can still see
    // RUNNING. Publish the committed row for every applied non-steer completion; task-bound
    // summaries carry taskId and clear the running overlay without waiting for reconciliation.
    if (finalized.applied && !finalized.steer) {
      // A turn of this conversation has ended, which is where anything a project still owes it is
      // handed over — including what was recorded while it was busy, and what the door that recorded
      // it never got to deliver (contract §4.4 X-D4 3).
      await this.openItems?.deliverOwedTo(sessionId);
      this.realtime.publishSessionUpdated(sessionId);
      // T5: this turn's numbers, events and tool calls are committed now, so its spend is a fact.
      // A steer settles only its own row and books no turn, cost or tool call.
      await this.attemptBudgets?.meterQuietly(sessionId, new Date());
    }
    if (
      'taskReclaimed' in finalized
      && finalized.taskReclaimed
      && finalized.taskId
    ) {
      this.realtime.publishTaskChanged(sessionId, finalized.taskId);
    }
    // Either way the queued tail changed: a message left it as an undelivered receipt, or
    // re-entered it as the next turn. The waking is already unconditional at the end of a
    // completion, so a requeued row needs nothing beyond being seen.
    if (
      ('currentWorkTerminalized' in finalized && (finalized.currentWorkTerminalized ?? 0) > 0)
      || ('currentWorkRequeued' in finalized && (finalized.currentWorkRequeued ?? 0) > 0)
    ) {
      this.realtime.publishQueuedTurnsChanged(sessionId);
    }
    if (finalized.steer) {
      // Nothing about the session changed, so nothing about it is announced. The queue view
      // did change — a steer left it — and the clients read that from the durable list.
      if (finalized.applied) this.realtime.publishQueuedTurnsChanged(sessionId);
      // A requeued steer is an executable turn again, and nothing else is going to come
      // looking for it: the completion that would normally wake the inbox has either already
      // happened or is about to find this row on its own.
      if (finalized.requeued) this.realtime.notifyInbox(sessionId);
      return { ok: true, status: finalized.status };
    }
    if (finalized.failSession) {
      // Only announce the terminal status if this call actually finalized the session
      // (a late/duplicate turn-complete for an already-ended session is a no-op).
      if (finalized.applied) {
        this.realtime.publish(sessionId, {
          seq: Number.MAX_SAFE_INTEGER,
          type: RunEventType.STATUS,
          ts: new Date().toISOString(),
          // `final` still fires with a retry armed: it means "this turn is over" — the clients
          // tear down the in-flight turn on it, and a half-streamed bubble left mid-air is
          // wrong whether or not the run resumes in 30 seconds. `retryAt` is what says the
          // FAILED beside it is not yet the outcome: publish() reads it to hold the settlement
          // announcement, and the clients read the same field off the row to draw Retrying.
          // Null once the retries are spent, and AutoRetryService.disarm publishes the real one.
          payload: {
            status: RunStatus.FAILED,
            final: true,
            ...(finalized.retryAt ? { retryAt: finalized.retryAt.toISOString() } : {}),
          },
        });
      }
      return { ok: true, status: finalized.status };
    }
    // RUNNING means the already-held slot passes to a queued follow-up. AWAITING_INPUT
    // still wakes control turns (reload/diff/end), while executable messages remain gated
    // until a future claim changes the Session back to RUNNING.
    this.realtime.notifyInbox(sessionId);
    if (finalized.applied && finalized.status === RunStatus.AWAITING_INPUT) {
      // A runner slot just became available; wake claim long-polls immediately instead
      // of leaving unrelated PENDING sessions to the periodic retry fallback.
      this.queue.notifySessionQueued();
    }
    return { ok: true, status: finalized.status };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/events')
  @HttpCode(202)
  async events(@CurrentRunner() runner: { id: string }, @Param('id', PublicIdPipe) sessionId: string, @Body() batch: RunEventBatch) {
    const leaseOwner = parseLeaseGeneration(batch?.leaseOwner);
    // Sanitized here, at the edge, so nothing downstream can carry a byte Postgres refuses:
    // every write below — run_event.payload, tool_call, the denormalized preview columns — is
    // derived from this array, and one NUL in one tool_result used to fail the batch and wedge
    // the session's stream behind it for good. See strip-nul.ts.
    // tool_output is normalized after sanitization: besides bounding its transient payload, this
    // replaces the runner's top-level monotonic seq with the live-only seq 0 sentinel (retaining
    // it as payload.snapshotSeq for snapshot ordering). An older client that ignores the unknown
    // event therefore cannot advance its durable resume cursor past an event we never store.
    const events = stripNul(batch?.events ?? []).map(normalizeToolOutputEvent);

    // Persist idempotently — RunEvent has @@unique([sessionId, seq]) + skipDuplicates.
    // text_delta / thinking_delta are streaming-animation increments: broadcast them
    // live (below) but DON'T persist them — the full reply is durably saved as the
    // trailing `assistant` / `thinking` event, so replay/refresh still shows complete
    // text without piling up rows. background_output is the live tail of a background
    // shell's file, and tool_output is the current output snapshot of an in-flight foreground
    // shell — same deal (ephemeral animation; their durable records are background_task / the
    // final tool_result respectively). The shared deny-list also fences control-plane nudges such
    // as approvals/resync if a newer or misbehaving runner ever sends one through this generic
    // event ingress; the read paths use the same list for rolling-deployment history compatibility.
    const durable = events.filter((e) => !NON_REPLAYABLE_EVENT_TYPES.includes(e.type));
    // Retried whole. This is the durable event batch, and it is the clearest case for a retry there
    // is: every write in it is already idempotent (`run_event` by `(sessionId, seq)` with
    // skipDuplicates, the tool_call outcome by tool_use id, the running sets by set semantics),
    // `durable` and `events` are derived from the request body above, and the ONE Session write is
    // accumulated from a row re-read under its lock on every attempt. The live broadcast below is
    // outside the loop, so a retried batch is published once, after the attempt that committed.
    const eventOutcome = await withTransactionRetry(this.prisma, async (tx) => {
      // Take the Session lock before any event-side write. Besides fencing stale runner
      // processes, a consistent lock order prevents event writes from racing a takeover
      // outside the transaction and later deadlocking when they touch Session.
      await this.lockSessionLeaseOwner(tx, sessionId, runner.id, leaseOwner);
      const session = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
          status: true,
          runtimeSessionId: true,
          // Read under the row lock so the three conditional writes this transaction used to
          // issue as separate guarded statements can be decided here instead. Nothing can move
          // them between this read and the single write below: the row is held FOR UPDATE.
          cancelRequestedAt: true,
          runningBgShells: true,
          runningBgJobs: true,
          runningBgJobActivity: true,
          runningSubagents: true,
          coordinatorContextEpoch: true,
          // Same one-shot-per-run reason as runtimeSessionId: the stamp below is only taken
          // while this is still null, and the row is held FOR UPDATE across that decision.
          engineStartedAt: true,
          enginePhase: true,
        },
      });
      // The owner fence alone is insufficient when the same runner process
      // survives a control-plane terminal transition. Reject before every event-
      // derived write, including empty and streaming-only batches. The runner drains
      // a task-failure tail through a bounded send barrier before terminalizing it.
      if (!OPEN.includes(session.status)) {
        throw new ConflictException('session is no longer open');
      }
      // ONE write of this Session row, accumulated here and issued once at the end
      // (common/lock-order.ts, I3). It used to be up to eight — a telemetry write, a runtime-id
      // fill, the preview denormalisation and one per background/sub-agent id — and every write
      // after the first re-ran EVERY Session foreign key, because PostgreSQL only skips the
      // re-check when the row it is replacing was not written by the current transaction. Those
      // re-checks took FOR KEY SHARE on `user`, `workspace`, `runner` and `task` while this
      // transaction held the Session FOR UPDATE, which is the exact reverse of the order a Task
      // write takes them in, and it is the third edge of the 2026-08-21 05:47:43 cycle. Written
      // once, this transaction's lock set is the Session row and its own child rows, and nothing
      // else. `lock-order.pg.spec.ts` reads those four locks out of pg_locks to keep it that way.
      const sessionData: Prisma.SessionUpdateInput = {};
      const coordinatorContextBoundarySeq = durable.reduce((latest, event) => {
        if (event.type !== RunEventType.SYSTEM) return latest;
        const payload = event.payload as {
          subtype?: unknown;
          compactMetadata?: unknown;
        } | null;
        const subtype = String(payload?.subtype ?? '');
        return (COORDINATOR_CONTEXT_BOUNDARY_SUBTYPES.has(subtype)
          || payload?.compactMetadata != null)
          ? Math.max(latest, event.seq)
          : latest;
      }, 0);
      if (coordinatorContextBoundarySeq > session.coordinatorContextEpoch) {
        // Event seq is monotonic and createMany is retry-idempotent. Taking max rather than
        // incrementing means replaying the same compaction batch cannot create a fresh epoch and
        // force another unnecessary coordinator injection.
        sessionData.coordinatorContextEpoch = coordinatorContextBoundarySeq;
        sessionData.coordinatorContextAckKey = null;
      }
      // What the person wrote, for each user turn in this batch. Read before the events are stored:
      // it is where their words end in the runner's echo, so whatever delivery appended is recorded
      // beside the echo as the control plane's own (control-plane-note.ts) — and the preview below
      // takes it over the echo for the same reason.
      const userTurnIds = [...new Set(durable.flatMap((event) =>
        event.type === RunEventType.USER && event.turnId ? [event.turnId] : [],
      ))];
      const userTurns = userTurnIds.length > 0
        ? await tx.conversationTurn.findMany({
            where: { sessionId, id: { in: userTurnIds } },
            select: { id: true, content: true },
          })
        : [];
      const authoredUserText = new Map(userTurns.map((turn) => [turn.id, turn.content]));
      for (const e of durable) {
        if (e.type !== RunEventType.USER) continue;
        e.payload = withControlPlaneNote(
          e.payload,
          e.turnId ? authoredUserText.get(e.turnId) : undefined,
        );
      }
      if (durable.length > 0) {
        // The one place a run_event is ever written, and the reason the per-token progress pings
        // stop costing 868 MB/day: `isNoiseSystemEvent` decides here whether a row is worth
        // storing, using the same predicate the live broadcast and the read paths' notNoiseSql
        // use, so what a client can see and what the archive holds stay the same set.
        //
        // `max(seq)` stays safe. It is load-bearing — the queue and the reclaim path both rebuild
        // the runner's event counter from it (runner-go: `seq := job.MaxSeq + 1`) — and a drop
        // leaves it BELOW what the dead process had counted to. The slots it fell behind by were
        // never stored, so a runner resuming at max+1 re-uses empty ones and `skipDuplicates`
        // has nothing to swallow. A batch that is nothing but pings stores nothing at all
        // (chunkedCreateMany's loop does not run on an empty list).
        await chunkedCreateMany(
          (data) => tx.runEvent.createMany({ data, skipDuplicates: true }),
          durable.filter((e) => !isNoiseSystemEvent(e)).map((e) => ({
            sessionId,
            seq: e.seq,
            type: e.type,
            payload: e.payload as Prisma.InputJsonValue,
            turnId: e.turnId ?? null,
            createdAt: new Date(e.ts),
            ingestedByRunnerId: runner.id,
            ingestedUnderLeaseGeneration: leaseOwner,
          })) as never[],
        );
        // Persisted conversation/background activity is liveness. Session-level system events
        // are different: every reclaimed idle session emits init/resumed when its runner restarts,
        // and counting that handshake would move every waiting session to "now" and scramble the
        // recency sort. OPEN deliberately includes PENDING because a buffered tail from the prior
        // turn may arrive after a concurrent send moved AWAITING_INPUT -> PENDING.
        // `status IN (OPEN)` was the other half of this write's old WHERE clause; it is the
        // condition already asserted above off the same locked read.
        if (hasSessionActivity(durable) && session.cancelRequestedAt == null) {
          sessionData.lastTurnAt = new Date();
        }
      }

      // Dynamic runtimes report their session id in an init/resumed event; unlike Claude
      // (seeded at session creation) it's otherwise only persisted at /turn-complete.
      // Capture it as soon as it lands so the reaper's startup
      // watchdog (reaper.service.ts) can tell a live-but-slow first turn from a runtime
      // that never came up — without this a first turn longer than the startup grace is
      // force-failed as "<runtime> runtime not initialized". Fill only while unset (the id is
      // stable per session), so this is a one-shot, retry-idempotent write.
      if (!session.runtimeSessionId) {
        const runtimeId = runtimeInitSessionId(durable);
        if (runtimeId) sessionData.runtimeSessionId = runtimeId;
      }

      // Denormalize the latest assistant reply onto the session for the list's preview
      // line. Take the highest-seq assistant event in this batch with non-empty text;
      // seq is monotonic per session, so this only ever advances.
      const lastAssistant = durable
        .filter((e) => e.type === RunEventType.ASSISTANT)
        .reduce<{ seq: number; text: string } | null>((acc, e) => {
          const text = (e.payload as { text?: string } | null)?.text?.trim();
          if (!text) return acc;
          return !acc || e.seq > acc.seq ? { seq: e.seq, text } : acc;
        }, null);
      // Denormalize the "frontier" activity for the sidebar's live status line. The
      // highest-seq durable event is the workspace's latest known state: a tool_use means a
      // tool is in flight (its tool_result hasn't landed yet) → surface its name; any
      // other frontier (assistant text, tool_result, turn end) means no tool is running
      // → clear it. Batches arrive in seq order, so the latest batch's frontier is the
      // latest overall. An empty (all-streaming) batch leaves the prior value untouched.
      let frontier: { seq: number; tool: string | null } | null = null;
      // The pending question, denormalized alongside the tool: the message text when a user turn
      // arrives (a turn just started, no reply yet) → the list shows it while awaiting the reply;
      // an event that *answers* it clears it, flipping the row back to the reply once it lands.
      // Everything else leaves it standing — an interrupt, a turn ending or a system handshake
      // ends the turn without answering, and clearing on those left a session interrupted before
      // its first reply with no preview at all. `undefined` = no event in this batch decided
      // either way, so the stored value stays. Stored full; the list query truncates it
      // (left(…, PREVIEW_LEN)).
      let pendingUserText: string | null | undefined;
      let currentWorkAcknowledged = 0;
      const acknowledgedTurnIds = acknowledgedRuntimeTurnIds(durable);
      if (acknowledgedTurnIds.length > 0) {
        const acknowledgedAt = new Date();
        const steers = await tx.conversationTurn.updateMany({
          where: {
            sessionId,
            id: { in: acknowledgedTurnIds },
            kind: 'steer',
            sendIntent: 'CURRENT_WORK',
            OR: [
              { deliveryStatus: null },
              { deliveryStatus: 'UNCONFIRMED' },
            ],
          },
          data: {
            deliveryStatus: 'ACKNOWLEDGED',
            deliveryAcknowledgedAt: acknowledgedAt,
            // A strict engine-read ACK may arrive after a runner-loss boundary. Resolve the
            // ambiguity rather than preserving contradictory ACK+UNCONFIRMED fields.
            deliveryFailureCode: null,
            deliveryFailureReason: null,
            deliveryTerminalAt: null,
          },
        });
        currentWorkAcknowledged = steers.count;
      }
      for (const e of durable) {
        // Sub-workspace (Task/Workspace) events carry the spawning call's parentToolUseId. Skip
        // them: while a sub-workspace runs, its own tool_use/tool_result would clobber then
        // clear the parent's frontier, dropping the sidebar out of "Running…" even though
        // the parent's Task call is still in flight. The parent's own tool_use has no
        // parentToolUseId, so it stays the frontier until its tool_result lands.
        if ((e.payload as { parentToolUseId?: string } | null)?.parentToolUseId) continue;
        if (frontier && e.seq <= frontier.seq) continue;
        const tool =
          e.type === RunEventType.TOOL_USE
            ? String((e.payload as { name?: string } | null)?.name ?? '')
                .trim()
                .slice(0, 60) || null
            : null;
        if (e.type === RunEventType.USER) {
          // The runner echoes its full delivered input, including generated references, list state
          // and coordinator context. The turn is the source of truth for the person's text; only
          // old/recovered events with no matching row fall back to the echo. A known null content
          // is an attachment-only turn and must not preview generated context as if they typed it.
          const echoed =
            (e.payload as { text?: string; content?: string } | null)?.text
            ?? (e.payload as { content?: string } | null)?.content
            ?? '';
          const text = e.turnId && authoredUserText.has(e.turnId)
            ? authoredUserText.get(e.turnId)
            : echoed;
          pendingUserText = text?.trim() || null;
        } else if (ANSWERS_USER_TURN.has(e.type)) {
          pendingUserText = null;
        }
        frontier = { seq: e.seq, tool };
      }
      // Current context-window occupancy (Session.contextTokens/contextWindow), denormalized off
      // the turn_end event that already carries it for the clients' gauge. Highest seq in the
      // batch wins, and only a positive number counts: a runtime that doesn't report it sends 0,
      // which must leave the last known value standing rather than blanking it mid-session.
      //
      // The window is read off that same event rather than reduced separately, because the pair is
      // one reading: the denominator only describes this numerator if it came from the same model
      // at the same moment. A runner too old to send one leaves the stored window alone — stale by
      // one release beats mismatched.
      const context = durable.reduce<{ seq: number; tokens: number; window: number } | null>((acc, e) => {
        const payload = e.payload as { contextTokens?: unknown; contextWindow?: unknown } | null;
        const tokens = payload?.contextTokens;
        if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return acc;
        if (acc && e.seq <= acc.seq) return acc;
        const window = payload?.contextWindow;
        const usable = typeof window === 'number' && Number.isFinite(window) && window > 0;
        return { seq: e.seq, tokens: Math.round(tokens), window: usable ? Math.round(window as number) : 0 };
      }, null);
      // A reply that is only the provider saying it cannot answer right now — the account's
      // quota spent, or the API overloaded — is the failure that fixes itself: the same
      // message succeeds once the window rolls over or the far side recovers. Arm a retry for
      // that moment. Detected here rather than in the runner so it also covers runners too old
      // to know about this — they self-update on their own schedule and outlive a release.
      const retry = lastAssistant
        ? await this.retryPlanFor(tx, sessionId, runner.id, lastAssistant.text)
        : {};
      // Whether the engine is generating right now — see Session.engineTurnActive. Tracked
      // separately from the frontier above because it must survive a tool_result (a tool
      // finishing clears lastToolUse but the turn runs on) and because `status` cannot answer
      // it: a turn the runtime started for itself never reaches /turn-complete, so the session
      // stays AWAITING_INPUT for its whole duration.
      const engineTurnActive = engineTurnActiveAfter(durable);
      // What the engine is doing in a stretch where it produces nothing else — see
      // Session.enginePhase. Reduced separately from engineTurnActive above because the two
      // answer different questions off overlapping events: a compaction is not a turn, and the
      // output that ends one is exactly what makes the turn active.
      const enginePhase = enginePhaseAfter(durable);
      const enginePhaseSince = enginePhaseSinceAfter(session.enginePhase ?? null, enginePhase, new Date());
      // When the engine first spoke for this run — see Session.engineStartedAt. `undefined`
      // from the reducer above means nothing in this batch came from the engine at all, which
      // is the case that matters: the runner emits the user turn itself (seq 1) seconds before
      // the runtime is up, so "any durable event" would end the starting state while the CLI
      // was still booting. Every value it does return — a spawn handshake, a generation event
      // from a reused warm process, a turn ending — is the engine talking.
      // Fill only while unset, like runtimeSessionId above: one-shot per run (the claim clears
      // it), so a redelivered batch cannot push the stamp later than the first arrival.
      if (!session.engineStartedAt && engineTurnActive !== undefined) {
        sessionData.engineStartedAt = new Date();
      }
      Object.assign(sessionData, {
        ...(lastAssistant ? { lastAssistantText: lastAssistant.text } : {}),
        ...(frontier ? { lastToolUse: frontier.tool } : {}),
        ...(context ? { contextTokens: context.tokens } : {}),
        ...(context?.window ? { contextWindow: context.window } : {}),
        ...(engineTurnActive !== undefined ? { engineTurnActive } : {}),
        // null is a decision here (the phase is over), undefined is "this batch said nothing
        // about it" — so only the first may be written over the stored value.
        ...(enginePhase !== undefined ? { enginePhase } : {}),
        // Moves only when the phase changes — see enginePhaseSinceAfter for why a keepalive must not.
        ...(enginePhaseSince !== undefined ? { enginePhaseSince } : {}),
        // undefined = nothing in this batch either asked or answered; keep the stored
        // message rather than writing null over it.
        ...(pendingUserText !== undefined ? { lastUserText: pendingUserText } : {}),
        ...retry,
      });

      const toolUses = events.filter((e) => e.type === RunEventType.TOOL_USE);
      if (toolUses.length > 0) {
        await chunkedCreateMany(
          (data) => tx.toolCall.createMany({ data }),
          toolUses.map((e) => ({
            sessionId,
            name: String((e.payload as Record<string, unknown>).name ?? 'unknown'),
            toolUseId: String((e.payload as { id?: unknown }).id ?? '') || null,
            input: ((e.payload as Record<string, unknown>).input ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            startedAt: new Date(e.ts),
          })) as never[],
        );
      }

      // Pair each tool_result back to the row its tool_use created, so the outcome columns
      // (output / is_error / finished_at) stop being dead. The tool_use is always persisted
      // before its result — same batch (createMany ran just above) or an earlier one (durable,
      // idempotent by seq) — so the row exists by now. Matching on (sessionId, toolUseId) with a
      // non-empty id keeps a result from smearing across the id-less rows old runtimes produced.
      // finished_at is derived from the event ts, so replaying a retried batch rewrites identical
      // values — idempotent without a guard. A runtime that streams incremental results for one id
      // (rare) collapses to its last write, which is the outcome a reader wants.
      const toolResults = events.filter(
        (e) => e.type === RunEventType.TOOL_RESULT && String((e.payload as { toolUseId?: unknown }).toolUseId ?? '') !== '',
      );
      if (toolResults.length > 0) {
        await Promise.all(
          toolResults.map((e) => {
            const p = e.payload as { toolUseId?: unknown; content?: unknown; isError?: unknown };
            return tx.toolCall.updateMany({
              where: { sessionId, toolUseId: String(p.toolUseId) },
              data: {
                output: (p.content ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                isError: !!p.isError,
                finishedAt: new Date(e.ts),
              },
            });
          }),
        );
      }

      // Maintain the running background-shell set (Session.runningBgShells), which drives the
      // "Background running" status on the list + header. Added on a background launch (keyed by
      // its tool_use id), removed on that task's terminal <task-notification> — which the runner
      // also synthesizes when the launching runtime stops, since its children die with it — and
      // cleared on a respawn handshake (see bgReset). A runner-hosted job adopted after a
      // self-update is put back by its `running` report (see bgRunning).
      // Two tools launch one: Bash with run_in_background, and Monitor, a watcher that has no such
      // flag because backgrounding is all it does. Both report in through the same
      // <task-notification> carrying the launch tool_use id (a Monitor's per-event pings carry
      // neither id nor status, so only its terminal one clears the set), which is what lets
      // bgEnded below retire either kind without knowing which it was.
      // Atomic array ops stay idempotent under event-batch retries.
      const bgStarted = events
        .filter((e) => {
          if (e.type !== RunEventType.TOOL_USE) return false;
          const name = (e.payload as { name?: string }).name;
          if (name === 'Monitor') return true;
          return (
            name === 'Bash' &&
            (e.payload as { input?: { run_in_background?: boolean } }).input?.run_in_background === true
          );
        })
        .map((e) => String((e.payload as { id?: unknown }).id ?? ''))
        .filter(Boolean);
      // Sub-workspaces (Task/Workspace tool) run async: the launch tool_result ("Async workspace launched")
      // lands immediately and the parent then streams its own top-scope system progress events,
      // so lastToolUse can't stay 'Workspace'. Track in-flight sub-workspaces the same way as background
      // shells — by their launch tool_use id, cleared by the same terminal background_task
      // (bgEnded) — so the list can show "Running Workspace…" the whole time one runs. Only top-level
      // launches count; a sub-workspace's own nested tool_use carries parentToolUseId, so skip those.
      const subStarted = events
        .filter(
          (e) =>
            e.type === RunEventType.TOOL_USE &&
            ['Task', 'Workspace'].includes(String((e.payload as { name?: string }).name ?? '')) &&
            !(e.payload as { parentToolUseId?: string }).parentToolUseId,
        )
        .map((e) => String((e.payload as { id?: unknown }).id ?? ''))
        .filter(Boolean);
      const bgEnded = events
        .filter(
          (e) =>
            e.type === RunEventType.BACKGROUND_TASK &&
            ['completed', 'failed', 'killed', 'stopped'].includes(
              String((e.payload as { status?: unknown }).status ?? ''),
            ),
        )
        .map((e) => String((e.payload as { toolUseId?: unknown }).toolUseId ?? ''))
        .filter(Boolean);
      // A *synchronous* sub-workspace (Task/Workspace run inline) reports completion as its own top-level
      // tool_result, never a <task-notification> — so without this it stays in runningSubagents
      // forever and the list is stuck on "Running Workspace…". A sub-workspace's own nested tool_results
      // carry parentToolUseId (skip those), and an async workspace's immediate "Async workspace launched"
      // ack is also a top-level tool_result for its id — but that one runs on and is cleared later
      // by its terminal background_task (bgEnded), so exclude it. Any non-sub-workspace tool_result id
      // here is harmless: it's simply absent from runningSubagents, so array_remove is a no-op.
      const subEnded = events
        .filter(
          (e) =>
            e.type === RunEventType.TOOL_RESULT &&
            !(e.payload as { parentToolUseId?: string }).parentToolUseId &&
            !isAsyncAgentLaunchAck((e.payload as { content?: unknown }).content),
        )
        .map((e) => String((e.payload as { toolUseId?: unknown }).toolUseId ?? ''))
        .filter(Boolean);
      // A respawn handshake means a fresh provider process: whatever the previous one had running
      // died with it. Only `resumed` qualifies, because the runner emits that one itself, exactly
      // when it restarts an engine in place.
      //
      // `init` used to count too, as a backstop for a runner killed outright. It cannot: Claude
      // Code emits an `init` at the head of EVERY query, including the self-driven turns it starts
      // for a background-task notification (see Session.engineTurnActive). So the wake-up that
      // proved a background task was alive was also what erased the record of it, and a session
      // watching a live Monitor reported no background work at all. The crash case is covered
      // where the handoff is actually observable: /takeover-leases clears the same two sets when a
      // different process takes the session over, and every claim and reclaim goes through it.
      const bgReset = events.some(
        (e) =>
          e.type === RunEventType.SYSTEM &&
          String((e.payload as { subtype?: unknown }).subtype ?? '') === 'resumed',
      );
      // A runner-hosted job (runner-go background_job.go) also reports itself with a `running`
      // background_task: at launch, beside the tool_use bgStarted counts, and again when a runner
      // that re-executed into a self-update adopts it. That second report is the only thing that
      // can put the job back: the new process's /takeover-leases has just cleared this set, and it
      // does not re-send the tool_use, since tool_call has no uniqueness on its id and a second one
      // would be a second row. Only a report carrying a `kind` counts — that is what marks a
      // runner-hosted job, as background-jobs-context.ts reads it too — because an engine's own
      // shell carries none, and that shell died with its engine.
      const bgRunningReports = events
        .filter((e) => {
          if (e.type !== RunEventType.BACKGROUND_TASK) return false;
          const { status, kind } = e.payload as { status?: unknown; kind?: unknown };
          return status === 'running' && typeof kind === 'string' && kind !== '';
        })
        .map((e) => {
          const { toolUseId, kind, idleMs } = e.payload as {
            toolUseId?: unknown;
            kind?: unknown;
            idleMs?: unknown;
          };
          return {
            id: String(toolUseId ?? ''),
            kind: String(kind ?? ''),
            // How long the job had produced nothing when this report was sent, on the runner's own
            // clock (runner-go bgJob.idleMs). A runner that predates the field sends none, which is
            // "unknown", not "silent" — see background-job-activity.ts.
            idleMs: typeof idleMs === 'number' && Number.isFinite(idleMs) ? idleMs : null,
          };
        })
        .filter((report) => report.id !== '');
      const bgRunning = bgRunningReports.map((report) => report.id);
      // Which of those reports are WORK rather than something left standing. `service` is the one
      // kind the runner defines as never ending (a dev server, a watcher) — it is what a workspace
      // deliberately leaves up, so it keeps the static glyph and stays out of Session.runningBgJobs.
      // Everything else (`job`, `watch`) has a terminal report coming, which is what makes "there is
      // work in flight here" a claim the control plane can stand behind. An engine's own shell is
      // absent from these reports entirely (only a runner-hosted job states a kind) and so is never
      // marked active whatever it is doing — see the column's note in schema.prisma.
      const bgJobRunning = bgRunningReports
        .filter((report) => report.kind !== 'service')
        .map((report) => report.id);
      // The two running sets, folded in the order the separate statements used to apply them:
      // reset, then the launches, then the terminal notifications, then the synchronous
      // sub-workspace completions. Computed from the values read under the row lock rather than
      // from the row itself, because this transaction gets exactly one write of it (I3) — and set
      // semantics make that identical to the sequence of `array_append`/`array_remove` it
      // replaces, including under an event-batch retry, which replays the same ids onto the same
      // starting state.
      let shells = bgReset ? [] : [...session.runningBgShells];
      let jobs = bgReset ? [] : [...session.runningBgJobs];
      let subagents = bgReset ? [] : [...session.runningSubagents];
      for (const id of bgStarted) shells = [...shells.filter((v) => v !== id), id];
      // A `running` report counts with the launches, and adds only an id that is missing — the
      // adoption. At launch the tool_use has already added it, and moving it would write the row
      // for nothing.
      for (const id of bgRunning) if (!shells.includes(id)) shells = [...shells, id];
      // Same fold, narrower set: a shell an engine launched is in `shells` and never here.
      for (const id of bgJobRunning) if (!jobs.includes(id)) jobs = [...jobs, id];
      for (const id of subStarted) subagents = [...subagents.filter((v) => v !== id), id];
      // A terminal background_task id belongs to either a background shell or a sub-workspace;
      // removing from the set that doesn't hold it is a no-op, so clear from both.
      for (const id of bgEnded) {
        shells = shells.filter((v) => v !== id);
        jobs = jobs.filter((v) => v !== id);
        subagents = subagents.filter((v) => v !== id);
      }
      if (subEnded.length > 0) {
        const done = new Set(subEnded);
        subagents = subagents.filter((v) => !done.has(v));
      }
      // Only when they actually moved, so an ordinary tool_result — the vast majority — does not
      // put the hot Session row into this write at all.
      if (!sameIds(shells, session.runningBgShells)) sessionData.runningBgShells = shells;
      if (!sameIds(jobs, session.runningBgJobs)) sessionData.runningBgJobs = jobs;
      if (!sameIds(subagents, session.runningSubagents)) sessionData.runningSubagents = subagents;
      // When each of those jobs last produced output, folded from the same reports and pruned to the
      // same set. This is what makes the marker mean "work in flight AND still moving": a job whose
      // entry here is older than the threshold stops counting as in flight while staying in
      // `runningBgShells`, which is the process that is genuinely still up. Recorded here rather
      // than decided here — see background-job-activity.ts for why a duration from the runner, and
      // not a timestamp, is what crosses the machine boundary, and why the threshold is applied by
      // the readers instead of being stored.
      //
      // A heartbeat from a job that is producing nothing recomputes the same instant (the silence it
      // reports grows exactly as the time since the last report does), so the comparison keeps an
      // idle job's minute-by-minute report from writing the row for nothing.
      const activity = bgJobActivityAfterReports(
        session.runningBgJobActivity,
        jobs,
        bgRunningReports,
        Date.now(),
      );
      if (!sameBgJobActivity(activity, session.runningBgJobActivity)) {
        sessionData.runningBgJobActivity = activity;
      }

      if (Object.keys(sessionData).length > 0) {
        await tx.session.update({ where: { id: sessionId }, data: sessionData });
      }
      return { session, currentWorkAcknowledged };
    }, loggedRetry(this.logger, 'runnerApi.events', { transaction: { timeout: EVENTS_INGEST_TRANSACTION_TIMEOUT_MS, maxWait: EVENTS_INGEST_TRANSACTION_TIMEOUT_MS } }));

    // Broadcast to live subscribers while the session is open;
    // once finalized, don't let late/replayed events spam the live stream — they
    // remain in the persisted transcript and appear on replay. NB: must include
    // AWAITING_INPUT, not just RUNNING — the runner emits a turn's final batch
    // (last text_delta + the authoritative `assistant` + `turn_end`) into its 250ms
    // buffer, then immediately calls /turn-complete, which parks the session at
    // AWAITING_INPUT. So that buffered batch almost always arrives here AFTER the
    // park; gating on RUNNING alone dropped every turn's tail from the live stream.
    // PENDING matters for the same reason when a new message races that buffered tail.
    if (eventOutcome.currentWorkAcknowledged > 0) {
      this.realtime.publishQueuedTurnsChanged(sessionId);
    }
    if (OPEN.includes(eventOutcome.session.status)) {
      for (const e of events) {
        // Persisted above either way — but a `system` progress ping renders as nothing on every
        // client, so spending a frame on it only costs the reader bandwidth. The replay paths
        // drop the same events (notNoiseSql), so live and replayed transcripts agree.
        if (isNoiseSystemEvent(e)) continue;
        this.realtime.publish(sessionId, e);
      }
    }
    // Two of the three facts the spend fuse is read on (contract §6.1 F5): this batch committed a
    // turn nobody delivered, or a call that opened a session. Decided from the batch already in
    // hand rather than by asking the fuse on every ingest — this is the hottest path there is, and
    // a batch carrying neither is the overwhelming majority.
    if (durable.some((e) => e.type === RunEventType.TURN_END && !e.turnId)) {
      await this.fuse?.afterCoordinatorSpend(sessionId, 'run_event');
    } else if (events.some((e) => e.type === RunEventType.TOOL_USE)) {
      await this.fuse?.afterCoordinatorSpend(sessionId, 'tool_call');
    }
    return { ok: true };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/finalize')
  async finalize(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() body: RunFinalizeRequest,
  ): Promise<RunFinalizeResponse> {
    // See turnComplete: the engine's last words (`result`, `error`) and the branch's per-file
    // patches all land in text/jsonb here, and a NUL in any of them fails the whole statement.
    const dto = stripNul(body);
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    // Finalize in ONE row-locked transaction. Complete/remove/reaper also write this row,
    // so the locked re-read is the only snapshot allowed to decide the final status and
    // checkout lifetime. The process fence is evaluated from that same locked snapshot,
    // so a predecessor cannot finalize after takeover. Billing is accrued per-turn by
    // /turn-complete.
    // Retried whole: one locked re-read decides the final status and the checkout lifetime, and a
    // re-run re-reads it. A session another writer finalized first is seen as finalized, which is
    // the answer this already gives.
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await this.lockSessionLeaseOwner(tx, sessionId, runner.id, leaseOwner);
      if (!TERMINAL.includes(dto.status as RunStatus)) {
        throw new BadRequestException('finalization status must be terminal');
      }
      const current = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
      });

      // If cancel/end won the row lock, its reason is authoritative regardless of what
      // the runner reports. TASK_DONE settles SUCCEEDED; task-cancel/user-end/idle and
      // hard complete/delete/cancel settle CANCELLED through the fallback.
      const effectiveStatus: RunStatus = current.cancelRequestedAt
        ? ((gracefulEndStatus(current.endReason) as RunStatus | null) ?? RunStatus.CANCELLED)
        : (dto.status as RunStatus);
      // Filing timestamps are canonical for new rows; endReason checks keep legacy rows
      // safe. Only Open sessions retain their checkout for a future resume.
      const keepCheckout =
        (current.completedAt ?? current.archivedAt) == null &&
        current.deletedAt == null &&
        current.endReason !== SessionEndReason.COMPLETED &&
        current.endReason !== SessionEndReason.DELETED &&
        !producedNothingBeforeFailing(current.numTurns, effectiveStatus, dto);
      // A run the provider's quota killed before it could speak: claude/codex refuse at startup and
      // that refusal is the process's last words, not an assistant reply, so it never passes the
      // event path that arms the retry (retryPlanFor) — the only record of when work can resume was
      // prose inside `error`. Arm the same retry from it, so `retryAt` answers "when does this come
      // back" for every quota failure rather than only the ones that got far enough to talk. Never
      // an overwrite: an ingestion-armed retry already knows more than the terminal message does.
      const quotaRetryAt =
        effectiveStatus === RunStatus.FAILED &&
        current.retryAt == null &&
        isUsageLimitErrorText(dto.error)
          ? await this.quotaRetryAt(tx, runner.id, current.provider, dto.error!)
          : null;

      // Only a LIVE session is finalized (updateMany count); duplicate/late completion
      // is a safe no-op but still returns the result derived from this locked snapshot.
      const res = await tx.session.updateMany({
        where: { id: sessionId, status: { in: LIVE } },
        data: {
          status: effectiveStatus,
          result: dto.result,
          error: dto.error,
          // `claudeSessionId` is a legacy alias older runners still send; both name the same
          // id, so it only serves as a fallback here and is never persisted on its own.
          runtimeSessionId: dto.runtimeSessionId ?? dto.claudeSessionId ?? undefined,
          finishedAt: new Date(),
          // Worktree isolation outcome reported by the runner: the branch it committed
          // the work to, the base it forked from, what it did (worktree/shared-nogit),
          // and the per-file diff summary. Each left untouched when the runner omits it.
          branch: dto.branch ?? undefined,
          baseSha: dto.baseSha ?? undefined,
          // The worktree's actual HEAD branch at completion → the bar flags divergence from the
          // tracked `branch` / offers Adopt for a session that finished on a checkout -b branch.
          ...(dto.worktreeBranch !== undefined ? { worktreeBranch: dto.worktreeBranch } : {}),
          isolationStatus: dto.isolationStatus ?? undefined,
          ...(dto.changedFiles !== undefined
            ? {
                changedFiles: dto.changedFiles as unknown as Prisma.InputJsonValue,
              }
            : {}),
          // Candidate branches for the ended session's "Merge to…" dropdown (older runners omit it).
          ...(dto.mergeTargets !== undefined ? { mergeTargets: dto.mergeTargets } : {}),
          // What the runner MEASURED the checkout to be once finalization was done with it. This
          // used to be an unconditional `false`, on the reasoning that finalizeWorktree had just
          // committed everything — and so, on the runs where staging or committing failed, the
          // control plane overwrote the last true thing anyone knew about that checkout with the
          // assumption. The session then read as clean and merge-ready while its whole output sat
          // uncommitted, and the Commit action that could have rescued it was hidden by the same
          // false flag. A runner too old to report keeps the historical answer.
          ...(dto.worktreeDirty !== undefined ? { worktreeDirty: dto.worktreeDirty } : { worktreeDirty: false }),
          // A finalize that could not put the work on the branch is a failed commit, and it is
          // shown as one: same field, same place in the status bar, git's own words. Only ever
          // written on failure — a successful finalize leaves whatever the session's own Commit
          // actions last recorded alone — and never over a commit still in flight, whose own
          // outcome is the more specific answer to the same question and is still owed to the row.
          ...(dto.captureError && current.commitStatus !== 'pending'
            ? { commitStatus: 'error', commitError: dto.captureError.slice(0, 1000) }
            : {}),
          // The session is ending — Claude (and its background children) are gone, so neither
          // the background-shell set nor any in-flight sub-workspace (Task/Workspace) can still be live.
          // Clearing runningSubagents here is the teardown backstop for a sub-workspace that never got
          // its own terminal signal (e.g. an async workspace killed with the session), so the list
          // can't stay stuck on "Running Workspace…".
          runningBgShells: [],
          runningBgJobs: [],
          runningBgJobActivity: {},
          runningSubagents: [],
          ...(quotaRetryAt ? { retryAt: quotaRetryAt } : {}),
        },
      });
      const retryAt = quotaRetryAt ?? current.retryAt;
      if (res.count === 0) return { finalized: false, effectiveStatus, keepCheckout, retryAt };
      await retireSessionInboxGeneration(tx, sessionId);
      // Persist the committed branch's per-file diffs to the side table (see turn-complete) —
      // off the session payload, fetched on demand when a file's diff is opened.
      if (dto.changedDiff !== undefined) {
        await tx.sessionDiff.upsert({
          where: { sessionId },
          create: {
            sessionId,
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
          update: {
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
        });
      }
      const currentWork = await terminalizePendingCurrentWorkSteers(tx, sessionId, {
        includeInFlight: true,
        inFlightOutcome: 'UNCONFIRMED',
        code: CURRENT_WORK_SESSION_FINALIZED,
        reason:
          `Delivery could not be confirmed before the runner finalized the session as ${effectiveStatus}.`,
      });
      const currentWorkTerminalized = currentWork.terminalizedTurnIds.length;
      // A Watch wake still queued goes with the drain below, unrun: its delivery stops reading
      // DELIVERED first (watches/watch-wake-drain.ts).
      await deadLetterQueuedWatchWakes(tx, sessionId, {
        code: 'OBSERVER_SESSION_ENDED',
        ending: `the runner finalized it as ${effectiveStatus}`,
      });
      // And an exception item queued for this conversation (projects/project-open-item.ts).
      await returnQueuedTurns(tx, sessionId, { code: 'SESSION_ENDED', ending: true });
      // Drain any queued turns so nothing can be leased after the session ends.
      await tx.conversationTurn.updateMany({
        where: { sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      // Every turn of this session has just ended, so every tool call still waiting on one is now
      // unanswerable. Same predicate as the turn boundary, evaluated after the drain that made it
      // true rather than before it.
      await reapApprovalsOfEndedTurns(tx, sessionId);
      // Abnormal end (FAILED/CANCELLED): if the workspace never got to finalize its
      // task, reclaim a now-stalled IN_PROGRESS task so it stops looking like it's
      // still running. A genuine FAILED run lands the task at FAILED (needs a human);
      // a CANCELLED (user end) goes back to OPEN (retryable). SUCCEEDED is left alone —
      // the workspace owns DONE.
      let taskReclaimed = false;
      if (current.taskId && effectiveStatus !== RunStatus.SUCCEEDED) {
        taskReclaimed = await reclaimStalledTask(
          tx,
          current.taskId,
          effectiveStatus === RunStatus.FAILED ? TaskStatus.FAILED : TaskStatus.OPEN,
          // A genuine failure also opens the project's exception item, in this transaction (contract
          // §4.3 C). A cancel does not: nobody's judgment is owed about work somebody stopped.
          effectiveStatus === RunStatus.FAILED
            ? {
                sessionId,
                how: 'RUNNER_FINALIZED_FAILED',
                error: dto.error || dto.result || 'run failed',
              }
            : undefined,
        );
        // Genuine failure (not a user cancel): leave a note on the task explaining it.
        if (effectiveStatus === RunStatus.FAILED) {
          await postRunFailureComment(tx, current.taskId, dto.error || dto.result || 'run failed');
        }
      }
      // The run ended without getting its work onto its branch. Say so on the task, whatever the
      // run's own status was — a SUCCEEDED run whose acceptance command passed is exactly the case
      // that needs it, because nothing else about that task will ever mention the absence. The
      // acceptance ran against the working tree, which is where the work still is.
      if (current.taskId && dto.captureError) {
        await postWorkNotOnBranchComment(
          tx,
          current.taskId,
          dto.branch ?? current.branch,
          dto.captureError.slice(0, 1000),
        );
      }
      return {
        finalized: true,
        effectiveStatus,
        keepCheckout,
        retryAt,
        taskReclaimed,
        taskId: current.taskId,
        currentWorkTerminalized,
      };
    }, loggedRetry(this.logger, 'runnerApi.finalize'));
    if (!outcome.finalized) return { ok: true, keepCheckout: outcome.keepCheckout };

    if (
      'taskReclaimed' in outcome
      && outcome.taskReclaimed
      && outcome.taskId
    ) {
      this.realtime.publishTaskChanged(sessionId, outcome.taskId);
      // The exception item this finalize opened, handed over (contract §4.4 X-D4 1). Before today
      // this door reclaimed the task and told nobody at all.
      await this.openItems?.deliverForTasks([outcome.taskId]);
    }
    if ('currentWorkTerminalized' in outcome && (outcome.currentWorkTerminalized ?? 0) > 0) {
      this.realtime.publishQueuedTurnsChanged(sessionId);
    }

    this.realtime.publish(sessionId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      // See turn-complete: an armed retry means this end is not the outcome yet, so the event
      // carries the moment it resumes and publish() withholds the settlement announcement.
      payload: {
        status: outcome.effectiveStatus,
        final: true,
        ...(outcome.retryAt ? { retryAt: outcome.retryAt.toISOString() } : {}),
      },
    });
    return { ok: true, keepCheckout: outcome.keepCheckout };
  }

  /** @deprecated Runner protocol alias retained for binaries predating `/finalize`. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/complete')
  complete(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: RunFinalizeRequest,
  ): Promise<RunFinalizeResponse> {
    return this.finalize(runner, sessionId, dto);
  }

  /**
   * Settle a session's pending transcript import — the runner's import step, which is the whole
   * of the claim that carries it and spawns no engine after it. `ok` clears the
   * `importSourceCwd` marker (CAS, so a retried ok after a lost reply is a no-op), may carry the
   * real title read out of the transcript, and parks the session: AWAITING_INPUT, or PENDING when
   * a message is already queued, so the claim it was holding is released and the engine starts
   * with the first message instead. A failure moves the session to Trash (FAILED + deletedAt)
   * with the reason, and the runner reports that run end via /finalize as usual, whose LIVE
   * filter leaves this Trash'd row alone.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/import-result')
  async importResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() body: { leaseOwner?: string; ok?: boolean; error?: string; title?: string },
  ) {
    // See turnComplete: the title is read out of the transcript file being imported, so it is
    // workspace bytes reaching a text column.
    const dto = stripNul(body);
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await this.lockSessionLeaseOwner(tx, sessionId, runner.id, leaseOwner);
      if (dto?.ok) {
        // The import is the whole of this claim's work and it spawns no engine, so this receipt
        // is the last thing the runner does before releasing it — which makes this the only place
        // that can move the session off RUNNING. Nothing else ever would: a RUNNING row with no
        // engine holds a runner slot and is never offered to a claim again, so leaving it here
        // would strand the session the import just made readable.
        //
        // Where it stops is decided the way a completed turn's park is (see turn-complete): a
        // message that arrived while the import was running is already queued and needs a runner,
        // so the session goes back to PENDING and the next claim is what spawns the engine for it.
        // With nothing queued there is no turn to run, and AWAITING_INPUT leaves the session
        // claimable by the first message a person sends — that claim is the one that spawns,
        // --resuming the transcript this one placed.
        //
        // A session cancelled mid-import parks too. The 'end' turn that cancel queued has no
        // engine to consume it either way, and parking is what releases the slot; the row reads
        // as ended from cancelRequestedAt, and getSendable refuses to arm it with a new message.
        const pendingExecutable = await tx.conversationTurn.count({
          where: { sessionId, kind: { in: ['message', 'shell'] }, status: 'PENDING' },
        });
        // CAS on the pending marker: a replayed ok (the runner crashed between this POST and its
        // reply) matches nothing and reports applied:false instead of applying twice. Same for a
        // row some other writer already finalized — the status guard keeps this from resurrecting
        // one, and the marker it leaves behind is inert on a session that can no longer be claimed.
        const res = await tx.session.updateMany({
          where: { id: sessionId, importSourceCwd: { not: null }, status: RunStatus.RUNNING },
          data: {
            importSourceCwd: null,
            // The runner read a real title out of the transcript; it wins over the placeholder.
            ...(dto.title ? { title: dto.title } : {}),
            status: pendingExecutable > 0 ? RunStatus.PENDING : RunStatus.AWAITING_INPUT,
          },
        });
        // Applied is what clients have to reconcile — the row's status moved, not just its title.
        return { applied: res.count > 0, failed: false, announced: res.count > 0 };
      }
      // The transcript could not be read, verified or replayed. Unconditional: an import that
      // failed has no other state to write, and no second attempt is expected to succeed.
      await tx.session.update({
        where: { id: sessionId },
        data: {
          status: RunStatus.FAILED,
          error: dto.error ?? 'import failed',
          deletedAt: new Date(),
        },
      });
      return { applied: false, failed: true, announced: true };
    }, loggedRetry(this.logger, 'runnerApi.importResult'));
    // Wake live clients: the imported session just got its real title (or went to Trash).
    if (outcome.announced) this.realtime.publishSessionUpdated(sessionId);
    return { ok: true, ...outcome };
  }

  /** Startup worktree GC support: given the session ids of leftover checkouts on the runner,
   *  return which are safe to remove. A checkout is kept while its session still exists and is
   *  neither Completed nor deleted — it stays resumable, so idle-parked sessions
   *  survive a runner restart. Everything else (Completed, deleted, or missing) is
   *  removable leftover. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/worktrees-removable')
  async worktreesRemovable(
    @CurrentRunner() _runner: { id: string },
    @Body() dto: WorktreesRemovableRequest,
  ): Promise<WorktreesRemovableResponse> {
    const ids = (dto.ids ?? []).slice(0, 1000);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const valid = ids.filter((id) => UUID.test(id));
    const keepRows = valid.length
      ? await this.prisma.session.findMany({
          where: {
            id: { in: valid },
            completedAt: null,
            archivedAt: null,
            deletedAt: null,
          },
          select: { id: true },
        })
      : [];
    const keep = new Set(keepRows.map((r) => r.id));
    return { removable: ids.filter((id) => !keep.has(id)) };
  }

  /** Outcome of a heartbeat-delivered MergeCommand — persist it so the worktree status bar
   *  can show merged ✓ / conflict / error. mergedAt + cleared error on success; the message
   *  (git stderr / failed precondition) is kept for conflict/error. `released` is not an
   *  outcome: a runner that drained before touching the repo hands the claim back. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/merge-result')
  async mergeResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SessionMergeResultRequest,
  ) {
    if (
      dto?.status !== 'merged' &&
      dto?.status !== 'conflict' &&
      dto?.status !== 'error' &&
      dto?.status !== 'released'
    ) {
      throw new BadRequestException('invalid merge result status');
    }
    const operationId = parseLeaseGeneration(dto?.operationId, 'operationId');
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner, 'leaseOwner');
    if (!!operationId !== !!leaseOwner) {
      throw new BadRequestException('operationId and leaseOwner must be provided together');
    }
    const released = dto.status === 'released';
    // Handing a claim back is only meaningful for the owner-bearing protocol: a legacy
    // request has no recorded owner to clear.
    if (released && !operationId) {
      throw new BadRequestException('released requires the claimed operation');
    }
    const merged = dto.status === 'merged';
    // Set by the §7 authority below, and read by the receipt writer further down. Declared out here
    // because `withTransactionRetry` may run the closure again, and each run re-derives it.
    let landedCheckpointId: string | null = null;
    // The project a receipt was actually WRITTEN for, carried out of the transaction so its
    // completion-input facts can be delivered once it has committed. A set rather than a variable
    // because `withTransactionRetry` may run the closure again and would otherwise leave a project
    // named by an attempt that was thrown away — re-adding the same id is a no-op, and the closure
    // adds nothing on the paths that write no receipt.
    // ...and the task whose work it landed, because that is what the dispatch edge is keyed on
    // (§2.5 J10). A Map rather than a Set for the same reason it was a Set: re-adding the same
    // project on a retried attempt overwrites rather than accumulates.
    const receiptProjects = new Map<string, string | null>();
    // Retried whole. The worktree-op claim is re-read under its row lock inside the closure, so a
    // re-run either still owns the operation it is reporting on or finds it reclaimed — the same
    // two outcomes a first attempt has.
    await withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          status: RunStatus;
          inboxLeaseOwner: string | null;
          mergeStatus: string | null;
          mergeOperationId: string | null;
          mergeOperationOwner: string | null;
          ownerId: string;
          taskId: string | null;
          branch: string | null;
          mergeTarget: string | null;
          mergeCheckpointId: string | null;
        }>
      >`
        SELECT status, "inbox_lease_owner" AS "inboxLeaseOwner",
               "merge_status" AS "mergeStatus",
               "merge_operation_id" AS "mergeOperationId",
               "merge_operation_owner" AS "mergeOperationOwner",
               "owner_id" AS "ownerId", "task_id" AS "taskId",
               "branch", "merge_target" AS "mergeTarget",
               "merge_checkpoint_id" AS "mergeCheckpointId"
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      const current = locked[0];
      // A terminal merge has no live supervisor and is claimed by the operation owner.
      // An open merge additionally remains fenced to the current Session owner.
      const legacyAttempt =
        !operationId &&
        !leaseOwner &&
        current.mergeStatus === 'pending' &&
        current.mergeOperationId === null &&
        current.mergeOperationOwner === null;
      const modernAttempt =
        !!operationId &&
        !!leaseOwner &&
        current.mergeStatus === 'pending' &&
        current.mergeOperationId === operationId &&
        current.mergeOperationOwner === leaseOwner &&
        (!OPEN.includes(current.status) || current.inboxLeaseOwner === leaseOwner);
      if (!legacyAttempt && !modernAttempt) {
        throw new ConflictException('merge operation is no longer current');
      }
      if (released) {
        // Back to the state the click produced: still pending, nobody executing. The
        // request survives the restart and the successor process claims it.
        await tx.session.update({
          where: { id: sessionId },
          data: { mergeOperationOwner: null },
        });
        return;
      }
      // `[K6]` §7, fail-closed, and deliberately BEFORE every write below.
      //
      // The runner is handed `requiredSourceSha` and is the only party that can compare it against
      // a working tree — but an older runner never reads it and a broken one can ignore it, and
      // either would then report a merge of some other commit. What followed used to be: the
      // projection is written (`branch_merged`, `merged_source_sha`), then a receipt is written,
      // and because no checkpoint matches that commit the receipt gets a NULL `checkpoint_id` —
      // which is precisely the shape 0152's own trigger is required to let through, for the old
      // replicas that legitimately produce it. An unverified tip would land as a fact.
      //
      // So the decision is taken here, from what THIS server persisted when it authorised the
      // operation, under the same row lock and inside the same fence that just proved this report
      // belongs to the operation in flight. A refusal rolls the whole transaction back: no
      // projection, no receipt, no state change of any kind. Only a LANDED claim is judged — a
      // conflict or an error is the truth about an attempt somebody made, and refusing those would
      // delete the audit and wedge the operation that is trying to report itself finished.
      const reportedSourceSha = (dto.sourceSha ?? '').trim().toLowerCase() || null;
      if (merged) {
        const authority = await reportedLandingAuthority(tx, {
          ownerId: current.ownerId,
          taskId: current.taskId,
          mergeCheckpointId: current.mergeCheckpointId,
          sourceSha: reportedSourceSha,
        });
        if (authority.decision !== 'ALLOWED') {
          throw new ConflictException(`${authority.decision}: ${authority.detail}`);
        }
        landedCheckpointId = authority.checkpointId;
      }

      await tx.session.update({
        where: { id: sessionId },
        data: {
          mergeStatus: dto.status,
          mergeError: merged ? null : (dto.message ?? null),
          mergedAt: merged ? new Date() : null,
          // A successful merge is authoritative even when ancestry/patch-id heuristics cannot
          // recognize its conflict-adapted replay.
          ...(merged
            ? {
                branchMerged: true,
                mergedSourceSha: dto.sourceSha ?? null,
              }
            : {}),
          // On a successful merge, advance the recorded fork point to the merge tip.
          ...(merged && dto.mergedSha ? { baseSha: dto.mergedSha } : {}),
        },
      });

      // §13.7 MR3: Orbit's own merge leaves a receipt too.
      //
      // Written in THIS transaction so a recorded merge and the session state it produced commit
      // together — a receipt that survives a rolled-back merge would be the worst row in the table.
      // Skipped only when the runner named no source tip: a receipt whose `sourceSha` is a guess
      // cannot be re-checked, and this table's whole value is that its rows can be.
      const sha = (value: string | undefined) => {
        const v = (value ?? '').trim().toLowerCase();
        return /^[0-9a-f]{40}$/.test(v) ? v : null;
      };
      const sourceSha = sha(dto.sourceSha);
      const mergedSha = sha(dto.mergedSha);
      const targetBranch = (dto.targetBranch ?? current.mergeTarget ?? '').trim();
      const sourceBranch = (current.branch ?? '').trim();
      // A success that cannot say where the target ended up is refused by 0128's CHECK, and
      // failing the merge-result write over it would turn a completed merge into an error the
      // runner retries forever. It is the same rule as the missing source tip: no checkable row,
      // no receipt.
      const checkable = sourceSha !== null && targetBranch !== '' && sourceBranch !== ''
        && (!merged || mergedSha !== null);
      if (checkable && sourceSha) {
        const task = current.taskId
          ? await tx.task.findUnique({
              where: { id: current.taskId },
              select: { projectId: true },
            })
          : null;
        if (task?.projectId) receiptProjects.set(task.projectId, current.taskId ?? null);
        await MergeReceiptService.fromRunnerMergeResult(tx, {
          ownerId: current.ownerId,
          sessionId,
          taskId: current.taskId,
          projectId: task?.projectId ?? null,
          // `[K6]` §7 / §13.7 MR2: a merge that moved nothing is `ALREADY_MERGED`, not `MERGED`.
          // Both are landed, so every projection below treats them alike; what the distinction
          // keeps is the one fact a reader cannot re-derive later — whether this request advanced
          // the target or found the work already there. Older runners never set the flag and keep
          // producing `MERGED`, which is what they always meant.
          result: merged
            ? (dto.alreadyMerged ? 'ALREADY_MERGED' : 'MERGED')
            : dto.status === 'conflict' ? 'CONFLICT' : 'ERROR',
          sourceBranch,
          sourceSha,
          targetBranch,
          targetShaBefore: sha(dto.targetShaBefore),
          // A merge that did not happen moved no target, so only a success names one.
          targetShaAfter: merged ? mergedSha : null,
          rebaseBaseSha: sha(dto.rebaseBaseSha),
          conflicts: dto.status === 'conflict' ? (dto.conflicts ?? []) : [],
          message: dto.message ?? null,
          operationId: dto.operationId ?? null,
          // CP4: which verified point this landing is about, when there is one. Null for every
          // merge not under convergence management, which is almost all of them.
          // The checkpoint the SERVER authorised, for a landing it has just proved is that
          // checkpoint's commit. Looking one up FROM the reported sha would return null for
          // exactly the report that most needs to be refused, and a null here is what makes
          // 0152's acceptance trigger stand down.
          checkpointId:
            landedCheckpointId ??
            (await checkpointIdForCommit(tx, {
              ownerId: current.ownerId,
              taskId: current.taskId,
              commitSha: sourceSha,
            })),
        });
      }
    }, loggedRetry(this.logger, 'runnerApi.mergeResult'));
    // The third receipt writer's own post-commit edge, and the reason it is written out here rather
    // than inside the closure above: `fromRunnerMergeResult` writes the receipt in THIS
    // transaction, so a delivery made from inside it would derive every fact from a world the
    // receipt is not yet in. `MergeReceiptService.record` takes this same edge for the other two
    // writers; here the transaction is ours, so the call is too. Failures are logged inside it —
    // the merge and the receipt are committed and a coordinator that could not be reached does not
    // un-record them.
    for (const [projectId, landedTaskId] of receiptProjects) {
      await this.mergeReceipts?.deliverProjectFactsAfterCommit(projectId, landedTaskId);
    }
    // The checkout is free again. A message the user sent while this merge executed is
    // parked PENDING behind the claim fence (see trySessionClaim); re-drive the queue so it
    // gets a slot now instead of on the next ≤5s poll. Not on `released`: the operation is
    // still pending and a successor process re-runs it.
    if (!released) this.queue.notifySessionQueued();
    return { ok: true };
  }

  /** Outcome of a heartbeat-delivered CommitCommand — persist it so the worktree status bar
   *  can flip from Commit to Merge. On success the worktree is clean (worktreeDirty=false),
   *  so the bar shows Merge without waiting for the next live-diff heartbeat; 'nochange' is
   *  also clean. An error keeps the Commit button (commitError carries git's message). A
   *  success keeps the runner's message in commitResultMessage — e.g. that it evicted the
   *  session's parked engine before committing, which nothing else records.
   *  `released` is not an outcome: a runner that drained before touching the repo hands
   *  the claim back. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/commit-result')
  async commitResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SessionCommitResultRequest,
  ) {
    if (
      dto?.status !== 'committed' &&
      dto?.status !== 'nochange' &&
      dto?.status !== 'error' &&
      dto?.status !== 'released'
    ) {
      throw new BadRequestException('invalid commit result status');
    }
    const operationId = parseLeaseGeneration(dto?.operationId, 'operationId');
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner, 'leaseOwner');
    if (!!operationId !== !!leaseOwner) {
      throw new BadRequestException('operationId and leaseOwner must be provided together');
    }
    const released = dto.status === 'released';
    if (released && !operationId) {
      throw new BadRequestException('released requires the claimed operation');
    }
    const clean = dto.status === 'committed' || dto.status === 'nochange';
    // Retried whole, on the same claim fence as the merge result above.
    await withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          status: RunStatus;
          inboxLeaseOwner: string | null;
          commitStatus: string | null;
          commitOperationId: string | null;
          commitOperationOwner: string | null;
        }>
      >`
        SELECT status, "inbox_lease_owner" AS "inboxLeaseOwner",
               "commit_status" AS "commitStatus",
               "commit_operation_id" AS "commitOperationId",
               "commit_operation_owner" AS "commitOperationOwner"
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      const current = locked[0];
      const legacyAttempt =
        !operationId &&
        !leaseOwner &&
        current.status === RunStatus.AWAITING_INPUT &&
        current.commitStatus === 'pending' &&
        current.commitOperationId === null &&
        current.commitOperationOwner === null;
      const modernAttempt =
        !!operationId &&
        !!leaseOwner &&
        current.commitStatus === 'pending' &&
        current.commitOperationId === operationId &&
        current.commitOperationOwner === leaseOwner &&
        // The command was admitted while idle. Lifecycle terminalization may win
        // before its receipt POST; accept that exact process/epoch so Resume can
        // safely wait for completion instead of stranding a claimed operation.
        (TERMINAL.includes(current.status) ||
          (current.status === RunStatus.AWAITING_INPUT && current.inboxLeaseOwner === leaseOwner));
      if (!legacyAttempt && !modernAttempt) {
        throw new ConflictException('commit operation is no longer current');
      }
      if (released) {
        // Back to the state the click produced: still pending, nobody executing. The
        // request survives the restart and the successor process claims it.
        await tx.session.update({
          where: { id: sessionId },
          data: { commitOperationOwner: null },
        });
        return;
      }
      await tx.session.update({
        where: { id: sessionId },
        data: {
          commitStatus: dto.status,
          commitError: dto.status === 'error' ? (dto.message ?? null) : null,
          commitResultMessage: clean ? (dto.message ?? null) : null,
          ...(clean ? { worktreeDirty: false } : {}),
        },
      });
    }, loggedRetry(this.logger, 'runnerApi.commitResult'));
    // Mirror mergeResult: release a message queued behind this commit now that the
    // checkout is free, rather than waiting for the queue's periodic poll.
    if (!released) this.queue.notifySessionQueued();
    return { ok: true };
  }

  /** A freshly recomputed live worktree diff, pushed in response to a 'diff' inbox control
   *  turn (the web opened a file whose stored patch lagged). Overwrites the session's
   *  changedFiles and the SessionDiff side-table patches together, so the file list and the
   *  per-file diffs are consistent again. Guarded to OPEN + this runner (mirrors the heartbeat
   *  guard) so a straggler can't clobber a just-finalized session's committed diff. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/diff')
  @HttpCode(202)
  async diffResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() body: SessionDiffResultRequest,
  ) {
    // See turnComplete: these patches are file content, and `git diff` only hides a NUL behind
    // "Binary files differ" when it sits in the first 8000 bytes.
    const dto = stripNul(body);
    await this.assertSessionOwnership(sessionId, runner.id);
    // See turnComplete: a healed base with an omitted legacy `omitempty` slice means the newly
    // computed snapshot is empty, never that the old changedFiles still belong to the new base.
    const changedFilesSnapshot =
      dto.changedFiles ?? (dto.baseSha !== undefined ? [] : undefined);
    const branchMerged = await this.reconcileReportedBranchMerged(
      sessionId,
      runner.id,
      dto.branchMerged,
      dto.branchSha,
    );
    const updated = await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        assignedRunnerId: runner.id,
        status: { in: OPEN },
      },
      data: {
        ...(changedFilesSnapshot !== undefined
          ? {
              ...(dto.baseSha !== undefined ? { baseSha: dto.baseSha } : {}),
              changedFiles: changedFilesSnapshot as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(dto.worktreeDirty !== undefined ? { worktreeDirty: dto.worktreeDirty } : {}),
        // Recomputed with the diff, so opening the drawer refreshes "✓ In main" for an idle
        // session merged out-of-band (older runners omit it → left untouched).
        ...(branchMerged !== undefined ? { branchMerged } : {}),
        // The worktree's actual HEAD branch → flags divergence / offers Adopt (older runners omit).
        ...(dto.worktreeBranch !== undefined ? { worktreeBranch: dto.worktreeBranch } : {}),
      },
    });
    // Only persist the patches once we've confirmed the session is still live (count > 0);
    // a no-op update means it finalized, so its committed diff must stay authoritative.
    if (updated.count > 0 && dto.changedDiff !== undefined) {
      await this.prisma.sessionDiff.upsert({
        where: { sessionId },
        create: {
          sessionId,
          patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
        },
        update: {
          patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return { ok: true };
  }

  /** Return the runtime session UUID + workDir so `orbit resume` can reattach locally. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/meta')
  async getSessionMeta(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
  ): Promise<{
    provider: AgentProvider;
    sessionUuid: string;
    runtimeSessionId?: string;
    workDir: string | null;
    title: string;
  }> {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    const provider = normalizeRuntimeProvider(session.provider, session.providerBuiltin);
    const runtimeSessionId = session.runtimeSessionId ?? undefined;
    if (!runtimeSessionId) {
      throw new NotFoundException('session has no runtime session ID');
    }
    const workspace = session.workspaceId ? await this.prisma.workspace.findUnique({ where: { id: session.workspaceId } }) : null;
    return {
      provider,
      sessionUuid: runtimeSessionId,
      runtimeSessionId,
      workDir: workspace?.workDir ?? null,
      title: session.title,
    };
  }

  /**
   * The session's stored transcript, oldest-first, so a runner can rebuild the runtime's own
   * local conversation file when it is gone — a machine that never ran this session, a wiped
   * ~/.claude, a moved cwd (see transcript_rebuild.go). Without it `claude --resume` just says
   * "No conversation found with session ID".
   *
   * Payloads come back WHOLE: unlike the clients' `/events/page`, a rebuilt transcript assembled
   * from preview-truncated tool output would silently rewrite the workspace's own history. Paged on
   * `after` so a long session streams in bounded chunks.
   */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/events')
  async sessionEvents(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{
    events: { seq: number; type: string; payload: unknown; ts: Date }[];
    hasMore: boolean;
  }> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const asInt = (s: string | undefined, fallback: number): number => {
      const n = Number(s);
      return s !== undefined && s !== '' && Number.isFinite(n) ? Math.trunc(n) : fallback;
    };
    const take = Math.min(Math.max(asInt(limit, 500), 1), 1000);
    const afterSeq = asInt(after, 0);
    const rows = await this.prisma.$queryRaw<
      { seq: number; type: string; payload: unknown; ts: Date }[]
    >`
      SELECT seq, type, payload, created_at AS "ts"
      FROM run_event
      WHERE session_id = ${sessionId}::uuid
        AND seq > ${afterSeq}
        AND ${replayableEventSql}
      ORDER BY seq ASC
      LIMIT ${take + 1}
    `; // one extra row: its presence means newer events remain
    const hasMore = rows.length > take;
    return { events: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  /**
   * Serialize runner-originated writes on the Session row and fence them to the process
   * identity installed by takeover. `IS NOT DISTINCT FROM` deliberately lets legacy
   * runners that omit leaseOwner write only while the Session owner is still NULL.
   */
  private async lockSessionLeaseOwner(
    tx: Prisma.TransactionClient,
    sessionId: string,
    runnerId: string,
    leaseOwner: string | null,
  ): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string; leaseOwnerMatches: boolean }>>`
      SELECT id,
             ("inbox_lease_owner" IS NOT DISTINCT FROM ${leaseOwner}::uuid) AS "leaseOwnerMatches"
      FROM "session"
      WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runnerId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new ForbiddenException('session does not belong to this runner');
    }
    if (!locked[0].leaseOwnerMatches) {
      throw new ConflictException('runner process no longer owns this session');
    }
  }

  /**
   * What this reply does to the session's armed retry — the fields to write, or `{}` to leave
   * both where they are. `text` is the turn's latest assistant message, which for both
   * self-healing failures is the entire reply.
   *
   * Three outcomes:
   *  - an exhausted quota → arm for the moment it resets (below), leaving the attempt count
   *    alone: the sweeper counts against it while the snapshot keeps reporting the quota spent.
   *  - a transient provider error → arm for one backoff step out, or hand back once the steps
   *    are spent. Task-bound sessions are excluded: such a turn also fails their task, which
   *    has its own retry budget (tasks.service AUTO_RUN_RETRY_BACKOFF_MS), and two schedulers
   *    reviving one task is how you get two runs of it.
   *  - anything else, including an error a re-send would reproduce → the run of failures is
   *    over, so clear the count. This is the ONLY thing that clears it: doing it when a retry
   *    is dispatched instead would restart the backoff at every attempt, and a provider that
   *    fails identically every time would be re-sent to forever.
   */
  private async retryPlanFor(
    tx: RetryPlanTransaction,
    sessionId: string,
    runnerId: string,
    text: string,
  ): Promise<{ retryAt?: Date | null; retryAttempts?: number }> {
    const quotaSpent = isUsageLimitErrorText(text);
    if (!quotaSpent && !isRetryableApiErrorText(text)) return { retryAt: null, retryAttempts: 0 };
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { provider: true, taskId: true, retryAttempts: true },
    });
    if (!session) return {};
    if (!quotaSpent) {
      if (session.taskId) return {};
      return { retryAt: apiErrorRetryAt(session.retryAttempts, new Date()) };
    }
    const at = await this.quotaRetryAt(tx, runnerId, session.provider, text);
    // No defensible moment → leave any earlier arming standing rather than replacing it with
    // nothing; the card falls back to a manual retry.
    return at ? { retryAt: at } : {};
  }

  /**
   * When a quota-killed run may be re-sent, from two sources in this order. The runtime's own
   * sentence is available on the spot but is prose ("resets 6:20pm (Europe/Berlin)") and Codex's
   * phrasing pins no time zone at all; the runner's quota snapshot is machine-readable but
   * refreshes on its own cadence, so it can still be describing the pre-limit world at this
   * instant. Text first for immediacy, snapshot as the fallback — and the sweeper re-checks the
   * snapshot before it fires, so a wrong-but-early guess costs a deferral, never a wasted turn.
   * null when neither can name a moment.
   *
   * The jitter is not cosmetic: a quota is an *account*-wide fact, so every session that hit it
   * comes due at the same instant, and releasing them together would reproduce the outage against
   * the freshly reset window.
   *
   * `text` is whichever words carried the refusal — the assistant reply that ingestion saw, or the
   * terminal `error` of a run that never got to speak.
   */
  private async quotaRetryAt(
    tx: QuotaRetryTransaction,
    runnerId: string,
    provider: string,
    text: string,
  ): Promise<Date | null> {
    const now = new Date();
    const runner = await tx.runner.findUnique({
      where: { id: runnerId },
      select: { planUsage: true },
    });
    const at =
      parseQuotaResetAt(text, now) ??
      planUsageBlockedUntil(runner?.planUsage as PlanUsage | null, provider, now);
    return at ? new Date(at.getTime() + Math.floor(Math.random() * QUOTA_RETRY_JITTER_MS)) : null;
  }

  private async assertSessionOwnership(sessionId: string, runnerId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.assignedRunnerId !== runnerId) {
      throw new ForbiddenException('session does not belong to this runner');
    }
    return session;
  }

  /** Reconcile the runner's heuristic merged verdict with the exact source tip captured by a
   * successful Orbit merge. `branchMerged=false` is deliberately conservative: ancestry and
   * patch-id both fail when a rebase adapts overlapping target changes. If the reported branch
   * SHA still equals mergedSourceSha, keep the successful merge authoritative and normalize the
   * snapshot to true. A missing reported SHA is inconclusive and preserves a stored exact marker;
   * only two present, different SHAs prove new commits landed. Legacy merge results without an
   * exact marker retain the historical false-clears behavior.
   */
  private async reconcileReportedBranchMerged(
    sessionId: string,
    runnerId: string,
    reported?: boolean,
    branchSha?: string,
    leaseOwner?: string,
  ): Promise<boolean | undefined> {
    if (reported !== false) return reported;
    const merged = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        assignedRunnerId: runnerId,
        status: { in: OPEN },
        mergeStatus: 'merged',
        ...(leaseOwner !== undefined ? { inboxLeaseOwner: leaseOwner } : {}),
      },
      select: {
        mergedSourceSha: true,
        mergeOperationId: true,
        mergeOperationOwner: true,
      },
    });
    if (!merged) return false;
    if (merged.mergedSourceSha && (!branchSha || merged.mergedSourceSha === branchSha)) {
      return true;
    }

    await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        assignedRunnerId: runnerId,
        status: { in: OPEN },
        mergeStatus: 'merged',
        // Fence a racing fresh merge-result: the source tip may be identical
        // across attempts, so bind the cleanup to the exact operation receipt too.
        mergedSourceSha: merged.mergedSourceSha,
        mergeOperationId: merged.mergeOperationId,
        mergeOperationOwner: merged.mergeOperationOwner,
        ...(leaseOwner !== undefined ? { inboxLeaseOwner: leaseOwner } : {}),
      },
      data: {
        mergeStatus: null,
        mergeOperationId: null,
        mergeOperationOwner: null,
        mergeError: null,
        mergedSourceSha: null,
      },
    });
    return false;
  }
}
