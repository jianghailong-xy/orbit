import { Controller, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import { AllowQueryToken } from '../auth/allow-query-token.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { untilStopping } from '../common/graceful-stop';
import { declaresDriveChanged, declaresDriveSyncs, declaresListChanged, declaresListScopes, declaresOwnerRequests, declaresScheduleCards } from '../realtime/open-list-hints';
import { RealtimeService } from '../realtime/realtime.service';

/** ~20s keepalive (decision Q5): its job is to let the CLIENT's byte watchdog detect a half-dead
 *  connection quickly — the gateway's 3600s read timeout never needs it. Nest's SSE abstraction
 *  can't emit raw `:` comment frames, so the ping is a data frame clients discard by type; the
 *  bytes still feed the watchdog, which is the point. */
const KEEPALIVE_MS = 20_000;

/**
 * The user-scoped control-plane stream: `GET /api/events` pushes coarse lifecycle / status /
 * approval / background events for ALL of the caller's sessions over one always-on SSE
 * connection, so clients drive lists, badges and notifications from push instead of polling.
 * No `sinceSeq` replay — a (re)connecting client rebuilds from one REST list snapshot and then
 * follows (see docs/realtime-control-plane-stream.md §4.5). Sibling of the per-session
 * data-plane stream in SessionsController (`GET /sessions/:id/events`).
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private readonly realtime: RealtimeService) {}

  @AllowQueryToken() // browser EventSource can't set headers; native clients use Authorization
  @PatScope('events:read', { workspaceConfinable: false })
  @Sse('events')
  events(
    @CurrentUser() user: AuthUser,
    // The hints this client understands, comma-separated (docs/realtime-control-plane-stream.md
    // §4.8). The stream uses opt-ins for `list_changed`, `owner_requests`, `schedule_cards`, `drive_changed` and `drive_syncs`
    // because shipped clients re-read everything on unknown event types. `list_scopes` adds
    // `scopes` to `sessions.list_changed` when that event is enabled.
    @Query('hints') hints?: string | string[],
  ): Observable<MessageEvent> {
    // Ends as this apiserver stops, so the client opens it again on another (common/graceful-stop.ts).
    return merge(
      this.realtime.streamForUser(user.userId, {
        listChanged: declaresListChanged(hints),
        listScopes: declaresListScopes(hints),
        ownerRequests: declaresOwnerRequests(hints),
        driveChanged: declaresDriveChanged(hints),
        driveSyncs: declaresDriveSyncs(hints),
        scheduleCards: declaresScheduleCards(hints),
      }).pipe(map((e) => ({ data: e }) as MessageEvent)),
      interval(KEEPALIVE_MS).pipe(map(() => ({ data: { type: 'ping' } }) as MessageEvent)),
    ).pipe(untilStopping());
  }
}
