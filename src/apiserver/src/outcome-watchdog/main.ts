import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { OutcomeWatchdogWorkerModule } from './outcome-watchdog.worker.module';

async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(OutcomeWatchdogWorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
}

void bootstrap();
