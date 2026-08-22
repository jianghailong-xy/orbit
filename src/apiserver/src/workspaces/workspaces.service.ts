import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WorkspacePermissionRuleInfo } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { lastProviderByWorkspace, withProviderSeed } from './workspace-provider';
import {
  isBlockingRepoState,
  readRunnerRepoHealth,
  repoHealthForWorkspace,
} from '../common/runner-repo-health';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from './dto';

/** Shape of the account-level preferences this service reads (users.controller owns the rest). */
type OrchestrationPreference = { defaultEnableOrchestration?: unknown };

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A workspace may only be pinned to a runner the same owner controls. Without
   * this, a user could point their own workspace at another tenant's runner and
   * route tasks there (cross-tenant execution via the workspace-routing path).
   */
  private async assertOwnedRunner(ownerId: string, runnerId?: string): Promise<void> {
    if (!runnerId) return;
    const runner = await this.prisma.runner.findFirst({
      where: { id: runnerId, ownerId },
      select: { id: true },
    });
    if (!runner) throw new ForbiddenException('runner not found');
  }

  /**
   * The account-level answer to "should a workspace I make next be allowed to orchestrate?"
   * (Settings → Session orchestration). A seed only: it decides what the new row is written with,
   * and from then on the row is the authority — exactly how defaultPermissionMode seeds a session.
   * Consulted solely when the create request itself names no value, so an explicit `false` from a
   * form always wins over an account default of on.
   */
  private async defaultEnableOrchestration(ownerId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { preferences: true },
    });
    const prefs = (user?.preferences ?? {}) as OrchestrationPreference;
    return prefs.defaultEnableOrchestration === true;
  }

  async create(ownerId: string, dto: CreateWorkspaceDto) {
    await this.assertOwnedRunner(ownerId, dto.targetRunnerId);
    await this.assertOwnedRunner(ownerId, dto.runnerId);
    const enableOrchestration =
      dto.enableOrchestration ?? (await this.defaultEnableOrchestration(ownerId));
    const workspace = await this.prisma.workspace.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        // Runtime defaults are reported through the bound Runner. Keep the nullable column only for
        // old-client reads of workspaces created before migration 0079; never seed it from dto.model.
        model: null,
        appendSystemPrompt: dto.appendSystemPrompt,
        systemPrompt: dto.systemPrompt,
        disallowedTools: (dto.disallowedTools ?? []) as Prisma.InputJsonValue,
        providerFallbacks: (dto.providerFallbacks ?? []) as unknown as Prisma.InputJsonValue,
        canCreateTasks: dto.canCreateTasks ?? false,
        canDelegate: dto.canDelegate ?? false,
        maxConcurrentTasks: dto.maxConcurrentTasks,
        effort: dto.effort,
        targetRunnerId: dto.targetRunnerId,
        targetLabels: dto.targetLabels ?? [],
        runnerId: dto.runnerId,
        workDir: dto.workDir,
        env: (dto.env ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
        autoInitGit: dto.autoInitGit ?? false,
        enableWorktree: dto.enableWorktree ?? false,
        enableOrchestration,
        defaultMergeTarget: dto.defaultMergeTarget,
      },
    });
    // Brand-new: no sessions yet, so the seed is the floor. Shaped like every other read.
    return withProviderSeed([workspace], new Map())[0];
  }

  /** What the read paths include about a workspace's machine: identity for grouping/routing, plus
   *  the checkout-health snapshot its heartbeat carries (resolved per workspace by withRepoHealth). */
  private static readonly RUNNER_INCLUDE = {
    runner: {
      select: {
        id: true,
        name: true,
        displayName: true,
        repoHealth: true,
        repoCleanupStatus: true,
        repoCleanupBranch: true,
        repoCleanupMessage: true,
      },
    },
  } as const;

  /**
   * Attach the state of the shared checkout this workspace's sessions run in.
   *
   * The runner reports every checkout on the machine; a workspace only cares about its own, so this
   * resolves the one entry and drops the rest rather than shipping the whole column with each
   * workspace. Null when the runner is older than the report, has no runner, or the workDir isn't a
   * git repo — all of which the UI reads as "unknown", never as "clean".
   */
  private withRepoHealth<T extends { id: string; runner?: { repoHealth?: unknown } | null }>(
    workspace: T,
  ) {
    if (!workspace.runner) return { ...workspace, repoHealth: null, repoCleanup: null };
    const {
      repoHealth: reported,
      repoCleanupStatus,
      repoCleanupBranch,
      repoCleanupMessage,
      ...runner
    } = workspace.runner as Record<string, unknown> & { repoHealth?: unknown };
    return {
      ...workspace,
      runner,
      repoHealth: repoHealthForWorkspace(readRunnerRepoHealth(reported), workspace.id),
      // The repair relay's last word, so the UI can hold "Cleaning up…" and then name the rescue
      // branch instead of silently dropping the warning.
      repoCleanup: repoCleanupStatus
        ? {
            status: repoCleanupStatus as string,
            branch: (repoCleanupBranch as string | null) ?? null,
            message: (repoCleanupMessage as string | null) ?? null,
          }
        : null,
    };
  }

  async list(ownerId: string) {
    const workspaces = await this.prisma.workspace.findMany({
      where: { ownerId, deletedAt: null },
      // Custom drag order first; never-reordered workspaces (position NULL) sort last by
      // creation time, so newly added workspaces append below the arranged ones.
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      // Expose the machine a workspace belongs to so the UI can group/route by runner.
      include: WorkspacesService.RUNNER_INCLUDE,
    });
    // One indexed query for the whole list — the provider each project last ran on.
    const seeded = withProviderSeed(workspaces, await lastProviderByWorkspace(this.prisma, workspaces.map((a) => a.id)));
    return seeded.map((workspace) => this.withRepoHealth(workspace));
  }

  /**
   * Persist the sidebar order. `ids` is the full workspace list in the desired order;
   * each workspace's `position` is set to its index. Ids the caller doesn't own are
   * dropped, so a stale or hostile client can't stamp positions onto another
   * tenant's workspaces.
   */
  async reorder(ownerId: string, ids: string[]) {
    const owned = await this.prisma.workspace.findMany({
      where: { id: { in: ids }, ownerId, deletedAt: null },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((a) => a.id));
    const ordered = ids.filter((id) => ownedIds.has(id));
    // The position a workspace ends up with is its index in the order the CALLER sent. The order
    // the rows are LOCKED in is by id, and the two are deliberately different things.
    //
    // Writing in the caller's order was a deadlock waiting for two people to drag the same
    // sidebar — or one person on two devices. A drag that moves A above B and a drag that moves B
    // above A send exactly reversed arrays, so the two transactions took the same `workspace`
    // rows in opposite orders and PostgreSQL had to shoot one of them (40P01), which surfaced as
    // an unexplained 500 on a sidebar drag. Nothing about the request was wrong.
    //
    // Sorting the STATEMENTS fixes it without changing a single stored position: each row still
    // gets the index the caller asked for, and every concurrent reorder now takes the rows in one
    // agreed order, which is the same trick `RunnersService.reorderRunners` has always used and
    // the general rule `orderedIds` states (common/lock-order.ts). Two reorders that overlap
    // now queue behind each other and both commit, last writer winning per row — which is what a
    // sidebar order means anyway.
    // De-duplicated in the order the caller sent — a client that repeats an id must not hand two
    // positions to one row — and then sorted by id, which is the same two steps
    // `RunnersService.reorderRunners` takes.
    const ranked = [...new Set(ordered)]
      .map((id, position) => ({ id, position }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    if (ranked.length === 0) return this.list(ownerId);
    // Retried whole. The ordering above removes the reorder-versus-reorder cycle, but a
    // `workspace` row is also touched by other writers, so the residual conflict is answered
    // rather than assumed away — and it is safe to answer this way because every attempt writes
    // the same positions from the same `ranked` array, computed once, outside the closure.
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        for (const { id, position } of ranked) {
          await tx.workspace.update({ where: { id }, data: { position } });
        }
      },
      loggedRetry(this.logger, 'workspaces.reorder'),
    );
    return this.list(ownerId);
  }

  async get(ownerId: string, id: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id, ownerId, deletedAt: null },
      include: WorkspacesService.RUNNER_INCLUDE,
    });
    if (!workspace) throw new NotFoundException('workspace not found');
    const seeded = withProviderSeed([workspace], await lastProviderByWorkspace(this.prisma, [workspace.id]))[0];
    return this.withRepoHealth(seeded);
  }

  /**
   * Queue "clean up the checkout this workspace works in" for its runner's next heartbeat.
   *
   * Only offered for a checkout the runner itself reported as wedged: the repair rewrites a
   * directory shared by every session on that machine, so the trigger is a state we observed, not
   * a path a client asked for. Re-clicking while one is pending is a no-op rather than a second
   * repair — the first is already redelivered until the runner answers.
   */
  async requestRepoCleanup(ownerId: string, id: string) {
    const workspace = await this.get(ownerId, id);
    const health = workspace.repoHealth;
    if (!health) throw new BadRequestException('this workspace has no reported checkout');
    if (!isBlockingRepoState(health.state)) {
      throw new BadRequestException(`${health.root} is not stuck (${health.state}) — nothing to clean up`);
    }
    if (!workspace.runnerId) throw new BadRequestException('this workspace is not bound to a runner');
    await this.prisma.runner.updateMany({
      // Owner-scoped even though `get` already proved the workspace is ours: the runner is a separate
      // row, and a write keyed only by id would be a cross-tenant write if the two ever disagreed.
      where: {
        id: workspace.runnerId,
        ownerId,
        // Null-safe on purpose. `NOT (status = 'pending')` evaluates to NULL — not true — for a
        // runner that has never been asked, which is every runner's initial state, so the plain
        // NOT matched no rows and the very first repair on a machine silently did nothing while
        // this endpoint still answered 200 and the UI sat on "Cleaning up…" forever.
        OR: [{ repoCleanupStatus: null }, { repoCleanupStatus: { not: 'pending' } }],
      },
      data: {
        repoCleanupStatus: 'pending',
        repoCleanupRoot: health.root,
        repoCleanupBranch: null,
        repoCleanupMessage: null,
        repoCleanupAt: new Date(),
      },
    });
    return this.get(ownerId, id);
  }

  async update(ownerId: string, id: string, dto: UpdateWorkspaceDto) {
    const current = await this.get(ownerId, id);
    await this.assertOwnedRunner(ownerId, dto.targetRunnerId);
    await this.assertOwnedRunner(ownerId, dto.runnerId);
    const data: Prisma.WorkspaceUpdateInput = {
      name: dto.name,
      description: dto.description,
      appendSystemPrompt: dto.appendSystemPrompt,
      systemPrompt: dto.systemPrompt,
      effort: dto.effort,
      workDir: dto.workDir,
      targetRunnerId: dto.targetRunnerId,
      enabled: dto.enabled,
      autoInitGit: dto.autoInitGit,
      enableWorktree: dto.enableWorktree,
      enableOrchestration: dto.enableOrchestration,
      canCreateTasks: dto.canCreateTasks,
      canDelegate: dto.canDelegate,
      maxConcurrentTasks: dto.maxConcurrentTasks,
      defaultMergeTarget: dto.defaultMergeTarget,
    };
    if (dto.disallowedTools) data.disallowedTools = dto.disallowedTools as Prisma.InputJsonValue;
    if (dto.providerFallbacks) {
      data.providerFallbacks = dto.providerFallbacks as unknown as Prisma.InputJsonValue;
    }
    if (dto.env) data.env = dto.env as Prisma.InputJsonValue;
    if (dto.targetLabels) data.targetLabels = dto.targetLabels;
    // runnerId is a relation FK: connect to (re)bind, disconnect to detach.
    if (dto.runnerId !== undefined) {
      data.runner = dto.runnerId ? { connect: { id: dto.runnerId } } : { disconnect: true };
    }
    const workspace = await this.prisma.workspace.update({ where: { id }, data });
    return withProviderSeed([workspace], await lastProviderByWorkspace(this.prisma, [id]))[0];
  }

  /**
   * Grant or revoke session orchestration across every live workspace this account owns.
   *
   * The grant stays per workspace — this writes each row rather than introducing an account-level
   * switch the authorizer would consult — because the enforced bit has to stay revocable one
   * workspace at a time (runner-orchestration-authorizer reads it live, per claim and per spawn).
   * What this removes is only the clicking: turning it on for a fleet used to mean opening every
   * workspace's editor in turn, and the "off" direction doubles as a kill switch for the account.
   */
  async setOrchestrationForAll(ownerId: string, enabled: boolean) {
    const { count } = await this.prisma.workspace.updateMany({
      where: { ownerId, deletedAt: null },
      data: { enableOrchestration: enabled },
    });
    return { updated: count };
  }

  /**
   * Delete an agent — unless a project is coordinated by it.
   *
   * The refusal is the soft-delete half of the `project_member` foreign key's RESTRICT, which
   * cannot fire here: this is an UPDATE, and the row it points at goes on existing. Without it, an
   * agent a project coordinates with can be deleted and the project keeps naming it — the identity
   * behind its coordinator is a deleted agent, and every later read has to decide what that means.
   *
   * The lock is what makes the answer independent of timing. `FOR UPDATE` conflicts with the
   * `FOR SHARE` that `ProjectsService.writeCoordinatorAgent` takes on this same row, so a delete
   * and a "make this agent the coordinator" are two orderings and never an interleaving: whichever
   * takes the row first, the other sees the outcome and is refused. Taking it BEFORE counting is
   * the whole of it — counting first would read a number that another transaction is already
   * making wrong. This path never locks a project row, which is why it cannot deadlock against
   * that one (project first, then agent).
   */
  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    // Soft delete: stamp `deletedAt` rather than dropping the row. The workspace's sessions and
    // tasks stay linked (no FK SET NULL orphaning) and it stays restorable; every user-facing
    // listing filters on `deletedAt: null`, while runtime lookups by a live session's workspaceId
    // deliberately don't — so in-flight sessions keep resolving their workspace's config.
    // Retried whole: the row is re-read under its own lock inside the closure, and a delete that
    // already happened is the same answer on any attempt.
    await withTransactionRetry(this.prisma, async (tx) => {
      const held = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "workspace"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid AND "deleted_at" IS NULL
        FOR UPDATE`;
      // Already deleted, by a request that got here first. Deleting is idempotent — the caller
      // asked for a state this row is already in.
      if (held.length === 0) return;
      const coordinating = await tx.projectMember.count({ where: { agentId: id } });
      if (coordinating > 0) {
        throw new ConflictException(
          `This agent still coordinates ${coordinating} project(s) and cannot be deleted — ` +
            'point those projects at another coordinator first',
        );
      }
      await tx.workspace.update({ where: { id }, data: { deletedAt: new Date() } });
    }, loggedRetry(this.logger, 'workspaces.remove'));
    return { ok: true };
  }

  /**
   * The standing "always allow" grants on this workspace — what its sessions no longer ask
   * about, because someone already answered once with "always allow".
   *
   * Listing them is not a nicety: a grant that cannot be seen cannot be judged, and one that
   * outlives the session that created it has to be revocable, or "always" is a decision the
   * user can never take back.
   */
  async listPermissionRules(ownerId: string, id: string): Promise<WorkspacePermissionRuleInfo[]> {
    await this.get(ownerId, id);
    const rules = await this.prisma.workspacePermissionRule.findMany({
      where: { workspaceId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, toolName: true, ruleContent: true, createdAt: true },
    });
    return rules.map((rule) => ({ ...rule, createdAt: rule.createdAt.toISOString() }));
  }

  /** Revoke one standing grant. Its workspace's sessions ask about that call again from their
   *  next dispatch on — a session already running keeps whatever its runtime was started with,
   *  since the allowlist is a process argument. */
  async removePermissionRule(ownerId: string, id: string, ruleId: string) {
    await this.get(ownerId, id);
    const res = await this.prisma.workspacePermissionRule.deleteMany({
      where: { id: ruleId, workspaceId: id },
    });
    if (res.count === 0) throw new NotFoundException('permission rule not found');
    return { ok: true };
  }
}
