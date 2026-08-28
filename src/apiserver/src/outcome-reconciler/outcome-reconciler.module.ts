import { Module } from '@nestjs/common';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';

@Module({
  providers: [OutcomeFactIngressService, OutcomeEvaluatorService],
  exports: [OutcomeFactIngressService, OutcomeEvaluatorService],
})
export class OutcomeReconcilerModule {}
