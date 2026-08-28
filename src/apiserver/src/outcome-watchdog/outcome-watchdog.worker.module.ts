import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { OutcomeWatchdogModule } from './outcome-watchdog.module';
import { OutcomeWatchdogRunner } from './outcome-watchdog.runner';

/** Standalone dependency graph: no AppModule and no OutcomeReconcilerModule. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, OutcomeWatchdogModule],
  providers: [OutcomeWatchdogRunner],
})
export class OutcomeWatchdogWorkerModule {}
