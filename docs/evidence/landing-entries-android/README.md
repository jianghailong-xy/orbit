# Landing session entries — Android evidence (NATIVE frames, light and dark, and an emulator journey)

What the Android client draws for A-2's ways into a landing session (contract §2.9 LS6, the owner's
2026-10-19 方案 A), against the owner-approved boards `docs/mocks/landing-session/v4/07-android.png`,
whose task-page and waiting-card quadrants map to `04-project-sessions-page.png` and
`06-list-chat-task.png`. The pictures here are the evidence; a build directory is not durable.

Two sets, the same rules as `docs/evidence/landing-session-android` and
`docs/evidence/task-landing-android`:

- `light/`, `dark/` — NATIVE frames written by the Robolectric tests `LandingEntriesShotsTest` and
  `LandingEntriesDarkShotsTest` under `@GraphicsMode(NATIVE)`, from the production composables over
  the controlled `ProjectShell` HTTP fixture (`src/android/app/src/test/kotlin/io/orbitd/android/ProjectShellFixture.kt`).
  Light is the default qualifier; dark is `w411dp-h1600dp-night`, which `isSystemInDarkTheme()` reads.
- `device/light/`, `device/dark/` — screenshots from `LandingEntriesDeviceTest` on a local API 36
  emulator over its own `MockWebServer` fixture, not a deployment. The script runs it in both night
  modes and puts the device's mode back.

## Frames

Each NATIVE frame exists in `light/` and `dark/`; the board column names the v4 frame it is checked
against.

| Frame | What it draws | Board |
|---|---|---|
| `01-landing-card` | the Landing card, one job: the head (`Landing`, live clock, `checking · updated just now`), the task, `onto project/launch`, `Nothing to do — it lands on its own.`, and the foot `Open landing ›` beside `All jobs ›` | 07 10:20; 04 b1 |
| `02-jobs-list` | the jobs list: a timed-out `LAND_TASK` with `Retry` and `Open landing ›`, a queued row, a `Merge check` row whose only way in is `Open landing ›`, and an older server's row with the grey `No landing page on this server yet` | 07 10:52 |
| `03-merge-check-card` | the project sessions page's merge check card: head, `+1 job queued · All jobs ›`; the whole head row opens this round's landing session | 07 10:52; 06 |
| `04-xe5-card` | the X-E5 card (board 15:02): `Now yours — no report from the runner for 27m`, the server's sentence, the red **Abandon** lead over `Open landing ›`, Chat about this, Mark as handled, then `Land · Wire the page · generation 2` / `workstation-gpu · last report 19:02 · lease expired 19:12` / `rebasing · claim 1 · round 1 of 3`, Owner waiting 2m | 07 15:02; 06 c |
| `05-integration-card` | an `INTEGRATION_CHECK_FAILED` item that became the owner's: Ask the coordinator again (lead), Open task session, Retry, and `Open landing ›` appended after the existing doors, with the Check and Branch facts | 07 13:28 |
| `06-delivery-card` | the open-item delivery card in the transcript: `Open the failed session ↗` and `Open the landing ↗` | 06 b |
| `07-source-label` | the source session's derived label at its bottom: `Landing · checking ›`, opening the generation's landing session | 06 e |
| `08-landings-group` | the project sessions page under the Coordinator: the waiting row (`Checks failed · with the coordinator`), a settled row (`Landed`), and `Earlier · 1 landed · 0 nothing to land`; the header still counts conversations only (`Project · 4 sessions`) | 04 c1 |

The device journey, in both `device/light/` and `device/dark/`:

| Frame | What it shows | Board |
|---|---|---|
| `01-landing-card` | the project sessions page with the Landing card and its `Open landing ›` foot | 07 10:20 |
| `02-landing-from-card` | the landing session opened from that foot (the page's status card and read-only footer) | 07 11:05; 05 |
| `03-jobs-list` | the jobs list opened by the card's body | 07 10:52 |
| `04-landing-from-jobs` | the landing session opened from a jobs-list row's `Open landing ›` | 07 10:52 |
| `05-merge-card` | the merge check card on the page, head row and `All jobs ›` | 07 10:52 |
| `06-landing-from-merge` | the landing session opened from the merge card's head row | 07 |
| `07-xe5-card` | the waiting card in the coordinator's conversation; scrolled to the viewport, so the complete card is the NATIVE `04-xe5-card` | 07 15:02 |
| `08-landing-from-waiting-card` | the landing session opened from the card's `Open landing` | 07 |

Difference that is not the layout: the fixture's ids are short (`34A05d…`, `34A2…`), where a
deployment's are base62; and the device frames are a 720×1280 phone at 320 dpi, the NATIVE frames a
411 dp canvas.

## How the frames were produced

```
bash src/android/gradlew -p src/android --no-daemon :app:testDebugUnitTest \
  --tests "io.orbitd.android.LandingEntriesShotsTest" \
  --tests "io.orbitd.android.LandingEntriesDarkShotsTest"
```

The PNGs land in `src/android/build/evidence/landing-entries-android/{light,dark}/` with their
semantics trees; the PNGs are copied here. The device frames come from:

```
bash src/android/scripts/landing-entries-device-test.sh APP_APK TEST_APK EVIDENCE_DIR
```

on a booted emulator (`ANDROID_DEVICE_SERIAL`, default `emulator-5554`), which installs a dedicated
signed-out build, runs the journey light then dark, and restores the night mode. Device tests are not
part of CI; this is a local API 36 result.

## Tests behind the frames

- `LandingEntriesShellTest` — the production shell: the Landing card's foot and per-row entries, a
  jobs-list row, the merge head row's two destinations (this round's landing, else the jobs list),
  `+N job queued · All jobs ›`, the CONFIRMED foot, the receipt's foot, BLOCKED drawing none, the
  timed-out round's two doors (a merge to main has only Abandon), the project Open items' OPEN_LANDING
  / ABANDON and the coordinator card's, the X-E5 heading and lead, the Landings group's filtering,
  fold and rows, the header count without LANDING, the source label, and a directory carrying LANDING
  rows still decoding.
- `LandingEntriesShotsTest` / `LandingEntriesDarkShotsTest` — the NATIVE frames above.
- `LandingEntriesDeviceTest` — the emulator journey above.
- `ExceptionCardsTest`, `ExceptionCardViewTest` — the two doors' labels, J12's two push sentences,
  the X-E5 heading/footer and lease block, and that an unknown action is still no door.
- `TranscriptDeliveryCardTest` — the delivery card's two links and their absence on an older payload.
- `ProjectPageTest`, `ProjectLandingCardViewTest`, `SessionProjectsTest`, `DirectoryDecodingTest`,
  `SessionLandingsCopyParityTest`, `LandingSessionCopyParityTest`, `ProjectCopyParityTest`,
  `SessionProjectCopyParityTest` — the models, the card states, the Landings group's rules, LANDING
  decoding, and the words (Kotlin ⊆ Swift).
- `src/android/scripts/verify.sh` — unit, lint and assemble on the delivered tree.
