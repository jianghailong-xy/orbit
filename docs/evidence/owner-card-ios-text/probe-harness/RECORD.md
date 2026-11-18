# The probe that took the iPhone pictures — kept as a record

It ran four times from the push-triggered branch `probe/owner-card-ios-text`. On that branch these files sat under
`.ocit-probe/`, and `client.probe.yml` replaced `.github/workflows/client.yml`. Nothing here is built by this
repository. Each probe commit was the task branch plus this harness; the gates (main's own client.yml) ran on
`probe/owner-card-ios-text-gates` at the task commit itself.

- Round 1 (run 43989277266): the probe project lacked `MenuBarIcon.swift` in its excludes, so nothing ran.
- Round 2 (run 43994699076): found a real bug — the settled fold read "2 no longer open", because the card that
  pressed was folded away before it could record its receipt. Fixed in the task (the console records the receipt
  in the door's own call). The UI-test runner may not read the pasteboard; run.sh reads it host-side since.
- Round 3 (run 44008578232): the fold read "2 sent back to the coordinator"; "Full output" was tapped under the
  composer band, and the fixture's ids were not UUIDs, so "Fix it myself" had no address.
- Round 4 (run 44014911610): both tests green; these are its files.
