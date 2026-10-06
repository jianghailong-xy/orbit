# TEMPORARY evidence probe — the iOS/macOS close-out, task ⑥

Task 34Y7UuPVxk2F6sKgLHFQu (project 34Y7My8sqhKLWtmCQYv1l, criterion 6). Lives only on the `-shots`
branch; never merged.

- `ios/` — the *real* iOS app (`src/ios`'s target definition, re-declared in `ios/project.yml` so
  nothing of the delivery branch is touched), built from the commit under test and signed in to a
  stub control plane on `127.0.0.1:8787` (`stub.py`). A UI test (`ios/RealUITests/DoneShotTests.swift`)
  walks it as an owner would: the session row's Ready to close, the coordinator conversation's
  "Is this project done?" drawn whole in the transcript (photographed top to bottom, Not yet…, Record
  as done and the receipt left in place), the project list's "Needs you · Ready to close" and
  recorded-by words, the project page's Ready to close and the request's row, Review opening the
  same card over the page, the owner's own Record as done…, and "Why is this project not done?" in two
  conversations. The stub records every write in `writes.jsonl` (the done door's body is the evidence
  of what the press sends).
- `mac/` — the app's real `ProjectDoneCards.swift` (and the card chrome, cut out of
  `ApprovalCards.swift` / `ApprovalReview.swift`) and the projects list's
  own `ProjectRow`, drawn in real macOS windows with the stub's facts, light and dark.

Run with `bash .done-probe/ios/run.sh` / `bash .done-probe/mac/run.sh`, or through the
`done-shots-ios` / `done-shots-mac` jobs in `.github/workflows/client.yml`
(dispatch: `gh workflow run client.yml --ref <shots branch>`).
