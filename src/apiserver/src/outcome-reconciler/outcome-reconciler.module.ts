import { Module } from '@nestjs/common';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';
import { OutcomeVersioningService } from './outcome-versioning.service';

@Module({
  providers: [OutcomeFactIngressService, OutcomeEvaluatorService, OutcomeVersioningService],
  exports: [OutcomeFactIngressService, OutcomeEvaluatorService, OutcomeVersioningService],
})
export class OutcomeReconcilerModule {}
