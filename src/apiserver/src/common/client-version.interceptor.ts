import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './current-user.decorator';

/**
 * Record which build of which client each request came from (`X-Orbit-Client: web/0.1.114`).
 *
 * The question this exists to answer is "is anything still in the field older than X?", asked
 * whenever a wire format has to change. Today that question has no answer for anything but
 * runners: `WorkspaceAliasInterceptor` next to this one is a shim whose comment says to delete it
 * once every client speaks the new name, and it is still running because nobody can tell whether
 * that is true. See docs/public-id-migration-design.md §6.
 *
 * An interceptor, not middleware: middleware runs before the guards, where `req.user` does not
 * exist yet, and an unattributed version tells you nothing about whose client is stale.
 *
 * Three rules, all of them about never being worth an incident:
 *  - It cannot fail a request. A malformed header is ignored rather than 400'd (a header is
 *    telemetry, not a contract), and the write is fire-and-forget.
 *  - It cannot flood the database. One row per (user, kind) is rewritten at most hourly while the
 *    version is unchanged, so a client polling every 4s still writes once an hour.
 *  - It cannot grow without bound. The throttle map is capped and dropped wholesale when full;
 *    losing it costs one extra upsert per active client, which is the cheap direction to fail in.
 */
const HEADER = 'x-orbit-client';

/** Runners are absent on purpose: `Runner.version` already carries theirs, reported on every
 *  heartbeat. Two sources of truth for one fact is how they end up disagreeing. */
const KINDS = new Set(['web', 'ios', 'macos']);

/** Anything a real build number is made of. Bounded so a junk header can't store a novel. */
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

const WRITE_EVERY_MS = 60 * 60 * 1000;
const MAX_TRACKED = 20_000;

@Injectable()
export class ClientVersionInterceptor implements NestInterceptor {
  private readonly lastWrite = new Map<string, { version: string; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    this.record(context.switchToHttp().getRequest());
    return next.handle();
  }

  private record(req: { headers?: Record<string, unknown>; user?: AuthUser } | undefined): void {
    const userId = req?.user?.userId;
    const raw = req?.headers?.[HEADER];
    if (!userId || typeof raw !== 'string') return;

    const slash = raw.indexOf('/');
    if (slash < 0) return;
    const kind = raw.slice(0, slash);
    const version = raw.slice(slash + 1);
    if (!KINDS.has(kind) || !VERSION_RE.test(version)) return;

    const key = `${userId}:${kind}`;
    const seen = this.lastWrite.get(key);
    const now = Date.now();
    if (seen && seen.version === version && now - seen.at < WRITE_EVERY_MS) return;

    if (this.lastWrite.size >= MAX_TRACKED) this.lastWrite.clear();
    this.lastWrite.set(key, { version, at: now });

    void this.prisma.clientVersion
      .upsert({
        where: { userId_kind: { userId, kind } },
        create: { userId, kind, version },
        update: { version },
      })
      // Undo the throttle entry so the next request retries. Without this a single failed write
      // (a restart mid-query, a brief pool exhaustion) would silently blind this client for an
      // hour — and the whole point of the table is that the gaps in it are load-bearing.
      .catch(() => this.lastWrite.delete(key));
  }
}
