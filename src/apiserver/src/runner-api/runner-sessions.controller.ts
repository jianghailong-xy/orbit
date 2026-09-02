import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { randomUUID } from 'crypto';
import { Runner, RunStatus } from '@prisma/client';
import { RunnerSessionScope, SessionsService } from '../sessions/sessions.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { RecordMergeReceiptDto } from '../sessions/dto';
import { SessionAttemptService } from '../projects/session-attempt.service';
import { SessionLifecycleActor } from '../projects/attempt-budget';
import { CurrentRunner } from './current-runner.decorator';
import { CurrentServiceGrant, RunnerSessionAuthGuard } from './runner-session-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { ServiceTokenGrant, ServiceTokenScope } from './service-token.authorizer';

/** No calling session => the request comes from a headless process, not from a workspace. */
function isHeadlessCaller(callingSessionId: string | undefined): boolean {
  return !callingSessionId?.trim();
}

/**
 * What the machine's own runner credential grants a headless caller: observe and message the
 * sessions this runner already hosts. Not creation — starting new work is the one headless verb
 * that must come from a credential someone minted on purpose and can revoke on its own.
 */
const RUNNER_CREDENTIAL_SCOPES: readonly ServiceTokenScope[] = [
  'session:get',
  'session:list',
  'session:send',
];

/**
 * Session orchestration (L3) for in-session workspaces, reached by the `orbit mcp` server with the
 * machine's runner token. Tenant scope is the runner's owner; a spawn is attributed to the
 * PARENT session (X-Orbit-Session-Id, injected by the runner) whose workspace must have
 * orchestration enabled — SessionsService enforces that plus the depth/child-count guards.
 *
 * A caller with no X-Orbit-Session-Id at all is HEADLESS: a launchd/cron bridge that belongs to
 * no session and outlives every session, so it can hold no session-bound credential. What it may
 * do depends on which credential it presents:
 *   - the machine's runner token   → get / list / send over the sessions this runner hosts
 *   - a minted service token       → exactly its scopes (which may include create), further
 *                                    narrowed to one workspace when the token is pinned
 * Either way the destructive verbs — interrupt, merge, end, complete — and the owner-wide search
 * stay out of reach: those still require a live calling session with orchestration enabled.
 *
 * Registered AFTER RunnerApiController (see runner-api.module.ts) so its static
 * GET sessions/claim | sessions/reclaim routes win over this controller's GET sessions/:id.
 */
@UseGuards(RunnerSessionAuthGuard)
@Controller('runner')
export class RunnerSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
    private readonly mergeReceipts: MergeReceiptService,
    private readonly attempts: SessionAttemptService,
  ) {}

  /**
   * `[K3]` §3: who is knocking.
   *
   * This is the door an agent uses, so it is the only place the difference between "a person
   * stopped this run" and "another agent stopped somebody else's run" is still visible — by the
   * time the request reaches SessionsService both look identical, which is how a coordinator's
   * `session complete` used to land on a live worker as an ordinary cancellation.
   */
  private static actor(callingSessionId: string | undefined): SessionLifecycleActor {
    return callingSessionId && !isHeadlessCaller(callingSessionId)
      ? { kind: 'AGENT_SESSION', sessionId: callingSessionId }
      : { kind: 'USER' };
  }

  /**
   * Resolve one headless request's reach, then assert it covers what the route needs.
   *
   * A service token authenticates a process, never a session, so presenting one alongside a
   * calling session is refused outright rather than silently resolved one way or the other.
   */
  private headlessScope(
    runner: Runner,
    grant: ServiceTokenGrant | undefined,
    scope: ServiceTokenScope,
  ): RunnerSessionScope {
    const granted = grant ? grant.scopes : RUNNER_CREDENTIAL_SCOPES;
    if (!granted.includes(scope)) {
      throw new ForbiddenException(
        grant
          ? `this service token does not have the ${scope} scope`
          : `${scope} requires a service token; mint one with \`orbit token mint\``,
      );
    }
    return { assignedRunnerId: runner.id, workspaceId: grant?.workspaceId ?? null };
  }

  private assertNoServiceToken(grant: ServiceTokenGrant | undefined): void {
    if (grant) {
      throw new ForbiddenException('a service token cannot act on behalf of a session');
    }
  }

  @Post('sessions')
  async createSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') parentSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    // Inline type — nothing validates it, and `workspaceId` is exactly what a model copies out of an
    // Orbit URL when told to "run this under that workspace".
    @Body(PublicIdPipe.forFields('workspaceId', 'agentId'))
    dto: {
      prompt: string;
      workspaceId?: string;
      /** @deprecated Pre-rename name, still sent by `orbit mcp` and every shipped runner. */
      agentId?: string;
      workspaceName?: string;
      title?: string;
      model?: string;
      provider?: string;
      permissionMode?: string;
    },
  ) {
    if (isHeadlessCaller(parentSessionId)) {
      const scope = this.headlessScope(runner, grant, 'session:create');
      // The pin is the authorization, so it is also the target: a caller cannot redirect the
      // spawn at another workspace by passing one in the body.
      if (dto.workspaceId && dto.workspaceId !== scope.workspaceId) {
        throw new ForbiddenException('this service token may only start its own workspace');
      }
      if (!scope.workspaceId) throw new ForbiddenException('this service token has no workspace to start');
      return this.sessions.spawnForServiceToken(
        runner.ownerId,
        { assignedRunnerId: runner.id, workspaceId: scope.workspaceId, tokenId: grant!.tokenId },
        { prompt: dto.prompt, title: dto.title, model: dto.model, permissionMode: dto.permissionMode },
      );
    }
    this.assertNoServiceToken(grant);
    const caller = await this.orchestration.assert(runner, parentSessionId, orchestrationToken);
    return this.sessions.spawnFromSession(runner.ownerId, caller, dto);
  }

  @Get('sessions')
  async listSessions(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Query('status') status: string | undefined,
    @Query('parentSessionId', PublicIdPipe) parentSessionId: string | undefined,
  ) {
    // Ignore an unknown status rather than letting Prisma 500 on a bad enum value.
    const s =
      status && (Object.values(RunStatus) as string[]).includes(status) ? (status as RunStatus) : undefined;
    if (isHeadlessCaller(callingSessionId)) {
      return this.sessions.listForOrchestration(runner.ownerId, {
        status: s,
        parentSessionId,
        scope: this.headlessScope(runner, grant, 'session:list'),
      });
    }
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.listForOrchestration(runner.ownerId, { status: s, parentSessionId });
  }

  // Same cross-scope search the clients' ⌘K palette runs (SessionsService.search), scoped to the
  // runner's owner. MUST stay above `sessions/:id` — Nest matches in declaration order, so below
  // it the literal path would be swallowed as an id.
  @Get('sessions/search')
  async searchSessions(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Query('q') q: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    // Deliberately no headless path: search spans every scope the OWNER has, including
    // conversation text from sessions on other machines, which is exactly what a machine-local
    // credential must not reach.
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.search(runner.ownerId, q, Number(limit) || 20);
  }

  @Get('sessions/:id')
  async getSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    if (isHeadlessCaller(callingSessionId)) {
      return this.sessions.getForOrchestration(
        runner.ownerId,
        id,
        this.headlessScope(runner, grant, 'session:get'),
      );
    }
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.getForOrchestration(runner.ownerId, id);
  }

  @Post('sessions/:id/turns')
  async sendMessage(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: { message: string; clientTurnId?: string },
  ) {
    if (isHeadlessCaller(callingSessionId)) {
      await this.sessions.assertHostedByRunner(
        runner.ownerId,
        this.headlessScope(runner, grant, 'session:send'),
        id,
      );
    } else {
      this.assertNoServiceToken(grant);
      await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    }
    const actor = RunnerSessionsController.actor(callingSessionId);
    // Same idempotency key every other entry point sends. A caller that retries a request it
    // never saw the answer to (the MCP tool, the CLI, a script) can repeat the key and get the
    // turn it already filed back, instead of a second copy of the message. Minting one here
    // when none is given keeps the historical behaviour for callers that don't care.
    const clientTurnId = dto.clientTurnId?.trim() || randomUUID();
    // Deliberately NO explicit `intent`: this endpoint sends the same unqualified message every
    // other client sends, and the server decides from the live turn whether it joins the turn now
    // running or queues as the next one. Naming CURRENT_WORK here made the verb useless against
    // the sessions it most needs to reach — a session that is AWAITING_INPUT has no current work,
    // and while the routing protocol was rollout-gated the request was refused outright.
    return this.sessions.createTurn(runner.ownerId, id, {
      clientTurnId,
      content: dto.message,
    }, {
      // AU3/TH3, but only for a NEW turn that has already passed idempotency and placement. The
      // callback runs under createTurn's Session lock and in its transaction: a retry observes the
      // durable clientTurnId first and spends nothing, while a refusal rolls back both charge and
      // receipt. This is the idempotency boundary, not a preflight guess in the controller.
      participateSendTransaction: (tx) =>
        this.attempts.chargeSteer(runner.ownerId, id, actor, tx),
    });
  }

  // The lifecycle verbs below have NO headless path by design. They are the most damaging
  // thing a machine-local credential could reach and a bridge never needs them, so they are not
  // in the service-token vocabulary at all: every one of them still requires a live calling
  // session whose workspace has orchestration enabled.
  @Post('sessions/:id/interrupt')
  async interruptSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto?: { message?: string; clientTurnId?: string },
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    // With a message, this is the same one-transaction "stop that and do this instead" the
    // browser sends (SessionInterruptDto): the follow-up is filed after the interrupt drops
    // what was queued, so it cannot be its own casualty. Bodyless stays a plain interrupt.
    const followUp = dto?.message?.trim();
    // Only the version that injects a turn is charged. A bodyless interrupt stops what is running
    // and writes no outcome, so it cannot overwrite one; an interrupt CARRYING a message is a steer
    // with more force behind it, and an unbounded loop of those is the same unbounded verb.
    const actor = RunnerSessionsController.actor(callingSessionId);
    const clientTurnId = dto?.clientTurnId?.trim() || randomUUID();
    return this.sessions.interrupt(
      runner.ownerId,
      id,
      followUp
        ? { content: followUp, clientTurnId }
        : undefined,
      followUp
        ? {
            participateFollowUpTransaction: (tx) =>
              this.attempts.chargeSteer(runner.ownerId, id, actor, tx),
          }
        : undefined,
    );
  }

  @Post('sessions/:id/merge')
  async mergeSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: { targetBranch?: string },
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.mergeToMain(runner.ownerId, id, dto.targetBranch);
  }

  /**
   * Record that a session's branch was merged (contract §13.7), for a merge Orbit did not perform.
   *
   * This is the door the fast-forward case needs. An agent that merges its own worktree branch —
   * which is how these branches actually land — leaves `merge_status` NULL and `branch_merged`
   * false forever, because the only code that ever wrote them is Orbit's own Merge button. One
   * `orbit session merge-receipt` after the merge is what makes the control plane able to answer
   * "did this task's work land" with a SHA instead of a shrug.
   *
   * Deliberately NOT behind the orchestration assert that guards `sessions/:id/merge` above. That
   * one asks another session's runner to mutate a repository; this one records a fact about work
   * that already happened, is append-only, and is scoped to the caller's own tenant. Requiring an
   * orchestration grant to file evidence would mean the deployments that most need the audit — the
   * ones where orchestration is off — are exactly the ones that cannot produce it.
   */
  @Post('sessions/:id/merge-receipts')
  async recordMergeReceipt(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RecordMergeReceiptDto,
  ) {
    return this.mergeReceipts.record(runner.ownerId, id, dto, 'AGENT');
  }

  /** Every merge recorded against this session's branch, newest first. */
  @Get('sessions/:id/merge-receipts')
  async listMergeReceipts(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.mergeReceipts.list(runner.ownerId, id, limit ? Number(limit) : undefined);
  }

  @Post('sessions/:id/end')
  async endSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    // TH2/AU2: a live attempt's ending is the worker's to write. Another agent ending it here
    // would settle the session with no outcome and no checkpoint, and "what actually failed" would
    // stop having an answer for every generation after this one.
    await this.attempts.assertMayEndSession(
      runner.ownerId, id, RunnerSessionsController.actor(callingSessionId));
    return this.sessions.end(runner.ownerId, id);
  }

  // The runner's own POST sessions/:id/finalize route is reserved for reporting process
  // teardown. Orchestrators use /complete-session for the user-facing Complete action:
  // it ends a live session with reason=completed and moves it out of Open.
  @Post('sessions/:id/complete-session')
  async completeSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    // The single most expensive action in the incident: a coordinator that disliked a run and
    // completed it. That is not a close — it is a result with no ending written over one that had
    // one, and the session lands as CANCELLED with nothing left to learn from.
    await this.attempts.assertMayEndSession(
      runner.ownerId, id, RunnerSessionsController.actor(callingSessionId));
    return this.sessions.complete(runner.ownerId, id);
  }

  // Soft-delete only: this moves the session to Trash and retains its transcript and other data.
  // Permanent purge remains a human-only action on the user-authenticated SessionsController.
  @Delete('sessions/:id')
  async deleteSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    await this.attempts.assertMayEndSession(
      runner.ownerId,
      id,
      RunnerSessionsController.actor(callingSessionId),
    );
    return this.sessions.remove(runner.ownerId, id);
  }

  /** @deprecated Compatibility route for older runner binaries. */
  @Post('sessions/:id/archive')
  async archiveSessionCompatibility(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.completeSession(runner, grant, callingSessionId, orchestrationToken, id);
  }
}
