import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { Runner } from '@prisma/client';
import { PushService } from '../push/push.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The alert body is cut to a lock-screen line by `agentAlert` anyway; this bound is only so a
 * runaway generation can't post a megabyte to be thrown away, and is generous enough that no
 * message a person would want pushed is ever refused outright rather than trimmed.
 */
const MAX_MESSAGE_CHARS = 4000;

export class NotifyDto {
  @IsString()
  @MaxLength(MAX_MESSAGE_CHARS)
  message!: string;
}

/**
 * An agent's own push to the human it works for, reached by `orbit notify` and the `notify` MCP
 * tool. The recipient is the runner's owner — an agent can only ever ring the account it runs
 * for, never one it names — and the session comes from the same X-Orbit-Session-Id header the
 * task writes use (already decoded from base62 by the `publicIdHeaders` middleware), so the alert
 * carries that session's title and a tap lands in it.
 *
 * Deliberately NOT behind the orchestration gate the session_* routes use. Orchestration is the
 * authority to start and steer other runs; this is the authority to say one sentence to your own
 * owner, which every agent needs and which is bounded by PushService's rate limit rather than by
 * who you are. Gating it would leave exactly the ordinary single-session agents — the ones whose
 * work nobody is watching — with no way to ask for a human.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerNotifyController {
  constructor(private readonly push: PushService) {}

  @Post('notify')
  notify(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: NotifyDto,
  ) {
    return this.push.notifyAgentMessage({
      ownerId: runner.ownerId,
      sessionId: sessionId || undefined,
      fallbackTitle: runner.displayName || runner.name || 'Orbit',
      message: dto.message,
    });
  }
}
