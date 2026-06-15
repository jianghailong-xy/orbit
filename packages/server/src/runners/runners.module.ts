import { Module } from '@nestjs/common';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

@Module({
  controllers: [RunnersController],
  providers: [RunnersService],
})
export class RunnersModule {}
