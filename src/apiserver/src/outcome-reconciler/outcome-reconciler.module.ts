import { Module } from '@nestjs/common';
import {
  OutcomeCoordinatorResolverRegistry,
  OutcomeCoordinatorService,
} from './outcome-coordinator.service';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';
import { OutcomeProjectionService } from './outcome-projection.service';
import { DeliveryAttestationService } from './delivery-attestation.service';
import { OutcomeVersioningService } from './outcome-versioning.service';
import { OutcomeSurfaceService } from './outcome-surface.service';
import { ProjectAcceptanceModule } from '../projects/project-acceptance.module';

@Module({
  imports: [ProjectAcceptanceModule],
  providers: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    DeliveryAttestationService,
    OutcomeCoordinatorResolverRegistry,
    OutcomeCoordinatorService,
    OutcomeVersioningService,
    OutcomeSurfaceService,
  ],
  exports: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    DeliveryAttestationService,
    OutcomeCoordinatorResolverRegistry,
    OutcomeCoordinatorService,
    OutcomeVersioningService,
    OutcomeSurfaceService,
  ],
})
export class OutcomeReconcilerModule {}
