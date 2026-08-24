import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { WorkspacesService } from './workspaces.service';
import {
  CreateWorkspaceDto,
  RedispatchCloneDto,
  ReorderWorkspacesDto,
  SetOrchestrationDto,
  UpdateWorkspaceDto,
} from './dto';

@UseGuards(JwtAuthGuard)
// Both paths are live on purpose: `workspaces` is the name, `agents` is what every already-
// shipped client (web build, TestFlight iOS/macOS, field runners) still calls. The alias goes
// away once those have all rolled over; until then removing it is a hard break, not a cleanup.
@Controller(['workspaces', 'agents'])
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspaces.list(user.userId);
  }

  // Persist the sidebar drag order. Declared before the `:id` routes; the static
  // path keeps it from being shadowed by a param route.
  @Post('reorder')
  reorder(@CurrentUser() user: AuthUser, @Body() dto: ReorderWorkspacesDto) {
    return this.workspaces.reorder(user.userId, dto.ids);
  }

  /** Flip session orchestration on every workspace this account owns. Static path, so it must be
   *  declared ahead of the `:id` routes. Human-only by construction: this is a JWT route, and the
   *  runner/MCP surface (runner-agents.controller) drops the field entirely. */
  @Post('orchestration')
  setOrchestration(@CurrentUser() user: AuthUser, @Body() dto: SetOrchestrationDto) {
    return this.workspaces.setOrchestrationForAll(user.userId, dto.enabled);
  }

  /** The repositories this account already works on, for the first step of "new workspace".
   *  Static path, so it is declared ahead of the `:id` routes. */
  @Get('recent-repos')
  recentRepos(@CurrentUser() user: AuthUser) {
    return this.workspaces.recentRepos(user.userId);
  }

  /** Which machines can take a clone of `repoUrl`, and which already have it. Same reason for
   *  sitting above `:id`. `repoUrl` is optional: without it this still answers which machines can
   *  clone at all, which is what the picker needs while the URL is still being typed. */
  @Get('clone-targets')
  cloneTargets(@CurrentUser() user: AuthUser, @Query('repoUrl') repoUrl?: string) {
    return this.workspaces.cloneTargets(user.userId, repoUrl);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspaces.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.remove(user.userId, id);
  }

  /** Ask this workspace's runner to clean up the shared checkout it works in (rescue what's there
   *  onto a branch, then return it to HEAD). Queued for the next heartbeat; the outcome lands on
   *  the workspace's repoCleanup fields. */
  @Post(':id/repo-cleanup')
  cleanUpRepo(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.requestRepoCleanup(user.userId, id);
  }

  /** Clone again for a workspace whose last clone failed — the failure card's retry, and its
   *  change-URL and change-machine exits, which are the same dispatch with different arguments. */
  @Post(':id/clone')
  redispatchClone(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RedispatchCloneDto,
  ) {
    return this.workspaces.redispatchClone(user.userId, id, dto);
  }

  /** What this workspace's sessions no longer ask about ("always allow" answers that outlived
   *  the session they were given in). */
  @Get(':id/permission-rules')
  permissionRules(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.listPermissionRules(user.userId, id);
  }

  /** Revoke one standing grant; this workspace's sessions ask about that call again. */
  @Delete(':id/permission-rules/:ruleId')
  removePermissionRule(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('ruleId', PublicIdPipe) ruleId: string,
  ) {
    return this.workspaces.removePermissionRule(user.userId, id, ruleId);
  }
}
