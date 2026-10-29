import { Controller, Delete, Headers, Param, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnersService } from '../runners/runners.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import {
  RUNNER_DELETE_APPROVAL_TOOL_NAME,
  WORKSPACE_DELETE_APPROVAL_TOOL_NAME,
  requireDeleteApproval,
  runnerToDelete,
  workspaceToDelete,
} from './runner-delete-approval';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

/**
 * Deleting one of the account's runners, or one of its workspaces, from inside a session: what
 * `orbit runner delete` / `orbit agent delete` and the MCP tools runner_delete / agent_delete reach,
 * and what the runner's page in the web app does with its Delete.
 *
 * Gated as the runner list and the workspace tools are — the calling session must be allowed to
 * orchestrate — and then on the account owner's yes: the runner puts a confirmation card in front
 * of them first, and each route goes through only against that card (runner-delete-approval.ts).
 * The order is the answer's: a runner or workspace that is not the account's is not found before
 * anything is asked about it, one that is the asking session's own is refused, and only then is the
 * card required. Neither route is called by an already-shipped runner, so the workspace one has no
 * `agents/:id` alias.
 *
 * The deletes are the web's own: a runner goes with every workspace bound to it and a managed runner
 * is refused (RunnersService.removeRunner); a workspace is soft-deleted, and one that still
 * coordinates a project is refused (WorkspacesService.remove).
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerDeleteController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
    private readonly runners: RunnersService,
    private readonly workspaces: WorkspacesService,
    private readonly realtime: RealtimeService,
  ) {}

  @Delete('runners/:id')
  async deleteRunner(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const deleted = await runnerToDelete(this.prisma, { ownerId: runner.ownerId, runnerId: runner.id }, id);
    await requireDeleteApproval(this.prisma, scope, RUNNER_DELETE_APPROVAL_TOOL_NAME, id);
    await this.runners.removeRunner(runner.ownerId, id);
    // Its workspaces went with it: the owner's open lists drop them as they would an agent's edit.
    for (const workspace of deleted.workspaces) this.realtime.publishWorkspaceChanged(scope, workspace.id, true);
    return { ok: true, deleted };
  }

  @Delete('workspaces/:id')
  async deleteWorkspace(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const deleted = await workspaceToDelete(this.prisma, { ownerId: runner.ownerId, sessionId: scope }, id);
    await requireDeleteApproval(this.prisma, scope, WORKSPACE_DELETE_APPROVAL_TOOL_NAME, id);
    await this.workspaces.remove(runner.ownerId, id);
    this.realtime.publishWorkspaceChanged(scope, id, true);
    return { ok: true, deleted };
  }
}
