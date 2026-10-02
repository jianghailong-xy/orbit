# TEMPORARY evidence probe — never merged

The iOS Move panel's second group, Move to Another Workspace (docs/session-folders-move-design.md
§4, §5.2–5.4): the owner's other workspaces as `GET /sessions/:id/move-targets` answers — open ones
with their brand mark and `<provider> · <runner>`, `Runner offline`, greyed ones with the server's
reason, the whole group greyed when the session itself can't leave — a workspace's page with its
folders and a sentence on the runner and the conversation, the `Move to <workspace>?` confirmation
with Move or End and Move, End and Move's progress, the `Moved to <workspace>` toast and the list
without the row.

This probe builds the iOS app's shared sources into a throwaway app — the real session list, as the
compact shell hosts it (`AgentContentColumn(rowNavigation: .push)` in a navigation stack, minus the
drawer), with the app's toast host — pointed (`-orbit.instance`) at `stub.py`: a fixture API with six
workspaces on four runners (one offline, one not upgraded, one workspace disabled), the list's
sessions (running, idle, a Codex one, completed ones), and the doors a move uses (`move-targets`,
`POST /sessions/:id/end` ending the session three seconds later — one session never ends —
`GET /sessions/:id`, `POST /sessions/:id/move` with a `workspaceId`, folders). UI tests swipe and tap
through it on the newest iPhone simulator and photograph each step; the stub logs every request.

Fixture titles are made up; nothing here is real data.
