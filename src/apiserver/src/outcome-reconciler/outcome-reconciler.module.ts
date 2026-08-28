import { Module } from '@nestjs/common';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';
import { OutcomeProjectionService } from './outcome-projection.service';

@Module({
  providers: [OutcomeFactIngressService, OutcomeEvaluatorService, OutcomeProjectionService],
  exports: [OutcomeFactIngressService, OutcomeEvaluatorService, OutcomeProjectionService],
})
export class OutcomeReconcilerModule {}
