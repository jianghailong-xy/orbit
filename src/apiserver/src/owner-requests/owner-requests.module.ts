import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { WatchDeliveryModule } from '../watches/watch-delivery.module';
import { OwnerRequestsController } from './owner-requests.controller';
import { OwnerRequestsService } from './owner-requests.service';

@Module({
  imports: [PushModule, WatchDeliveryModule],
  controllers: [OwnerRequestsController],
  providers: [OwnerRequestsService],
  exports: [OwnerRequestsService],
})
export class OwnerRequestsModule {}
