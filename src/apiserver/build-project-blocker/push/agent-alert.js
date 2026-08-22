"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentAlert = agentAlert;
/**
 * Longest agent line worth pushing. A notification is a glance, not a transcript — the full text
 * stays in the session either way, and this is the one alert whose body is written by a model,
 * which will happily produce a paragraph. Wider than `settleAlert`'s 120-char error excerpt
 * because here the line IS the message rather than a hint at one.
 */
const MAX_BODY_CHARS = 200;
/**
 * Turn an agent's raw `notify` message into an alert body.
 *
 * Pure, so the edge cases are testable without Prisma or APNs, and separate from the delivery
 * decision (registered devices, the account's opt-out, the rate limit) which PushService owns.
 *
 * Whitespace is collapsed because a model writes for a transcript: a message with newlines and
 * indentation renders as one run-together line on a lock screen anyway, and collapsing it first is
 * what makes the truncation point mean something. Truncating rather than rejecting keeps a
 * too-long message from being silently worth nothing — the agent is told it was cut, and the
 * user still gets the first sentence, which is the part that decides whether they come look.
 */
function agentAlert(message) {
    const collapsed = message.replace(/\s+/g, ' ').trim();
    if (!collapsed)
        return null;
    if (collapsed.length <= MAX_BODY_CHARS)
        return { body: collapsed, truncated: false };
    return { body: `${collapsed.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…`, truncated: true };
}
//# sourceMappingURL=agent-alert.js.map