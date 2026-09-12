import { Module } from '@nestjs/common';

import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WatchDeliveryService } from './watch-delivery.service';

/**
 * The Watch delivery worker: one shared loop per replica that leases due deliveries and performs
 * them — a turn through SessionsService's queue entry point, or a push. PrismaService is global.
 */
@Module({
  imports: [SessionsModule, PushModule],
  providers: [WatchDeliveryService],
  exports: [WatchDeliveryService],
})
export class WatchDeliveryModule {}
