# TEMPORARY evidence probe — the project list and the project page, task ⑨

Task 34X0DqRhOjK7iSXtJ3N4c (project 34WzvgkHWbY1VwXmSPUZi, criterion 9). Lives only on the `-shots`
branch; never merged.

The *real* iOS app (`src/ios`'s target definition, re-declared in `ios/project.yml` so nothing of
the delivery branch is touched), built from the commit under test and signed in to a stub control
plane on `127.0.0.1:8787` (`stub.py`). A UI test (`ios/RealUITests/ProjectPageShotTests.swift`) walks
it as an owner would: the drawer's Projects count, the project list's "Needs you · Ready to start",
a project nobody started (Not started, the undecided line, Start this project? + Review, Ready
"starts when you start"), one nobody asked about (Start… and the start card over the page), How it
runs on a started project (locked line with its reason, Escalate after's menu, the merge check's
editor) and on a paused one (the open line, the amber merge check, Resume project, Automatic and
At most written), and Review landing on the start card in the coordinator conversation.

The stub applies and records every write How it runs makes (`writes.jsonl`): that file is the
evidence of what the app sends — `automatic` (never `coordinatorEnabled`), the integration door,
pause/resume.

Run with `bash .ps9-probe/ios/run.sh`, or through the `ps9-shots-ios` job in
`.github/workflows/client.yml` (dispatch: `gh workflow run client.yml --ref <shots branch>`).
