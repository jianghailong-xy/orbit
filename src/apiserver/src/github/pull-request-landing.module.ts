import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { GithubModule } from './github.module';
import { GithubWebhookController, GithubWebhookService } from './github-webhook';
import { PullRequestDoorService } from './pull-request-door.service';
import { PushAsMeService } from './push-as-me.service';

/**
 * Landing on a protected GitHub branch through a pull request (docs/design/protected-branch-landing.md §4): the door
 * that opens, reads and merges Orbit's pull requests and writes their landings, with GitHub's webhook and the slow
 * re-read that ring it. Imported by the runner door, whose results leave landings waiting on it.
 */
@Module({
  imports: [GithubModule, ProjectsModule, SessionsModule, PushModule],
  controllers: [GithubWebhookController],
  providers: [PullRequestDoorService, GithubWebhookService, PushAsMeService],
  exports: [PullRequestDoorService, PushAsMeService],
})
export class PullRequestLandingModule {}
