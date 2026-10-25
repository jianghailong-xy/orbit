/**
 * Whether a request is a runner link call: one the link gateway forwards, on behalf of a runner
 * connected to it, over the apiserver's internal listener (docs/runner-link-design.md §5.6, §6.4;
 * runner-api/runner-link-call.ts opens the listener and says what a link call may carry).
 *
 * The mark is a symbol the internal listener sets on the request before the app sees it. It is
 * not a header, so nothing that arrives on the public listener can claim to be a link call: the
 * answers a link call gets (no long poll, the link's error envelope) stay the link's, and every
 * HTTPS request is served exactly as it was before the link existed.
 *
 * Here rather than beside the listener because the error boundary in this directory reads it too.
 */
const RUNNER_LINK_CALL = Symbol('orbit.runnerLinkCall');

/** Marks a request the internal listener accepted from the link gateway. */
export function markRunnerLinkCall(request: object): void {
  (request as Record<symbol, unknown>)[RUNNER_LINK_CALL] = true;
}

/** Whether the internal listener marked this request. */
export function isRunnerLinkCall(request: unknown): boolean {
  return (
    request !== null
    && typeof request === 'object'
    && (request as Record<symbol, unknown>)[RUNNER_LINK_CALL] === true
  );
}
