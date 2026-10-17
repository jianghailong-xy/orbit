import { BadRequestException, ConflictException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import {
  announceRunnerRelease,
  assignRunnerRelease,
  currentRunnerReleasePolicy,
  isRunnerReleaseVersion,
  type RunnerReleaseAssignment,
  type RunnerReleasePolicy,
} from './runner-release';

/**
 * GET /api/runner/release?latest=<version>&previous=<version>: which of the releases /dl publishes this runner is to
 * run (runner-release.ts). The runner names the two versions it read from /dl/version.json and
 * /dl/previous/version.json (`previous` omitted when there is none); the answer is decided by the authenticated
 * runner's id, never by anything the caller could choose. A runner that gets a 404 here is talking to a control
 * plane older than this route and installs /dl/version.json as before, so every refusal below is a 4xx other than
 * 404: the runner keeps the release it runs and asks again at its next check.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerReleaseController {
  @Get('release')
  assign(
    @CurrentRunner() runner: Runner,
    @Query('latest') latest: unknown,
    @Query('previous') previous: unknown,
  ): RunnerReleaseAssignment {
    return answerRunnerRelease(runner.id, latest, previous, currentRunnerReleasePolicy());
  }
}

/** The route's answer for `runnerId` under the pointer as `read`. */
export function answerRunnerRelease(
  runnerId: string,
  latest: unknown,
  previous: unknown,
  read: { policy: RunnerReleasePolicy } | { problems: string[] },
): RunnerReleaseAssignment {
  if (!isRunnerReleaseVersion(latest)) {
    throw new BadRequestException({
      code: 'RUNNER_RELEASE_VERSION_INVALID',
      message: `latest must be the release version /dl/version.json names, not ${JSON.stringify(latest)}`,
    });
  }
  if (previous !== undefined && !isRunnerReleaseVersion(previous)) {
    throw new BadRequestException({
      code: 'RUNNER_RELEASE_VERSION_INVALID',
      message: `previous must be the release version /dl/previous/version.json names, not ${JSON.stringify(previous)}`,
    });
  }
  if ('problems' in read) {
    throw new ConflictException({
      code: 'RUNNER_RELEASE_POINTER_UNREADABLE',
      message: `runner-release.json cannot be read (${read.problems.join('; ')}): no runner is assigned a release until it is fixed`,
    });
  }
  const published = { latest, previous: previous ?? null };
  announceRunnerRelease(published, read.policy);
  const assignment = assignRunnerRelease(runnerId, published, read.policy);
  if (!assignment) {
    throw new ConflictException({
      code: 'RUNNER_RELEASE_ROLLBACK_UNAVAILABLE',
      message: `runner-release.json rolls back ${latest}, but /dl keeps no release before it: no runner is moved`,
    });
  }
  return assignment;
}
