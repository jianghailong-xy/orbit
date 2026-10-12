# The probe that took these pictures — kept as a record

It ran from push-triggered branches (`probe/crossings-native`, `probe/crossings-native-shots`,
`probe/crossings-final`), which were deleted afterwards; `client.probe.yml`, `client.shots.yml` and
`client.final.yml` are the workflows those branches carried as `.github/workflows/client.yml`, and the rest
sat under `.xcross-probe/`. Nothing here is built
by this repository.

Task 34b99rROWy9XZs7gyAr8t (iOS / macOS: the project page's cross-project crossings card, move requests
included, in the web card's words). Builds the iPhone app's `CompactShell` and the Mac app's `MainView`
from the real shared sources into throwaway apps pointed at `stub.py`, opened on project P1's page
("Runner hardening"). P1 is an end of five crossings: a request to move "Wire the drain watchdog" in from
a DONE project, a request to move "Pin the runner image digest" out (its task is being landed), a filing
out, and two answered ones. `CrossingsShotTests` photographs the card, presses Approve… on the move in
(the second step names both projects and the consequence), then Yes, approve — which sends the real
`POST /api/projects/P1/handoffs/X1/decision` with the crossing key — and photographs the row read back
moved; then confirms the move out, which the door refuses with `MOVE_TASK_LANDING_IN_FLIGHT`, and
photographs the reason; then opens and cancels the second step of a refusal. All data is made up.
