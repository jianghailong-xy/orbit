# TEMPORARY evidence probe — never merged

What a rightward swipe from a column's left edge does on an iPad, and the screens the buttons reach
instead. Builds the iOS app's shells (`MainView` at regular width, as `RootView` picks it) from the
real shared sources into a throwaway app pointed (`-orbit.instance`) at `stub.py`: four workspaces
on three machines, the conversation S1 beside workspace orbit's session list, two folders, a project
with a coordinator and a member, and Mac Studio's record with its Claude Code page.

`EdgeSwipeTests` runs on the newest, largest iPad simulator, landscape and portrait: the screen's
left edge with the sidebar hidden, the sidebar button, a left swipe over the sidebar, a folder's
page and a project's sessions page in the list column, and the engine page in the detail column.
Each step is photographed with its outcome noted; the stub logs every request.

To run it: this directory at the repo root as `.ipad-probe/`, `client.probe.yml` as
`.github/workflows/client.yml` on a `probe/…` branch, and push. The report job pushes the pictures,
notes and logs to `<branch>-results`. Nothing here is real data.
