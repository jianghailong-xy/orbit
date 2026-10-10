# The probe that took these pictures — kept as a record

It ran from the push-triggered branch `probe/main-branch-native`, whose results went to
`probe/main-branch-native-results`; both are deleted afterwards. `client.probe.yml` is the workflow that
branch carried as `.github/workflows/client.yml`, and the rest sat under `.mb-probe/`. Nothing here is
built by this repository.

Task 34cjZa8klRaouPcEIhw3R (iOS / macOS: the Main branch row, the last choice remembered, the copy
named by the branch). It builds the iPhone app's `CompactShell` and the Mac app's `MainView` from the
real shared sources into throwaway apps pointed at `stub.py`, opened on one project's page
(`-probe.project`). The stub's four projects share the repository `acme/payments-api`, whose
coordination workspace `payments-api` reported the branches develop / master / release/2.4, and whose
owner chose master for it two days ago:

| Project | State | What `MainBranchShotTests` photographs (board 02-ios.png frame) |
|---|---|---|
| P2 Refund service | nobody started it | the owner's own Start… opening on master with "Your last choice for acme/payments-api" (⑥), the picker with master ticked and tagged last chosen (③ ⑦), a typed `release/3.0` offered as Use “release/3.0” (⑤), develop picked (c), Automatic off and the merge check open (⑬ ⑭ ⑮), the Tasks land on menu (⑫); then Start, whose body must carry `upstreamRef: refs/heads/develop` |
| P1 Payments gateway rollout | started, nothing integrated | How it runs with the Main branch row and its sentence (⑧ ⑨), the same picker, a pick written at once as `PATCH …/integration {upstreamRef}`, Pause said of the new branch |
| P3 Checkout redesign | integrating for three days | the integration row under the title (⑪) and the line and main branch locked together, the lock sentence under Main branch (⑩) |
| P4 Docs site | no repository | the start card with no Main branch row (e) |

`run.sh` serves the stub, runs the Mac pass, then the iPhone pass, and keeps each pass's request log
(`requests.log`, write bodies decoded) beside its pictures. A state a picture is meant to show is
asserted, so a run that never reached it fails rather than photographing something else.
