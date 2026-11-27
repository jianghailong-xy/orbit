import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { GithubClient } from './github-api.client';
import { GithubAdminController } from './github-admin.controller';
import { GithubAppConfigService } from './github-app-config.service';
import { GithubConnectionService } from './github-connection.service';
import { GithubInstallationGrants } from './github-installation-grants';
import { GithubCallbackController, GithubController } from './github.controller';
import { GithubWorkspaceController } from './github-workspace.controller';
import { GithubWorkspaceService } from './github-workspace.service';

/**
 * GitHub-backed workspaces (docs/github-workspace-design.md §11): the App's configuration and each account's connection
 * (P0), and a GitHub workspace's installation tokens, clone and Retry (P1). What each installation granted
 * (docs/design/protected-branch-landing.md §10) is read here too, for the integration queue to decide how a landing
 * goes; the pull request door is `PullRequestLandingModule`, which builds on this one.
 */
@Module({
  controllers: [GithubAdminController, GithubController, GithubCallbackController, GithubWorkspaceController],
  providers: [
    AdminRoleGuard,
    { provide: GithubClient, useFactory: () => new GithubClient() },
    GithubAppConfigService,
    GithubConnectionService,
    GithubWorkspaceService,
    GithubInstallationGrants,
  ],
  exports: [GithubAppConfigService, GithubConnectionService, GithubWorkspaceService, GithubClient, GithubInstallationGrants],
})
export class GithubModule {}
