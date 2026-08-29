import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutcomeReconcilerModule } from './outcome-reconciler.module';
import { OutcomeSurfacesController } from './outcome-surfaces.controller';

/**
 * HTTP-only adapter graph for the canonical outcome services.
 *
 * The persistent coordinator imports OutcomeReconcilerModule in a standalone process. Keeping the
 * JWT-guarded controller here prevents that worker from acquiring an unrelated HTTP/JWT startup
 * dependency while the API still receives the exact same authenticated routes.
 */
@Module({
  imports: [AuthModule, OutcomeReconcilerModule],
  controllers: [OutcomeSurfacesController],
})
export class OutcomeReconcilerHttpModule {}
