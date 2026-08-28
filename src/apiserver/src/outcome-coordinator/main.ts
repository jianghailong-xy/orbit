import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { OutcomeCoordinatorWorkerModule } from './outcome-coordinator.worker.module';

async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(OutcomeCoordinatorWorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
}

void bootstrap();
