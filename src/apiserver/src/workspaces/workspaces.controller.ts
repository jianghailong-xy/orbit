import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { MainCheckoutActionPost } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope, workspaceConfinement } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { WorkspacesService } from './workspaces.service';
import { MainCheckoutService } from './main-checkout.service';
import { CreateWorkspaceDto, ReorderWorkspacesDto, UpdateWorkspaceDto } from './dto';

@UseGuards(JwtAuthGuard)
// Both paths are live on purpose: `workspaces` is the name, `agents` is what every already-
// shipped client (web build, TestFlight iOS/macOS, field runners) still calls. The alias goes
// away once those have all rolled over; until then removing it is a hard break, not a cleanup.
@Controller(['workspaces', 'agents'])
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly mainCheckout: MainCheckoutService,
  ) {}

  @PatScope('workspaces:write', { workspaceConfinable: false })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(user.userId, dto);
  }

  @PatScope('workspaces:read', { workspaceConfinable: 'LIST' })
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspaces.list(user.userId, workspaceConfinement(user));
  }

  // Persist the sidebar drag order. Declared before the `:id` routes; the static
  // path keeps it from being shadowed by a param route.
  @PatScope('workspaces:write', { workspaceConfinable: false })
  @Post('reorder')
  reorder(@CurrentUser() user: AuthUser, @Body() dto: ReorderWorkspacesDto) {
    return this.workspaces.reorder(user.userId, dto.ids);
  }

  @PatScope('workspaces:read', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.get(user.userId, id);
  }

  @PatScope('workspaces:write', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspaces.update(user.userId, id, dto);
  }

  @PatScope('workspaces:write', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.remove(user.userId, id);
  }

  /** Ask this workspace's runner to clean up the shared checkout it works in (rescue what's there
   *  onto a branch, then return it to HEAD). Queued for the next heartbeat; the outcome lands on
   *  the workspace's repoCleanup fields. */
  @PatScope('workspaces:write', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Post(':id/repo-cleanup')
  cleanUpRepo(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.requestRepoCleanup(user.userId, id);
  }

  /** The main checkout as its runner sees it now (docs/main-checkout-git-contract.md §2), with the patches of the
   *  files named by `diff` (repeat it per file). A runner without `main-checkout-git/v1` is answered from its last
   *  heartbeat, with `actionsSupported: false`. */
  @PatScope('workspaces:read', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Get(':id/main-checkout')
  mainCheckoutRead(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('diff') diff?: string | string[],
  ) {
    return this.mainCheckout.read(user.userId, id, diff === undefined ? [] : Array.isArray(diff) ? diff : [diff]);
  }

  /** Move, commit, push or rescue the main checkout (§5). Queued for the runner; the outcome is a line in
   *  `initiatedFromSessionId` and the answer to a repeat of the same `requestId`. */
  @PatScope('workspaces:write', {
    workspaceConfinable: { params: { id: 'workspace' }, body: { targetSessionId: 'session', initiatedFromSessionId: 'session' } },
  })
  @Post(':id/main-checkout/actions')
  @HttpCode(200)
  mainCheckoutAct(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body(PublicIdPipe.forFields('targetSessionId', 'initiatedFromSessionId')) body: MainCheckoutActionPost,
  ) {
    return this.mainCheckout.act(user.userId, id, body);
  }

  /** Cancel an action the runner has not been handed yet (the RUNNER_OFFLINE line's Cancel). */
  @PatScope('workspaces:write', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Post(':id/main-checkout/actions/:requestId/cancel')
  @HttpCode(200)
  mainCheckoutCancel(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('requestId') requestId: string,
  ) {
    return this.mainCheckout.cancel(user.userId, id, requestId);
  }

  /** What this workspace's sessions no longer ask about ("always allow" answers that outlived
   *  the session they were given in). */
  @PatScope('workspaces:read', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Get(':id/permission-rules')
  permissionRules(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.listPermissionRules(user.userId, id);
  }

  /** Revoke one standing grant; this workspace's sessions ask about that call again. */
  @PatScope('workspaces:write', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Delete(':id/permission-rules/:ruleId')
  removePermissionRule(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('ruleId', PublicIdPipe) ruleId: string,
  ) {
    return this.workspaces.removePermissionRule(user.userId, id, ruleId);
  }
}
