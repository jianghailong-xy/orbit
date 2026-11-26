import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { HelpAsk } from './help-ask';
import { HelpAskController } from './help-ask.controller';
import { HelpAskRunnerFence, HelpAskSessions, RunnerHelpAskController } from './help-ask-reads';
import { HelpModule } from './help.module';

/**
 * The help center's Ask (help-ask.ts), answered on the server's DeepSeek key from the article library (HelpModule) and
 * the account reads; Ask your admin makes a task (TasksModule). The runner doors and the fence serve the session-based
 * Asks made before migration 1668: the fence holds such an Ask's tools to its four reads on every runner door.
 */
@Module({
  imports: [HelpModule, TasksModule],
  controllers: [HelpAskController, RunnerHelpAskController],
  providers: [HelpAsk, HelpAskSessions, HelpAskRunnerFence],
})
export class HelpAskModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HelpAskRunnerFence).forRoutes({ path: 'runner/*path', method: RequestMethod.ALL });
  }
}
