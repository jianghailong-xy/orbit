import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto, ReorderWorkspacesDto, UpdateWorkspaceDto } from './dto';

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
}
