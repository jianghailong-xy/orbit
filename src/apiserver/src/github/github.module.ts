import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { GithubClient } from './github-api.client';
import { GithubAdminController } from './github-admin.controller';
import { GithubAppConfigService } from './github-app-config.service';
import { GithubConnectionService } from './github-connection.service';
import { GithubCallbackController, GithubController } from './github.controller';

/** GitHub-backed workspaces, P0 (docs/github-workspace-design.md §11): the App's configuration and each account's connection. */
@Module({
  controllers: [GithubAdminController, GithubController, GithubCallbackController],
  providers: [AdminRoleGuard, { provide: GithubClient, useFactory: () => new GithubClient() }, GithubAppConfigService, GithubConnectionService],
  exports: [GithubAppConfigService, GithubConnectionService],
})
export class GithubModule {}
