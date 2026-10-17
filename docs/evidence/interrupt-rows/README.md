# Interrupt rows: a Stop and a runner restart, told apart

Task 34gvBR3txIp7SfGl486Y5. The runner writes two kinds of `interrupt` event: a Stop's carries the
request it answered (`{"requestId":"req-22-1"}`, or `{}` from engines without one), and a turn the
runner tears down while it restarts is marked `{"reason":"runner_restart"}` (runner-go's
`watchShutdownDrain`). Every client used to draw both the same way. Now:

| Client | A Stop | A runner restart |
| --- | --- | --- |
| Web (`Transcript.tsx`) | `⊘ interrupted` | `⊘ interrupted — the runner restarted` |
| iOS and macOS (`ConsoleView.swift`, from OrbitKit's `TranscriptItem.interrupt`) | `Interrupted` | `Interrupted — the runner restarted` |
| Android (`TranscriptRowView.kt`) | `Interrupted` | `Interrupted — the runner restarted` |

Every picture shows one conversation holding both interrupts, with the two payloads that session
34dLFOCjLz8KqyCiaECec recorded on 2026-10-13. Apart from those two payloads, the conversation is made up.

| Picture | What it is |
| --- | --- |
| `ios-before-light.png` | iPhone, the tree before the change (930f488f7): both rows read `Interrupted` |
| `ios-after-light.png`, `ios-after-dark.png` | iPhone, the change: `Interrupted`, then `Interrupted — the runner restarted` |
| `mac-before-light.png` | The Mac app's window, before: both rows read `Interrupted` |
| `mac-after-light.png`, `mac-after-dark.png` | The Mac app's window, the change |
| `android-after.png` | Android's session page, the change, retaken once task 34hGdSoCnMMCn9iYhSwbB stopped the rows printing their raw payload (`android-after-semantics.txt` is its semantics tree; ca24298c6 holds the first picture) |
| `web-after-light.png` | The web transcript, the change |

`accessibility.txt` lists every iPhone and Mac element whose words begin "Interrupted", before and
after, as XCUITest read them beside each picture.

## How the pictures were taken

- **iPhone and Mac:** `probe-harness/` (copied from `docs/evidence/composer-fade/probe-harness`)
  builds the iPhone app's `CompactShell` and the Mac app's `MainView` from the real shared sources and
  points them at `stub.py`. `InterruptShotTests` opens the session and photographs it. The harness
  ran on GitHub Actions in run 38989803289 (macos-26, iPhone 17 Pro simulator, iOS 26.5), on the tree
  before the change and on the change, from the never-merged branch `probe/interrupt-rows`. The same
  run passed client.yml's macOS gate (`swift test` for OrbitKit and `swift build` for OrbitApp) and
  its iOS gate.
- **Android:** `InterruptRowsTest` (app unit tests) opens the production `MainActivity` session page
  over `ComposerShell`'s fake reads. It renders with Robolectric's native graphics at 411×891 dp,
  xxhdpi, asserts both rows' titles and that neither row prints its payload, and writes the PNG.
  The first picture's run also passed `scripts/verify.sh`: 3141 local tests, lint and the debug APK.
  The picture here was retaken in run 38999624606, which ran `InterruptRowsTest` alone from the
  never-merged branch `probe/interrupt-payload-after`.
- **Web:** the `Transcript` component's markup for the same conversation, styled by `index.css` and
  photographed with headless Chromium. `Transcript.test.tsx` pins both rows'
  words (`npx vitest run src/components/Transcript.test.tsx`).

## Not shown here

- The iPhone pictures come from the simulator, not the owner's phone. The Android picture is a
  Robolectric rendering, not an emulator or device screenshot.
