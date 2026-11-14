import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { RunnerTerminalLoginController } from './runner-terminal-login.controller';
import { TerminalLoginService } from './terminal-login.service';
import { TerminalsController } from './terminals.controller';

/**
 * The TERMINAL credential's sign-in and management (docs/terminal-session-design.md). Verifying one on a request is
 * AuthModule's (auth/terminal-credentials.ts), for JwtAuthGuard; this is where one is asked for, approved, listed and
 * revoked. PushModule for the approve card's push; RealtimeService and PrismaService are global.
 */
@Module({
  imports: [PushModule],
  controllers: [TerminalsController, RunnerTerminalLoginController],
  providers: [TerminalLoginService],
})
export class TerminalsModule {}
