# Phase 0 — Empirical verification of Claude CLI streaming-input (Route B)

Verified against the real binary: **claude 2.1.178 (Claude Code)**, logged-in session auth.
All probes ran `claude -p --input-format stream-json --output-format stream-json` variants.
Result: **every load-bearing assumption of the Route B design holds.** A few refinements below.

## Confirmed

| # | Question | Result |
|---|----------|--------|
| a | Persistent multi-turn over stdin | ✅ Process stays alive after each turn's `result`, processes the next stdin user message, and exits `code 0` only on stdin **EOF**. A `result` is emitted per turn. **This is the linchpin — Route B is viable.** |
| b | `--session-id <uuid>` honored | ✅ The supplied UUID is used and echoed on every `system:init` (`session_id` matches). Server can pre-generate `sessionUuid` and pass it. |
| c | Crash + `--resume` recovery | ✅ After a hard `SIGKILL` right after turn 1, `claude --resume <session-id>` restored full context (recalled the secret word). A restarted runner can reattach + resume. |
| d | Mid-turn stdin | ✅ A second user message sent while a turn is generating is **buffered and processed FIFO after** the current turn — not interleaved, not rejected, no corruption. It does **not** redirect the in-flight turn. |
| e | `--replay-user-messages` | ✅ Each accepted user message is echoed back as a `type:"user"` event (emitted when that turn starts processing). Usable as the canonical user-turn transcript event. |
| f | Interrupt | ✅ `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` → `{"type":"control_response","response":{"subtype":"success",…}}`. The current turn aborts with `result.subtype="error_during_execution"` (`is_error:true`, `stop_reason:null`), and **the process survives** for the next turn. |

Event shapes (one-shot + streaming): `system:init` (carries `session_id`), `system:status`, `assistant` (text/tool_use), `result` (carries `result` text, `subtype`, `num_turns`, `usage`, `total_cost_usd`, `session_id`), plus `rate_limit_event`, and `user` (when `--replay-user-messages`).

## Refinements the design must incorporate

1. **`system:init` is emitted at the START OF EACH TURN**, not once per process. The runner's per-session `seq` counter must stay continuous across these, and the apiserver must tolerate multiple `system:init` events within one run. Capture/confirm `session_id` from the first one.
2. **`--max-turns` is a PROCESS-WIDE budget** (each turn's `result.num_turns` resets to 1, but the cap accumulates across stdin turns). For a long-lived interactive session a small `--max-turns` would silently brick later turns. → For interactive: omit `--max-turns` (or set very high) and enforce per-turn/session limits at the app layer (ConversationTurn accounting + a server-side budget kill). Same caveat for `--max-budget-usd`.
3. **Interrupt → `error_during_execution`.** The runner sent the interrupt, so it must correlate this `result` to "turn interrupted" (map to `INTERRUPTED`), NOT a session-fatal error. Keep the process alive and park in `AWAITING_INPUT`.
4. **Per-turn cost/usage is available** in each `result` (`total_cost_usd`, `usage`) → the design's per-turn `ConversationTurn` accounting is feasible directly from the turn's `result`.
5. **Server-side 409-while-RUNNING is now a CHOICE, not a requirement** (finding d). claude safely queues mid-turn messages. v1 can still serialize at the server for clean cancel/interrupt control, but correctness no longer depends on it.
6. **Use control_request interrupt, never SIGINT** for stopping a turn — SIGINT would tear down the whole long-lived session.

## Input wire formats (verified)
- User turn: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}\n`
- Interrupt: `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}\n`

## Reproduce
Canonical persistent invocation used:
`claude -p --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages --verbose --session-id <uuid>`
Probe harnesses (multi-turn, resume-after-kill, mid-turn, interrupt) were run ad hoc; the wire formats above are sufficient to rebuild them.
