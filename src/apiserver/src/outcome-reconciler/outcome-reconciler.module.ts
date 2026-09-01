import { Module } from '@nestjs/common';
import { OutcomeSurfaceService } from './outcome-surface.service';

@Module({
  providers: [OutcomeSurfaceService],
  exports: [OutcomeSurfaceService],
})
export class OutcomeReconcilerModule {}
