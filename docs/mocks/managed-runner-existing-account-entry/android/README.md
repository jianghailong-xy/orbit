# Android: managed runner entry, beside board 3

Emulator screenshots of the Android build of `docs/managed-runner-existing-account-entry-design.md` (D1–D5 = A; D5: Android follows
iPhone), to compare with `../board-3.png`. Taken 2026-11-15 (retaken after the review of revision 1) by `ManagedRunnerEntryDeviceTest`
(`src/android/app/src/androidTest/kotlin/io/orbitd/android/increments/`), run through `src/android/scripts/increments-device-test.sh`
on an API 36 emulator (sdk_gphone64_x86_64, 1080×2400). The server is the test's own in-process fixture (MockWebServer), not a
deployment.

| File | What it shows |
| --- | --- |
| `01-section.png` | Machines & models: the Managed runner section after Needs you and before Machines — "Set up a managed runner" / "Orbit runs a runner for you on this server." / Set up |
| `02-confirmation.png` | Set up on an existing account asks first: "Set up a managed runner?" with the design's body, Cancel · Set up |
| `03-runner-page.png` | After Set up: one `POST /managed-runner/ensure`, then the runner's machine page while Preparing and not yet reported (no version, heartbeat or engines): its banner and state only, Resources and Engines each "Available once the runner is ready.", no Update runner, no "predates" lines, no engine rows (owner's ruling 2026-11-14) |
| `04-post-setup-row.png` | Back on the list: the entry is gone; the managed runner is one machine row with the shared short label, Preparing |
| `05-asleep-row.png` | The same row asleep: "Asleep" and the whole line "Wakes automatically when you start a session" (wrapped, not cut), never Offline, and no Needs you line for it |
| `06-drawer-asleep.png` | The drawer's workspace row on the managed runner: "managed-runner · Asleep" |
| `08-runner-ready.png` | The same runner once ready and reporting: its banner ("Managed runner ready"), its Ready state, and the ordinary page — readings, capacity, engines |
| `09-session-composer-asleep.png` | An existing session on the managed runner, asleep: the shared line "Your managed runner is asleep. Sending wakes it (about 10 s)." over a composer that still sends |
| `10-picker-asleep.png` | The project page's coordinator Change workspace sheet: the managed runner's workspace says Asleep, not Runner offline, and is still a press |
| `07-feature-off.png` | Capability absent (404): no section; the list is today's. `07-feature-off-requests.txt` is every request the app made, with no `GET managed-runner` |
