# The Landings window drawn as a chat — web, iOS/macOS, Android

Owner decisions, 2026-11-02: 「优化这个页面，使其更像聊天框」; after option B (`docs/mocks/landings-chat-style/`) was sent back with 「先改效果图」,
option C (`docs/mocks/landings-chat-bubbles/`) was approved with 「都按推荐」: the time in each bubble's foot, a read-only bar in the composer's
place, Orbit's avatar once per group.

| Directory | Client | What is there |
|---|---|---|
| `web/` | Web console | Browser frames a–e and a 390 px phone, light and dark, the capture kit, and what each frame drew (`report.json`). |
| `native/` | iOS / macOS | iPhone frames a–e (light, plus a dark a) and the Mac window, from the real apps built on GitHub's macOS runners against a stub (`native/probe-harness/`), with the run's gates. |
| `android/` | Android | Emulator frames a–e, light and dark, the kit that took them, and the `verify.sh` result. |

## What changed, in all three clients

1. **A settled landing is Orbit's message.** A bubble that hugs its words: the task's name, whole, and a foot with today's mark
   (✓ landed, ⇢ merged into main, ◌ every quiet ending), the row's own line and the time. A merge into main is the next bubble. A bubble
   leaves a gutter on the far side, like an incoming chat message.
2. **Groups.** Orbit's avatar, the app icon, stands beside the first message of each group: a day's rows join the one before when they
   settled at most ten minutes after it, so a task's landing and the merge that carried it read as one exchange. One rule in three
   clients (web `landingsWindowGroups`, OrbitKit `SessionProjectLandings.groups`, Kotlin `groups`), the gap held across them by the
   parity tests.
3. **Days are chips.** Centred capsules with the same words; `Now` in the accent.
4. **The cards in hand are Orbit's last messages.** The same status cards, doors and polling, across the column beside one avatar. A
   card's task name now wraps: the column is narrower beside the avatar, and the board draws it wrapping (02 d).
5. **A pressed bubble opens its record under it**, on the quiet panel a person's own message opens what Orbit attached to. The record is
   the same: a merge's receipt, then the timeline, then a task's two ways out.
6. **The footer is a read-only bar in the composer's place and shape**: `Orbit runs these landings — nothing to type here.`,
   `Decisions: the coordinator`, and `Open coordinator` where Send stands. There is nothing to type in (contract §2.9 LS6 stands).

**Unchanged:** the head and its ⋯; opening at the bottom; a landing's id opening the window on it (scrolled to, opened, outlined for about
1.5 s; the outline is on the bubble now); each landing's menu; the polling cadence; every English word; the server, the contract and the
data. The contract describes what the window holds and does, and all of that still stands.

## Checks

On the final commits (`c8f8bbc21`, and the evidence commits on it, which change no code):

| Check | Result |
|---|---|
| Web `vitest`, under `TZ=UTC` and under `TZ=Asia/Shanghai` | 462 files, 6125 tests passed in each |
| Web `tsc` and `npm run build -w @orbit/web` | clean |
| OrbitKit `swift test` in the `swift:6.1` image | 4341 tests, 5 skipped, 0 failures |
| macOS and iOS on GitHub (`native/README.md`, run 41373778258) | the Mac app and OrbitKit, the iOS build, the navigation and font-token gates, and the probe's 6 UI tests all passed |
| Android `src/android/scripts/verify.sh` (`android/README.md`) | 4526 local tests passed, no skips; lint and assemble passed |

The server, `src/shared` and runner-go are untouched, so their suites were not rerun.

## Known limits

- The iPhone and Mac frames are the real apps on GitHub's simulator and CI Mac, and the Android frames are the shared emulator: nothing
  here was run on a physical phone.
- Android's other device journeys through the window (`LandingSessionDeviceTest`, `LandingEntriesDeviceTest`, `TaskLandingDeviceTest`,
  `ProjectMergeDeviceTest`, `ProjectMergeRealStackDeviceTest`) compile but were not run on a device for this.
- One screen shows a little less than before (about 7 messages where there were 8 rows), because names no longer clip.
- Each client keeps its own platform's shapes: Android's long press is its Material dropdown without the lift and dim, and its bar copies
  Android's composer (an outlined field over a row), not the iPhone's single rounded card.
