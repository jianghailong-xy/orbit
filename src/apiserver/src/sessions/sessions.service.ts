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
  Prisma,
  RunStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  WorkspaceProvisionState,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  ApprovalDecisionRequest,
  ApprovalInfo,
  ApprovalStatus,
  AgentProvider,
  type BgShell,
  deriveBackgroundShells,
  deriveSessionFilingState,
  deriveSessionLifecycleState,
  type EventSearchResponse,
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
  type SessionResumeBlockedReason,
  SessionRunState,
  SessionState,
  type SessionSearchHit,
  supportsMidTurnSteer,
  uuidToBase62,
} from '@orbit/shared';
import { agentProviderSeed } from '../workspaces/workspace-provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  TaskWorkFacts,
  isLockNotAvailable,
  taskWorkRefusal,
} from '../tasks/task-supersession';
import { TaskRunFenceLost, type TaskRunEffectFence } from '../tasks/task-run-receipt';
import {
  accountDefaultPermissionMode,
  resolvePermissionMode,
} from '../common/permission-mode';
import { normalizePermissionRules } from '../common/permission-rules';
import {
  batchActiveTurns,
  runnerActiveTurns,
  treeActiveTurns,
  treeCeiling,
} from '../common/session-tree-sql';
import { QueueService } from '../queue/queue.service';
import { mergeDispatchGate } from '../projects/task-checkpoint.service';
import { MergeReceiptRow, mergeReceiptRow } from './merge-receipt';
import { RealtimeService } from '../realtime/realtime.service';
import { MAX_UPLOAD_BYTES, toBytes } from '../attachments/attachments.media';
import { SESSION_TAG_PALETTE } from '../session-tags/session-tags.service';
import {
  CreateSessionDto,
  SessionConfigDto,
  SessionInterruptDto,
  SessionResumeDto,
  SessionTurnDto,
} from './dto';
import {
  enqueueBeautifySession,
  MAX_KNOWN_TAGS_PROMPTED,
  makeBranchName,
  titleFromPrompt,
} from './naming';
import {
  broaden,
  normalizeSearchQuery,
  type NormalizedSearchQuery,
  stripEmphasis,
} from './search-query';
import { notNoiseSql } from '../common/system-noise';
import {
  SERVICE_TOKEN_CONCURRENCY,
  SPAWN_TREE_OUTSTANDING,
  UNSETTLED_SESSION_STATUSES,
  statusAfterTurnEnqueued,
} from '../common/session-scheduling';
import { GENERATING_SESSION_FILTER, isSessionGenerating } from '../common/session-generating';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForProvider,
  normalizeRuntimeProvider,
} from '../common/runtime-provider';
import {
  execRuntime,
  isBuiltinProvider,
  resolveProviderExec,
  sessionExecRuntime,
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
  isAggregateParent,
} from '../projects/task-aggregation';
import { truncatePayload } from './truncate-payload';
import { EngineSignedOutConflict, signedOutEngineRefusal } from './engine-signin-preflight';
import {
  SESSION_RUNNER_OFFLINE_AFTER_MS,
  deriveSessionCapabilities,
  withSessionCapabilities,
  withSessionState,
} from './session-state';

// The furthest ahead a hand-armed retry may be scheduled (armAutoRetry). Just past the longest
// window a provider actually reports — a weekly quota — so a bad clock parks a session for days
// at worst, never indefinitely.
const MAX_ARM_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

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

type TurnPlacement = 'accepted' | 'queued' | 'steer';

interface ListedQueuedTurn {
  turnId: string;
  kind: string;
  content: string;
  attachments: Array<{ id: string; mimeType: string }>;
}

interface ListedActiveTurn extends ListedQueuedTurn {
  placement: TurnPlacement;
  createdAt: string;
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

/**
 * A workspace whose working directory is not on its machine yet cannot host a session.
 *
 * Refused here rather than at spawn because of what the two failures LOOK like. The runtime
 * starting in a directory that does not exist dies with ENOENT and an absolute path — which reads
 * as a broken workspace, minutes after the click, on a machine the user cannot see. Said here it
 * is one sentence about a clone that is still running or has already failed, at the moment
 * somebody asks the workspace to do something.
 *
 * Both non-READY states are refused for the one reason: there is no directory. A failed clone has
 * an exit that a session is not — retry it, fix the URL, or point it at another machine.
 */
function assertWorkspaceProvisioned(state: WorkspaceProvisionState): void {
  if (state === 'CLONING') {
    throw new ForbiddenException(
      'this workspace is still cloning — its working directory is not on the machine yet',
    );
  }
  if (state === 'FAILED') {
    throw new ForbiddenException(
      "this workspace's clone failed, so it has no working directory — retry the clone, " +
        'correct the repository URL, or clone it onto another machine',
    );
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
      seq, type, created_at, payload,
      ${stripMarks(Prisma.sql`
        concat_ws(' ',
          payload->>'text',
          payload->>'name',
          (payload->'input')::text,
          CASE WHEN jsonb_typeof(payload->'content') = 'string'
               THEN payload->>'content'
               ELSE (payload->'content')::text END,
          payload->>'message'
        )
      `)} AS text
    FROM run_event
    WHERE session_id = ${id}::uuid
      AND type IN ('user', 'assistant', 'thinking', 'tool_use', 'tool_result', 'error')
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

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

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
    },
  ) {
    if (!dto.prompt) throw new BadRequestException('prompt is required');
    assertPromptSize(dto.prompt, 'prompt');
    // The session runs on a runner. Prefer an explicit pin; otherwise derive it from
    // the chosen workspace's machine (workspaces belong to a runner) — picking a workspace is
    // enough to know which machine + project dir to run in.
    let assignedRunnerId: string | undefined = dto.assignedRunnerId;
    // The session's provider identity: a built-in ("claude"/"codex"/"opencode") or a custom
    // slug ("deepseek"). Stored verbatim; runtime is derived below. A workspace holds no provider of
    // its own — absent an explicit pick this is seeded from what the project last ran on.
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
    // The workspace's own environment, which may carry the provider credential that makes the
    // runner's engine sign-in irrelevant — see the sign-in preflight below.
    let workspaceEnv: unknown;
    if (!assignedRunnerId && dto.workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: dto.workspaceId, ownerId, deletedAt: null },
        select: {
          runnerId: true,
          enableWorktree: true,
          enabled: true,
          env: true,
          provisionState: true,
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
      assertWorkspaceProvisioned(workspace.provisionState);
      assignedRunnerId = workspace.runnerId ?? undefined;
      enableWorktree = workspace.enableWorktree;
      workspaceEnv = workspace.env;
    } else if (dto.workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: dto.workspaceId, ownerId, deletedAt: null },
        select: { enableWorktree: true, enabled: true, env: true, provisionState: true },
      });
      if (!workspace) throw new ForbiddenException('workspace not found');
      if (workspace.enabled === false) throw new ForbiddenException('workspace is disabled');
      assertWorkspaceProvisioned(workspace.provisionState);
      enableWorktree = workspace.enableWorktree;
      workspaceEnv = workspace.env;
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
      if (!providerBuiltin) {
        const configured = await this.prisma.modelProvider.findFirst({
          where: { slug: dto.provider, enabled: true, OR: [{ ownerId: null }, { ownerId }] },
          select: { runtime: true },
        });
        if (!configured) throw new BadRequestException('provider not available');
        borrowedRuntime = configured.runtime;
      }
    } else if (!providerBuiltin) {
      // Inherited from the workspace, so it hasn't been looked up yet. A row that has since been
      // deleted or disabled leaves this null: dispatch falls back to Claude, and so does the
      // runtime below.
      const configured = await this.prisma.modelProvider.findFirst({
        where: { slug: provider, enabled: true, OR: [{ ownerId: null }, { ownerId }] },
        select: { runtime: true },
      });
      borrowedRuntime = configured?.runtime ?? null;
    }
    await this.assertOwnedRefs(ownerId, { workspaceId: dto.workspaceId, assignedRunnerId });
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
    if (requestedMode && ROOT_REFUSED_PERMISSION_MODES.has(requestedMode)) {
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
    // Linking to a task: it must belong to the same user (no cross-tenant linking).
    if (dto.taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, ownerId },
        select: { id: true },
      });
      if (!task) throw new ForbiddenException('task not found');
    }
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
    const title = explicitTitle ?? titleFromPrompt(dto.prompt);
    let branch = enableWorktree ? makeBranchName(title) : null;
    // provider is the identity stored on the row; runtime is which built-in CLI actually
    // drives it (a custom provider borrows Claude/Codex/Kimi), and decides the pre-generated
    // session-id and effort normalization. A borrowed runtime is authoritative here: giving a
    // Codex/Kimi session a Claude-style id it never created makes its very first spawn a resume
    // of a conversation that doesn't exist.
    const runtime = borrowedRuntime
      ? normalizeRuntimeProvider(borrowedRuntime)
      : normalizeRuntimeProvider(provider, providerBuiltin);
    // Refuse now if the machine this is bound for cannot start it at all, rather than creating a
    // session (and, on the runner, a git checkout) that dies a second later with the same message.
    // Only for a runtime signed out on an online runner — see signedOutEngineRefusal for
    // everything this deliberately lets through.
    const targetRunner = await this.prisma.runner.findFirst({
      where: { id: assignedRunnerId, ownerId },
      select: { name: true, displayName: true, status: true, lastHeartbeatAt: true, engines: true },
    });
    const refusal =
      targetRunner &&
      signedOutEngineRefusal({
        runtime,
        bringsOwnCredentials: borrowedRuntime != null,
        workspaceEnv,
        runner: targetRunner,
      });
    // Typed, not a bare 409: this is an availability condition — the engine is signed out on a
    // machine that is up — and a caller that retries has to be able to tell it from a refusal that
    // will never succeed. See `EngineSignedOutConflict`.
    if (refusal) throw new EngineSignedOutConflict(runtime, refusal);
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
        // Codex/Kimi/OpenCode create and return their own thread id after process init.
        runtimeSessionId: runtime === AgentProvider.CLAUDE ? runtimeSessionId : null,
        model: dto.model,
        // Old replicas omit this post-0079 column and receive its false default. That lets claim
        // distinguish their legacy null-model inheritance from new Runtime-default semantics.
        usesRuntimeDefaultModel: true,
        permissionMode: rootRefusedFallback ?? dto.permissionMode ?? accountPermissionMode,
        effort: normalizeEffortForProvider(runtime, dto.effort),
        workspaceId: dto.workspaceId,
        assignedRunnerId,
        taskId: dto.taskId,
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
      },
    }));
    // Scope the compose-page uploads to this session now that it exists. They stay
    // turn-less until the runner seeds the first turn (queue.service links them to it),
    // and cascade-delete with the session.
    if (attachmentIds.length > 0) {
      await this.prisma.attachment.updateMany({
        where: { id: { in: attachmentIds }, sessionId: null, turnId: null },
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
    // DeepSeek. The branch is deliberately left as-is when the display title is later improved.
    if (!hasExplicitTitle) void this.beautifySessionLater(ownerId, session.id, dto.prompt, title);
    // Title ownership/provenance is an internal synchronization mechanism, not a public setting.
    const {
      titleManagedByProject: _titleManagedByProject,
      titleBeforeProjectManagement: _titleBeforeProjectManagement,
      ...publicSession
    } = session;
    return withSessionState(publicSession);
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
        workspace: { select: { enableOrchestration: true } },
      },
    });
    if (!parent) throw new NotFoundException('parent session not found');
    if (!parent.workspace?.enableOrchestration) {
      throw new ForbiddenException('orchestration is not enabled for this workspace');
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
    dto: { prompt: string; title?: string; model?: string; permissionMode?: string },
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
      {
        prompt: dto.prompt,
        title: dto.title,
        workspaceId: workspace.id,
        model: dto.model,
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
                e.payload->>'text' AS raw_text
              FROM run_event e
              -- Not merely a lookup: run_event has no owner column, so this join IS the
              -- authorization boundary for conversation text. Never drop it.
              JOIN session s ON s.id = e.session_id
              WHERE s.owner_id = ${ownerId}::uuid
                AND e.type IN ('user', 'assistant')
                AND ${matches(stripMarks(Prisma.sql`e.payload->>'text'`))}
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
   * model is already running. `needsYou` is returned separately and wins the sidebar status slot.
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
    const [active, running, blocked] = await Promise.all([
      this.prisma.session.groupBy({
        by: ['workspaceId'],
        where: { ...open, status: { in: [RunStatus.RUNNING, RunStatus.PENDING] } },
        _count: { _all: true },
      }),
      this.prisma.session.groupBy({
        by: ['workspaceId'],
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
        _count: { _all: true },
      }),
      // Only the blocked rows come back (a handful at most), so this stays a lookup, not a scan
      // of the whole list. This one counts prompts a human has to answer, which a self-driven
      // turn raises just as well — and those sit at AWAITING_INPUT for the whole turn.
      this.prisma.session.findMany({
        where: { ...open, ...GENERATING_SESSION_FILTER, approvals: { some: { status: 'PENDING' } } },
        select: { workspaceId: true },
      }),
    ]);
    const counts = new Map<
      string,
      { workspaceId: string; active: number; running: number; needsYou: number }
    >();
    const row = (workspaceId: string) => {
      const existing = counts.get(workspaceId);
      if (existing) return existing;
      const fresh = { workspaceId, active: 0, running: 0, needsYou: 0 };
      counts.set(workspaceId, fresh);
      return fresh;
    };
    for (const group of active) {
      if (group.workspaceId) row(group.workspaceId).active = group._count._all;
    }
    for (const group of running) {
      if (group.workspaceId) row(group.workspaceId).running = group._count._all;
    }
    for (const session of blocked) {
      if (session.workspaceId) row(session.workspaceId).needsYou += 1;
    }
    return [...counts.values()];
  }

  async list(
    ownerId: string,
    filters: {
      runnerId?: string;
      workspaceId?: string;
      tagId?: string;
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
    // Same reasoning for the list's tag filter: narrowing a page client-side can leave too few
    // rows to fill (or scroll) the column while the matches sit in pages nobody asked for.
    const tagFilter = filters.tagId
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM session_tag_link stl
          WHERE stl.session_id = s.id AND stl.tag_id = ${filters.tagId}::uuid
        )`
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
      lastAssistantText: string | null;
      lastToolUse: string | null;
      lastUserText: string | null;
      mergeStatus: string | null;
      pinnedAt: Date | null;
      tags: { id: string; name: string; color: string; isSystem: boolean; position: number }[];
      runningBgCount: number;
      runningSubagentCount: number;
      engineTurnActive: boolean;
      engineStartedAt: Date | null;
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
        left(s.last_assistant_text, ${SessionsService.PREVIEW_LEN}::int) AS "lastAssistantText",
        s.last_tool_use   AS "lastToolUse",
        left(s.last_user_text, ${SessionsService.PREVIEW_LEN}::int) AS "lastUserText",
        s.merge_status    AS "mergeStatus",
        s.pinned_at       AS "pinnedAt",
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
        cardinality(s.running_subagents)::int AS "runningSubagentCount",
        s.engine_turn_active AS "engineTurnActive",
        s.engine_started_at AS "engineStartedAt",
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
        ${runnerFilter}
        ${workspaceFilter}
        ${tagFilter}
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
        lastAssistantText: r.lastAssistantText,
        lastToolUse: r.lastToolUse,
        lastUserText: r.lastUserText,
        mergeStatus: r.mergeStatus,
        pinnedAt: r.pinnedAt,
        tags: r.tags,
        runningBgCount: r.runningBgCount,
        runningSubagentCount: r.runningSubagentCount,
        engineTurnActive: r.engineTurnActive,
        engineStartedAt: r.engineStartedAt,
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
        // Null unless the row is queued behind a cap — "waiting its turn" is not a gate.
        queuedReason: r.queuedReason,
        queuedActive: r.queuedActive == null ? null : Number(r.queuedActive),
        queuedLimit: r.queuedLimit == null ? null : Number(r.queuedLimit),
      }),
    );
    // A turn blocked on a permission prompt keeps the session generating, so the list can't tell
    // "running" from "waiting for approval" without this count. Only a generating session can
    // hold a live approval; skip the query otherwise. That includes a self-driven turn, which
    // stays at AWAITING_INPUT while it runs — its prompt is no less blocking for it.
    const generating = sessions.filter(isSessionGenerating).map((s) => s.id);
    if (generating.length === 0) return sessions.map((s) => ({ ...s, pendingApprovals: 0 }));
    const counts = await this.prisma.approval.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: generating }, status: 'PENDING' },
      _count: { _all: true },
    });
    const byId = new Map(counts.map((c) => [c.sessionId, c._count._all]));
    return sessions.map((s) => ({ ...s, pendingApprovals: byId.get(s.id) ?? 0 }));
  }

  async get(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      include: {
        workspace: true,
        assignedRunner: {
          select: { id: true, name: true, status: true, lastHeartbeatAt: true },
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
        coordinatorForProject: { select: { id: true, title: true } },
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
    // Flatten the join to a picker-ordered `tags` array (system first), matching the list payload.
    // The coordinated project is flattened the same way and for the same reason `taskTitle` is:
    // a name beside its id, so a client can label the link without a second request. Both keys are
    // always present — null on the ordinary session that coordinates nothing — and `projectId` is
    // rendered base62 by PublicIdInterceptor like every other address in the payload.
    const {
      tagLinks,
      coordinatorForProject,
      titleManagedByProject: _titleManagedByProject,
      titleBeforeProjectManagement: _titleBeforeProjectManagement,
      ...rest
    } = projected;
    const tags = tagLinks
      .map((l) => l.tag)
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.position - b.position);
    return withSessionCapabilities({
      ...rest,
      tags,
      projectId: coordinatorForProject?.id ?? null,
      projectTitle: coordinatorForProject?.title ?? null,
    });
  }

  /**
   * Enable a public read-only share link for this session: mint an unguessable `shareToken`
   * (idempotent — returns the existing one if already shared). The token alone is the
   * capability; anyone with the link can read the transcript with no login (see getShared).
   */
  async enableShare(ownerId: string, id: string): Promise<{ shareToken: string; sharedAt: Date }> {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { shareToken: true, sharedAt: true },
    });
    if (!session) throw new NotFoundException('session not found');
    if (session.shareToken && session.sharedAt) {
      return { shareToken: session.shareToken, sharedAt: session.sharedAt };
    }
    const updated = await this.prisma.session.update({
      where: { id },
      data: { shareToken: randomBytes(24).toString('base64url'), sharedAt: new Date() },
      select: { shareToken: true, sharedAt: true },
    });
    return { shareToken: updated.shareToken!, sharedAt: updated.sharedAt! };
  }

  /** Revoke the public share link (the token 404s afterwards). No-op if not shared. */
  async disableShare(ownerId: string, id: string): Promise<void> {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!session) throw new NotFoundException('session not found');
    await this.prisma.session.update({ where: { id }, data: { shareToken: null, sharedAt: null } });
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
    await this.prisma.session.update({ where: { id }, data: { retryAt: null } });
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
      if (target?.taskId) {
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
          startsTaskWork: target?.startsTaskWork ?? false,
          taskId: target?.taskId ?? null,
          OR: [
            { status: RunStatus.AWAITING_INPUT, cancelRequestedAt: null },
            { status: RunStatus.FAILED },
          ],
        },
        data: { retryAt: at },
      });
    }, loggedRetry(this.logger, 'sessions.armAutoRetry'));
    if (!armed.count) throw new BadRequestException('session is not waiting on a retry');
    return { retryAt: at };
  }

  /**
   * Resolve a public share token to its sanitized, read-only transcript. NO ownerId — the
   * unguessable token IS the capability. Returns only what a viewer needs to render the
   * conversation (title, workspace name, status, the event stream); never ownership, billing,
   * runner internals, or worktree/merge state. A trashed (deletedAt) session stops resolving.
   */
  async getShared(token: string) {
    const session = await this.prisma.session.findFirst({
      where: { shareToken: token, deletedAt: null },
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
    if (!session) throw new NotFoundException('shared session not found');
    const stateful = withSessionState(session);
    const events = await this.prisma.runEvent.findMany({
      where: { sessionId: session.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, type: true, payload: true, turnId: true, createdAt: true },
    });
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
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        turnId: e.turnId ?? null,
        ts: e.createdAt,
      })),
    };
  }

  /**
   * A page of a session's persisted events for tail-first lazy loading. `tail` returns the
   * newest N events (initial paint); `before`+`limit` return the N events immediately older
   * than a seq (scroll-up). Both share one newest-first query that takes one extra row to
   * report `hasMore`, then returns the page in chronological (seq asc) order.
   *
   * Two things shrink what a page costs on a slow link. The `system` progress pings no client
   * renders are filtered out in the query (notNoiseSql) — they're still stored, they just don't
   * ride the wire, and filtering in SQL rather than after it means `take` counts events the
   * reader can actually see. And `maxPayload` (opt-in, see truncate-payload) clips bulky tool
   * call/result bodies to a preview and marks those events `truncated`, so the client downloads
   * what the folded transcript shows and refetches the rest per card from getEventFull.
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
    const take = Math.min(Math.max(Math.trunc(opts.limit ?? opts.tail ?? 200), 1), 500);
    const before =
      typeof opts.before === 'number' && Number.isFinite(opts.before)
        ? Prisma.sql`AND seq < ${Math.trunc(opts.before)}`
        : Prisma.empty;
    // Raw because notNoiseSql needs a jsonb key-subtraction Prisma's filter language can't spell.
    // Index Scan Backward on (session_id, seq) still drives it — the filter just skips pings on
    // the way, and the scan stops as soon as `take + 1` renderable rows are in hand.
    const rows = await this.prisma.$queryRaw<
      { seq: number; type: string; payload: unknown; turnId: string | null; createdAt: Date }[]
    >`
      SELECT seq, type, payload, turn_id AS "turnId", created_at AS "createdAt"
      FROM run_event
      WHERE session_id = ${id}::uuid
        ${before}
        AND ${notNoiseSql}
      ORDER BY seq DESC
      LIMIT ${take + 1}
    `; // one extra row: its presence means older events remain
    const hasMore = rows.length > take;
    const page = (hasMore ? rows.slice(0, take) : rows).reverse(); // back to seq asc
    return {
      hasMore,
      events: page.map((e) => {
        const cut = opts.maxPayload
          ? truncatePayload(e.type, e.payload, opts.maxPayload)
          : { payload: e.payload, truncated: false };
        return {
          seq: e.seq,
          type: e.type,
          payload: cut.payload,
          turnId: e.turnId ?? null,
          ts: e.createdAt,
          ...(cut.truncated ? { truncated: true as const } : {}),
        };
      }),
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
   * Bash(run_in_background), with output recovered from the workspace's persisted Read polls of the
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

  async getLegacyArtifactForShared(
    token: string,
    rawPath: string | undefined,
  ): Promise<{ data: Buffer; mimeType: string; disposition: string }> {
    const session = await this.prisma.session.findFirst({
      where: { shareToken: token, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('artifact not found');
    return this.getLegacyArtifact(session.id, rawPath);
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
    if (!localFile) return this.requestAndWaitForLegacyArtifact(sessionId, resolved.original, filename);

    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(localFile);
    } catch {
      return this.requestAndWaitForLegacyArtifact(sessionId, resolved.original, filename);
    }
    if (!st.isFile() || st.size <= 0 || st.size > MAX_UPLOAD_BYTES) {
      return this.requestAndWaitForLegacyArtifact(sessionId, resolved.original, filename);
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
    const original = (rawPath ?? '').trim();
    if (!original) throw new NotFoundException('artifact not found');
    let decoded = original;
    try {
      decoded = decodeURIComponent(original);
    } catch {
      // Keep the raw value; the path checks below reject malformed or unsafe values.
    }
    if (!path.isAbsolute(decoded) || decoded.split(/[\\/]+/).includes('..')) {
      throw new NotFoundException('artifact not found');
    }
    const normalized = path.normalize(decoded);
    const parts = normalized.split(path.sep).filter(Boolean);
    const marker = parts.findIndex(
      (part, i) => part === '.orbit' && parts[i + 1] === 'uploads' && parts[i + 2] === sessionId,
    );
    if (marker < 0 || parts.length <= marker + 3) {
      throw new NotFoundException('artifact not found');
    }
    const root = path.join(path.sep, ...parts.slice(0, marker + 3));
    return { original: decoded, file: normalized, root };
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
   */
  private async ensurePromptSeeded(
    tx: Prisma.TransactionClient,
    session: { id: string; prompt: string },
  ) {
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
      where: { sessionId: session.id, turnId: null },
      data: { turnId: turn.id },
    });
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
  private async engineTurnInFlight(tx: Prisma.TransactionClient, sessionId: string) {
    const running = await tx.conversationTurn.count({
      where: {
        sessionId,
        kind: 'message',
        status: 'IN_FLIGHT',
        leaseDeadlineAt: { gt: new Date() },
      },
    });
    return running > 0;
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
   * and the inbox re-asks the poller itself before handing anything over, so a steer filed
   * on a stale yes is withheld there and becomes an ordinary message when the turn ends.
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
    return supportsMidTurnSteer(await sessionExecRuntime(tx, session), runner?.capabilities);
  }

  private async insertTurnLocked(
    tx: Prisma.TransactionClient,
    sessionId: string,
    data: { kind: string; content?: string; clientTurnId: string },
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
    data: { kind: string; content?: string; clientTurnId: string },
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
   * Verify the given attachment ids are the caller's, scoped to this session, and not yet
   * tied to a turn. Returns the de-duped ids. Throws on any unknown/foreign/already-used id
   * so a bad reference is rejected BEFORE a turn is queued (no orphan text turn, no silent
   * drop of an image the user meant to send). Call before inserting the turn; link after.
   */
  private async assertLinkableAttachments(
    ownerId: string,
    sessionId: string,
    attachmentIds: string[] | undefined,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string[]> {
    const ids = [...new Set(attachmentIds ?? [])];
    if (ids.length === 0) return [];
    const found = await tx.attachment.findMany({
      where: { id: { in: ids }, ownerId, sessionId, turnId: null },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('one or more attachments are unknown, not yours, or already attached');
    }
    return ids;
  }

  /**
   * Verify the given attachment ids are the caller's and still unscoped (no session, no
   * turn) — i.e. fresh uploads made on the compose page before any session existed. Returns
   * the de-duped ids. Throws on any unknown/foreign/already-scoped id so a bad reference is
   * rejected BEFORE the session is created. Used by create() for the seeded first turn.
   */
  private async assertScopableAttachments(
    ownerId: string,
    attachmentIds: string[] | undefined,
  ): Promise<string[]> {
    const ids = [...new Set(attachmentIds ?? [])];
    if (ids.length === 0) return [];
    const found = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, ownerId, sessionId: null, turnId: null },
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
    },
  ) {
    assertPromptSize(dto.content, 'message');
    await this.getSendable(ownerId, id); // fast ownership/lifecycle validation
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
      // §13.6 SU6: a turn that carries the TASK's prompt is the task's work, whatever this row was
      // opened for. Written in the same transaction as the turn — so 0130's guard judges the value
      // this turn actually starts under, and a session first opened to look at a task cannot keep
      // the salvage exemption while executing it.
      if (opts?.startsTaskWork) {
        await tx.session.update({ where: { id }, data: { startsTaskWork: true } });
      }
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      if (session.deletedAt) {
        throw new SessionNotSendable('the session is in Trash; restore it before sending a message');
      }
      if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
        throw new SessionNotSendable('the session has ended');
      }
      const existing = await tx.conversationTurn.findUnique({
        where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto.clientTurnId } },
      });
      if (existing) {
        return {
          turn: existing,
          placement: await this.turnPlacement(tx, id, existing),
          wakeQueue: session.status === RunStatus.PENDING,
          wakeInbox: session.status === RunStatus.RUNNING,
        };
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
      const attachmentIds = await this.assertLinkableAttachments(ownerId, id, dto.attachmentIds, tx);
      // A claim can race the lazy first-turn seed. While holding the same Session lock as
      // queue.buildSession, ensure an unestablished runtime cannot lose its opening prompt.
      if (session.numTurns === 0) await this.ensurePromptSeeded(tx, session);
      // A message sent while a turn is already running is a steer: it is written into that
      // running turn rather than queued behind its result (see ConversationTurnKind). The
      // kind is decided here, under the same Session row lock the inbox dequeues under, so
      // the decision cannot race the turn it is about — and it is decided by the server so
      // every entry point behaves the same without any of them knowing about steering.
      //
      // Only a message steers. A `!cmd` shell turn runs on the runner, not in the engine,
      // so there is nothing to fold it into and it keeps queuing exactly as before — and
      // neither does a message on an engine that cannot be written to mid-turn, or one whose
      // runner has not said it can deliver that engine's steer (see runtimeTakesSteer).
      const kind =
        dto.kind === 'shell'
          ? 'shell'
          : (await this.engineTurnInFlight(tx, id)) && (await this.runtimeTakesSteer(tx, session))
            ? 'steer'
            : 'message';
      // This is the authoritative queue placement: it is read before this row exists and while
      // the Session lock prevents dequeue/complete from changing its predecessors underneath it.
      // A steer takes precedence because it joins the running turn instead of waiting behind it.
      const placement = await this.turnPlacement(tx, id, { kind, status: 'PENDING' });
      const turn = await this.insertTurnLocked(tx, id, {
        // Whitelist: this endpoint cannot manufacture control turns.
        kind,
        content: dto.content,
        clientTurnId: dto.clientTurnId,
      });
      await this.linkAttachments(turn.id, attachmentIds, tx);
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
          retryAt: null,
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
              }
            : {}),
        },
      });
      return {
        turn,
        placement,
        wakeQueue: nextStatus === RunStatus.PENDING,
        wakeInbox: nextStatus === RunStatus.RUNNING,
      };
    }, loggedRetry(this.logger, 'sessions.createTurn'));
    if (queued.wakeQueue) this.queue.notifySessionQueued();
    if (queued.wakeInbox) this.realtime.notifyInbox(id);
    // No transcript event exists until the runner leases this turn. Tell every focused client to
    // refresh the durable queue now, so a message queued on web appears on iOS (and vice versa).
    this.realtime.publishQueuedTurnsChanged(id);
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
  async interrupt(ownerId: string, id: string, dto?: SessionInterruptDto) {
    const content = dto?.content ?? '';
    const followUp = content.trim().length > 0 || (dto?.attachmentIds?.length ?? 0) > 0;
    if (followUp) {
      assertPromptSize(content, 'message');
      if (!dto?.clientTurnId) {
        throw new BadRequestException('clientTurnId is required when interrupting with a follow-up');
      }
    }
    await this.getLive(ownerId, id);
    // Retried whole: the interrupt is decided from the Session row re-read under its lock.
    const queued = await withTransactionRetry(this.prisma, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      if (!SessionsService.LIVE.includes(session.status) || session.cancelRequestedAt) {
        throw new ConflictException('the session has ended');
      }
      // The same bar createTurn holds a message to. Stopping a trashed session's work is
      // still allowed — it is running, and stopping is the whole point — but nothing new
      // may be queued onto it behind that.
      if (followUp && session.deletedAt) {
        throw new ConflictException('the session is in Trash; restore it before sending a message');
      }
      // Keyed on the interrupt rather than on the message, because only the interrupt is
      // certainly still there: a later interrupt may have dropped the follow-up, and a
      // retry must not then re-file it. A control turn is never deleted, so its presence
      // is the durable record that this request already ran.
      const interruptClientTurnId = followUp
        ? SessionsService.interruptClientId(dto!.clientTurnId!)
        : randomUUID();
      if (followUp) {
        const already = await tx.conversationTurn.findUnique({
          where: {
            sessionId_clientTurnId: { sessionId: id, clientTurnId: interruptClientTurnId },
          },
          select: { id: true },
        });
        if (already) {
          // A retry: everything below already happened. Re-running it would delete the
          // follow-up this request queued and file a second interrupt behind it.
          const turn = await tx.conversationTurn.findUnique({
            where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto!.clientTurnId! } },
            select: { id: true, seq: true },
          });
          return { turn, wakeQueue: false };
        }
      }
      // Checked before anything is dropped, so a request that cannot be honoured leaves
      // the queue exactly as it found it.
      const attachmentIds = followUp
        ? await this.assertLinkableAttachments(ownerId, id, dto?.attachmentIds, tx)
        : [];
      // Drop queued-but-undelivered follow-ups: interrupting means "stop", so they
      // should not fire after the current turn is aborted. Queued `!cmd` shell turns go
      // too — they sit in the same "waiting behind the running turn" queue (as the
      // executable count below already assumes), and leaving them behind ran a command
      // the user had just told to stop. A queued steer goes for the same reason and one
      // more: it would be written into the very turn being stopped.
      await tx.conversationTurn.deleteMany({
        where: { sessionId: id, kind: { in: ['message', 'shell', 'steer'] }, status: 'PENDING' },
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
      });
      if (!followUp) return { turn: null, wakeQueue: false };
      // A claim can race the lazy first-turn seed, exactly as in createTurn: under this
      // same lock, make sure an unestablished runtime cannot lose its opening prompt.
      if (session.numTurns === 0) await this.ensurePromptSeeded(tx, session);
      const turn = await this.insertTurnLocked(tx, id, {
        kind: 'message',
        content,
        clientTurnId: dto!.clientTurnId!,
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
          // second, unasked-for turn behind the one they just redirected to.
          retryAt: null,
        },
      });
      return { turn, wakeQueue: nextStatus === RunStatus.PENDING };
    }, loggedRetry(this.logger, 'sessions.interrupt'));
    // The inbox is woken unconditionally: the interrupt turn is what it is waiting for, and
    // it is deliverable the moment this commits, whatever the follow-up's status implies.
    if (queued.wakeQueue) this.queue.notifySessionQueued();
    this.realtime.notifyInbox(id);
    this.realtime.publishQueuedTurnsChanged(id);
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
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const turns = await this.prisma.conversationTurn.findMany({
      // One snapshot, including rows that are needed only to identify the executable head.
      where: {
        sessionId: id,
        kind: { in: ['message', 'shell', 'steer'] },
        status: { in: ['PENDING', 'IN_FLIGHT'] },
      },
      orderBy: { seq: 'asc' },
      // Carry each queued turn's image refs so the composer can still render them after a
      // reload (the local object-URL previews are gone by then) — e.g. an image-only turn.
      select: {
        id: true,
        seq: true,
        clientTurnId: true,
        kind: true,
        status: true,
        content: true,
        createdAt: true,
        attachments: { select: { id: true, mimeType: true } },
      },
    });
    const headExecutableId = turns.find((t) => t.kind === 'message' || t.kind === 'shell')?.id;
    const initialClientTurnId = SessionsService.initialTurnClientId(id);
    const classified = turns
      .filter((turn) => turn.clientTurnId !== initialClientTurnId)
      .map((turn) => ({
        turn,
        placement: (turn.kind === 'steer'
          ? 'steer'
          : turn.id === headExecutableId
            ? 'accepted'
            : 'queued') as TurnPlacement,
      }));
    if (view !== 'active') {
      return classified
        .filter(({ turn, placement }) => turn.status === 'PENDING' && placement !== 'accepted')
        .map(({ turn }) => ({
          turnId: turn.id,
          kind: turn.kind,
          content: turn.content ?? '',
          attachments: turn.attachments.map((attachment) => ({
            id: attachment.id,
            mimeType: attachment.mimeType,
          })),
        }));
    }
    // `run_event` is append-only, so probing after the active-turn snapshot is monotone in the safe
    // direction: an event that committed meanwhile suppresses a fallback that is no longer needed;
    // one that commits after this query is the live event that replaces the short-lived fallback.
    // Do this only after placement is computed over ALL active turns. Filtering the announced head
    // first would promote its genuinely queued successor to `accepted`.
    const announced = turns.length === 0
      ? []
      : await this.prisma.runEvent.findMany({
          where: {
            sessionId: id,
            type: RunEventType.USER,
            turnId: { in: turns.map((turn) => turn.id) },
          },
          select: { turnId: true },
        });
    const announcedTurnIds = new Set(
      announced.flatMap((event) => (event.turnId ? [event.turnId] : [])),
    );
    return classified
      .filter(({ turn }) => !announcedTurnIds.has(turn.id))
      .map(({ turn, placement }) => ({
        turnId: turn.id,
        kind: turn.kind,
        placement,
        content: turn.content ?? '',
        createdAt: turn.createdAt.toISOString(),
        attachments: turn.attachments.map((attachment) => ({
          id: attachment.id,
          mimeType: attachment.mimeType,
        })),
      }));
  }

  /** Withdraw a queued user message or `!cmd` shell turn. Only a still-PENDING one can be
   *  cancelled; once the runner has leased it (IN_FLIGHT) it's already feeding claude / already
   *  running, and will appear in the transcript, so cancelling is rejected. */
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
   * `assignedRunnerId` still points at the machine whose local repo holds it. The runner
   * picks the request up on its next heartbeat (≤30s), merges its branch's committed state
   * into main (the live checkout, if any, is a separate worktree and is undisturbed), and
   * reports the outcome back into `mergeStatus`/`mergeError`/`mergedAt`. Idempotent while a
   * merge is already pending; re-requesting a merged/conflicted session re-queues it.
   *
   * `targetBranch` is the branch to merge INTO, picked from the status bar's dropdown; it's
   * stored on `mergeTarget` and relayed to the runner. Omitted/empty → the default (the runner
   * auto-detects main, else master). A target equal to the session's own branch is rejected.
   *
   * An explicit target is also remembered on the session's workspace (`defaultMergeTarget`), so
   * switching the target sticks across all of that workspace's sessions — the next merge button
   * defaults to it. Cleared back to the auto-detect default is not offered here (picking main
   * from the dropdown re-records main).
   */
  async mergeToMain(ownerId: string, id: string, targetBranch?: string) {
    const target = targetBranch?.trim() || null;
    // Retried whole. The worktree-operation claim is taken under the Session row lock inside the
    // closure, so a re-run competes for it from the state that exists. The runner is only told
    // about the operation after this returns.
    const workspaceId = await withTransactionRetry(this.prisma, async (tx) => {
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
      if (session.mergeStatus === 'pending') return null;

      if (session.commitStatus === 'pending') {
        throw new ConflictException('wait for the pending worktree commit to finish');
      }
      if (
        !SessionsService.TERMINAL.includes(session.status) &&
        (session.status !== RunStatus.AWAITING_INPUT || !!session.cancelRequestedAt)
      ) {
        throw new ConflictException('wait for the current turn to finish before merging');
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
      if (gate.decision === 'ALREADY_LANDED') return { alreadyLanded: gate };
      if (gate.decision !== 'ALLOWED') {
        throw new ConflictException(`${gate.decision}: ${gate.detail}`);
      }

      await tx.session.update({
        where: { id },
        data: {
          mergeStatus: 'pending',
          mergeTarget: target,
          mergeRequestedAt: new Date(),
          mergeOperationId: randomUUID(),
          // `[K6]` §7: which checkpoint THIS operation was authorised for, persisted with the
          // operation id it is part of. When the result comes back the server checks the reported
          // commit against this rather than against anything the runner sent — a gate that only
          // holds when the client cooperates is not a gate. Null for unmanaged work, which is
          // almost every merge, and which is then unaffected by all of this.
          mergeCheckpointId: gate.checkpointId,
          mergeOperationOwner: null,
          mergeError: null,
          mergedAt: null,
          mergedSourceSha: null,
          branchMerged: null,
        },
      });
      return session.workspaceId;
    }, loggedRetry(this.logger, 'sessions.mergeToMain'));
    if (workspaceId && typeof workspaceId === 'object' && 'alreadyLanded' in workspaceId) {
      // Nothing was queued and nothing will be executed: the receipt that already says this landed
      // IS the answer. Handing it back rather than re-running the merge is the whole of CP4's
      // "重复投递的同一回执只生效一次" at the request end of the wire.
      const landed = workspaceId.alreadyLanded;
      const receipt = await this.prisma.sessionMergeReceipt.findFirst({
        where: { id: landed.receiptId, ownerId },
      });
      return {
        ok: true as const,
        alreadyMerged: true as const,
        sourceSha: landed.sourceSha,
        targetSha: landed.targetSha,
        receipt: receipt ? mergeReceiptRow(receipt as unknown as MergeReceiptRow) : null,
      };
    }
    // Remember an explicitly chosen target on the workspace so every session of it defaults there.
    if (target && workspaceId) {
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { defaultMergeTarget: target },
      });
    }
    return { ok: true };
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
   * The runner picks the request up on its next heartbeat (≤30s), commits, and reports the
   * outcome back into `commitStatus`/`commitError` (clearing `worktreeDirty` on success, so the
   * bar flips to Merge). Idempotent while a commit is already pending. A finished session
   * already committed its work at completion, so it has nothing to commit here.
   */
  async commitWorktree(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (session.isolationStatus !== 'worktree' || !session.branch) {
      throw new BadRequestException('session has no worktree to commit');
    }
    if (!SessionsService.LIVE.includes(session.status) || session.cancelRequestedAt) {
      throw new ConflictException('the session has ended — its work is already committed');
    }
    if (session.status !== RunStatus.AWAITING_INPUT) {
      throw new ConflictException('wait for the current turn to finish before committing');
    }
    if (session.runningSubagents.length > 0) {
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
    const queued = await this.prisma.session.updateMany({
      where: {
        id,
        ownerId,
        status: RunStatus.AWAITING_INPUT,
        cancelRequestedAt: null,
        runningSubagents: { isEmpty: true },
        commitStatus: session.commitStatus,
        mergeStatus: session.mergeStatus,
      },
      data: {
        commitStatus: 'pending',
        commitRequestedAt: new Date(),
        commitOperationId: randomUUID(),
        commitOperationOwner: null,
        commitError: null,
      },
    });
    if (queued.count === 0) {
      // A concurrent identical request may have won the compare-and-set. Keep the endpoint
      // idempotent in that case; every other transition means the checkout is no longer safe.
      const current = await this.prisma.session.findFirst({ where: { id, ownerId } });
      if (
        current?.commitStatus === 'pending' &&
        current.status === RunStatus.AWAITING_INPUT &&
        !current.cancelRequestedAt &&
        current.runningSubagents.length === 0
      ) {
        return { ok: true };
      }
      if (current?.mergeStatus === 'pending') {
        throw new ConflictException('wait for the pending branch merge to finish');
      }
      throw new ConflictException(
        'the session is no longer idle — wait for its current work to finish',
      );
    }
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
        // Drop queued messages so they cannot replay if the session is later revived.
        await tx.conversationTurn.deleteMany({
          where: { sessionId, kind: 'message', status: 'PENDING' },
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
    ended: { changed: boolean; runnerId: string | null },
  ): void {
    if (!ended.changed) return;
    // PENDING sessions settle synchronously to CANCELLED and will never receive runner STATUS.
    // The full summary carries taskId, letting task lists clear queued immediately. Live-session
    // end intents also publish safely here; their later finalize event remains authoritative.
    this.realtime.publishSessionUpdated(sessionId);
    if (ended.runnerId) this.realtime.requestCancel(ended.runnerId, sessionId);
    this.realtime.notifyInbox(sessionId);
  }

  /** Pending (or all) tool-permission approvals for a session the caller owns. */
  async listApprovals(ownerId: string, id: string, status?: string): Promise<ApprovalInfo[]> {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!session) throw new NotFoundException('session not found');
    const approvals = await this.prisma.approval.findMany({
      where: { sessionId: id, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    return approvals.map((a) => this.toApprovalInfo(a));
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
    'this task is completed by aggregating its subtasks, so it has no work of its own to run — '
    + 'run its subtasks, or set its completion policy to MANUAL';

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
      completionPolicy: string; hasDirectChildren: boolean;
    }>>(Prisma.sql`
      SELECT t."terminal_reason" AS "terminalReason",
             t."superseded_by_task_id" AS "supersededByTaskId",
             subject."terminal_reason" AS "subjectTerminalReason",
             subject."superseded_by_task_id" AS "subjectSupersededByTaskId",
             t."completion_policy"::text AS "completionPolicy",
             EXISTS (SELECT 1 FROM "task" c
                      WHERE c."parent_task_id" = t."id" AND c."owner_id" = t."owner_id")
               AS "hasDirectChildren"
        FROM "task" t
        LEFT JOIN "task" subject ON subject."id" = t."verifies_task_id"
       WHERE t."id" = ${taskId}::uuid
       ${locked ? Prisma.sql`FOR SHARE OF t` : Prisma.empty}
    `);
    if (!facts) return null;
    if (startsTaskWork && isAggregateParent({
      completionPolicy: facts.completionPolicy as TaskCompletionPolicyValue,
      hasDirectChildren: facts.hasDirectChildren,
    })) {
      return SessionsService.AGGREGATE_PARENT_REFUSAL;
    }
    return taskWorkRefusal(facts, uuidToBase62);
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
    },
  ) {
    assertPromptSize(dto.content, 'message');
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
      return this.createTurn(ownerId, id, dto, {
        clearSettledWorktreeState: true,
        // Carried through: a live paused run being handed the task's prompt is the task's work,
        // and the row has to say so in the same transaction that writes the turn.
        startsTaskWork: opts?.startsTaskWork,
        // ...and so does the right to deliver it. This is the path a task resume actually takes —
        // `AWAITING_INPUT` and `INTERRUPTED` are both LIVE — so a fence applied only to the revive
        // below would be a fence on the branch nobody uses.
        fence: opts?.fence,
      });
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
          assignedRunner: { select: { id: true, status: true, lastHeartbeatAt: true } },
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
      });
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
        dto.attachmentIds,
        tx,
      );
      // Self-heal terminal rows produced before generation retirement was deployed
      // (or by an older replica during a rolling upgrade). Otherwise a same-process
      // takeover returns early and the fresh engine cannot replace that active marker.
      await retireSessionInboxGeneration(tx, id);
      const turn = await this.insertTurnLocked(tx, id, {
        kind: dto.kind === 'shell' ? 'shell' : 'message',
        content: dto.content,
        clientTurnId: dto.clientTurnId,
      });
      await this.linkAttachments(turn.id, attachmentIds, tx);
      // A revive may also move the session to another provider on the same runtime. Unlike a live
      // switch there is no process to reload: the row goes PENDING and the claim below resolves
      // the environment from it, which is also why a model the new provider doesn't serve is
      // simply cleared — claim re-resolves an unset model against the provider it is claiming for.
      const next = await this.resolveProviderSwitch(tx, current, dto.provider);
      const normalizedEffort =
        dto.effort !== undefined
          ? normalizeEffortForProvider(
              normalizeRuntimeProvider(next.provider, next.providerBuiltin),
              dto.effort,
            )
          : undefined;
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
          // A resumable Completed session moves back to Open. Trash was rejected above.
          completedAt: null,
          archivedAt: null,
          // As in createTurn: a new message — the user's or the sweeper's own — disarms the
          // auto-retry. This is the route the sweeper itself takes for a terminal session.
          retryAt: null,
          ...(dto.model !== undefined
            ? { model: dto.model }
            : next.keepsModel
              ? {}
              : { model: null }),
          ...(dto.permissionMode !== undefined ? { permissionMode: dto.permissionMode } : {}),
          ...(dto.effort !== undefined ? { effort: normalizedEffort } : {}),
          ...(next.changed
            ? { provider: next.provider, providerBuiltin: next.providerBuiltin }
            : {}),
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
    }, loggedRetry(this.logger, 'sessions.resume'));
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
    };
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
          where: { slug: declared, OR: [{ ownerId: null }, { ownerId: session.ownerId }] },
        });
    if (requested === undefined || requested === declared) {
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
    const providerBuiltin = Object.values(AgentProvider).includes(requested as AgentProvider);
    const targetRow = providerBuiltin
      ? null
      : await tx.modelProvider.findFirst({
          where: {
            slug: requested,
            enabled: true,
            OR: [{ ownerId: null }, { ownerId: session.ownerId }],
          },
        });
    if (!providerBuiltin && !targetRow) {
      throw new BadRequestException('provider not available');
    }
    const from = execRuntime({
      declaredProvider: declared,
      declaredProviderBuiltin: session.providerBuiltin,
      customRow: currentRow,
    });
    const to = execRuntime({
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
   * Change the model / permission mode / effort / provider of an already-started session.
   *
   * The new values are persisted and a control turn is queued for the live runtime, and which
   * turn that is depends on what moved. The provider is spawn-only: the process was built with
   * its environment, so a `reload` — tear down, re-spawn with --resume and the new flags, full
   * context kept — is the only way to change it, and the inbox holds that turn until no message
   * is in flight so it cannot abort a running turn. Model, permission mode and effort are not
   * spawn-only: a resident engine can be told about all three, so they travel as `setconfig`,
   * which the inbox hands over mid-turn. A PATCH that moves both halves queues both, setconfig
   * first.
   *
   * Telling one requires a runtime with a control protocol to hear it, which is claude alone;
   * for the ACP and one-shot runtimes the whole config rides the reload, exactly as it always
   * did — see `acceptsLiveConfig` below.
   *
   * A not-yet-claimed (PENDING) session needs neither: the claim reads the new values.
   */
  async updateConfig(ownerId: string, id: string, dto: SessionConfigDto) {
    if (
      dto.model === undefined &&
      dto.permissionMode === undefined &&
      dto.effort === undefined &&
      dto.provider === undefined
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
            select: { runtimeDefaultModels: true, modelCatalog: true, runsAsRoot: true },
          },
          // The account-level permission default, which replaced the per-workspace one.
          owner: { select: { preferences: true } },
        },
      });
      if (SessionsService.TERMINAL.includes(session.status)) {
        throw new ConflictException('the session has ended');
      }
      const next = await this.resolveProviderSwitch(tx, session, dto.provider);
      const exec = resolveProviderExec({
        declaredProvider: next.provider,
        declaredProviderBuiltin: next.providerBuiltin,
        customRow: next.customRow,
        sessionModel: dto.model ?? (next.keepsModel ? session.model : null),
        usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
        runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
        workspaceModel: session.workspace?.model,
        modelCatalog: session.assignedRunner?.modelCatalog,
        workspaceEnv: session.workspace?.env as Record<string, string> | null,
      });
      const requestedPermissionMode =
        (dto.permissionMode as PermissionMode | undefined) ??
        resolvePermissionMode(session.permissionMode, session.owner);
      const normalizedPermissionMode = normalizeBuiltinPermissionMode(
        exec.provider,
        exec.model,
        requestedPermissionMode,
        next.customRow?.enabled === true,
        session.assignedRunner?.runsAsRoot,
      );
      const normalizedEffort =
        dto.effort !== undefined
          ? normalizeEffortForProvider(exec.provider, dto.effort)
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
          ...(next.changed
            ? { provider: next.provider, providerBuiltin: next.providerBuiltin }
            : {}),
        },
      });

      if (session.status === RunStatus.PENDING) return false;
      // A claim marks the row RUNNING before buildSession lazily seeds the opening prompt. A
      // config PATCH in that small window must seed it first; otherwise the control turn would
      // become the first turn and the claim path could mistake it for the opening message.
      if (session.numTurns === 0) await this.ensurePromptSeeded(tx, session);
      // Whether there is anything to say the new config TO. `setconfig` is a stream-json
      // control_request, and claude is the only runtime spoken to that way: codex and kimi are
      // driven over ACP/JSON-RPC, opencode runs one process per turn, and none of their session
      // loops has an arm for the kind — one filed there is acked on delivery and applied by
      // nobody, which is worse than the wait this split removed. For them the live half stays
      // what it always was: part of the re-spawn, effort included (web `appliesMidTurn` promises
      // the same).
      //
      // Asked of the RUNTIME, the way deliverSteer asks its own question, and read off
      // `resolveProviderExec` — whose `provider` IS that runtime (`execRuntime`), resolved after
      // the switch above. A configured (BYOK) slug is its owner's word and says nothing about
      // the CLI underneath; judged by the slug, the borrowers of the claude runtime would be the
      // ones losing the frame.
      const acceptsLiveConfig = exec.provider === AgentProvider.CLAUDE;
      const effortMoved = dto.effort !== undefined && normalizedEffort !== session.effort;
      // Which half of the config actually moved decides what is queued. The provider is
      // spawn-only — a process's environment is decided when it is built, so the only way to
      // change it is to build another one, and that is what `reload` is. Model, permission mode
      // and effort are not: a resident engine can be told about each, so they go out as
      // `setconfig`, which the inbox hands over mid-turn instead of holding until the running
      // turn ends. Effort joined them on measured behaviour, not on principle — an
      // apply_flag_settings frame moves the effort of the API calls the RUNNING turn goes on to
      // make (runner-go/claude_setconfig.go), which is the whole reason it stopped being worth a
      // re-spawn.
      const respawns = !acceptsLiveConfig || next.changed;
      // …and the control frame goes whenever the live half moved. A PATCH that moved nothing at
      // all still sends one rather than falling silent: re-stating the committed pair is what
      // this kind costs, and it is cheaper than the reload that used to be sent here.
      const setsLiveConfig =
        acceptsLiveConfig &&
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
            // reads an absent effort as "say nothing about effort".
            effort: dto.effort !== undefined ? normalizedEffort : undefined,
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
            effort: normalizedEffort,
            // The identity only. It tells the runner its process environment is stale — the
            // credential behind it is resolved when the inbox delivers this turn, so a decrypted
            // provider key never lands in conversation_turn.
            provider: next.changed ? next.provider : undefined,
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
