import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { MachineProtocol } from '../common/machine-protocol';
import { GithubWorkspaceService } from '../github/github-workspace.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/** POST /runner/git-credential (docs/github-workspace-design.md §5.4). */
export class RunnerGitCredentialDto {
  @IsUUID()
  workspaceId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(400)
  path!: string;
}

/**
 * The credential helper on the runner's own git commands asking for a GitHub workspace's token (§5.4, §7). Only the
 * runner the workspace is on is answered, for that workspace's repository on github.com, and the answer is never
 * logged: the token lives in GithubWorkspaceService's memory and in this response, and nowhere else.
 */
@UseGuards(RunnerAuthGuard)
// The runner's own protocol: the workspace id is the UUID the clone request named, and nothing here reaches an agent.
@MachineProtocol()
@Controller('runner/git-credential')
export class RunnerGitCredentialController {
  constructor(private readonly github: GithubWorkspaceService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  credential(@CurrentRunner() runner: Runner, @Body() dto: RunnerGitCredentialDto) {
    return this.github.gitCredential(runner, dto);
  }
}
