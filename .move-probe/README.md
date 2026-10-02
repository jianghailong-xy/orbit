# TEMPORARY evidence probe — never merged

The iOS session list's rows now swipe left to Share · Move · Delete (Delete outermost, no full swipe),
and their long-press menu has Move… after Share…. Move opens the Move panel, a sheet the list holds
(`AgentPanes.movingSession` → `SessionMoveSheet`): No Folder, the workspace's folders with their
counts, and New Folder…. A tap files the session at once and the toast says where it went. Trash has
none of it; macOS has none of it.

This probe builds the iOS app's shared sources into a throwaway app whose only screen is the real
session list — `AgentContentColumn(rowNavigation: .push)` in a navigation stack, as the compact shell
hosts it, minus the drawer, with the app's toast host — pointed (`-orbit.instance`) at `stub.py`, a
fixture API: one workspace, its Open / Completed / Trash sessions, its folders, and the folder doors
(`GET`/`POST /session-folders`, `POST /sessions/:id/move`, a duplicate name answered 409). A UI test
swipes, long-presses and taps through it on the newest iPhone simulator and photographs each step; the
stub logs every request, so the run shows which move each tap asked for.

Fixture titles are made up; nothing here is real data.
