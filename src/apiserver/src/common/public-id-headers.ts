import { NextFunction, Request, Response } from 'express';
import { toUuid } from '@orbit/shared';

/**
 * The third position an id arrives in, after params/queries (`PublicIdPipe`) and bodies
 * (`IsPublicId`): the session-context headers `orbit mcp` and the `orbit` CLI attach to every
 * call they make.
 *
 * They come from the runner's own environment (`ORBIT_SESSION_ID` / `ORBIT_AGENT_ID`), which is
 * now spelled base62 like everything else a model can see — so the same rule has to apply here or
 * an agent's every write arrives unattributed. The failures are silent in both directions:
 * `X-Orbit-Workspace-Id` lands in `resolveAgentCreator`'s `where: { id }` and a miss is a 403
 * "workspace not found"; `X-Orbit-Session-Id` is compared byte-for-byte against the orchestration
 * token's `sub` (`RunnerOrchestrationAuthorizer.assert`) and a mismatch is a 403 on a credential
 * that is in fact valid.
 *
 * WHY THIS ONE IS GLOBAL when the rule is declared per-field everywhere else: the objection to
 * inferring from a name is that the wire is full of id-shaped fields that are not addresses
 * (`clientTurnId`, `toolUseId`, `bundleId`…). Headers are not that wire — this list is three
 * names long, closed, and ours. Naming them here is the declaration; the alternative is the same
 * declaration repeated at ~25 `@Headers()` parameters, which is 25 chances to add the 26th route
 * without it. `X-Orbit-Session-Token` is deliberately absent: it is a JWT, not an id.
 *
 * Runs as middleware rather than a pipe because guards see headers before handler parameters are
 * resolved, so normalizing later would leave a second spelling reachable from a guard.
 */
const ID_HEADERS = ['x-orbit-session-id', 'x-orbit-workspace-id', 'x-orbit-agent-id'] as const;

export function publicIdHeaders(req: Request, _res: Response, next: NextFunction): void {
  for (const name of ID_HEADERS) {
    const value = req.headers[name];
    // Undecodable is left exactly as it arrived: this is not the place that judges an id. The
    // handler's own lookup misses and answers with its own error, the same as it always did.
    if (typeof value !== 'string' || value === '') continue;
    try {
      req.headers[name] = toUuid(value);
    } catch {
      /* not an id we can spell — leave it for the handler to reject */
    }
  }
  next();
}
