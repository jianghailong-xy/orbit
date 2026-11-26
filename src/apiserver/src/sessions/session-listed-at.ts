/**
 * `session.listed_at` (migration 1490): where a session sits in its owner's session list. `last_turn_at` is the
 * liveness clock — every persisted event, claim and state move rewrites it — so a list sorted by it reshuffled each
 * time a session waiting on CI printed a line. This one moves only when the session changes for its owner:
 *
 *  - it is created (the column default);
 *  - a person sends it a message: the owner's doors, a guest, a Feishu sender (`createTurn`/`resume`/`interrupt`
 *    with `listed`, which also marks the turn `by_person`);
 *  - a turn ends on the owner: any turn — a person's, a wake-up's, a notification's, another session's message, a
 *    task brief — answered with nothing queued behind it (AWAITING_INPUT at turn-complete; owner 2026-11-26: a new
 *    reply brings the row up), a permission card or question raised (runner `approvals`), an owner request filed;
 *  - it lands a merge (runner `merge-result`, merged);
 *  - it ends or is completed (the `session_listed_at_settle` trigger on status / completed_at).
 *
 * Streamed events, tool calls, background-job output, the arrival of a wake-up or notification turn, queue claims
 * and runner handshakes leave it alone.
 */
export {};
