import { Module } from '@nestjs/common';
import { ActionCapabilityRegistry, ActionExecutorService } from './action-executor.service';
import {
  OutcomeCoordinatorResolverRegistry,
  OutcomeCoordinatorService,
} from './outcome-coordinator.service';
import { OutcomeEvaluatorService } from './outcome-evaluator.service';
import { OutcomeFactIngressService } from './outcome-fact-ingress.service';
import { OutcomeProjectionService } from './outcome-projection.service';
import { OutcomeVersioningService } from './outcome-versioning.service';
import { OutcomeSurfaceService } from './outcome-surface.service';
import { OutcomeSurfacesController } from './outcome-surfaces.controller';
import { ProjectAcceptanceModule } from '../projects/project-acceptance.module';

@Module({
  imports: [ProjectAcceptanceModule],
  controllers: [OutcomeSurfacesController],
  providers: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    ActionCapabilityRegistry,
    ActionExecutorService,
    OutcomeCoordinatorResolverRegistry,
    OutcomeCoordinatorService,
    OutcomeVersioningService,
    OutcomeSurfaceService,
  ],
  exports: [
    OutcomeFactIngressService,
    OutcomeEvaluatorService,
    OutcomeProjectionService,
    ActionCapabilityRegistry,
    ActionExecutorService,
    OutcomeCoordinatorResolverRegistry,
    OutcomeCoordinatorService,
    OutcomeVersioningService,
    OutcomeSurfaceService,
  ],
})
export class OutcomeReconcilerModule {}
