import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { HelpAsk } from './help-ask';
import { HelpAskController } from './help-ask.controller';
import { HelpAskRunnerFence, HelpAskSessions, RunnerHelpAskController } from './help-ask-reads';

/**
 * The help center's Ask (help-ask.ts): its own module because an Ask is made through SessionsService.create, as the
 * wiki chat's is (wiki-chat.module.ts), while the article library's module needs nothing of Sessions. The fence holds
 * an Ask's tools to its four reads on every runner door.
 */
@Module({
  imports: [SessionsModule, TasksModule],
  controllers: [HelpAskController, RunnerHelpAskController],
  providers: [HelpAsk, HelpAskSessions, HelpAskRunnerFence],
})
export class HelpAskModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HelpAskRunnerFence).forRoutes({ path: 'runner/*path', method: RequestMethod.ALL });
  }
}
