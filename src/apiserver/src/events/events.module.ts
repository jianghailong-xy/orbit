import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { EventsController } from './events.controller';

/** Hosts the user-scoped control-plane SSE endpoint (`GET /api/events`). */
@Module({
  imports: [RealtimeModule],
  controllers: [EventsController],
})
export class EventsModule {}
