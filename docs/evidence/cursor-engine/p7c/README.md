# Cursor CLI on Android (P7c): the emulator beside the owner's board

This is the evidence for task 34h05gHLUjZPikL7KwakY, P7c: Android's Cursor CLI screens, in project 34gyHIZv301nDWxKP9XkO.

- **The board.** `docs/mocks/cursor-engine/ios-1` … `ios-6` (T0, de5c226d5). The owner confirmed it on 2026-10-17, with D1–D6 as recommended and D6 as option A.
- **What Android follows.** Android follows the iOS boards. Its behaviour and words follow the web's (P7a, `docs/evidence/cursor-engine/p7a/`).
- **The rulings.** The coordinator's rulings are in the task's comments.

**Result.** Every "after" phone of iOS 1–6 was taken from the app on the emulator, in light and dark: 35 scenes, 70 captures. Each capture sits beside the board's phone it follows.

- They match the board except for the differences listed below.
- Each difference comes from one of three places: a coordinator ruling, the web's words (P7a), or a convention Android already keeps for every engine.

Two kinds of board phone are not drawn:
- the "now" phones (main before Cursor CLI);
- D6's option B, which the owner did not choose.

## Files

- `compare-<board>-<theme>.png`: 12 sheets, one per board (iOS 1–6) and theme. Each row is one scene: the board's phone on the left, the emulator's capture on the right, both at the same height. `compare-index.json` lists each sheet's rows.
- `shots/<scene>-<theme>.png`: the 70 captures at the emulator's 1080 × 2400, in 256 colours.
- `device-run/`: the run's own record:
  - the source SHA;
  - the device;
  - the APKs' SHA-256;
  - the instrumentation output;
  - every request each pass made to the controlled server.
- `kit/`: the scripts:
  - `frames.mjs` cuts each phone out of the board;
  - `compare.py` lays out the sheets;
  - `quantize.py` makes the 256-colour copies.

## How the frames were taken

- **The app.** This branch's debug APK, on the shared emulator: `sdk_gphone64_x86_64`, Android 16 (API 36), 1080 × 2400 at 420 dpi. The app is cleared and signed out before the run.
- **The walk.** `CursorDeviceTest` (`src/android/app/src/androidTest/kotlin/io/orbitd/android/cursor/`) drives the real product shell:
  - the workspace's New session;
  - a Cursor CLI session;
  - Settings → Infrastructure, the machine hpc, and Cursor CLI's engine page with its accounts;
  - both Cursor keys.

  It runs once light (`cursorScreensLight`) and once dark (`cursorScreensDark`). The theme is the signed-in user's preference.
- **The API.** A MockWebServer inside the instrumentation answers every request. Its answers take the shapes the runner and the server give (docs/cursor-runtime-contract.md):
  - **hpc**: runner 0.1.262 with Cursor CLI 2026.10.14-941492e. Default (Free plan, no reading) and Team (Pro, monthly 34%) are signed in. The walk turns Cursor CLI on hpc into each state the board draws.
  - **mac-studio**: runner 0.1.236, which predates Cursor CLI.
  - **build-box**: a runner that knows Cursor CLI but doesn't have it installed.
  - **Keys**: two Cursor keys, one of them refused by Cursor, and a DeepSeek key. The signed-out row of iOS 1 is taken with no Cursor key, as the board's case is.
  - **Sessions**:
    - "Fix the flaky export test" on Cursor CLI, talked or not;
    - the same session on Auto, or on Claude Opus 5.5 at 1M and Fast;
    - the same session running with a message queued;
    - a session of its own that met Default's usage limit.

  No real Cursor account, key, runner or prompt was used.
- **The run.** `src/android/scripts/cursor-device-test.sh APP_APK TEST_APK OUT`:
  - installs both APKs;
  - clears the app;
  - runs the class;
  - pulls the captures, holding the shared device lock throughout.
- **The board's phones.** `kit/frames.mjs` renders each iOS board in headless Chromium at 2×, light and dark, with the board's own fonts. It cuts out each phone with its stage label.
- **The sheets.** `kit/compare.py` lays each phone beside its capture. `kit/quantize.py` makes the 256-colour copies.

To take them again:

1. `bash src/android/scripts/cursor-device-test.sh app-debug.apk app-debug-androidTest.apk <out>`
2. `FONTCONFIG_FILE=/var/tmp/cursor-engine-mock/fonts.conf node kit/frames.mjs docs/mocks/cursor-engine <frames>`
3. `python3 -I kit/compare.py <frames> <out>/p7c-cursor <sheets>`
4. `python3 -I kit/quantize.py <out>/p7c-cursor <shots>`

## Everywhere

- **No engine marks.** Android draws no engine's mark anywhere, so Cursor CLI has no cube in the lists, cards or headers.
- **Android's layouts.** The pages keep Android's own layout where the board draws iOS's:
  - a full page for a machine or a key, not a sheet;
  - a dialog for the model menu, with lists where iOS has submenus;
  - a "⋯" button for an account's menu, where iOS long-presses.

## Board by board

### iOS 1 · New session (`compare-ios-1-new-session-*`)

Scenes: `ios1-engines` (phone 2), `ios1-new-session` (phone 3), and phone 4 four times: `ios1-row-not-installed`, `ios1-row-signed-out`, `ios1-row-update-runner`, `ios1-row-wrong-version`.

Same as the board:
- Cursor CLI is the Engine list's last row, on Auto.
- The four ways a machine can't run it each show on the row:
  - "Not installed →";
  - "Not signed in, sign in →" (no sign-in and no Cursor key);
  - "Update runner →";
  - "Unsupported version →".

  Each opens the machine's page for it, as every engine's row does.
- Picked, the session is on Auto, with Context Unavailable.

Different:
- The list has no Antigravity CLI row: the fixture's hpc has nothing Antigravity could run on.
- The new session is Android's own page: an Engine row at its head, not the board's centred title.
- Android's composer has no mode chip, so the board's Accept Edits ③ is in the model menu's Permissions (iOS 6).

### iOS 2 · Infrastructure (`compare-ios-2-infrastructure-*`)

Scenes: `ios2-infrastructure` (phone 1), `ios2-machine` (phone 2), `ios2-engine-page` (phone 3). Phone 4 six times: the four states on hpc's row (`ios2-state-not-installed`, `-signed-out`, `-update-runner`, `-wrong-version`), and the engine page of the two that offer a press (`-not-installed-page`, `-wrong-version-page`).

Same as the board:
- The overview's seventh card: Cursor CLI Ready, with "Subscription · hpc ×2" and its keys on Auto.
- hpc's Engines: Cursor CLI is last, with "2026.10.14-941492e · 2 accounts signed in", Next: Team, and the monthly limit.
- The engine page:
  - "2026.10.14-941492e · pinned · checked 6m ago";
  - Default's Free plan with "Usage unavailable" (never 0%);
  - Team NEXT with its monthly limit;
  - Add Account and the footer.
- The four states:
  - Not installed: the engine page offers Install Cursor CLI.
  - Signed out: Sign In right on the row.
  - Update runner: with its hint.
  - Unsupported version: with its hint; the engine page offers Reinstall Cursor CLI.

Different:
- **The overview lists both keys** ("Cursor Auto, Cursor 2 Auto"). The fixture has two Cursor keys where the board's overview had one. The web lists every key too.
- **The web's words**, for two sentences:
  - Default's line reads "…how much of the Free plan’s usage is left, so Orbit shows no number rather than 0%." The board's reads "…how many of the Free plan’s requests are left."
  - The Unsupported version hint reads "…Reinstall puts that version back on this runner; sessions here can’t start until then." The board's reads "…Sessions here can’t start until it is reinstalled."
- An account's home is cut in the middle (`~/.orbit/c…ccounts/5c2e91a0`), where iOS cuts its end.

### iOS 3 · Add Account, Sign In Again, Remove (`compare-ios-3-add-account-*`)

Scenes: `ios3-add-pending` (a), `ios3-add-link` (b), `ios3-add-expired` (c), `ios3-add-done` (d), `ios3-account-menu`, `ios3-resign-link`, `ios3-remove-confirm`, `ios3-remove-refused`.

Same as the board:
- **Starting.** Add Account names the new account and starts the sign-in at once. The card says "Starting sign-in on the runner…" until the runner relays the link.
- **The link card:**
  - "Sign in on cursor.com with the account you are adding:";
  - Open cursor.com and Copy Sign-In Link;
  - "Waiting for you to sign in… · link expires in 26 min";
  - Cancel.
- **Expired.** The runner's sentence, and Get a New Link.
- **Landed.** The new account sits in its own row, signed in, with its monthly limit. Team stays NEXT.
- **The account's menu.** Rename…, Sign In Again, Pause… and Remove…. Sign In Again opens the same link card, under that account.
- **Remove.** It asks first. When the runner refuses, the reason shows under the account.

Different:
- The new account keeps the name the page picks, "Account 3"; the board typed "Work".
- After the link expired, the card offers Close rather than Cancel. Nothing is under way any more, and Android's sign-in card offers Cancel only while something is, for every engine.
- The refusal also shows as a snackbar. "Copy Sign-In Link" wraps to two lines at this width.

### iOS 4 · API key (`compare-ios-4-api-key-*`)

Scenes: `ios4-keys` (phone 2), `ios4-key-valid` (phone 3), `ios4-key-rejected` (phone 4).

Same as the board:
- **API keys rows.** Cursor and Cursor 2, each "Auto" on "Cursor CLI". The refused one ends in Rejected.
- **The key's page:**
  - Works with Cursor CLI, "Billed to this key’s Cursor plan";
  - Last check, "Valid · 4 min ago" or "Rejected · 4 min ago";
  - for the refused key, Check Again, with Cursor's words and what to do;
  - the Key section: Cursor API, Auto, api2.cursor.sh;
  - the footer.
- **Check Again** posts `providers/mine/:id/key-check`. The page reads `keyCheckState` and `keyCheckedAt` (the coordinator's ruling); see `CursorKeyPageTest`.

Different:
- The keys above the Cursor ones are this fixture's (one DeepSeek key).

### iOS 5 · Session (`compare-ios-5-session-*`)

Scenes: `ios5-model-auto` (phone 1), `ios5-model-variant` and `ios5-chip` (phone 2), `ios5-running` (phone 3), `ios5-context` (phone 4), `ios5-quota` (phone 5).

Same as the board:
- **The model list.** Auto first, then the runner's catalogue. Under Auto, the board's note: "…and Auto has no effort or context to set."
- **Claude Opus 5.5:** Effort, Context (300K / 1M) and Speed (Standard / Fast).
  - The coordinator's convention of 2026-10-18 applies: the context and the speed travel in the session's model value, `claude-opus-5-5[context=1m,fast=true]`. A value at the model's default is left out. The effort stays in its field.
  - The chip reads "Claude Opus 5.5 High · 1M · Fast".
- **A running turn.** The tray's "Queued for next turn" row with the note "Cursor CLI can’t take a message mid-turn — sending one would stop the turn. These go in order once it ends.", and the placeholder "Reply — it goes to Cursor CLI when this turn ends…".
- **Context.** "Context: Unavailable", and the sheet's "Context window · Unavailable" with why. Its Model row says "Claude Opus 5.5 High · 1M · Fast", never the bracketed value.
- **The usage-limit card:**
  - "The quota for Default (Cursor CLI) on “hpc” is used up."
  - "Cursor answered “Upgrade your plan to continue”: Default’s Free plan has no requests left until Oct 24."
  - "This conversation can’t move to Team yet — start a new session on Team."

Different:
- **The chip is cut short at 411 dp:** "Claude Opus 5.5 High · 1M …". The board shortens the name to "Opus 5.5". Android uses the catalogue's name, as its menu does. The context sheet's Model row, and the chip's spoken label, have it whole.
- **Effort is a list.** Android's Effort list marks no current level, as for every engine; the chip names it. Its levels are the runner's values (low … max).
- **The sheet.** The context sheet is Android's "Context and plan usage" dialog, which also shows the plan.
- **The usage-limit card's extras.** It adds "Auto-retry is off.", as the web's does. Its button is Android's "Retry now".
- **The Auto note is the board's, not the web's.** The web leaves "or context" out because its menu has no Context row. Android's has one, by the 2026-10-18 ruling. `CursorCopyParityTest` reads the web's note either way.

### iOS 6 · Modes and switching (`compare-ios-6-modes-and-switch-*`)

Scenes: `ios6-modes` (phone 2, D6 option A), `ios6-switch-blocked` (phone 4), `ios6-switch-open` (phone 5).

Same as the board:
- **The modes.** Default is greyed with why. Accept Edits is ticked, then Plan, Auto, Don't Ask and Bypass.
- **A session that has talked.** Its other accounts and keys are greyed, with the note: "Cursor CLI can’t carry a conversation to another account or key yet. Start a new session to use one of these." The current Automatic is greyed too, as on the board.
- **A session that hasn't talked.** Every account and key can be picked.

Different:
- **The modes' short notes** are the shared `permissionSemantics` ones, as the coordinator ruled on 2026-10-17 and as the web does:
  - Default: "Unsupported on Cursor CLI; session configuration is rejected".
  - Don't Ask: "Partly enforced, edits inside the workspace still run".
  - Plan and Auto: no note.
- **Phone 5.** `ios6-switch-open` is the session before it talked. The board's phone 5 draws a new session's draft; both have not talked.

## When Cursor CLI appears

`ProviderEngines.androidShowsEngine(engine, runners)` is true once some runner of the account knows Cursor CLI. A runner knows it if it declares `provider:cursor`, or reports a `cursor` engine, installed or not. This is the web's `webShowsEngine` / `runnerKnowsCursor`.

Until then, Cursor CLI is nowhere on Android:
- not the New session's engines;
- not a task's engine pin (TaskDetail now reads GET /runners for it);
- not Infrastructure's cards and Needs you;
- not a machine's Engines rows.

So Android's entry opens only after the runners are updated, which is P9's order. See `CursorEngineTest`.

## Gaps

- **No real Cursor account, key or prompt was used.** Every Cursor answer here is a fixture in the shape the runner and the server give.
- **The server refuses Install and Reinstall today.** Android draws them per the board and posts `runners/:id/install {engine: 'cursor'}`, as for every engine. `StartInstallDto` refuses cursor until task 34iDkJiUemFVk3oqBYuJ0.
- **The runner side of Context and Speed is task 34iDjteT5qGcwXKjAUKj1.**
  - Android writes the bracketed model value by the coordinator's convention: `CursorRuntime.withParameters`, `modelParameters` and `modelBase`.
  - Android reads the values from the catalogue's `parameters` rows.
  - If that task names or shapes them otherwise, Android follows it.
- **The web (P7a, as landed) has no Context or Speed row.** Android's Auto note and model menu differ from the web there, by the ruling.
- **No engine marks on Android** (see "Everywhere").
- **Signing in on another device is not measured yet** (contract §17.1 item 6). iOS 3 assumes it works, as the board does.
