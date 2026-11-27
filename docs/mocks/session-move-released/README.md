# Board: how a moved session reads once the move released it

[board.png](board.png) (source [board.html](board.html)). Decided by the owner on 2026-11-27 ("As suggested"): **① A, ② A**.

- ① A: a session a move released (`endReason` `moved`) reads exactly like an idle session that never moved, on every
  client: no Ended mark, its idle word and glyph, and no "Session ended…" line under the conversation. It stays released,
  so the next message resumes it.
- ② A: no line in the conversation about where it came from; the move's own toast is enough.

The original move board, [../session-move/03-move-workspace.png](../session-move/03-move-workspace.png), was redrawn the same
day: the confirmation's button is Move for an idle session too, and "The session ends first." is gone.
