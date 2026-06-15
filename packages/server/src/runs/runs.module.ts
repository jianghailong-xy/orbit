import { Module } from '@nestjs/common';
import { RunsController } from './runs.controller';

@Module({
  controllers: [RunsController],
})
export class RunsModule {}
