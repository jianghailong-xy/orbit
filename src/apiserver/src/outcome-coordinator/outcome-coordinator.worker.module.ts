import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { OutcomeReconcilerModule } from '../outcome-reconciler/outcome-reconciler.module';
import { OutcomeWatchdogModule } from '../outcome-watchdog/outcome-watchdog.module';
import { CompletionAckCoordinatorResolver } from './completion-ack-coordinator.resolver';
import { CompletionAckOutcomeCoordinatorRunner } from './outcome-coordinator.runner';

/**
 * Standalone dependency graph for durable remediation delivery.
 *
 * Deliberately absent: AppModule, HTTP controllers, AutoRetryService, ReaperService and the
 * API-side CompletionAckObligationRouter. The process may create one fenced coordinator Session,
 * but it cannot run the API's periodic lifecycle loops or monitor its own detector.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    OutcomeReconcilerModule,
    OutcomeWatchdogModule,
  ],
  providers: [
    // Provide the background sender directly. Importing PushModule would also instantiate its
    // HTTP controller and JwtAuthGuard, contaminating this headless worker with a JwtService
    // dependency and making the independent process fail during Nest bootstrap.
    PushService,
    RealtimeService,
    QueueService,
    SessionsService,
    CoordinatorWakeService,
    CoordinatorJudgmentService,
    CompletionAckCoordinatorResolver,
    CompletionAckOutcomeCoordinatorRunner,
  ],
})
export class OutcomeCoordinatorWorkerModule {}
