import { Module } from '@nestjs/common';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';

@Module({
  controllers: [RunnerApiController],
  providers: [RunnerAuthGuard],
})
export class RunnerApiModule {}
