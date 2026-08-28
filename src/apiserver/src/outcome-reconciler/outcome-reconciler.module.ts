import { Module } from '@nestjs/common';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';

@Module({
  providers: [OutcomeFactIngressService],
  exports: [OutcomeFactIngressService],
})
export class OutcomeReconcilerModule {}
