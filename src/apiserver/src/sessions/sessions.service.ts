import { SESSION_MERGE_RECOVERY_V1, readMergeRecovery, mergeRecoveryPrompt, mergeRecoveryReady, type MergeRecoveryAction } from '@orbit/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type ConversationTurn,
  Prisma,
  RunStatus,
  type Session,
  SessionDispatchOrigin,
  SessionRunSource,
} from '@prisma/client';
import { appendBackgroundWakeContext, isBackgroundWakeTurn } from '../runner-api/background-job-wake';
import { appendScheduledWakeupContext } from '../runner-api/scheduled-wakeup';
import { settleUnrunWakeTurns } from '../runner-api/wake-turn-withdraw';
import { linkNotFound } from '../share-links/share-link';
import { freshRunningBgJobs } from './background-job-activity';
import { CLEARED_RUNNING_WORK } from './running-work';
import { resolveLegacyArtifactPath } from './legacy-artifact-path';
import { isWorktreeArtifactPath, readWorktreeArtifactRequest } from './worktree-artifact';
import { isOrbitAuthoredTurn } from './orbit-authored-turn';
import { readSessionProjectMembership, sessionInProjectSql, sessionProjectMembershipSql } from './session-project-membership';
import {
  closeRequestsTheRetryWillNotResend,
  isSessionReplyTurn,
  queuedRepliesContent,
  readOpenRequestPeers,
  settleUnrunSessionRequests,
} from './session-request';
import { readTurnCards, type TurnCards } from './turn-cards';
import { readConfirmationsUnderReview } from '../tasks/owner-confirmation-read';
import {
  isConfirmationReviewContentTurn,
  queuedConfirmationReviewContent,
} from '../tasks/owner-confirmation-review-turn';

import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  ApprovalDecisionRequest,
  ApprovalInfo,
  ApprovalStatus,
  AgentProvider,
  openCodeKeyOf,
  type BgShell,
  CLAUDE_HISTORY_MAX_TRANSCRIPTS,
  deriveBackgroundShells,
  deriveSessionFilingState,
  deriveSessionLifecycleState,
  type EventSearchResponse,
  fastModeAvailable,
  type RunnerModelCatalog,
  FilePatch,
  MAX_PROMPT_CHARS,
  PermissionMode,
  type PermissionRule,
  ROOT_FALLBACK_PERMISSION_MODE,
  ROOT_REFUSED_PERMISSION_MODES,
  RunEventType,
  SessionEndReason,
  SessionFilingState,
  SessionLifecycleState,
  type SessionMoveFolder,
  type SessionMoveTarget,
  type SessionMoveTargets,
  type SessionResumeBlockedReason,
  type SessionTurnIntent,
  type SessionTurnPlacement,
  SessionRunState,
  SessionState,
  type SessionProjectMembership,
  type SessionSearchHit,
  type SessionSourceRefusalDetail,
  type SourceRefusalCode,
  type SourceState,
  supportsMidTurnSteer,
  supportsTargetBoundCurrentWorkSteer,
  uuidToBase62,
  accountToMoveTo,
  isAccountEngine,
  planUsageBlockedUntil,
  withEnginePlanUsage,
  type AccountEngine,
  type PlanUsage,
} from '@orbit/shared';
import { agentProviderSeed, lastProviderByWorkspace } from '../workspaces/workspace-provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  TaskWorkFacts,
  isExecutionClaimConflict,
  isLockNotAvailable,
  taskWorkRefusal,
} from '../tasks/task-supersession';
import {
  TaskRunFenceLost,
  taskAlreadyRunning,
  taskRunProviderSwitchConfirmation,
  type TaskRunEffectFence,
} from '../tasks/task-run-receipt';
import { readTaskRouteSummaries } from '../tasks/task-route-decision';
import { TASK_OCCUPYING } from '../tasks/reclaim-stalled-task';
import {
  accountDefaultPermissionMode,
  resolvePermissionMode,
} from '../common/permission-mode';
import { refuseOwnerFieldsToToken } from '../auth/pat-scope.decorator';
import type { AuthCredential } from '../common/current-user.decorator';
import { orchestrationEnabled } from '../common/orchestration-switch';
import { normalizePermissionRules } from '../common/permission-rules';
import {
  batchActiveTurns,
  runnerActiveTurns,
  treeActiveTurns,
  treeCeiling,
} from '../common/session-tree-sql';
import { QueueService } from '../queue/queue.service';
import { mergeDispatchGate } from '../projects/task-checkpoint.service';
import {
  ownerItemsForRow,
  readOwnerDecisionSignals,
  readOwnerDecisionsBySession,
  sessionWaitingKind,
} from '../projects/owner-decision-signal';
import { decideSessionSource, type SessionSourceTaskRow } from '../projects/session-source';
import { branchName } from '../projects/project-criterion-landing';
import {
  MERGE_RECEIPT_RESULTS,
  MergeReceiptRow,
  mergeReceiptRow,
  mergeStatusForResult,
} from './merge-receipt';
import { RealtimeService } from '../realtime/realtime.service';
import { MAX_UPLOAD_BYTES, toBytes } from '../attachments/attachments.media';
import { SESSION_TAG_PALETTE } from '../session-tags/session-tags.service';
import {
  CreateSessionDto,
  MoveSessionDto,
  SessionConfigDto,
  AUTOMATIC_ACCOUNT,
  SessionInterruptDto,
  SessionResumeDto,
  SessionTurnDto,
} from './dto';
import {
  enqueueBeautifySession,
  MAX_KNOWN_TAGS_PROMPTED,
  makeBranchName,
  titleFromAttachments,
  titleFromPrompt,
} from './naming';
import {
  broaden,
  normalizeSearchQuery,
  type NormalizedSearchQuery,
  stripEmphasis,
} from './search-query';
import { replayableEventSql } from '../common/system-noise';
import {
  SERVICE_TOKEN_CONCURRENCY,
  SPAWN_TREE_OUTSTANDING,
  UNSETTLED_SESSION_STATUSES,
  statusAfterTurnEnqueued,
} from '../common/session-scheduling';
import { GENERATING_SESSION_FILTER, isSessionGenerating } from '../common/session-generating';
import { countLiveApprovals, readByLiveBackgroundJob } from './abandoned-approvals';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForProvider,
  normalizeEffortForRuntimeModel,
  normalizeRuntimeProvider,
} from '../common/runtime-provider';
import {
  accountPoolRuntime,
  adminOnlyProviderRefusal,
  execRuntime,
  isBuiltinProvider,
  openCodeKeyRows,
  resolveProviderExec,
  runsOnOpenCode,
  sessionExecRuntime,
  usableProviderScope,
} from '../providers/custom-provider';
import { ownsModel } from '../providers/preset-overlay';
import {
  newTerminalResumeHandoffOwner,
  pendingWorktreeOperationMayBeExecuting,
  retireSessionInboxGeneration,
  worktreeOperationFenceSql,
} from '../common/session-inbox-fence';
import {
  TaskCompletionPolicyValue,
  taskStartOwnedByCompletion,
} from '../projects/task-aggregation';
import {
  pageAround,
  type PageRow,
  toPageEvent,
  type TranscriptAnchor,
  transcriptAnchorSql,
  type TranscriptPage,
  type TranscriptRecordKind,
} from './transcript-around';
import { EngineSignedOutConflict, engineSignInAction, signedOutEngineRefusal } from './engine-signin-preflight';
import { antigravityState, hasGeminiEnvKey } from '../common/antigravity-readiness';
import { DSH_RUNNER_UPGRADE_ERROR, dshRuntimeUnavailable } from '../runner-api/runner-provider-support';
import { ACCOUNT_ID_PATTERN } from '../runners/dto';
import {
  accountLabel,
  accountSwitchNotice,
  accountBeforeDispatch,
  automaticAccount,
  runAccount,
  workspaceLeavesAccountToOrbit,
  type WorkspaceAccountChoices,
} from '../providers/plan-usage-accounts';
import { ACCOUNT_CHOICE, ACCOUNT_PINNED } from '../providers/account';
import { namedRunnerEngines, sanitizeRunnerEngines } from '../common/runner-engines';
import { runnerAccountPausedUntil } from '../common/account-pause';
import { ACCOUNT_MOVE_CAPABILITY } from '../providers/account-move-capability';
import { sessionPoolCodexLogin } from '../providers/codex-login';
import {
  CURRENT_WORK_INTERRUPTED,
  CURRENT_WORK_SESSION_ENDED,
  terminalizePendingCurrentWorkSteers,
} from './current-work-delivery';
import { deadLetterQueuedWatchWakes } from '../watches/watch-wake-drain';
import { returnQueuedTurns } from '../projects/project-open-item';
import { OpenListDeltaStore } from './open-list-delta';
import { readOpenListVersion } from './open-list-version';
import {
  SESSION_RUNNER_OFFLINE_AFTER_MS,
  deriveSessionCapabilities,
  withSessionCapabilities,
  withSessionState,
} from './session-state';
import {
  MOVE_REFUSAL,
  accountsAfterMove,
  branchAfterMove,
  branchIsMerged,
  changedFileCount,
  mergeTargetOf,
  moveTargetRefusal,
  runnerIsOnline,
  runnerLabel,
  sessionMoveVerdict,
} from './session-move';

/**
 * A turn the control plane queued with no words of anybody's, whose content is written in at delivery:
 * a background job's or a wakeup's wake, the outcomes of the session's own requests handed back, or a
 * confirmation request's review handed to its reviewer and a reviewer's return handed to the run
 * (tasks/owner-confirmation-review-turn.ts).
 */
function isPlatformContentTurn(clientTurnId: string | null | undefined): boolean {
  return isBackgroundWakeTurn(clientTurnId)
    || isSessionReplyTurn(clientTurnId)
    || isConfirmationReviewContentTurn(clientTurnId);
}


// The furthest ahead a hand-armed retry may be scheduled (armAutoRetry). Just past the longest
// window a provider actually reports — a weekly quota — so a bad clock parks a session for days
// at worst, never indefinitely.
const MAX_ARM_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

// A lease this close to expiry is not a usable CURRENT_WORK target: capability resolution and the
// insert still have to commit before the runner can poll. The final check uses PostgreSQL's clock.
const CURRENT_WORK_LEASE_SAFETY_MS = 1_000;

// A single prompt / turn message past this size freezes the web & macOS clients (one giant
// text node lays out synchronously on the main thread), so reject it here as the server-side
// backstop to the composer's own client-side cap.
function assertPromptSize(text: string, field: 'prompt' | 'message'): void {
  if (text.length > MAX_PROMPT_CHARS) {
    throw new BadRequestException(
      `${field} is too long: ${text.length} characters (max ${MAX_PROMPT_CHARS})`,
    );
  }
}

/**
 * How far a headless caller may see: always one runner, optionally one workspace within it. Built
 * from the credential, never from anything the caller passes, and applied identically to reads
 * and to sends so no route can accidentally be broader than another.
 */
export type RunnerSessionScope = { assignedRunnerId: string; workspaceId?: string | null };

type TurnPlacement = SessionTurnPlacement;

/** A waiting turn, with the cards the runner's echo will carry (`TurnCards`, turn-cards.ts): an
 *  exception item's delivery (§4.4 X-D2), a task run's brief, another session's message, and every
 *  other card a turn the control plane opened is drawn as — so the card a client paints while this
 *  turn waits is not a different rendering of a different reading. Absent on every turn a person
 *  typed — and on this base rather than on one view, because BOTH projections carry them and both
 *  ends draw the queue (`listQueuedTurns`). A client taking another session's message off the queue
 *  unrun hands none of it back to the owner's composer: the words are the sending session's. */
interface ListedQueuedTurn extends TurnCards {
  turnId: string;
  kind: string;
  content: string;
  attachments: Array<{ id: string; mimeType: string }>;
  /** The control plane wrote this turn itself (`isOrbitAuthoredTurn`): nobody typed its words, so a
   *  client taking it off the queue unrun hands none of them back to the composer. Absent on every
   *  turn somebody sent. */
  authoredByOrbit?: true;
}

interface ListedActiveTurn extends ListedQueuedTurn {
  placement: TurnPlacement;
  createdAt: string;
  targetTurnId?: string;
  delivery?: 'failed' | 'unconfirmed';
  deliveryCode?: string;
  deliveryReason?: string;
}

const CURRENT_WORK_UNAVAILABLE = 'CURRENT_WORK_UNAVAILABLE';

function currentWorkUnavailable(
  reason:
    | 'NO_CURRENT_WORK'
    | 'TARGET_LEASE_EXPIRED'
    | 'STEER_UNSUPPORTED'
    | 'SHELL_UNSUPPORTED',
  message: string,
): ConflictException {
  return new ConflictException({ code: CURRENT_WORK_UNAVAILABLE, reason, message });
}

/** Hash every authored/configuration field that makes one resume a distinct logical operation.
 * Undefined configuration is encoded explicitly as null, while empty strings remain authored
 * values. Attachment order is not semantic on the wire, so normalize it before hashing. */
function resumeRequestFingerprint(dto: SessionResumeDto): string {
  return createHash('sha256')
    .update(JSON.stringify({
      content: dto.content,
      kind: dto.kind ?? 'message',
      intent: dto.intent ?? null,
      attachmentIds: [...new Set(dto.attachmentIds ?? [])].sort(),
      model: dto.model ?? null,
      permissionMode: dto.permissionMode ?? null,
      effort: dto.effort ?? null,
      provider: dto.provider ?? null,
    }))
    .digest('hex');
}

/**
 * The id of the copy a send makes of a file an earlier turn of this session already carries (see
 * `assertLinkableAttachments`). Derived from the request rather than drawn at random so that a
 * replay of the same send names the same copy: the receipt check compares the files a turn holds
 * with the ones its request named, and a random id would make every response-lost replay of a
 * re-send read as a different payload.
 */
function resentAttachmentId(sessionId: string, clientTurnId: string, sourceId: string): string {
  const b = createHash('sha256').update(`resend:${sessionId}:${clientTurnId}:${sourceId}`).digest();
  b[6] = (b[6] & 0x0f) | 0x80; // RFC 9562 version 8, "custom"
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The ids a turn written for this request holds, sorted: each one it named, except that a file an
 *  earlier turn carries is there as its copy. `stored` is what the turn holds now — a named id in
 *  it was linked as-is, one outside it was already another turn's when the request came in. */
function expectedTurnAttachments(
  sessionId: string,
  clientTurnId: string,
  attachmentIds: string[] | undefined,
  stored: readonly string[],
): string[] {
  return [...new Set(attachmentIds ?? [])]
    .map((id) => (stored.includes(id) ? id : resentAttachmentId(sessionId, clientTurnId, id)))
    .sort();
}

/**
 * Guards the two spawn paths a machine drives — `orbit mcp` / `orbit session create` and the
 * headless service-token bridge. Their caller is a model or a script, not a form with a picker, so
 * an invented mode would be stored verbatim and only surface when the claim hands it to the CLI:
 * far from the call that caused it, on the new session's very first turn.
 */
function assertKnownPermissionMode(mode: string | undefined): void {
  if (mode === undefined) return;
  const modes = Object.values(PermissionMode) as string[];
  if (!modes.includes(mode)) {
    throw new BadRequestException(`unknown permissionMode "${mode}"; use one of: ${modes.join(', ')}`);
  }
}

function runnerScopeWhere(scope: RunnerSessionScope | undefined) {
  if (!scope) return {};
  return {
    assignedRunnerId: scope.assignedRunnerId,
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  };
}

function legacyArtifactMime(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function legacyArtifactDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]|["\\\r\n]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How much of `cwd` a workspace's `workDir` accounts for, or -1 when the path is outside it.
 * Used to decide which workspace an imported Claude transcript belongs to.
 *
 * A workDir is stored exactly as the user typed it, which for most workspaces is home-relative
 * (`~/orbit`), while a transcript always records an absolute cwd (`/root/orbit`). The control
 * plane does not know the runner's home — one account's machines span `/root` and
 * `/home/husong` — so a `~/` workDir is read as "this tail under SOME home": the tail has to
 * appear at a directory boundary one component deep or more, with nothing or a subpath after
 * it. That is deliberately the looser question. The binding one is the runner's, which expands
 * the tilde against its own home before it copies anything (transcript_import.go); this check
 * exists so the caller does not wait for a runner to refuse the obvious cases. An absolute
 * workDir keeps its exact prefix meaning, unrelaxed.
 *
 * The answer is the matched prefix's length rather than a boolean so the tightest-workspace-wins
 * pick compares the two forms on the same footing: `~/orbit` accounts for 11 characters of
 * `/root/orbit/src`, not 7.
 */
function workDirPrefixLength(workDir: string, cwd: string): number {
  const holds = (dir: string): boolean =>
    cwd === dir || cwd.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  if (!workDir.startsWith('~' + path.sep)) return holds(workDir) ? workDir.length : -1;
  const tail = workDir.slice(2);
  // Walk the cwd's own separators, so the tail is only ever tried at a directory boundary
  // (`~/orbit` is not inside `/root/orbital`). Starting past index 0 keeps the home at least one
  // component long, which every home is.
  for (let sep = cwd.indexOf(path.sep, 1); sep !== -1; sep = cwd.indexOf(path.sep, sep + 1)) {
    const underThisHome = cwd.slice(0, sep + 1) + tail;
    if (holds(underThisHome)) return underThisHome.length;
  }
  return -1;
}

/**
 * The corpus half of `stripEmphasis`, in SQL — the query half lives in search-query.ts and the two
 * must always be applied together.
 *
 * This expression is also, character for character, what migration 0095 builds
 * session_search_trgm and run_event_text_trgm on. A trigram index over an expression is only used
 * by a query that repeats that expression exactly, so if these two ever drift the search still
 * returns the right rows — by scanning every one of them (measured 450ms against 5ms on the
 * session tier here). Change one, change the other.
 *
 * Nested replace() rather than the regexp_replace(…, '[*\`]', …) that reads more obviously: same
 * result, ~5x the speed (125ms against 356ms over 20k message bodies). replace() hands back the
 * source unchanged when there is nothing to remove, so the ~60% of rows carrying no marks cost a
 * scan instead of a rebuild — and this runs on every row a trigram index admits, since a trigram
 * match is approximate and always rechecked.
 */
const stripMarks = (col: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`replace(replace(${col}, '*', ''), '\`', '')`;

/** Where in-session find stops counting matches. See `eventTotal`. */
const EVENT_TOTAL_CAP = 1000;

/**
 * The corpus in-session find searches: one row per renderable event of one session, with every
 * string a transcript card can show flattened into a single `text` column, so the match and the
 * snippet can never disagree about where the hit is.
 *
 * A `WITH` body, shared by the page query and the count — written once because the two have to
 * search exactly the same text, and a count over a corpus the page didn't use is just a wrong
 * number.
 *
 * The two JSON casts (a tool's input, and a tool_result whose content is an array of blocks
 * rather than a plain string) search the JSON *encoding*, so a query containing a quote or a
 * newline won't match inside them — acceptable for what people actually search for (a path, a
 * name, a phrase).
 *
 * Asterisks and backticks are dropped (stripMarks, which the ⌘K palette shares and stripEmphasis
 * strips the query with) because what is stored is markdown source and what the user is searching
 * for is what they read: "the merge button" has to find "the **merge** button", and 9.5k
 * assistant events here carry bold. Underscore is deliberately kept — it is a character in half
 * the identifiers anyone would search for, not decoration.
 */
const eventBodySql = (id: string): Prisma.Sql => Prisma.sql`
  body AS (
    SELECT
      e.seq, e.type, e.created_at, e.payload,
      ${stripMarks(Prisma.sql`
        concat_ws(' ',
          CASE WHEN e.type = 'user'
               THEN (COALESCE(
                 (SELECT ARRAY[ct.content]
                    FROM conversation_turn ct
                   WHERE ct.id = e.turn_id AND ct.session_id = e.session_id),
                 ARRAY[e.payload->>'text']
               ))[1]
               ELSE e.payload->>'text' END,
          e.payload->>'name',
          (e.payload->'input')::text,
          CASE WHEN jsonb_typeof(e.payload->'content') = 'string'
               THEN e.payload->>'content'
               ELSE (e.payload->'content')::text END,
          e.payload->>'message'
        )
      `)} AS text
    FROM run_event e
    -- A user event is the runner's delivery echo and may include generated reference/list/role
    -- blocks. The correlated primary-key lookup reads what the person authored while preserving
    -- run_event's backwards index/early-LIMIT plan; a join makes Postgres hash and sort the whole
    -- session. ARRAY distinguishes a found row with NULL content (attachment-only) from no row,
    -- which alone falls back to the echo for old/recovered events.
    WHERE e.session_id = ${id}::uuid
      AND e.type IN ('user', 'assistant', 'thinking', 'tool_use', 'tool_result', 'error')
  )`;

/** "This event matches": every term ANDed, and a term's alternatives ORed (see SearchTerm). */
const eventMatchSql = (norm: NormalizedSearchQuery): Prisma.Sql =>
  Prisma.join(
    norm.patterns.map(
      (term) =>
        Prisma.sql`(${Prisma.join(
          term.map((p) => Prisma.sql`text ILIKE ${p}`),
          ' OR ',
        )})`,
    ),
    ' AND ',
  );

/**
 * What the resume door answers.
 *
 * Written out rather than inferred because the door is now REENTRANT: a confirmed provider switch
 * stops the run in the way and re-enters `resume` to continue the message, and TypeScript cannot
 * infer a return type through a cycle. Spelling it here also makes the one field the clients gained
 * a declared part of the contract instead of a shape that happens to fall out of one branch.
 */
export interface SessionResumeAnswer {
  turnId: string;
  seq: number;
  kind: string;
  placement: TurnPlacement;
  targetTurnId?: string;
  /** Whether THIS request restarted an engine, as opposed to joining one that was already up. */
  revived: boolean;
  /**
   * The session this message was delivered to, when that is not the one it was addressed to: the
   * run holding the task's execution claim, as a PUBLIC id. Absent means it landed where it was
   * sent. Clients follow it — this is how a person stops talking to a run that was replaced.
   */
  routedToSessionId?: string;
}

/**
 * Why a conversation cannot be handed a message: the closed set `receiveBlockedReasonFor` answers
 * with, and the word the agent's `ensure` door reports as its reason for opening a replacement.
 *
 * Most of it IS resumability — what a revive would refuse, a message cannot be delivered through —
 * which is why it borrows `SessionResumeBlockedReason` rather than restating it. The two additions
 * are the cases a resume's vocabulary has no name for: one where the row it describes is gone, and
 * one where the row is perfectly healthy.
 */
export type SessionReceiveBlockedReason =
  | SessionResumeBlockedReason
  /** The row the pointer names is not there at all — purged, or never this owner's. */
  | 'SESSION_GONE'
  /** §13.6 SU6: the run this conversation belongs to was replaced or abandoned. */
  | 'RUN_RETIRED';

/** What SessionsService.resolveProviderSwitch answers — see its doc comment. */
interface ResolvedProviderSwitch {
  /** The identity the session should dispatch under: the requested one, or the current one when
   *  nothing was asked for. */
  provider: string;
  providerBuiltin: boolean;
  /** The configured row behind it, already scoped to the session's owner. Null for a built-in
   *  engine, and for a slug whose row was deleted or disabled. */
  customRow: Awaited<ReturnType<Prisma.TransactionClient['modelProvider']['findFirst']>>;
  changed: boolean;
  keepsModel: boolean;
}

/**
 * This session will not take another message: it has ended, or it is in Trash. Typed rather than
 * left as prose, because a caller that must tell "this landing is spent, re-home the message" apart
 * from "the write failed" cannot afford to read error strings — the two answers lead opposite ways,
 * and one of them silently discards a real failure. Still a 409 with the same text on the wire.
 */
export class SessionNotSendable extends ConflictException {}

/**
 * The account Automatic starts a session moved onto the built-in `engine` on (accountOnProviderSwitch):
 * automaticAccount, when its workspace leaves the account to Orbit. Null leaves the session's own
 * column as it was.
 *
 * A session that has already said something has a conversation to take along, so only a runner that
 * carries one to another account is handed a new one (the capability switchAccount asks for too);
 * an older runner resumes it where it was, as before.
 */
function automaticAccountOnSwitch(
  session: {
    numTurns: number;
    workspace: ({ env: unknown } & WorkspaceAccountChoices) | null;
    assignedRunner: { engines: unknown; accountPauses?: unknown; planUsage: unknown; capabilities: string[] } | null;
  },
  engine: AccountEngine,
  now: Date,
): string | null {
  const runner = session.assignedRunner;
  if (!runner) return null;
  if (session.numTurns > 0 && !runnerCarriesAccounts(runner, engine)) return null;
  return automaticAccount(engine, session.workspace, runner.engines, runner.planUsage, now, runner.accountPauses);
}

/** Whether `runner` carries a conversation from one of its `engine` accounts to another. */
function runnerCarriesAccounts(runner: { capabilities: string[] }, engine: AccountEngine): boolean {
  return (runner.capabilities ?? []).includes(ACCOUNT_MOVE_CAPABILITY[engine]);
}

/** The account columns a provider switch writes (accountOnProviderSwitch); empty writes none. */
interface AccountSwitchWrite {
  codexAccount?: string;
  codexAccountPinned?: boolean;
  claudeAccount?: string;
  claudeAccountPinned?: boolean;
  antigravityAccount?: string;
  antigravityAccountPinned?: boolean;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  /** The snapshots `listOpenSince` answers a cursor against — see open-list-delta.ts. */
  private readonly openListDelta = new OpenListDeltaStore();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Do a write UNDER the right to do it, in one transaction.
   *
   * The lease on a run request (0137) fences the receipt's own rows — who may bind a plan, who may
   * freeze an answer — and that is not the same as fencing the EFFECT. Without this, a holder whose
   * lease expired mid-flight is already inside `session.create`, a takeover binds its own plan and
   * answers, and the old holder then commits a Session for a request that has moved on. The receipt
   * would refuse its `completeRunReceipt` afterwards, which is a report, not a prevention.
   *
   * So the write takes the receipt row FIRST, `FOR UPDATE`, and proves it is still `BOUND` to this
   * holder and attempt. The lock is held to commit, so a takeover cannot bind past a holder that is
   * legitimately mid-write, and a holder that has been taken over cannot write at all.
   *
   * With no fence — every caller that is not a task run — this is the bare write it always was.
   */
  private async writeFenced<T>(
    fence: TaskRunEffectFence | undefined,
    write: (client: PrismaService | Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!fence) return write(this.prisma);
    return withTransactionRetry(this.prisma, async (tx) => {
      await this.assertFenceHeld(tx, fence);
      return write(tx);
    }, loggedRetry(this.logger, 'sessions.writeFenced'));
  }

  /**
   * Take the run request's row and prove this delivery still owns it — inside the caller's
   * transaction, so the lock is held until whatever it fences commits.
   *
   * `FOR UPDATE` rather than a bare read: a takeover's `UPDATE … SET lease_holder` has to WAIT for
   * a holder that is legitimately mid-write, instead of overtaking it and leaving two writers.
   */
  private async assertFenceHeld(
    tx: Prisma.TransactionClient,
    fence: TaskRunEffectFence,
  ): Promise<void> {
    const [held] = await tx.$queryRaw<Array<{ attempt: number }>>(Prisma.sql`
      SELECT "attempt" FROM "task_run_request"
       WHERE "owner_id" = ${fence.ownerId}::uuid
         AND "action_kind" = ${fence.actionKind}
         AND "request_token" = ${fence.requestToken}
         AND "status" = 'BOUND'
         AND "lease_holder" = ${fence.leaseHolder}
         AND "attempt" = ${fence.attempt}
         FOR UPDATE
    `);
    // FAIL CLOSED. No row means this delivery no longer owns the request — its lease expired and
    // somebody took it over — and the one thing it must not do is write the effect anyway.
    if (!held) throw new TaskRunFenceLost(fence.requestToken);
  }

  /**
   * Ensure any workspace/runner a session references belongs to the caller — without
   * this a user could pin a session to another tenant's runner and have Claude
   * Code execute on a machine they don't own (cross-tenant RCE).
   */
  private async assertOwnedRefs(
    ownerId: string,
    refs: { workspaceId?: string; assignedRunnerId?: string },
  ): Promise<void> {
    if (refs.assignedRunnerId) {
      const runner = await this.prisma.runner.findFirst({
        where: { id: refs.assignedRunnerId, ownerId },
        select: { id: true },
      });
      if (!runner) throw new ForbiddenException('runner not found');
    }
    if (refs.workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: refs.workspaceId, ownerId, deletedAt: null },
        select: { id: true },
      });
      if (!workspace) throw new ForbiddenException('workspace not found');
    }
  }

  // `source` is retained as internal provenance for backwards compatibility. Current clients
  // no longer split out a System list, and task-linked runs are always "user" so older clients
  // also place them in Open. `source` is not on CreateSessionDto, so HTTP clients can't spoof it.
  async create(
    ownerId: string,
    dto: CreateSessionDto,
    opts?: {
      source?: string;
      batch?: { id: string; maxConcurrent: number };
      /** Spawn-tree membership. Independent of `batch`: a tree is open-ended and
       *  server-capped, a batch run is a closed set with a user-chosen cap. */
      tree?: { rootSessionId: string; depth: number };
      parentSessionId?: string;
      dispatchOrigin?: SessionDispatchOrigin;
      runSource?: SessionRunSource;
      /**
       * §13.8: open this session with no worktree, whatever its workspace's default is.
       *
       * A conversation about a task does not change code, so a branch and a worktree for it are an
       * unmerged branch left behind by a reply to a comment — which reads as work somebody
       * abandoned. Internal, and set only by the @-mention delivery sweep.
       */
      noWorktree?: boolean;
      /**
       * §13.8: the task this session is ABOUT rather than one it executes.
       *
       * INTERNAL, and deliberately not on `CreateSessionDto`: a public field would need Base62
       * decoding and an owner check of its own, and the only writer is the @-mention delivery
       * sweep, which already knows the task is the one it read the comment from. Mutually exclusive
       * with `dto.taskId` at the database (0131's CHECK).
       */
      contextTaskId?: string;
      /**
       * §13.8: the id this session must be created WITH.
       *
       * Also internal. The delivery ledger binds a target id BEFORE creating the session, so a
       * worker that dies between the two retries with the SAME id — and the create either succeeds
       * or collides with the row it already wrote, instead of opening a second conversation.
       */
      id?: string;
      /**
       * The run request this Session is being written FOR, and the proof that this caller still
       * holds it (0137).
       *
       * Passed through rather than checked by the caller, because a check the caller makes BEFORE
       * the write is not a fence: a lease can expire between it and the insert, a takeover can bind
       * its own plan, and the old holder would still commit a Session the request no longer wants.
       * Given one, the insert happens inside a transaction that first takes the receipt row and
       * proves it is still `BOUND` to this holder and attempt — so the write and the right to make
       * it commit together, or neither does.
       */
      fence?: TaskRunEffectFence;
      /**
       * §13.6 SU6: this Session exists to DO the task's work, not to look at it.
       *
       * Only the paths that start work set it — Run Now, the sweeps, the Project dispatcher — and
       * 0130's guard is its only reader: it is what lets the database refuse a repeat of replaced
       * work while still allowing somebody to open a session against the replaced attempt and read
       * what it did. Defaults false, which is what an ordinary session_create means.
       */
      startsTaskWork?: boolean;
      /**
       * Internal title ownership for a dedicated Project coordinator. The project service supplies
       * the canonical project title with this bit; public session creation cannot claim it.
       */
      titleManagedByProject?: boolean;
      /**
       * The HTTP create door's credential. A personal access token may not choose `permissionMode`
       * at all, to any value, for the reason `updateConfig` refuses it one (§5.1 of
       * docs/personal-access-token-design.md): a session opened in a mode that runs without asking
       * would take approvals — which only a login may answer — out of its way. Without one the
       * session opens in the account's default mode, as every session that names none does.
       */
      credential?: AuthCredential;
    },
  ) {
    refuseOwnerFieldsToToken(opts?.credential, { permissionMode: dto.permissionMode });
    // Attachments with no words are a whole opening message, as they are on any later turn: the
    // runtime is handed the files either way. A shell command is nothing without its words.
    const attachmentsAlone =
      dto.prompt === '' && !dto.shell && (dto.attachmentIds?.length ?? 0) > 0;
    if (!dto.prompt && !attachmentsAlone) throw new BadRequestException('prompt is required');
    assertPromptSize(dto.prompt, 'prompt');
    // An account id, never a path: which account is stored here, and where it lives is only ever
    // what the runner reports. CreateSessionDto is an interface, so nothing upstream checked it.
    if (
      dto.codexAccount != null &&
      (typeof dto.codexAccount !== 'string' || !ACCOUNT_ID_PATTERN.test(dto.codexAccount))
    ) {
      throw new BadRequestException('codexAccount must be "default" or the id of one of the runner\'s accounts');
    }
    if (
      dto.claudeAccount != null &&
      (typeof dto.claudeAccount !== 'string' || !ACCOUNT_ID_PATTERN.test(dto.claudeAccount))
    ) {
      throw new BadRequestException('claudeAccount must be "default" or the id of one of the runner\'s accounts');
    }
    if (
      dto.antigravityAccount != null &&
      (typeof dto.antigravityAccount !== 'string' || !ACCOUNT_ID_PATTERN.test(dto.antigravityAccount))
    ) {
      throw new BadRequestException('antigravityAccount must be "default" or the id of one of the runner\'s accounts');
    }
    // The session runs on a runner. Prefer an explicit pin; otherwise derive it from
    // the chosen workspace's machine (workspaces belong to a runner) — picking a workspace is
    // enough to know which machine + project dir to run in.
    let assignedRunnerId: string | undefined = dto.assignedRunnerId;
    // The session's provider identity: a built-in ("claude"/"codex"/"kimi"/"opencode"/"antigravity")
    // or a custom slug ("deepseek"). Stored verbatim; runtime is derived below. A workspace holds no
    // provider of its own — absent an explicit pick this is seeded from what the project last ran on.
    let provider: string = AgentProvider.CLAUDE;
    let providerBuiltin = true;
    // Per-workspace worktree toggle: default off. A workspace with it turned off (the default)
    // makes its sessions run with no branch, so the runner runs them in the shared workDir.
    let enableWorktree = false;
    // The owner's account-level permission default, materialized onto the session below when the
    // caller picked none (MCP spawns, task runs — the web/native composers always send one).
    // The claim resolves session ?? account ?? auto anyway, so this doesn't change what the
    // runner spawns with; it stops a NULL column from *reading* as one particular mode in every
    // client's Mode pill — a stale pill that the next resume writes back, silently changing a
    // session that was really running the account's mode.
    // Only looked up when the caller named no mode: the web/native composers always send one,
    // so the common path stays at the query count it had before this moved off the workspace.
    const accountPermissionMode = dto.permissionMode
      ? undefined
      : accountDefaultPermissionMode(
          await this.prisma.user.findUnique({
            where: { id: ownerId },
            select: { preferences: true },
          }),
        );
    // The same shape, for the same reason, one field over: the effort a caller that named none
    // inherits. Every surface a person picks effort on writes it back as the account default
    // (`UserPreferences.defaultEffort`), so "no effort in this request" means "whatever I last
    // chose", never "the engine's own default".
    //
    // It used to be resolved by CALLERS instead — `session_create` and the service-token bridge
    // each call `resolveDefaultEffort` before this method — which left every other server-started
    // session at the engine default: a task run, a coordinator, a judgment session all began at
    // Default while the account said `max`. Resolved here, the rule holds wherever a session comes
    // from, and the two callers above simply arrive with `dto.effort` already set.
    //
    // `undefined` is the only value that means "unasked": an empty string is the composer's
    // explicit *Default*, and it must not be overwritten by a remembered pick.
    const accountEffort =
      dto.effort === undefined
        ? await this.resolveDefaultEffort(ownerId, dto.workspaceId)
        : undefined;
    // The workspace's own environment, which may carry the provider credential that makes the
    // runner's engine sign-in irrelevant — see the sign-in preflight below.
    let workspaceEnv: unknown;
    // The accounts the workspace pins its sessions to, whose sign-ins the preflight below judges.
    let accountChoices: WorkspaceAccountChoices | undefined;
    if (!assignedRunnerId && dto.workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: dto.workspaceId, ownerId, deletedAt: null },
        select: {
          runnerId: true,
          enableWorktree: true,
          enabled: true,
          env: true,
          codexAccount: true,
          claudeAccount: true,
          antigravityAccount: true,
        },
      });
      if (!workspace) throw new ForbiddenException('workspace not found');
      // Every way a session gets started — composer, task run, orchestrated spawn — funnels
      // through here, so this one check is what makes "disabled" mean anything. Kept separate
      // from the not-found path: the workspace exists and its config is intact, which is exactly
      // what the caller needs to hear to know it can be switched back on.
      //
      // Tested against `false` rather than falsiness: the column is non-nullable with a
      // default, so a real row is always a boolean, and only an explicit "off" should refuse.
      if (workspace.enabled === false) throw new ForbiddenException('workspace is disabled');
      assignedRunnerId = workspace.runnerId ?? undefined;
      enableWorktree = workspace.enableWorktree;
      workspaceEnv = workspace.env;
      accountChoices = workspace;
    } else if (dto.workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: dto.workspaceId, ownerId, deletedAt: null },
        select: { enableWorktree: true, enabled: true, env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true },
      });
      if (!workspace) throw new ForbiddenException('workspace not found');
      if (workspace.enabled === false) throw new ForbiddenException('workspace is disabled');
      enableWorktree = workspace.enableWorktree;
      workspaceEnv = workspace.env;
      accountChoices = workspace;
    }
    if (!assignedRunnerId) {
      throw new BadRequestException('pick a workspace bound to a runner, or pass assignedRunnerId');
    }
    // No explicit pick: start where this project last started. Derived, not stored — see
    // workspace-provider.ts for why a workspace holds no provider of its own.
    if (!dto.provider && dto.workspaceId) {
      ({ provider, providerBuiltin } = await agentProviderSeed(this.prisma, dto.workspaceId));
    }
    // The runtime a configured provider borrows, which is what decides the pre-generated session
    // id below — its slug says nothing about which CLI ends up running it.
    let borrowedRuntime: string | null = null;
    // An explicit provider (the New Session picker) overrides what the workspace would have
    // contributed. Resolved here rather than trusted: a built-in engine slug is always fine,
    // and anything else has to be a provider this caller can actually dispatch with.
    if (dto.provider) {
      provider = dto.provider;
      // Deliberately NOT isBuiltinProvider(): that one reads `kimi` as custom unless told
      // otherwise. This test has to match the one the seed carries forward, or a session started
      // from a `kimi` predecessor would land with a different providerBuiltin than it had.
      providerBuiltin = Object.values(AgentProvider).includes(dto.provider as AgentProvider);
      // dsh is a new reserved engine name. A reachable provider or pool that already held it
      // remains configured, fenced by the existing discriminator rather than renamed.
      if (!providerBuiltin || provider === AgentProvider.DSH) {
        const configured = await this.prisma.modelProvider.findFirst({
          where: {
            slug: dto.provider,
            ...(provider === AgentProvider.DSH ? {} : { enabled: true }),
            ...(await usableProviderScope(this.prisma, ownerId)),
          },
          select: { runtime: true, enabled: true },
        });
        if (configured?.enabled === false) {
          throw new BadRequestException(`provider not available: "${dto.provider}"`);
        }
        // …or one of the caller's own account pools, which the claim resolves to a member.
        borrowedRuntime = configured
          ? configured.runtime
          : await accountPoolRuntime(this.prisma, ownerId, dto.provider);
        if (configured || borrowedRuntime) providerBuiltin = false;
        // The slug is named: a command-line caller typed it, and no picker checked it first.
        if (!providerBuiltin && !configured && !borrowedRuntime) {
          throw new BadRequestException(
            (await adminOnlyProviderRefusal(this.prisma, ownerId, dto.provider)) ?? `provider not available: "${dto.provider}"`,
          );
        }
        if (!configured && borrowedRuntime) await this.assertUsablePool(ownerId, dto.provider);
      }
    } else if (!isBuiltinProvider(provider, providerBuiltin)) {
      providerBuiltin = false;
      // Inherited from the workspace: a removed/disabled provider cannot substitute the runner's
      // own Claude login for the configured endpoint the caller inherited.
      const configured = await this.prisma.modelProvider.findFirst({
        where: { slug: provider, enabled: true, ...(await usableProviderScope(this.prisma, ownerId)) },
        select: { runtime: true },
      });
      borrowedRuntime = configured
        ? configured.runtime
        : await accountPoolRuntime(this.prisma, ownerId, provider);
      if (!borrowedRuntime) {
        throw new BadRequestException(
          (await adminOnlyProviderRefusal(this.prisma, ownerId, provider)) ?? `provider not available: "${provider}"`,
        );
      }
      if (!configured && borrowedRuntime) await this.assertUsablePool(ownerId, provider);
    }
    if (borrowedRuntime && (!Object.values(AgentProvider).includes(borrowedRuntime as AgentProvider) ||
      borrowedRuntime === AgentProvider.OPENCODE)) {
      throw new BadRequestException(`provider runtime not available: "${borrowedRuntime}"`);
    }
    // An OpenCode model on one of the caller's configured keys (shared `openCodeKeys`) has to name a
    // key that can run there, or the claim would only refuse it later.
    const openCodeKey = provider === AgentProvider.OPENCODE ? openCodeKeyOf(dto.model) : null;
    if (openCodeKey) {
      const row = await this.prisma.modelProvider.findFirst({
        where: { slug: openCodeKey.slug, ...(await usableProviderScope(this.prisma, ownerId)) },
        select: { enabled: true, runtime: true, apiKeyEnc: true },
      });
      if (!row || !runsOnOpenCode(row)) {
        throw new BadRequestException(
          (!row && (await adminOnlyProviderRefusal(this.prisma, ownerId, openCodeKey.slug)))
            || `provider not available on OpenCode: "${openCodeKey.slug}"`,
        );
      }
    }
    await this.assertOwnedRefs(ownerId, { workspaceId: dto.workspaceId, assignedRunnerId });
    // §3.2: a session opened from a folder's page is filed in that folder, which has to be one of
    // the caller's folders in the workspace this session is created in. A plain read: a folder
    // never changes workspace, and one deleted before the INSERT fails its foreign key there.
    const folderId = dto.folderId || null;
    if (folderId) {
      // CreateSessionDto is an interface, so nothing upstream checked the type: a number here would
      // reach Prisma as one and come back a 500.
      const folder = dto.workspaceId && typeof folderId === 'string'
        ? await this.prisma.sessionFolder.findFirst({
            where: { id: folderId, ownerId, workspaceId: dto.workspaceId },
            select: { id: true },
          })
        : null;
      if (!folder) throw new BadRequestException('folderId must be a folder of this workspace');
    }
    // provider is the identity stored on the row; runtime is which built-in CLI actually
    // drives it (a custom provider borrows Claude/Codex/Kimi), and decides the pre-generated
    // session-id and effort normalization. A borrowed runtime is authoritative here: giving a
    // Codex/Kimi session a Claude-style id it never created makes its very first spawn a resume
    // of a conversation that doesn't exist.
    const runtime = borrowedRuntime
      ? normalizeRuntimeProvider(borrowedRuntime)
      : normalizeRuntimeProvider(provider, providerBuiltin);
    // A mode the target machine cannot run at all: Bypass on a runner deployed as root, which
    // claude refuses by exiting inside its own startup — five seconds in, with the refusal on
    // stderr and a bare FAILED in every UI. Which of the two outcomes below applies turns on who
    // chose the mode, because they are owed different answers:
    //
    //   named by the caller  -> refuse. A composer that offered it is stale and an MCP/CLI caller
    //                           invented it; either way the request cannot be honored as written,
    //                           and silently running something else would report success for a
    //                           guarantee that was never applied.
    //   the account default  -> substitute. A stored preference is about a fleet, not this machine,
    //                           and must not make every session on one runner unstartable.
    //
    // The lookup sits behind the mode test, so no caller that named a runnable mode pays for it.
    let rootRefusedFallback: PermissionMode | undefined;
    const requestedMode = dto.permissionMode ?? accountPermissionMode;
    if (runtime !== AgentProvider.DSH && requestedMode && ROOT_REFUSED_PERMISSION_MODES.has(requestedMode)) {
      const target = await this.prisma.runner.findUnique({
        where: { id: assignedRunnerId },
        select: { name: true, runsAsRoot: true },
      });
      if (target?.runsAsRoot && dto.permissionMode) {
        throw new BadRequestException(
          `runner "${target.name}" runs as root, and Claude Code refuses "${dto.permissionMode}" ` +
            `under root — the session would exit before its first turn. Use ` +
            `"${ROOT_FALLBACK_PERMISSION_MODE}", which also never asks.`,
        );
      }
      // Substituted into the stored column rather than only at dispatch, so the Mode pill reads
      // what the session will really do. Narrowing only (Bypass -> Don't Ask, allow -> deny), which
      // is why this is safe to persist where the general rule is to derive: the account's own
      // default is untouched, and a session cannot move to a runner that would have honored it.
      if (target?.runsAsRoot) rootRefusedFallback = ROOT_FALLBACK_PERMISSION_MODE;
    }
    // Linking to a task: it must belong to the same user (no cross-tenant linking). The same read
    // carries §4's inputs, so which code this run starts from is decided from the row this caller
    // was just proved to own rather than from a second lookup that could answer differently.
    let sourceTask: SessionSourceTaskRow | null = null;
    if (dto.taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, ownerId },
        select: {
          id: true,
          projectId: true,
          verifiesTaskId: true,
          pinnedRevision: true,
          codeless: true,
          attemptGeneration: true,
          knownGoodSha: true,
        },
      });
      if (!task) throw new ForbiddenException('task not found');
      sourceTask = task;
    }
    // The fourth resolution chain: WHICH COMMIT this run starts from
    // (`docs/project-source-contract.md`). Resolved here, before the insert, because its answer is
    // nine columns of that same insert (SR28) — a session that is claimable before its selector is
    // written is a session a claim starts Legacy.
    //
    // Deliberately reads only the task and its project's code binding: no workspace, no workDir, no
    // `defaultMergeTarget` (SR1/SR3). Which machine this lands on is decided above and contributes
    // nothing here. A session that executes no task, or whose project has no binding, resolves
    // `UNBOUND` and behaves exactly as it did before migration 0231 (SR45).
    const source = await decideSessionSource(this.prisma, sourceTask);
    // Validate any compose-page image refs up front (caller's, still unscoped) so a bad
    // one fails the request before a session is created. They're scoped to the session
    // below and linked to the seeded first turn when the runner claims it (queue.service).
    const attachmentIds = await this.assertScopableAttachments(ownerId, dto.attachmentIds);
    // PENDING so the assigned runner claims it and spawns the long-lived claude
    // process; it then awaits turns via the inbox.
    // Persist a title and worktree branch synchronously. Naming is cosmetic and must never hold
    // session creation (especially a large task batch) open on an external model. An explicit
    // title is authoritative; otherwise the display title can be beautified in the bounded
    // background queue below. The branch is fixed before the runner can claim the session and is
    // never changed afterwards because a runner may already have created its git worktree.
    // DTO is intentionally an interface, so normalize a runtime JSON null even though TypeScript
    // callers only see string | undefined. Empty string remains an explicit caller choice.
    const explicitTitle = dto.title ?? undefined;
    const hasExplicitTitle = explicitTitle !== undefined;
    const title =
      explicitTitle ??
      (attachmentsAlone
        ? // No words to name it by: the session is named for the files it was opened with.
          titleFromAttachments(
            (
              await this.prisma.attachment.findMany({
                where: { id: { in: attachmentIds } },
                orderBy: { createdAt: 'asc' },
                select: { fileName: true },
              })
            ).map((a) => a.fileName),
          )
        : titleFromPrompt(dto.prompt));
    let branch = enableWorktree ? makeBranchName(title) : null;
    // Refuse now if the machine this is bound for cannot start it at all, rather than creating a
    // session (and, on the runner, a git checkout) that dies a second later with the same message.
    // Only for a runtime signed out on an online runner — see signedOutEngineRefusal for
    // everything this deliberately lets through.
    const targetRunner = await this.prisma.runner.findFirst({
      where: { id: assignedRunnerId, ownerId },
      select: { name: true, displayName: true, status: true, lastHeartbeatAt: true, engines: true, accountNames: true, accountPauses: true, planUsage: true, capabilities: true, capabilitiesReportedAt: true },
    });
    if (runtime === AgentProvider.DSH) {
      if (!targetRunner?.capabilitiesReportedAt || !targetRunner.capabilities?.includes('provider:dsh')) {
        throw new ConflictException(DSH_RUNNER_UPGRADE_ERROR);
      }
      // P4 has not yet verified an Orbit permission policy for Harness. The runner upgrade
      // refusal comes first so an older machine receives the availability action it needs.
      normalizeBuiltinPermissionMode(
        runtime,
        dto.model ?? '',
        resolvePermissionMode(dto.permissionMode ?? accountPermissionMode, null),
      );
      // Declaring dsh does not install it. Refused here like the upgrade, rather than creating a
      // session the runner would claim only to fail at launch (dshRuntimeUnavailable).
      const unavailable = dshRuntimeUnavailable(targetRunner.engines);
      if (unavailable) throw new ConflictException(unavailable);
    }
    // The Codex, Claude or Antigravity account this session runs on: the one picked for it — which
    // pins it there — else, when its workspace leaves the account to Orbit, the runner's account whose
    // quota resets soonest (automaticAccount), which Orbit may move it off when that account's usage
    // limit stops it. Stored here; a Codex or Claude conversation lives in that account's directory.
    // Null runs on the workspace's.
    const automatic = (engine: AccountEngine) =>
      provider === engine && providerBuiltin && targetRunner
        ? automaticAccount(
            engine,
            { env: workspaceEnv, ...accountChoices },
            targetRunner.engines,
            targetRunner.planUsage,
            new Date(),
            targetRunner.accountPauses,
          )
        : null;
    const codexAccount = dto.codexAccount ?? automatic(AgentProvider.CODEX);
    const claudeAccount = dto.claudeAccount ?? automatic(AgentProvider.CLAUDE);
    const antigravityAccount = dto.antigravityAccount ?? automatic(AgentProvider.ANTIGRAVITY);
    const refusal =
      targetRunner &&
      signedOutEngineRefusal({
        runtime,
        bringsOwnCredentials: borrowedRuntime != null,
        workspaceEnv,
        // The account this session runs on is the one judged, whatever the workspace says.
        accounts: {
          ...accountChoices,
          ...(codexAccount ? { codexAccount } : {}),
          ...(claudeAccount ? { claudeAccount } : {}),
          ...(antigravityAccount ? { antigravityAccount } : {}),
        },
        runner: targetRunner,
      });
    // Typed, not a bare 409: this is an availability condition — the engine is signed out on a
    // machine that is up — and a caller that retries has to be able to tell it from a refusal that
    // will never succeed. See `EngineSignedOutConflict`. It names the runner, and the sign-in that
    // clears it where Orbit can start one, so a client can offer that as a button.
    if (refusal && targetRunner) {
      throw new EngineSignedOutConflict(runtime, refusal, assignedRunnerId, engineSignInAction(runtime, targetRunner));
    }
    // §13.8: a conversation gets no worktree. Applied after the workspace's default is read, so it
    // is a deliberate override rather than a second source of the default.
    if (opts?.noWorktree) {
      enableWorktree = false;
      branch = null;
    }
    const runtimeSessionId = randomUUID();
    const session = await this.writeFenced(opts?.fence, (client) => client.session.create({
      data: {
        ...(opts?.id ? { id: opts.id } : {}),
        title,
        titleManagedByProject: opts?.titleManagedByProject ?? false,
        titleBeforeProjectManagement: null,
        branch,
        prompt: dto.prompt,
        status: RunStatus.PENDING,
        provider,
        providerBuiltin,
        // Pre-generate the Claude session id so the runner spawns with --session-id.
        // Codex/Kimi/OpenCode/Antigravity create and return their own thread id after process init.
        runtimeSessionId: runtime === AgentProvider.CLAUDE ? runtimeSessionId : null,
        model: dto.model,
        // Old replicas omit this post-0079 column and receive its false default. That lets claim
        // distinguish their legacy null-model inheritance from new Runtime-default semantics.
        usesRuntimeDefaultModel: true,
        permissionMode: rootRefusedFallback ?? dto.permissionMode ?? accountPermissionMode,
        effort: normalizeEffortForProvider(runtime, dto.effort ?? accountEffort),
        // Stored as asked rather than clamped here, unlike effort above: whether this session
        // has a fast lane depends on the MODEL it ends up running (and for Codex on that model's
        // row in the runner's catalogue), and a request that named none inherits the runner's
        // Runtime default, which only the claim resolves. So the constraint is applied once, at
        // dispatch (`fastModeAvailable` in queue.service and the reclaim payload), and a session
        // whose effective model has no fast lane simply dispatches without one instead of being
        // refused at create.
        fastMode: dto.fastMode === true,
        // As picked or chosen above, `default` included: NULL is the one value that follows the
        // workspace's choice. A pick by hand pins it.
        codexAccount,
        codexAccountPinned: dto.codexAccount != null,
        claudeAccount,
        claudeAccountPinned: dto.claudeAccount != null,
        antigravityAccount,
        antigravityAccountPinned: dto.antigravityAccount != null,
        workspaceId: dto.workspaceId,
        assignedRunnerId,
        taskId: dto.taskId,
        folderId,
        // §13.8: what this session is ABOUT, when it is not executing it. Mutually exclusive with
        // `taskId` at the database (0131), so the two cannot both be set by accident.
        contextTaskId: opts?.contextTaskId ?? null,
        dispatchOrigin: opts?.dispatchOrigin ?? SessionDispatchOrigin.USER,
        runSource: opts?.runSource ?? SessionRunSource.MANUAL,
        startsTaskWork: opts?.startsTaskWork ?? false,
        // A task session must remain discoverable in Open even if an internal caller
        // accidentally asks for the legacy "system" provenance.
        source: dto.taskId ? 'user' : (opts?.source ?? 'user'),
        batchId: opts?.batch?.id ?? null,
        batchMaxConcurrent: opts?.batch?.maxConcurrent ?? null,
        rootSessionId: opts?.tree?.rootSessionId ?? null,
        spawnDepth: opts?.tree?.depth ?? 0,
        parentSessionId: opts?.parentSessionId ?? null,
        creatorId: ownerId,
        ownerId,
        // SR28: the SOURCE selector is frozen by THIS statement, not a follow-up UPDATE. The
        // database agrees — migration 0231's freeze guard refuses every later write to these nine
        // columns, so there is no second statement that could write them.
        ...source.columns,
      },
    })).catch(async (e: unknown) => {
      // The folder checked above was deleted before this INSERT reached it: the same 400 as naming
      // a deleted one. Re-read rather than parsed out of the error, so a P2003 about any other key
      // this INSERT names is left saying what it was really about.
      if (
        folderId &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2003' &&
        (await this.prisma.sessionFolder.count({ where: { id: folderId } })) === 0
      ) {
        throw new BadRequestException('folderId must be a folder of this workspace');
      }
      throw e;
    });
    // Scope the compose-page uploads to this session now that it exists. They stay
    // turn-less until the runner seeds the first turn (queue.service links them to it),
    // and cascade-delete with the session.
    if (attachmentIds.length > 0) {
      await this.prisma.attachment.updateMany({
        // `taskId: null` for the same reason the validator carries it, but here it is the
        // CONCURRENT case: an upload that became a task's input between that check and this write
        // is skipped, leaving it as the task's, rather than raising 0241's CHECK mid-create.
        where: { id: { in: attachmentIds }, sessionId: null, turnId: null, taskId: null },
        data: { sessionId: session.id },
      });
    }
    // A shell-first session (composed from a `!cmd` draft): seed its first turn as a 'shell'
    // turn now, using the SAME fixed clientTurnId the claim uses, so buildSession sees a turn
    // already exists and skips its default message seed. The command runs on the runner and
    // is never fed to claude as a prompt; claude still spawns (with --session-id) and idles.
    if (dto.shell) {
      await this.insertTurn(session.id, {
        kind: 'shell',
        content: dto.prompt,
        clientTurnId: SessionsService.initialTurnClientId(session.id),
      });
    }
    // Opened with attachments alone: seed its first turn now too. The claim reads an empty prompt
    // as an imported transcript's and lays no turn down, so without this the files would never
    // reach the engine.
    if (attachmentsAlone) await this.seedOpeningTurn(session);
    this.queue.notifySessionQueued();
    // Push the new session to the owner's control-plane stream (GET /api/events) so other
    // clients see it appear without polling.
    this.realtime.publishSessionCreated(session.id);
    // A session a person started *is* the project's new provider default — the derivation reads
    // exactly these rows (workspaces/workspace-provider.ts) — so every client's cached workspace payload just
    // went stale. Nothing else announced that: `session.created` refreshes session lists, not the
    // workspace list, so a native client kept seeding New Session from whatever ran before until the
    // app was relaunched. Web only hid the bug by refetching workspaces on window focus.
    // Gated on the same rows the derivation reads, so a task run or a workspace-spawned child — which
    // deliberately cannot move the default — doesn't wake every client for nothing.
    if (session.workspaceId && !session.taskId && !session.parentSessionId) {
      // The workspace's provider-default display changed, but no Task row did. Keeping this
      // explicit prevents an ordinary New Session from triggering a full task-list refresh.
      this.realtime.publishWorkspaceChanged(session.id, session.workspaceId, false);
    }
    // Only unnamed sessions need cosmetic naming. Task runs and user-supplied titles never call
    // DeepSeek, and neither does a session with no words to read — its file names stand.
    // The branch is deliberately left as-is when the display title is later improved.
    if (!hasExplicitTitle && !attachmentsAlone) {
      void this.beautifySessionLater(ownerId, session.id, dto.prompt, title);
    }
    // Title ownership/provenance is an internal synchronization mechanism, not a public setting.
    const {
      titleManagedByProject: _titleManagedByProject,
      titleBeforeProjectManagement: _titleBeforeProjectManagement,
      ...publicSession
    } = session;
    return withSessionState(publicSession);
  }

  /** pg_advisory_xact_lock namespace for the import-claim serializer (see importSession). */
  private static readonly IMPORT_LOCK_NAMESPACE = 4000274;

  private static readonly CLAUDE_SESSION_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Create a session by importing a local Claude Code transcript.
   *
   * The row is written PENDING with `runtimeSessionId` = the Claude session id and a non-null
   * `importSourceCwd` (the transcript's original cwd, or the workspace workDir for the web path,
   * where the runner locates the file itself). The runner then, inside one claim: copies the
   * transcript into the session's `~/.claude/projects/<slug>/` directory, replays it as run
   * events so Orbit can read and search the conversation, and clears the marker (or Trashes the
   * session) via POST /runner/sessions/:id/import-result — and spawns no engine, because an
   * import has no user turn behind it to run. The session parks at AWAITING_INPUT, and the
   * engine starts on the first message, resuming the transcript placed here.
   *
   * `importedAt` is written in the same row and is what carries that: it is the durable record
   * that this session's conversation already exists on disk, which is what the claim's `resume`
   * answer reads, and what keeps the opening-prompt seeders off a session whose prompt is empty
   * by construction.
   */
  async importSession(
    ownerId: string,
    dto: {
      /** The Claude Code session id whose `<uuid>.jsonl` transcript to import. */
      claudeSessionId: string;
      /** The transcript's recorded cwd, when the caller has it (CLI path). */
      sourceCwd?: string;
      workspaceId?: string;
      title?: string;
    },
    opts?: {
      /** The runner that called this import (CLI door) — the transcript lives on its disk. */
      assignedRunnerId?: string;
    },
  ) {
    if (!SessionsService.CLAUDE_SESSION_ID_RE.test(dto.claudeSessionId)) {
      throw new BadRequestException('claudeSessionId must be a UUID');
    }
    let workspace: {
      id: string;
      name: string;
      workDir: string | null;
      runnerId: string | null;
      enableWorktree: boolean;
      enabled: boolean;
    } | null;
    if (dto.workspaceId) {
      workspace = await this.prisma.workspace.findFirst({
        where: { id: dto.workspaceId, ownerId, deletedAt: null },
        select: { id: true, name: true, workDir: true, runnerId: true, enableWorktree: true, enabled: true },
      });
      if (!workspace) throw new ForbiddenException('workspace not found');
      if (workspace.enabled === false) throw new ForbiddenException('workspace is disabled');
    } else {
      // No explicit pick: the transcript's cwd names its workspace. Longest workDir prefix wins,
      // so a project nested inside another binds the transcript to the tighter one.
      const cwd = dto.sourceCwd;
      if (!cwd) throw new BadRequestException('pick a workspace or pass the transcript cwd');
      const candidates = await this.prisma.workspace.findMany({
        where: { ownerId, deletedAt: null },
        select: { id: true, name: true, workDir: true, runnerId: true, enableWorktree: true, enabled: true },
      });
      workspace = candidates
        .map((c) => ({ c, matched: c.workDir === null ? -1 : workDirPrefixLength(c.workDir, cwd) }))
        .filter((s) => s.matched >= 0)
        .sort((a, b) => b.matched - a.matched)[0]?.c;
      if (!workspace) {
        throw new BadRequestException(
          `no workspace of yours contains the transcript's cwd ${cwd}; pass --workspace to pick one`,
        );
      }
      if (workspace.enabled === false) throw new ForbiddenException('workspace is disabled');
    }
    if (!workspace.workDir) throw new BadRequestException('the workspace has no work directory');
    if (dto.sourceCwd) {
      // Rejection ②, checked at create so the caller never waits for a runner to refuse it: the
      // resumed engine runs in this workspace, so a transcript recorded elsewhere would carry
      // paths that mean nothing here.
      if (workDirPrefixLength(workspace.workDir, dto.sourceCwd) < 0) {
        throw new BadRequestException(
          `the transcript's cwd ${dto.sourceCwd} is not inside workspace ${workspace.name} (${workspace.workDir})`,
        );
      }
    }
    const assignedRunnerId = opts?.assignedRunnerId ?? workspace.runnerId ?? undefined;
    if (!assignedRunnerId) {
      throw new BadRequestException('pick a workspace bound to a runner, or pass assignedRunnerId');
    }
    const accountPermissionMode = accountDefaultPermissionMode(
      await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { preferences: true },
      }),
    );
    const accountEffort = await this.resolveDefaultEffort(ownerId, dto.workspaceId);
    const title = dto.title ?? `Imported session ${dto.claudeSessionId.slice(0, 8)}`;
    const enableWorktree = workspace.enableWorktree;
    const branch = enableWorktree ? makeBranchName(title) : null;
    const sourceCwd = dto.sourceCwd ?? workspace.workDir;
    // The lock key is a hash of the Claude session id, so two concurrent imports of the same
    // transcript serialize and the second one sees the first's row. Namespace is a constant
    // distinct from the claim serializer's, so imports never queue behind claims.
    const lockKey = parseInt(createHash('sha256').update(dto.claudeSessionId).digest('hex').slice(0, 8), 16) & 0x7fffffff;
    const session = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SessionsService.IMPORT_LOCK_NAMESPACE}, ${lockKey})`;
        // Rejection ③: a Claude transcript can be imported once — the imported session IS the
        // continuation of it. A Trashed one does not count: deleting the import frees the id.
        // Once per account: a session of another account with this engine id is not this
        // account's to be told about — not that it exists, nor its id or title — nor in its way.
        const claimed = await tx.session.findFirst({
          where: { ownerId, runtimeSessionId: dto.claudeSessionId, deletedAt: null },
          select: { id: true, title: true },
        });
        if (claimed) {
          throw new ConflictException(
            `this Claude session is already imported as Orbit session ${claimed.id} ("${claimed.title}")`,
          );
        }
        return tx.session.create({
          data: {
            title,
            branch,
            prompt: '',
            status: RunStatus.PENDING,
            provider: AgentProvider.CLAUDE,
            providerBuiltin: true,
            // The Claude session id is pre-generated FOR us, by claude, when the transcript was
            // recorded; the runner resumes it instead of minting one.
            runtimeSessionId: dto.claudeSessionId,
            // Non-null = import PENDING: the runner performs the import step and clears this.
            importSourceCwd: sourceCwd,
            // Durable provenance, unlike the marker above: this is never cleared, so "remove the
            // conversations this directory's history brought in" still has something to select on
            // long after every replay has landed.
            importedAt: new Date(),
            // No model pin: the claim resolves the runner's Runtime default, as a fresh session
            // without an explicit pick does.
            model: null,
            usesRuntimeDefaultModel: true,
            // Left honest at 0: no turn has run here, and none can until the first message (an
            // import settles no turn, and the claim it arrives on spawns no engine). The
            // `--resume` this session's spawn needs comes from `importedAt` instead — the durable
            // statement that its conversation already exists on disk (queue.buildSession).
            numTurns: 0,
            permissionMode: accountPermissionMode,
            effort: normalizeEffortForProvider(AgentProvider.CLAUDE, accountEffort),
            workspaceId: workspace.id,
            assignedRunnerId,
            creatorId: ownerId,
            ownerId,
          },
        });
      },
      loggedRetry(this.logger, 'session.import'),
    );
    this.queue.notifySessionQueued();
    this.realtime.publishSessionCreated(session.id);
    return withSessionState(session);
  }

  /**
   * Import several of one directory's transcripts at once — the batch behind "this directory
   * already has Claude Code history in it" on the new-workspace form.
   *
   * A wrapper, not a second import: every transcript goes through `importSession` above, so each
   * refusal it states (already imported, no real conversation, recorded somewhere this workspace
   * does not contain) reads the same whether one arrived or two hundred did.
   *
   * Per-item refusals are collected rather than thrown. Consent here was given for a directory's
   * history as a whole, and the most ordinary case in a directory somebody has been working in is
   * that one conversation was already imported last week — failing the batch over it would break
   * the offer exactly where it is most useful. What IS thrown is a refusal about the request
   * itself: a workspace that is not the caller's must not arrive as N per-item failures that read
   * as though the transcripts were the problem.
   *
   * Nothing here waits for a transcript to be read. Each import is one row the runner claims and
   * replays on its own schedule, so this returns as soon as the rows exist — which is what lets
   * the workspace be usable the moment it is created, however much history was accepted.
   */
  async importBatch(
    ownerId: string,
    dto: {
      workspaceId: string;
      transcripts: Array<{ claudeSessionId: string; title?: string }>;
    },
  ) {
    const items = dto?.transcripts ?? [];
    if (!dto?.workspaceId) throw new BadRequestException('pick a workspace to import into');
    if (items.length === 0) throw new BadRequestException('nothing to import');
    if (items.length > CLAUDE_HISTORY_MAX_TRANSCRIPTS) {
      throw new BadRequestException(
        `at most ${CLAUDE_HISTORY_MAX_TRANSCRIPTS} transcripts at a time — that is what one scan reports`,
      );
    }
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: dto.workspaceId, ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new ForbiddenException('workspace not found');
    const sessionIds: string[] = [];
    const skipped: Array<{ claudeSessionId: string; reason: string }> = [];
    for (const item of items) {
      try {
        const session = await this.importSession(ownerId, {
          claudeSessionId: item?.claudeSessionId,
          workspaceId: dto.workspaceId,
          // The name the conversation already carries on disk, so the list reads as the work the
          // user remembers instead of two hundred rows of "Imported session 4e453ab7". The runner
          // rewrites it from the transcript itself once the replay lands, either way.
          title: item?.title,
        });
        sessionIds.push(session.id);
      } catch (err) {
        skipped.push({
          claudeSessionId: item?.claudeSessionId,
          reason: err instanceof Error ? err.message : 'import refused',
        });
      }
    }
    return { imported: sessionIds.length, skipped, sessionIds };
  }

  /** How many of a workspace's live sessions came in as imported transcripts — what the offer to
   *  remove them again has to be able to say out loud before anyone presses it. */
  async countImported(ownerId: string, workspaceId: string) {
    if (!workspaceId) throw new BadRequestException('workspaceId is required');
    const count = await this.prisma.session.count({
      where: { ownerId, workspaceId, importedAt: { not: null }, deletedAt: null },
    });
    return { count };
  }

  /**
   * Remove every session a directory's history brought into one workspace.
   *
   * The other half of what the import offer promises. Consent was given for a whole directory's
   * history at once — nobody chose two hundred conversations one by one — so withdrawing it has to
   * work at the same granularity, or the warning that they "can be removed later" is a sentence
   * nobody can act on.
   *
   * Each one goes through `remove` above rather than a bulk UPDATE: an imported session is a
   * session, and it has to leave by the same door as any other, with the same end transition and
   * the same notification to whoever is watching it. One that ends or is deleted concurrently is
   * already where this was taking it, so it is counted as gone rather than failing the sweep.
   */
  async removeImported(ownerId: string, workspaceId: string) {
    if (!workspaceId) throw new BadRequestException('workspaceId is required');
    const sessions = await this.prisma.session.findMany({
      where: { ownerId, workspaceId, importedAt: { not: null }, deletedAt: null },
      select: { id: true },
    });
    let removed = 0;
    for (const session of sessions) {
      try {
        await this.remove(ownerId, session.id);
        removed++;
      } catch (err) {
        this.logger.warn(
          `removeImported: leaving ${session.id} — ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return { removed, requested: sessions.length };
  }

  /**
   * Background naming for a session that started with a prompt-derived title: a cleaner display
   * title, plus a couple of semantic tags to file it under. The shared bounded queue prevents a
   * create burst from fan-out calling DeepSeek. Swap the title only while it is still the exact
   * fallback we wrote, so a user rename (or any concurrent change) is never clobbered. Re-publishes
   * the session so live clients pick up both. Fire-and-forget: never awaited, swallows all errors.
   */
  private async beautifySessionLater(
    ownerId: string,
    sessionId: string,
    prompt: string,
    fallbackTitle: string,
  ): Promise<void> {
    try {
      // The owner's own vocabulary, offered to the model as reuse candidates. System tags are
      // colors ("Red"), not semantics, so they are never candidates and are never auto-applied.
      const known = await this.prisma.sessionTag.findMany({
        where: { ownerId, isSystem: false },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
        take: MAX_KNOWN_TAGS_PROMPTED,
      });
      const { title, tags } = await enqueueBeautifySession({
        prompt,
        knownTags: known.map((t) => t.name),
      });
      let changed = false;
      if (title && title !== fallbackTitle) {
        const res = await this.prisma.session.updateMany({
          where: { id: sessionId, title: fallbackTitle, titleManagedByProject: false },
          data: { title },
        });
        changed = res.count > 0;
      }
      if (tags.length > 0 && (await this.applyAutoTags(ownerId, sessionId, tags, known))) {
        changed = true;
      }
      if (changed) this.realtime.publishSessionUpdated(sessionId);
    } catch {
      // best-effort; the raw fallback title simply stays
    }
  }

  /**
   * File a freshly created session under the model's labels, minting the ones this owner doesn't
   * have yet. Returns whether anything was linked.
   *
   * `known` is the candidate list from before the call, so a name the model echoed back maps to
   * the row it came from — matched case-insensitively, because "Login" and "login" are one tag to
   * a person but two rows under the (owner, name) unique, and a filter split across both finds
   * neither half.
   */
  private async applyAutoTags(
    ownerId: string,
    sessionId: string,
    names: string[],
    known: { id: string; name: string }[],
  ): Promise<boolean> {
    // Never argue with a person. Tagging by hand while DeepSeek was still in flight is a decision;
    // this is a guess. Same compare-and-set spirit as the title swap above.
    if ((await this.prisma.sessionTagLink.count({ where: { sessionId } })) > 0) return false;
    const byName = new Map(known.map((t) => [t.name.toLowerCase(), t.id]));
    const tagIds = names.map((name) => byName.get(name.toLowerCase())).filter((id): id is string => !!id);
    const fresh = names.filter((name) => !byName.has(name.toLowerCase()));
    // `known` was itself capped at MAX_KNOWN_TAGS_PROMPTED, so a short list *is* the proof that
    // the library is still under the ceiling — no second count. At the ceiling the session still
    // gets tagged, just only with labels that already exist: an unbounded auto-grown library is a
    // wall of one-session tags, which is no filter at all.
    const room = MAX_KNOWN_TAGS_PROMPTED - known.length;
    if (fresh.length > 0 && room > 0) {
      tagIds.push(...(await this.createAutoTags(ownerId, fresh.slice(0, room))));
    }
    if (tagIds.length === 0) return false;
    await this.prisma.sessionTagLink.createMany({
      data: tagIds.map((tagId) => ({ sessionId, tagId })),
      skipDuplicates: true,
    });
    return true;
  }

  /**
   * Create tags for this owner and return their ids. Positions continue after the system block
   * (which may not be seeded yet — it is written lazily on first list) and pick a palette color by
   * position. Two sessions naming the same new tag at once is a race the (owner, name) unique
   * settles: `skipDuplicates` lets the loser adopt the winner's row instead of failing the pass,
   * which is why the ids are read back by name rather than taken from the create.
   */
  private async createAutoTags(ownerId: string, names: string[]): Promise<string[]> {
    const agg = await this.prisma.sessionTag.aggregate({
      where: { ownerId },
      _max: { position: true },
    });
    const start = (agg._max.position ?? SESSION_TAG_PALETTE.length - 1) + 1;
    await this.prisma.sessionTag.createMany({
      data: names.map((name, i) => ({
        name,
        ownerId,
        isSystem: false,
        color: SESSION_TAG_PALETTE[(start + i) % SESSION_TAG_PALETTE.length],
        position: start + i,
      })),
      skipDuplicates: true,
    });
    const rows = await this.prisma.sessionTag.findMany({
      where: { ownerId, name: { in: names } },
      select: { id: true },
    });
    // The tag library is user-scoped and nothing polls it: without this push the new tag exists
    // but is missing from every open filter and picker until a reload. Clients refetch the whole
    // library on any tag event, so one publish covers the batch.
    if (rows.length > 0) this.realtime.publishForUser(ownerId, RunEventType.TAG_CHANGED, rows[0].id);
    return rows.map((r) => r.id);
  }

  // ── L3 orchestration: an in-session workspace spawning/managing OTHER sessions ──
  // The runner-token session_* tools are the only callers. Resource containment is
  // SPAWN_TREE_OUTSTANDING (how much unfinished work a tree may hold) and the tree
  // concurrency cap (how fast it drains) — both counted on the tree, both self-releasing.
  //
  // Depth is not one of those. It bounded resources only by proxy, and a bad one: a
  // 5-deep tree of three sessions costs nothing, while a 1-deep fan-out of five hundred
  // costs everything, so measuring depth penalised decomposition and waved through the
  // shape that actually hurts. What depth genuinely bounds is *context fidelity*.
  // session_create hands the child a self-contained brief and no prior context, so every
  // level is one more lossy re-encoding of the original intent by an LLM — a telephone
  // game whose error compounds with each hop. Five is where a brief stops resembling what
  // the user asked for, not where the machine runs out of room.
  //
  // Read from the row (spawn_depth), so a corrupt or cyclic parent chain cannot be walked
  // into — the reason the old bounded walk existed, and why it could never report a depth
  // past the cap it was guarding with.
  private static readonly MAX_SPAWN_DEPTH = 5;

  /** Rolling window for {@link SPAWN_TREE_RATE}. */
  private static readonly SPAWN_RATE_WINDOW_MS = 60 * 60_000;
  /**
   * How many sessions one tree may start per hour.
   *
   * The outstanding cap bounds how *large* a tree gets; this bounds how *fast* it churns.
   * They catch different failures. A loop in workspace space — A spawns B, B messages A back
   * with session_send, A spawns again — never trips the outstanding cap if each child
   * finishes quickly, and never trips the depth guard at all because it stays one level
   * deep. It just burns tokens forever. Depth was supposed to prevent recursion and cannot
   * see this shape; a rate can.
   *
   * Far above deliberate use: a dispatcher spawning one child per incoming human message
   * lives in the single digits per hour.
   */
  private static readonly SPAWN_TREE_RATE = 60;

  /**
   * Spawn a child session from a parent session's workspace (orbit mcp `session_create`). The
   * parent's workspace must have orchestration enabled; the child is attributed to the parent
   * (parentSessionId) and joins the parent's spawn tree so fan-out stays concurrency-capped.
   * Enforces the depth guard. Returns a compact handle to poll via get().
   */
  async spawnFromSession(
    ownerId: string,
    parentSessionId: string,
    dto: {
      prompt: string;
      workspaceId?: string;
      workspaceName?: string;
      /** @deprecated Pre-rename names, still sent by `orbit mcp` and every shipped runner. */
      agentId?: string;
      agentName?: string;
      title?: string;
      model?: string;
      provider?: string;
      /** The child's own permission posture. Omitted, create() materializes the account default —
       *  the spawn does NOT inherit the parent's mode, which is per-run and not per-tree. */
      permissionMode?: string;
    },
  ): Promise<{
    id: string;
    status: RunStatus;
    runStatus: RunStatus;
    sessionState: SessionState;
    runState: SessionRunState;
    lifecycleState: SessionLifecycleState;
    /** @deprecated Compatibility representation of lifecycleState. */
    filingState: SessionFilingState;
    title: string;
    /** Wire name kept: `orbit mcp` renders this straight back to the calling model. */
    agentName: string | null;
    provider: string;
  }> {
    if (!dto.prompt) throw new BadRequestException('prompt is required');
    assertKnownPermissionMode(dto.permissionMode);
    const parent = await this.prisma.session.findFirst({
      where: { id: parentSessionId, ownerId },
      select: {
        id: true,
        rootSessionId: true,
        spawnDepth: true,
        workspaceId: true,
        owner: { select: { preferences: true } },
      },
    });
    if (!parent) throw new NotFoundException('parent session not found');
    if (!parent.workspaceId || !orchestrationEnabled(parent.owner)) {
      throw new ForbiddenException('orchestration is not enabled for this account');
    }
    if (parent.spawnDepth >= SessionsService.MAX_SPAWN_DEPTH) {
      throw new ForbiddenException(`spawn depth limit (${SessionsService.MAX_SPAWN_DEPTH}) reached`);
    }
    // The whole tree shares one id — rooted at the session it grew from — so the claim queue
    // caps how many of it run concurrently, on top of the runner's own max_concurrent. Per
    // parent instead would multiply level by level (3 -> 9 -> 27) and be sidestepped by
    // inserting another intermediate session.
    const rootSessionId = parent.rootSessionId ?? parentSessionId;
    // Admission control, separate from the tree's concurrency cap: that one paces how fast the
    // tree drains, this one refuses to let it grow further. The refusal is the point — it is
    // the only backpressure the calling workspace ever sees. Queuing silently instead would leave
    // it believing the work was dispatched while the backlog grows without bound.
    //
    // Unsettled, not open: a child parked at AWAITING_INPUT has already handed back its result
    // (that is precisely when session_create(wait) returns), and it parks there indefinitely.
    // Charging for it would make this quota monotonic and wedge the tree for good.
    const outstanding = await this.prisma.session.count({
      where: { rootSessionId, status: { in: UNSETTLED_SESSION_STATUSES } },
    });
    if (outstanding >= SPAWN_TREE_OUTSTANDING) {
      throw new HttpException(
        `this run already has ${outstanding} unfinished sessions (limit ${SPAWN_TREE_OUTSTANDING}); ` +
          `wait for some to finish before starting more`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // And how fast it may churn. A tree whose children finish quickly can stay far under the
    // outstanding cap while spawning forever — the shape a session_send loop back to the
    // parent produces, which no depth guard can see because it never gets deeper than one.
    const startedThisHour = await this.prisma.session.count({
      where: {
        rootSessionId,
        createdAt: { gt: new Date(Date.now() - SessionsService.SPAWN_RATE_WINDOW_MS) },
      },
    });
    if (startedThisHour >= SessionsService.SPAWN_TREE_RATE) {
      throw new HttpException(
        `this run has started ${startedThisHour} sessions in the past hour ` +
          `(limit ${SessionsService.SPAWN_TREE_RATE}); it is looping rather than making progress`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // A root joins its own tree the first time it spawns; before that it belongs to no tree
    // and must not be counted against one. Nothing else writes this column on the parent, so
    // an unconditional write of the same value is idempotent under concurrent spawns.
    if (!parent.rootSessionId) {
      await this.prisma.session.update({
        where: { id: parentSessionId },
        data: { rootSessionId },
      });
    }
    // Resolve an @-mentioned workspace name to its id (owner-scoped). An explicit workspaceId wins.
    const wantId = dto.workspaceId ?? dto.agentId;
    const wantName = dto.workspaceName ?? dto.agentName;
    const workspaceId =
      wantId ?? (wantName ? await this.resolveWorkspaceByName(ownerId, wantName) : undefined);
    // Give the child a real effort like a normal new session would (the target workspace's own
    // effort, else the owner's account default). create() normalizes it for the selected runtime
    // model. Without this the child's effort is empty, so a codex child falls back to the
    // runner's codex config default — which can be invalid for its model → 400 on the first turn.
    const effort = await this.resolveDefaultEffort(ownerId, workspaceId);
    const created = await this.create(
      ownerId,
      // An explicit provider is the child's binding; create() checks the caller can dispatch it.
      // Omitted, the child starts where the target project last started.
      {
        prompt: dto.prompt,
        title: dto.title,
        workspaceId,
        model: dto.model,
        provider: dto.provider,
        permissionMode: dto.permissionMode,
        effort,
      },
      {
        // Orchestrated children appear in Open like any other session; the
        // parentSessionId link is what marks them as spawned/orchestrated.
        parentSessionId,
        tree: { rootSessionId, depth: parent.spawnDepth + 1 },
      },
    );
    // Surface the target workspace's name + provider so the web/native transcript can render a
    // rich "session created" card (title · workspace · provider) that links to the child.
    const targetWorkspace = created.workspaceId
      ? await this.prisma.workspace.findFirst({ where: { id: created.workspaceId }, select: { name: true } })
      : null;
    return {
      id: created.id,
      status: created.status,
      runStatus: created.runStatus,
      sessionState: created.sessionState,
      runState: created.runState,
      lifecycleState: created.lifecycleState,
      filingState: created.filingState,
      title: created.title,
      agentName: targetWorkspace?.name ?? null,
      provider: created.provider,
    };
  }

  /** The effort a normal new session under this workspace would inherit: the workspace's own effort if
   *  set, else the owner's account default (UserPreferences.defaultEffort). create() normalizes
   *  it per provider. Returns undefined only when neither is set. */
  private async resolveDefaultEffort(ownerId: string, workspaceId?: string): Promise<string | undefined> {
    if (workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: workspaceId, ownerId, deletedAt: null },
        select: { effort: true },
      });
      // Empty is an explicit "use this model's default" choice, not a missing value.
      if (workspace && workspace.effort !== null) return workspace.effort;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { preferences: true },
    });
    const prefs = (user?.preferences ?? {}) as { defaultEffort?: string };
    return prefs.defaultEffort || undefined;
  }

  /** Resolve an @-mentioned workspace name to its id within the owner. Throws on no/ambiguous match. */
  private async resolveWorkspaceByName(ownerId: string, name: string): Promise<string> {
    const matches = await this.prisma.workspace.findMany({
      where: { ownerId, name, deletedAt: null },
      select: { id: true },
      take: 2,
    });
    if (matches.length === 0) throw new BadRequestException(`no workspace named "${name}"`);
    if (matches.length > 1) throw new BadRequestException(`multiple workspaces named "${name}"; use workspaceId`);
    return matches[0].id;
  }

  /**
   * Headless callers (a launchd/cron bridge) authenticate with no session context: there is no
   * calling session to bind a signed credential to. Their reach is therefore capped at the
   * sessions that runner already hosts — it receives their prompts and streams their output, so
   * observing or messaging one grants no authority the machine did not already have. Sessions on
   * any other runner stay invisible. A service token may narrow this further to a single workspace.
   */
  async assertHostedByRunner(ownerId: string, scope: RunnerSessionScope, id: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId, deletedAt: null, ...runnerScopeWhere(scope) },
      select: { id: true },
    });
    // 404 rather than 403: a session hosted on another machine must not be distinguishable
    // from one that does not exist.
    if (!session) throw new NotFoundException('session not found');
  }

  /**
   * Start a session for a headless caller holding a session:create service token. Unlike
   * spawnFromSession there is no parent to inherit from, so the workspace pin on the token is the
   * whole authorization: the workspace must live on the runner the token was minted for.
   *
   * Every session one token starts shares a batch keyed on that token, so a bridge stuck in a
   * loop queues behind itself instead of flooding the machine — the same bound spawned children
   * get, applied to the credential rather than to a parent session.
   */
  async spawnForServiceToken(
    ownerId: string,
    scope: { assignedRunnerId: string; workspaceId: string; tokenId: string },
    dto: { prompt: string; title?: string; model?: string; provider?: string; permissionMode?: string },
  ) {
    if (!dto.prompt) throw new BadRequestException('prompt is required');
    assertKnownPermissionMode(dto.permissionMode);
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: scope.workspaceId,
        ownerId,
        runnerId: scope.assignedRunnerId,
        deletedAt: null,
        enabled: true,
      },
      select: { id: true, name: true },
    });
    if (!workspace) throw new NotFoundException('workspace not found on this runner');
    const effort = await this.resolveDefaultEffort(ownerId, workspace.id);
    const created = await this.create(
      ownerId,
      // As with spawnFromSession: an explicit provider is the session's binding and create() checks
      // the caller can dispatch it, refusing one it cannot rather than starting on the default.
      {
        prompt: dto.prompt,
        title: dto.title,
        workspaceId: workspace.id,
        model: dto.model,
        provider: dto.provider,
        permissionMode: dto.permissionMode,
        effort,
      },
      { batch: { id: scope.tokenId, maxConcurrent: SERVICE_TOKEN_CONCURRENCY } },
    );
    return {
      id: created.id,
      status: created.status,
      runStatus: created.runStatus,
      sessionState: created.sessionState,
      runState: created.runState,
      lifecycleState: created.lifecycleState,
      filingState: created.filingState,
      title: created.title,
      agentName: workspace.name,
      provider: created.provider,
    };
  }

  /** Owner-scoped session list for orchestration (orbit mcp `session_list`): compact rows with
   *  optional status / parent filter. Distinct from the UI `list` below (view tabs, previews).
   *  `scope` narrows the list to one runner's (optionally one workspace's) sessions for headless
   *  callers. */
  async listForOrchestration(
    ownerId: string,
    filters: { status?: RunStatus; parentSessionId?: string; scope?: RunnerSessionScope },
  ) {
    const sessions = await this.prisma.session.findMany({
      where: {
        ownerId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.parentSessionId ? { parentSessionId: filters.parentSessionId } : {}),
        ...runnerScopeWhere(filters.scope),
      },
      select: {
        id: true,
        title: true,
        status: true,
        endReason: true,
        completedAt: true,
        archivedAt: true,
        deletedAt: true,
        workspaceId: true,
        parentSessionId: true,
        lastAssistantText: true,
        lastTurnAt: true,
        createdAt: true,
        // Who opened this conversation, as opposed to who owns it. USER is a person (every door a
        // client can press lands here), PROJECT_COORDINATOR is a project's one-shot judgment
        // session opened by a committed fact (`CoordinatorJudgmentService`), LEGACY_SWEEP is the
        // pre-0122 default. An orchestrating caller listing a project's sessions cannot otherwise
        // tell the coordinator conversation a person is in from a judgment that woke beside it —
        // they share an owner, a workspace and often a title stem.
        dispatchOrigin: true,
      },
      orderBy: [{ lastTurnAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return sessions.map((session) => withSessionState(session));
  }

  /**
   * Owner-scoped detail returned to an orchestrating workspace. Keep this deliberately
   * narrower than the UI detail query: the full Workspace row contains injected env,
   * MCP config, prompts, and other configuration that must not become model output.
   * `scope` narrows it to one runner's (optionally one workspace's) sessions for headless callers.
   */
  async getForOrchestration(ownerId: string, id: string, scope?: RunnerSessionScope) {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId, ...runnerScopeWhere(scope) },
      select: {
        id: true,
        title: true,
        prompt: true,
        status: true,
        completedAt: true,
        archivedAt: true,
        deletedAt: true,
        provider: true,
        model: true,
        effort: true,
        workspaceId: true,
        parentSessionId: true,
        taskId: true,
        assignedRunnerId: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        lastTurnAt: true,
        numTurns: true,
        costUsd: true,
        // How full the context window is right now (see Session.contextTokens). A headless caller
        // driving a long-lived session rotates it before it reaches the window, and turn count is
        // a poor stand-in: one turn returning a large tool_result moves this further than a
        // hundred short ones. The window ships with it because the fraction is what the caller
        // actually wants, and it is the half no reader can derive on its own.
        contextTokens: true,
        contextWindow: true,
        lastAssistantText: true,
        lastUserText: true,
        lastToolUse: true,
        result: true,
        error: true,
        endReason: true,
        // When a self-healing failure — a spent quota, a provider that was overloaded — is due to
        // be re-sent, and how many attempts it has already cost. The moment is the same one the
        // sweeper acts on, so a caller that schedules its own work around this session backs off
        // to a time Orbit already computed rather than parsing it back out of `error`.
        retryAt: true,
        retryAttempts: true,
        branch: true,
        changedFiles: true,
        isolationStatus: true,
        mergeStatus: true,
        mergeError: true,
        mergeTarget: true,
        mergedAt: true,
        branchMerged: true,
        worktreeBranch: true,
        workspace: { select: { id: true, name: true, model: true } },
        assignedRunner: { select: { id: true, name: true } },
      },
    });
    if (!session) throw new NotFoundException('session not found');
    return withSessionState(session);
  }

  /**
   * Cross-scope session search backing the clients' ⌘K palette.
   *
   * Distinct from `list` above in two ways that matter: it spans EVERY scope at once (Open,
   * Completed and Trash — "the one I'm thinking of" is usually filed away, and the hit
   * carries completedAt/deletedAt so the row can say where it lives), and it reaches into
   * conversation text, which no list payload ever carries.
   *
   * Three tiers:
   *  - id — a full UUID or Base62 public id matched exactly, or an 8–12 hex UUID prefix.
   *  - metadata — title / prompt / last reply / branch on the session row, plus the joined workspace
   *    and task names. Trigram-indexed (migration 0068) and runs for any query length.
   *  - conversation text — the durable `user` + `assistant` events. Gated on CONTENT_MIN_CHARS;
   *    see search-query.ts for why that floor is the index's, not a product decision.
   *
   * An empty query returns recents, so ⌘K doubles as a session switcher.
   *
   * Every tier searches the text with its markdown marks removed (see stripMarks), because what is
   * stored is markdown source and what the user is searching for is the line they read.
   *
   * Ordering is a score, not a tier ranking — see the `scored` CTE for why, and for the quota that
   * keeps the name tier from taking a page the palette has no way to scroll past. `total` reports
   * what the page left behind.
   */
  async search(ownerId: string, q: string | undefined, limit: number) {
    const take = Math.min(Math.max(limit || 20, 1), 50);
    // Both sides lose `*` and backticks, exactly as in-session find does: the corpus in SQL, the
    // query here. Stripping the query first also means a query of nothing but marks normalizes to
    // null and answers with recents, rather than matching every row.
    const norm = normalizeSearchQuery(stripEmphasis(q ?? ''));
    if (!norm) {
      const recents = await this.searchRows(ownerId, null, take);
      return { q: '', contentSearched: false, total: recents.total, hits: recents.hits };
    }
    const first = await this.searchRows(ownerId, norm, take);
    if (first.total > 0) {
      return { q: norm.raw, contentSearched: norm.searchContent, total: first.total, hits: first.hits };
    }
    // Nothing contains the phrase. Rather than answer "no results" for a query that only got a
    // word wrong, ask the broader question — see `broaden` for why this is a second query and not
    // the first one's WHERE clause. The palette's own debounce keeps this off most keystrokes.
    const wide = broaden(norm);
    if (!wide) {
      return { q: norm.raw, contentSearched: norm.searchContent, total: 0, hits: [] };
    }
    const { hits, total } = await this.searchRows(ownerId, wide, take);
    return { q: norm.raw, contentSearched: wide.searchContent, total, hits };
  }

  /**
   * The search query itself (and, with `norm === null`, the plain recents list that backs an empty
   * palette). Raw SQL for the same reason `list` is: the snippet window has to be cut in SQL —
   * a match can sit 5 KB into a prompt or a message, so neither `left()` nor a Prisma `select`
   * can produce it, and shipping whole message bodies to slice them in Node would defeat the
   * point of a fast palette.
   */
  private async searchRows(
    ownerId: string,
    norm: NormalizedSearchQuery | null,
    take: number,
  ): Promise<{ hits: SessionSearchHit[]; total: number }> {
    type Row = {
      id: string;
      title: string;
      status: RunStatus;
      workspaceId: string | null;
      workspaceName: string | null;
      runnerId: string | null;
      taskId: string | null;
      taskTitle: string | null;
      lastTurnAt: Date | null;
      createdAt: Date;
      completedAt: Date | null;
      archivedAt: Date | null;
      deletedAt: Date | null;
      endReason: string | null;
      matchField: SessionSearchHit['matchField'];
      snippet: string | null;
      /** Every session the query matched, before the tier quota and the LIMIT — the same window
       *  count in-session find already reports, repeated on every row. Absent on the recents
       *  branch, which isn't a search and whose total is just what it returned. */
      total?: number;
    };

    // "This text matches the query": one ILIKE against the phrase, or every term ANDed once the
    // query has been broadened (with a term's alternatives ORed — see SearchTerm). Every predicate
    // in this statement goes through here, so the tiers can never disagree about what a match is —
    // and each ILIKE stays its own indexable condition, which is what lets the planner BitmapAnd
    // them (measured 24ms for three words against 43ms for one, since ANDing narrows the candidate
    // set). Parenthesized because `retest` ORs the results together.
    const matches = (col: Prisma.Sql): Prisma.Sql =>
      Prisma.sql`(${Prisma.join(
        (norm?.patterns ?? [['']]).map(
          (term) =>
            Prisma.sql`(${Prisma.join(
              term.map((p) => Prisma.sql`${col} ILIKE ${p}`),
              ' OR ',
            )})`,
        ),
        ' AND ',
      )})`;

    // The conversation-text tier is composed in or out HERE, at SQL-build time, rather than being
    // gated by a `AND ${norm.searchContent}` bind parameter inside the query. A parameter can't be
    // folded away when the plan is prepared, so the sub-3-character case would still execute the
    // very scan the floor exists to prevent — the 533ms one.
    const authoredEventText = Prisma.sql`
      CASE WHEN e.type = 'user' AND ct.id IS NOT NULL
           THEN ct.content
           ELSE e.payload->>'text' END
    `;
    const contentCte =
      norm && norm.searchContent
        ? Prisma.sql`
            -- Stripped only AFTER the collapse to one row per session. The predicate below has to
            -- strip (that is what the index is built on, and every candidate row is rechecked
            -- against it), but the text carried out for the snippet does not: doing it here
            -- rebuilds a few hundred bodies instead of every matching message — 484ms against
            -- 566ms for a word matching 7.7k messages.
            SELECT session_id, ${stripMarks(Prisma.sql`raw_text`)} AS match_text
            FROM (
              -- One row per session: the most recent matching message. DISTINCT ON needs the
              -- leading ORDER BY key to be the grouping column, hence session_id then seq DESC.
              SELECT DISTINCT ON (e.session_id)
                e.session_id,
                ${authoredEventText} AS raw_text
              FROM run_event e
              -- Not merely a lookup: run_event has no owner column, so this join IS the
              -- authorization boundary for conversation text. Never drop it.
              JOIN session s ON s.id = e.session_id
              LEFT JOIN conversation_turn ct
                ON ct.id = e.turn_id AND ct.session_id = e.session_id
              WHERE s.owner_id = ${ownerId}::uuid
                AND e.type IN ('user', 'assistant')
                -- Keep the exact indexed expression as the cheap candidate filter. On an ordinary
                -- delivery it contains the authored user text. A reclaimed continuation can
                -- differ, so candidate coverage remains exactly what the pre-existing echo index
                -- could provide. This avoids turning every conversation search into a table scan.
                AND ${matches(stripMarks(Prisma.sql`e.payload->>'text'`))}
                -- Then reject hits that exist only in Orbit-appended delivery context. This join
                -- runs over indexed candidates rather than turning the whole event tier into an
                -- unindexed scan; snippets below are cut from this same authored expression.
                AND ${matches(stripMarks(authoredEventText))}
              ORDER BY e.session_id, e.seq DESC
            ) c
          `
        : Prisma.sql`SELECT NULL::uuid AS session_id, NULL::text AS match_text WHERE false`;

    // The columns a hit may be attributed to, in rank order — the single source the three places
    // that must agree are generated from: the match_field CASE, the match_text CASE, and the
    // re-test predicate. Written out three times by hand they drift, and the failure is quiet:
    // a field reported as the match with a snippet that doesn't contain the query.
    //
    // Below the floor the two long bodies drop out of the list entirely, so a short query can't
    // reach them through ANY branch (a session admitted by its workspace's name would otherwise still
    // be labelled 'prompt' and hand back a snippet cut from a 7 KB body).
    type Field = {
      field: SessionSearchHit['matchField'];
      /** What the fenced sub-select in `meta` projects for this field — evaluated once per row. */
      proj: Prisma.Sql;
      /** Reads that projection, never the underlying column. Same for `col`. */
      test: Prisma.Sql;
      col: Prisma.Sql;
    };
    /**
     * A text field: stripped once into `x.<field>`, then both matched and snippeted from there.
     * The predicate and the snippet source being one expression is also what keeps them agreeing —
     * strpos() looks for the stripped query, so a snippet cut from the raw column would miss and
     * hand back the head of a 7 KB body instead of the match.
     */
    const textField = (field: Field['field'], col: Prisma.Sql): Field => ({
      field,
      proj: Prisma.sql`${stripMarks(col)} AS ${Prisma.raw(`"${field}"`)}`,
      test: matches(Prisma.raw(`x."${field}"`)),
      col: Prisma.raw(`x."${field}"`),
    });
    const fields: Field[] = [
      // Base62 is decoded in normalizeSearchQuery; comparing the resulting UUID lets the primary
      // key resolve the exact child session without adding a database-side Base62 implementation.
      // Workspaces/logs also abbreviate UUIDs to their first 8–12 hex characters, handled by the
      // second predicate. An abbreviation's match text is the full UUID so a collision is visible.
      {
        field: 'id',
        proj: Prisma.sql`(
            s.id = ${norm?.sessionId ?? null}::uuid
            OR replace(s.id::text, '-', '') LIKE ${norm?.sessionIdPrefix ? `${norm.sessionIdPrefix}%` : null}
          ) AS "id_hit",
          CASE
            WHEN s.id = ${norm?.sessionId ?? null}::uuid THEN ${norm?.raw ?? ''}
            ELSE s.id::text
          END AS "id_text"`,
        test: Prisma.sql`x."id_hit"`,
        col: Prisma.sql`x."id_text"`,
      },
      textField('title', Prisma.sql`s.title`),
      ...(norm?.searchContent
        ? [
            textField('prompt', Prisma.sql`s.prompt`),
            textField('reply', Prisma.sql`s.last_assistant_text`),
          ]
        : []),
      textField('branch', Prisma.sql`s.branch`),
      textField('agent', Prisma.sql`a.name`),
      textField('task', Prisma.sql`t.title`),
    ];
    const matchFieldCase = Prisma.sql`CASE ${Prisma.join(
      fields.map((f) => Prisma.sql`WHEN ${f.test} THEN ${f.field}::text`),
      ' ',
    )} END`;
    const matchTextCase = Prisma.sql`CASE ${Prisma.join(
      fields.map((f) => Prisma.sql`WHEN ${f.test} THEN ${f.col}`),
      ' ',
    )} END`;
    const retest = Prisma.join(fields.map((f) => f.test), ' OR ');
    const projection = Prisma.join(fields.map((f) => f.proj), ',\n          ');

    // The session-side predicate, likewise chosen by the floor. Above it, the long bodies are in
    // play and the predicate is written against the exact expression session_search_trgm indexes.
    // Below it, that same expression would be a trap: the index can't answer a 2-character
    // pattern, so Postgres would build a multi-KB concatenation for all 1.3k rows and ILIKE it
    // (128ms) to return 512 mostly-meaningless hits. Matching the short name columns instead is
    // 4.4ms and returns 51 — see CONTENT_MIN_CHARS.
    const sessionPredicate = norm?.searchContent
      ? matches(
          stripMarks(Prisma.sql`
            coalesce(s.title, '') || ' ' ||
            coalesce(s.prompt, '') || ' ' ||
            coalesce(s.last_assistant_text, '') || ' ' ||
            coalesce(s.branch, '')
          `),
        )
      : Prisma.sql`(
          ${matches(stripMarks(Prisma.sql`s.title`))}
          OR ${matches(stripMarks(Prisma.sql`s.branch`))}
        )`;

    const rows = norm
      ? await this.prisma.$queryRaw<Row[]>(Prisma.sql`
          WITH meta_ids AS (
            -- An Orbit URL's Base62 id was decoded before this query. Keep this as an independent
            -- UNION branch so the exact match is a primary-key lookup and cannot disable the
            -- trigram plan used by the normal text branch below.
            SELECT s.id
            FROM session s
            WHERE s.owner_id = ${ownerId}::uuid
              AND s.id = ${norm.sessionId}::uuid
            UNION
            -- Workspaces and logs commonly shorten a UUID to its first 8–12 hex characters. At this
            -- scale an owner-scoped scan is cheap; if a prefix ever collides, return both rows so
            -- the caller can disambiguate instead of silently choosing the wrong child.
            SELECT s.id
            FROM session s
            WHERE s.owner_id = ${ownerId}::uuid
              AND replace(s.id::text, '-', '') LIKE ${
                norm.sessionIdPrefix ? `${norm.sessionIdPrefix}%` : null
              }
            UNION
            -- A UNION of independently index-usable branches, NOT one OR-chain. Written as
            -- "... OR a.name ILIKE ... OR t.title ILIKE ..." against the joined tables, the
            -- planner cannot use session_search_trgm at all and falls back to scanning every
            -- session row with six ILIKEs over multi-KB text — measured at 279ms versus 132ms
            -- for this shape on the same data, with the common-word case the worst hit.
            SELECT s.id
            FROM session s
            WHERE s.owner_id = ${ownerId}::uuid
              AND ${sessionPredicate}
            UNION
            -- Joined names resolve against their own tiny tables first (~10 workspaces, ~500 tasks),
            -- leaving the session side a cheap uuid comparison. Folding these into the session
            -- index instead would mean reindexing every session whenever a workspace is renamed.
            SELECT s.id FROM session s
            WHERE s.owner_id = ${ownerId}::uuid
              AND s.workspace_id IN (
                SELECT id FROM workspace WHERE ${matches(stripMarks(Prisma.sql`name`))}
              )
            UNION
            SELECT s.id FROM session s
            WHERE s.owner_id = ${ownerId}::uuid
              AND s.task_id IN (
                SELECT id FROM task WHERE ${matches(stripMarks(Prisma.sql`title`))}
              )
          ),
          meta AS (
            SELECT
              x.session_id,
              ${matchFieldCase} AS match_field,
              ${matchTextCase}  AS match_text
            FROM (
              SELECT
                s.id AS session_id,
                ${projection}
              FROM meta_ids mi
              JOIN session s ON s.id = mi.id
              LEFT JOIN workspace a ON a.id = s.workspace_id
              LEFT JOIN task  t ON t.id = s.task_id
              -- OFFSET 0 here is an optimization fence, not leftover paging: it stops the planner
              -- from flattening this sub-select into the CASEs above, which would re-run every
              -- strip once per branch it appears in — up to fifteen rebuilds of the same multi-KB
              -- body per row. Measured 346ms with the fence against 584ms without, for a word
              -- matching 2k sessions. Deleting it costs that silently.
              OFFSET 0
            ) x
            -- Concatenating the columns with a space invents adjacencies that don't exist: a
            -- query spanning the seam ("foo bar" where the title ends in "foo" and the prompt
            -- opens with "bar") matches the indexed expression while matching no actual field.
            -- Re-testing the columns individually drops those, and guarantees the CASEs above
            -- always find a branch — without it they'd fall through to NULL and produce a hit
            -- with no snippet. Runs only on rows the index already admitted.
            WHERE ${retest}
          ),
          content AS (
            ${contentCte}
          ),
          hit AS (
            SELECT
              COALESCE(m.session_id, c.session_id) AS session_id,
              COALESCE(m.match_field, 'message')   AS match_field,
              COALESCE(m.match_text, c.match_text) AS match_text
            FROM meta m
            FULL OUTER JOIN content c ON c.session_id = m.session_id
          ),
          scored AS (
            SELECT
              s.id, s.title, s.status,
              a.id   AS "workspaceId",
              a.name AS "workspaceName",
              s.assigned_runner_id AS "runnerId",
              s.task_id AS "taskId",
              t.title   AS "taskTitle",
              s.last_turn_at AS "lastTurnAt",
              s.created_at   AS "createdAt",
              COALESCE(s.completed_at, s.archived_at) AS "completedAt",
              COALESCE(s.completed_at, s.archived_at) AS "archivedAt",
              s.deleted_at   AS "deletedAt",
              s.end_reason   AS "endReason",
              h.match_field  AS "matchField",
              -- A ±60-character window around the first literal occurrence. strpos() is literal
              -- while ILIKE is not, which is exactly why the pattern escapes % and _ (see
              -- search-query.ts) — otherwise the two could disagree and strpos would return 0.
              -- greatest()/least() keep the window in range if they ever do disagree anyway.
              --
              -- On a broadened query the phrase is genuinely absent, which is the normal case
              -- rather than a disagreement: the window then follows the longest word, which every
              -- admitted row does contain.
              substr(
                h.match_text,
                greatest(
                  1,
                  coalesce(
                    nullif(strpos(lower(h.match_text), lower(${norm.raw})), 0),
                    strpos(lower(h.match_text), lower(${norm.anchor}))
                  ) - 60
                ),
                length(${norm.raw}) + 120
              ) AS "snippet",
              -- Which field matched, as a WEIGHT rather than a lexicographic bucket. Ordering by
              -- the bucket first gives the field infinite priority over recency, so a title hit
              -- from six months ago outranked a message hit from ten minutes ago; summing instead
              -- lets a recent conversation hit overtake a stale name hit while a fresh title hit
              -- still wins outright.
              --
              -- prompt/reply/message share one weight on purpose. They are not three degrees of
              -- relevance, they are one corpus stored in three places: prompt is the first user
              -- message and last_assistant_text is the last assistant one, both duplicated from
              -- run_event onto the session row. Ranking them apart said "message #1 outranks
              -- message #2", which is a fact about the schema and not about the search — and in
              -- practice let the long final summary of every session crowd out the real hits.
              (CASE h.match_field
                 WHEN 'id'    THEN 1000  -- an exact identity match is never not the answer
                 WHEN 'title' THEN 4     -- a short human-written label: the most match per character
                 WHEN 'prompt'  THEN 2
                 WHEN 'reply'   THEN 2
                 WHEN 'message' THEN 2
                 ELSE 1                  -- branch / agent / task: names of the container, not of this
               END)
              + (CASE
                   WHEN COALESCE(s.last_turn_at, s.created_at) > now() - interval '1 day'  THEN 3
                   WHEN COALESCE(s.last_turn_at, s.created_at) > now() - interval '7 days' THEN 2
                   WHEN COALESCE(s.last_turn_at, s.created_at) > now() - interval '30 days' THEN 1
                   ELSE 0
                 END)
              -- Exactness, the one match-quality signal a substring search can afford. The length
              -- test in front is what keeps it affordable: without it every candidate row lowers a
              -- multi-KB body to compare it against a handful of characters.
              + (CASE
                   WHEN length(h.match_text) = length(${norm.raw})
                        AND lower(h.match_text) = lower(${norm.raw}) THEN 3
                   WHEN h.match_text ILIKE ${norm.prefixPattern} THEN 2
                   ELSE 0
                 END) AS score,
              (h.match_field IN ('prompt', 'reply', 'message')) AS is_conversation
            FROM hit h
            JOIN session s ON s.id = h.session_id
            LEFT JOIN workspace a ON a.id = s.workspace_id
            LEFT JOIN task  t ON t.id = s.task_id
          ),
          ranked AS (
            SELECT
              scored.*,
              -- Counted before the quota and the LIMIT, so the palette can admit to what it cut.
              count(*) OVER () AS total,
              count(*) FILTER (WHERE is_conversation) OVER () AS conv_total,
              row_number() OVER (
                PARTITION BY is_conversation
                ORDER BY score DESC, "lastTurnAt" DESC NULLS LAST, "createdAt" DESC
              ) AS group_rn
            FROM scored
          )
          SELECT
            id, title, status, "workspaceId", "workspaceName", "runnerId", "taskId", "taskTitle",
            "lastTurnAt", "createdAt", "completedAt", "archivedAt", "deletedAt", "endReason",
            "matchField", "snippet", total::int AS "total"
          FROM ranked
          -- The name tier cannot take the whole page. Weights alone don't prevent that: a common
          -- word matches 31 titles AND 600 messages here, and with every title touched this month
          -- the top 20 is 20 titles — the conversation hits aren't ranked low, they're unreachable,
          -- because the palette has no paging. So conversation keeps up to half the page and the
          -- name tier takes what's left, which is all of it when there is nothing to reserve for.
          WHERE is_conversation
             OR group_rn <= ${take}::int - LEAST(conv_total, ${take}::int / 2)
          ORDER BY score DESC, "lastTurnAt" DESC NULLS LAST, "createdAt" DESC
          LIMIT ${take}::int
        `)
      : await this.prisma.$queryRaw<Row[]>(Prisma.sql`
          SELECT
            s.id, s.title, s.status,
            a.id   AS "workspaceId",
            a.name AS "workspaceName",
            s.assigned_runner_id AS "runnerId",
            s.task_id AS "taskId",
            t.title   AS "taskTitle",
            s.last_turn_at AS "lastTurnAt",
            s.created_at   AS "createdAt",
            COALESCE(s.completed_at, s.archived_at) AS "completedAt",
            COALESCE(s.completed_at, s.archived_at) AS "archivedAt",
            s.deleted_at   AS "deletedAt",
            s.end_reason   AS "endReason",
            'recent'::text AS "matchField",
            NULL::text AS "snippet"
          FROM session s
          LEFT JOIN workspace a ON a.id = s.workspace_id
          LEFT JOIN task  t ON t.id = s.task_id
          WHERE s.owner_id = ${ownerId}::uuid
            AND s.deleted_at IS NULL
          ORDER BY s.last_turn_at DESC NULLS LAST, s.created_at DESC
          LIMIT ${take}::int
        `);

    const hits = rows.map((r) =>
      withSessionState({
        id: r.id,
        title: r.title,
        status: r.status,
        agent: r.workspaceId ? { id: r.workspaceId, name: r.workspaceName ?? '' } : null,
        runnerId: r.runnerId,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        lastTurnAt: r.lastTurnAt,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        archivedAt: r.archivedAt,
        deletedAt: r.deletedAt,
        endReason: r.endReason,
        matchField: r.matchField,
        // Collapse the whitespace a snippet cut out of a markdown reply is full of, so the palette
        // row reads as one line instead of an accordion of blank space. This is also why no match
        // offset is carried: collapsing shifts every position, so clients locate the query inside
        // the finished snippet instead.
        snippet: r.snippet ? r.snippet.replace(/\s+/g, ' ').trim() : null,
      }),
    );
    // Recents returns everything it has, so what it returned IS the total; a search carries the
    // pre-quota count out on every row.
    return { hits, total: norm ? (rows[0]?.total ?? 0) : hits.length };
  }

  /**
   * Per-workspace tallies over the Open list. `active` remains the admitted-work/fast-poll signal
   * (queued + dispatched); `running` is deliberately narrower and matches the Session list's blue
   * spinner: a dispatched turn, a self-driven engine turn, or a parked parent with a sub-agent
   * still working. Keeping both prevents queued-only workspaces from falsely looking as though the
   * model is already running. `jobs` is neither: sessions with a background job in flight AND still
   * producing output (`runningBgJobs` narrowed by `runningBgJobActivity`) — a `bg_run` that has gone
   * quiet is a process, not work in progress, and the rail should not draw it as the latter. The
   * rail draws this as its own quieter mark: real work the workspace can be doing with nobody
   * generating in it, and the one thing `running` deliberately does not cover.
   * `needsYou` is returned separately, and a session it counts is in neither `running` nor `jobs`:
   * the Session list draws that row with the waiting glyph, not the spinner or the breathing
   * terminal, and the expanded sidebar shows its activity dot beside the count — where a turn
   * blocked on you would otherwise light the dot for work that is not moving.
   * Sessions with no workspace belong to no row and are skipped.
   */
  async workspaceSessionCounts(ownerId: string) {
    const open = {
      ownerId,
      completedAt: null,
      archivedAt: null,
      deletedAt: null,
      workspaceId: { not: null },
    } as const;
    const [active, running, jobs, blocked, jobCards] = await Promise.all([
      this.prisma.session.groupBy({
        by: ['workspaceId'],
        where: { ...open, status: { in: [RunStatus.RUNNING, RunStatus.PENDING] } },
        _count: { _all: true },
      }),
      // Rows rather than a `groupBy`, so a session that needs you can be taken back out by id.
      // These are the sessions in flight right now — a handful even for a busy account.
      this.prisma.session.findMany({
        where: {
          ...open,
          OR: [
            { status: RunStatus.RUNNING },
            {
              status: RunStatus.AWAITING_INPUT,
              OR: [{ engineTurnActive: true }, { runningSubagents: { isEmpty: false } }],
            },
          ],
        },
        select: { id: true, workspaceId: true },
      }),
      // The third tally, and the only one that is neither "the model is generating" nor "somebody
      // is being asked": sessions with a background JOB in flight (Session.runningBgJobs — a
      // `bg_run` that will end, never a `service` left up). The workspace rail draws it as a
      // quieter mark than the working dot, because it answers the question the rail was silent
      // about: a workspace can be doing real work with nobody generating in it.
      //
      // A job only counts while it is still MOVING (freshRunningBgJobs): a `bg_run` whose process is
      // up but has produced nothing for BG_JOB_ACTIVITY_STALE_AFTER_MS is a hang, and a marker that
      // breathes for a hang is a marker that means nothing. That verdict is a fact about `now`, so
      // it can't be a WHERE clause and it isn't a stored answer — hence rows, not a groupBy. The
      // candidate set is the sessions with any job in flight at all, which is a handful even for a
      // busy account, and the rule applied here is the same one the session payload counts with.
      this.prisma.session.findMany({
        where: { ...open, runningBgJobs: { isEmpty: false } },
        select: { id: true, workspaceId: true, runningBgJobs: true, runningBgJobActivity: true },
      }),
      // Only the blocked rows come back (a handful at most), so this stays a lookup, not a scan
      // of the whole list. This one counts prompts a human has to answer, which a self-driven
      // turn raises just as well — and those sit at AWAITING_INPUT for the whole turn.
      this.prisma.session.findMany({
        where: { ...open, ...GENERATING_SESSION_FILTER, approvals: { some: { status: 'PENDING' } } },
        select: { id: true, workspaceId: true },
      }),
      // The second kind of card a person still has to answer, and the one the query above cannot
      // see: a card that names the runner-hosted job reading it (approval.background_job_id,
      // migration 0291) is a question while that process is up, whatever the conversation is
      // doing — and a job may file one while no turn is in flight at all, which is the ordinary
      // shape of a watch that decides an hour later. Candidate set: the sessions with any shell
      // up, because only those can hold one, which keeps this a lookup too; the membership test
      // inside is the same fact `abandoned-approvals.ts` collects on, read by the same predicate.
      this.prisma.session.findMany({
        where: { ...open, runningBgShells: { isEmpty: false } },
        select: {
          id: true,
          workspaceId: true,
          runningBgShells: true,
          approvals: {
            where: { status: 'PENDING', backgroundJobId: { not: null } },
            select: { backgroundJobId: true },
          },
        },
      }),
    ]);
    // The other half of "needs you": decisions only the account owner can take, waiting on the
    // conversation they are asked on. Not an `Approval` row and deliberately never one — see
    // `owner-decision-signal.ts` for why the door refuses to use that table and why COUNTING one is
    // a different question. It is not behind `GENERATING_SESSION_FILTER` either: an unanswered
    // decision outlives the turn that delivered its card, which is exactly the state in which the
    // badge was dark while somebody was waiting.
    //
    // A project ready to start is not one of them here. Its row still says "Ready to start", but
    // nothing is blocked on the start and the owner makes it when they choose, so it lights no
    // tally — the clients' bar leaves the same row out (`SessionGrouping.countsOnlyAStart`), and the
    // APNs badge never counted it.
    const decisions = (await readOwnerDecisionSignals(this.prisma, ownerId))
      .filter((signal) => signal.kind !== 'START_REQUEST');
    const awaitingDecision =
      decisions.length === 0
        ? []
        : await this.prisma.session.findMany({
            where: { ...open, id: { in: decisions.map((signal) => signal.sessionId) } },
            select: { id: true, workspaceId: true },
          });
    const counts = new Map<
      string,
      { workspaceId: string; active: number; running: number; jobs: number; needsYou: number }
    >();
    const row = (workspaceId: string) => {
      const existing = counts.get(workspaceId);
      if (existing) return existing;
      const fresh = { workspaceId, active: 0, running: 0, jobs: 0, needsYou: 0 };
      counts.set(workspaceId, fresh);
      return fresh;
    };
    for (const session of active) {
      if (session.workspaceId) row(session.workspaceId).active = session._count._all;
    }
    // One conversation is one row of this tally however many things are waiting on it: the number
    // is "sessions that need you", and a coordinator blocked on a tool call while a proposal is
    // also unanswered is still one place to go.
    const needsYou = new Set<string>();
    for (const session of [...blocked, ...awaitingDecision]) {
      if (!session.workspaceId || needsYou.has(session.id)) continue;
      needsYou.add(session.id);
      row(session.workspaceId).needsYou += 1;
    }
    // The job cards from the query above, on the same one-row-per-conversation rule: a session
    // already lit by a blocked turn is not lit twice by the card a job filed beside it.
    for (const session of jobCards) {
      if (!session.workspaceId || needsYou.has(session.id)) continue;
      if (!session.approvals.some((a) => readByLiveBackgroundJob(a, session.runningBgShells))) continue;
      needsYou.add(session.id);
      row(session.workspaceId).needsYou += 1;
    }
    // The activity tallies, after `needsYou` because a session counted there is counted only there
    // (see the doc above).
    for (const session of running) {
      if (!session.workspaceId || needsYou.has(session.id)) continue;
      row(session.workspaceId).running += 1;
    }
    // One session is one row of this tally however many jobs it has in flight, as it has always
    // been. What changed with the freshness rule is that a session whose jobs have ALL gone quiet
    // is not one of them: the rail should stop showing work where nothing is moving. `undefined`
    // for a job nobody has reported progress on is not quiet — see BgJobActivity.
    for (const session of jobs) {
      if (!session.workspaceId || needsYou.has(session.id)) continue;
      if (freshRunningBgJobs(session.runningBgJobs, session.runningBgJobActivity).length === 0) continue;
      row(session.workspaceId).jobs += 1;
    }
    return [...counts.values()];
  }

  /** The Open list's data version; see open-list-version.ts. */
  openListVersion(ownerId: string): Promise<string> {
    return readOpenListVersion(this.prisma, ownerId);
  }

  async list(
    ownerId: string,
    filters: {
      runnerId?: string;
      workspaceId?: string;
      tagId?: string;
      projectId?: string;
      /** The workspaces a token confined to them may see (`workspaceConfinement`). */
      confinedTo?: readonly string[];
      view?: 'open' | 'completed' | 'trash' | 'active' | 'archived' | 'deleted' | 'system';
      limit?: number;
    },
  ) {
    // Open = neither completed nor deleted; Completed = completed but not deleted;
    // Trash = deleted, regardless of completion state. Legacy view names remain aliases.
    // `system` is a removed scope retained only for installed older clients; explicitly
    // return no rows so it can never fall through and duplicate Open.
    const view =
      filters.view === 'active'
        ? 'open'
        : filters.view === 'archived'
          ? 'completed'
          : filters.view === 'deleted'
            ? 'trash'
            : (filters.view ?? 'open');
    const visibility: Prisma.Sql =
      view === 'trash'
        ? Prisma.sql`s.deleted_at IS NOT NULL`
        : view === 'system'
          ? Prisma.sql`FALSE`
          : view === 'completed'
            ? Prisma.sql`COALESCE(s.completed_at, s.archived_at) IS NOT NULL AND s.deleted_at IS NULL`
            : Prisma.sql`COALESCE(s.completed_at, s.archived_at) IS NULL AND s.deleted_at IS NULL`;
    const runnerFilter = filters.runnerId
      ? Prisma.sql`AND s.assigned_runner_id = ${filters.runnerId}::uuid`
      : Prisma.empty;
    // The web console's session column is one workspace's conversation list, so it scopes the
    // query rather than filtering a runner-wide list client-side — otherwise a page of rows
    // could be all *other* workspaces' sessions and read as an empty (or stalled) list.
    const workspaceFilter = filters.workspaceId
      ? Prisma.sql`AND s.workspace_id = ${filters.workspaceId}::uuid`
      : Prisma.empty;
    const confinedFilter = filters.confinedTo
      ? Prisma.sql`AND s.workspace_id = ANY(${[...filters.confinedTo]}::uuid[])`
      : Prisma.empty;
    // Same reasoning for the list's tag filter: narrowing a page client-side can leave too few
    // rows to fill (or scroll) the column while the matches sit in pages nobody asked for.
    const tagFilter = filters.tagId
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM session_tag_link stl
          WHERE stl.session_id = s.id AND stl.tag_id = ${filters.tagId}::uuid
        )`
      : Prisma.empty;
    const projectFilter = filters.projectId
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM project p
          WHERE p.id = ${filters.projectId}::uuid AND p.owner_id = ${ownerId}::uuid
        )
        AND ${sessionInProjectSql('s', filters.projectId)}`
      : Prisma.empty;
    // Paging is opt-in: a caller that omits `limit` (the native clients, any older web build)
    // still gets the whole list, so this can only ever shrink a response.
    const pageLimit =
      typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0
        ? Prisma.sql`LIMIT ${Math.floor(filters.limit)}::int`
        : Prisma.empty;
    // Completed orders by when the session was completed
    // (completed_at, newest first) — not by last activity — and deliberately ignores
    // pinning, which is an Open-list affordance. Every other view floats pinned
    // sessions to the top and orders by last turn activity.
    // A session that has never run has no last_turn_at, and the clients place it by when it
    // was created (not last, as `NULLS LAST` would) — so order on the same key they sort by.
    // With `limit` that stopped being cosmetic: a differently ordered page would cut exactly
    // the rows the client then floats to the top.
    const orderBy: Prisma.Sql =
      view === 'completed'
        ? Prisma.sql`COALESCE(s.completed_at, s.archived_at) DESC NULLS LAST, s.created_at DESC`
        : Prisma.sql`(s.pinned_at IS NOT NULL) DESC, COALESCE(s.last_turn_at, s.created_at) DESC, s.created_at DESC`;
    return this.listRows(ownerId, {
      scope: Prisma.sql`${runnerFilter} ${workspaceFilter} ${confinedFilter} ${tagFilter} ${projectFilter}`,
      visibility,
      orderBy,
      pageLimit,
    });
  }

  /**
   * The Open list as a delta against the list the caller was last sent under `since` (see
   * open-list-delta.ts): only the rows that changed, the ids that left Open — finished, trashed or
   * deleted alike, since all the delta sees is that the row is no longer in the list — and the
   * order when it moved. A cursor this process does not hold is answered `full: true` with the
   * whole list. Every answer carries the cursor for the next read.
   */
  async listOpenSince(
    ownerId: string,
    filters: {
      runnerId?: string;
      workspaceId?: string;
      tagId?: string;
      projectId?: string;
      confinedTo?: readonly string[];
    },
    since: string | undefined,
  ) {
    const rows = await this.list(ownerId, { ...filters, view: 'open' });
    const scope = JSON.stringify([
      filters.runnerId ?? null, filters.workspaceId ?? null, filters.tagId ?? null, filters.projectId ?? null,
      filters.confinedTo ?? null,
    ]);
    // A runner's heartbeat restamps every row it hosts every 30 seconds; with a few runners that
    // alone would resend most of the list on most polls. The clients that read this delta draw
    // nothing from the raw timestamp — what it decides (the queue gate, capabilities) are fields of
    // their own and still count — so it is left out of what counts as a change, and a row sent
    // here may carry an older heartbeat than the plain list would.
    const delta = this.openListDelta.answer(ownerId, scope, rows, since, (row) =>
      row.assignedRunner ? { ...row, assignedRunner: { ...row.assignedRunner, lastHeartbeatAt: null } } : row,
    );
    if (delta.full) return delta;
    // Rows have their `id` rewritten to the public spelling on the way out; bare id lists are not
    // walked by that pass, so they are spelled here to match.
    return {
      ...delta,
      removedIds: delta.removedIds.map(uuidToBase62),
      ...(delta.order ? { order: delta.order.map(uuidToBase62) } : {}),
    };
  }

  /**
   * These sessions' list rows, for a reader that names sessions instead of browsing a view of them
   * (the link cards, `link-previews/`). The same query and the same mapping as `list`, so a row read
   * here cannot say something different from the row the list draws for the same session.
   *
   * Open and Completed alike; a session in Trash is not returned, and neither is one that is not
   * `ownerId`'s. No order is promised — key the result by `id`.
   */
  async listRowsByIds(ownerId: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    return this.listRows(ownerId, {
      scope: Prisma.sql`AND s.id = ANY(${[...ids]}::uuid[])`,
      visibility: Prisma.sql`s.deleted_at IS NULL`,
      orderBy: Prisma.sql`s.created_at DESC`,
      pageLimit: Prisma.empty,
    });
  }

  /**
   * The row query and its mapping, shared by `list` and `listRowsByIds`.
   *
   * Every table read here, or by a reader called from here, must also be a source of
   * `readOpenListVersion` (open-list-version.ts): the Open list answers 304 from that version
   * without building this, so a source it misses is a change the clients never see.
   */
  private async listRows(
    ownerId: string,
    { scope, visibility, orderBy, pageLimit }: {
      scope: Prisma.Sql;
      visibility: Prisma.Sql;
      orderBy: Prisma.Sql;
      pageLimit: Prisma.Sql;
    },
  ) {
    // Raw query so the (potentially multi-KB) last-reply preview is truncated in SQL —
    // only ~200 chars per row ever leave the DB. It also omits big unused columns like
    // `prompt`; together this keeps the list payload flat as the session count grows.
    // `select` can't express left()/substring(), hence the hand-written join.
    type Row = {
      id: string;
      status: RunStatus;
      title: string;
      createdAt: Date;
      lastTurnAt: Date | null;
      currentTurnStartedAt: Date | null;
      startedAt: Date | null;
      numTurns: number;
      costUsd: number;
      error: string | null;
      endReason: string | null;
      completedAt: Date | null;
      archivedAt: Date | null;
      deletedAt: Date | null;
      source: string;
      provider: string;
      providerBuiltin: boolean;
      model: string | null;
      permissionMode: string | null;
      effort: string | null;
      fastMode: boolean;
      lastAssistantText: string | null;
      lastToolUse: string | null;
      lastUserText: string | null;
      mergeStatus: string | null;
      sourceState: SourceState;
      sourceRefusalCode: SourceRefusalCode | null;
      sourceRefusalDetail: SessionSourceRefusalDetail | null;
      pinnedAt: Date | null;
      folderId: string | null;
      shared: boolean;
      tags: { id: string; name: string; color: string; isSystem: boolean; position: number }[];
      runningBgCount: number;
      runningBgShells: string[];
      // The live job set with its per-job freshness, shipped raw so the mapper below can count it:
      // which of those jobs still count as work in flight is a fact about `now` (see
      // background-job-activity.ts), so it cannot be a cardinality in the query.
      runningBgJobs: string[];
      runningBgJobActivity: Prisma.JsonValue;
      runningSubagentCount: number;      engineTurnActive: boolean;
      engineStartedAt: Date | null;
      enginePhase: string | null;
      runClaimedAt: Date | null;
      enginePhaseSince: Date | null;
      workspaceId: string | null;
      workspaceName: string | null;
      workspaceModel: string | null;
      workspaceEffort: string | null;
      runnerId: string | null;
      runnerName: string | null;
      runnerStatus: string | null;
      runnerLastHeartbeatAt: Date | null;
      taskId: string | null;
      taskTitle: string | null;
      projectId: string | null;
      projectTitle: string | null;
      projectMembership: SessionProjectMembership | null;
      cancelRequestedAt: Date | null;
      runtimeSessionId: string | null;
      retryAt: Date | null;
      queuedReason: string | null;
      queuedActive: number | null;
      queuedLimit: number | null;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        s.id, s.status, s.title,
        s.created_at      AS "createdAt",
        s.last_turn_at    AS "lastTurnAt",
        -- When the turn now in flight was handed to the runner. last_turn_at cannot answer this:
        -- it is rewritten on every state move (turn delivered, awaiting input, the reaper's
        -- idle-clock reset), so on a running session it sits seconds behind now and a list of
        -- them all reads "just now". This is the one clock that separates a session eight
        -- seconds into a turn from one wedged for forty minutes. Gated on the states that can be
        -- mid-turn so the subquery is skipped for the settled rows that make up most of a list;
        -- answered_at IS NULL is what makes it the *current* turn.
        -- (No backticks in here: this whole statement is a JS template literal.)
        CASE WHEN s.status IN ('RUNNING', 'PENDING') THEN (
          SELECT max(ct.delivered_at)
            FROM conversation_turn ct
           WHERE ct.session_id = s.id
             AND ct.answered_at IS NULL
        ) END AS "currentTurnStartedAt",
        s.started_at      AS "startedAt",
        s.num_turns       AS "numTurns",
        s.cost_usd        AS "costUsd",
        s.error,
        s.end_reason      AS "endReason",
        s.cancel_requested_at AS "cancelRequestedAt",
        s.runtime_session_id AS "runtimeSessionId",
        -- When the auto-retry will re-send the message that a self-healing failure killed, or
        -- NULL when nothing is armed. On the list because a FAILED row with a retry pending is
        -- not an outcome yet: the clients read this to keep from announcing a failure the
        -- server is about to undo (see AutoRetryService, and SessionDelta on the native side).
        s.retry_at        AS "retryAt",
        COALESCE(s.completed_at, s.archived_at) AS "completedAt",
        COALESCE(s.completed_at, s.archived_at) AS "archivedAt",
        s.deleted_at      AS "deletedAt",
        s.source, s.provider, s.model,
        s.provider_builtin AS "providerBuiltin",
        s.permission_mode AS "permissionMode",
        s.effort,
        s.fast_mode       AS "fastMode",
        left(s.last_assistant_text, ${SessionsService.PREVIEW_LEN}::int) AS "lastAssistantText",
        s.last_tool_use   AS "lastToolUse",
        left(s.last_user_text, ${SessionsService.PREVIEW_LEN}::int) AS "lastUserText",
        s.merge_status    AS "mergeStatus",
        -- The SOURCE snapshot (migration 0231), for the "this run never started" card: which
        -- baseline this run was to start from, and — when a runner refused it — the code, and the
        -- diagnosis carrying §10.1's fixAction. On the row rather than behind a second request,
        -- because the card is drawn over a list and a refused run is otherwise a row that says
        -- nothing is wrong. UNBOUND + nulls on every Legacy session.
        s.source_state    AS "sourceState",
        s.source_refusal_code   AS "sourceRefusalCode",
        s.source_refusal_detail AS "sourceRefusalDetail",
        s.pinned_at       AS "pinnedAt",
        -- The folder this session is filed in (0348), which the clients group the list by.
        s.folder_id       AS "folderId",
        -- Whether anyone with a link can open this session right now: a share_link (0306) that
        -- was not turned off and has not run past its expiry, on a session that is not in the
        -- trash (which pauses it). The list's globe (docs/share-links-design.md §8). At most one
        -- such row per session, by share_link's partial unique index.
        (s.deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM share_link sl
           WHERE sl.session_id = s.id
             AND sl.revoked_at IS NULL
             AND (sl.expires_at IS NULL OR sl.expires_at > now())
        )) AS "shared",
        COALESCE((
          SELECT json_agg(json_build_object(
                   'id', st.id, 'name', st.name, 'color', st.color,
                   'isSystem', st.is_system, 'position', st.position
                 ) ORDER BY st.is_system DESC, st.position ASC, st.created_at ASC)
          FROM session_tag_link stl
          JOIN session_tag st ON st.id = stl.tag_id
          WHERE stl.session_id = s.id
        ), '[]'::json) AS "tags",
        cardinality(s.running_bg_shells)::int AS "runningBgCount",
        -- The ids themselves, read by the mapper and never shipped: whether a card is still being
        -- asked depends on its background_job_id being IN this set (readByLiveBackgroundJob in
        -- sessions/abandoned-approvals.ts), which a cardinality cannot answer. A client that wants
        -- the processes asks the count.
        s.running_bg_shells AS "runningBgShells",
        -- The subset of the above that is work in flight (a job/watch, never a service), minus the
        -- ones that have gone quiet: what the clients draw as the pulsing terminal glyph, and what
        -- the workspace rail reads as background activity. See Session.runningBgJobs and
        -- freshRunningBgJobs (background-job-activity.ts) — the count is derived in the mapper,
        -- from these two columns, because the threshold applies to the read.
        s.running_bg_jobs AS "runningBgJobs",
        s.running_bg_job_activity AS "runningBgJobActivity",
        cardinality(s.running_subagents)::int AS "runningSubagentCount",
        s.engine_turn_active AS "engineTurnActive",
        s.engine_started_at AS "engineStartedAt",
        s.engine_phase AS "enginePhase",
        s.run_claimed_at AS "runClaimedAt",
        s.engine_phase_since AS "enginePhaseSince",
        a.id    AS "workspaceId",
        a.name  AS "workspaceName",
        a.model AS "workspaceModel",
        a.effort AS "workspaceEffort",
        s.assigned_runner_id AS "runnerId",
        r.name  AS "runnerName",
        r.status AS "runnerStatus",
        r.last_heartbeat_at AS "runnerLastHeartbeatAt",
        s.task_id AS "taskId",
        t.title   AS "taskTitle",
        cp.id     AS "projectId",
        cp.title  AS "projectTitle",
        ${sessionProjectMembershipSql('s')} AS "projectMembership",
        q.reason  AS "queuedReason",
        q.active  AS "queuedActive",
        q."limit" AS "queuedLimit"
      FROM session s
      LEFT JOIN workspace a  ON a.id = s.workspace_id
      LEFT JOIN runner r ON r.id = s.assigned_runner_id
      LEFT JOIN task t   ON t.id = s.task_id
      -- A coordinator badge is relation metadata, not a user tag. The pointer is unique, so this
      -- adds at most one row and lets the list render it without a per-session detail request.
      LEFT JOIN project cp ON cp.coordinator_session_id = s.id
      -- Which gate is holding a queued session, and against what numbers. "Waiting for a free
      -- slot" was true of every PENDING row and explained none of them: the runner could be
      -- idle while the session's own run was full, and nothing said so. Every count and
      -- ceiling here is the SAME fragment the claim decides with (session-tree-sql.ts) — a
      -- second copy would drift, and confidently naming the wrong gate is worse than naming
      -- none. Only PENDING rows carry an answer; for the rest the lateral yields NULLs.
      LEFT JOIN LATERAL (
        SELECT reason, active, "limit" FROM (
          SELECT
            CASE
              -- First, because it subsumes every gate below: a runner that is not polling will
              -- not claim this row whatever the counts say, and "waiting for a slot" on an idle
              -- machine is the least useful thing the UI could tell someone. Same rule
              -- deriveSessionCapabilities resumes on, so one runner cannot read online here and
              -- offline there.
              WHEN r.id IS NULL
                   OR r.status = 'OFFLINE'
                   OR r.last_heartbeat_at IS NULL
                   OR r.last_heartbeat_at
                      < now() - (${SESSION_RUNNER_OFFLINE_AFTER_MS} * interval '1 millisecond')
                THEN 'runner_offline'
              WHEN ${runnerActiveTurns(Prisma.sql`s.assigned_runner_id`)} >= r.max_concurrent
                THEN 'runner_at_capacity'
              WHEN s.root_session_id IS NOT NULL
                   AND ${treeActiveTurns('s')} >= ${treeCeiling(Prisma.sql`s.assigned_runner_id`)}
                THEN 'tree_at_capacity'
              WHEN s.batch_id IS NOT NULL
                   AND ${batchActiveTurns('s')} >= s.batch_max_concurrent
                THEN 'batch_at_capacity'
              -- Last, so a row that was already explained by capacity keeps that explanation.
              -- This one holds for seconds while a merge/commit finishes on the checkout, and
              -- it is the claim's own fence, not a second copy of it.
              WHEN ${worktreeOperationFenceSql('s')}
                THEN 'worktree_op_pending'
            END AS reason,
            ${runnerActiveTurns(Prisma.sql`s.assigned_runner_id`)} AS runner_active,
            r.max_concurrent AS runner_limit,
            ${treeActiveTurns('s')} AS tree_active,
            ${treeCeiling(Prisma.sql`s.assigned_runner_id`)} AS tree_limit,
            ${batchActiveTurns('s')} AS batch_active,
            s.batch_max_concurrent AS batch_limit
        ) g,
        LATERAL (
          SELECT
            CASE g.reason
              WHEN 'runner_at_capacity' THEN g.runner_active
              WHEN 'tree_at_capacity'   THEN g.tree_active
              WHEN 'batch_at_capacity'  THEN g.batch_active
            END AS active,
            CASE g.reason
              WHEN 'runner_at_capacity' THEN g.runner_limit
              WHEN 'tree_at_capacity'   THEN g.tree_limit
              WHEN 'batch_at_capacity'  THEN g.batch_limit
            END AS "limit"
        ) n
      ) q ON s.status = 'PENDING' AND s.cancel_requested_at IS NULL
      WHERE s.owner_id = ${ownerId}::uuid
        ${scope}
        AND (${visibility})
      ORDER BY ${orderBy}
      ${pageLimit}
    `);
    // Re-nest workspace/assignedRunner to keep the same response shape as the typed query.
    const sessions = rows.map((r) =>
      withSessionCapabilities({
        id: r.id,
        status: r.status,
        title: r.title,
        createdAt: r.createdAt,
        lastTurnAt: r.lastTurnAt,
        currentTurnStartedAt: r.currentTurnStartedAt,
        startedAt: r.startedAt,
        numTurns: r.numTurns,
        costUsd: r.costUsd,
        error: r.error,
        endReason: r.endReason,
        cancelRequestedAt: r.cancelRequestedAt,
        runtimeSessionId: r.runtimeSessionId,
        retryAt: r.retryAt,
        completedAt: r.completedAt,
        archivedAt: r.archivedAt,
        deletedAt: r.deletedAt,
        source: r.source,
        provider: r.provider,
        providerBuiltin: r.providerBuiltin,
        model: r.model,
        permissionMode: r.permissionMode,
        effort: r.effort,
        fastMode: r.fastMode,
        lastAssistantText: r.lastAssistantText,
        lastToolUse: r.lastToolUse,
        lastUserText: r.lastUserText,
        mergeStatus: r.mergeStatus,
        // The SOURCE snapshot, passed through as the columns hold it: a row that resolves nothing
        // is `UNBOUND` with nulls, which is the shape a card tests before it draws anything.
        sourceState: r.sourceState,
        sourceRefusalCode: r.sourceRefusalCode ?? null,
        sourceRefusalDetail: r.sourceRefusalDetail ?? null,
        pinnedAt: r.pinnedAt,
        folderId: r.folderId,
        shared: r.shared === true,
        tags: r.tags,
        runningBgCount: r.runningBgCount,
        runningBgJobCount: freshRunningBgJobs(r.runningBgJobs, r.runningBgJobActivity).length,
        runningSubagentCount: r.runningSubagentCount,
        engineTurnActive: r.engineTurnActive,
        engineStartedAt: r.engineStartedAt,
        // What the list row needs to tell a three-second cold start from an engine that has been
        // compacting for four minutes; both are RUNNING with a null engineStartedAt.
        enginePhase: r.enginePhase,
        // The clocks the waiting notices count from; lastTurnAt moves with activity.
        runClaimedAt: r.runClaimedAt,
        enginePhaseSince: r.enginePhaseSince,
        workspace: r.workspaceId
          ? { id: r.workspaceId, name: r.workspaceName, model: r.workspaceModel, effort: r.workspaceEffort }
          : null,
        assignedRunnerId: r.runnerId,
        assignedRunner: r.runnerId
          ? {
              id: r.runnerId,
              name: r.runnerName,
              status: r.runnerStatus ?? 'OFFLINE',
              lastHeartbeatAt: r.runnerLastHeartbeatAt,
            }
          : null,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        projectId: r.projectId,
        projectTitle: r.projectTitle,
        projectMembership: r.projectMembership,
        // Null unless the row is queued behind a cap — "waiting its turn" is not a gate.
        queuedReason: r.queuedReason,
        queuedActive: r.queuedActive == null ? null : Number(r.queuedActive),
        queuedLimit: r.queuedLimit == null ? null : Number(r.queuedLimit),
      }),
    );
    // A turn blocked on a permission prompt keeps the session generating, so the list can't tell
    // "running" from "waiting for approval" without this count. A conversation can be holding a
    // card in two ways, and it has to be one of them to have one: its turn is live — a generating
    // session, including a self-driven turn, which stays at AWAITING_INPUT while it runs and whose
    // prompt is no less blocking for it — or a runner-hosted job is still reading the card it
    // named (migration 0291), which a PARKED conversation holds just as well. That second class is
    // the one a generating-only count was blind to, and the one this list has to show if a job's
    // card is to be answerable at all; the rail's `needsYou` counts the same pair.
    //
    // Rows rather than a `groupBy`, because the second class is not a predicate the query can
    // carry: the question is whether a card's `background_job_id` is IN its session's
    // `running_bg_shells`. The candidate set is the sessions that are generating plus the ones with
    // a shell up — a handful even on a busy account — so this stays a lookup. What the turn half
    // counts is unchanged from when it was the only half: every PENDING card of a generating
    // session, which is the signal this number has always been, and the door re-reads the facts.
    const generating = new Set(sessions.filter(isSessionGenerating).map((s) => s.id));
    // Off the raw rows, not the mapped ones: the shell ids are read here and deliberately not
    // shipped to the client, so they do not survive into the payload above.
    const shells = new Map(
      rows.filter((r) => r.runningBgShells.length > 0).map((r) => [r.id, r.runningBgShells]),
    );
    const candidates = [...new Set([...generating, ...shells.keys()])];
    const cards = candidates.length === 0
      ? []
      : await this.prisma.approval.findMany({
          where: { sessionId: { in: candidates }, status: 'PENDING' },
          select: { sessionId: true, backgroundJobId: true },
        });
    const byId = new Map<string, number>();
    for (const card of cards) {
      if (!generating.has(card.sessionId) && !readByLiveBackgroundJob(card, shells.get(card.sessionId) ?? [])) {
        continue;
      }
      byId.set(card.sessionId, (byId.get(card.sessionId) ?? 0) + 1);
    }
    // Plus the owner decisions each row is the surface for. A blocked tool call and an unanswered
    // criteria decision are one question to the reader of this list — "is somebody waiting on me
    // here" — so they are one number, and the row's own `projectId` is where the second kind leads.
    // The count is a signal and grants nothing; the decision door re-reads every fact it needs.
    // A row whose only question is an owner confirmation also says which, so it can read "Waiting
    // for your confirmation" rather than "Waiting for approval" (`sessionWaitingKind`).
    const decisions = await readOwnerDecisionsBySession(this.prisma, ownerId, {
      sessionIds: sessions.map((s) => s.id),
    });
    // Who is waiting on whose reply (session-request.ts, contract §6): on each row, the sessions it
    // asked and still waits on, and the sessions waiting on it.
    const requests = await readOpenRequestPeers(this.prisma, ownerId, sessions.map((s) => s.id));
    // The confirmation still with its reviewer, which the row says instead of counting it
    // (docs/owner-confirmation-review-contract.md §5 N3).
    const underReview = await readConfirmationsUnderReview(this.prisma, ownerId, {
      sessionIds: sessions.map((s) => s.id),
    });
    return sessions.map((s) => {
      const approvals = byId.get(s.id) ?? 0;
      const waiting = decisions.get(s.id);
      const peers = requests.get(s.id);
      return {
        ...s,
        pendingApprovals: approvals + (waiting?.count ?? 0),
        waitingKind: sessionWaitingKind(approvals, waiting),
        // Always sent, as null when there is none: a client folding a summary into a row it holds
        // reads null as "clear it".
        confirmationUnderReview: underReview.get(s.id) ?? null,
        // Which of the four owner items are waiting here, for the banner that has to name one and
        // open its card rather than only say that a number is not zero (§7.6 V13).
        ownerItems: ownerItemsForRow(waiting),
        awaitingReplyFrom: peers?.awaitingReplyFrom ?? [],
        owesReplyTo: peers?.owesReplyTo ?? [],
      };
    });
  }

  async get(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      include: {
        workspace: true,
        assignedRunner: {
          select: { id: true, name: true, displayName: true, version: true, engines: true, status: true, lastHeartbeatAt: true, capabilities: true },
        },
        tagLinks: {
          include: {
            tag: { select: { id: true, name: true, color: true, isSystem: true, position: true } },
          },
        },
        // The project this session coordinates, if it is one. The link only exists in this
        // direction — a Session has no project column — so a client that opened the conversation
        // from a project page has no other way to find its way back. At most one row (the unique
        // index behind Project.coordinatorSessionId), reached through that index.
        coordinatorForProject: {
          select: {
            id: true,
            title: true,
            codebases: {
              where: { slot: 'primary' },
              select: { integrationRef: true },
              take: 1,
            },
          },
        },
        task: {
          select: {
            codeless: true,
            project: {
              select: {
                codebases: {
                  where: { slot: 'primary' },
                  select: { integrationRef: true },
                  take: 1,
                },
              },
            },
          },
        },
        // The public link, which lives in `share_link` since 0306: the one that has not ended and
        // has not run past its expiry — at most one, by that table's partial unique index. It is
        // still answered as `shareToken`/`sharedAt`, the names shipped clients read.
        shareLinks: {
          where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          select: { token: true, createdAt: true },
        },
        // A merge recovery can hand work to a dedicated repair conversation. Keep only the newest
        // repair child on the parent detail so the status card can follow it without loading the
        // owner's whole session list. The source marker is server-owned by startMergeRepair.
        children: {
          where: { ownerId, source: 'merge-repair', deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            title: true,
            status: true,
            endReason: true,
            completedAt: true,
            archivedAt: true,
            deletedAt: true,
            error: true,
            createdAt: true,
            startedAt: true,
            finishedAt: true,
            lastTurnAt: true,
          },
        },
      },
    });
    if (!session) throw new NotFoundException('session not found');
    // A Claude row with turns but no runtime session id has no conversation to resume (it predates
    // the column, or its id was minted by a different runtime), so the capabilities payload would
    // say MISSING_CONTEXT and the UI would block resume.
    //
    // PROJECTED, NOT WRITTEN. This used to repair the row here, on a GET — so merely OPENING a
    // historical session's page rewrote `runtime_session_id` and reset `numTurns`, which are the
    // record of what that run did. On a retired task that is worse than untidy: the resume it was
    // preparing for is refused (§13.6 SU6), so the only lasting effect of looking at the page was
    // to edit the history being looked at. A read has no business writing.
    //
    // The repair itself still happens — inside the revive transaction, on the locked row, after the
    // task fence has approved it. Here it is only what the capabilities derivation is told, so the
    // UI offers the button that will, if pressed, do the write.
    const projected = session.provider === 'claude'
        && session.numTurns > 0 && !session.runtimeSessionId
      ? { ...session, runtimeSessionId: SessionsService.RESUMABLE_PROJECTION, numTurns: 0 }
      : session;
    // The ChatGPT account a login-pool session runs on, as the masked view every response names one by
    // (providers/codex-login.ts): the composer of such a session names THE account it is on, not the
    // pool's next one — which, with its oldest account spent, would be nobody. The raw column
    // (migration 0324) is stripped below; this is all a response says of it.
    const poolCodexLogin = await sessionPoolCodexLogin(
      this.prisma,
      ownerId,
      projected.provider,
      projected.poolCodexAccountId,
    );
    // Flatten the join to a picker-ordered `tags` array (system first), matching the list payload.
    // The coordinated project is flattened the same way and for the same reason `taskTitle` is:
    // a name beside its id, so a client can label the link without a second request. Both keys are
    // always present — null on the ordinary session that coordinates nothing — and `projectId` is
    // rendered base62 by PublicIdInterceptor like every other address in the payload.
    const {
      tagLinks,
      coordinatorForProject,
      task,
      shareLinks,
      children,
      // The retired columns (0306): never written since, so what they hold is at best stale.
      shareToken: _retiredShareToken,
      sharedAt: _retiredSharedAt,
      titleManagedByProject: _titleManagedByProject,
      titleBeforeProjectManagement: _titleBeforeProjectManagement,
      // Read, never spread: it is the input to the count below, and a client that wants to know
      // which jobs are moving asks the count, not the per-job instants behind it.
      runningBgJobActivity,
      // OpenAI's own id of the ChatGPT account a login-pool session runs on (migration 0324): no response
      // names an account but by its email and masked form (providers/codex-login.ts).
      poolCodexAccountId: _poolCodexAccountId,
      ...rest
    } = projected;
    const tags = tagLinks
      .map((l) => l.tag)
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.position - b.position);
    // The project line is display metadata for the existing worktree bar. A coordinator reads
    // its own project's line; a code task reads the line of the project it executes. Codeless
    // tasks intentionally stay out of this path, because they have no code diff target.
    const integrationRef = coordinatorForProject?.codebases[0]?.integrationRef
      ?? (task && !task.codeless ? task.project?.codebases[0]?.integrationRef : null);
    // A code task's default merge destination is its project's integration line. An explicit
    // session target still wins, while coordinators keep the workspace target they operate on.
    const taskIntegrationRef = task && !task.codeless ? task.project?.codebases[0]?.integrationRef : null;
    const mergeTarget = rest.branch
      ? mergeTargetOf(rest, session.workspace?.defaultMergeTarget, taskIntegrationRef)
      : null;
    // The Route Decision this task run was planned with (model routing §7.5). Only a task's run
    // can have one, so no other session pays for the read.
    const route = session.taskId
      ? (await readTaskRouteSummaries(this.prisma, ownerId, [session.id])).get(session.id) ?? null
      : null;
    return withSessionCapabilities({
      ...rest,
      workspace: session.workspace ? {
        ...session.workspace,
        antigravityKeyAvailableByRunner: session.assignedRunner ? {
          [session.assignedRunner.id]: hasGeminiEnvKey(session.workspace.env) || antigravityState(session.assignedRunner).envKeyAvailable,
        } : {},
      } : null,
      assignedRunner: session.assignedRunner ? {
        ...session.assignedRunner,
        antigravity: antigravityState(session.assignedRunner),
      } : null,
      route,
      poolCodexLogin,
      mergeTarget,
      mergeRepairSession: children[0] ? withSessionState(children[0]) : null,
      mergeRecoverySupported: session.assignedRunner?.capabilities.includes(SESSION_MERGE_RECOVERY_V1) ?? false,
      tags,
      // Both shapes of the same fact, because the two faces of the API have always differed here:
      // the row's `runningBgJobs`/`runningBgShells` arrays ride along in the spread above, and a
      // client that only needs to draw the glyph should not have to count them itself. The list
      // endpoint answers with the count and never the ids, so this is the one spelling both read.
      //
      // Counted, not `runningBgJobs.length`: a job that has produced nothing for longer than the
      // threshold is still a process (it stays in `runningBgShells`, and in the tray) but is no
      // longer work in flight, which is the question this number answers.
      runningBgJobCount: freshRunningBgJobs(session.runningBgJobs, runningBgJobActivity).length,
      projectId: coordinatorForProject?.id ?? null,
      projectTitle: coordinatorForProject?.title ?? null,
      projectIntegrationRef: integrationRef ? branchName(integrationRef) : null,
      projectMembership: await readSessionProjectMembership(this.prisma, session.id),
      shareToken: shareLinks?.[0]?.token ?? null,
      sharedAt: shareLinks?.[0]?.createdAt ?? null,
    });
  }

  /**
   * Start the repair conversation owned by a merge recovery. The parent link is written by the
   * server so the original session can show the child's live/terminal state after navigation or a
   * reload. A live child is reused, which makes repeated taps idempotent; a terminal child remains
   * visible as the last result and a later explicit tap may start a fresh attempt.
   */
  async startMergeRepair(ownerId: string, id: string, preparePR = false) {
    const parent = await this.prisma.session.findFirst({
      where: { id, ownerId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        assignedRunnerId: true,
        provider: true,
        mergeRecovery: true,
      },
    });
    if (!parent) throw new NotFoundException('session not found');
    const recovery = readMergeRecovery(parent.mergeRecovery);
    if (!recovery || !parent.workspaceId) {
      throw new ConflictException('no merge recovery is available for this session');
    }

    const existing = await this.prisma.session.findFirst({
      where: {
        ownerId,
        parentSessionId: parent.id,
        source: 'merge-repair',
        deletedAt: null,
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return withSessionState(existing);

    const created = await this.create(
      ownerId,
      {
        workspaceId: parent.workspaceId,
        assignedRunnerId: parent.assignedRunnerId ?? undefined,
        provider: parent.provider ?? undefined,
        prompt: mergeRecoveryPrompt(recovery, preparePR),
      },
      { source: 'merge-repair', parentSessionId: parent.id },
    );
    return withSessionState(created);
  }

  /**
   * Stop the pending auto-retry on this session. The user is saying they will decide when
   * (or whether) to send this message again — the transcript card keeps its manual Retry.
   * Idempotent: a retry that already fired, or was never armed, is a no-op.
   */
  async cancelAutoRetry(ownerId: string, id: string): Promise<{ ok: true }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    await this.prisma.session.update({
      where: { id },
      // The claim too (migration 0354): the retry is over, so the session is not on its way to the
      // turn a claim promised — a reader must see a retry given up, not one in flight.
      data: { retryAt: null, retryClaimedAt: null },
    });
    return { ok: true };
  }

  /**
   * Arm it again — the other half of the card's switch.
   *
   * The instant comes from the caller because disarming cleared the only copy the server kept,
   * and re-deriving it here would mean a second implementation of the ingestion path's
   * `retryPlanFor` to drift against. That is safe rather than lax: the same owner can already
   * re-send this message *right now* with the card's Retry button, so an instant they choose can
   * only ever make the re-send happen later than one they can already trigger by hand. The cap
   * is there so a bad clock or a typo can't park a session a year out.
   *
   * Gated on the session still being parked the way the sweeper requires (auto-retry.service):
   * arming one that has since been resumed would drop a re-send into a live conversation.
   */
  async armAutoRetry(ownerId: string, id: string, retryAt: string): Promise<{ retryAt: Date }> {
    const at = new Date(retryAt);
    const now = Date.now();
    if (Number.isNaN(at.getTime()) || at.getTime() <= now)
      throw new BadRequestException('retryAt must be a future instant');
    if (at.getTime() - now > MAX_ARM_AHEAD_MS)
      throw new BadRequestException('retryAt is too far out');
    // §13.6 SU6, before the write. Arming a retry on a task whose work has been replaced promises a
    // run that can never happen: the sweep would select it, find the task retired, and disarm it —
    // so the only lasting effect of the click is a countdown in the UI that expires into nothing.
    // Refused here, `retry_at`, `retry_attempts` and `updated_at` are all untouched. A supersession
    // that lands AFTER this is the sweep's to handle, and it does: one disarm, no attempt spent.
    // ONE transaction, project -> task -> session, so the refusal and the write are the same act.
    //
    // A read-then-write here is not enough, and §13.1 AG6 is the case that shows why: a FAILED work
    // Session is not live, so nothing in 0132's activation fence stops its task becoming an
    // aggregate parent — the pre-check can pass and the arm can land against a task that is a
    // roll-up node by the time it commits, promising a retry the sweep will only ever refuse.
    // Taking the task `FOR UPDATE` is what makes the two orders decide the same thing, and it is
    // the mode the shape guard conflicts with.
    // Retried whole. It takes rank 40 then rank 50 then writes the Session row, and everything it
    // decides — the target's task, that task's project, the role the refusal was judged against —
    // is re-read inside the closure, so a re-run judges the state the winning transaction left.
    const armed = await withTransactionRetry(this.prisma, async (tx) => {
      const [target] = await tx.$queryRaw<Array<{
        taskId: string | null; startsTaskWork: boolean; projectId: string | null;
      }>>(Prisma.sql`
        SELECT s."task_id" AS "taskId", s."starts_task_work" AS "startsTaskWork",
               t."project_id" AS "projectId"
          FROM "session" s LEFT JOIN "task" t ON t."id" = s."task_id"
         WHERE s."id" = ${id}::uuid AND s."owner_id" = ${ownerId}::uuid
      `);
      // Another account's session, or none: not found, as disarming answers it — not "not waiting
      // on a retry", which describes a session the caller has.
      if (!target) throw new NotFoundException('session not found');
      if (target.taskId) {
        if (target.projectId) {
          await tx.$queryRaw(Prisma.sql`
            SELECT 1 FROM "project" p WHERE p."id" = ${target.projectId}::uuid FOR NO KEY UPDATE
          `);
        }
        const [locked] = await tx.$queryRaw<Array<{ projectId: string | null }>>(Prisma.sql`
          SELECT t."project_id" AS "projectId" FROM "task" t WHERE t."id" = ${target.taskId}::uuid
           FOR UPDATE
        `);
        // The project taken above came from an unlocked read. Re-confirm it now that the task is
        // held: a task re-filed in between would leave this holding the OLD project while every
        // trigger behind the write reaches for the new one.
        if ((locked?.projectId ?? null) !== (target.projectId ?? null)) {
          throw new ConflictException(
            'this task changed project while the request was being prepared — nothing was '
            + 'changed; retry',
          );
        }
        // Re-read under the lock, in its own statement: the facts are read from a snapshot taken
        // after the row was granted, not from the one the lock request itself used.
        // §13.1 AG6 applies only to a retry of the task's WORK — arming a retry on a conversation
        // about a roll-up node is a normal thing to do and stays available.
        const refusal = await this.taskWorkRefusalFor(
          tx, target.taskId, false, target.startsTaskWork,
        );
        if (refusal) {
          throw new ConflictException(`this retry cannot be armed: ${refusal}`);
        }
      }
      return tx.session.updateMany({
        where: {
          id,
          ownerId,
          deletedAt: null,
          completedAt: null,
          // The role the refusal above was decided against, so a demotion or promotion landing
          // inside this transaction cannot leave the two disagreeing.
          startsTaskWork: target.startsTaskWork,
          taskId: target.taskId,
          OR: [
            { status: RunStatus.AWAITING_INPUT, cancelRequestedAt: null },
            { status: RunStatus.FAILED },
          ],
        },
        // Armed for a LATER instant, so any claim the sweep had in flight is over: the session waits
        // on this retry, not on a turn (migration 0354).
        data: { retryAt: at, retryClaimedAt: null },
      });
    }, loggedRetry(this.logger, 'sessions.armAutoRetry'));
    if (!armed.count) throw new BadRequestException('session is not waiting on a retry');
    return { retryAt: at };
  }

  /**
   * The sanitized, read-only transcript of a session a public link opens. NO ownerId — the link
   * was resolved from its token (ShareLinksService.resolve), which is the capability, and this is
   * handed the session that link names. Returns only what a viewer needs to render the
   * conversation (title, workspace name, status, the event stream); never ownership, billing,
   * runner internals, or worktree/merge state. A trashed (deletedAt) session stops resolving.
   *
   * `events` is the transcript's TAIL page — the newest `limit` (default 200) — with `hasMore`,
   * not the whole history: a coordinator's transcript is megabytes, and the anonymous door was
   * handing all of it to whoever asked. Older events page in over getSharedEventPage.
   */
  async getSharedTranscript(sessionId: string, opts: { limit?: number; maxPayload?: number } = {}) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        endReason: true,
        completedAt: true,
        archivedAt: true,
        deletedAt: true,
        createdAt: true,
        workspace: { select: { name: true } },
      },
    });
    if (!session) throw linkNotFound();
    const stateful = withSessionState(session);
    // A share is another historical transcript reader, so it observes the same replay contract as
    // the authenticated page/SSE paths. In particular, do not expose live-only rows accidentally
    // persisted by an older API during a rolling deployment (or spend a public response on their
    // repeated foreground-shell snapshots). The page query is the owner's own (eventPage).
    const { events, hasMore } = await this.eventPage(session.id, opts);
    return {
      title: session.title,
      workspaceName: session.workspace?.name ?? null,
      status: stateful.status,
      runStatus: stateful.runStatus,
      sessionState: stateful.sessionState,
      runState: stateful.runState,
      lifecycleState: stateful.lifecycleState,
      filingState: stateful.filingState,
      createdAt: session.createdAt,
      events,
      hasMore,
    };
  }

  /** getEventPage for a share link's session: an older page of the shared transcript
   *  (`before`/`limit`), or its tail when `before` is absent. Same query, cap and truncation as the
   *  owner's page. */
  async getSharedEventPage(
    sessionId: string,
    opts: { before?: number; limit?: number; maxPayload?: number },
  ) {
    return this.eventPage(sessionId, opts);
  }

  /**
   * getEventFull for a share link: one event's untrimmed payload, for a card that came back
   * `truncated`. Behind the same replay fence as the shared pages, so a seq the transcript does
   * not show (a progress ping, a live-only row) is not reachable by asking for it directly.
   */
  async getSharedEventFull(
    sessionId: string,
    seq: number,
  ): Promise<{ seq: number; type: string; payload: unknown; turnId: string | null; ts: Date }> {
    const [row] = await this.prisma.$queryRaw<
      { seq: number; type: string; payload: unknown; turnId: string | null; createdAt: Date }[]
    >`
      SELECT seq, type, payload, turn_id AS "turnId", created_at AS "createdAt"
      FROM run_event
      WHERE session_id = ${sessionId}::uuid
        AND seq = ${seq}
        AND ${replayableEventSql}
    `;
    if (!row) throw new NotFoundException('event not found');
    return { seq: row.seq, type: row.type, payload: row.payload, turnId: row.turnId ?? null, ts: row.createdAt };
  }

  /**
   * A page of a session's persisted events for tail-first lazy loading. `tail` returns the
   * newest N events (initial paint); `before`+`limit` return the N events immediately older
   * than a seq (scroll-up). Both share one newest-first query that takes one extra row to
   * report `hasMore`, then returns the page in chronological (seq asc) order.
   *
   * Two things shrink what a page costs on a slow link. The `system` progress pings no client
   * renders and any live-only events a legacy API accidentally persisted are filtered out in the
   * query (`replayableEventSql`) — they stay stored, but do not ride a historical wire. Filtering
   * in SQL rather than after it means `take` counts events the reader can actually use. And
   * `maxPayload` (opt-in, see truncate-payload) clips bulky tool call/result bodies to a preview
   * and marks those events `truncated`, so the client downloads what the folded transcript shows
   * and refetches the rest per card from getEventFull.
   */
  async getEventPage(
    userId: string,
    id: string,
    opts: { tail?: number; before?: number; limit?: number; maxPayload?: number },
  ): Promise<{
    events: {
      seq: number;
      type: string;
      payload: unknown;
      turnId: string | null;
      ts: Date;
      truncated?: true;
    }[];
    hasMore: boolean;
  }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: userId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    return this.eventPage(id, opts);
  }

  /** getEventPage's query, for a session the caller has already resolved — by owner there, by
   *  share link in getSharedTranscript / getSharedEventPage. */
  private async eventPage(
    id: string,
    opts: { tail?: number; before?: number; limit?: number; maxPayload?: number },
  ): Promise<{
    events: {
      seq: number;
      type: string;
      payload: unknown;
      turnId: string | null;
      ts: Date;
      truncated?: true;
    }[];
    hasMore: boolean;
  }> {
    const take = Math.min(Math.max(Math.trunc(opts.limit ?? opts.tail ?? 200), 1), 500);
    const before =
      typeof opts.before === 'number' && Number.isFinite(opts.before)
        ? Prisma.sql`AND seq < ${Math.trunc(opts.before)}`
        : Prisma.empty;
    // Raw because replayableEventSql includes a jsonb key-subtraction Prisma's filter language
    // cannot spell, and because the filter must run before the page LIMIT.
    // Index Scan Backward on (session_id, seq) still drives it — the filter just skips pings on
    // the way, and the scan stops as soon as `take + 1` renderable rows are in hand.
    const rows = await this.prisma.$queryRaw<
      { seq: number; type: string; payload: unknown; turnId: string | null; createdAt: Date }[]
    >`
      SELECT seq, type, payload, turn_id AS "turnId", created_at AS "createdAt"
      FROM run_event
      WHERE session_id = ${id}::uuid
        ${before}
        AND ${replayableEventSql}
      ORDER BY seq DESC
      LIMIT ${take + 1}
    `; // one extra row: its presence means older events remain
    const hasMore = rows.length > take;
    const page = (hasMore ? rows.slice(0, take) : rows).reverse(); // back to seq asc
    return {
      hasMore,
      events: page.map((e) => toPageEvent(e, opts.maxPayload)),
    };
  }

  /**
   * The page of a session's transcript around ONE record — a conversation turn, a run event or a
   * tool call — for a link that names it (a wiki footnote's location link; see transcript-around.ts).
   * `limit` events centred on the record, the anchor saying which seq it sits at, and a cursor each
   * way: `before` for the ordinary `before=` read, `after` for the `after=` read below — so a client
   * shows the record at once and pages out from it until it meets the tail it streams live.
   *
   * Everything that is not the caller's record in the caller's session is the same 404: another
   * owner's session, a record of another session (and so of another owner), a record the transcript
   * shows nothing of. The answer cannot tell anybody whether somebody else's record exists.
   */
  async getEventPageAround(
    userId: string,
    id: string,
    opts: { around: string; limit?: number; maxPayload?: number },
  ): Promise<TranscriptPage & { anchor: TranscriptAnchor }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: userId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const [found] = await this.prisma.$queryRaw<{ kind: TranscriptRecordKind; seq: number | null }[]>(
      transcriptAnchorSql(id, opts.around),
    );
    if (!found || found.seq === null) throw new NotFoundException('record not found in this session');
    const take = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
    // Each side read one row past the whole page, so pageAround can hand one side's unused room to
    // the other and still tell whether rows remain beyond what it kept.
    const [older, newer] = await Promise.all([
      this.prisma.$queryRaw<PageRow[]>`
        SELECT seq, type, payload, turn_id AS "turnId", created_at AS "createdAt"
        FROM run_event
        WHERE session_id = ${id}::uuid
          AND seq < ${found.seq}
          AND ${replayableEventSql}
        ORDER BY seq DESC
        LIMIT ${take + 1}
      `,
      this.prisma.$queryRaw<PageRow[]>`
        SELECT seq, type, payload, turn_id AS "turnId", created_at AS "createdAt"
        FROM run_event
        WHERE session_id = ${id}::uuid
          AND seq >= ${found.seq}
          AND ${replayableEventSql}
        ORDER BY seq ASC
        LIMIT ${take + 1}
      `,
    ]);
    const page = pageAround(older, newer, take);
    return {
      anchor: { kind: found.kind, id: opts.around, seq: found.seq },
      events: page.events.map((e) => toPageEvent(e, opts.maxPayload)),
      hasMore: page.before !== null,
      before: page.before,
      after: page.after,
    };
  }

  /**
   * The page just NEWER than a seq — the `after` cursor of a page read from the middle, paging back
   * down towards the tail. The mirror of `before=`: `limit` events with seq above `after`, oldest
   * first, and the cursor for the page after that, null once the page reaches the newest event.
   */
  async getEventPageAfter(
    userId: string,
    id: string,
    opts: { after: number; limit?: number; maxPayload?: number },
  ): Promise<TranscriptPage> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: userId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const take = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
    const after = Math.trunc(opts.after);
    const [rows, older] = await Promise.all([
      this.prisma.$queryRaw<PageRow[]>`
        SELECT seq, type, payload, turn_id AS "turnId", created_at AS "createdAt"
        FROM run_event
        WHERE session_id = ${id}::uuid
          AND seq > ${after}
          AND ${replayableEventSql}
        ORDER BY seq ASC
        LIMIT ${take + 1}
      `,
      this.prisma.$queryRaw<{ found: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM run_event
          WHERE session_id = ${id}::uuid
            AND seq <= ${after}
            AND ${replayableEventSql}
        ) AS "found"
      `,
    ]);
    const hasNewer = rows.length > take;
    const events = hasNewer ? rows.slice(0, take) : rows;
    const hasOlder = older[0]?.found === true;
    return {
      events: events.map((e) => toPageEvent(e, opts.maxPayload)),
      hasMore: hasOlder,
      before: hasOlder ? (events[0]?.seq ?? after + 1) : null,
      after: hasNewer ? events[events.length - 1].seq : null,
    };
  }

  /**
   * Find inside ONE session, over its whole history rather than the tail the client happens to
   * have loaded — the transcript is tail-first, so "where did I see that" is usually older than
   * the loaded window, and half of it (folded tool bodies, payloads the page trimmed to a
   * preview) isn't in the client's DOM at all even when it is loaded.
   *
   * A plain scan, deliberately: bounded to one session, the partial index that skips noise
   * events leaves only renderable rows — p99 789 — so the ILIKE usually runs over a few hundred
   * payloads. That's also why CONTENT_MIN_CHARS doesn't apply: the global palette's floor exists
   * because a sub-trigram pattern makes pg_trgm recheck every indexed row in the *deployment*,
   * which a single session's few hundred rows can't reproduce.
   *
   * Matching is the same two-step the palette uses (see `broaden`): the phrase, and — only when
   * the session doesn't contain it — every word of it, so half-remembering a line still finds it.
   * The scan is what costs, so the second step is a second query; `eventRows` says why.
   */
  async searchEvents(
    userId: string,
    id: string,
    q: string | undefined,
    limit?: number,
  ): Promise<EventSearchResponse> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: userId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    // Both sides lose `*` and backticks (see the column below), so the query is stripped with the
    // same brush before it's escaped — otherwise searching for something the user copied out of a
    // rendered reply, marks and all, would match nothing.
    const norm = normalizeSearchQuery(stripEmphasis(q ?? ''));
    if (!norm) return { q: '', total: 0, hits: [] };
    const take = Math.min(Math.max(Math.trunc(limit ?? 100), 1), 200);
    let matched = norm;
    let rows = await this.eventRows(id, norm, take);
    if (rows.length === 0) {
      const wide = broaden(norm);
      if (wide) {
        matched = wide;
        rows = await this.eventRows(id, wide, take);
      }
    }
    // A short page is its own total — the LIMIT didn't cut anything, so there is nothing to count.
    // Only a full page needs asking, and then only up to a ceiling (see `eventTotal`).
    const counted = rows.length < take ? { total: rows.length } : await this.eventTotal(id, matched);

    return {
      q: norm.raw,
      ...counted,
      hits: rows.map((r) => ({
        seq: r.seq,
        type: r.type,
        toolName: r.toolName ?? null,
        ts: r.ts,
        // Collapsed for the same reason the palette collapses: a window cut out of a markdown
        // body or a JSON blob is full of newlines and would render as an accordion.
        snippet: (r.snippet ?? '').replace(/\s+/g, ' ').trim(),
      })),
    };
  }

  /**
   * One pass of in-session find, for whichever form of the query it is handed.
   *
   * Deliberately one scan per form rather than one scan answering both. Evaluating the phrase
   * inside a widened scan looks cheaper — one round trip instead of two — but it makes the
   * *common* case pay the widened price: the words of a query match far more of a session than
   * the phrase does, and everything they admit has to be carried through the sort and the window
   * count. On this deployment's largest session (111k renderable events) that was 13.1s against
   * the 2.0s the phrase alone costs. Asking the cheap question first, and the expensive one only
   * when it came back empty, is the same shape the palette uses and for the same reason.
   */
  private async eventRows(
    id: string,
    norm: NormalizedSearchQuery,
    take: number,
  ): Promise<{ seq: number; type: string; toolName: string | null; ts: Date; snippet: string | null }[]> {
    return this.prisma.$queryRaw<
      { seq: number; type: string; toolName: string | null; ts: Date; snippet: string | null }[]
    >(Prisma.sql`
      WITH ${eventBodySql(id)}
      SELECT
        seq,
        type,
        created_at AS "ts",
        payload->>'name' AS "toolName",
        -- Same ±60 window as the ⌘K palette, and for the same reason: a match can sit deep
        -- inside a multi-KB body, so the cut has to happen in SQL. strpos is literal while
        -- ILIKE is not, which is why the pattern escapes % and _ (see search-query.ts).
        --
        -- The whole phrase first, so a row that has it verbatim shows it; strpos returns 0 when
        -- it doesn't — which is the normal case on a broadened pass — and the window falls back
        -- to the anchor, which the WHERE guarantees is in there somewhere.
        substr(
          text,
          greatest(
            1,
            coalesce(
              nullif(strpos(lower(text), lower(${norm.raw})), 0),
              strpos(lower(text), lower(${norm.anchor}))
            ) - 60
          ),
          length(${norm.raw}) + 120
        ) AS "snippet"
      FROM body
      -- No window count here on purpose. A count(*) OVER () has to see every match before it can
      -- emit the first row, which forbids the backward index scan from stopping at LIMIT: on the
      -- 111k-event session that was 9038ms against 162ms for the same query without it. The total
      -- is asked for separately, and only when the page came back full.
      WHERE ${eventMatchSql(norm)}
      ORDER BY seq DESC
      LIMIT ${take}::int
    `);
  }

  /**
   * How many events match, counted only as far as it is worth counting.
   *
   * The exact figure costs a full scan of the session — nothing about "how many" can stop early —
   * and its only consumer is a label reading "100 of 240". Past a point that label doesn't get
   * more useful, so the count stops at EVENT_TOTAL_CAP and says it stopped; the client renders
   * "1000+". Below the cap the answer is exact, which is every ordinary session.
   */
  private async eventTotal(
    id: string,
    norm: NormalizedSearchQuery,
  ): Promise<{ total: number; totalCapped?: true }> {
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      WITH ${eventBodySql(id)}
      SELECT count(*)::int AS n
      FROM (
        -- The LIMIT is what makes this cheap on the sessions that need it: a query matching most
        -- of a huge session stops after the ceiling instead of counting all of it.
        SELECT 1 FROM body WHERE ${eventMatchSql(norm)} LIMIT ${EVENT_TOTAL_CAP + 1}
      ) capped
    `);
    const n = row?.n ?? 0;
    return n > EVENT_TOTAL_CAP ? { total: EVENT_TOTAL_CAP, totalCapped: true } : { total: n };
  }

  /**
   * One event's untrimmed payload, fetched when the user expands a card whose page/stream copy
   * came back `truncated`. Keyed by seq (unique per session) rather than row id, since that's
   * the only identity a client holds.
   */
  async getEventFull(
    userId: string,
    id: string,
    seq: number,
  ): Promise<{ seq: number; type: string; payload: unknown; turnId: string | null; ts: Date }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: userId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const row = await this.prisma.runEvent.findFirst({
      where: { sessionId: id, seq },
      select: { seq: true, type: true, payload: true, turnId: true, createdAt: true },
    });
    if (!row) throw new NotFoundException('event not found');
    return {
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      turnId: row.turnId ?? null,
      ts: row.createdAt,
    };
  }

  // A background shell with no terminal signal is still "running" only while the session is live;
  // once it's settled the shell can't still be running, so it reads as "unknown" (see
  // classifyShellStatus). Mirrors the web tray's liveness (WorkspaceView `TERMINAL`).
  private static readonly TERMINAL_STATUSES: RunStatus[] = [
    RunStatus.SUCCEEDED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
  ];

  /**
   * The authoritative, complete list of background shells the session ever launched — every
   * Bash(run_in_background), and the workspace's own background sub-agents and workflows (an async
   * Agent call, a Workflow call) — with output recovered from the workspace's persisted Read polls of the
   * `.output` file. Derived server-side over ALL of the session's persisted events (not just the
   * client's loaded tail window), so the "Background processes" tray shows the same complete list
   * on every client regardless of how much transcript is loaded. Reuses the exact derivation the
   * web client overlays live (@orbit/shared deriveBackgroundShells), so the two never drift.
   */
  async getBackgroundShells(userId: string, id: string): Promise<BgShell[]> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: userId },
      select: { id: true, status: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const rows = await this.selectBackgroundEvents(id);
    const sessionLive = !SessionsService.TERMINAL_STATUSES.includes(session.status);
    return deriveBackgroundShells(
      rows.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        ts: e.createdAt.toISOString(),
      })),
      { sessionLive },
    );
  }

  /**
   * The SQL complement of @orbit/shared's `selectBackgroundDerivationEvents` — the events the
   * background derivation can actually read, chosen in the database so the rest never leaves it.
   *
   * Filtering by event *type* alone (what this used to do) was nowhere near enough: `tool_use` and
   * `tool_result` ARE the bulk of a session. Measured here, a busy session hauled 2249 rows / 3.7MB
   * of untruncated tool bodies across for a derivation that reads a handful of them and, 93% of the
   * time, returns nothing at all; the largest session in this deployment would have moved 112k rows
   * / 127MB. Narrowed to the two `tool_use` shapes the derivation inspects, that session reads 105
   * rows / 36kB. Keep this literally in step with the shared function — background.spec.ts proves
   * the narrowing is lossless by deriving over the wide and narrow sets and comparing.
   *
   * Two passes, because whether a `tool_result` matters depends on which `tool_use` it answers.
   * The second only runs for a session that actually launched a shell (6.5% of them here), and is
   * skipped entirely otherwise.
   */
  private async selectBackgroundEvents(
    id: string,
  ): Promise<{ seq: number; type: string; payload: unknown; createdAt: Date }[]> {
    type Row = { seq: number; type: string; payload: unknown; createdAt: Date };
    const calls = await this.prisma.$queryRaw<Row[]>`
      SELECT seq, type, payload, created_at AS "createdAt"
      FROM run_event
      WHERE session_id = ${id}::uuid
        AND (
          type IN (${RunEventType.BACKGROUND_TASK}, ${RunEventType.BACKGROUND_OUTPUT})
          OR (
            type = ${RunEventType.TOOL_USE}
            AND (
              (payload->>'name' = 'Bash' AND payload->'input'->>'run_in_background' = 'true')
              OR (payload->>'name' = 'Read' AND payload->'input'->>'file_path' LIKE '%.output')
              OR (payload->>'name' IN ('Agent', 'Task', 'Workflow') AND NOT (payload ? 'parentToolUseId'))
            )
          )
        )
      ORDER BY seq ASC
    `;
    const toolUseIds = [
      ...new Set(
        calls
          .filter((r) => r.type === RunEventType.TOOL_USE)
          .map((r) => (r.payload as { id?: unknown } | null)?.id)
          .filter((v): v is string | number => v != null)
          .map(String),
      ),
    ];
    if (toolUseIds.length === 0) return calls;
    const results = await this.prisma.$queryRaw<Row[]>`
      SELECT seq, type, payload, created_at AS "createdAt"
      FROM run_event
      WHERE session_id = ${id}::uuid
        AND type = ${RunEventType.TOOL_RESULT}
        AND payload->>'toolUseId' IN (${Prisma.join(toolUseIds)})
      ORDER BY seq ASC
    `;
    return [...calls, ...results].sort((a, b) => a.seq - b.seq);
  }

  async getWorktreeFileForOwner(
    ownerId: string,
    id: string,
    filePath: string | undefined,
  ): Promise<{ data: Buffer; mimeType: string; disposition: string }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: {
        id: true, changedFiles: true,
        assignedRunner: { select: { status: true, lastHeartbeatAt: true } },
      },
    });
    if (!session) throw new NotFoundException('Session not found.');
    if (!isWorktreeArtifactPath(filePath) || !Array.isArray(session.changedFiles)
      || !session.changedFiles.some((file) => file && typeof file === 'object' && !Array.isArray(file)
        && file.path === filePath && typeof file.status === 'string' && file.status !== 'D')) {
      throw new NotFoundException('File is no longer available.');
    }
    if (!session.assignedRunner || !runnerIsOnline(session.assignedRunner)) {
      throw new HttpException('The runner is offline. Try again when it is online.', HttpStatus.SERVICE_UNAVAILABLE);
    }

    // A new request always reads fresh bytes, including two files with the same basename.
    const content = { source: 'worktree' as const, path: filePath };
    const turn = await this.insertTurn(id, {
      kind: 'artifact', content: JSON.stringify(content), clientTurnId: `worktree-file-${randomUUID()}`,
    });
    const deadline = Date.now() + 40_000;
    while (true) {
      const result = await this.prisma.conversationTurn.findFirst({
        where: { id: turn.id, sessionId: id, kind: 'artifact' },
        select: {
          status: true, content: true,
          attachments: {
            where: { ownerId, sessionId: id }, take: 1,
            select: { id: true, data: true, mimeType: true },
          },
        },
      });
      if (!result) throw new NotFoundException('File is no longer available.');
      if (result.status === 'ANSWERED') {
        const receipt = readWorktreeArtifactRequest(result.content)?.result;
        const attachment = result.attachments[0];
        if (receipt?.status === 'uploaded' && attachment) {
          // Preview bytes are transient; do not retain a new blob for every file opening.
          await this.prisma.attachment.deleteMany({
            where: { id: attachment.id, turnId: turn.id, ownerId, sessionId: id },
          });
          return {
            data: Buffer.from(attachment.data), mimeType: attachment.mimeType,
            disposition: legacyArtifactDisposition(path.posix.basename(filePath)),
          };
        }
        if (receipt?.status === 'missing') throw new NotFoundException('File is no longer available.');
        if (receipt?.status === 'error' && receipt.errorCode === 'too_large') {
          throw new HttpException('This file is too large to preview or download.', HttpStatus.PAYLOAD_TOO_LARGE);
        }
        throw new HttpException('The runner could not read this file. Please try again.', HttpStatus.BAD_GATEWAY);
      }
      if (Date.now() >= deadline) {
        // A late callback cannot restart the request. If a result won this race, read it.
        const expired = await this.prisma.conversationTurn.updateMany({
          where: { id: turn.id, sessionId: id, kind: 'artifact', status: 'PENDING' },
          data: {
            status: 'ANSWERED', answeredAt: new Date(),
            content: JSON.stringify({ ...content, result: { status: 'timeout' } }),
          },
        });
        if (expired.count === 0) continue;
        throw new HttpException('The file request timed out. Please try again.', HttpStatus.GATEWAY_TIMEOUT);
      }
      await sleep(1_000);
    }
  }

  async getLegacyArtifactForOwner(
    ownerId: string,
    id: string,
    rawPath: string | undefined,
  ): Promise<{ data: Buffer; mimeType: string; disposition: string }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    return this.getLegacyArtifact(session.id, rawPath);
  }

  /**
   * The share link's artifact door serves only what is already stored. Everything else
   * getLegacyArtifact does is the owner's: asking the runner (a turn in the owner's session and a
   * request held up to 40s) and proving the path was mentioned (the whole run_event history read
   * into memory) — neither is something an anonymous visitor should be able to start.
   */
  async getLegacyArtifactForShared(
    sessionId: string,
    rawPath: string | undefined,
  ): Promise<{ data: Buffer; mimeType: string; disposition: string }> {
    const resolved = await this.resolveLegacyArtifactPath(sessionId, rawPath);
    const attached = await this.getLegacyArtifactAttachment(sessionId, path.basename(resolved.file));
    if (!attached) throw new NotFoundException('artifact not found');
    return attached;
  }

  private async getLegacyArtifact(
    sessionId: string,
    rawPath: string | undefined,
  ): Promise<{ data: Buffer; mimeType: string; disposition: string }> {
    const resolved = await this.resolveLegacyArtifactPath(sessionId, rawPath);
    const mentioned = await this.legacyArtifactPathIsMentioned(sessionId, resolved.original);
    if (!mentioned) throw new NotFoundException('artifact not found');

    const filename = path.basename(resolved.file);
    const attached = await this.getLegacyArtifactAttachment(sessionId, filename);
    if (attached) return attached;

    const localFile = await this.resolveExistingLocalArtifactFile(resolved.root, resolved.file);
    if (!localFile) return this.requestAndWaitForLegacyArtifact(sessionId, resolved.file, filename);

    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(localFile);
    } catch {
      return this.requestAndWaitForLegacyArtifact(sessionId, resolved.file, filename);
    }
    if (!st.isFile() || st.size <= 0 || st.size > MAX_UPLOAD_BYTES) {
      return this.requestAndWaitForLegacyArtifact(sessionId, resolved.file, filename);
    }
    const data = await fs.readFile(localFile);
    const local = {
      data,
      mimeType: legacyArtifactMime(localFile),
      disposition: legacyArtifactDisposition(filename),
    };
    await this.persistLegacyArtifactAttachment(sessionId, filename, local.mimeType, data).catch(() => undefined);
    return local;
  }

  private async requestAndWaitForLegacyArtifact(
    sessionId: string,
    artifactPath: string,
    filename: string,
  ): Promise<{ data: Buffer; mimeType: string; disposition: string }> {
    await this.enqueueLegacyArtifactRequest(sessionId, artifactPath);
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const attached = await this.getLegacyArtifactAttachment(sessionId, filename);
      if (attached) return attached;
      await sleep(1_000);
    }
    throw new NotFoundException('artifact not found');
  }

  private async enqueueLegacyArtifactRequest(sessionId: string, artifactPath: string): Promise<void> {
    const key = createHash('sha256').update(artifactPath).digest('hex').slice(0, 32);
    const turn = await this.insertTurn(sessionId, {
      kind: 'artifact',
      content: artifactPath,
      clientTurnId: `artifact-${key}`,
    });
    if (turn.status !== 'PENDING') {
      await this.prisma.conversationTurn.update({
        where: { id: turn.id },
        data: { status: 'PENDING', answeredAt: null, deliveredAt: null, leaseDeadlineAt: null },
      });
    }
  }

  private async resolveLegacyArtifactPath(
    sessionId: string,
    rawPath: string | undefined,
  ): Promise<{ original: string; file: string; root: string }> {
    const resolved = resolveLegacyArtifactPath(sessionId, rawPath);
    if (!resolved) throw new NotFoundException('artifact not found');
    return resolved;
  }

  private async resolveExistingLocalArtifactFile(root: string, file: string): Promise<string | null> {
    let realRoot: string;
    let realFile: string;
    try {
      realRoot = await fs.realpath(root);
      realFile = await fs.realpath(file);
    } catch {
      return null;
    }
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
      throw new NotFoundException('artifact not found');
    }
    return realFile;
  }

  private async legacyArtifactPathIsMentioned(sessionId: string, artifactPath: string): Promise<boolean> {
    const rows = await this.prisma.runEvent.findMany({
      where: { sessionId },
      select: { payload: true },
    });
    return rows.some((row) => (JSON.stringify(row.payload) ?? '').includes(artifactPath));
  }

  private async getLegacyArtifactAttachment(
    sessionId: string,
    filename: string,
  ): Promise<{ data: Buffer; mimeType: string; disposition: string } | null> {
    const row = await this.prisma.attachment.findFirst({
      where: { sessionId, fileName: filename, turnId: null },
      orderBy: { createdAt: 'desc' },
      select: { data: true, mimeType: true, fileName: true },
    });
    if (!row) return null;
    return {
      data: Buffer.from(row.data),
      mimeType: row.mimeType,
      disposition: legacyArtifactDisposition(row.fileName ?? filename),
    };
  }

  private async persistLegacyArtifactAttachment(
    sessionId: string,
    filename: string,
    mimeType: string,
    data: Buffer,
  ): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { ownerId: true } });
    if (!session) return;
    await this.prisma.attachment.create({
      data: {
        ownerId: session.ownerId,
        sessionId,
        mimeType,
        sizeBytes: data.length,
        fileName: filename,
        data: toBytes(data),
      },
    });
  }

  /**
   * The session's per-file unified diffs (FilePatch[]), kept in a side table so the patch
   * text never rides the session detail/list payload — fetched only when the user opens a
   * file's diff in the worktree status bar. The runner upserts it each turn (live) and at
   * completion (committed). Returns an empty list for a session with no recorded diff.
   */
  async getDiff(ownerId: string, id: string): Promise<{ patches: FilePatch[] }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const row = await this.prisma.sessionDiff.findUnique({
      where: { sessionId: id },
      select: { patches: true },
    });
    return { patches: (row?.patches as unknown as FilePatch[]) ?? [] };
  }

  /**
   * Ask the live runner to recompute this session's worktree diff right now. The stored
   * patches only refresh at turn boundaries, but the file list refreshes on every heartbeat,
   * so a file changed since the last turn end can show in the list with no diff ("No diff to
   * preview"). Enqueueing a 'diff' control turn makes the runner's inbox poller recompute and
   * push the diff back within a second or two (see RunnerApiController.diffResult).
   *
   * Only a live session has a running inbox poller; for anything else the stored snapshot is
   * already as fresh as it gets, so this is a no-op. At most one refresh is queued at a time
   * (dedup on a PENDING 'diff' turn) so repeated drawer opens / polls don't pile up turns.
   */
  async requestDiffRefresh(ownerId: string, id: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true, status: true },
    });
    if (!session) throw new NotFoundException('session not found');
    if (!SessionsService.LIVE.includes(session.status)) return;
    const pending = await this.prisma.conversationTurn.findFirst({
      where: { sessionId: id, kind: 'diff', status: 'PENDING' },
      select: { id: true },
    });
    if (!pending) {
      await this.insertTurn(id, { kind: 'diff', clientTurnId: randomUUID() });
    }
    this.realtime.notifyInbox(id);
  }

  // The session list shows the last reply as a single ellipsised line, so it only
  // needs a short prefix of the (potentially multi-KB) denormalized preview text.
  private static readonly PREVIEW_LEN = 200;

  static readonly LIVE: RunStatus[] = [
    RunStatus.RUNNING,
    RunStatus.AWAITING_INPUT,
    RunStatus.INTERRUPTED,
  ];

  // Not live: resume() revives these (and complete/delete/config treat them as
  // already-ended). CANCELLED covers both a hard stop and a graceful, still-resumable end
  // (idle recycle / user end) — `endReason` is what tells those apart for display.
  static readonly TERMINAL: RunStatus[] = [
    RunStatus.SUCCEEDED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
  ];

  private static resumeBlocked(reason: SessionResumeBlockedReason): ConflictException {
    switch (reason) {
      case 'TRASHED':
        return new ConflictException('the session is in Trash; restore it before sending a message');
      case 'ENDING':
        return new ConflictException('the session is ending');
      case 'NOT_TERMINAL':
        return new ConflictException('the session has not started yet');
      case 'NOT_STARTED':
      case 'MISSING_CONTEXT':
        return new ConflictException('this session never ran and cannot be resumed');
      case 'NO_RUNNER':
        return new ConflictException('the session has no runner to resume on');
      case 'RUNNER_OFFLINE':
        return new ConflictException('the runner is offline; it must be online to resume this session');
    }
  }

  /** Load an owner's session and assert it's still live (not ended/cancelled). */
  private async getLive(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (!SessionsService.LIVE.includes(session.status) || session.cancelRequestedAt) {
      throw new ConflictException('the session has ended');
    }
    return session;
  }

  /**
   * Like {@link getLive}, but also accepts a still-PENDING session — one queued and
   * waiting for a runner slot, with no claude process yet. A user message can be lined
   * up onto it (it's delivered once the runner claims the session); only an ended or
   * cancel-requested session rejects. Used by createTurn / cancelQueuedTurn so the
   * composer works while the session waits for a slot.
   */
  private async getSendable(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (session.deletedAt) {
      throw new SessionNotSendable('the session is in Trash; restore it before sending a message');
    }
    if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
      throw new SessionNotSendable('the session has ended');
    }
    return session;
  }

  /**
   * Seed the session's first turn from its prompt, idempotently. A fresh PENDING session
   * isn't seeded until the runner claims it (queue.service.buildSession), so to queue a
   * follow-up onto one we must lay down the prompt as turn 1 first — otherwise the
   * follow-up would take seq 1 and the claim would skip seeding (turnCount > 0), dropping
   * the prompt. Uses the SAME fixed clientTurnId the claim uses, so whichever path runs
   * first wins and the other no-ops (insertTurn is idempotent on clientTurnId). Check that fixed
   * id rather than an arbitrary turn count: a control turn must never masquerade as the prompt.
   *
   * An imported session has no prompt to lay down — `prompt` is empty by construction, because
   * its conversation arrived from a transcript rather than from a first message (see
   * importSession). Seeding it would put an empty "user message" at the head of a conversation
   * that already has one, and the message that triggered it would be answered a turn late.
   * `importedAt` says so durably; `importSourceCwd` cannot, having been cleared by the import
   * itself, and numTurns is now honestly 0 for these rows.
   */
  private async ensurePromptSeeded(
    tx: Prisma.TransactionClient,
    session: { id: string; prompt: string; importedAt: Date | null },
    excludedAttachmentIds: readonly string[] = [],
  ) {
    if (session.importedAt) return;
    const existing = await tx.conversationTurn.findUnique({
      where: {
        sessionId_clientTurnId: {
          sessionId: session.id,
          clientTurnId: SessionsService.initialTurnClientId(session.id),
        },
      },
      select: { id: true },
    });
    if (existing) return;
    const turn = await this.insertTurnLocked(tx, session.id, {
      kind: 'message',
      content: session.prompt,
      clientTurnId: SessionsService.initialTurnClientId(session.id),
    });
    // Link any compose-page uploads (scoped to the session, still turn-less) to the seed
    // turn, exactly as the claim would, so they ride along with the prompt.
    await tx.attachment.updateMany({
      where: {
        sessionId: session.id,
        turnId: null,
        ...(excludedAttachmentIds.length > 0 ? { id: { notIn: [...excludedAttachmentIds] } } : {}),
      },
      data: { turnId: turn.id },
    });
  }

  /**
   * `ensurePromptSeeded` in a transaction of its own, for the one opening the claim will not seed:
   * a session `create` opened with attachments alone. The uploads are linked in the same
   * transaction as the turn, so no runner can take the turn without them.
   */
  private async seedOpeningTurn(session: { id: string; prompt: string; importedAt: Date | null }) {
    await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${session.id}::uuid FOR UPDATE`;
      await this.ensurePromptSeeded(tx, session);
    }, loggedRetry(this.logger, 'sessions.seedOpeningTurn'));
  }

  /** The fixed clientTurnId of the seeded first turn (the prompt) — see ensurePromptSeeded
   *  / queue.service.buildSession. It's a real PENDING message turn but isn't a withdrawable
   *  queued follow-up, so the queued-turn list/cancel paths exclude it. */
  static initialTurnClientId(sessionId: string): string {
    return `initial-${sessionId}`;
  }

  /** Allocate a turn while the caller holds the Session row lock. */
  /**
   * Is the ENGINE running a turn right now — the only thing there is to steer?
   *
   * Messages only. A `!cmd` shell turn holds the same slot but runs on the runner, with the
   * engine sitting idle beside it: a message sent during one has no turn to join, so it
   * queues behind the shell turn exactly as it always has.
   *
   * Only a live lease counts. An IN_FLIGHT row whose lease has expired belongs to an engine
   * that stopped answering: the inbox will re-deliver it to whoever takes over, and treating
   * it as running would file a message as a steer for a turn nobody is executing.
   *
   * Called under the Session row lock that createTurn already holds, which is the same lock
   * dequeueTurn takes — so a turn cannot finish between this answer and the insert.
   */
  private async liveEngineTurn(
    tx: Prisma.TransactionClient,
    sessionId: string,
    exactTurnId?: string,
  ): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "conversation_turn"
       WHERE "session_id" = ${sessionId}::uuid
         AND kind = 'message'
         AND status = 'IN_FLIGHT'
         AND "lease_deadline_at" > clock_timestamp()
             + (${CURRENT_WORK_LEASE_SAFETY_MS} * interval '1 millisecond')
         ${exactTurnId ? Prisma.sql`AND id = ${exactTurnId}::uuid` : Prisma.empty}
       ORDER BY seq ASC
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Tell the sender where its turn actually landed, from the same row-locked queue snapshot that
   * decides and inserts it. A PENDING message/shell is only waiting when another executable turn
   * has a lower seq; the first executable is accepted even though enqueue changes the Session to
   * PENDING while it waits for a runner slot. Once a retried turn has started or finished it is no
   * longer queued, and a steer always keeps its distinct placement however its delivery progressed.
   */
  private async turnPlacement(
    tx: Prisma.TransactionClient,
    sessionId: string,
    turn: { kind: string; status: string; seq?: number },
  ): Promise<TurnPlacement> {
    if (turn.kind === 'steer') return 'steer';
    if (turn.status !== 'PENDING') return 'accepted';
    const earlierExecutable = await tx.conversationTurn.count({
      where: {
        sessionId,
        kind: { in: ['message', 'shell'] },
        status: { in: ['PENDING', 'IN_FLIGHT'] },
        ...(turn.seq === undefined ? {} : { seq: { lt: turn.seq } }),
      },
    });
    return earlierExecutable > 0 ? 'queued' : 'accepted';
  }

  /**
   * Whether a message sent to this session right now can be written into the turn already
   * running — which takes BOTH an engine that can be handed one and a runner that can hand
   * it over.
   *
   * Filing a steer for a runtime whose session loop has no case for it delivered a turn
   * nobody consumes: it is leased, so it leaves the queued list, and it is never re-leased,
   * so it never reappears — the message would simply be gone. Filing one for a runner too
   * old to deliver it is not silent, but it is a regression all the same: that runner
   * refuses every steer it is handed, so a mid-turn message that quietly queued today would
   * start failing in front of the user instead (docs/codex-turn-steer-contract.md §6.1).
   * Both answers must be yes, and either one being unknown means no.
   *
   * The runtime is resolved with the same `execRuntime` dispatch uses, so a configured
   * (BYOK) provider is judged by the built-in runtime it borrows rather than by its slug.
   *
   * The runner is judged by what it declared on its own last heartbeat. That snapshot can
   * only be stale in one direction that matters — a machine downgraded since it last spoke —
   * and the inbox re-asks the poller itself before handing anything over. A stale legacy steer
   * keeps its compatibility requeue; explicit CURRENT_WORK is withheld and terminalized as a
   * visible non-delivery when its exact target ends.
   */
  private async runtimeTakesSteer(
    tx: Prisma.TransactionClient,
    session: {
      provider: string;
      providerBuiltin: boolean;
      ownerId: string;
      assignedRunnerId: string | null;
    },
  ) {
    // A session with no runner assigned has nothing running to steer either — engineTurnInFlight
    // is asked first — so an absent runner only ever reads as "declared nothing", which withholds
    // every gated runtime and leaves claude exactly where it already was.
    const runner = session.assignedRunnerId
      ? await tx.runner.findUnique({
          where: { id: session.assignedRunnerId },
          select: { capabilities: true },
        })
      : null;
    return supportsTargetBoundCurrentWorkSteer(
      await sessionExecRuntime(tx, session),
      runner?.capabilities,
    );
  }

  /**
   * The engine turn a server-routed send is written into (createTurn's `steerIfLive`), or null for
   * one that waits behind it. Explicit CURRENT_WORK's questions in its order — a live engine turn, a
   * runtime and runner that take an exact-target steer, and that turn's lease asked again on the
   * database clock once the capability reads are done — answered with a route instead of a refusal.
   */
  private async steerTargetIfLive(
    tx: Prisma.TransactionClient,
    sessionId: string,
    session: {
      provider: string;
      providerBuiltin: boolean;
      ownerId: string;
      assignedRunnerId: string | null;
    },
  ): Promise<{ id: string } | null> {
    const live = await this.liveEngineTurn(tx, sessionId);
    if (!live || !(await this.runtimeTakesSteer(tx, session))) return null;
    return this.liveEngineTurn(tx, sessionId, live.id);
  }

  /** The pre-routing-protocol decision used only when an installed client omits `intent`.
   * It deliberately retains Claude's legacy always-steer behaviour and Codex's existing
   * capability gate; routing-v1 is required only for explicit, exact-target CURRENT_WORK. */
  private async runtimeTakesLegacySteer(
    tx: Prisma.TransactionClient,
    session: {
      provider: string;
      providerBuiltin: boolean;
      ownerId: string;
      assignedRunnerId: string | null;
    },
  ): Promise<boolean> {
    const runner = session.assignedRunnerId
      ? await tx.runner.findUnique({
          where: { id: session.assignedRunnerId },
          select: { capabilities: true },
        })
      : null;
    return supportsMidTurnSteer(await sessionExecRuntime(tx, session), runner?.capabilities);
  }

  private async insertTurnLocked(
    tx: Prisma.TransactionClient,
    sessionId: string,
    data: {
      kind: string;
      content?: string;
      clientTurnId: string;
      requestFingerprint?: string;
      sendIntent?: SessionTurnIntent;
      targetTurnId?: string;
      senderSessionId?: string;
    },
  ) {
    const existing = await tx.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId, clientTurnId: data.clientTurnId } },
    });
    if (existing) return existing;
    const last = await tx.conversationTurn.findFirst({
      where: { sessionId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return tx.conversationTurn.create({
      data: { sessionId, seq: (last?.seq ?? 0) + 1, status: 'PENDING', ...data },
    });
  }

  /**
   * Allocate the next per-session delivery seq under a row lock. Every producer uses
   * this path, so concurrent user/control turns cannot race on the unique (session,seq).
   */
  private async insertTurn(
    sessionId: string,
    data: {
      kind: string;
      content?: string;
      clientTurnId: string;
      requestFingerprint?: string;
      sendIntent?: SessionTurnIntent;
      targetTurnId?: string;
    },
  ) {
    // Retried whole. The seq is allocated from a row read under the Session's own lock inside the
    // closure, so a re-run allocates from the sequence the winner left rather than reusing a number
    // a discarded snapshot suggested.
    return withTransactionRetry(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('session not found');
      return this.insertTurnLocked(tx, sessionId, data);
    }, loggedRetry(this.logger, 'sessions.insertTurn'));
  }

  /**
   * Verify the given attachment ids are the caller's and scoped to this session, and return the
   * de-duped ids to link to the turn. Throws on any unknown/foreign id so a bad reference is
   * rejected BEFORE a turn is queued (no orphan text turn, no silent drop of an image the user
   * meant to send). Call before inserting the turn; link after.
   *
   * An id already on a turn is a file this session sent before, named again — a retry re-sending
   * the message it went out with (the clients' Retry carries that message's own ids). It is copied,
   * and the copy is what gets linked: an attachment belongs to exactly one turn and is deleted with
   * it, so moving it would take the picture out of the bubble it was sent in, and a withdrawn retry
   * would take it with it — `AutoRetryService.copyAttachments` copies for the same reason. Refusing
   * it instead failed every Retry of a message that had a file, and the words came back into the
   * composer without it. The copy's id is `resentAttachmentId`, so a replay of this send finds it.
   */
  private async assertLinkableAttachments(
    ownerId: string,
    sessionId: string,
    clientTurnId: string,
    attachmentIds: string[] | undefined,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const ids = [...new Set(attachmentIds ?? [])];
    if (ids.length === 0) return [];
    const found = await tx.attachment.findMany({
      where: { id: { in: ids }, ownerId, sessionId },
      select: { id: true, turnId: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('one or more attachments are unknown or not yours');
    }
    const copyOf = new Map(
      found
        .filter((a) => a.turnId != null)
        .map((a) => [a.id, resentAttachmentId(sessionId, clientTurnId, a.id)] as const),
    );
    if (copyOf.size === 0) return ids;
    // In the database, so the bytes are not carried through this process under the session lock.
    await tx.$executeRaw`
      INSERT INTO "attachment" (id, owner_id, session_id, mime_type, size_bytes, file_name, data)
      SELECT c.copy_id, a.owner_id, a.session_id, a.mime_type, a.size_bytes, a.file_name, a.data
        FROM unnest(ARRAY[${Prisma.join([...copyOf.keys()])}]::uuid[],
                    ARRAY[${Prisma.join([...copyOf.values()])}]::uuid[]) AS c(source_id, copy_id)
        JOIN "attachment" a ON a.id = c.source_id`;
    return ids.map((id) => copyOf.get(id) ?? id);
  }

  /**
   * Verify the given attachment ids are the caller's and still unscoped (no session, no turn and
   * no task) — i.e. fresh uploads made on the compose page before any session existed. Returns
   * the de-duped ids. Throws on any unknown/foreign/already-scoped id so a bad reference is
   * rejected BEFORE the session is created. Used by create() for the seeded first turn.
   *
   * `taskId: null` is part of "unscoped" and not a redundancy: a task's INPUT template also has no
   * session and no turn, so without it a caller naming one would pass this check and be refused by
   * migration 0241's CHECK instead — a 500 with a constraint name in it, for a request whose real
   * answer is "that file belongs to a task". The template must never be consumable this way: it is
   * copied per dispatch precisely so that no one run can take it away from the task.
   */
  private async assertScopableAttachments(
    ownerId: string,
    attachmentIds: string[] | undefined,
  ): Promise<string[]> {
    const ids = [...new Set(attachmentIds ?? [])];
    if (ids.length === 0) return [];
    const found = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, ownerId, sessionId: null, turnId: null, taskId: null },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('one or more attachments are unknown, not yours, or already used');
    }
    return ids;
  }

  /** Stamp pre-validated attachments with the turn they belong to, so the inbox can
   *  deliver them. `turnId: null` in the filter keeps a concurrent link from double-using one. */
  private async linkAttachments(
    turnId: string,
    attachmentIds: string[],
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    if (attachmentIds.length === 0) return;
    await tx.attachment.updateMany({
      where: { id: { in: attachmentIds }, turnId: null },
      data: { turnId },
    });
  }

  /** Enqueue a user message for a live or still-queued (PENDING) session. */
  /**
   * On Automatic, the account an idle session's next message should not reach: one its runner's own
   * snapshot already reports spent (accountBeforeDispatch). The session moves to one with room and a
   * reload is queued ahead of the message — re-spawning the engine there with the conversation carried
   * across, as picking the account in the menu does (switchAccount) — instead of the message failing on
   * the limit first and being sent again after that failure's move. The columns to write, for the
   * caller's one Session write; null when nothing moves.
   *
   * Only an idle session (AWAITING_INPUT): a turn in flight finishes or fails where it is, and a
   * failure there makes the move itself.
   */
  private async accountMoveBeforeTurn(
    tx: Prisma.TransactionClient,
    session: Session,
  ): Promise<Prisma.SessionUncheckedUpdateInput | null> {
    if (session.status !== RunStatus.AWAITING_INPUT || !session.assignedRunnerId) return null;
    const engine: AccountEngine | null = isAccountEngine(session.provider) ? session.provider : null;
    if (!engine || !isBuiltinProvider(session.provider, session.providerBuiltin)) return null;
    const runner = await tx.runner.findUnique({
      where: { id: session.assignedRunnerId },
      select: { engines: true, accountNames: true, accountPauses: true, planUsage: true, capabilities: true },
    });
    if (!runner || !runnerCarriesAccounts(runner, engine)) return null;
    const workspace = session.workspaceId
      ? await tx.workspace.findUnique({
          where: { id: session.workspaceId },
          select: { env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true },
        })
      : null;
    const move = accountBeforeDispatch(
      engine,
      { account: session[ACCOUNT_CHOICE[engine]], pinned: session[ACCOUNT_PINNED[engine]] },
      workspace,
      runner.engines,
      runner.planUsage,
      new Date(),
      runner.accountPauses,
    );
    if (!move) return null;
    await this.insertTurnLocked(tx, session.id, {
      kind: 'reload',
      content: JSON.stringify({ provider: engine }),
      clientTurnId: randomUUID(),
    });
    return {
      [ACCOUNT_CHOICE[engine]]: move.to,
      // Said on the `resumed` that reload earns, unless another line is already owed.
      ...(session.poolSwitchNotice ? {} : { poolSwitchNotice: accountSwitchNotice(engine, move, runner) }),
    };
  }

  async createTurn(
    ownerId: string,
    id: string,
    dto: SessionTurnDto,
    opts?: {
      clearSettledWorktreeState?: boolean;
      /** §13.6 SU6: this turn carries the task's prompt, so the row is doing the task's work. */
      startsTaskWork?: boolean;
      /**
       * The run request this turn is being delivered FOR — see `create`'s own `fence`.
       *
       * A LIVE paused run is handed the task's prompt through here rather than through the revive
       * path below, so a fence that guarded only the revive would leave the door most task resumes
       * actually take unfenced: a delivery whose lease was taken over would still commit the turn.
       */
      fence?: TaskRunEffectFence;
      /** Orchestration's attempt charge. Invoked exactly once for a NEW, placeable turn, inside
       * this transaction after idempotency/target checks and before the turn is written. */
      participateSendTransaction?: (tx: Prisma.TransactionClient) => Promise<void>;
      /**
       * The session this turn is a message FROM (`conversation_turn.sender_session_id`,
       * session-message.ts). Set by the two session-to-session doors — `session_send` and
       * `project_send` — from the session their orchestration credential proved, and by nothing
       * else: it is an option of this call and never a field of `dto`, so no request body can name a
       * sender. Written on a NEW turn only; a replay returns the turn as it was written.
       */
      senderSessionId?: string;
      /** Full logical resume payload hash. Present only when resume delegates to this live path. */
      requestFingerprint?: string;
      /**
       * A NEXT_TURN message the server may write into the turn already running instead: filed as a
       * CURRENT_WORK steer aimed at the live engine turn when there is one and this runtime and its
       * runner can take an exact-target steer — the same two questions explicit CURRENT_WORK asks,
       * answered under the same Session lock in the same transaction — and as the NEXT_TURN message
       * it was otherwise. A route, never a refusal: nothing here answers 409 for a turn that cannot
       * steer. An option of this call and never a field of `dto`, so no request body can ask for it;
       * its callers are the platform's own deliveries: a background job's exit (runner-api
       * `backgroundWake`) and a session request's outcome handed back to its asker
       * (`SessionRequestService.handOff`).
       */
      steerIfLive?: boolean;
      /**
       * A turn that joins one already queued rather than adding another. Called for a NEW operation
       * only, under the Session lock and after the lifecycle refusals: a turn it returns is this
       * request's receipt, and nothing more is written or woken; null lets the turn be written as
       * usual. Whatever it wrote rolls back with a refusal it throws. `route` is where the turn would
       * be written — a `steer` names the running turn it joins — decided before this is called, so a
       * turn joined is one on the same route.
       */
      coalesce?: (
        tx: Prisma.TransactionClient,
        session: Session,
        route: { kind: 'message' | 'shell' | 'steer'; targetTurnId?: string },
      ) => Promise<ConversationTurn | null>;
      /**
       * What rides on the turn just written, written beside it: called once for a NEW turn, in this
       * transaction and under the Session lock, after the row exists — the session-to-session doors'
       * request (`session_request`, session-request.ts), which names the turn that carries it. A
       * replay of a committed key never reaches it, and a refusal it throws takes the turn with it.
       */
      onTurnWritten?: (tx: Prisma.TransactionClient, turn: ConversationTurn) => Promise<void>;
    },
  ) {
    assertPromptSize(dto.content, 'message');
    if (dto.intent !== undefined && dto.intent !== 'CURRENT_WORK' && dto.intent !== 'NEXT_TURN') {
      throw new BadRequestException('intent must be CURRENT_WORK or NEXT_TURN');
    }
    // Undefined is not an alias for NEXT_TURN: it is the installed N-1 auto-routing protocol.
    // Keep the distinction all the way to `send_intent` so mixed-version retries and dequeue can
    // preserve the behaviour that accepted the row.
    const intent = dto.intent;
    // Retried whole. This is where a user turn serializes against the runner's claim and against
    // turnComplete, and every one of those decisions is taken from the Session row read under the
    // lock inside the closure. A victim wrote no turn, so a re-run enqueues once — and the delivery
    // notice to the runner is outside the loop, after commit.
    const queued = await withTransactionRetry(this.prisma, async (tx) => {
      // THE RIGHT TO WRITE THIS TURN, first and held to commit. A delivery whose lease was taken
      // over while it was getting here must not enqueue the prompt anyway — the receipt would
      // refuse its answer afterwards, which reports the contradiction rather than preventing it.
      // Taken before the session row because it fences the REQUEST rather than the conversation.
      if (opts?.fence) await this.assertFenceHeld(tx, opts.fence);
      // Linearize against claim and turnComplete. If completion wins, it first releases
      // RUNNING->AWAITING_INPUT and this enqueue changes it to PENDING. If enqueue wins,
      // completion sees this turn and retains RUNNING. Neither ordering can lose a wakeup.
      // BLOCKING, deliberately. This is the point where an ordinary turn serializes against the
      // runner's claim and against `turnComplete`, and the waiting is the mechanism: whichever
      // arrives second sees the other's committed state, which is what makes a message delivered
      // exactly once rather than lost. NOWAIT here would turn a normal, short lock hold into a 409
      // and drop the user's turn.
      //
      // It is also not the acquisition that could deadlock: this transaction holds nothing else
      // yet. The revive path is the one that arrives here already holding a project and a task, and
      // that one takes the session NOWAIT for exactly that reason.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      // A committed operation owns its key even after its Session later ends or moves to Trash.
      // Check the durable receipt while holding the Session lock before any lifecycle, attachment
      // or budget decision. Hard purge remains a 404 because there is no owner-scoped Session row
      // (and its cascading receipts no longer exist).
      const existing = await tx.conversationTurn.findUnique({
        where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto.clientTurnId } },
        include: { attachments: { select: { id: true } } },
      });
      if (existing) {
        // A server-routed send may have been filed either way, and a missed steer is a NEXT_TURN
        // message by now: its retry replays whichever the row is.
        const routedSteer = opts?.steerIfLive === true
          && intent === 'NEXT_TURN'
          && dto.kind !== 'shell'
          && existing.sendIntent === 'CURRENT_WORK';
        if (
          (intent === 'CURRENT_WORK' && existing.sendIntent !== 'CURRENT_WORK')
          || (intent === 'NEXT_TURN'
            && existing.sendIntent != null
            && existing.sendIntent !== 'NEXT_TURN'
            && !routedSteer)
          || (intent === undefined && existing.sendIntent === 'CURRENT_WORK')
        ) {
          throw new ConflictException(`clientTurnId was already used with ${existing.sendIntent ?? 'legacy intent'}`);
        }
        const expectedKinds = intent === 'CURRENT_WORK' || routedSteer
          ? ['steer']
          : dto.kind === 'shell'
            ? ['shell']
            : intent === 'NEXT_TURN'
              ? ['message']
              : ['message', 'steer'];
        const storedAttachments = (existing.attachments ?? [])
          .map((attachment) => attachment.id)
          .sort();
        const expectedAttachments = expectedTurnAttachments(
          id,
          dto.clientTurnId,
          dto.attachmentIds,
          storedAttachments,
        );
        if (
          !expectedKinds.includes(existing.kind)
          || existing.content !== dto.content
          || expectedAttachments.length !== storedAttachments.length
          || expectedAttachments.some((attachmentId, index) => attachmentId !== storedAttachments[index])
          || (existing.requestFingerprint != null
            && existing.requestFingerprint !== opts?.requestFingerprint)
        ) {
          throw new ConflictException(
            'clientTurnId was already used with a different turn payload',
          );
        }
        return {
          turn: existing,
          placement: await this.turnPlacement(tx, id, existing),
          wakeQueue: false,
          wakeInbox: false,
          idempotent: true,
        };
      }
      // Only a genuinely new logical operation is subject to the Session's current lifecycle. A
      // response-lost retry must replay its committed receipt, not become a new refusal because
      // the turn completed or the user filed the Session in the meantime.
      if (session.deletedAt) {
        throw new SessionNotSendable('the session is in Trash; restore it before sending a message');
      }
      if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
        throw new SessionNotSendable('the session has ended');
      }
      // A server-routed send is placed before anything may join it: whether it goes into the running
      // turn or waits behind it decides which queued turn it can join, and a placement changed after
      // joining could only be undone in a second transaction — the fallback this lock exists to avoid.
      const steerTarget = opts?.steerIfLive && intent === 'NEXT_TURN' && dto.kind !== 'shell'
        ? await this.steerTargetIfLive(tx, id, session)
        : null;
      const joined = await opts?.coalesce?.(
        tx,
        session,
        steerTarget
          ? { kind: 'steer', targetTurnId: steerTarget.id }
          : { kind: dto.kind === 'shell' ? 'shell' : 'message' },
      );
      if (joined) {
        return {
          turn: joined,
          placement: await this.turnPlacement(tx, id, joined),
          wakeQueue: false,
          wakeInbox: false,
          // No new turn, but not the replay above either: the hook wrote something onto the turn it
          // joined — a second job's wake, a wakeup that came due — and `listQueuedTurns` now shows
          // that turn saying it. `idempotent` is read for exactly one decision, whether to tell
          // focused clients the queue moved, and this is a queue that moved.
          idempotent: false,
        };
      }
      // §13.6 SU6: a turn that carries the TASK's prompt is the task's work, whatever this row was
      // opened for. Written only for a new operation, in the same transaction as the turn.
      if (opts?.startsTaskWork) {
        await tx.session.update({ where: { id }, data: { startsTaskWork: true } });
      }
      // Heartbeat delivery is the server-side linearization point for manual git
      // mutations. A modern UUID-bearing unclaimed request (or a stale/orphaned one)
      // may be superseded by this turn — the merge/commit clears below drop it. A
      // claimed operation is instead still mutating the checkout, so the turn cannot
      // overtake it: it enqueues as PENDING and the claim fence (trySessionClaim)
      // keeps it out of a runner slot until the merge/commit result flips the status
      // off 'pending', at which point the worktree is free and the turn runs. This is
      // what lets a user send while "Merging…"/"Committing…" instead of being bounced.
      const mergeExecuting = pendingWorktreeOperationMayBeExecuting(
        session.mergeStatus,
        session.mergeOperationId,
        session.mergeOperationOwner,
        session.mergeRequestedAt,
      );
      const commitExecuting = pendingWorktreeOperationMayBeExecuting(
        session.commitStatus,
        session.commitOperationId,
        session.commitOperationOwner,
        session.commitRequestedAt,
      );
      // Check attachments only after the idempotency lookup: on a retry of a successful
      // request they are already linked to this same turn and must not make the retry fail.
      // For a genuinely new request validation still precedes the turn insert.
      const attachmentIds = await this.assertLinkableAttachments(
        ownerId,
        id,
        dto.clientTurnId,
        dto.attachmentIds,
        tx,
      );
      // A claim can race the lazy first-turn seed. While holding the same Session lock as
      // queue.buildSession, ensure an unestablished runtime cannot lose its opening prompt.
      if (session.numTurns === 0) await this.ensurePromptSeeded(tx, session, attachmentIds);

      let kind: 'message' | 'shell' | 'steer';
      let targetTurnId: string | undefined;
      if (intent === 'CURRENT_WORK') {
        if (dto.kind === 'shell') {
          throw currentWorkUnavailable(
            'SHELL_UNSUPPORTED',
            'CURRENT_WORK is only available for a message; shell commands must use NEXT_TURN',
          );
        }
        const liveTarget = await this.liveEngineTurn(tx, id);
        if (!liveTarget) {
          // liveEngineTurn already made the acceptance decision with PostgreSQL's clock and the
          // safety margin. This read only distinguishes its structured refusal reason; do not
          // reintroduce an application-clock lease decision here.
          const unusableLeaseTarget = await tx.conversationTurn.count({
            where: {
              sessionId: id,
              kind: 'message',
              status: 'IN_FLIGHT',
            },
          });
          throw currentWorkUnavailable(
            unusableLeaseTarget > 0 ? 'TARGET_LEASE_EXPIRED' : 'NO_CURRENT_WORK',
            unusableLeaseTarget > 0
              ? 'the current turn lease expired before this message could enter it'
              : 'there is no live message turn to receive CURRENT_WORK',
          );
        }
        if (!(await this.runtimeTakesSteer(tx, session))) {
          throw currentWorkUnavailable(
            'STEER_UNSUPPORTED',
            'this runtime or runner does not support acknowledged CURRENT_WORK delivery',
          );
        }
        // Capability resolution may make network-free DB reads, but wall time still moves. Recheck
        // the exact lease against the database clock immediately before charging/inserting.
        if (!(await this.liveEngineTurn(tx, id, liveTarget.id))) {
          throw currentWorkUnavailable(
            'TARGET_LEASE_EXPIRED',
            'the current turn lease expired before this message could enter it',
          );
        }
        await opts?.participateSendTransaction?.(tx);
        // The atomic orchestration charge above may itself wait on a task-attempt row. Its write
        // is part of this transaction, so reject after one last database-clock check and roll the
        // charge back if the target stopped being usable while that lock was acquired.
        if (!(await this.liveEngineTurn(tx, id, liveTarget.id))) {
          throw currentWorkUnavailable(
            'TARGET_LEASE_EXPIRED',
            'the current turn lease expired before this message could enter it',
          );
        }
        kind = 'steer';
        targetTurnId = liveTarget.id;
      } else if (steerTarget) {
        // Placed above, under this lock and before the turn could join anything.
        kind = 'steer';
        targetTurnId = steerTarget.id;
        await opts?.participateSendTransaction?.(tx);
      } else {
        if (intent === 'NEXT_TURN') {
          kind = dto.kind === 'shell' ? 'shell' : 'message';
        } else {
          // This is the exact N-1 rule. It remains inside the Session serialization boundary, but
          // intentionally has no target address or routing-v1 receipt: old clients sent one
          // unqualified message and the old server chose steer vs queue from the live turn.
          kind = dto.kind === 'shell'
            ? 'shell'
            : (await this.liveEngineTurn(tx, id))
                && (await this.runtimeTakesLegacySteer(tx, session))
              ? 'steer'
              : 'message';
        }
        // The orchestration verb is budgeted whichever way its message lands. Charged on exactly
        // one of the two paths, after the placement decision and before the row, so a refusal
        // rolls the charge back with the turn it was for.
        await opts?.participateSendTransaction?.(tx);
      }
      // On Automatic, an idle session whose account its runner's own snapshot already reports spent
      // moves to one with room before this message reaches it, a reload going ahead of it
      // (accountMoveBeforeTurn). Its columns ride on the one Session write below (lock-order I3).
      const accountMove = kind === 'message' ? await this.accountMoveBeforeTurn(tx, session) : null;
      // This is the authoritative queue placement: it is read before this row exists and while
      // the Session lock prevents dequeue/complete from changing its predecessors underneath it.
      // A steer takes precedence because it joins the running turn instead of waiting behind it.
      const placement = await this.turnPlacement(tx, id, { kind, status: 'PENDING' });
      const turn = await this.insertTurnLocked(tx, id, {
        // Whitelist: this endpoint cannot manufacture control turns.
        kind,
        content: dto.content,
        clientTurnId: dto.clientTurnId,
        ...(opts?.requestFingerprint ? { requestFingerprint: opts.requestFingerprint } : {}),
        // A server-routed steer is the CURRENT_WORK shape the row constraints accept for one.
        ...(steerTarget ? { sendIntent: 'CURRENT_WORK' } : intent ? { sendIntent: intent } : {}),
        ...(targetTurnId ? { targetTurnId } : {}),
        ...(opts?.senderSessionId ? { senderSessionId: opts.senderSessionId } : {}),
      });
      await this.linkAttachments(turn.id, attachmentIds, tx);
      await opts?.onTurnWritten?.(tx, turn);
      const nextStatus = statusAfterTurnEnqueued(session.status);
      await tx.session.update({
        where: { id },
        data: {
          status: nextStatus,
          lastTurnAt: new Date(),
          // The message the list previews while it waits to be answered. Written here, at
          // enqueue, rather than when the runner reports the user turn: between the two lies the
          // whole wait — for a runner slot, and for a message queued behind a running turn the
          // rest of that turn — and throughout it the row previewed the PREVIOUS reply, which is
          // the one thing that reads as "already answered". The runner's own `user` event rewrites
          // the same value; only a reply clears it (ANSWERS_USER_TURN). An attachment-only send
          // carries no text to preview and so leaves the column as it found it.
          ...(dto.content ? { lastUserText: dto.content } : {}),
          // A message on this session disarms any auto-retry waiting on it — whether it
          // came from the user (they took over; sending their own message again behind
          // their back would be a second, unasked-for turn) or from the sweeper itself
          // (the retry has now fired). Both routes into a new turn pass through here.
          // A claim the sweep left behind ends with them (migration 0354): this IS the turn it
          // promised, so the session stops reading as on its way to one.
          retryAt: null,
          retryClaimedAt: null,
          ...(accountMove ?? {}),
          ...(session.mergeStatus === 'pending' && !mergeExecuting
            ? {
                mergeStatus: null,
                mergeOperationId: null,
                mergeOperationOwner: null,
                mergeError: null,
              }
            : {}),
          ...(session.commitStatus === 'pending' && !commitExecuting
            ? {
                commitStatus: null,
                commitOperationId: null,
                commitOperationOwner: null,
                commitError: null,
                commitResultMessage: null,
              }
            : {}),
          // "Resolve in session" uses the live-session resume route. Clear its
          // settled receipt in this same row-locked update, never from the stale
          // fast-read snapshot: a newly queued/claimed epoch must win instead.
          ...(opts?.clearSettledWorktreeState && session.mergeStatus && session.mergeStatus !== 'pending'
            ? {
                mergeStatus: null,
                mergeOperationId: null,
                mergeOperationOwner: null,
                mergeError: null,
                mergedAt: null,
                mergedSourceSha: null,
                branchMerged: null,
              }
            : {}),
          ...(opts?.clearSettledWorktreeState && session.commitStatus && session.commitStatus !== 'pending'
            ? {
                commitStatus: null,
                commitOperationId: null,
                commitOperationOwner: null,
                commitError: null,
                commitResultMessage: null,
              }
            : {}),
        },
      });
      return {
        turn,
        placement,
        wakeQueue: nextStatus === RunStatus.PENDING,
        wakeInbox: nextStatus === RunStatus.RUNNING,
        idempotent: false,
      };
    }, loggedRetry(this.logger, 'sessions.createTurn', {
      // This transaction deliberately waits for the Session row: dequeue and turnComplete use
      // that lock as the routing linearization point. Prisma's 5s interactive-transaction default
      // is shorter than a legitimate contender can hold it, so make the deadline explicit.
      transaction: { maxWait: 10_000, timeout: 30_000 },
    }));
    if (queued.wakeQueue) this.queue.notifySessionQueued();
    if (queued.wakeInbox) this.realtime.notifyInbox(id);
    // No transcript event exists until the runner leases this turn. Tell every focused client to
    // refresh the durable queue now, so a message queued on web appears on iOS (and vice versa).
    if (!queued.idempotent) this.realtime.publishQueuedTurnsChanged(id);
    // `kind` is the server's own decision (message / shell / steer), and the only way the
    // caller learns which one it got: a steer joins the turn that is already running, while a
    // message queues behind it. Every entry point sends the same request, so this is what lets
    // web and the native clients tell "waiting its turn" from "going into this one" — and stop
    // offering to withdraw something that is already on its way.
    return {
      turnId: queued.turn.id,
      seq: queued.turn.seq,
      kind: queued.turn.kind,
      placement: queued.placement,
      ...('targetTurnId' in queued.turn && queued.turn.targetTurnId
        ? { targetTurnId: queued.turn.targetTurnId }
        : {}),
    };
  }

  /**
   * Abort the in-flight turn of a live session (the process stays alive), optionally
   * queuing what to do instead in the same transaction.
   *
   * Interrupt-and-send is one operation rather than two requests because interrupting
   * DROPS the follow-ups queued behind the running turn — stopping means stop, and a
   * queued message firing straight afterwards is the opposite of what was asked. A client
   * that interrupted and then sent would therefore be racing its own delete, and whether
   * the redirection survived would come down to which request the server saw first. Filed
   * here, after the delete and under the same row lock, the follow-up cannot be its own
   * casualty.
   *
   * The follow-up is filed as an ordinary `message`, deliberately not a steer: a steer is
   * written INTO the turn that is running, which is exactly what someone who just pressed
   * stop is not asking for. As a message it waits on the inbox gate (no executable turn in
   * flight) until the interrupted turn's result lands, so the new frame reaches the engine
   * only after the turn it replaces is actually over — and if the interrupt does not take,
   * it waits for that turn to finish on its own rather than being folded into it. Accepting
   * the request is not a claim that the engine stopped: only the engine's own answer settles
   * that, and the runner reports it as an `interrupt` transcript event.
   */
  async interrupt(
    ownerId: string,
    id: string,
    dto?: SessionInterruptDto,
    opts?: {
      /** Atomic orchestration budget participant. It runs only after a new follow-up's durable
       * idempotency receipt and payload have been checked, inside the Session transaction. */
      participateFollowUpTransaction?: (tx: Prisma.TransactionClient) => Promise<void>;
      /**
       * The session the follow-up is a message FROM — see `createTurn`'s own. Set by
       * `session_interrupt`'s door from the session its orchestration credential proved, and by
       * nothing else; written on the follow-up turn and never on the interrupt, which says nothing.
       */
      senderSessionId?: string;
    },
  ) {
    const content = dto?.content ?? '';
    const followUp = content.trim().length > 0 || (dto?.attachmentIds?.length ?? 0) > 0;
    if (followUp) {
      assertPromptSize(content, 'message');
      if (!dto?.clientTurnId) {
        throw new BadRequestException('clientTurnId is required when interrupting with a follow-up');
      }
    }
    // Mint once per logical call, outside the retried transaction. Follow-ups derive both durable
    // rows from the caller's stable key; a plain interrupt still gets one stable key if the
    // transaction itself is replayed after a serialization failure.
    const interruptClientTurnId = followUp
      ? SessionsService.interruptClientId(dto!.clientTurnId!)
      : randomUUID();
    const interruptPayload = followUp
      ? JSON.stringify({
          content,
          attachmentIds: [...new Set(dto?.attachmentIds ?? [])].sort(),
        })
      : undefined;
    // Retried whole: the interrupt is decided from the Session row re-read under its lock.
    const queued = await withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      // Keyed on the interrupt rather than on the message, because only the interrupt is
      // certainly still there: a later interrupt may have dropped the follow-up, and a
      // retry must not then re-file it. A control turn is never deleted, so its presence
      // is the durable record that this request already ran.
      if (followUp) {
        const already = await tx.conversationTurn.findUnique({
          where: {
            sessionId_clientTurnId: { sessionId: id, clientTurnId: interruptClientTurnId },
          },
          select: { id: true, content: true },
        });
        if (already) {
          if (already.content !== interruptPayload) {
            throw new ConflictException(
              'clientTurnId was already used with a different interrupt follow-up payload',
            );
          }
          // A retry: everything below already happened. Re-running it would delete the
          // follow-up this request queued and file a second interrupt behind it.
          const turn = await tx.conversationTurn.findUnique({
            where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto!.clientTurnId! } },
            select: { id: true, seq: true },
          });
          return { turn, wakeQueue: false, wakeInbox: false, idempotent: true };
        }
      }
      // A committed follow-up is returned above even if the Session later ended or was filed in
      // Trash. Only a new operation is judged against the lifecycle it is trying to mutate.
      if (!SessionsService.LIVE.includes(session.status) || session.cancelRequestedAt) {
        throw new ConflictException('the session has ended');
      }
      // The same bar createTurn holds a message to. Stopping a trashed session's work is
      // still allowed — it is running, and stopping is the whole point — but nothing new
      // may be queued onto it behind that.
      if (followUp && session.deletedAt) {
        throw new ConflictException('the session is in Trash; restore it before sending a message');
      }
      // Checked before anything is dropped, so a request that cannot be honoured leaves
      // the queue exactly as it found it.
      const attachmentIds = followUp
        ? await this.assertLinkableAttachments(
          ownerId,
          id,
          dto!.clientTurnId!,
          dto?.attachmentIds,
          tx,
        )
        : [];
      if (followUp) await opts?.participateFollowUpTransaction?.(tx);
      // Explicit CURRENT_WORK is durable authored input, not a disposable queue row. Settle it
      // with a visible failed-delivery receipt before removing ordinary queued work.
      const terminalized = await terminalizePendingCurrentWorkSteers(tx, id, {
        code: CURRENT_WORK_INTERRUPTED,
        reason: 'CURRENT_WORK was not delivered because the session was interrupted.',
      });
      const protectedTargetIds = terminalized.targetTurnIds;
      // Every follow-up still queued goes below, retired in place or deleted, a Watch wake among them:
      // its delivery stops reading DELIVERED first, and nothing queues the wake again
      // (watches/watch-wake-drain.ts).
      await deadLetterQueuedWatchWakes(tx, id, { code: 'OBSERVER_TURN_INTERRUPTED' });
      // A `bg-wake:` turn is deleted by that same statement, and what it was to deliver is kept beside
      // it rather than in it: the delete alone would leave a job's wakes under the key its next wake
      // reuses, and a due wakeup settled onto a turn that is gone. Both are settled with the turns
      // here — every one of them, because an interrupt drops the whole queue and not one named turn
      // (runner-api/wake-turn-withdraw.ts). A refusal below rolls this back too.
      await settleUnrunWakeTurns(tx, id, { interrupted: true });
      // An exception item queued behind the interrupted turn is taken back unrun. The conversation
      // lives on, so the item stays the coordinator's and is delivered again when its next turn ends.
      await returnQueuedTurns(tx, id, { code: 'TURN_INTERRUPTED' });
      // A request another session queued here was never read: it is UNDELIVERED, and its asker is
      // told. Outcomes queued back to THIS session as an asker are held for its next turn — stopping
      // means stopping, not running on to read a reply (sessions/session-request.ts).
      await settleUnrunSessionRequests(tx, id, { code: 'TURN_INTERRUPTED' });
      if (protectedTargetIds.length > 0) {
        // Target FKs intentionally prevent individual deletion. Retire an undelivered seed in
        // place so its attachments and clientTurnId receipt remain auditable.
        await tx.conversationTurn.updateMany({
          where: { sessionId: id, id: { in: protectedTargetIds }, status: 'PENDING' },
          data: { status: 'ANSWERED', answeredAt: new Date() },
        });
      }
      // Drop queued-but-undelivered follow-ups: interrupting means "stop", so they
      // should not fire after the current turn is aborted. Queued `!cmd` shell turns go
      // too — they sit in the same "waiting behind the running turn" queue (as the
      // executable count below already assumes), and leaving them behind ran a command
      // the user had just told to stop. A queued steer goes for the same reason and one
      // more: it would be written into the very turn being stopped.
      await tx.conversationTurn.deleteMany({
        where: {
          sessionId: id,
          kind: { in: ['message', 'shell', 'steer'] },
          status: 'PENDING',
          ...(protectedTargetIds.length > 0 ? { id: { notIn: protectedTargetIds } } : {}),
        },
      });
      if (session.status === RunStatus.RUNNING) {
        const executable = await tx.conversationTurn.count({
          where: {
            sessionId: id,
            kind: { in: ['message', 'shell'] },
            status: { in: ['PENDING', 'IN_FLIGHT'] },
          },
        });
        if (executable === 0) {
          // turnComplete already handed the slot to a queued follow-up, but that next
          // turn has not been leased. Dropping it would strand the runner-local permit;
          // roll back and let the caller retry once the next turn actually starts.
          throw new ConflictException('the next turn is already starting');
        }
      }
      await this.insertTurnLocked(tx, id, {
        kind: 'interrupt',
        clientTurnId: interruptClientTurnId,
        ...(interruptPayload ? { content: interruptPayload } : {}),
      });
      if (!followUp) {
        return { turn: null, wakeQueue: false, wakeInbox: true, idempotent: false };
      }
      // A claim can race the lazy first-turn seed, exactly as in createTurn: under this
      // same lock, make sure an unestablished runtime cannot lose its opening prompt.
      if (session.numTurns === 0) await this.ensurePromptSeeded(tx, session);
      const turn = await this.insertTurnLocked(tx, id, {
        kind: 'message',
        content,
        clientTurnId: dto!.clientTurnId!,
        ...(opts?.senderSessionId ? { senderSessionId: opts.senderSessionId } : {}),
      });
      await this.linkAttachments(turn.id, attachmentIds, tx);
      const nextStatus = statusAfterTurnEnqueued(session.status);
      await tx.session.update({
        where: { id },
        data: {
          status: nextStatus,
          lastTurnAt: new Date(),
          // The redirected message is what the session is waiting on now — previewed from here
          // exactly as in createTurn.
          ...(content ? { lastUserText: content } : {}),
          // The person took over: an auto-retry waiting on this session must not fire a
          // second, unasked-for turn behind the one they just redirected to. A claim the sweep had
          // in flight ends for the same reason (migration 0354) — this turn is not its.
          retryAt: null,
          retryClaimedAt: null,
        },
      });
      return {
        turn,
        wakeQueue: nextStatus === RunStatus.PENDING,
        wakeInbox: true,
        idempotent: false,
      };
    }, loggedRetry(this.logger, 'sessions.interrupt'));
    // The inbox is woken unconditionally: the interrupt turn is what it is waiting for, and
    // it is deliverable the moment this commits, whatever the follow-up's status implies.
    if (queued.wakeQueue) this.queue.notifySessionQueued();
    if (queued.wakeInbox) this.realtime.notifyInbox(id);
    if (!queued.idempotent) this.realtime.publishQueuedTurnsChanged(id);
    return queued.turn
      ? { ok: true as const, turnId: queued.turn.id, seq: queued.turn.seq }
      : { ok: true as const };
  }

  /** The clientTurnId the interrupt half of an interrupt-and-send is filed under, derived
   *  from the follow-up's so one key makes the whole operation idempotent. */
  private static interruptClientId(clientTurnId: string): string {
    return `interrupt-${clientTurnId}`;
  }

  /** The session's user turns that do not have a transcript event yet, oldest first. `active` is
   *  an explicit web-client opt-in: it includes the accepted executable across dequeue → first
   *  event as well as queued successors. In that view, once a listed turn's durable `user` event
   *  exists it is omitted again, even if a tail-paged client has not loaded that older event:
   *  otherwise a long IN_FLIGHT turn reopens with its opening message synthesized at the end of
   *  the transcript.
   *  The default preserves the installed native contract by returning only rows it can truthfully
   *  render as queued/on-the-way without understanding
   *  placement — PENDING queued successors and steers, never the accepted head or IN_FLIGHT rows.
   *  `!cmd` shell turns queue and cross that handoff like messages do, so they're classified too.
   *
   *  Both projections carry the same cards for the rows they return (`TurnCards`, turn-cards.ts — an
   *  exception item's delivery among them, §4.4 X-D2), because both ends draw the queued tail: the
   *  native one reads THIS projection, and a delivery whose card only came with the `active` view
   *  would be prose on a phone and a card in a browser for as long as it waits.
   *
   *  A still-PENDING `steer` is listed for the same reason and NOT for the same purpose: it
   *  is not waiting its turn, it is on its way into the one already running, and the runner
   *  usually takes it within a poll. But until it does, a reload has nothing else to render it
   *  from — the transcript event only exists once the runner leases it — and a message that
   *  vanishes on refresh is the one outcome mid-turn sending must not produce. Callers tell the
   *  two apart by `kind`: a steer must not be offered a withdraw, because cancelQueuedTurn
   *  refuses it (a message the engine may already be reading is not withdrawable).
   *
   *  Classification comes from one ordered snapshot containing PENDING and IN_FLIGHT rows. The
   *  initial prompt is not returned, but remains in that snapshot because it can be the head that
   *  makes every later message/shell truly queued. In the active view, IN_FLIGHT rows are returned:
   *  they bridge the dequeue → first-user-event window and, as the executable head, remain
   *  accepted/non-cancellable. Splitting the head probe from the returned-row query would let a
   *  lease/complete between the two make one response contradict itself. */
  listQueuedTurns(ownerId: string, id: string, view: 'active'): Promise<ListedActiveTurn[]>;
  listQueuedTurns(ownerId: string, id: string, view?: undefined): Promise<ListedQueuedTurn[]>;
  async listQueuedTurns(
    ownerId: string,
    id: string,
    view?: 'active',
  ): Promise<ListedQueuedTurn[] | ListedActiveTurn[]> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      // What the cards are read against (turn-cards.ts): whose rows they may name, and the task a
      // run's brief was built from.
      select: { id: true, ownerId: true, taskId: true, runSource: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const turns = await this.prisma.conversationTurn.findMany({
      // One snapshot, including rows that are needed only to identify the executable head.
      where: {
        sessionId: id,
        kind: { in: ['message', 'shell', 'steer'] },
        OR: [
          { status: { in: ['PENDING', 'IN_FLIGHT'] } },
          ...(view === 'active'
            ? [{ sendIntent: 'CURRENT_WORK', deliveryStatus: { in: ['FAILED', 'UNCONFIRMED'] } }]
            : []),
        ],
      },
      orderBy: { seq: 'asc' },
      // Carry each queued turn's image refs so the composer can still render them after a
      // reload (the local object-URL previews are gone by then) — e.g. an image-only turn.
      select: {
        id: true,
        seq: true,
        clientTurnId: true,
        kind: true,
        targetTurnId: true,
        deliveryStatus: true,
        deliveryFailureCode: true,
        deliveryFailureReason: true,
        status: true,
        content: true,
        createdAt: true,
        senderSessionId: true,
        attachments: { select: { id: true, mimeType: true } },
      },
    });
    const headExecutableId = turns.find((t) => t.kind === 'message' || t.kind === 'shell')?.id;
    const initialClientTurnId = SessionsService.initialTurnClientId(id);
    const wakeContent = await this.queuedWakeContent(id, turns);
    const classified = turns
      // A background job's wake turn carries nobody's words (runner-api/background-job-wake.ts) and
      // is not a message anyone queued — but it IS a row waiting to be delivered, and a client that
      // cannot see it cannot say the session is about to be woken. So it is listed with the block it
      // will be delivered with (queuedWakeContent), and left out exactly where it has nothing to
      // show: no wakes filed on it, or already leased, where the transcript is what shows it.
      //
      // A turn handing back the outcomes of this session's requests is the same kind of row
      // (sessions/session-request.ts): listed with the blocks it will be delivered with.
      .filter((turn) => turn.clientTurnId !== initialClientTurnId
        && (!isPlatformContentTurn(turn.clientTurnId) || wakeContent.has(turn.id)))
      .map((turn) => ({
        turn,
        content: wakeContent.get(turn.id) ?? turn.content ?? '',
        // A wake is never the `accepted` head, whichever seq it sits at: `accepted` says the runner
        // has this one, so web represents it as the person's own message bridged into the
        // transcript (queuedTurnFromActiveSnapshot) and the queue-only view drops it. Neither is
        // true of a wake. `headExecutableId` above still counts it, so its genuinely queued
        // successor is not promoted into the place it vacates.
        placement: (turn.kind === 'steer'
          ? 'steer'
          : isPlatformContentTurn(turn.clientTurnId)
            ? 'queued'
            : turn.id === headExecutableId
              ? 'accepted'
              : 'queued') as TurnPlacement,
      }));
    if (view !== 'active') {
      const queued = classified
        .filter(({ turn, placement }) => turn.status === 'PENDING' && placement !== 'accepted');
      // The cards, for the same reason the active view carries them and by the same read: the
      // narrow projection is what the installed native client draws its queue from, and a delivery
      // it cannot see the card on is 30 lines of prose in the reader's own bubble until the runner
      // takes the turn — the reading this row's whole shape exists to avoid (web parity: the
      // queue tail, `WorkspaceView`). Read after the filter, so an accepted head the native client
      // will not see costs no card read.
      const cards = await readTurnCards(this.prisma, session, queued.map(({ turn }) => turn));
      return queued.map(({ turn, content }) => {
        return {
          turnId: turn.id,
          kind: turn.kind,
          content,
          attachments: turn.attachments.map((attachment) => ({
            id: attachment.id,
            mimeType: attachment.mimeType,
          })),
          ...cards.get(turn.id),
          ...(isOrbitAuthoredTurn(turn.clientTurnId) ? { authoredByOrbit: true as const } : {}),
        };
      });
    }
    // `run_event` is append-only, so probing after the active-turn snapshot is monotone in the safe
    // direction: an event that committed meanwhile suppresses a fallback that is no longer needed;
    // one that commits after this query is the live event that replaces the short-lived fallback.
    // Do this only after placement is computed over ALL active turns. Filtering the announced head
    // first would promote its genuinely queued successor to `accepted`.
    const announcedTargetIds = turns.map((turn) => turn.id);
    const transcriptReceipts = announcedTargetIds.length === 0
      ? []
      : await this.prisma.runEvent.findMany({
          where: {
            sessionId: id,
            OR: [
              { type: RunEventType.USER, turnId: { in: announcedTargetIds } },
              {
                type: RunEventType.USER_DELIVERY,
                payload: { path: ['delivery'], equals: 'failed' },
              },
            ],
          },
          select: { type: true, turnId: true, payload: true },
        });
    const announcedTurnIds = new Set(
      transcriptReceipts.flatMap((event) =>
        event.type === RunEventType.USER && event.turnId ? [event.turnId] : []),
    );
    const failedDeliveryTurnIds = new Set(
      transcriptReceipts.flatMap((event) => {
        if (event.type !== RunEventType.USER_DELIVERY) return [];
        const payload = event.payload as { delivery?: unknown; turnId?: unknown } | null;
        if (payload?.delivery !== 'failed') return [];
        const turnId = typeof payload.turnId === 'string' ? payload.turnId : event.turnId;
        return turnId && announcedTargetIds.includes(turnId) ? [turnId] : [];
      }),
    );
    const activeRows = classified
      // A USER(enqueued/written) is only optimistic progress. Once the durable receipt says
      // FAILED it must remain visible and override that transcript state; no synthetic failed
      // run_event is written by the server, so suppressing it here would strand the UI forever.
      // Conversely, a runner-authored USER_DELIVERY(failed) already renders the terminal result;
      // returning the row as well would paint the same Not delivered bubble twice after reload.
      .filter(({ turn }) => {
        if (turn.deliveryStatus === 'FAILED') return !failedDeliveryTurnIds.has(turn.id);
        if (turn.deliveryStatus === 'UNCONFIRMED') return true;
        return !announcedTurnIds.has(turn.id);
      });
    // The cards these turns are drawn as, for the rows this snapshot actually returns.
    const cards = await readTurnCards(this.prisma, session, activeRows.map(({ turn }) => turn));
    const activeTurns: ListedActiveTurn[] = activeRows
      .map(({ turn, placement, content }) => {
        return {
          turnId: turn.id,
          kind: turn.kind,
          placement,
          ...(turn.targetTurnId ? { targetTurnId: turn.targetTurnId } : {}),
          ...(turn.deliveryStatus === 'FAILED' || turn.deliveryStatus === 'UNCONFIRMED'
            ? {
                delivery: (turn.deliveryStatus === 'FAILED' ? 'failed' : 'unconfirmed') as
                  'failed' | 'unconfirmed',
                ...(turn.deliveryFailureCode ? { deliveryCode: turn.deliveryFailureCode } : {}),
                ...(turn.deliveryFailureReason
                  ? { deliveryReason: turn.deliveryFailureReason }
                  : {}),
              }
            : {}),
          ...cards.get(turn.id),
          ...(isOrbitAuthoredTurn(turn.clientTurnId) ? { authoredByOrbit: true as const } : {}),
          content,
          createdAt: turn.createdAt.toISOString(),
          attachments: turn.attachments.map((attachment) => ({
            id: attachment.id,
            mimeType: attachment.mimeType,
          })),
        };
      });
    // ES sort is stable: equal timestamps preserve the turn query's seq order. Breaking a tie by
    // unrelated UUID would reorder the executable head behind its queued successor in a recovered
    // snapshot.
    return [...activeTurns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** What each of the session's still-queued wake turns has to say, by turn id.
   *
   *  A wake turn's own `content` is empty and stays empty: what it says lives beside it, in the
   *  rows the claim transaction reads to build the block it hands the runner — a job's wakes
   *  (background-job-wake.ts) and the wakeups that came due (scheduled-wakeup.ts). That is what
   *  keeps a turn nobody typed out of `last_user_text`, out of auto-retry's re-send and out of
   *  every other read of the person's words; none of them reads this list.
   *
   *  Both sets of rows are written in the same transaction that files the turn, so they can be
   *  read while it is still queued — and they are read HERE by the very functions delivery calls,
   *  not by a second rendering of them. The card a client draws while the wake waits is therefore
   *  the block that will be delivered, with no copy of it to drift.
   *
   *  Only while the turn is PENDING: once a runner has leased it the block has been delivered and
   *  the transcript is what shows it. A turn with nothing to say is absent from the map and left
   *  out of the list — that empty row is what listing every wake turn would otherwise produce. */
  private async queuedWakeContent(
    sessionId: string,
    turns: ReadonlyArray<{ id: string; clientTurnId: string | null; status: string; kind: string }>,
  ): Promise<Map<string, string>> {
    const wakeContent = new Map<string, string>();
    for (const turn of turns) {
      if (!turn.clientTurnId || turn.status !== 'PENDING') continue;
      if (isSessionReplyTurn(turn.clientTurnId)) {
        // In the turn's own kind too: a reply steer's blocks say which turn they join.
        const replies = await queuedRepliesContent(this.prisma, sessionId, turn.clientTurnId, turn.kind);
        if (replies) wakeContent.set(turn.id, replies);
        continue;
      }
      if (isConfirmationReviewContentTurn(turn.clientTurnId)) {
        const block = await queuedConfirmationReviewContent(this.prisma, turn.clientTurnId);
        if (block) wakeContent.set(turn.id, block);
        continue;
      }
      if (!isBackgroundWakeTurn(turn.clientTurnId)) continue;
      const { clientTurnId } = turn;
      // In the turn's own kind, as the claim writes it: a steer's block says which turn it joins.
      const jobs = await appendBackgroundWakeContext(this.prisma, sessionId, clientTurnId, '', turn.kind);
      const block = await appendScheduledWakeupContext(this.prisma, sessionId, clientTurnId, jobs);
      if (block) wakeContent.set(turn.id, block);
    }
    return wakeContent;
  }

  /** Withdraw a queued user message or `!cmd` shell turn. Only a still-PENDING one can be
   *  cancelled; once the runner has leased it (IN_FLIGHT) it's already feeding claude / already
   *  running, and will appear in the transcript, so cancelling is rejected.
   *
   *  Also the door for discarding a CURRENT_WORK message whose delivery settled undelivered:
   *  the engine never received it, so it is still the sender's to take back. */
  async cancelQueuedTurn(ownerId: string, id: string, turnId: string) {
    await this.getSendable(ownerId, id);
    // Retried whole. A cancel is a compare-and-set against a turn still queued; an attempt the
    // server discarded cancelled nothing, so a re-run either still finds it queued or reports the
    // same 'already gone' the first attempt would have.
    await withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
        throw new ConflictException('the session has ended');
      }
      // A Watch wake is withdrawn like any queued message, and then no runner will take it: its delivery
      // stops reading DELIVERED first (watches/watch-wake-drain.ts). A withdrawal refused below rolls
      // that back with it.
      await deadLetterQueuedWatchWakes(tx, id, { code: 'WAKE_WITHDRAWN', turnId });
      // A `bg-wake:` turn is withdrawn the same way, and carries the same kind of payload beside it:
      // the job wakes and the due wakeup settled onto it, which the delete alone would leave pointing
      // at a turn that is gone (runner-api/wake-turn-withdraw.ts). Refusals below roll this back too.
      await settleUnrunWakeTurns(tx, id, { turnId });
      // Same for an exception item's turn withdrawn from the queue: taken back unrun, still owed.
      await returnQueuedTurns(tx, id, { code: 'TURN_WITHDRAWN', turnId });
      // And a request another session asked of this one, withdrawn unread: UNDELIVERED. A reply turn
      // withdrawn here leaves its outcomes held for this session's next turn (session-request.ts).
      await settleUnrunSessionRequests(tx, id, { code: 'TURN_WITHDRAWN', turnId });
      const res = await tx.conversationTurn.deleteMany({
        // The seeded prompt turn isn't a withdrawable follow-up — never let it be cancelled.
        where: {
          id: turnId,
          sessionId: id,
          kind: { in: ['message', 'shell'] },
          status: 'PENDING',
          clientTurnId: { not: SessionsService.initialTurnClientId(id) },
        },
      });
      if (res.count === 0) {
        // A steer whose delivery already settled undelivered is the exception to that refusal.
        // It is not on its way anywhere: the boundary that failed it is durable, no engine read
        // it, and the row exists only to say so. Left un-withdrawable it is a bubble with no
        // exit, which is how "Not delivered" ends up sitting under a conversation that moved on
        // days ago. Discarding one changes no executable count, so the queue-slot bookkeeping
        // below deliberately does not run.
        const discarded = await tx.conversationTurn.deleteMany({
          where: {
            id: turnId,
            sessionId: id,
            kind: 'steer',
            sendIntent: 'CURRENT_WORK',
            deliveryStatus: { in: ['FAILED', 'UNCONFIRMED'] },
          },
        });
        if (discarded.count > 0) return;
        // A steer is the one thing here that is refused for a reason of its own rather than
        // for being gone: it is not waiting its turn, it is on its way into the one already
        // running, and the engine may be reading it as we ask. Saying "already started or
        // not found" would send a client looking for a race that never happened, so name it.
        const steer = await tx.conversationTurn.findFirst({
          where: { id: turnId, sessionId: id, kind: 'steer' },
          select: { id: true },
        });
        throw new ConflictException(
          steer
            ? 'this message is being written into the running turn and can no longer be withdrawn'
            : 'message already started or not found',
        );
      }

      // Sending to AWAITING_INPUT changes the Session to PENDING. If that last queued
      // message is withdrawn before claim, restore the idle state instead of letting an
      // empty claim consume a slot forever.
      const executable = await tx.conversationTurn.count({
        where: {
          sessionId: id,
          kind: { in: ['message', 'shell'] },
          status: { in: ['PENDING', 'IN_FLIGHT'] },
        },
      });
      if (executable === 0 && session.status === RunStatus.RUNNING) {
        // Claim has already reserved a runner-local permit but the runner has not leased
        // this turn yet. Deleting the last executable turn would leave that handoff with
        // no /turn-complete capable of releasing its local permit. Roll the delete back;
        // from the user's perspective the message has crossed the "started" boundary.
        throw new ConflictException('message already started or not found');
      }
      if (executable === 0 && session.status === RunStatus.PENDING) {
        await tx.session.update({
          where: { id },
          data: { status: RunStatus.AWAITING_INPUT, lastTurnAt: new Date() },
        });
      }
    }, loggedRetry(this.logger, 'sessions.cancelQueuedTurn'));
    this.realtime.notifyInbox(id);
    this.realtime.publishQueuedTurnsChanged(id);
    return { ok: true };
  }

  /** End a live session (closes the runner's claude process). */
  async end(ownerId: string, id: string) {
    const session = await this.getSendable(ownerId, id);
    await this.endOpen(ownerId, id, SessionEndReason.ENDED);
    return { ok: true };
  }

  /**
   * Queue a "merge this session's worktree branch into main" for the runner that ran it.
   * Worktree-isolated sessions only, whose `branch` holds committed work (auto-committed at
   * /complete for a finished session, or via {@link commitWorktree} for a live one) and whose
   * `assignedRunnerId` still points at the machine whose local repo holds it. The runner is
   * woken to pick the request up at once (else on its next heartbeat, ≤30s), merges its branch's
   * committed state into main (the live checkout, if any, is a separate worktree and is
   * undisturbed), and reports the outcome back into `mergeStatus`/`mergeError`/`mergedAt`.
   * Idempotent while a merge is already pending; re-requesting a merged/conflicted session
   * re-queues it.
   *
   * `targetBranch` is the branch to merge INTO, picked from the status bar's dropdown; it's
   * stored on `mergeTarget` and relayed to the runner. Omitted/empty → the default (the runner
   * auto-detects main, else master). A target equal to the session's own branch is rejected.
   *
   * An explicit target picked in the owner's own Merge menu is also remembered on the session's
   * workspace (`defaultMergeTarget`), so switching the target sticks across all of that
   * workspace's sessions — the next merge button defaults to it. Cleared back to the auto-detect
   * default is not offered here (picking main from the dropdown re-records main). Only that door
   * passes `rememberTarget`. A merge the platform or an agent asks for names the branch ONE piece
   * of work goes to, and every project shares the workspace, so remembering it would send every
   * other session's next merge into that project's branch (`docs/project-integration-line-contract.md` L7).
   *
   * `waitSeconds` makes this call synchronous. The merge is queued exactly as it always is; the
   * request is then held until the runner has reported an outcome, and that outcome comes back
   * INLINE — see {@link awaitMergeConclusion}. Omitted, nothing here changes at all: the answer is
   * `{ ok: true }`, which is what the Merge button asks for and what every existing caller reads.
   */
  async mergeToMain(
    ownerId: string,
    id: string,
    targetBranch?: string,
    waitSeconds?: number,
    options: { rememberTarget?: boolean; recoveryAction?: MergeRecoveryAction; previewId?: string } = {},
  ) {
    if (options.recoveryAction && !['preview', 'apply', 'sync-local'].includes(options.recoveryAction)) {
      throw new BadRequestException('invalid merge recovery action');
    }
    const wait = SessionsService.mergeWaitSeconds(waitSeconds);
    const target = targetBranch?.trim() || null;
    // The operation this call is about, for a caller that asked to wait on it. Assigned inside the
    // closure because `withTransactionRetry` may run it again, and each run re-derives it.
    let operationId: string | null = null;
    // The runner a merge this call queued is waiting on, re-derived by each run like the id above.
    let queuedOn: string | null = null;
    // Retried whole. The worktree-operation claim is taken under the Session row lock inside the
    // closure, so a re-run competes for it from the state that exists. The runner is only told
    // about the operation after this returns.
    const workspaceId = await withTransactionRetry(this.prisma, async (tx) => {
      queuedOn = null;
      // Queueing, heartbeat claim, new-turn enqueue, Adopt, and terminal Resume
      // all linearize on this row. An old click therefore cannot create a fresh
      // operation after the session has already entered a new turn epoch.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      if (session.isolationStatus !== 'worktree' || !session.branch) {
        throw new BadRequestException('session has no worktree branch to merge');
      }
      if (!session.assignedRunnerId) {
        throw new ConflictException('no runner is associated with this session');
      }
      if (target && target === session.branch) {
        throw new BadRequestException("can't merge a branch into itself");
      }
      if (session.mergeStatus === 'pending') {
        // Idempotent, and that is what a waiting caller waits on: the operation already in flight
        // IS this call's operation. Minting a second one here would merge the same branch twice
        // because somebody asked twice.
        operationId = session.mergeOperationId;
        return null;
      }

      if (session.commitStatus === 'pending') {
        throw new ConflictException('wait for the pending worktree commit to finish');
      }
      if (
        !SessionsService.TERMINAL.includes(session.status) &&
        (session.status !== RunStatus.AWAITING_INPUT || !!session.cancelRequestedAt)
      ) {
        throw new ConflictException('wait for the current turn to finish before merging');
      }
      if (options.recoveryAction) {
        const runner = await tx.runner.findUnique({
          where: { id: session.assignedRunnerId }, select: { capabilities: true },
        });
        if (!runner?.capabilities.includes(SESSION_MERGE_RECOVERY_V1)) {
          throw new ConflictException('upgrade this runner to check and repair target branches');
        }
        const recovery = readMergeRecovery(session.mergeRecovery);
        if (options.recoveryAction !== 'preview') {
          if (!recovery || !options.previewId || recovery.previewId !== options.previewId ||
              (target && recovery.targetBranch !== target)) {
            throw new ConflictException('the recovery preview is no longer current; check again');
          }
          const retry = session.mergeRecoveryAction === 'apply' &&
            ['PUSH_FAILED', 'REMOTE_NOT_VERIFIED'].includes(recovery.code);
          if (options.recoveryAction === 'apply' && !mergeRecoveryReady(recovery) && !retry) {
            throw new ConflictException('review a ready candidate before applying it');
          }
          if (options.recoveryAction === 'sync-local' && recovery.code !== 'LOCAL_SYNC_PENDING') {
            throw new ConflictException('no landed candidate is waiting for local sync');
          }
        }
      }
      // `[K6]` §7, the dispatch gate: everything that can be decided before a repository is
      // touched. Two questions, and the ORDER is the point.
      //
      // "Is it already there" comes first, because a source the target already contains needs no
      // checkpoint, no evidence and no scope comparison — there is nothing to merge, so every
      // refusal below would be answering a question nobody is asking. That order is exactly what
      // was missing when a session whose branch and `main` pointed at the SAME commit was asked to
      // merge again: the one guard in the path compared the two branch NAMES, which differed, and
      // twenty-two commits were replayed from a base recorded days earlier onto a target that
      // already contained every one of them.
      //
      // The refusals are `[K1]`'s frozen §7 codes and are terminal: no queue, no backoff, no
      // operation. What this deliberately does NOT judge is the branch tip and the evidence digest
      // — the API server has no repository, and a gate that guessed there would be refusing on a
      // value it invented. Those two are decided by the runner against `requiredSourceSha`, and by
      // the receipt writer when a caller claims a landing and names the commit it landed.
      const gate = await mergeDispatchGate(tx, {
        ownerId,
        sessionId: id,
        taskId: session.taskId,
        targetBranch: target ?? session.mergeTarget ?? '',
      });
      if (gate.decision === 'ALREADY_LANDED' && !options.recoveryAction) return { alreadyLanded: gate };
      if (gate.decision !== 'ALLOWED' && gate.decision !== 'ALREADY_LANDED' && options.recoveryAction !== 'sync-local') {
        throw new ConflictException(`${gate.decision}: ${gate.detail}`);
      }

      operationId = randomUUID();
      await tx.session.update({
        where: { id },
        data: {
          mergeStatus: 'pending',
          mergeTarget: target ?? (options.recoveryAction ? readMergeRecovery(session.mergeRecovery)?.targetBranch ?? null : null),
          mergeRecoveryAction: options.recoveryAction ?? null,
          ...(!options.recoveryAction ? { mergeRecovery: Prisma.DbNull } : {}),
          mergeRequestedAt: new Date(),
          mergeOperationId: operationId,
          // `[K6]` §7: which checkpoint THIS operation was authorised for, persisted with the
          // operation id it is part of. When the result comes back the server checks the reported
          // commit against this rather than against anything the runner sent — a gate that only
          // holds when the client cooperates is not a gate. Null for unmanaged work, which is
          // almost every merge, and which is then unaffected by all of this.
          mergeCheckpointId: options.recoveryAction === 'apply' || options.recoveryAction === 'sync-local' || gate.decision !== 'ALLOWED' ? session.mergeCheckpointId : gate.checkpointId,
          mergeOperationOwner: null,
          mergeError: null,
          ...(!['preview', 'sync-local'].includes(options.recoveryAction ?? '') ? {
            mergedAt: null,
            mergedSourceSha: null,
            branchMerged: null,
          } : {}),
        },
      });
      queuedOn = session.assignedRunnerId;
      return session.workspaceId;
    }, loggedRetry(this.logger, 'sessions.mergeToMain'));
    // Have that runner heartbeat now instead of at its next 30s tick: whoever pressed Merge is
    // watching a spinner. Only a nudge; a lost wake leaves the merge to that tick.
    if (queuedOn) this.realtime.notifyRunnerWake(queuedOn);
    if (workspaceId && typeof workspaceId === 'object' && 'alreadyLanded' in workspaceId) {
      // Nothing was queued and nothing will be executed: the receipt that already says this landed
      // IS the answer. Handing it back rather than re-running the merge is the whole of CP4's
      // "重复投递的同一回执只生效一次" at the request end of the wire.
      const landed = workspaceId.alreadyLanded;
      const receipt = await this.prisma.sessionMergeReceipt.findFirst({
        where: { id: landed.receiptId, ownerId },
      });
      const row = receipt ? mergeReceiptRow(receipt as unknown as MergeReceiptRow) : null;
      // A waiting caller gets ONE shape whatever happened, and this is a conclusion: there is
      // nothing to wait for because the receipt in hand already says the work is in the target.
      if (wait !== null) {
        return {
          outcome: 'SETTLED' as const,
          operationId: null,
          mergeStatus: 'merged' as const,
          receipt: row,
          receiptAbsentReason: row ? null : ('NO_RECEIPT_RECORDED' as const),
          nextStep: null,
        };
      }
      return {
        ok: true as const,
        alreadyMerged: true as const,
        sourceSha: landed.sourceSha,
        targetSha: landed.targetSha,
        receipt: row,
      };
    }
    // Remember a target the owner picked in their Merge menu on the workspace, so every session of it
    // defaults there. No other merge writes it back — see `rememberTarget` above.
    if (options.rememberTarget && target && workspaceId) {
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { defaultMergeTarget: target },
      });
    }
    if (wait !== null) return this.awaitMergeConclusion(ownerId, id, operationId, wait);
    return { ok: true };
  }

  /**
   * The longest a caller may hold the request open waiting for a merge, and how often the wait
   * looks. Five minutes because the floor can be a heartbeat — when the wake is lost,
   * `runloop.go`'s ticker is 30 seconds, so the runner does not even READ the command before
   * then — and a ceiling below a few multiples of that would make the parameter useless for the
   * one merge it exists for.
   */
  private static readonly MERGE_WAIT_MAX_SECONDS = 300;
  private static readonly MERGE_WAIT_POLL_MS = 250;

  /** `waitSeconds` as the rest of this path may assume it: a whole number of seconds in range, or
   *  null for "the caller did not ask to wait" — which is every existing caller. */
  private static mergeWaitSeconds(value: number | undefined | null): number | null {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 1 || value > SessionsService.MERGE_WAIT_MAX_SECONDS) {
      throw new BadRequestException(
        `waitSeconds must be a whole number of seconds from 1 to ${SessionsService.MERGE_WAIT_MAX_SECONDS}`,
      );
    }
    return value;
  }

  /**
   * Hold the request until this merge has an outcome, and hand that outcome back inline.
   *
   * WHY, because the shape is the whole point. `{ ok: true }` means "queued", and a caller who does
   * not already know a second tool exists reads it as "merged". That is not hypothetical: a
   * coordinator asked twice to merge a branch that conflicts, was told `ok: true` twice, concluded
   * the tool had swallowed the failure, and went off to re-derive the conflict with `git
   * merge-tree` — while the result, both conflicting paths and git's own message sat in a receipt
   * nobody had thought to ask for. So a waiting call NEVER gets a bare `ok: true`. It gets one
   * envelope, in every case, and the envelope says which of the two things is true: an outcome
   * (`SETTLED`, with the receipt `merge_receipts` would serve — the same shape, not a second
   * spelling of it) or no outcome yet (`TIMED_OUT`, saying so, naming the operation still in flight
   * and where to read it later).
   *
   * The server cannot merge anything itself — the checkout is the runner's — so this is a wait, not
   * a takeover: it polls the two facts the runner's own report writes, under the operation this
   * call queued, and changes nothing.
   */
  private async awaitMergeConclusion(
    ownerId: string,
    sessionId: string,
    operationId: string | null,
    waitSeconds: number,
  ) {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, ownerId },
        select: { mergeStatus: true },
      });
      // The runner's report writes the receipt and this column in ONE transaction, so a status that
      // has left `pending` means whatever receipt this merge produced is already readable.
      const mergeStatus = session?.mergeStatus ?? null;
      if (mergeStatus !== null && mergeStatus !== 'pending') {
        const receipt = await this.mergeOutcomeReceipt(ownerId, sessionId, operationId, mergeStatus);
        return {
          outcome: 'SETTLED' as const,
          operationId,
          mergeStatus,
          receipt,
          receiptAbsentReason: receipt ? null : ('NO_RECEIPT_RECORDED' as const),
          nextStep: receipt
            ? null
            : 'this merge recorded no checkable receipt — the runner named no source commit, so ' +
              '`mergeStatus` above is the whole of what it reported',
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          outcome: 'TIMED_OUT' as const,
          operationId,
          mergeStatus,
          receipt: null,
          receiptAbsentReason: 'MERGE_STILL_RUNNING' as const,
          nextStep:
            `no outcome after ${waitSeconds}s, and none is claimed here: the merge is still queued ` +
            `as operation ${operationId ?? '(none recorded)'}. A runner picks a merge up on its ` +
            'next heartbeat, which ticks every 30 seconds, so a shorter wait than that times out ' +
            'even for a merge that then succeeds. Read the outcome with merge_receipts on this ' +
            'session, or ask again with a longer waitSeconds.',
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(SessionsService.MERGE_WAIT_POLL_MS, remaining)),
      );
    }
  }

  /**
   * The receipt this concluded merge produced, in `merge_receipts`' own shape.
   *
   * Found by the operation id the runner echoes onto `detail` — and, failing that, by the newest
   * receipt whose result agrees with the status the session just reached. The fallback is not
   * belt-and-braces: asking twice to merge a branch that conflicts is exactly the case this whole
   * parameter exists for, and the second attempt reports an outcome identical to the first, whose
   * receipt is therefore skipped by MR4's idempotency key. Without the fallback the caller who
   * waited would be told "settled, no receipt" while the receipt describing that very conflict sat
   * one row away.
   */
  private async mergeOutcomeReceipt(
    ownerId: string,
    sessionId: string,
    operationId: string | null,
    mergeStatus: string,
  ) {
    const byOperation = operationId
      ? await this.prisma.sessionMergeReceipt.findFirst({
          where: { sessionId, ownerId, detail: { path: ['operationId'], equals: operationId } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : null;
    if (byOperation) return mergeReceiptRow(byOperation as unknown as MergeReceiptRow);
    const results = MERGE_RECEIPT_RESULTS.filter(
      (result) => mergeStatusForResult(result) === mergeStatus,
    );
    if (results.length === 0) return null;
    const latest = await this.prisma.sessionMergeReceipt.findFirst({
      where: { sessionId, ownerId, result: { in: [...results] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return latest ? mergeReceiptRow(latest as unknown as MergeReceiptRow) : null;
  }

  /**
   * Queue a "commit this idle session's uncommitted worktree changes onto its branch" for the
   * runner that's hosting it. The checkout is only stable between turns: committing while the
   * top-level turn or a sub-workspace is still running can capture a half-built snapshot.
   * `AWAITING_INPUT` plus an empty sub-workspace set is therefore the authoritative server-side gate;
   * the UI's disabled button is only a convenience, not the safety boundary.
   *
   * Running background shells (`runningBgShells`) are NOT part of the gate. Workspaces leave
   * long-lived processes up — dev servers, watchers — which never exit, so their launch ids never
   * clear and gating on them disabled Commit permanently for that session. A commit racing a
   * background writer is re-committable; a permanently blocked one isn't.
   *
   * The runner is woken to pick the request up at once (else on its next heartbeat, ≤30s),
   * commits, and reports the outcome back into `commitStatus`/`commitError` (clearing
   * `worktreeDirty` on success, so the bar flips to Merge). Idempotent while a commit is already
   * pending.
   *
   * An ENDED session is admitted on one condition: its checkout still reports uncommitted changes.
   * This endpoint used to refuse every finished session with "its work is already committed",
   * which was the runner's intention rather than an observation — when finalization's `git add`
   * or `git commit` was refused (a stale `index.lock` in the checkout's git dir is enough), the
   * work stayed in the checkout and this was the door that could have put it on the branch,
   * bolted shut by the assumption that it never needed to be open. Nothing is running in an
   * ended session's checkout, so the idle gate below has nothing left to protect; `worktreeDirty`
   * is the whole precondition, and a session that really did commit everything reports false and
   * is refused exactly as before.
   */
  async commitWorktree(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (session.isolationStatus !== 'worktree' || !session.branch) {
      throw new BadRequestException('session has no worktree to commit');
    }
    const ended = !SessionsService.LIVE.includes(session.status);
    if (ended && session.worktreeDirty !== true) {
      throw new ConflictException('the session has ended — its work is already committed');
    }
    if (!ended && session.cancelRequestedAt) {
      throw new ConflictException('the session has ended — its work is already committed');
    }
    if (!ended && session.status !== RunStatus.AWAITING_INPUT) {
      throw new ConflictException('wait for the current turn to finish before committing');
    }
    if (!ended && session.runningSubagents.length > 0) {
      throw new ConflictException('wait for the running sub-workspace to finish before committing');
    }
    if (!session.assignedRunnerId) {
      throw new ConflictException('no runner is associated with this session');
    }
    if (session.commitStatus === 'pending') return { ok: true };
    if (session.mergeStatus === 'pending') {
      throw new ConflictException('wait for the pending branch merge to finish');
    }

    // Close the read→write race with a turn starting (or background work being recorded)
    // after the checks above. A plain update would still queue a commit against the now-active
    // checkout. updateMany turns the same idle predicates into an atomic compare-and-set.
    //
    // An ended session's race is the opposite one — it can only be RESUMED, which would put a turn
    // back in the checkout — so the predicate that has to hold is that it is still ended and still
    // reports work the branch does not have.
    const idle = ended
      ? { status: { notIn: [...SessionsService.LIVE] }, worktreeDirty: true }
      : {
          status: RunStatus.AWAITING_INPUT,
          cancelRequestedAt: null,
          runningSubagents: { isEmpty: true },
        };
    const queued = await this.prisma.session.updateMany({
      where: {
        id,
        ownerId,
        ...idle,
        commitStatus: session.commitStatus,
        mergeStatus: session.mergeStatus,
      },
      data: {
        commitStatus: 'pending',
        commitRequestedAt: new Date(),
        commitOperationId: randomUUID(),
        commitOperationOwner: null,
        commitError: null,
        commitResultMessage: null,
      },
    });
    if (queued.count === 0) {
      // A concurrent identical request may have won the compare-and-set. Keep the endpoint
      // idempotent in that case; every other transition means the checkout is no longer safe.
      const current = await this.prisma.session.findFirst({ where: { id, ownerId } });
      const stillCommittable =
        current != null &&
        (SessionsService.LIVE.includes(current.status)
          ? current.status === RunStatus.AWAITING_INPUT &&
            !current.cancelRequestedAt &&
            current.runningSubagents.length === 0
          : current.worktreeDirty === true);
      if (current?.commitStatus === 'pending' && stillCommittable) {
        return { ok: true };
      }
      if (current?.mergeStatus === 'pending') {
        throw new ConflictException('wait for the pending branch merge to finish');
      }
      throw new ConflictException(
        'the session is no longer idle — wait for its current work to finish',
      );
    }
    // As for a merge: have the runner heartbeat now rather than at its next 30s tick.
    this.realtime.notifyRunnerWake(session.assignedRunnerId);
    return { ok: true };
  }

  /**
   * Adopt the worktree's ACTUAL current HEAD branch as the session's tracked branch. When the
   * workspace ran `git checkout -b` inside the worktree, the work moved onto a branch Orbit wasn't
   * tracking — `session.branch` still names the original (often already-merged) branch, so the bar
   * shows "On <worktreeBranch> — not tracked" instead of a stale "✓ In main". Adopting re-points
   * `branch` to that HEAD so Merge / diff / the "in main" verdict all act on the real work.
   *
   * Pure server-side: the runner already computes live worktree state (diff base, branchMerged)
   * on its real HEAD and the merge command reads `session.branch` fresh each heartbeat, so no
   * runner round-trip is needed — the swap takes effect on the next report. The stale fork point
   * and merge verdict are cleared so the runner's next report re-derives them for the new branch.
   */
  async adoptWorktreeBranch(ownerId: string, id: string) {
    // Retried whole: one locked re-read decides whether the branch may be re-pointed.
    return withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      if (session.isolationStatus !== 'worktree') {
        throw new BadRequestException('session has no worktree to adopt a branch from');
      }
      if (
        pendingWorktreeOperationMayBeExecuting(
          session.mergeStatus,
          session.mergeOperationId,
          session.mergeOperationOwner,
          session.mergeRequestedAt,
        ) ||
        pendingWorktreeOperationMayBeExecuting(
          session.commitStatus,
          session.commitOperationId,
          session.commitOperationOwner,
          session.commitRequestedAt,
        )
      ) {
        throw new ConflictException('wait for the pending worktree operation to finish');
      }
      const target = session.worktreeBranch?.trim();
      if (!target) {
        throw new ConflictException('the runner has not reported the worktree branch yet');
      }
      if (target === session.branch) {
        throw new BadRequestException('the worktree is already on the tracked branch');
      }
      await tx.session.update({
        where: { id },
        data: {
          branch: target,
          // The adopted branch has its own fork point + merge state: clear the stale ones (they
          // described the old branch) so the runner's next report re-derives the diff base.
          baseSha: null,
          mergeStatus: null,
          mergeOperationId: null,
          mergeOperationOwner: null,
          mergeError: null,
          mergedAt: null,
          mergedSourceSha: null,
          branchMerged: null,
        },
      });
      return { ok: true, branch: target };
    }, loggedRetry(this.logger, 'sessions.adoptWorktreeBranch'));
  }

  /**
   * Stop a session and settle it to CANCELLED — unlike {@link end}, which reaches the same
   * status under 'ended' and so still reads as dormant/resumable. A PENDING session is
   * finalized in place (while any prior warm runtime is cancelled); other open states receive
   * an end control. No-op (returns false) if already terminal or already ending.
   *
   * `reason` records who called it off. CANCELLED is a person stopping the run
   * (TasksService.batchStop). TASK_CANCELLED is the work item itself going away
   * (TasksService deleting the task) — a *graceful* reason, so a runner that never honors the
   * end is force-finalized to CANCELLED by the reaper instead of being recorded as a run
   * failure. Nothing failed: the task was withdrawn.
   */
  async cancel(
    ownerId: string,
    id: string,
    reason: SessionEndReason = SessionEndReason.CANCELLED,
  ): Promise<boolean> {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) return false;
    return this.endOpen(ownerId, id, reason);
  }

  /**
   * Linearize send/claim/end on the Session row. A still-PENDING session is settled
   * directly; RUNNING/AWAITING_INPUT/INTERRUPTED gets an end control for its runtime.
   * This avoids stale pre-lock status reads creating PENDING+cancelRequestedAt wedges.
   */
  private async endOpen(
    ownerId: string,
    sessionId: string,
    reason: SessionEndReason,
  ): Promise<boolean> {
    const ended = await this.transitionEnd(ownerId, sessionId, reason);
    if (!ended.changed) return false;
    this.publishEndIntent(sessionId, ended);
    return true;
  }

  /**
   * Persist an end intent and, optionally, its filing destination under one Session
   * row lock. This method deliberately has no realtime/runner side effects: callers
   * emit those only after the transaction commits.
   */
  private async transitionEnd(
    ownerId: string,
    sessionId: string,
    reason: SessionEndReason,
    lifecycle?: 'completedAt' | 'deletedAt',
    requireNoProjectBinding = false,
  ): Promise<{
    changed: boolean;
    runnerId: string | null;
    status: RunStatus;
    lifecycleState: SessionLifecycleState;
    /** @deprecated Compatibility representation of lifecycleState. */
    filingState: SessionFilingState;
    endReason: SessionEndReason | null;
    projectBound: boolean;
  }> {
    // Retried whole. Every terminal transition is decided from the Session row under its lock, so a
    // re-run sees whichever end actually committed rather than re-applying one that did not.
    return withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${sessionId}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId } });
      if (requireNoProjectBinding) {
        // Every Project binding path takes this same Session lock first. A non-locking lookup made
        // after acquiring it therefore decides a stable fact: an existing adopter is preserved,
        // while a future adopter cannot pass the deleted_at guard until this transaction commits.
        const project = await tx.project.findFirst({
          where: { coordinatorSessionId: sessionId },
          select: { id: true },
        });
        if (project) {
          return {
            changed: false,
            runnerId: session.assignedRunnerId,
            status: session.status,
            lifecycleState: deriveSessionLifecycleState(session),
            filingState: deriveSessionFilingState(session),
            endReason:
              session.endReason == null ? null : (session.endReason as SessionEndReason),
            projectBound: true,
          };
        }
      }
      if (lifecycle === 'completedAt' && session.deletedAt != null) {
        throw new ConflictException(
          'a session in Trash must be moved to Open before it can be completed',
        );
      }
      const now = new Date();
      // Keep the first filing timestamp stable across retries. This matters especially
      // for deletedAt, which starts the Trash retention clock.
      const lifecycleData: {
        completedAt?: Date;
        /** @deprecated Rolling-version compatibility mirror. */
        archivedAt?: Date;
        deletedAt?: Date;
      } = {};
      let finalCompletedAt = session.completedAt ?? session.archivedAt;
      let finalDeletedAt = session.deletedAt;
      if (lifecycle === 'completedAt' && finalCompletedAt == null) {
        lifecycleData.completedAt = now;
        // Keep old replicas and clients coherent during the compatibility window.
        lifecycleData.archivedAt = now;
        finalCompletedAt = now;
      }
      if (lifecycle === 'deletedAt' && session.deletedAt == null) {
        lifecycleData.deletedAt = now;
        finalDeletedAt = now;
      }
      const lifecycleState = deriveSessionLifecycleState({
        completedAt: finalCompletedAt,
        deletedAt: finalDeletedAt,
      });
      const filingState = deriveSessionFilingState({
        completedAt: finalCompletedAt,
        deletedAt: finalDeletedAt,
      });
      if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
        if (Object.keys(lifecycleData).length > 0 || requireNoProjectBinding) {
          await tx.session.update({
            where: { id: sessionId },
            data: {
              ...lifecycleData,
              ...(requireNoProjectBinding ? { titleManagedByProject: false } : {}),
            },
          });
        }
        return {
          changed: false,
          runnerId: session.assignedRunnerId,
          status: session.status,
          lifecycleState,
          filingState,
          endReason:
            session.endReason == null ? null : (session.endReason as SessionEndReason),
          projectBound: false,
        };
      }
      await terminalizePendingCurrentWorkSteers(tx, sessionId, {
        code: CURRENT_WORK_SESSION_ENDED,
        reason: 'CURRENT_WORK was not delivered because the session ended.',
      });
      // Both branches below retire every queued message, a Watch wake among them: its delivery
      // stops reading DELIVERED first (watches/watch-wake-drain.ts).
      await deadLetterQueuedWatchWakes(tx, sessionId, {
        code: 'OBSERVER_SESSION_ENDED',
        ending: `an end was requested: ${reason}`,
      });
      // An exception item queued for this project's coordinator goes back to being owed, and to the
      // account owner: a conversation that is ending cannot read it (projects/project-open-item.ts).
      await returnQueuedTurns(tx, sessionId, { code: 'SESSION_ENDED', ending: true });
      // Outcomes queued back to this session as an asker are let go, to be held for it and written on
      // its task. The requests queued here are left to the end itself: the status write below (or the
      // finalize after it) closes them RECIPIENT_ENDED, which wins over UNDELIVERED (session-request.ts).
      await settleUnrunSessionRequests(tx, sessionId, { code: 'SESSION_ENDED', closesRequests: false, retryArmed: false });
      if (session.status === RunStatus.PENDING) {
        await tx.session.update({
          where: { id: sessionId },
          data: {
            ...lifecycleData,
            ...(requireNoProjectBinding ? { titleManagedByProject: false } : {}),
            status: RunStatus.CANCELLED,
            endReason: reason,
            cancelRequestedAt: now,
            finishedAt: now,
            // A queued session can still be holding what its last run left running — a job parked
            // with the session and never reaped — and CANCELLED is the end of the line for it
            // (CLEARED_RUNNING_WORK). The runner is told to stop by the same cancelRequestedAt,
            // and what its drain then reports is refused: this status has closed the door.
            ...CLEARED_RUNNING_WORK,
          },
        });
        await retireSessionInboxGeneration(tx, sessionId);
        await tx.conversationTurn.updateMany({
          where: { sessionId, status: { not: 'ANSWERED' } },
          data: { status: 'ANSWERED', answeredAt: now },
        });
      } else {
        await tx.session.update({
          where: { id: sessionId },
          data: {
            ...lifecycleData,
            ...(requireNoProjectBinding ? { titleManagedByProject: false } : {}),
            cancelRequestedAt: now,
            endReason: reason,
          },
        });
        // Retire queued messages in place. This prevents replay while preserving target FKs,
        // attachments and clientTurnId receipts as durable audit evidence.
        await tx.conversationTurn.updateMany({
          where: { sessionId, kind: 'message', status: 'PENDING' },
          data: { status: 'ANSWERED', answeredAt: now },
        });
        await this.insertTurnLocked(tx, sessionId, {
          kind: 'end',
          clientTurnId: randomUUID(),
        });
      }
      return {
        changed: true,
        runnerId: session.assignedRunnerId,
        status: session.status === RunStatus.PENDING ? RunStatus.CANCELLED : session.status,
        lifecycleState,
        filingState,
        endReason: reason,
        projectBound: false,
      };
    }, loggedRetry(this.logger, 'sessions.transitionEnd'));
  }

  /** Emit runner/control-plane effects for a newly persisted end intent. */
  private publishEndIntent(
    sessionId: string,
    ended: {
      changed: boolean;
      runnerId: string | null;
    },
  ): void {
    if (!ended.changed) return;
    // PENDING sessions settle synchronously to CANCELLED and will never receive runner STATUS.
    // The full summary carries taskId, letting task lists clear queued immediately. Live-session
    // end intents also publish safely here; their later finalize event remains authoritative.
    this.realtime.publishSessionUpdated(sessionId);
    this.realtime.publishQueuedTurnsChanged(sessionId);
    if (ended.runnerId) this.realtime.requestCancel(ended.runnerId, sessionId);
    this.realtime.notifyInbox(sessionId);
  }

  /**
   * Pending (or all) tool-permission approvals for a session the caller owns.
   *
   * A `PENDING` row is not by itself a question somebody can still answer, and asking for the
   * pending ones is asking which ones are. Nothing writes to the row when the asking ends: the
   * engine polls for a decision without a wall-clock cap (`runner-go/mcp.go`) and `approval` has no
   * expiry column, so a call the engine gave up on — and a card whose turn was reclaimed — leaves
   * it exactly as the runner wrote it. A client that goes on offering it takes a person's answer
   * and delivers it to nobody, because the poll loop that would have consumed it died with the
   * turn; a surface that looks answerable and silently is not is worse than no surface
   * (`docs/completion-input-routing.md` §A2 D1).
   *
   * A row is offered while either reader this product has is still there to take an answer, and
   * there are exactly two:
   *
   *   - the turn it was raised in. That is the whole of `stillBeingAsked` for a card that names no
   *     job, and two committed facts end it: the session is not generating — `isSessionGenerating`
   *     is already the predicate for "which sessions can be holding a live approval", and the one
   *     the per-workspace badge counts with, so a dead card stopped being counted long before it
   *     stopped being shown — and the tool call this approval was raised for already has a result,
   *     which is what the engine abandoning the call writes and the only trace it leaves while the
   *     turn runs on;
   *   - the runner-hosted job a card names (`approval.background_job_id`, migration 0291). That
   *     process is the asker's reader and it OUTLIVES the turn by construction, so the turn decides
   *     nothing for such a card: it is a question while the job is up, and `abandoned-approvals.ts`
   *     collects it when the job goes. Without this half the card a job is polling for was simply
   *     invisible on a parked conversation — the job waiting, the row PENDING, and every surface
   *     saying nobody was asking.
   *
   * Neither is a clock and neither writes anything: the row is left as it stands, a listing that
   * asks for any other status is untouched, and the question an unanswered evidence card was about
   * is still on the decision rail's derived read (`pending-evidence-judgments.ts`).
   */
  async listApprovals(ownerId: string, id: string, status?: string): Promise<ApprovalInfo[]> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true, status: true, engineTurnActive: true, runningBgShells: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const approvals = await this.prisma.approval.findMany({
      where: { sessionId: id, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const answerable = status === 'PENDING' ? await this.stillBeingAsked(session, approvals) : approvals;
    return answerable.map((a) => this.toApprovalInfo(a));
  }

  /**
   * The `PENDING` rows an answer could still reach, on the readers `listApprovals` names.
   *
   * Which reader a card has is decided by the card: one that names a runner-hosted job is read by
   * that process and by nothing else — it may have been filed while no turn was in flight at all —
   * so its job settles it and the turn is not consulted. Everything else is read by the turn it was
   * raised in, which is why the generating check and the finished-call read apply to those and to
   * those only. Both halves are the reaper's own rule (`readByLiveBackgroundJob`,
   * `abandoned-approvals.ts`), so a card leaves this list exactly where it stops being answerable.
   */
  private async stillBeingAsked<
    T extends { id: string; toolUseId: string | null; backgroundJobId: string | null },
  >(
    session: {
      id: string;
      status: RunStatus;
      engineTurnActive: boolean;
      runningBgShells: string[];
    },
    approvals: T[],
  ): Promise<T[]> {
    if (approvals.length === 0) return approvals;
    const generating = isSessionGenerating(session);
    const raised = approvals
      .filter((a) => a.backgroundJobId === null)
      .map((a) => a.toolUseId)
      .filter((id): id is string => id !== null);
    // An old runtime sent no tool_use id, so its rows can never be paired with a result and are
    // left alone: this drops a card on evidence that it is over, never on the absence of it. The
    // read is skipped when there is nothing the turn could tell us about — no id to pair against,
    // or a turn that is not running, which leaves its cards over whatever the calls say.
    const over =
      raised.length === 0 || !generating
        ? new Set<string>()
        : new Set(
            (
              await this.prisma.toolCall.findMany({
                where: {
                  sessionId: session.id,
                  toolUseId: { in: raised },
                  finishedAt: { not: null },
                },
                select: { toolUseId: true },
              })
            ).map((call) => call.toolUseId),
          );
    return approvals.filter((a) =>
      a.backgroundJobId === null
        ? generating && (a.toolUseId === null || !over.has(a.toolUseId))
        : readByLiveBackgroundJob(a, session.runningBgShells),
    );
  }

  /** Record a human allow/deny on a pending approval; the runner's long-poll picks
   *  it up and returns it to claude's --permission-prompt-tool. */
  async decideApproval(
    ownerId: string,
    id: string,
    approvalId: string,
    dto: ApprovalDecisionRequest,
  ): Promise<ApprovalInfo> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true, workspaceId: true },
    });
    if (!session) throw new NotFoundException('session not found');
    if (dto.behavior !== 'allow' && dto.behavior !== 'deny') {
      throw new BadRequestException('behavior must be "allow" or "deny"');
    }
    const status = dto.behavior === 'allow' ? 'ALLOWED' : 'DENIED';
    // Only the first decision on a still-PENDING approval applies (idempotent).
    const res = await this.prisma.approval.updateMany({
      where: { id: approvalId, sessionId: id, status: 'PENDING' },
      data: {
        status,
        message: dto.message ?? null,
        answers: dto.answers ? (dto.answers as Prisma.InputJsonValue) : Prisma.DbNull,
        // Only an allow can carry "remember same kind" rules; the runner reads them off
        // the long-poll and adds them to claude's session permissions. Stored as a JSON
        // array (the schemaless `remember_rule` column holds either shape).
        rememberRule:
          dto.behavior === 'allow' && dto.rememberRules?.length
            ? (dto.rememberRules as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        decidedById: ownerId,
        decidedAt: new Date(),
      },
    });
    const a = await this.prisma.approval.findFirst({ where: { id: approvalId, sessionId: id } });
    if (!a) throw new NotFoundException('approval not found');
    if (res.count > 0) {
      // Only the decision that actually landed writes the standing grant: a second, losing
      // click on an already-answered approval must not widen anything.
      if (dto.behavior === 'allow' && session.workspaceId) {
        await this.rememberForWorkspace(session.workspaceId, ownerId, approvalId, dto.rememberRules);
      }
      this.realtime.publish(id, {
        seq: 0,
        type: RunEventType.APPROVAL_RESOLVED,
        payload: { id: approvalId, behavior: dto.behavior },
        ts: new Date().toISOString(),
      });
    }
    return this.toApprovalInfo(a);
  }

  /** Persist "always allow" rules on the workspace this session belongs to, so its other and
   *  later sessions start with them (see WorkspacePermissionRule). Duplicates are skipped by
   *  the unique index, so re-approving something already granted is a no-op rather than a
   *  second row. A session with no workspace stores nothing — the decision still applies to
   *  the running session through the runner's long-poll, as it always did. */
  private async rememberForWorkspace(
    workspaceId: string,
    ownerId: string,
    approvalId: string,
    rules: PermissionRule[] | undefined,
  ): Promise<void> {
    const stored = normalizePermissionRules(rules);
    if (!stored.length) return;
    await this.prisma.workspacePermissionRule.createMany({
      data: stored.map((rule) => ({
        workspaceId,
        toolName: rule.toolName,
        ruleContent: rule.ruleContent,
        createdById: ownerId,
        approvalId,
      })),
      skipDuplicates: true,
    });
  }

  private toApprovalInfo(a: {
    id: string;
    sessionId: string;
    toolName: string;
    input: Prisma.JsonValue;
    toolUseId: string | null;
    backgroundJobId: string | null;
    status: string;
    message: string | null;
    createdAt: Date;
    decidedAt: Date | null;
  }): ApprovalInfo {
    return {
      id: a.id,
      sessionId: a.sessionId,
      toolName: a.toolName,
      input: a.input,
      toolUseId: a.toolUseId ?? undefined,
      backgroundJobId: a.backgroundJobId ?? undefined,
      status: a.status as ApprovalStatus,
      message: a.message ?? undefined,
      createdAt: a.createdAt.toISOString(),
      decidedAt: a.decidedAt?.toISOString(),
    };
  }

  /**
   * Revive an ended session with a new user message. The same Session row goes back
   * to PENDING so its assigned runner re-claims it and resumes the existing runtime
   * context rather than starting fresh. Requires that runner to be online because the
   * transcript lives on its disk.
   */
  /**
   * A placeholder runtime id used only to DERIVE capabilities on a read (see `get`).
   *
   * Never written. It exists so `deriveSessionCapabilities` answers the question it is being asked
   * — "would a resume of this row work" — rather than the question the un-repaired row spells,
   * without the read having to write to make that true. The real id is minted inside the revive
   * transaction, once the task fence has let it through.
   */
  private static readonly RESUMABLE_PROJECTION = '00000000-0000-4000-8000-000000000000';

  /**
   * §13.6 SU6 for one task, as the sentence every entry point uses.
   *
   * Both halves in one read: the task's own retirement, and — when it is a verification — its
   * subject's. The second is the one that used to reach callers as a raw `check_violation` from
   * 0130's guard, because nothing above the database asked it.
   *
   * `locked` takes the rows `FOR SHARE`, which is what makes it a fence rather than a check: used
   * inside the revive transaction, a supersession committing concurrently either lands before this
   * read (and is seen) or waits for this transaction (and applies to a row already resumed).
   */
  /**
   * §13.1 AG6's sentence, and the marker AutoRetry keys its permanent stand-down on.
   *
   * A constant rather than a formatted string: `AutoRetryService` has to tell this refusal apart
   * from the ordinary "it failed again" so it can DISARM instead of re-arming, and matching on a
   * shared constant is the only version of that which cannot drift from what is thrown.
   */
  static readonly AGGREGATE_PARENT_REFUSAL =
    'this task is completed by its declared completion owner, so it has no work of its own to run';

  /**
   * @param startsTaskWork whether the operation being judged is the TASK's work.
   *
   * §13.6 SU6's refusal is CATEGORICAL — reviving a replaced attempt is refused whoever asks and
   * whatever the turn is for, because nothing on the row separates a person from the sweep. §13.1
   * AG6's is not, and the difference is the whole reason this parameter exists: an aggregate parent
   * is a row you may legitimately open a session ABOUT — read it, ask it a question, salvage
   * something from a run that stopped. What it may not have is a session doing its WORK, because
   * that is the thing its subtasks are for. Applying the aggregate arm unconditionally would refuse
   * every conversation on a roll-up node, which is both wrong and the opposite of a wedge's exit.
   */
  private async taskWorkRefusalFor(
    db: Prisma.TransactionClient | PrismaService,
    taskId: string,
    locked = false,
    startsTaskWork = true,
  ): Promise<string | null> {
    // §13.1 AG6 rides on the same read. A resume that hands a task its own work is a dispatch by
    // another name: the row was a legal leaf when it ran and the task has since become an aggregate
    // parent, so reviving it would put a Worker back on a row whose completion now belongs to the
    // recomputation. `hasDirectChildren` is owner-scoped like every other reader of this predicate,
    // because that is the scope aggregation itself walks.
    //
    // Said HERE rather than inside the statement, and that is not only taste: `db-write-inventory`
    // finds a statement's lock clause by reading a window of lines after the `$queryRaw`, so five
    // lines of prose in the middle pushed `FOR SHARE OF t` out of view and this method stopped
    // counting as a lock site the inventory could see.
    const [facts] = await db.$queryRaw<Array<TaskWorkFacts & {
      completionPolicy: string; completionCriterion: string; verifiesTaskId: string | null;
      hasDirectChildren: boolean;
    }>>(Prisma.sql`
      SELECT t."terminal_reason" AS "terminalReason", t."superseded_by_task_id" AS "supersededByTaskId",
             subject."terminal_reason" AS "subjectTerminalReason", subject."superseded_by_task_id" AS "subjectSupersededByTaskId",
             t."completion_policy"::text AS "completionPolicy", t."completion_criterion"::text AS "completionCriterion",
             t."verifies_task_id" AS "verifiesTaskId",
             EXISTS (SELECT 1 FROM "task" c
                      WHERE c."parent_task_id" = t."id" AND c."owner_id" = t."owner_id")
               AS "hasDirectChildren"
        FROM "task" t
        LEFT JOIN "task" subject ON subject."id" = t."verifies_task_id"
       WHERE t."id" = ${taskId}::uuid
       ${locked ? Prisma.sql`FOR SHARE OF t` : Prisma.empty}
    `);
    if (!facts) return null;
    if (startsTaskWork && taskStartOwnedByCompletion({
      completionPolicy: facts.completionPolicy as TaskCompletionPolicyValue,
      completionCriterion: facts.completionCriterion as 'EXECUTABLE' | 'VERIFICATION' | 'EVIDENCE_JUDGMENT',
      verifiesTaskId: facts.verifiesTaskId,
      hasDirectChildren: facts.hasDirectChildren,
    })) {
      return SessionsService.AGGREGATE_PARENT_REFUSAL;
    }
    return taskWorkRefusal(facts, uuidToBase62);
  }

  /**
   * Where a message goes when its revive lost 0130's execution claim.
   *
   * The run this session belongs to has been replaced — by Run Now, by a sweep, by the auto-run
   * the task list reconciles — and the person is still looking at the one it replaced. Until now
   * the whole answer was a refusal, and the message was never delivered anywhere: the platform
   * knew which run holds the task and said so in a sentence, while the thing the person actually
   * asked for (say this to whoever is doing the work) was left undone. So this ROUTES.
   *
   * Three answers, and which one it is turns on what the person chose, never on what would be
   * convenient:
   *
   *   they named no provider, or the one already running — the message is delivered to the run
   *     that holds the claim and the answer says which run that was, so the client can follow;
   *   they named another provider — a run's provider is fixed for its lifetime, so this can only
   *     be done by stopping that run, which is destructive and is therefore ASKED
   *     (`TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED`) before it is done;
   *   the confirmation names that run — it is stopped through the ordinary stop, and this message
   *     opens the continuing round on the provider that was chosen.
   *
   * Nothing here stops a run that nobody asked to stop, and nothing here moves a running session
   * onto another provider.
   *
   * `session_task_execution_claim_idx` makes "one live Session per task" a property of the database,
   * and a revive writes a LIVE status — so a task whose run has already been re-dispatched (Run Now,
   * a sweep, the auto-run the task list reconciles) refuses the revive at that index. The refusal is
   * correct; what used to happen with it was not. The raw `P2002` reached the API as a 500 with a
   * PostgreSQL sentence in it, in front of somebody who pressed "Retry now" on a failed run of a
   * task that is at that moment running somewhere else, and said nothing about which session has it.
   *
   * READ AFTER THE TRANSACTION HAS ROLLED BACK, and that is not a detail: the transaction that
   * raised this is aborted, so any further statement inside it answers 25P02 rather than a row.
   * Nothing of the revive was written (the flip is the last thing the transaction does), so this
   * read is of the world the refusal is about.
   *
   * The predicate is the index's own (`TASK_OCCUPYING` is its four statuses, character for
   * character) rather than "the newest" or "the live one": a reader narrower than the index it
   * explains answers "nothing holds the claim" for rows that do.
   */
  private async routeOntoTheHeldClaim(
    ownerId: string,
    id: string,
    dto: SessionResumeDto,
    taskId: string | null,
    workspaceId: string | null,
    opts?: { routeToCurrentRun?: boolean },
  ): Promise<SessionResumeAnswer> {
    if (taskId !== null) {
      // `NOT: { id }` is belt-and-braces — every path here arrives with THIS row terminal, so it
      // cannot be in the index — and it is what keeps the sentence from naming the caller's own
      // session if that ever stops being true.
      const holder = await this.prisma.session.findFirst({
        where: { taskId, deletedAt: null, status: { in: TASK_OCCUPYING }, NOT: { id } },
        select: {
          id: true,
          status: true,
          workspaceId: true,
          startsTaskWork: true,
          cancelRequestedAt: true,
          provider: true,
        },
      });
      if (holder) {
        const inTheWay = () => taskAlreadyRunning({
          taskPublicId: uuidToBase62(taskId),
          sessionPublicId: uuidToBase62(holder.id),
          sessionStatus: holder.status,
          onAnotherAgent: holder.workspaceId != null && holder.workspaceId !== workspaceId,
          ending: holder.cancelRequestedAt != null,
          notWork: holder.startsTaskWork === false,
        });
        // Only a person routes — see `resume`'s `routeToCurrentRun`. Every server-driven caller
        // keeps the refusal it has always had.
        if (!opts?.routeToCurrentRun) throw inTheWay();
        // Already on its way out, whoever asked for that — including the request one delivery ago
        // that asked for it below. Nothing can take a message: `createTurn` refuses a session with
        // `cancel_requested_at` set, and a revive still loses the claim until the runner lets go of
        // it. Said as the retryable answer it is, so the repeat of this same `clientTurnId` lands
        // the moment the claim is free.
        if (holder.cancelRequestedAt != null) throw inTheWay();
        // Nothing was chosen, or what was chosen is what is already running: this is a message, not
        // a switch. It goes to the run doing the work, and the answer names that run so the client
        // can follow it there.
        //
        // Per-session overrides that rode along (model, effort, permission mode, fast mode) are
        // deliberately NOT carried over: they configure the session they were sent for, and this
        // message is being delivered into a different one that is already running under its own.
        if (dto.provider === undefined || dto.provider === holder.provider) {
          // ...unless the message brought files with it. An `attachment` row is scoped to ONE
          // session (`assertLinkableAttachments`), so the only two things this could do are hand
          // the other run the words without the screenshot they are about, or fail on the
          // attachment with a sentence about ids. Both are worse than the structured refusal this
          // door has always given, which at least names the run to open and re-send in.
          if (dto.attachmentIds?.length) throw inTheWay();
          const delivered = await this.createTurn(ownerId, holder.id, dto);
          return {
            ...delivered,
            revived: false as const,
            routedToSessionId: uuidToBase62(holder.id),
          };
        }
        // A different provider was named. The switch itself was already judged — the revive that
        // brought us here ran `resolveProviderSwitch` inside its transaction and would have thrown
        // before reaching the index if the two ran on different runtimes — so what is left is the
        // destructive half: this can only be done by ending the run that is going.
        if (dto.stopSessionId !== holder.id) {
          throw taskRunProviderSwitchConfirmation({
            taskPublicId: uuidToBase62(taskId),
            sessionPublicId: uuidToBase62(holder.id),
            sessionStatus: holder.status,
            runningProvider: holder.provider,
            requestedProvider: dto.provider,
          });
        }
        // Confirmed, and naming this run. The ordinary stop — the one the Stop button and
        // `batch-stop` take — so the branch and the worktree are left exactly as they are and the
        // runner winds its process down rather than being orphaned.
        await this.cancel(ownerId, holder.id);
        // And then the message goes where it was always going: this session, on the provider that
        // was chosen, with this message opening it. A holder that had not started yet is already
        // out of the claim when this re-enters; one with a process to wind down still holds it, and
        // the re-entry answers with the ending refusal above rather than pretending otherwise.
        // It cannot loop: a stop is authorised for ONE named session, so a claim that changed hands
        // in between asks its own question instead of being stopped by this answer.
        return this.resume(ownerId, id, dto, opts);
      }
    }
    // No holder: the claim was taken and released between the failed write and this read, or this
    // row was never in a position to lose one. Nothing of this request landed either way, and a
    // retry does not meet what refused it.
    throw new ConflictException(
      'this session could not be revived: its task\'s execution claim was taken and released '
        + 'while the revive was being written — nothing was changed; retry',
    );
  }

  async resume(
    ownerId: string,
    id: string,
    dto: SessionResumeDto,
    opts?: {
      batch?: { id: string; maxConcurrent: number } | null;
      /**
       * §13.6 SU6: this turn is the TASK's work, not a comment on it.
       *
       * Set by the paths that run a task (Run Now, the sweeps, a batch) when they hand a paused run
       * the task's prompt. An @-mention deliberately does not set it: replying in a session about a
       * task is not executing the task, and marking it as such would make the reaper close that
       * conversation the moment the task settled. Written in the same UPDATE that revives the row,
       * so 0130's guard judges the value this turn is actually starting under.
       */
      startsTaskWork?: boolean;
      /**
       * The run request this turn is being delivered FOR — see `create`'s own `fence`. Proved
       * inside the transaction that revives the session and writes the turn, so a holder whose
       * lease was taken over cannot deliver a prompt the request no longer wants.
       */
      fence?: TaskRunEffectFence;
      /**
       * Orchestration's attempt charge — see `createTurn`'s own. Forwarded verbatim to the live
       * delegation below and invoked inside the revive transaction, because the orchestration
       * door reaches both branches through one verb: a caller that may not steer a running
       * attempt may not buy the same turn by reviving the session it belongs to instead.
       */
      participateSendTransaction?: (tx: Prisma.TransactionClient) => Promise<void>;
      /**
       * Who the turn is a message from — see `createTurn`'s own. Carried onto both branches: the
       * live delegation below and the revive, because the session-to-session doors reach both
       * through this one verb and a message is no less another session's for having woken its
       * recipient up.
       */
      senderSessionId?: string;
      /**
       * What rides on the turn — see `createTurn`'s own. Carried onto both branches for the reason
       * `senderSessionId` is: a request is no less a request for having woken its recipient up.
       */
      onTurnWritten?: (tx: Prisma.TransactionClient, turn: ConversationTurn) => Promise<void>;
      /**
       * This request is a PERSON saying something now — the HTTP resume door, and only that one.
       *
       * It is what decides whether a message whose session has been replaced is ROUTED to the run
       * that holds the task instead of refused. Every other caller of resume is a server replaying
       * or dispatching something: the auto-retry sweeper re-sends a message that was typed into
       * THIS run before a quota killed it, the task planner hands a paused run the task's own
       * prompt, the coordinator delivers to the session it addressed. Routing those would push
       * words that belong to one conversation into whichever run the task happens to be on — so
       * they keep the refusal, and the person's door gets the routing.
       */
      routeToCurrentRun?: boolean;
      /**
       * The HTTP resume door's credential. A personal access token may not re-apply `permissionMode`
       * on the way back in, for the reason `updateConfig` refuses it one (§5 of
       * docs/personal-access-token-design.md): reviving a session is another way of setting its mode.
       */
      credential?: AuthCredential;
    },
  ): Promise<SessionResumeAnswer> {
    refuseOwnerFieldsToToken(opts?.credential, { permissionMode: dto.permissionMode });
    assertPromptSize(dto.content, 'message');
    const requestFingerprint = resumeRequestFingerprint(dto);
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      include: {
        assignedRunner: { select: { id: true, status: true, lastHeartbeatAt: true } },
      },
    });
    if (!session) throw new NotFoundException('session not found');
    // §13.6 SU6, and it comes BEFORE the runtime repair below on purpose.
    //
    // A resume of a session whose task was replaced is refused — by 0130's revive guard if it gets
    // that far, and by this if it does not. The order matters because the repair underneath writes
    // to the Session: `runtime_session_id` and `numTurns` are the record of what that run actually
    // did, and rewriting them for a resume that is then refused would edit the history of a run to
    // no purpose. Read once, checked once, before anything with an effect.
    //
    // No exemption for a person here, unlike a fresh session_create: reviving a terminal row is
    // indistinguishable on the row itself from the auto-retry sweep doing it, so the rule that can
    // be enforced is the categorical one. Salvage stays available by opening a NEW session.
    // §13.6 SU6, applied to what THIS request is, not to the row's history.
    //
    // Three shapes reach here and they are not the same question:
    //
    //   a live salvage continuing as a salvage — the row is `starts_task_work = false`, the request
    //     does not claim otherwise, and 0130's guard deliberately lets a live row keep moving
    //     between live statuses. Refusing it would mean a person could open a session on a replaced
    //     attempt, get one reply, and never be able to ask a second question;
    //   a live row being handed the TASK's work (`opts.startsTaskWork`) — that is a new claim about
    //     what the run is for, and it is judged;
    //   a terminal revival — judged categorically, whoever asks: nothing on the row separates a
    //     person reviving it from the auto-retry sweep doing so.
    const continuesSalvage = SessionsService.LIVE.includes(session.status)
      && !session.startsTaskWork
      && !opts?.startsTaskWork;
    if (session.taskId && !continuesSalvage) {
      // The two refusals part company here. Supersession is categorical — a terminal revival is
      // refused whoever asks. §13.1 AG6 asks a narrower question: is THIS turn the task's work?
      // A terminal non-work session revived to read or salvage is not, and must stay resumable.
      const effectiveStartsTaskWork = session.startsTaskWork || opts?.startsTaskWork === true;
      const refusal = await this.taskWorkRefusalFor(
        this.prisma, session.taskId, false, effectiveStartsTaskWork,
      );
      if (refusal) {
        throw new ConflictException(`this session's run may not be resumed: ${refusal}`);
      }
    }
    // A Claude row with turns but no runtime session id has no conversation to resume. That
    // wedges the capabilities check: MISSING_CONTEXT blocks resume because the session
    // appears to have lost its conversation. A fresh id with `numTurns` reset makes the runner do
    // a first spawn (--session-id) instead of a doomed --resume.
    //
    // NOT WRITTEN HERE. It used to be, and that made it the first side effect of a resume that
    // could still be refused several checks later — by Trash, by a pending worktree operation, or
    // (§13.6 SU6) by a supersession that committed after the read above. The caller got an error
    // and the Session's own history had been edited anyway: `runtime_session_id` and `numTurns` are
    // the record of what that run did. The repair now happens inside the revive transaction, on the
    // row re-read under `FOR UPDATE`, so a refusal takes it with it.
    const needsRuntimeRepair =
      session.provider === 'claude' && session.numTurns > 0 && !session.runtimeSessionId;
    if (needsRuntimeRepair) {
      // The in-memory copy only, so the capability derivations below judge the world the
      // transaction is going to create. Nothing is persisted until that transaction commits.
      session.runtimeSessionId = randomUUID();
      session.numTurns = 0;
    }
    const initialCapabilities = deriveSessionCapabilities(session);
    if (initialCapabilities.resumeBlockedReason === 'TRASHED') {
      throw SessionsService.resumeBlocked('TRASHED');
    }
    if (initialCapabilities.resumeBlockedReason === 'ENDING') {
      throw SessionsService.resumeBlocked('ENDING');
    }
    // Still live — a normal turn belongs on the running process, not a revive. But a
    // "Resolve in session" rebase reaches resume() on a live session too: the bar offers it
    // while the session is still AWAITING_INPUT, and its whole point is to clear the failed
    // merge so the bar offers Merge afresh once the workspace rebases. The revive path below does
    // that for ended sessions (mergeStatus: null); mirror it here, since createTurn doesn't.
    // Only a *settled* outcome is stale. createTurn performs that cleanup under
    // its Session row lock so it cannot erase an operation queued after this fast read.
    if (SessionsService.LIVE.includes(session.status) && !session.cancelRequestedAt) {
      const live = await this.createTurn(ownerId, id, dto, {
        clearSettledWorktreeState: true,
        // Carried through: a live paused run being handed the task's prompt is the task's work,
        // and the row has to say so in the same transaction that writes the turn.
        startsTaskWork: opts?.startsTaskWork,
        // ...and so does the right to deliver it. This is the path a task resume actually takes —
        // `AWAITING_INPUT` and `INTERRUPTED` are both LIVE — so a fence applied only to the revive
        // below would be a fence on the branch nobody uses.
        fence: opts?.fence,
        participateSendTransaction: opts?.participateSendTransaction,
        senderSessionId: opts?.senderSessionId,
        onTurnWritten: opts?.onTurnWritten,
        requestFingerprint,
      });
      // Nothing was revived: this turn joined a process that was already running. Said out loud
      // because the orchestration door offers resume as a fallback for `send`, and the caller
      // has to be able to tell "I restarted an engine" from "it was still up".
      return { ...live, revived: false as const };
    }
    if (
      initialCapabilities.resumeBlockedReason &&
      initialCapabilities.resumeBlockedReason !== 'NOT_TERMINAL' &&
      initialCapabilities.resumeBlockedReason !== 'NO_RUNNER' &&
      initialCapabilities.resumeBlockedReason !== 'RUNNER_OFFLINE'
    ) {
      throw SessionsService.resumeBlocked(initialCapabilities.resumeBlockedReason);
    }

    // Re-check capability and revive under the same Session row lock used by complete/delete.
    // This closes the race where Trash could win after the fast read but before the turn insert.
    // Retried whole. A resume reads the session, its project capacity and its worktree state under
    // locks taken inside the closure and writes from that read; nothing outside it moves between
    // attempts, and the runner is notified after this returns.
    const revived = await withTransactionRetry(this.prisma, async (tx) => {
      // THE RIGHT TO DO THIS, FIRST, and held to commit. A delivery whose lease was taken over
      // while it was getting here must not write the turn anyway — the receipt would refuse its
      // answer afterwards, which reports the contradiction rather than preventing it. Taken before
      // the rows below because it is not one of them: it fences the REQUEST, and a request that is
      // no longer this delivery's has no business taking a project, a task or a session at all.
      if (opts?.fence) await this.assertFenceHeld(tx, opts.fence);
      // PROJECT FIRST — the one order this system takes these three rows in.
      //
      // A revive ends by writing a live status onto this row, which reaches
      // `session_project_capacity_serialize` and takes the project. Taken there, the order would be
      // session → task → project, against every Coordinator path's project → task → session, and
      // the two interleave into a native 40P01 that reaches a caller as a 500. Taken here it is the
      // same three rows in the same order as everybody else, so the cycle cannot be built.
      //
      // Only when this session belongs to a task in a project — which is exactly when the capacity
      // trigger would have taken it, so nothing acquires a lock it did not already end up holding.
      const [scope] = await tx.$queryRaw<Array<{ taskId: string; projectId: string | null }>>(
        Prisma.sql`
          SELECT s."task_id" AS "taskId", t."project_id" AS "projectId"
            FROM "session" s JOIN "task" t ON t."id" = s."task_id"
           WHERE s."id" = ${id}::uuid AND s."owner_id" = ${ownerId}::uuid
        `,
      );
      // The scope read above took no lock, so it is a guess about BOTH halves: which project the
      // task is in, and whether it is in one at all. A task with no project can be moved INTO one
      // between the two reads, and this transaction would then reach
      // `session_project_capacity_serialize` holding nothing — session → task → P2, against every
      // P2 → task path. Null is not the safe case; it is the case with nothing to lock, which is
      // why the confirmation below runs either way.
      if (scope) {
        if (scope.projectId) {
          await tx.$queryRaw`
            SELECT 1 FROM "project" WHERE "id" = ${scope.projectId}::uuid FOR NO KEY UPDATE`;
        }
        // The project was read WITHOUT a lock a moment ago, so it is a guess until the task row
        // confirms it. Two things can have happened in between, and both end in a cycle rather than
        // a wrong answer: the task moved to another project (this transaction now holds the OLD
        // project while the capacity trigger below will reach for the NEW one), or a writer already
        // holds the task and is waiting for a project this transaction holds.
        //
        // NOWAIT, for the same reason 0130's `task_supersession_project_lock_order` uses it:
        // waiting is what builds a cycle, and refusing immediately cannot. Then re-read the scope
        // THROUGH the lock and require it to be the one that was locked. Either answer leaves this
        // transaction with nothing written.
        let confirmed: Array<{ projectId: string | null }>;
        try {
          confirmed = await tx.$queryRaw<Array<{ projectId: string | null }>>(Prisma.sql`
            SELECT t."project_id" AS "projectId"
              FROM "session" s JOIN "task" t ON t."id" = s."task_id"
             WHERE s."id" = ${id}::uuid AND s."owner_id" = ${ownerId}::uuid
             FOR SHARE OF t NOWAIT
          `);
        } catch (error) {
          if (!isLockNotAvailable(error)) throw error;
          throw new ConflictException(
            'this session\'s task is being written right now, so the run cannot be resumed in ' +
              'this request — nothing was changed; retry',
          );
        }
        // Compared in BOTH directions, including null → project and project → null: what matters is
        // that the row this transaction locked is the row the capacity trigger will reach for.
        if ((confirmed[0]?.projectId ?? null) !== (scope.projectId ?? null)) {
          throw new ConflictException(
            'this session\'s task moved to another project while the resume was being prepared — ' +
              'nothing was changed; retry',
          );
        }
      }
      // NOWAIT, and only here. This transaction already holds the project and the task (above), so
      // an ordinary wait on the session row closes the loop against any writer that took the
      // session first — which, for an UPDATE, is every writer, since PostgreSQL locks the target
      // row before a BEFORE ROW trigger can take anything else. `createTurn`'s own lock is
      // deliberately blocking; it holds nothing and must not drop a user's turn.
      let locked: Array<{ id: string }>;
      try {
        locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "session"
          WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
          FOR UPDATE NOWAIT`;
      } catch (error) {
        if (!isLockNotAvailable(error)) throw error;
        throw new ConflictException(
          'this session is being written right now, so it cannot be revived in this request — ' +
            'nothing was changed; retry',
        );
      }
      if (locked.length === 0) throw new NotFoundException('session not found');
      const current = await tx.session.findUniqueOrThrow({
        where: { id },
        include: {
          assignedRunner: { select: { id: true, status: true, lastHeartbeatAt: true, capabilities: true, capabilitiesReportedAt: true, engines: true } },
        },
      });
      // Everything was locked in the order project → task → session, but the SESSION was the last
      // one taken, so its own fields are the ones that could have moved in between. Re-checked
      // against the scope this transaction actually holds: a rebind to another task means the
      // project and task it locked are not this session's any more.
      if ((current.taskId ?? null) !== (scope?.taskId ?? null)) {
        throw new ConflictException(
          'this session was rebound to another task while the resume was being prepared — ' +
            'nothing was changed; retry',
        );
      }
      // §13.6 SU6, re-read under the Session row lock this transaction already holds and the Task
      // row it takes here. The check before the transaction is the friendly one; this is the fence.
      // A supersession that commits between them makes this refuse, and because it refuses INSIDE
      // the transaction, every write below — the runtime repair, the turn, the status flip — is
      // rolled back with it. The order is Session → Task, matching `complete`/`delete` and the
      // revive path itself; 0130's guard takes the Task from a Session write for the same reason.
      // The commit-point half, and it reaches only a REVIVAL — the live path returned above through
      // `createTurn`. A revival is judged categorically; see the pre-check for why.
      if (current.taskId) {
        const refusal = await this.taskWorkRefusalFor(
          tx, current.taskId, true, current.startsTaskWork || opts?.startsTaskWork === true,
        );
        if (refusal) {
          throw new ConflictException(`this session's run may not be resumed: ${refusal}`);
        }
      }
      // The runtime repair, now that nothing after it can refuse. Written on the locked row, in the
      // transaction that also writes the turn, so the two are one act.
      if (opts?.startsTaskWork && !current.startsTaskWork) {
        await tx.session.update({ where: { id }, data: { startsTaskWork: true } });
        current.startsTaskWork = true;
      }
      if (needsRuntimeRepair && !current.runtimeSessionId) {
        await tx.session.update({
          where: { id },
          data: { runtimeSessionId: session.runtimeSessionId, numTurns: 0 },
        });
        current.runtimeSessionId = session.runtimeSessionId;
        current.numTurns = 0;
      }
      const capabilities = deriveSessionCapabilities(current);
      if (capabilities.resumeBlockedReason === 'TRASHED') {
        throw SessionsService.resumeBlocked('TRASHED');
      }
      if (capabilities.resumeBlockedReason === 'ENDING') {
        throw SessionsService.resumeBlocked('ENDING');
      }

      // Idempotent retry: once another request queued this clientTurnId, return it even
      // if the runner went offline in the meantime. Trash/ending still win above.
      const existing = await tx.conversationTurn.findUnique({
        where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto.clientTurnId } },
        include: { attachments: { select: { id: true } } },
      });
      if (existing) {
        const expectedKind = dto.kind === 'shell' ? 'shell' : 'message';
        const storedAttachments = existing.attachments.map((attachment) => attachment.id).sort();
        const expectedAttachments = expectedTurnAttachments(
          id,
          dto.clientTurnId,
          dto.attachmentIds,
          storedAttachments,
        );
        if (
          existing.kind !== expectedKind
          || existing.content !== dto.content
          || (existing.requestFingerprint != null
            && existing.requestFingerprint !== requestFingerprint)
          || expectedAttachments.length !== storedAttachments.length
          || expectedAttachments.some(
            (attachmentId, index) => attachmentId !== storedAttachments[index],
          )
        ) {
          throw new ConflictException(
            'clientTurnId was already used with a different resume payload',
          );
        }
      }
      if (!SessionsService.TERMINAL.includes(current.status)) {
        if (existing) return { turn: existing, wasCompleted: false, wasRevived: false };
        throw SessionsService.resumeBlocked('NOT_TERMINAL');
      }
      if (
        capabilities.resumeBlockedReason &&
        capabilities.resumeBlockedReason !== 'NO_RUNNER' &&
        capabilities.resumeBlockedReason !== 'RUNNER_OFFLINE'
      ) {
        throw SessionsService.resumeBlocked(capabilities.resumeBlockedReason);
      }
      if (existing) return { turn: existing, wasCompleted: false, wasRevived: false };
      if (capabilities.resumeBlockedReason) {
        throw SessionsService.resumeBlocked(capabilities.resumeBlockedReason);
      }
      if (
        pendingWorktreeOperationMayBeExecuting(
          current.mergeStatus,
          current.mergeOperationId,
          current.mergeOperationOwner,
          current.mergeRequestedAt,
        ) ||
        pendingWorktreeOperationMayBeExecuting(
          current.commitStatus,
          current.commitOperationId,
          current.commitOperationOwner,
          current.commitRequestedAt,
        )
      ) {
        throw new ConflictException('wait for the pending worktree operation to finish');
      }

      // Validate image refs only for a new turn. On retry, attachments are already linked
      // to the existing turn and must not invalidate the idempotent response.
      const attachmentIds = await this.assertLinkableAttachments(
        ownerId,
        id,
        dto.clientTurnId,
        dto.attachmentIds,
        tx,
      );
      // A revive keeps its runtime and durable id. Resolve that boundary and the still-unverified
      // Harness permission policy before accepting the next turn.
      const next = await this.resolveProviderSwitch(tx, current, dto.provider);
      const resumeRuntime = execRuntime({
        declaredProvider: next.provider,
        declaredProviderBuiltin: next.providerBuiltin,
        customRow: next.customRow,
      });
      if (resumeRuntime === AgentProvider.DSH) {
        if (!current.assignedRunner?.capabilitiesReportedAt || !current.assignedRunner.capabilities?.includes('provider:dsh')) {
          throw new ConflictException(DSH_RUNNER_UPGRADE_ERROR);
        }
        normalizeBuiltinPermissionMode(
          resumeRuntime,
          dto.model ?? current.model ?? '',
          resolvePermissionMode(dto.permissionMode ?? current.permissionMode, null),
        );
        // Nothing is written: the session stays as it was and revives once the CLI is installed.
        const unavailable = dshRuntimeUnavailable(current.assignedRunner.engines);
        if (unavailable) throw new ConflictException(unavailable);
      }
      // The orchestration charge, in the same place createTurn puts it: past idempotency and
      // every refusal above, before the row it is paying for. A revive that is refused after
      // this — or a transaction retried whole — rolls the charge back with the turn.
      await opts?.participateSendTransaction?.(tx);
      // Self-heal terminal rows produced before generation retirement was deployed
      // (or by an older replica during a rolling upgrade). Otherwise a same-process
      // takeover returns early and the fresh engine cannot replace that active marker.
      await retireSessionInboxGeneration(tx, id);
      const turn = await this.insertTurnLocked(tx, id, {
        kind: dto.kind === 'shell' ? 'shell' : 'message',
        content: dto.content,
        clientTurnId: dto.clientTurnId,
        requestFingerprint,
        ...(opts?.senderSessionId ? { senderSessionId: opts.senderSessionId } : {}),
      });
      await this.linkAttachments(turn.id, attachmentIds, tx);
      await opts?.onTurnWritten?.(tx, turn);
      // This turn takes the place of the retry the failed run was waiting on, which the write below
      // disarms: what it kept for its re-send will not get one (§8 criterion 26, session-request.ts).
      // The sweep's own re-send, and the failure card's Retry, took their request onto this turn just
      // above, and leave nothing for it.
      if (current.retryAt != null || current.retryClaimedAt != null) {
        await closeRequestsTheRetryWillNotResend(tx, id);
      }
      // A revive may also move the session to another provider on the same runtime. Unlike a live
      // switch there is no process to reload: the row goes PENDING and the claim below resolves
      // the environment from it, which is also why a model the new provider doesn't serve is
      // simply cleared — claim re-resolves an unset model against the provider it is claiming for.
      // …and onto one of the runner's accounts when it moves onto the built-in Codex or Claude engine,
      // as a live switch does (updateConfig). The claim that picks the revive up carries the
      // conversation there.
      const accounts = await this.accountOnProviderSwitch(tx, id, next, dto.account);
      const normalizedEffort =
        dto.effort !== undefined
          ? normalizeEffortForProvider(
              resumeRuntime === AgentProvider.DSH
                ? resumeRuntime
                : normalizeRuntimeProvider(next.provider, next.providerBuiltin),
              dto.effort,
            )
          : undefined;
      // Fast mode re-applied on the way back up. No process to reload here — the row goes PENDING
      // and the claim builds one from it — so the only question is whether the value is true, and
      // the claim polices it against whatever model this revive resolves to.
      const normalizedFastMode = dto.fastMode !== undefined ? dto.fastMode === true : undefined;
      await tx.session.update({
        where: { id },
        data: {
          status: RunStatus.PENDING,
          // A terminal revive starts a fresh runner-supervisor epoch. Keep the
          // reserved handoff owner in the claim snapshot until a capable runner
          // drains any predecessor and restores its process owner. Owner-fenced
          // inbox/events/ack/finalize writes stay closed throughout that drain.
          inboxLeaseOwner: newTerminalResumeHandoffOwner(),
          cancelRequestedAt: null,
          endReason: null,
          finishedAt: null,
          error: null,
          result: null,
          lastTurnAt: new Date(),
          // Previewed from enqueue, as in createTurn: a revive waits for a slot like any other
          // turn, and until the runner reports it the row would show the reply from before.
          ...(dto.content ? { lastUserText: dto.content } : {}),
          mergeStatus: null,
          mergeOperationId: null,
          mergeOperationOwner: null,
          mergeError: null,
          mergedAt: null,
          mergedSourceSha: null,
          branchMerged: null,
          commitStatus: null,
          commitOperationId: null,
          commitOperationOwner: null,
          commitError: null,
          commitResultMessage: null,
          // A resumable Completed session moves back to Open. Trash was rejected above.
          completedAt: null,
          archivedAt: null,
          // As in createTurn: a new message — the user's or the sweeper's own — disarms the
          // auto-retry. This is the route the sweeper itself takes for a terminal session, and the
          // turn it writes is the one a claim was waiting for (migration 0354): both go together.
          retryAt: null,
          retryClaimedAt: null,
          ...(dto.model !== undefined
            ? { model: dto.model }
            : next.keepsModel
              ? {}
              : { model: null }),
          ...(dto.permissionMode !== undefined ? { permissionMode: dto.permissionMode } : {}),
          ...(dto.effort !== undefined ? { effort: normalizedEffort } : {}),
          ...(normalizedFastMode !== undefined ? { fastMode: normalizedFastMode } : {}),
          ...(next.changed
            ? { provider: next.provider, providerBuiltin: next.providerBuiltin }
            : {}),
          ...accounts,
          ...(opts?.batch !== undefined
            ? {
                batchId: opts.batch?.id ?? null,
                batchMaxConcurrent: opts.batch?.maxConcurrent ?? null,
              }
            : {}),
        },
      });
      return {
        turn,
        wasCompleted: (current.completedAt ?? current.archivedAt) != null,
        wasRevived: true,
      };
    }, loggedRetry(this.logger, 'sessions.resume'))
      // The one duplicate key this UPDATE can reach — another live Session already holds this task's
      // execution claim (0130) — answered as the refusal it is instead of as the 500 a bare P2002
      // becomes. Caught outside the transaction, because naming the holder means reading, and the
      // transaction that raised this cannot answer a read. Any other duplicate is somebody else's
      // fact and goes on being thrown as it is.
      .catch(async (error: unknown) => {
        if (!isExecutionClaimConflict(error)) throw error;
        return {
          routed: await this.routeOntoTheHeldClaim(
            ownerId, id, dto, session.taskId, session.workspaceId, opts,
          ),
        } as const;
      });
    // The message was delivered somewhere else, or a round was continued by re-entering resume.
    // Either way this delivery's receipt is that one, and none of the post-commit work below
    // belongs to it: nothing on THIS row was revived.
    if ('routed' in revived) return revived.routed;
    // Un-filing is a list-membership change with no STATUS event of its own — mirror restore()
    // and signal the control plane, so every other client moves the row out of Completed and
    // into Open without polling.
    //
    // A revive that never left Open has the same gap one step in from the sidebar: the row just
    // went from a terminal status back to PENDING and nothing announces it either. The claim that
    // follows (queue.claim, PENDING → RUNNING) publishes nothing, so the next control event this
    // session produces is its turn_end — a whole turn later. Invisible when the sender is the one
    // resuming (it updates itself), glaring when the server resumes on its own: AutoRetryService
    // re-sending a quota-killed message left every open console still drawing the failure it was
    // armed on ("Retrying automatically."), over a transcript stream that was paused at that
    // failure and only re-opens once the client believes the session is live again.
    if (revived.wasCompleted) this.realtime.publishSessionCreated(id);
    else if (revived.wasRevived) this.realtime.publishSessionUpdated(id);
    this.queue.notifySessionQueued();
    return {
      turnId: revived.turn.id,
      seq: revived.turn.seq,
      kind: revived.turn.kind,
      // This transaction revived a terminal row with this turn as its first executable. A fast
      // read that found the session live returned through createTurn above instead, preserving
      // createTurn's row-locked accepted/queued/steer decision verbatim.
      placement: 'accepted' as const,
      // Whether THIS request restarted the engine — not whether the session is running now. A
      // retry that replays a committed turn reports false: it spent nothing and started nothing,
      // and the revive it is replaying was reported to whoever won the race.
      revived: revived.wasRevived,
    };
  }

  /**
   * Why this conversation cannot be handed a message — or `null` when it can.
   *
   * The answer two doors need and neither may write for itself. `resume` is the door that
   * DELIVERS a message; this is the same question asked without delivering anything, which is
   * what a door that may only open a REPLACEMENT when the conversation a project names can no
   * longer receive has to ask first (contract §7.5, the agent's `ensure`).
   *
   * Two authorities, in the order the delivering door reaches them:
   *
   *   1. `deriveSessionCapabilities().canSend` — alive, or ended in a way that can still be
   *      revived. One predicate for trashed, ending, never-started, lost-context, no-runner and
   *      runner-offline, and the same one every Session payload publishes as `canSend`, so a
   *      card's affordance and this door cannot come to opposite answers about one row;
   *   2. §13.6 SU6 — a run whose task was replaced or abandoned may not be resumed, whoever
   *      asks, and `canSend` cannot see it: that row is healthy and its runner is up. Read
   *      through `taskWorkRefusalFor`, the same predicate the revive is fenced by, and applied
   *      to the same shape of turn the message is: a message, never the task's own work.
   *
   * The caller's own standing — a live session, orchestration enabled — is the DOOR's gate and
   * deliberately not read here: this is about the conversation being written to.
   */
  async receiveBlockedReasonFor(
    ownerId: string,
    sessionId: string,
  ): Promise<SessionReceiveBlockedReason | null> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      include: { assignedRunner: { select: { id: true, status: true, lastHeartbeatAt: true } } },
    });
    if (!session) return 'SESSION_GONE';
    const capabilities = deriveSessionCapabilities(session);
    if (!capabilities.canSend) {
      // `canSend` is false on exactly three paths — in Trash, ending, or ended with no revival —
      // and each of them names its reason in that same derivation. `SESSION_GONE` is unreachable
      // here; it is what keeps this door from ever reading "no reason given" as "deliverable" if
      // that derivation grows a path that does not.
      return capabilities.resumeBlockedReason ?? 'SESSION_GONE';
    }
    // A live conversation ABOUT a task is not the task's work, and 0130's guard deliberately lets
    // it keep going — refusing a message here would leave a salvage somebody can reply to once and
    // never again. The same carve-out `resume` makes, spelled the same way.
    const continuesSalvage =
      SessionsService.LIVE.includes(session.status) && !session.startsTaskWork;
    if (session.taskId && !continuesSalvage) {
      const refusal = await this.taskWorkRefusalFor(
        this.prisma, session.taskId, false, session.startsTaskWork,
      );
      if (refusal) return 'RUN_RETIRED';
    }
    return null;
  }

  /**
   * Move a session from Open to Completed. Reversible. A session that
   * hasn't ended is completed too: we recycle its runner process first (enqueue an
   * `end` control turn + signal the runner to cancel) so a live claude isn't orphaned.
   * The status settles to CANCELLED async while the row already sits in Completed.
   */
  async complete(ownerId: string, id: string) {
    const ended = await this.transitionEnd(
      ownerId,
      id,
      SessionEndReason.COMPLETED,
      'completedAt',
    );
    // Everything below is deliberately post-commit. A failed end-turn insert rolls back
    // both the intent and completedAt, and therefore produces no runner/realtime signal.
    this.publishEndIntent(id, ended);
    // Complete is a lifecycle change with no STATUS event — signal the control plane so
    // other clients drop the row without polling.
    this.realtime.publishSessionLifecycleChanged(
      id,
      ended.status,
      ended.endReason,
      ended.lifecycleState,
    );
    return { ok: true };
  }

  /**
   * Why `slug`, one of `ownerId`'s account pools, may not be written as anything's provider — it has no
   * account that can run — or null when it may, or names no pool of theirs (QueueService's answer; the
   * claim chooses from the same members). Every door that takes a provider asks it: opening a session
   * and switching one here, and TasksService's pin and mention delivery through this.
   */
  accountPoolRefusal(ownerId: string, slug: string, db?: Prisma.TransactionClient): Promise<string | null> {
    return this.queue.accountPoolRefusal(ownerId, slug, db);
  }

  /** accountPoolRefusal, as the 400 this service's own doors answer with. */
  private async assertUsablePool(ownerId: string, slug: string, db?: Prisma.TransactionClient): Promise<void> {
    const refusal = await this.accountPoolRefusal(ownerId, slug, db);
    if (refusal) throw new BadRequestException(refusal);
  }

  /**
   * Resolve a requested provider change against the one a session is already on.
   *
   * A switch re-points the session at another identity — a second account with the same vendor,
   * or a different endpoint — without moving it to another CLI. The runtime has to match on both
   * sides: the transcript, the resume id and the wire protocol all belong to the CLI that started
   * the session, so claude→codex is not a setting but a different session. Same runtime,
   * different credentials IS a setting — the engine re-spawns with the new environment and
   * --resume, and the conversation carries over.
   *
   * `keepsModel` answers the other half. Each provider owns its model space: a vendor whose own
   * CLI reports the models (Anthropic on claude, OpenAI on codex) shares one space with the
   * built-in engine, so the session keeps the model it is running; a provider that maintains its
   * own list keeps it only when that list has it. False means the caller must let the model
   * re-resolve against the new provider rather than carry an id it does not serve.
   *
   * Caller holds the Session row lock — both call sites (updateConfig, resume) decide and persist
   * under it, so a concurrent switch cannot interleave with a model write.
   */
  /**
   * Which of its runner's accounts a session moving onto the built-in Codex or Claude engine runs on
   * there — the live switch (updateConfig) and the revive (resume) alike. The Provider menu lists each
   * engine's accounts under it, as the New Session picker does, so a switch can name one:
   *
   * - `automatic`: the account Automatic picks, unpinned — where the workspace leaves it to Orbit.
   * - an account id: that one, pinned, as picking it in the menu of a session already there does
   *   (switchAccount) — refused when the runner does not report it, it is signed out, or the runner
   *   cannot carry the conversation there.
   * - omitted: Automatic's pick, unless the session is pinned to one of that engine's accounts. Left
   *   to follow its workspace instead, a session moved off an API key onto Claude ran on Default
   *   whatever Default had left — straight into a spent weekly window while two accounts had room.
   *
   * The columns to write; empty when the switch lands on no such engine, or nothing moves.
   */
  private async accountOnProviderSwitch(
    tx: Prisma.TransactionClient,
    id: string,
    next: ResolvedProviderSwitch,
    account: string | undefined,
  ): Promise<AccountSwitchWrite> {
    const engine: AccountEngine | null =
      next.changed && next.providerBuiltin && isAccountEngine(next.provider) ? next.provider : null;
    if (account !== undefined && !engine) {
      throw new BadRequestException(
        "an account goes with a switch onto the built-in Codex, Claude or Antigravity engine — a session already there moves with PATCH /sessions/:id/account",
      );
    }
    if (!engine) return {};
    if (account !== undefined && account !== AUTOMATIC_ACCOUNT && !ACCOUNT_ID_PATTERN.test(account)) {
      throw new BadRequestException('account must be "automatic", "default" or the id of one of the runner\'s accounts');
    }
    const session = await tx.session.findUniqueOrThrow({
      where: { id },
      select: {
        numTurns: true,
        codexAccountPinned: true,
        claudeAccountPinned: true,
        antigravityAccountPinned: true,
        workspace: { select: { env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true } },
        assignedRunner: { select: { engines: true, accountPauses: true, planUsage: true, capabilities: true } },
      },
    });
    const write = (to: string, pinned: boolean): AccountSwitchWrite =>
      ({ [ACCOUNT_CHOICE[engine]]: to, [ACCOUNT_PINNED[engine]]: pinned });
    const runner = session.assignedRunner;
    if (account === undefined || account === AUTOMATIC_ACCOUNT) {
      if (account === AUTOMATIC_ACCOUNT && !workspaceLeavesAccountToOrbit(engine, session.workspace, runner?.engines)) {
        throw new BadRequestException("this session's workspace decides its account");
      }
      const pinned = session[ACCOUNT_PINNED[engine]];
      if (account === undefined && pinned) return {};
      const to = automaticAccountOnSwitch(session, engine, new Date());
      if (to) return write(to, false);
      // Asked for by name, Automatic unpins even when it has nowhere to move the session yet.
      if (account === AUTOMATIC_ACCOUNT) return { [ACCOUNT_PINNED[engine]]: false };
      return {};
    }
    const row = sanitizeRunnerEngines(runner?.engines)
      ?.find((entry) => entry.engine === engine)
      ?.accounts?.find((entry) => entry.id === account);
    if (!runner || !row) throw new BadRequestException("that account is not one this session's runner reports");
    if (row.auth === 'no') throw new ConflictException("that account is signed out on this session's runner");
    if (runnerAccountPausedUntil(runner.accountPauses, engine, account)) {
      throw new ConflictException('That account is paused — resume it before switching');
    }
    if (session.numTurns > 0 && !runnerCarriesAccounts(runner, engine)) {
      throw new ConflictException(
        "this session's runner cannot move a conversation to another account yet — it updates itself when no turn is running",
      );
    }
    return write(account, true);
  }

  private async resolveProviderSwitch(
    tx: Prisma.TransactionClient,
    session: {
      ownerId: string;
      provider: string;
      providerBuiltin: boolean;
      model: string | null;
    },
    requested: string | undefined,
  ): Promise<ResolvedProviderSwitch> {
    const declared = session.provider;
    const currentRow = isBuiltinProvider(declared, session.providerBuiltin)
      ? null
      : await tx.modelProvider.findFirst({
          where: { slug: declared, ...(await usableProviderScope(tx, session.ownerId)) },
        });
    const fromPool = isBuiltinProvider(declared, session.providerBuiltin) || currentRow
      ? null
      : await accountPoolRuntime(tx, session.ownerId, declared);
    if (!isBuiltinProvider(declared, session.providerBuiltin) && !currentRow && !fromPool) {
      throw new BadRequestException(
        (await adminOnlyProviderRefusal(tx, session.ownerId, declared)) ?? `provider not available: "${declared}"`,
      );
    }
    if (requested === undefined || requested === declared) {
      if (currentRow?.enabled === false) throw new BadRequestException('provider is disabled');
      return {
        provider: declared,
        providerBuiltin: session.providerBuiltin,
        customRow: currentRow,
        changed: false,
        keepsModel: true,
      };
    }
    // Mirrors create(): membership of the enum, deliberately not isBuiltinProvider(), so a
    // session moved onto the built-in `kimi` slug keeps the discriminator that slug means.
    let providerBuiltin = Object.values(AgentProvider).includes(requested as AgentProvider);
    const targetRow = providerBuiltin && requested !== AgentProvider.DSH
      ? null
      : await tx.modelProvider.findFirst({
          where: {
            slug: requested,
            ...(requested === AgentProvider.DSH ? {} : { enabled: true }),
            ...(await usableProviderScope(tx, session.ownerId)),
          },
        });
    if (targetRow?.enabled === false) throw new BadRequestException('provider not available');
    // One of the owner's own account pools has no row: the claim and the reload resolve it to the
    // member they choose, whose model space is Claude's own.
    const poolRuntime =
      targetRow || (providerBuiltin && requested !== AgentProvider.DSH)
        ? null
        : await accountPoolRuntime(tx, session.ownerId, requested);
    if (targetRow || poolRuntime) providerBuiltin = false;
    if (!providerBuiltin && !targetRow && !poolRuntime) {
      throw new BadRequestException(
        (await adminOnlyProviderRefusal(tx, session.ownerId, requested)) ?? 'provider not available',
      );
    }
    if (poolRuntime) await this.assertUsablePool(session.ownerId, requested, tx);
    // A session already on a pool has no row either, and runs on that pool's engine — a shared pool's
    // on Codex, which the Claude a slug nothing holds falls back to would misread.
    const from =
      fromPool ??
      execRuntime({
        declaredProvider: declared,
        declaredProviderBuiltin: session.providerBuiltin,
        customRow: currentRow,
      });
    const to =
      poolRuntime ??
      execRuntime({
        declaredProvider: requested,
        declaredProviderBuiltin: providerBuiltin,
        customRow: targetRow,
      });
    if (from !== to) {
      throw new BadRequestException(
        `a ${from} session cannot switch to a provider that runs on ${to}`,
      );
    }
    return {
      provider: requested,
      providerBuiltin,
      customRow: targetRow,
      changed: true,
      keepsModel: !targetRow || ownsModel(targetRow, session.model ?? ''),
    };
  }

  /**
   * Change the model / permission mode / effort / fast mode / provider of an already-started
   * session.
   *
   * The new values are persisted and a control turn is queued for the live runtime, and which
   * turn that is depends on what moved. The provider is spawn-only: the process was built with
   * its environment, so a `reload` — tear down, re-spawn with --resume and the new flags, full
   * context kept — is the only way to change it, and the inbox holds that turn until no message
   * is in flight so it cannot abort a running turn. Claude's fast mode is spawn-only for the same
   * kind of reason in a different place: Claude Code has no `--fast` and reads `fastMode` out of the
   * settings file its process was built with, exactly once, so a control frame asking for it is
   * answered `success` and changes nothing (measured — runner-go/claude_fastmode_requestbody_test.go).
   * Codex's fast lane is a per-request service tier and needs no such thing, but every Codex field
   * already rides the reload (see `acceptsLiveConfig`), so it lands on the next turn all the same.
   * Model, permission mode and effort are not spawn-only: a resident engine can be told about all
   * three, so they travel as `setconfig`, which the inbox hands over mid-turn. A PATCH that moves
   * both halves queues both, setconfig first — unless the provider switch re-resolves the model,
   * which is the one value a process still on the old endpoint cannot be told (see
   * `modelCrossesProvider` below).
   *
   * Telling one requires a runtime with a control protocol to hear it, which is claude alone;
   * for the ACP and one-shot runtimes the whole config rides the reload, exactly as it always
   * did — see `acceptsLiveConfig` below.
   *
   * A not-yet-claimed (PENDING) session needs neither: the claim reads the new values.
   *
   * `credential` is the user door's. A personal access token may not change the permission mode at
   * all, to any value: a mode that runs without asking would take approvals — which only a login may
   * answer — out of the session's way (docs/personal-access-token-design.md §5). The rest is a token's.
   */
  async updateConfig(ownerId: string, id: string, dto: SessionConfigDto, credential?: AuthCredential) {
    refuseOwnerFieldsToToken(credential, { permissionMode: dto.permissionMode });
    if (
      dto.model === undefined &&
      dto.permissionMode === undefined &&
      dto.effort === undefined &&
      dto.fastMode === undefined &&
      dto.provider === undefined &&
      dto.account === undefined
    ) {
      throw new BadRequestException('nothing to update');
    }
    // Retried whole: a locked re-read decides what the new config may be, and the inbox nudge
    // below happens once, after commit.
    const queuedControlTurn = await withTransactionRetry(this.prisma, async (tx) => {
      // Serialize config patches with each other and with claim/end transitions. The effective
      // model/mode pair must be derived from the latest row: two concurrent partial PATCHes must
      // not restore each other's stale model or leave Auto paired with an unsupported model.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');

      const session = await tx.session.findUniqueOrThrow({
        where: { id },
        include: {
          workspace: true,
          assignedRunner: {
            select: { runtimeDefaultModels: true, modelCatalog: true, runsAsRoot: true, engines: true, capabilities: true, capabilitiesReportedAt: true },
          },
          // The account-level permission default, which replaced the per-workspace one.
          owner: { select: { preferences: true } },
        },
      });
      if (SessionsService.TERMINAL.includes(session.status)) {
        throw new ConflictException('the session has ended');
      }
      const next = await this.resolveProviderSwitch(tx, session, dto.provider);
      const accounts = await this.accountOnProviderSwitch(tx, id, next, dto.account);
      const poolRuntime = isBuiltinProvider(next.provider, next.providerBuiltin) || next.customRow
        ? null
        : await accountPoolRuntime(tx, ownerId, next.provider);
      const exec = resolveProviderExec({
        declaredProvider: poolRuntime ?? next.provider,
        declaredProviderBuiltin: poolRuntime ? true : next.providerBuiltin,
        customRow: next.customRow,
        // A model naming a configured key is refused here, with its reason, when the key cannot run.
        openCodeKeys:
          next.provider === AgentProvider.OPENCODE && openCodeKeyOf(dto.model ?? session.model)
            ? await openCodeKeyRows(tx, ownerId)
            : undefined,
        sessionModel: dto.model ?? (next.keepsModel ? session.model : null),
        usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
        runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
        workspaceModel: session.workspace?.model,
        modelCatalog: session.assignedRunner?.modelCatalog,
        workspaceEnv: session.workspace?.env as Record<string, string> | null,
        codexAccount: accounts.codexAccount ?? session.codexAccount ?? session.workspace?.codexAccount,
        claudeAccount: accounts.claudeAccount ?? session.claudeAccount ?? session.workspace?.claudeAccount,
        antigravityAccount:
          accounts.antigravityAccount ?? session.antigravityAccount ?? session.workspace?.antigravityAccount,
        runnerEngines: session.assignedRunner?.engines,
      });
      if (exec.provider === AgentProvider.DSH && (!session.assignedRunner?.capabilitiesReportedAt ||
        !session.assignedRunner.capabilities?.includes('provider:dsh'))) {
        throw new ConflictException(DSH_RUNNER_UPGRADE_ERROR);
      }
      const requestedPermissionMode =
        (dto.permissionMode as PermissionMode | undefined) ??
        resolvePermissionMode(session.permissionMode, session.owner);
      const normalizedPermissionMode = normalizeBuiltinPermissionMode(
        exec.provider,
        exec.model,
        requestedPermissionMode,
        next.customRow?.enabled === true,
        session.assignedRunner?.runsAsRoot,
        session.assignedRunner?.modelCatalog,
      );
      const normalizedEffort =
        dto.effort !== undefined
          ? normalizeEffortForProvider(exec.provider, dto.effort)
          : undefined;
      // What the engine is told about effort. For a model whose row declares the levels it accepts,
      // the claim spawned it on a level mapped onto that list, so every move that could leave it on
      // one the model refuses — the effort itself, the model, the provider — states the mapped
      // effective effort, and the row keeps the value the person picked. For everything else it is
      // the value stored below, exactly as before.
      const engineEffort =
        exec.reasoningLevels &&
        (dto.effort !== undefined || next.changed || exec.model !== session.model)
          ? normalizeEffortForRuntimeModel(
              exec.provider,
              dto.effort !== undefined ? normalizedEffort : (session.effort ?? session.workspace?.effort),
              exec.model,
              undefined,
              exec.reasoningLevels,
            )
          : normalizedEffort;
      // Clamped here, unlike on create: every part of the question — the runtime this session
      // executes on, the model it is being pointed at, and (for Codex) the tiers that model's row
      // in the assigned runner's catalogue advertises — is resolved above, so a PATCH that asks for
      // the fast lane where there is none is answered by storing the truth rather than a setting
      // the engine would drop without saying so.
      const normalizedFastMode =
        dto.fastMode !== undefined
          ? dto.fastMode === true &&
            fastModeAvailable(
              exec.provider,
              exec.model,
              session.assignedRunner?.modelCatalog as RunnerModelCatalog | null,
            )
          : undefined;
      await tx.session.update({
        where: { id },
        data: {
          lastTurnAt: new Date(), // reset the idle clock so the reaper won't tear down mid-reload
          // Persist the complete effective pair. This snapshots inherited defaults and keeps DB,
          // UI and the restarted runtime on the same provider-aware Auto normalization.
          model: exec.model,
          permissionMode: normalizedPermissionMode,
          ...(dto.effort !== undefined ? { effort: normalizedEffort } : {}),
          ...(normalizedFastMode !== undefined ? { fastMode: normalizedFastMode } : {}),
          ...(next.changed
            ? { provider: next.provider, providerBuiltin: next.providerBuiltin }
            : {}),
          ...accounts,
        },
      });

      if (session.status === RunStatus.PENDING) return false;
      // A claim marks the row RUNNING before buildSession lazily seeds the opening prompt. A
      // config PATCH in that small window must seed it first; otherwise the control turn would
      // become the first turn and the claim path could mistake it for the opening message.
      if (session.numTurns === 0) await this.ensurePromptSeeded(tx, session);
      // Whether there is anything to say the new config TO. `setconfig` is a stream-json
      // control_request, and claude is the only runtime spoken to that way: codex and kimi are
      // driven over ACP/JSON-RPC, opencode runs one process per turn, antigravity's stream-json
      // input takes nothing but user messages (agy exits on a control_request, contract §1.1), and
      // none of their session loops has an arm for the kind — one filed there is acked on delivery
      // and applied by nobody, which is worse than the wait this split removed. For them the live
      // half stays what it always was: part of the re-spawn, effort included.
      //
      // Asked of the RUNTIME, the way deliverSteer asks its own question, and read off
      // `resolveProviderExec` — whose `provider` IS that runtime (`execRuntime`), resolved after
      // the switch above. A configured (BYOK) slug is its owner's word and says nothing about
      // the CLI underneath; judged by the slug, the borrowers of the claude runtime would be the
      // ones losing the frame.
      const acceptsLiveConfig = exec.provider === AgentProvider.CLAUDE;
      const effortMoved = dto.effort !== undefined && normalizedEffort !== session.effort;
      const fastModeMoved =
        normalizedFastMode !== undefined && normalizedFastMode !== session.fastMode;
      // Which half of the config actually moved decides what is queued. The provider is
      // spawn-only — a process's environment is decided when it is built, so the only way to
      // change it is to build another one, and that is what `reload` is. Model, permission mode
      // and effort are not: a resident engine can be told about each, so they go out as
      // `setconfig`, which the inbox hands over mid-turn instead of holding until the running
      // turn ends. Effort joined them on measured behaviour, not on principle — an
      // apply_flag_settings frame moves the effort of the API calls the RUNNING turn goes on to
      // make (runner-go/claude_setconfig.go), which is the whole reason it stopped being worth a
      // re-spawn. Claude's fast mode went the other way on the same evidence: the frame is
      // accepted, answered `success`, and every later request in the turn still goes out without it
      // — so it joins the provider on the spawn-only side even on the runtime that HAS a control
      // channel. (On Codex `acceptsLiveConfig` is false, so this term changes nothing there.)
      const respawns = !acceptsLiveConfig || next.changed || fastModeMoved;
      // The key an OpenCode model names lives in the process environment (resolveProviderExec).
      const openCodeKeyMoved =
        exec.provider === AgentProvider.OPENCODE &&
        openCodeKeyOf(exec.model)?.slug !== openCodeKeyOf(session.model)?.slug;
      // A switch that re-resolves the MODEL must not be said to the running engine, whatever else
      // moved beside it. Every value on this PATCH was resolved against the provider the session
      // is moving TO, while the process a control frame reaches is still talking to the one it is
      // moving FROM — and the CLI answers for the endpoint it is configured against, not for a
      // model some other provider serves. Measured 2026-09-16 on a live claude session
      // (anthropic-2 / claude-opus-5) moved to deepseek: the model frame was refused (`Model
      // 'deepseek-flash' not found`), the runner took the re-spawn its refusal path promises —
      // applying the committed config to job.Agent, but taking its environment from the reload
      // turn, which the inbox had not delivered yet — and the engine came up as deepseek-flash
      // against the ANTHROPIC endpoint. The resumed turn died on that endpoint's 404 ("There's an
      // issue with the selected model (deepseek-flash)"), the session's run failed, and the switch
      // the person asked for was left not in effect. `next.changed` queues the reload regardless,
      // and the reload carries model, permission mode and effort, so nothing is lost by leaving
      // all three to it.
      const modelCrossesProvider = next.changed && exec.model !== session.model;
      // …and the control frame goes whenever the live half moved. A PATCH that moved nothing at
      // all still sends one rather than falling silent: re-stating the committed pair is what
      // this kind costs, and it is cheaper than the reload that used to be sent here.
      const setsLiveConfig =
        acceptsLiveConfig &&
        !modelCrossesProvider &&
        (!respawns ||
          exec.model !== session.model ||
          normalizedPermissionMode !== session.permissionMode ||
          effortMoved);
      // Both are enqueued under this same row lock, so their payload is exactly the config
      // committed above. Order matters when both go: the re-spawn re-applies every flag anyway,
      // so putting it last keeps the control frame from being work that is immediately redone.
      if (setsLiveConfig) {
        await this.insertTurnLocked(tx, id, {
          kind: 'setconfig',
          content: JSON.stringify({
            model: exec.model,
            permissionMode: normalizedPermissionMode,
            // Stated only when this PATCH stated it, unlike the pair above. A session with no
            // effort of its own runs on its WORKSPACE's (the claim resolves `session.effort ??
            // workspace.effort`), so the session's committed value is not what the engine was
            // built with — restating it every time would tell a live engine to drop a workspace
            // default nobody touched. `undefined` is dropped by JSON.stringify, and the runner
            // reads an absent effort as "say nothing about effort". (A model with declared levels
            // is the exception engineEffort makes: there a model change is an effort change too.)
            effort: engineEffort,
          }),
          clientTurnId: randomUUID(),
        });
      }
      // `effort: undefined` is omitted by JSON.stringify when it did not change.
      if (respawns) {
        await this.insertTurnLocked(tx, id, {
          kind: 'reload',
          content: JSON.stringify({
            model: exec.model,
            permissionMode: normalizedPermissionMode,
            effort: engineEffort,
            // Stated only when this PATCH moved it, like `effort` and for the same reason: the
            // runner reads an absent `fastMode` as "say nothing about fast mode" and keeps what
            // the process it is replacing was running with.
            fastMode: fastModeMoved ? normalizedFastMode : undefined,
            // The identity only. It tells the runner its process environment is stale — the
            // credential behind it is resolved when the inbox delivers this turn, so a decrypted
            // provider key never lands in conversation_turn.
            // An OpenCode session moving between keys (or onto its machine's own config) needs a new
            // OPENCODE_CONFIG_CONTENT just as a provider switch does, so it names its provider too.
            provider: next.changed || openCodeKeyMoved ? next.provider : undefined,
          }),
          clientTurnId: randomUUID(),
        });
      }
      return true;
    }, loggedRetry(this.logger, 'sessions.updateConfig'));
    if (queuedControlTurn) this.realtime.notifyInbox(id);
    return { ok: true };
  }

  /**
   * Which of its runner's accounts a session on the built-in Codex or Claude engine runs on, picked in
   * the composer's Provider menu. An account the runner reports pins the session to it — its usage
   * limit then waits for the reset. `automatic` leaves it to Orbit: the session stays where it is until
   * that account's limit stops it, and moves then — or at once, when the account it is on is spent
   * already and another has room.
   *
   * A move is spawn-only, as a provider is: the account IS the engine's environment. On a live session
   * a `reload` naming the engine re-spawns it on the new account once no turn is in flight, and the
   * runner carries the conversation across (CODEX_ACCOUNT_MOVE_V1, CLAUDE_ACCOUNT_MOVE_V1); a runner
   * that declares neither is refused the move, since it would resume where the conversation is. An
   * ended or unclaimed one just stores it, for the claim that runs it next — at once, if it was waiting
   * out the old account's reset. The next engine start says so in the transcript.
   */
  async switchAccount(ownerId: string, id: string, account: unknown) {
    if (typeof account !== 'string' || (account !== AUTOMATIC_ACCOUNT && !ACCOUNT_ID_PATTERN.test(account))) {
      throw new BadRequestException('account must be "automatic", "default" or the id of one of the runner\'s accounts');
    }
    const reload = await withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          provider: true,
          providerBuiltin: true,
          retryAt: true,
          codexAccount: true,
          codexAccountPinned: true,
          claudeAccount: true,
          claudeAccountPinned: true,
          antigravityAccount: true,
          antigravityAccountPinned: true,
          workspace: { select: { env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true } },
          assignedRunner: { select: { engines: true, accountNames: true, accountPauses: true, planUsage: true, capabilities: true } },
        },
      });
      const engine: AccountEngine | null = isAccountEngine(session.provider) ? session.provider : null;
      if (!engine || !isBuiltinProvider(session.provider, session.providerBuiltin) || !session.assignedRunner) {
        throw new BadRequestException(
          "only a session on the built-in Codex, Claude or Antigravity engine runs on one of its runner's accounts",
        );
      }
      const runner = session.assignedRunner;
      const column = ACCOUNT_CHOICE[engine];
      const choice = { [column]: session[column] ?? session.workspace?.[column] };
      const current = runAccount(engine, session.workspace?.env, choice, runner.engines);
      if (!current) throw new BadRequestException("this session spends a key of its own, not one of its runner's accounts");
      const accounts = namedRunnerEngines(runner)?.find((entry) => entry.engine === engine)?.accounts;
      // Antigravity's quota travels with its engine health, and is weighed with the rest here.
      const usage = withEnginePlanUsage(runner.planUsage as PlanUsage | null, sanitizeRunnerEngines(runner.engines));
      const now = new Date();
      let to = current;
      let pinned = true;
      let notice: string | null = null;
      if (account === AUTOMATIC_ACCOUNT) {
        if (!workspaceLeavesAccountToOrbit(engine, session.workspace, runner.engines)) {
          throw new BadRequestException("this session's workspace decides its account");
        }
        pinned = false;
        const paused = runnerAccountPausedUntil(runner.accountPauses, engine, current, now) !== null;
        const spent = paused || planUsageBlockedUntil(usage, engine, now, current) != null;
        const roomier = spent ? accountToMoveTo(engine, accounts, usage, now, current) : null;
        if (roomier) {
          to = roomier;
          notice = accountSwitchNotice(engine, { from: current, to, ...(paused ? { paused: true } : {}) }, runner);
        }
      } else {
        const row = accounts?.find((entry) => entry.id === account);
        if (!row) throw new BadRequestException("that account is not one this session's runner reports");
        if (row.auth === 'no') throw new ConflictException("that account is signed out on this session's runner");
        if (runnerAccountPausedUntil(runner.accountPauses, engine, account, now)) {
          throw new ConflictException('That account is paused — resume it before switching');
        }
        to = account;
        if (to !== current) notice = `Switched to ${accountLabel(engine, to, runner)}`;
      }
      const moves = to !== current;
      if (moves && !runnerCarriesAccounts(runner, engine)) {
        throw new ConflictException(
          "this session's runner cannot move a conversation to another account yet — it updates itself when no turn is running",
        );
      }
      const live = !SessionsService.TERMINAL.includes(session.status) && session.status !== RunStatus.PENDING;
      await tx.session.update({
        where: { id },
        data: {
          [column]: to,
          [ACCOUNT_PINNED[engine]]: pinned,
          ...(notice ? { poolSwitchNotice: notice } : {}),
          // A session waiting out the old account's reset goes now, on the one with room.
          ...(moves && session.retryAt && session.retryAt > now ? { retryAt: now } : {}),
        },
      });
      if (!moves || !live) return false;
      await this.insertTurnLocked(tx, id, {
        kind: 'reload',
        content: JSON.stringify({ provider: engine }),
        clientTurnId: randomUUID(),
      });
      return true;
    }, loggedRetry(this.logger, 'sessions.switchAccount'));
    if (reload) this.realtime.notifyInbox(id);
    return { ok: true };
  }

  /**
   * Rename a session's display title. Unlike updateConfig this carries no runner side
   * effects and is allowed in any status (a dormant/ended session can still be renamed),
   * so there's no terminal guard and no reload turn.
   */
  async rename(ownerId: string, id: string, rawTitle: string) {
    const title = (rawTitle ?? '').trim();
    if (!title) throw new BadRequestException('title must not be empty');
    if (title.length > 200) throw new BadRequestException('title is too long (max 200 chars)');
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    // One statement is the ownership boundary: a manual rename and opting out of project-driven
    // synchronization either both land or neither does. Always clear the bit, even when the text
    // happens to equal the project title — equality is not intent and would introduce an ABA bug.
    await this.prisma.session.update({
      where: { id },
      data: { title, titleManagedByProject: false },
    });
    // A rename has no STATUS/TURN_END behind it, so without this the owner's OTHER clients (and
    // other tabs) keep the old title until the session's next turn.
    this.realtime.publishSessionUpdated(id);
    return { ok: true, title };
  }

  /**
   * Announce a title write committed by the Project service. Kept here so callers do not need a
   * second realtime dependency merely to publish the same session.updated nudge as `rename`.
   */
  announceProjectSessionChanged(id: string): void {
    this.realtime.publishSessionUpdated(id);
  }

  /** Stop following a deleted Project without racing a Session that was immediately promoted into
   * another one. Binding paths lock Session before Project, so taking that same Session lock first
   * fences every adopter. The Project check is deliberately a SECOND statement: under READ
   * COMMITTED it receives a fresh snapshot after any adopter we waited for has committed. */
  async releaseProjectTitleManagement(ownerId: string, id: string): Promise<void> {
    await withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "session"
         WHERE "id" = ${id}::uuid
           AND "owner_id" = ${ownerId}::uuid
           AND "title_managed_by_project" = TRUE
         FOR UPDATE`);
      if (locked.length === 0) return;
      const adopted = await tx.project.findFirst({
        where: { coordinatorSessionId: id },
        select: { id: true },
      });
      if (adopted) return;
      await tx.session.updateMany({
        where: { id, ownerId, titleManagedByProject: true },
        data: { titleManagedByProject: false },
      });
    }, loggedRetry(this.logger, 'sessions.releaseProjectTitleManagement'));
  }

  /**
   * Soft-delete a session (moves it to the trash view). No data is removed — the
   * transcript and billing stay; restore brings it back. There is no hard delete.
   * A session that hasn't ended is deleted too: like `complete`, we recycle its runner
   * process first so a live runtime isn't orphaned. Status settles to
   * CANCELLED async while the row already sits in Trash.
   */
  async remove(ownerId: string, id: string) {
    const ended = await this.transitionEnd(ownerId, id, SessionEndReason.DELETED, 'deletedAt');
    this.publishEndIntent(id, ended);
    // Soft-delete is a list-membership change with no STATUS event — signal the control plane.
    this.realtime.publishSessionLifecycleChanged(
      id,
      ended.status,
      ended.endReason,
      ended.lifecycleState,
    );
    return { ok: true };
  }

  /** Soft-delete a provisional coordinator only if no Project adopted it. The relation check,
   * managed-title release and Trash transition share the Session lock, closing the create→bind
   * race that an ordinary check followed by `remove` would leave open. */
  async discardProjectCoordinatorCandidate(ownerId: string, id: string): Promise<boolean> {
    const ended = await this.transitionEnd(
      ownerId,
      id,
      SessionEndReason.DELETED,
      'deletedAt',
      true,
    );
    if (ended.projectBound) return false;
    this.publishEndIntent(id, ended);
    this.realtime.publishSessionLifecycleChanged(
      id,
      ended.status,
      ended.endReason,
      ended.lifecycleState,
    );
    return true;
  }

  /** Bring a Completed or soft-deleted session back to Open. */
  async restore(ownerId: string, id: string) {
    // Retried whole. Restoring something already restored is the same answer on any attempt.
    await withTransactionRetry(this.prisma, async (tx) => {
      // Serialize with purge: if restore wins, purge re-reads an Open row and refuses;
      // if purge wins, this lock query sees no row and restore returns 404.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      await tx.session.update({
        where: { id },
        data: { completedAt: null, archivedAt: null, deletedAt: null },
      });
    }, loggedRetry(this.logger, 'sessions.restore'));
    // Back in Open — same signal as a brand-new session (the control plane's
    // session.created carries a full summary either way).
    this.realtime.publishSessionCreated(id);
    return { ok: true };
  }

  /** Pin a session to the top of the list (personal ordering; never touches the runner). */
  async pin(ownerId: string, id: string) {
    await this.get(ownerId, id); // ownership check (404s otherwise)
    await this.prisma.session.update({ where: { id }, data: { pinnedAt: new Date() } });
    return { ok: true };
  }

  /** Remove a session's pin, dropping it back into time order. */
  async unpin(ownerId: string, id: string) {
    await this.get(ownerId, id); // ownership check (404s otherwise)
    await this.prisma.session.update({ where: { id }, data: { pinnedAt: null } });
    return { ok: true };
  }

  /**
   * `POST /sessions/:id/move` (docs/session-folders-move-design.md §5.4): file a session in a
   * folder, or move it to another workspace.
   *
   * Within its own workspace (no `workspaceId`, or its own): files it in one of that workspace's
   * folders, or in none. Any session outside Trash may be filed, a running one included: a folder
   * is filing only, and nothing that runs a session reads it.
   *
   * To another workspace: see moveToWorkspaceLocked. What moves is the conversation; the code stays
   * on the session's branch in the old workspace's repository.
   *
   * Locks, lowest rank first (common/lock-order.ts). The named workspace FOR SHARE (15), as
   * rebindCoordinator holds its landing: a live, enabled one of the caller's cannot be deleted or
   * disabled under a move into it. The target folder FOR KEY SHARE (25): a folder delete takes the
   * folder and then, through ON DELETE SET NULL, the sessions in it, so a move that held its
   * session while waiting for the folder would be the other half of that cycle — and FOR KEY SHARE
   * is the lock the UPDATE's foreign-key check takes anyway, taken earlier rather than added. Then
   * the session FOR NO KEY UPDATE (30), written once.
   */
  async move(ownerId: string, id: string, dto: MoveSessionDto) {
    const folderId = dto.folderId ?? null;
    const workspaceId = dto.workspaceId ?? null;
    const moved = await withTransactionRetry(this.prisma, async (tx) => {
      const [workspace] = workspaceId
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "workspace"
             WHERE "id" = ${workspaceId}::uuid AND "owner_id" = ${ownerId}::uuid
               AND "deleted_at" IS NULL AND "enabled" = TRUE
               FOR SHARE`
        : [];
      const [folder] = folderId
        ? await tx.$queryRaw<Array<{ ownerId: string; workspaceId: string }>>`
            SELECT "owner_id" AS "ownerId", "workspace_id" AS "workspaceId"
              FROM "session_folder"
             WHERE "id" = ${folderId}::uuid
               FOR KEY SHARE`
        : [];
      const [session] = await tx.$queryRaw<
        Array<{ workspaceId: string | null; folderId: string | null; deletedAt: Date | null }>
      >`
        SELECT "workspace_id" AS "workspaceId", "folder_id" AS "folderId", "deleted_at" AS "deletedAt"
          FROM "session"
         WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`;
      if (!session) throw new NotFoundException('session not found');
      if (workspaceId && workspaceId !== session.workspaceId) {
        await this.moveToWorkspaceLocked(tx, ownerId, id, { workspaceId, held: !!workspace }, folder, folderId);
        return { from: session.workspaceId, workspaceId, changed: true };
      }
      if (session.deletedAt) {
        throw new ConflictException('this session is in Trash; restore it before moving it');
      }
      if (
        folderId &&
        (!folder || folder.ownerId !== ownerId || folder.workspaceId !== session.workspaceId)
      ) {
        throw new BadRequestException("folderId must be a folder of this session's workspace");
      }
      const unmoved = { from: session.workspaceId, workspaceId: session.workspaceId };
      if (session.folderId === folderId) return { ...unmoved, changed: false };
      await tx.session.update({ where: { id }, data: { folderId } });
      return { ...unmoved, changed: true };
    }, loggedRetry(this.logger, 'sessions.move'));
    if (moved.workspaceId !== moved.from) {
      // The cached workspace is what every later control event of this session names as its
      // `agentId`, and only a session ending evicts it — so it goes before anything is announced.
      // Both workspaces are announced as well: a workspace's default runtime is read off its newest
      // session, which this move may have taken away from one and given to the other.
      this.realtime.forgetSessionOwner(id);
      this.realtime.publishSessionUpdated(id);
      if (moved.from) this.realtime.publishWorkspaceChanged(id, moved.from, false);
      if (moved.workspaceId) this.realtime.publishWorkspaceChanged(id, moved.workspaceId, false);
    } else if (moved.changed) {
      // The list row moved; other clients learn where from the summary's folderId.
      this.realtime.publishSessionUpdated(id);
    }
    return { id, workspaceId: moved.workspaceId, folderId };
  }

  /**
   * The cross-workspace half of {@link move}, inside its transaction, with the session row locked
   * and — when it is one the session can go to — the named workspace. Every §5.2 condition is asked
   * again on those rows (session-move.ts), so whatever changed since the Move panel was drawn — the
   * session woke up, the workspace was disabled — is refused with the reason that is true now: a 409
   * the client shows as it is. Only an ended session moves; ending an idle one is the client's step
   * (End and Move), because ending is when its runner commits what it left uncommitted.
   *
   * Then ONE write of the session row, which re-checks each of its foreign keys once (I3): it
   * belongs to the new workspace and folder; it is assigned to the new workspace's runner, which is
   * where dispatch, resume and the session lists look for it; its branch keeps its name; what
   * described the old checkout is cleared, for the new runner to report afresh; and its account
   * columns follow §5.1 (accountsAfterMove).
   */
  private async moveToWorkspaceLocked(
    tx: Prisma.TransactionClient,
    ownerId: string,
    id: string,
    to: { workspaceId: string; held: boolean },
    folder: { ownerId: string; workspaceId: string } | undefined,
    folderId: string | null,
  ): Promise<void> {
    if (!to.held) {
      const workspace = await tx.workspace.findFirst({
        where: { id: to.workspaceId, ownerId },
        select: { deletedAt: true, enabled: true },
      });
      if (workspace?.deletedAt) throw new ConflictException('This workspace was deleted.');
      if (workspace && !workspace.enabled) throw new ConflictException('This workspace is disabled.');
      throw new ConflictException('Workspace not found.');
    }
    if (folderId && (!folder || folder.ownerId !== ownerId || folder.workspaceId !== to.workspaceId)) {
      throw new BadRequestException('folderId must be a folder of the workspace the session moves to');
    }
    const subject = await this.readMoveSubject(tx, ownerId, id);
    if (!subject) throw new NotFoundException('session not found');
    const { session, runtime, verdict } = subject;
    if (verdict.reason) throw new ConflictException(verdict.reason);
    if (verdict.needsEnd) throw new ConflictException(MOVE_REFUSAL.END);
    const target = await tx.workspace.findUniqueOrThrow({
      where: { id: to.workspaceId },
      select: {
        enabled: true,
        runnerId: true,
        enableWorktree: true,
        runner: { select: { name: true, displayName: true, capabilities: true, engines: true } },
      },
    });
    const sourceRunner = session.assignedRunner;
    const refusal = moveTargetRefusal(
      {
        runtime,
        assignedRunnerId: session.assignedRunnerId,
        runnerName: sourceRunner ? runnerLabel(sourceRunner) : 'its runner',
      },
      target,
    );
    if (refusal) throw new ConflictException(refusal);
    const fromWorktree = session.workspace?.enableWorktree ?? session.branch != null;
    await tx.session.update({
      where: { id },
      data: {
        workspaceId: to.workspaceId,
        folderId,
        assignedRunnerId: target.runnerId,
        branch: branchAfterMove(session, fromWorktree, target.enableWorktree),
        baseSha: null,
        changedFiles: Prisma.DbNull,
        isolationStatus: null,
        mergeStatus: null,
        mergeError: null,
        mergeRecovery: Prisma.DbNull,
        mergeRecoveryAction: null,
        mergeRequestedAt: null,
        mergeOperationId: null,
        mergeOperationOwner: null,
        mergedAt: null,
        mergedSourceSha: null,
        branchMerged: null,
        worktreeBranch: null,
        worktreeDirty: null,
        mergeTarget: null,
        mergeTargets: [],
        ...accountsAfterMove({
          sameRunner: target.runnerId === session.assignedRunnerId,
          session,
          from: session.workspace,
          runnerEngines: sourceRunner?.engines,
        }),
      },
    });
  }

  /** What the move reads of a session: what §5.2 judges, and what the move then writes from. */
  private static readonly MOVE_SUBJECT = {
    id: true,
    ownerId: true,
    title: true,
    status: true,
    deletedAt: true,
    completedAt: true,
    importSourceCwd: true,
    taskId: true,
    dispatchOrigin: true,
    cancelRequestedAt: true,
    engineTurnActive: true,
    runningBgShells: true,
    mergeStatus: true,
    commitStatus: true,
    mergeRecovery: true,
    retryAt: true,
    provider: true,
    providerBuiltin: true,
    workspaceId: true,
    folderId: true,
    assignedRunnerId: true,
    branch: true,
    changedFiles: true,
    branchMerged: true,
    mergeTarget: true,
    mergeTargets: true,
    claudeAccount: true,
    codexAccount: true,
    // At most one, by the unique index behind Project.coordinatorSessionId. Nothing in the database
    // keeps a coordinator in its workspace since 0164, so the move is what has to.
    coordinatorForProject: { select: { id: true } },
    task: {
      select: {
        codeless: true,
        project: {
          select: {
            codebases: {
              where: { slot: 'primary' },
              select: { integrationRef: true },
              take: 1,
            },
          },
        },
      },
    },
    workspace: {
      select: { env: true, claudeAccount: true, codexAccount: true, enableWorktree: true, defaultMergeTarget: true },
    },
    assignedRunner: { select: { name: true, displayName: true, status: true, lastHeartbeatAt: true, engines: true } },
  } satisfies Prisma.SessionSelect;

  /**
   * A session and the verdict on whether it may leave its workspace (sessionMoveVerdict), read
   * through `db`: the move's own transaction, which holds the session row, or a plain read for the
   * panel. Null when the caller owns no such session.
   */
  private async readMoveSubject(db: Prisma.TransactionClient, ownerId: string, id: string) {
    const session = await db.session.findFirst({ where: { id, ownerId }, select: SessionsService.MOVE_SUBJECT });
    if (!session) return null;
    // Only an open session can still be asking or have work queued; on an ended one these are
    // leftovers that nothing will act on.
    const open = !SessionsService.TERMINAL.includes(session.status);
    const liveApprovals = open ? await countLiveApprovals(db, session) : 0;
    const queuedTurns = open
      ? await db.conversationTurn.count({
          where: {
            sessionId: id,
            kind: { in: ['message', 'shell', 'steer'] },
            status: { in: ['PENDING', 'IN_FLIGHT'] },
          },
        })
      : 0;
    const runtime = await sessionExecRuntime(db, session);
    const verdict = sessionMoveVerdict({
      ...session,
      coordinatesProject: session.coordinatorForProject != null,
      liveApprovals,
      queuedTurns,
      mergeRecoveryOpen: readMergeRecovery(session.mergeRecovery) != null,
      runtime,
    });
    return { session, runtime, verdict };
  }

  /**
   * `GET /sessions/:id/move-targets`: what the Move panel shows (§4, §5.2–5.3) — the folders of the
   * session's workspace, each of the owner's other workspaces with whether the session can move
   * there and why not, whether it has to be ended first, and what its confirmation says about the
   * code left behind. Judged here because only the server has every input: runner capabilities and
   * engines, liveness, the session's runtime. The same rules refuse `POST /sessions/:id/move`, which
   * asks them again on locked rows.
   */
  async moveTargets(ownerId: string, id: string): Promise<SessionMoveTargets> {
    const subject = await this.readMoveSubject(this.prisma, ownerId, id);
    if (!subject) throw new NotFoundException('session not found');
    const { session, runtime, verdict } = subject;
    const sourceRunner = session.assignedRunner;
    const sourceRunnerName = sourceRunner ? runnerLabel(sourceRunner) : null;
    // Ending is the old runner's to do — it commits what the session left uncommitted — so an End
    // and Move needs it online. An ended session has no such need.
    const reason =
      verdict.reason ??
      (verdict.needsEnd && !(sourceRunner && runnerIsOnline(sourceRunner))
        ? `${sourceRunnerName ?? 'Its runner'} has to be online to end the session first.`
        : null);
    const workspaces = await this.prisma.workspace.findMany({
      where: { ownerId, deletedAt: null },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        enabled: true,
        runnerId: true,
        workDir: true,
        runner: {
          select: { name: true, displayName: true, status: true, lastHeartbeatAt: true, capabilities: true, engines: true },
        },
      },
    });
    const folders = await this.prisma.sessionFolder.findMany({
      where: { ownerId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, workspaceId: true, name: true },
    });
    const filed = folders.length
      ? await this.prisma.session.groupBy({
          by: ['folderId'],
          where: { ownerId, deletedAt: null, folderId: { in: folders.map((f) => f.id) } },
          _count: { _all: true },
        })
      : [];
    const counts = new Map(filed.map((row) => [row.folderId, row._count._all]));
    const foldersOf = (workspaceId: string | null): SessionMoveFolder[] =>
      folders
        .filter((f) => f.workspaceId === workspaceId)
        .map((f) => ({ id: f.id, name: f.name, sessionCount: counts.get(f.id) ?? 0 }));
    const others = workspaces.filter((w) => w.id !== session.workspaceId);
    const seeds = await lastProviderByWorkspace(this.prisma, others.map((w) => w.id));
    const changedFiles = changedFileCount(session.changedFiles);
    return {
      workspaceId: session.workspaceId,
      folderId: session.folderId,
      folders: foldersOf(session.workspaceId),
      reason,
      needsEnd: verdict.needsEnd,
      branch: session.branch,
      changedFiles,
      unmergedFiles: branchIsMerged(session) ? 0 : changedFiles,
      mergeTarget: session.branch
        ? mergeTargetOf(
            session,
            session.workspace?.defaultMergeTarget,
            session.task && !session.task.codeless ? session.task.project?.codebases[0]?.integrationRef : null,
          )
        : null,
      targets: others.map((w): SessionMoveTarget => {
        const sameRunner = w.runnerId != null && w.runnerId === session.assignedRunnerId;
        return {
          workspaceId: w.id,
          name: w.name,
          provider: seeds.get(w.id)?.provider ?? AgentProvider.CLAUDE,
          runnerId: w.runnerId,
          runnerName: w.runner ? runnerLabel(w.runner) : null,
          runnerOnline: w.runner ? runnerIsOnline(w.runner) : false,
          workDir: w.workDir,
          reason: moveTargetRefusal(
            { runtime, assignedRunnerId: session.assignedRunnerId, runnerName: sourceRunnerName ?? 'its runner' },
            w,
          ),
          // The same runner carries the conversation to the new directory as it is; another one
          // rebuilds it from Orbit's record (§5.2).
          conversation: sameRunner ? 'continues' : 'rebuilt',
          folders: foldersOf(w.id),
        };
      }),
    };
  }

  /**
   * Permanently delete a trashed session and everything hanging off it — events, turns,
   * tool calls, usage, approvals, diff, and session-scoped attachments all cascade away at
   * the DB level (ON DELETE CASCADE). Irreversible. Guarded to sessions already in Trash
   * (deletedAt set), so an Open/Completed session can never be hard-deleted in one step —
   * the user must soft-delete first (matching an "empty trash" flow). Tasks the session
   * created are detached (Task.creatorSessionId → null), not deleted.
   */
  async purge(ownerId: string, id: string) {
    // Retried whole, for the same reason as restore: it is decided from a locked re-read.
    await withTransactionRetry(this.prisma, async (tx) => {
      // The Trash guard and irreversible delete must share the same row lock as restore.
      // A pre-lock deletedAt read could otherwise delete a session restored in between.
      const locked = await tx.$queryRaw<Array<{ id: string; deletedAt: Date | null }>>`
        SELECT id, "deleted_at" AS "deletedAt" FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      const session = locked[0];
      if (!session) throw new NotFoundException('session not found');
      if (!session.deletedAt) {
        throw new BadRequestException('session must be in Trash before it can be permanently deleted');
      }
      await tx.session.delete({ where: { id: session.id } });
    }, loggedRetry(this.logger, 'sessions.purge'));
    return { ok: true };
  }
}
