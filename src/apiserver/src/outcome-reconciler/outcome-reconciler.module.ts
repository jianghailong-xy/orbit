import { Module } from '@nestjs/common';
import { ActionCapabilityRegistry, ActionExecutorService } from './action-executor.service';
import {
  OutcomeCoordinatorResolverRegistry,
  OutcomeCoordinatorService,
} from './outcome-coordinator.service';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';
import { OutcomeProjectionService } from './outcome-projection.service';
import { DeliveryAttestationService } from './delivery-attestation.service';

@Module({
  providers: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    DeliveryAttestationService,
    ActionCapabilityRegistry,
    ActionExecutorService,
    OutcomeCoordinatorResolverRegistry,
    OutcomeCoordinatorService,
  ],
  exports: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    DeliveryAttestationService,
    ActionCapabilityRegistry,
    ActionExecutorService,
    OutcomeCoordinatorResolverRegistry,
    OutcomeCoordinatorService,
  ],
})
export class OutcomeReconcilerModule {}
