# TEMPORARY evidence probe — the decision cards on iOS, task T11

Task 34YjjEkj4nnV2A46oWmTg (project 34YhlsSkybFDaTXbOfcxM, "升级给你的异常", criterion 3's
iOS/macOS half). Lives only on the `-shots` branch; never merged.

- `ios/` — the *real* iOS app (`src/ios`'s own target, re-declared in `ios/project.yml` so nothing
  of the delivery branch is touched), built from the commit under test and signed in to a stub
  control plane on `127.0.0.1:8787` (`stub.py`). `ios/RealUITests/T11ShotTests.swift` walks it as an
  owner would and photographs: the session row's short `need` ("Escalated to you · Checks failed"),
  the conversation's "waiting below" bar with the cards scrolled away, the card in its **three
  states** — escalated, coordinator-is-fixing-it (with `handledBy`), handed over — each with the
  sentence the server says has to happen next, the doors and their one line of consequence, the
  Check row (mono command, red verdict) and the log directly under it, plus the merge card a
  `Review` press scrolls to and the reason field "Mark as handled" opens.
- `stub.py` serves the same three item rows T10 photographed on the web (taken from
  `t10-server-fixture.json`, the same `requiredAction` / `primaryAction` / `handledBy` / `facts`),
  so the two ends' pictures are of the same facts. Every write a press makes is recorded in
  `writes.jsonl`.

Run with `bash .t11-probe/ios/run.sh`, or through the `t11-shots-ios` job in
`.github/workflows/client.yml` (dispatch: `gh workflow run client.yml --ref <shots branch>`).
The pictures are also pushed to `probe/t11-ios-shots-results`, which a plain `git clone` can read.
