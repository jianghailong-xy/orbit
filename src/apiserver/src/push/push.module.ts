import { Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { PushService } from './push.service';

/** APNs push: device-token registration (PushController) + the sender (PushService), which other
 *  modules (runner-api) import to notify a session owner when an approval is created. */
@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
