import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { isRunnerLinkCall } from '../common/runner-link-call';

/**
 * The runner daemon's routes take its calls over the runner link alone (docs/runner-link-design.md §4, §13, decisions
 * D4, D13): RunnerApiController's routes answer a call that comes over HTTPS 426 UPGRADE_REQUIRED (`upgradeRequired`).
 * Their handlers are the link's: the link gateway forwards each call to the same route, over the apiserver's internal
 * listener. The refusal itself reads nothing and decides nothing else.
 *
 * What is never refused:
 *   - a call the link gateway forwarded (runner-link-call.ts): that is the link itself;
 *   - a call that names its caller in X-Orbit-Runner-Caller, on the eight routes marked CalledByNamedCallers. `orbit
 *     mcp`, the Antigravity approval hook and the CLI verbs share those of the daemon's routes (the approvals, the
 *     scheduled wakeup, the orchestration credential, `me`, `deregister`, a session's meta and events) and hold no link
 *     of their own. The daemon never sends the header, so a daemon too old to know the link is refused like any other.
 *     On any other route the header changes nothing;
 *   - the seven routes marked StaysOnHttps: registration and the device flow, the uploads and downloads (D14), and the
 *     Claude region check, which has to leave through Claude's proxy (docs/claude-region-check-contract.md §3);
 *   - every other controller under /runner: the agent tool API, the link token, the release check (D14).
 */

/**
 * The header a process other than the runner daemon names itself in when it calls with the runner credential
 * (src/runner-go/transport.go, runnerCallerHeader): `mcp`, `antigravity-hook` or `cli`. Any value counts.
 */
export const RUNNER_CALLER_HEADER = 'x-orbit-runner-caller';

/** 426 Upgrade Required, which Nest's HttpStatus does not name. */
export const UPGRADE_REQUIRED_STATUS = 426;

const STAYS_ON_HTTPS = 'orbit:runner-link-stays-on-https';

/**
 * Marks a RunnerApiController route that is not part of the daemon protocol and stays on HTTPS (docs/runner-link-design.md
 * D14): registration and the device flow, which come before the runner holds a credential to open a link with, the
 * attachments, which travel as multipart and raw bytes, and the Claude region check, whose request is the measurement
 * of Claude's own connection.
 */
export const StaysOnHttps = () => SetMetadata(STAYS_ON_HTTPS, true);

/** Whether a route handler is marked StaysOnHttps. */
export function staysOnHttps(handler: object): boolean {
  return Reflect.getMetadata(STAYS_ON_HTTPS, handler) === true;
}

const CALLED_BY_NAMED_CALLERS = 'orbit:runner-link-called-by-named-callers';

/**
 * Marks a daemon route that a process other than the daemon calls too, naming itself in X-Orbit-Runner-Caller
 * (src/runner-go/transport.go, newCallerTransport): over HTTPS it serves those calls alone.
 */
export const CalledByNamedCallers = () => SetMetadata(CALLED_BY_NAMED_CALLERS, true);

/** Whether a route handler is marked CalledByNamedCallers. */
export function calledByNamedCallers(handler: object): boolean {
  return Reflect.getMetadata(CALLED_BY_NAMED_CALLERS, handler) === true;
}

/**
 * What an HTTPS call to a daemon route is answered, and a call to a route of the daemon's that is gone. A runner that
 * speaks the link takes either the status or the code as the server asking for it (0.1.246's src/runner-go/link_mode.go,
 * linkUpgradeRequired).
 */
export function upgradeRequired(): HttpException {
  return new HttpException(
    {
      code: 'UPGRADE_REQUIRED',
      message:
        'This server takes the runner daemon\'s calls only over the runner link. '
        + 'Run `orbit upgrade` to update this runner.',
      retryable: false,
    },
    UPGRADE_REQUIRED_STATUS,
  );
}

/**
 * Refuses an HTTPS call to a daemon route. It is on RunnerApiController, and runs after the route's guards: a call the
 * runner guard refuses is still answered 401 or 403.
 */
@Injectable()
export class RunnerLinkRequiredInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler();
    if (context.getType() === 'http' && !staysOnHttps(handler)) {
      const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
      if (!isRunnerLinkCall(req) && !(calledByNamedCallers(handler) && namesItsCaller(req.headers))) throw upgradeRequired();
    }
    return next.handle();
  }
}

/** Whether a request names the process that sent it in X-Orbit-Runner-Caller: it is not the daemon. */
function namesItsCaller(headers: Record<string, string | string[] | undefined>): boolean {
  const value = headers[RUNNER_CALLER_HEADER];
  return (Array.isArray(value) ? value.join('') : (value ?? '')).trim() !== '';
}
