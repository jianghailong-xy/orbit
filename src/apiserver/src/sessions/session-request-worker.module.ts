import { Module } from '@nestjs/common';

import { SessionsModule } from './sessions.module';
import { SessionRequestWorker } from './session-request.worker';

/**
 * The session request worker: one loop per replica that expires requests past their deadline and
 * hands back the outcomes nothing else handed back (session-request.worker.ts). Its own module, as the
 * scheduled-wakeup worker's is, so a harness that imports SessionsModule does not start a clock.
 */
@Module({
  imports: [SessionsModule],
  providers: [SessionRequestWorker],
  exports: [SessionRequestWorker],
})
export class SessionRequestWorkerModule {}
