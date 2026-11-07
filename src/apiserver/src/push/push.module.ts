import { Module, forwardRef } from '@nestjs/common';
import { FeishuModule } from '../feishu/feishu.module';
import { FeishuTransport } from './feishu-transport';
import { PushController } from './push.controller';
import { PushService } from './push.service';

/** Push: device-token registration (PushController) + the sender (PushService), which other modules (runner-api)
 *  import to notify a session owner when an approval is created. Three transports: APNs and FCM to devices, and
 *  FeishuTransport to the owner of the account's own Feishu app (docs/feishu-bot-design.md §6.1). */
@Module({
  // forwardRef: FeishuModule imports this one back, for PushService.needsYouSessions (feishu/feishu-direct.service.ts).
  imports: [forwardRef(() => FeishuModule)],
  controllers: [PushController],
  providers: [PushService, FeishuTransport],
  exports: [PushService],
})
export class PushModule {}
