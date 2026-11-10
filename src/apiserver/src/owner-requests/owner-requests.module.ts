import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PushModule } from '../push/push.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { WatchDeliveryModule } from '../watches/watch-delivery.module';
import { AccountSecretsController } from './account-secrets.controller';
import { OwnerRequestsController } from './owner-requests.controller';
import { OwnerRequestsService } from './owner-requests.service';
import { OwnerSecretsService } from './owner-secrets.service';
import { SecretWriteDoorInterceptor } from './secret-write-door.interceptor';

@Module({
  imports: [PushModule, WatchDeliveryModule, RealtimeModule],
  controllers: [OwnerRequestsController, AccountSecretsController],
  // The write door is global: every runner-authenticated write is checked, a new route included.
  providers: [OwnerRequestsService, OwnerSecretsService, { provide: APP_INTERCEPTOR, useClass: SecretWriteDoorInterceptor }],
  exports: [OwnerRequestsService, OwnerSecretsService],
})
export class OwnerRequestsModule {}
