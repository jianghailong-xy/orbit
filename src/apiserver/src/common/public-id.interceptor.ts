import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { MACHINE_PROTOCOL } from './machine-protocol';
import { addTwins, rememberBoundary } from './public-id-body';

/**
 * Serve every public id in both spellings on the value a handler RETURNS. `public-id-body.ts`
 * holds the mapping itself and the reasoning behind it; `PublicIdExceptionFilter` applies the same
 * mapping to the value a handler THROWS.
 *
 * The one boundary that is NOT the public id's: the machine protocol.
 *
 * Everywhere else, `id` is the public id, unconditionally — no header, no negotiation, one
 * spelling. `@MachineProtocol()` marks the exception and says why; see that decorator for the
 * reasoning, and for why the test is per-controller and not per-path.
 *
 * It used to be per-path (`/api/runner/*`), which swept in the agent-facing half of the runner
 * API by accident: `orbit mcp` and the `orbit` CLI hand those response bodies straight to a model
 * or onto stdout, so every task and session a model saw was named by a raw UUID — the one place
 * the migration was supposed to have removed them from. The prefix was never the boundary; the
 * keying was.
 */
@Injectable()
export class PublicIdInterceptor implements NestInterceptor {
  private readonly reflector = new Reflector();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // getClass() only, not getHandler(): keying is a property of the whole protocol, and a
    // per-route opt-out is exactly the kind of thing that gets forgotten on the next route added.
    const replaceSource = !this.reflector.get<boolean>(MACHINE_PROTOCOL, context.getClass());
    // This stage is the last one that knows the controller class. Write the answer down for the
    // exception filter, which does not get one — see `rememberBoundary`.
    rememberBoundary(context, replaceSource);
    return next.handle().pipe(map((body) => addTwins(body, replaceSource)));
  }
}
