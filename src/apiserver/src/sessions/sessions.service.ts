import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
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
  RunEventType,
  SessionEndReason,
  SessionFilingState,
  SessionLifecycleState,
  type SessionResumeBlockedReason,
  SessionRunState,
  SessionState,
  type SessionSearchHit,
} from '@orbit/shared';
import { agentProviderSeed } from '../workspaces/workspace-provider';
import { PrismaService } from '../prisma/prisma.service';
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
import { RealtimeService } from '../realtime/realtime.service';
import { MAX_UPLOAD_BYTES } from '../attachments/attachments.media';
import { CreateSessionDto, SessionConfigDto, SessionResumeDto, SessionTurnDto } from './dto';
import { enqueueBeautifyTitle, makeBranchName, titleFromPrompt } from './naming';
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
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForProvider,
  normalizeRuntimeProvider,
} from '../common/runtime-provider';
import { execRuntime, isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { ownsModel } from '../providers/preset-overlay';
import {
  newTerminalResumeHandoffOwner,
  pendingWorktreeOperationMayBeExecuting,
  retireSessionInboxGeneration,
} from '../common/session-inbox-fence';
import { truncatePayload } from './truncate-payload';
import { signedOutEngineRefusal } from './engine-signin-preflight';
import {
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

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

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
    } else if (dto.workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: dto.workspaceId, ownerId, deletedAt: null },
        select: { enableWorktree: true, enabled: true, env: true },
      });
      if (!workspace) throw new ForbiddenException('workspace not found');
      if (workspace.enabled === false) throw new ForbiddenException('workspace is disabled');
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
    const branch = enableWorktree ? makeBranchName(title) : null;
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
    if (refusal) throw new ConflictException(refusal);
    const runtimeSessionId = randomUUID();
    const session = await this.prisma.session.create({
      data: {
        title,
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
        permissionMode: dto.permissionMode ?? accountPermissionMode,
        effort: normalizeEffortForProvider(runtime, dto.effort),
        workspaceId: dto.workspaceId,
        assignedRunnerId,
        taskId: dto.taskId,
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
    });
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
      this.realtime.publishWorkspaceChanged(session.id, session.workspaceId);
    }
    // Only unnamed sessions need cosmetic naming. Task runs and user-supplied titles never call
    // DeepSeek. The branch is deliberately left as-is when the display title is later improved.
    if (!hasExplicitTitle) void this.beautifyTitleLater(session.id, dto.prompt, title);
    return withSessionState(session);
  }

  /**
   * Background naming for a session that started with a prompt-derived title. The shared bounded
   * queue prevents a create burst from fan-out calling DeepSeek. Swap the title only while it is
   * still the exact fallback we wrote, so a user rename (or any concurrent change) is never
   * clobbered. Re-publishes the session so live clients pick up the new title. Fire-and-forget:
   * never awaited, swallows all errors.
   */
  private async beautifyTitleLater(sessionId: string, prompt: string, fallbackTitle: string): Promise<void> {
    try {
      const title = await enqueueBeautifyTitle({ prompt });
      if (!title || title === fallbackTitle) return;
      const res = await this.prisma.session.updateMany({
        where: { id: sessionId, title: fallbackTitle },
        data: { title },
      });
      if (res.count > 0) this.realtime.publishSessionUpdated(sessionId);
    } catch {
      // best-effort; the raw fallback title simply stays
    }
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
    // effort, else the owner's account default). create() normalizes it per provider (codex maps
    // max→xhigh). Without this the child's effort is empty, so a codex child falls back to the
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
   * Per-workspace tallies over the Open list: how many of a workspace's sessions are mid-turn, and how
   * many are blocked on an approval. The nav sidebar shows one number per workspace and used to
   * derive them by fetching every open session — the heaviest poll in the app once an account
   * has thousands. Same definitions as the list payload, including that only a RUNNING session
   * can hold a live approval (see `list`). Sessions with no workspace belong to no row and are
   * skipped, exactly as the sidebar skipped them.
   */
  async workspaceSessionCounts(ownerId: string) {
    const open = {
      ownerId,
      completedAt: null,
      archivedAt: null,
      deletedAt: null,
      workspaceId: { not: null },
    } as const;
    const [active, blocked] = await Promise.all([
      this.prisma.session.groupBy({
        by: ['workspaceId'],
        where: { ...open, status: { in: [RunStatus.RUNNING, RunStatus.PENDING] } },
        _count: { _all: true },
      }),
      // Only the blocked rows come back (a handful at most), so this stays a lookup, not a scan
      // of the whole list. `active` above counts runner slots, so it stays on RUNNING/PENDING;
      // this one counts prompts a human has to answer, which a self-driven turn raises just as
      // well — and those sit at AWAITING_INPUT for the whole turn.
      this.prisma.session.findMany({
        where: { ...open, ...GENERATING_SESSION_FILTER, approvals: { some: { status: 'PENDING' } } },
        select: { workspaceId: true },
      }),
    ]);
    const counts = new Map<string, { workspaceId: string; active: number; needsYou: number }>();
    const row = (workspaceId: string) => {
      const existing = counts.get(workspaceId);
      if (existing) return existing;
      const fresh = { workspaceId, active: 0, needsYou: 0 };
      counts.set(workspaceId, fresh);
      return fresh;
    };
    for (const group of active) {
      if (group.workspaceId) row(group.workspaceId).active = group._count._all;
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
        q.reason  AS "queuedReason",
        q.active  AS "queuedActive",
        q."limit" AS "queuedLimit"
      FROM session s
      LEFT JOIN workspace a  ON a.id = s.workspace_id
      LEFT JOIN runner r ON r.id = s.assigned_runner_id
      LEFT JOIN task t   ON t.id = s.task_id
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
              WHEN ${runnerActiveTurns(Prisma.sql`s.assigned_runner_id`)} >= r.max_concurrent
                THEN 'runner_at_capacity'
              WHEN s.root_session_id IS NOT NULL
                   AND ${treeActiveTurns('s')} >= ${treeCeiling(Prisma.sql`s.assigned_runner_id`)}
                THEN 'tree_at_capacity'
              WHEN s.batch_id IS NOT NULL
                   AND ${batchActiveTurns('s')} >= s.batch_max_concurrent
                THEN 'batch_at_capacity'
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
      },
    });
    if (!session) throw new NotFoundException('session not found');
    // A Claude row with turns but no runtime session id has no conversation to resume (it
    // predates the column, or its id was minted by a different runtime), so the capabilities
    // payload says MISSING_CONTEXT and the UI blocks resume (it creates a new session
    // instead). Fix it eagerly on read so every consumer — detail page, list, realtime
    // stream — sees the session as resumable.
    if (session.provider === 'claude' && session.numTurns > 0 && !session.runtimeSessionId) {
      const sid = randomUUID();
      await this.prisma.session.update({
        where: { id },
        data: { runtimeSessionId: sid, numTurns: 0 },
      });
      session.runtimeSessionId = sid;
      session.numTurns = 0;
    }
    // Flatten the join to a picker-ordered `tags` array (system first), matching the list payload.
    const { tagLinks, ...rest } = session;
    const tags = tagLinks
      .map((l) => l.tag)
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.position - b.position);
    return withSessionCapabilities({ ...rest, tags });
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
    const armed = await this.prisma.session.updateMany({
      where: {
        id,
        ownerId,
        deletedAt: null,
        completedAt: null,
        OR: [
          { status: RunStatus.AWAITING_INPUT, cancelRequestedAt: null },
          { status: RunStatus.FAILED },
        ],
      },
      data: { retryAt: at },
    });
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
   * events leaves only renderable rows — 258 of 27k in the largest session here, p99 789 — so
   * the ILIKE runs over a few hundred payloads. Measured 26ms warm / 98ms cold on that largest
   * session. That's also why CONTENT_MIN_CHARS doesn't apply: the global palette's floor exists
   * because a sub-trigram pattern makes pg_trgm recheck every indexed row in the *deployment*,
   * which a single session's few hundred rows can't reproduce.
   *
   * Matching is the same two-step the palette uses (see `broaden`): the phrase, and — only when
   * the session doesn't contain it — every word of it, so half-remembering a line still finds it.
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
    // The widest thing this query could match: every word of it, ANDed. Both rules are evaluated
    // in the one scan below — unlike the palette, which pays for a second query, because here the
    // scan IS the cost and a second one would double it on exactly the keystrokes that find
    // nothing yet.
    const widened = broaden(norm) ?? norm;
    const words = Prisma.join(
      widened.patterns.map(
        (term) =>
          Prisma.sql`(${Prisma.join(
            term.map((p) => Prisma.sql`text ILIKE ${p}`),
            ' OR ',
          )})`,
      ),
      ' AND ',
    );

    const rows = await this.prisma.$queryRaw<
      { seq: number; type: string; toolName: string | null; ts: Date; total: number; snippet: string | null }[]
    >(Prisma.sql`
      WITH body AS (
        SELECT
          seq, type, created_at, payload,
          -- Every string a transcript card can show, in one column so the match and the snippet
          -- can never disagree about where the hit is. The two JSON casts (a tool's input, and a
          -- tool_result whose content is an array of blocks rather than a plain string) search
          -- the JSON *encoding*, so a query containing a quote or a newline won't match inside
          -- them — acceptable for what people actually search for (a path, a name, a phrase).
          --
          -- Asterisks and backticks are dropped (stripMarks, which the ⌘K palette shares and
          -- stripEmphasis strips the query with) because what is stored is markdown source and
          -- what the user is searching for is what they read: "the merge button" has to find
          -- "the **merge** button", and 9.5k assistant events here carry bold. Underscore is
          -- deliberately kept — it is a character in half the identifiers anyone would search
          -- for, not decoration.
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
      ),
      -- MATERIALIZED so the phrase test below reads this once instead of re-running the whole
      -- concat-and-strip over the session a second time.
      matched AS MATERIALIZED (
        SELECT
          seq, type, created_at, payload, text,
          text ILIKE ${norm.pattern} AS exact,
          -- Same ±60 window as the ⌘K palette, and for the same reason: a match can sit deep
          -- inside a multi-KB body, so the cut has to happen in SQL. strpos is literal while
          -- ILIKE is not, which is why the pattern escapes % and _ (see search-query.ts).
          --
          -- The whole phrase first, so a row that has it verbatim shows it; strpos returns 0
          -- when it doesn't, and the window falls back to the query's longest word, which the
          -- WHERE guarantees is in there somewhere.
          substr(
            text,
            greatest(
              1,
              coalesce(
                nullif(strpos(lower(text), lower(${norm.raw})), 0),
                strpos(lower(text), lower(${widened.anchor}))
              ) - 60
            ),
            length(${norm.raw}) + 120
          ) AS snippet
        FROM body
        WHERE ${words}
      )
      SELECT
        seq,
        type,
        created_at AS "ts",
        payload->>'name' AS "toolName",
        -- Counted over every match, not just the page: the UI says "100 of 240" rather than
        -- implying the capped list is all there is. Window functions run before LIMIT.
        (count(*) OVER ())::int AS "total",
        snippet AS "snippet"
      FROM matched
      -- Phrase first, words only as a fallback: while the session holds the phrase itself, the
      -- rows that merely mention its words are noise, and this list has a hard cap that they
      -- would eat into. Once it doesn't, they are the whole point.
      WHERE exact OR NOT (SELECT bool_or(exact) FROM matched)
      ORDER BY seq DESC
      LIMIT ${take}::int
    `);

    return {
      q: norm.raw,
      total: rows[0]?.total ?? 0,
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
        data,
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

  private static readonly LIVE: RunStatus[] = [
    RunStatus.RUNNING,
    RunStatus.AWAITING_INPUT,
    RunStatus.INTERRUPTED,
  ];

  // Not live: resume() revives these (and complete/delete/config treat them as
  // already-ended). CANCELLED covers both a hard stop and a graceful, still-resumable end
  // (idle recycle / user end) — `endReason` is what tells those apart for display.
  private static readonly TERMINAL: RunStatus[] = [
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
      throw new ConflictException('the session is in Trash; restore it before sending a message');
    }
    if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
      throw new ConflictException('the session has ended');
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
  private static initialTurnClientId(sessionId: string): string {
    return `initial-${sessionId}`;
  }

  /** Allocate a turn while the caller holds the Session row lock. */
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
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('session not found');
      return this.insertTurnLocked(tx, sessionId, data);
    });
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
  async createTurn(ownerId: string, id: string, dto: SessionTurnDto, opts?: { clearSettledWorktreeState?: boolean }) {
    assertPromptSize(dto.content, 'message');
    await this.getSendable(ownerId, id); // fast ownership/lifecycle validation
    const queued = await this.prisma.$transaction(async (tx) => {
      // Linearize against claim and turnComplete. If completion wins, it first releases
      // RUNNING->AWAITING_INPUT and this enqueue changes it to PENDING. If enqueue wins,
      // completion sees this turn and retains RUNNING. Neither ordering can lose a wakeup.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      if (session.deletedAt) {
        throw new ConflictException('the session is in Trash; restore it before sending a message');
      }
      if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
        throw new ConflictException('the session has ended');
      }
      const existing = await tx.conversationTurn.findUnique({
        where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto.clientTurnId } },
      });
      if (existing) {
        return {
          turn: existing,
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
      const turn = await this.insertTurnLocked(tx, id, {
        // Whitelist: this endpoint cannot manufacture control turns.
        kind: dto.kind === 'shell' ? 'shell' : 'message',
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
        wakeQueue: nextStatus === RunStatus.PENDING,
        wakeInbox: nextStatus === RunStatus.RUNNING,
      };
    });
    if (queued.wakeQueue) this.queue.notifySessionQueued();
    if (queued.wakeInbox) this.realtime.notifyInbox(id);
    return { turnId: queued.turn.id, seq: queued.turn.seq };
  }

  /** Abort the in-flight turn of a live session (the process stays alive). */
  async interrupt(ownerId: string, id: string) {
    await this.getLive(ownerId, id);
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id } });
      if (!SessionsService.LIVE.includes(session.status) || session.cancelRequestedAt) {
        throw new ConflictException('the session has ended');
      }
      // Drop queued-but-undelivered follow-ups: interrupting means "stop", so they
      // should not fire after the current turn is aborted. Queued `!cmd` shell turns go
      // too — they sit in the same "waiting behind the running turn" queue (as the
      // executable count below already assumes), and leaving them behind ran a command
      // the user had just told to stop.
      await tx.conversationTurn.deleteMany({
        where: { sessionId: id, kind: { in: ['message', 'shell'] }, status: 'PENDING' },
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
      await this.insertTurnLocked(tx, id, { kind: 'interrupt', clientTurnId: randomUUID() });
    });
    this.realtime.notifyInbox(id);
    return { ok: true };
  }

  /** The session's still-queued user turns (PENDING — accepted but not yet picked
   *  up by the runner), oldest first. A queued turn emits no event until it's delivered,
   *  so it can't be recovered from the event stream; reopening or deep-linking a running
   *  session fetches this to restore the visible queue (mirrors listApprovals). `!cmd`
   *  shell turns queue behind the running turn exactly like messages do, so they're
   *  listed too (tagged by `kind`) — omitting them made a mid-turn command invisible
   *  until it eventually ran. */
  async listQueuedTurns(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const turns = await this.prisma.conversationTurn.findMany({
      // Exclude the seeded prompt turn (still PENDING until the runner claims the session):
      // it's the session's opening message, not a withdrawable queued follow-up.
      where: {
        sessionId: id,
        kind: { in: ['message', 'shell'] },
        status: 'PENDING',
        clientTurnId: { not: SessionsService.initialTurnClientId(id) },
      },
      orderBy: { seq: 'asc' },
      // Carry each queued turn's image refs so the composer can still render them after a
      // reload (the local object-URL previews are gone by then) — e.g. an image-only turn.
      select: {
        id: true,
        kind: true,
        content: true,
        attachments: { select: { id: true, mimeType: true } },
      },
    });
    return turns.map((t) => ({
      turnId: t.id,
      kind: t.kind,
      content: t.content ?? '',
      attachments: t.attachments.map((a) => ({ id: a.id, mimeType: a.mimeType })),
    }));
  }

  /** Withdraw a queued user message or `!cmd` shell turn. Only a still-PENDING one can be
   *  cancelled; once the runner has leased it (IN_FLIGHT) it's already feeding claude / already
   *  running, and will appear in the transcript, so cancelling is rejected. */
  async cancelQueuedTurn(ownerId: string, id: string, turnId: string) {
    await this.getSendable(ownerId, id);
    await this.prisma.$transaction(async (tx) => {
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
      if (res.count === 0) throw new ConflictException('message already started or not found');

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
    });
    this.realtime.notifyInbox(id);
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
    const workspaceId = await this.prisma.$transaction(async (tx) => {
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
      await tx.session.update({
        where: { id },
        data: {
          mergeStatus: 'pending',
          mergeTarget: target,
          mergeRequestedAt: new Date(),
          mergeOperationId: randomUUID(),
          mergeOperationOwner: null,
          mergeError: null,
          mergedAt: null,
          mergedSourceSha: null,
          branchMerged: null,
        },
      });
      return session.workspaceId;
    });
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
    return this.prisma.$transaction(async (tx) => {
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
    });
  }

  /**
   * Stop a session and settle it to CANCELLED with endReason 'cancelled' — unlike
   * {@link end}, which reaches the same status under 'ended' and so still reads as
   * dormant/resumable. A PENDING session is finalized in place (while any prior warm
   * runtime is cancelled); other open states receive an end control. No-op (returns
   * false) if already terminal or already ending. Used by {@link TasksService.batchStop}.
   */
  async cancel(ownerId: string, id: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) return false;
    return this.endOpen(ownerId, id, SessionEndReason.CANCELLED);
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
    if (ended.runnerId) this.realtime.requestCancel(ended.runnerId, sessionId);
    this.realtime.notifyInbox(sessionId);
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
  ): Promise<{
    changed: boolean;
    runnerId: string | null;
    status: RunStatus;
    lifecycleState: SessionLifecycleState;
    /** @deprecated Compatibility representation of lifecycleState. */
    filingState: SessionFilingState;
    endReason: SessionEndReason | null;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${sessionId}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId } });
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
        if (Object.keys(lifecycleData).length > 0) {
          await tx.session.update({ where: { id: sessionId }, data: lifecycleData });
        }
        return {
          changed: false,
          runnerId: session.assignedRunnerId,
          status: session.status,
          lifecycleState,
          filingState,
          endReason:
            session.endReason == null ? null : (session.endReason as SessionEndReason),
        };
      }
      if (session.status === RunStatus.PENDING) {
        await tx.session.update({
          where: { id: sessionId },
          data: {
            ...lifecycleData,
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
          data: { ...lifecycleData, cancelRequestedAt: now, endReason: reason },
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
      };
    });
  }

  /** Emit runner/control-plane effects for a newly persisted end intent. */
  private publishEndIntent(
    sessionId: string,
    ended: { changed: boolean; runnerId: string | null },
  ): void {
    if (!ended.changed) return;
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
  async resume(
    ownerId: string,
    id: string,
    dto: SessionResumeDto,
    opts?: { batch?: { id: string; maxConcurrent: number } | null },
  ) {
    assertPromptSize(dto.content, 'message');
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      include: {
        assignedRunner: { select: { id: true, status: true, lastHeartbeatAt: true } },
      },
    });
    if (!session) throw new NotFoundException('session not found');
    // A Claude row with turns but no runtime session id has no conversation to resume. That
    // wedges the capabilities check: MISSING_CONTEXT blocks resume because the session
    // appears to have lost its conversation. Generate a fresh id and reset numTurns so the
    // runner does a first spawn (--session-id) instead of a doomed --resume, and the session
    // is resumable from the UI.
    if (session.provider === 'claude' && session.numTurns > 0 && !session.runtimeSessionId) {
      const sid = randomUUID();
      await this.prisma.session.update({
        where: { id },
        data: { runtimeSessionId: sid, numTurns: 0 },
      });
      session.runtimeSessionId = sid;
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
    const revived = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "session"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('session not found');
      const current = await tx.session.findUniqueOrThrow({
        where: { id },
        include: {
          assignedRunner: { select: { id: true, status: true, lastHeartbeatAt: true } },
        },
      });
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
    });
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
    return { turnId: revived.turn.id, seq: revived.turn.seq };
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
   * Change the model / permission mode / effort / provider of an already-started session. The live
   * runtime process was spawned with the old model/permission-mode flags, so we
   * persist the new values and enqueue a `reload` control turn: the runner tears the
   * process down and re-spawns it with --resume + the new flags (full context kept).
   * The reload is deferred by the inbox lease until no message is in flight, so changing
   * config mid-turn doesn't abort the running turn — it applies between turns (the next
   * queued message then runs under the new config). A not-yet-claimed (PENDING) session
   * needs no reload: the claim reads the new value.
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
    const needsReload = await this.prisma.$transaction(async (tx) => {
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
          assignedRunner: { select: { runtimeDefaultModels: true, modelCatalog: true } },
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
      // config PATCH in that small window must seed it first; otherwise reload would become the
      // first turn and the claim path could mistake that control turn for the opening message.
      if (session.numTurns === 0) await this.ensurePromptSeeded(tx, session);
      // Live session (RUNNING/AWAITING_INPUT/INTERRUPTED): enqueue the reload under this same row
      // lock, so its payload is exactly the pair committed above. The inbox lease applies it
      // between turns. `effort: undefined` is omitted by JSON.stringify when it did not change.
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
      return true;
    });
    if (needsReload) this.realtime.notifyInbox(id);
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
    await this.prisma.session.update({ where: { id }, data: { title } });
    // A rename has no STATUS/TURN_END behind it, so without this the owner's OTHER clients (and
    // other tabs) keep the old title until the session's next turn.
    this.realtime.publishSessionUpdated(id);
    return { ok: true, title };
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

  /** Bring a Completed or soft-deleted session back to Open. */
  async restore(ownerId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
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
    });
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
    await this.prisma.$transaction(async (tx) => {
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
    });
    return { ok: true };
  }
}
