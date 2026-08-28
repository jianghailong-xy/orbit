import { Module } from '@nestjs/common';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';
import { ActionCapabilityRegistry, ActionExecutorService } from './action-executor.service';

@Module({
  providers: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    ActionCapabilityRegistry,
    ActionExecutorService,
  ],
  exports: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    ActionCapabilityRegistry,
    ActionExecutorService,
  ],
})
export class OutcomeReconcilerModule {}
