import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { isRunnerLinkCall } from '../common/runner-link-call';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The runner link's cut-over switch, RUNNER_LINK_REQUIRED (docs/runner-link-design.md §11.3, §11.4, decision D15;
 * migration 0446).
 *
 * An administrator turns it on to move the runners onto the link, and off again to bring them back: §11.4's first
 * rollback. Nothing is rebuilt or restarted (runner-link-required.controller.ts):
 *
 *   - While it is on, RunnerApiController's routes answer a call that comes over HTTPS 426 UPGRADE_REQUIRED
 *     (`upgradeRequired`), and the link gateway tells every runner MODE_LINK in its Welcome and HeartbeatAck (it reads
 *     the switch from GET /api/runner/link/mode). A runner that speaks the link (task B6) moves its daemon calls onto
 *     the link on either signal. An older one is told to run `orbit upgrade`.
 *   - Switched off, the routes serve HTTPS again and the gateway tells runners MODE_HTTP, which sends them back.
 *
 * What the switch never refuses:
 *   - a call the link gateway forwarded (runner-link-call.ts): that is the link itself;
 *   - a call that names its caller in X-Orbit-Runner-Caller. `orbit mcp`, the Antigravity approval hook and the CLI
 *     verbs share some of the daemon's routes (the approvals, the orchestration credential, `me`, a session's meta)
 *     and hold no link of their own. The daemon never sends the header, so a daemon too old to know the link is
 *     refused like any other;
 *   - the five routes marked StaysOnHttps: registration and the device flow, and the attachments (D14);
 *   - every other controller under /runner: the agent tool API, the link token, the release check (D14).
 *
 * Off, or never switched (no row), every request is served exactly as it was before the switch existed.
 */

/**
 * The header a process other than the runner daemon names itself in when it calls with the runner credential
 * (src/runner-go/transport.go, runnerCallerHeader): `mcp`, `antigravity-hook` or `cli`. Any value counts.
 */
export const RUNNER_CALLER_HEADER = 'x-orbit-runner-caller';

/** How long a replica answers the daemon routes from the switch it last read before it reads the row again. */
export const RUNNER_LINK_SWITCH_TTL_MS = 1_000;

/** 426 Upgrade Required, which Nest's HttpStatus does not name. */
export const UPGRADE_REQUIRED_STATUS = 426;

/** How often a replica that cannot read the switch says so. */
const READ_FAILURE_LOG_MS = 60_000;

const STAYS_ON_HTTPS = 'orbit:runner-link-stays-on-https';

/**
 * Marks a RunnerApiController route that is not part of the daemon protocol and stays on HTTPS after the cut-over
 * (docs/runner-link-design.md D14): registration and the device flow, which come before the runner holds a credential
 * to open a link with, and the attachments, which travel as multipart and raw bytes. The switch never refuses it.
 */
export const StaysOnHttps = () => SetMetadata(STAYS_ON_HTTPS, true);

/** Whether a route handler is marked StaysOnHttps. */
export function staysOnHttps(handler: object): boolean {
  return Reflect.getMetadata(STAYS_ON_HTTPS, handler) === true;
}

/**
 * What an HTTPS call to a daemon route is answered while the switch is on. B6's runner takes either the status or the
 * code as the server asking for the link (src/runner-go/link_mode.go, linkUpgradeRequired).
 */
export function upgradeRequired(): HttpException {
  return new HttpException(
    {
      code: 'UPGRADE_REQUIRED',
      message:
        'This server takes the runner daemon\'s calls only over the runner link now (RUNNER_LINK_REQUIRED is on), '
        + 'and this call came over HTTPS. Run `orbit upgrade` to update this runner, and check that its link mode is '
        + 'not turned off (ORBIT_LINK_MODE=off, or "linkMode": "off" in its config.json).',
      retryable: false,
    },
    UPGRADE_REQUIRED_STATUS,
  );
}

/** GET and PUT /api/admin/runner-link-required. */
export interface RunnerLinkSwitchView {
  required: boolean;
  /** When it was last switched; null while it never was. */
  updatedAt: Date | null;
  /** The administrator who switched it. */
  updatedById: string | null;
}

/**
 * Reads and switches RUNNER_LINK_REQUIRED. The daemon routes are answered from the state this replica last read,
 * which it reads again at most RUNNER_LINK_SWITCH_TTL_MS later (`required`); a switch takes effect at once on the
 * replica that wrote it, and within that interval on every other.
 */
@Injectable()
export class RunnerLinkSwitch {
  private readonly logger = new Logger(RunnerLinkSwitch.name);
  /** What this replica last read. Off until a read succeeds: a replica that never read the row serves as before. */
  private state = false;
  private readAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | undefined;
  private failureLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether the switch is on, as this replica read it at most RUNNER_LINK_SWITCH_TTL_MS ago. A read that fails keeps
   * what was read before it: a database that cannot be read switches nothing. It is tried again after the same
   * interval.
   */
  async required(): Promise<boolean> {
    if (Date.now() - this.readAt >= RUNNER_LINK_SWITCH_TTL_MS) {
      this.reading ??= this.refresh().finally(() => {
        this.reading = undefined;
      });
      await this.reading;
    }
    return this.state;
  }

  /** The switch as the row holds it now. A read that fails is thrown, never answered as off. */
  async read(): Promise<RunnerLinkSwitchView> {
    const row = await this.prisma.runnerLinkSwitch.findUnique({ where: { id: 1 } });
    this.remember(row?.required ?? false);
    return { required: row?.required ?? false, updatedAt: row?.updatedAt ?? null, updatedById: row?.updatedById ?? null };
  }

  /** Switch it, as `adminId`. Asking for the state it is already in writes nothing. Answered with what `read` answers. */
  async set(adminId: string, required: boolean): Promise<RunnerLinkSwitchView> {
    // One statement. No row reads as off, so turning it off writes only a row that is there to switch; a row already in
    // the state asked for is not rewritten, so it keeps when, and by whom, it really was switched.
    const switched = await this.prisma.$queryRaw<Array<{ required: boolean }>>`
      INSERT INTO "runner_link_switch" ("id", "required", "updated_at", "updated_by_id")
      SELECT 1, ${required}::boolean, now(), ${adminId}::uuid
       WHERE ${required}::boolean OR EXISTS (SELECT 1 FROM "runner_link_switch" WHERE "id" = 1)
      ON CONFLICT ("id") DO UPDATE
        SET "required" = EXCLUDED."required",
            "updated_at" = EXCLUDED."updated_at",
            "updated_by_id" = EXCLUDED."updated_by_id"
      WHERE "runner_link_switch"."required" IS DISTINCT FROM EXCLUDED."required"
      RETURNING "required"`;
    if (switched.length > 0) {
      this.logger.log(`RUNNER_LINK_REQUIRED switched ${required ? 'on' : 'off'} by administrator ${adminId}`);
    }
    return this.read();
  }

  private async refresh(): Promise<void> {
    try {
      const row = await this.prisma.runnerLinkSwitch.findUnique({ where: { id: 1 }, select: { required: true } });
      this.remember(row?.required ?? false);
    } catch (error) {
      const now = Date.now();
      this.readAt = now;
      if (now - this.failureLoggedAt >= READ_FAILURE_LOG_MS) {
        this.failureLoggedAt = now;
        this.logger.warn(
          `RUNNER_LINK_REQUIRED could not be read; this replica keeps answering as it last read it (${this.state ? 'on' : 'off'}): `
          + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  private remember(required: boolean): void {
    if (required !== this.state) {
      this.logger.log(
        required
          ? 'RUNNER_LINK_REQUIRED is on: the runner daemon\'s routes answer HTTPS 426 UPGRADE_REQUIRED'
          : 'RUNNER_LINK_REQUIRED is off: the runner daemon\'s routes serve HTTPS again',
      );
    }
    this.state = required;
    this.readAt = Date.now();
  }
}

/**
 * Refuses an HTTPS call to a daemon route while RUNNER_LINK_REQUIRED is on (the top of this file). It is on
 * RunnerApiController, and runs after the route's guards: a call the runner guard refuses is still answered 401 or 403.
 */
@Injectable()
export class RunnerLinkRequiredInterceptor implements NestInterceptor {
  constructor(
    /** Absent in the specs that build RunnerApiController by hand: nothing is refused, as with the switch off. */
    @Optional() private readonly linkSwitch?: RunnerLinkSwitch,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (this.linkSwitch && context.getType() === 'http' && !staysOnHttps(context.getHandler())) {
      const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
      if (!isRunnerLinkCall(req) && !namesItsCaller(req.headers) && (await this.linkSwitch.required())) {
        throw upgradeRequired();
      }
    }
    return next.handle();
  }
}

/** Whether a request names the process that sent it in X-Orbit-Runner-Caller: it is not the daemon. */
function namesItsCaller(headers: Record<string, string | string[] | undefined>): boolean {
  const value = headers[RUNNER_CALLER_HEADER];
  return (Array.isArray(value) ? value.join('') : (value ?? '')).trim() !== '';
}
