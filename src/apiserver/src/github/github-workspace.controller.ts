import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { GithubWorkspaceService } from './github-workspace.service';

/** A GitHub workspace's clone, from the owner's side (docs/github-workspace-design.md §5.3). */
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class GithubWorkspaceController {
  constructor(private readonly workspaces: GithubWorkspaceService) {}

  /** Clone again after a failure: FAILED → PENDING, and the runner is told on its next heartbeat. */
  @PatScope('workspaces:write', { workspaceConfinable: { params: { id: 'workspace' } } })
  @Post(':id/clone/retry')
  @HttpCode(HttpStatus.OK)
  retry(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.workspaces.retryClone(user.userId, id);
  }
}
