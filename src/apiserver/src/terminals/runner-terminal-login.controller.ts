import { Body, Controller, ForbiddenException, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { IsString } from 'class-validator';
import { CurrentRunner } from '../runner-api/current-runner.decorator';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { TerminalLoginService } from './terminal-login.service';

export class PollTerminalLoginDto {
  @IsString()
  deviceCode!: string;
}

/**
 * A terminal asking to be approved (docs/terminal-session-design.md, "The terminal credential"): `orbit` starts the
 * sign-in and polls for its credential with this machine's RUNNER credential, which is what binds the credential to
 * this runner and to its owner. Nothing here decides anything — the owner does, in the app.
 *
 * Refused to a request made on behalf of a session (`X-Orbit-Session-Id`): an agent acts as its session, and a
 * terminal is a person at this machine.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner/terminal-login')
export class RunnerTerminalLoginController {
  constructor(private readonly logins: TerminalLoginService) {}

  @Post('start')
  start(@CurrentRunner() runner: Runner, @Headers('x-orbit-session-id') actingSession?: string) {
    refuseSession(actingSession);
    return this.logins.start(runner);
  }

  @Post('poll')
  @HttpCode(200)
  poll(@CurrentRunner() runner: Runner, @Body() dto: PollTerminalLoginDto, @Headers('x-orbit-session-id') actingSession?: string) {
    refuseSession(actingSession);
    return this.logins.poll(runner, dto.deviceCode);
  }
}

function refuseSession(actingSession: string | undefined): void {
  if (!actingSession?.trim()) return;
  throw new ForbiddenException({
    code: 'TERMINAL_LOGIN_FROM_SESSION',
    message: 'A terminal signs in from your own terminal, not from inside an Orbit session',
  });
}
