import { Module } from '@nestjs/common';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';
import { OutcomeProjectionService } from './outcome-projection.service';
import { ActionCapabilityRegistry, ActionExecutorService } from './action-executor.service';
import { DeliveryAttestationService } from './delivery-attestation.service';

@Module({
  providers: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    DeliveryAttestationService,
    ActionCapabilityRegistry,
    ActionExecutorService,
  ],
  exports: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    DeliveryAttestationService,
    ActionCapabilityRegistry,
    ActionExecutorService,
  ],
})
export class OutcomeReconcilerModule {}
