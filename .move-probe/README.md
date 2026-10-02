# TEMPORARY evidence probe — never merged

The iOS session list's rows swipe left to Share · Move · Delete and their long-press menu has Move…
(docs/session-folders-move-design.md §2, §4); a workspace's folders lead its Open and Completed list
as rows that report for the sessions they hide, and a row opens the folder's own page — its name over
its workspace's, ⋯ with Rename… / Delete Folder…, and ✎ composing a session that lands in the folder
(§3.3–3.4). The Mac shows none of it.

This probe builds the iOS app's shared sources into a throwaway app — the real session list, as the
compact shell hosts it (`AgentContentColumn(rowNavigation: .push)` in a navigation stack, minus the
drawer) on a phone, and as `MainView` arranges it (the session column beside the console detail) on
an iPad — with the app's toast host, pointed (`-orbit.instance`) at `stub.py`: a fixture API with one
workspace, its sessions per tab (two of them filed, one waiting on you and one running), its folders,
and every door the surfaces use (`GET`/`POST`/`PATCH`/`DELETE /session-folders`, `POST /sessions`
with a `folderId`, `POST /sessions/:id/move`, a duplicate name answered 409). UI tests swipe,
long-press and tap through it on the newest iPhone and iPad simulators and photograph each step; the
stub logs every request, so the run shows which move, rename, delete or create each tap asked for.

Fixture titles are made up; nothing here is real data.
