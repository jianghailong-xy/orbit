# Evidence probe: Add Runner's Deny on the iPhone

Task 34no050naUDViWDBEtXaZ. The probe drives the iPhone app's Add Runner sheet through the request
`orbit register` makes on a machine with no browser:

- Settings → Machines & models → Add Runner, then the code typed into the sheet;
- a request still PENDING offers Deny beside Approve, and both wait while Deny is in flight;
- Deny posts `…/deny`, and the sheet then says "Request denied" in the web /enroll page's words;
- a request already DENIED opens denied, light and dark, with no Approve;
- an approval the server refuses (409 `DEVICE_ENROLLMENT_DECIDED`) shows the server's sentence;
- a runner of the same name shows "Last online 3d ago." and Re-register, and approving it says
  "Machine registered".

The probe builds the app's own CompactShell and Settings sheet from the real shared sources into a
throwaway app pointed at `stub.py`. It is adapted from the removed-Default probe
(docs/evidence/default-account-removal/ios/probe-harness). All data is made up.

- `stub.py` is the fixture API: one machine, HPC, and one request, `ABCDE-FGH23`, for devbox (hostname
  vmi3337007). GET, approve and deny answer as `runners.service.ts` does, its 409 sentences included.
  `POST /__set` picks the request's status and its same-name runner. It can also make the lookup stale,
  or hold each decision for some seconds.
- `UITests/ArdShotTests.swift` defines what is pressed and what has to be on screen. A missing word, a
  press offered where there should be none, or a decision that never reaches the stub fails the test.
- `project.yml`, `ProbeArgs.swift`, `ios/ArdProbe.swift`, `Info.plist` and `run.sh` build and run it.

To run it again, copy this directory to `.ard-probe/` at the repository root, because its `../src`
paths are relative to there. Then run `bash .ard-probe/run.sh` on a Mac with Xcode and XcodeGen. CI
runs it from a job added to `client.yml` on a `probe/…` branch, a change that is never merged (see
../README.md).
