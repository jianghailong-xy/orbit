import { Body, ConflictException, Controller, HttpCode, HttpStatus, Optional, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { MachineProtocol } from '../common/machine-protocol';
import { GithubWorkspaceService } from '../github/github-workspace.service';
import { PushAsMeService } from '../github/push-as-me.service';
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

  /** docs/design/protected-branch-landing.md §5.2: the owner's own token, for one landing's target push. */
  @IsOptional() @IsIn(['PUSH_AS_ME'])
  purpose?: 'PUSH_AS_ME';

  @IsOptional() @IsUUID()
  jobId?: string;

  @IsOptional() @IsString() @Matches(/^[0-9]{1,18}$/)
  claimGeneration?: string;

  @IsOptional() @IsString() @MaxLength(64)
  leaseOwner?: string;

  @IsOptional() @IsUUID()
  sessionId?: string;

  @IsOptional() @IsUUID()
  mergeOperationId?: string;
}

/**
 * The credential helper on the runner's own git commands asking for a GitHub workspace's token (§5.4, §7). Only the
 * runner the workspace is on is answered, for that workspace's repository on github.com, and the answer is never
 * logged: the token lives in GithubWorkspaceService's memory and in this response, and nowhere else. With
 * `purpose: 'PUSH_AS_ME'`, the owner's own token for one landing's push, under PushAsMeService's rules
 * (docs/design/protected-branch-landing.md §5.2); without it, unchanged.
 */
@UseGuards(RunnerAuthGuard)
// The runner's own protocol: the workspace id is the UUID the clone request named, and nothing here reaches an agent.
@MachineProtocol()
@Controller('runner/git-credential')
export class RunnerGitCredentialController {
  constructor(
    private readonly github: GithubWorkspaceService,
    @Optional() private readonly pushAsMe?: PushAsMeService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  credential(@CurrentRunner() runner: Runner, @Body() dto: RunnerGitCredentialDto) {
    if (dto.purpose === 'PUSH_AS_ME') {
      if (!this.pushAsMe) throw new ConflictException({ code: 'PUSH_AS_ME_REFUSED', message: 'This Orbit cannot answer your GitHub token.' });
      return this.pushAsMe.ownerCredential(runner, dto);
    }
    return this.github.gitCredential(runner, { workspaceId: dto.workspaceId, host: dto.host, path: dto.path });
  }
}
