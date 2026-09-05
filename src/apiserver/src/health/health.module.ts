import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** No providers: the answer is a constant, so there is nothing to inject. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
