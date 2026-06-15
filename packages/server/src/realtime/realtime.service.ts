import { Injectable } from '@nestjs/common';
import { NormalizedRunEvent } from '@orbit/shared';
import { Observable, Subject, filter, map } from 'rxjs';

/**
 * In-memory hub: runner-API writes events here, the SSE endpoint subscribes.
 * Also tracks cancellation requests delivered to runners via heartbeat.
 * (Single-process for v1; swap for Postgres LISTEN/NOTIFY or Redis to scale out.)
 */
@Injectable()
export class RealtimeService {
  private readonly hub = new Subject<{ runId: string; event: NormalizedRunEvent }>();
  private readonly cancellations = new Map<string, Set<string>>(); // runnerId -> runIds

  publish(runId: string, event: NormalizedRunEvent): void {
    this.hub.next({ runId, event });
  }

  streamForRun(runId: string): Observable<NormalizedRunEvent> {
    return this.hub.asObservable().pipe(
      filter((m) => m.runId === runId),
      map((m) => m.event),
    );
  }

  requestCancel(runnerId: string, runId: string): void {
    let set = this.cancellations.get(runnerId);
    if (!set) {
      set = new Set();
      this.cancellations.set(runnerId, set);
    }
    set.add(runId);
  }

  drainCancellations(runnerId: string): string[] {
    const set = this.cancellations.get(runnerId);
    if (!set || set.size === 0) return [];
    const ids = [...set];
    set.clear();
    return ids;
  }
}
