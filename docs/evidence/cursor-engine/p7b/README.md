# Cursor CLI on iPhone and Mac (P7b): the simulator beside the owner's board

This is the evidence for task 34h05g5qDzqxO4Cg6dHtP, P7b: the Cursor CLI screens of the iPhone app and the Mac app, in project
34gyHIZv301nDWxKP9XkO.

- **The board.** `docs/mocks/cursor-engine/ios-1` … `ios-6` (T0; af84e78dc as the coordinator named it, de5c226d5 on this line). The
  owner confirmed it on 2026-10-17, with D1–D6 as recommended and D6 as option A.
- **What the apps follow.** The iOS boards, with behaviour and words from the web (P7a, `docs/evidence/cursor-engine/p7a/`) and the
  coordinator's rulings in the task's comments. The Mac app draws the same OrbitApp views (Structure B), so the pictures are the
  iPhone's; the Mac's build and tests run in the same CI runs.

**Result.** Every "after" phone of iOS 1–6 was taken from the iPhone app on the simulator, light and dark: 39 scenes, 78 captures
(94 pictures with the rows also taken on their own). Each capture sits beside the board's phone it follows. They match the board except for the differences listed below, each of which comes from a
coordinator ruling, the web's words (P7a), or a convention the app already keeps for every engine.

Two kinds of board phone are not drawn: the "now" phones (before Cursor CLI), and D6's option B, which the owner did not choose.

## Files

- `compare-<board>-<theme>.png`: 12 sheets, one per board (iOS 1–6) and theme. Each row is one scene: the board's phone on the left, the
  simulator's capture on the right, both at the same height. `compare-index.json` lists each sheet's rows.
- `shots/<scene>-<theme>.png`: the captures at the simulator's 1206 × 2622 (iPhone 17 Pro, iOS 26.5), in 256 colours. A row of the Engine
  sheet or a machine's page is also photographed on its own (`ios1-c-row-not-installed-light.png`, …).
- `run/`: the CI run's own record: `RESULTS.txt` (run, commit, job results), each part's notes, the stub's request log and what it did
  not serve, and the test summaries.
- `probe-harness/`: the probe (below), with `ci/client.probe.yml`, the probe branch's `client.yml`.
- `kit/compare.py`: lays out the sheets. The board's phones are cut out by P7c's `docs/evidence/cursor-engine/p7c/kit/frames.mjs`.

## How the frames were taken

- **The app.** A throwaway iPhone app built from the iOS shell (`src/ios/Sources` without its `@main`), the shared OrbitApp sources and
  OrbitKit — the app's own views, nothing redrawn. It opens Settings, a new session or a session, pointed at a stub API.
- **The API.** `probe-harness/stub.py` serves the account the boards draw, in the shapes the runner and the server send
  (docs/cursor-runtime-contract.md):
  - **hpc**: runner 0.1.262 with the pinned Cursor CLI 2026.10.14-941492e. Default (Free plan, no reading) and Team (Pro, monthly 34%) are
    signed in; Add account is declared.
  - **build-box** (not installed), **mac-studio** (runner 0.1.236, which predates Cursor CLI), **gpu-box** (2026.10.16-e3cb207, not the
    pinned build), **lab** (signed out): one machine per state, each with a workspace on it.
  - **Keys**: DeepSeek, Gemini, Kimi, Z.AI and two Cursor keys — Cursor (accepted 4 min ago) and Cursor 2 (refused). iOS 1's signed-out
    row is taken with no Cursor key, as the board's case is; iOS 6's Provider menus with the one key the board draws.
  - **Sessions**, each "Fix the flaky export test" on hpc: C1 on Auto, talked; C2 on Claude Opus 5.5, High, at 1M and Fast; C3 with a turn
    running and a message queued; C4, whose turn met Default's usage limit.
  - The runner's sign-in relay is played by the stub: pending until the test hands over the cursor.com link, then expired or approved.
    Removing Team is refused as the runner refuses an account in use.

  No real Cursor account, key, runner or prompt was used; the fixture holds no key or token.
- **The walk.** `probe-harness/UITests/CursorShotTests.swift` presses its way to each screen — the new session's Engine switch; Settings →
  Infrastructure → a machine → Cursor CLI; an account's long press; a key's row; the composer's mode, model and Provider menus; the context
  ring — and photographs it in light and dark. It checks the words the board puts on each screen; a word missing fails the test, with the
  element tree kept. A menu row's subtitle is drawn but not in the accessibility tree, so those are read off the pictures.
- **The run.** Client CI run 39178766623 on `probe/p7b-cursor-shots` (commit e9e1b0bc1: this branch's cf0ca8026 plus `.p7b-probe/`,
  a copy of `probe-harness/`, and the probe's `client.yml`). macOS 26 runners, the iPhone 17 Pro simulator on iOS 26.5, Xcode
  latest-stable; part a took iOS 1–3 and part b iOS 4–6, 0 failures. The status bar is set to 9:41. The earlier runs' pictures are not
  used (see "Found on the way").
- **The sheets.** `node docs/evidence/cursor-engine/p7c/kit/frames.mjs docs/mocks/cursor-engine <frames>` (headless Chromium, 2×, the board's
  own fonts), then `python3 -I kit/compare.py <frames> <shots> <out>`.

## Checks

All on this branch at cf0ca8026, after merging the project branch's tip 55ac0e244 (the Context/Speed follow-up's landing); later
commits only add files under `docs/evidence/cursor-engine/p7b/`.

- **OrbitKit `swift test` in docker swift:6.1**, on a full copy of the worktree without node_modules, .git, build, dist and .build:
  the project tip 55ac0e244 gives 3873 tests, 5 skipped, 0 failures; this branch 3895, 5 skipped, 0 failures — no new failure, 22
  tests more (`CursorRuntimeTests`, and `CursorEngineTests` rewritten for the gated engine).
- **client.yml on the probe branch** (never merged): run 39178766623, the pictures' run, on the final code — macOS (OrbitKit
  `swift test`, OrbitApp `swift build`), iOS (XcodeGen + Simulator build), the font-token and navigation audits — all green. So were
  the earlier runs on the way: 39165241380 (`probe/p7b-cursor-gates`, before the project merges), 39166881682, 39169547335,
  39171352892, 39172008765 and 39176229497.
- **The Android gate** (`src/android/scripts/verify.sh`: unit tests, lint, debug APK) on the probe branch: green on every merge on the
  way (39166881621, 39169563181, 39172013375, 39176234558 on 8629bebf3) and on the final commit (39178766515). That run's first
  attempt failed two Robolectric tests that read nothing of this task's — `ProjectMergeShellTest` :211 and `ProjectSessionsShellTest`
  :69; only Swift had changed since the green 39176234558 — and its re-run on the same commit is green. The Android tests that read
  Swift sources (SettingsCopyParityTest, InfrastructureCopyParityTest, AccountCopyParityTest, PendingTrayCopyParityTest,
  TaskCopyParityTest, LoginCopyParityTest, DrawerCountTest and the rest) are among them; no Kotlin copy needed changing.
- **The project's full check** on cf0ca8026, each step's exit code: worktree overlay 0, `npm run build` 0, `npm test -w @orbit/shared` 0
  (33 files), `npm test -w @orbit/apiserver` 0 (5350 tests, 0 failed), `npm test -w @orbit/web` 0 (423 files), `go vet ./...` 0,
  `go test ./...` 0.
- **Every acceptance script of the project** (`scripts/test-cursor-*.mjs`, 16 of them, `test-cursor-model-variants` included) on
  cf0ca8026: all exit 0.
- **Real Cursor calls:** none; no prompt was sent.

## Everywhere

- **Copy.** Where a sentence on the board and the shipped web differ, the apps say the web's, as the task asks; the modes' notes are the
  shared ones by the coordinator's ruling of 2026-10-18. Each difference is named under its board below.
- **Menus are iOS 26's.** A menu opens from its control and lists from the end nearest it: the mode menu, opened upward from the composer,
  reads Bypass … Default from the top, as it does for every engine. A menu item's title carries no mark: the board's Cursor cube beside the
  model menu's "Cursor CLI" title is left out, because an image in one row of an iOS 26 menu shifts every row's text.

## Board by board

### iOS 1 · New session (`compare-ios-1-new-session-*`)

Scenes: `ios1-a-engine-sheet` (phone 2), `ios1-b-hero-cursor` (phone 3), and phone 4 four times, each the Engine sheet of a workspace
on the machine in that state: `ios1-c-row-not-installed-sheet`, `ios1-d-row-signed-out-sheet`, `ios1-e-row-update-runner-sheet`,
`ios1-f-row-unsupported-version-sheet` (the row alone: `shots/ios1-c-row-not-installed-*.png` …).

Same as the board:
- The Engine sheet's seventh row: Cursor CLI with the cube, on Auto. The sheet's two footers are unchanged.
- Picked, the hero is the cube, "Cursor CLI ⌄", "Send a task to get started." and Auto; the model chip says Auto. In dark the cube has
  its outline.
- The four ways a machine can't run it, under the name: "Not installed →", "Not signed in, sign in →" (no sign-in and no Cursor key),
  "Update runner →", "Unsupported version →". Each opens that machine's Cursor CLI page.

Different:
- **The new session's mode is Auto**, where phone 3 draws Accept Edits. A new session starts at the app's floor, Auto, on every engine,
  as on the web (`AgentDefaults.defaultPermissionMode`, web `pickedModeSeed`); Cursor CLI runs Auto, so it stays. Accept Edits is what
  a session asking for Default gets (D6 A).
- **Plan usage beside the chip**: the composer shows the reading of the account the session would start on (Team, 34%), as it does
  for every engine's accounts.

### iOS 2 · Infrastructure (`compare-ios-2-infrastructure-*`)

Scenes: `ios2-a-infrastructure-cursor-card` (phone 1), `ios2-b-machine-hpc-cursor-row` (phone 2), `ios2-c-cursor-engine-page` and its
footer `ios2-c2-…` (phone 3), and phone 4: the machine page of each state (`ios2-d-state-not-installed-page`,
`ios2-e-state-signed-out-page`, `ios2-f-state-update-runner-page`, `ios2-g-state-unsupported-version-page`; the row alone without
`-page`) and the Cursor CLI page of the two that offer a press (`ios2-d-…-engine-page`, `ios2-g-…-engine-page`).

Same as the board:
- **The overview's seventh card**: Cursor CLI Ready, "Subscription · hpc ×2", its keys on Auto.
- **hpc's Engines**: Cursor CLI last, "2026.10.14-941492e · 2 accounts signed in", Next: Team, Monthly limit 34% with its reset; the
  footer adds "Cursor CLI stays on the version Orbit pins."
- **The engine page**: "2026.10.14-941492e · pinned · checked 6m ago"; Default's "Free plan · ~/.orbit/cursor/default" and "Free plan ·
  Usage unavailable — Cursor doesn’t report how many of the Free plan’s requests are left." (never 0%); Team NEXT, "Pro plan ·
  ~/.orbit/cursor-accounts/5c2e…", Monthly limit 34%; Add Account; the footer. No Update Engines Now for Cursor CLI.
- **The four states**: Not installed, whose page offers Install Cursor CLI; Signed out with Sign In on the row; Update runner with "This
  runner predates Cursor CLI. It updates itself when no session is running on it."; Unsupported version (2026.10.16-e3cb207), whose page
  offers Reinstall Cursor CLI.

Different:
- **The overview lists both keys** ("Cursor Auto, Cursor 2 Auto"): the fixture has iOS 4's two Cursor keys where the board's overview has
  one. The web lists every key too.
- **The web's words for the Unsupported version hint**: "Orbit runs Cursor CLI 2026.10.14-941492e. Reinstall puts that version back on
  this runner; sessions here can’t start until then." The board's: "…Sessions here can’t start until it is reinstalled."
- An account's home is cut in the middle (`~/.orbit/cu…r-accounts/5c2e91a0`), where the board cuts its end.
- The other engines' rows on lab, mac-studio and gpu-box (Antigravity's "Update runner", say) are the fixture's machines, not Cursor's.

### iOS 3 · Add Account, Sign In Again, Remove (`compare-ios-3-add-account-*`)

Scenes: `ios3-a-add-pending` (a), `ios3-b-add-link` (b), `ios3-c-add-expired` (c), `ios3-d-add-done` (d), `ios3-e-team-menu`,
`ios3-f-sign-in-again-link`, `ios3-g-remove-confirm`, `ios3-h-remove-refused`.

Same as the board:
- **Starting.** Add Account names the account (typed "Work" here) and starts the sign-in at once: "Starting sign-in on the runner…" and
  why it can take a minute, until the runner relays the link.
- **The link card**: "Sign in on cursor.com with the account you are adding:", Open cursor.com and Copy Sign-In Link, "Waiting for you
  to sign in… · link expires in 26 min", Cancel.
- **Expired**: the runner's sentence "The sign-in link expired before anyone signed in with it." and Get a New Link.
- **Landed**: the card folds into Add Account; Work is a row of its own, signed in, "Pro plan · ~/.orbit/cur…r-accounts/9b1f3c20", its
  monthly limit at 3%. Team stays NEXT.
- **Team's long press**: Rename…, Sign In Again, Pause…, Remove…. Sign In Again opens the same link card under Team, "…with this account
  again:".
- **Remove** asks first; the runner's refusal shows under Team in red: "Team is in use: 2 sessions on hpc are running on it. Remove it
  once they finish. Its sign-in is untouched."

Different:
- After the link expired, the card offers Close rather than Cancel: nothing is under way any more, and the sign-in card offers Cancel only
  while something is, for every engine (Android's card does the same).
- Remove's question is the app's alert for every engine's account: its message names the account's directory
  ("~/.orbit/cursor-accounts/5c2e91a0 goes from this machine, …") where the board says "Its sign-in", and its two buttons sit side by
  side.
- The long-press menu draws its icons before the words (iOS 26's context menu).
- The refusal also shows for a moment in the app's toast, as any engine's failed press does.

### iOS 4 · API key (`compare-ios-4-api-key-*`)

Scenes: `ios4-a-api-keys` (phone 2), `ios4-b-cursor-key-valid` (phone 3), `ios4-c-cursor-key-rejected` and
`ios4-d-cursor-key-checked-again` (phone 4).

Same as the board:
- **API keys**: Cursor and Cursor 2, each "Auto" on "Cursor CLI", each opening a page; the refused one ends in Rejected (orange).
- **The key's page**: Works with Cursor CLI, "Billed to this key’s Cursor plan", "…It runs no other engine."; Last check "Valid · 4 min
  ago" with "A runner with Cursor CLI checks the key with Cursor (no request is spent)."; Protocol Cursor API, Default model Auto,
  Endpoint api2.cursor.sh; "Adding or changing a key happens on the web. Turning it off there stops it on Cursor CLI."
- **The refused key**: "Rejected · 4 min ago", Check Again, and "Cursor said “The provided API key is invalid.” Paste a new key on the
  web, then check again."
- **Check Again** posts `providers/mine/:id/key-check` (in `run/part-b/requests.log`) and reads the key's `keyCheckState` and
  `keyCheckedAt` again (the coordinator's ruling). The stub keeps the key's recorded check, so the page after it
  (`ios4-d-cursor-key-checked-again`) still shows that one.

Different:
- The keys above the Cursor ones are the fixture's (DeepSeek, Gemini, Kimi, Z.AI).

### iOS 5 · Session (`compare-ios-5-session-*`)

Scenes: `ios5-a-model-menu-auto` and `ios5-a2-model-menu-auto-three-models` (phone 1), `ios5-b0-chip-opus`,
`ios5-b-model-menu-opus` and `ios5-b2-model-menu-opus-three-models` (phone 2), `ios5-c-turn-running-queued` (phone 3),
`ios5-d-context-unavailable` (phone 4), `ios5-e-usage-limit` (phone 5).

Same as the board:
- **The model menu**: titled Cursor CLI, Provider (Automatic), then Auto and the runner's catalogue. Under Auto, the board's note: "Auto
  picks a model for each request. Cursor doesn’t report which one it used, and Auto has no effort or context to set."
- **Claude Opus 5.5**: Effort, Context (300K / 1M) and Speed (Standard / Fast), the settings the runner's catalogue lists for the model
  by Cursor's own names. The context and the speed travel in the session's model value, `claude-opus-5-5[context=1m,fast=true]`, read
  and written by shared `cursorModels.ts`'s rules (task 34iDjteT5qGcwXKjAUKj1, which the runner sets them by); the effort stays in its
  field. The rows and the chip's words are the web's (`cursorSettingRows`, `cursorChipSettings`): "Claude Opus 5.5 High · 1M · Fast".
  With the board's seven models the menu runs past the phone's foot, Effort at its edge; the `-three-models` captures take the menu
  with the runner listing three models, where all of it fits — Effort High, Context 1M, Speed Fast, and Auto's whole note.
- **A running turn**: the tray's "Queued for next turn" row with "Cursor CLI can’t take a message mid-turn — sending one would stop the
  turn. These go in order once it ends.", the placeholder "Reply — it goes to Cursor CLI when this turn ends…", and Stop.
- **Context**: the ring is dashed; its sheet says "Context window · Unavailable" and why, and names the model ("Model · Auto").
- **The usage-limit card**: "The quota for Default (Cursor CLI) on “hpc” is used up.", "Cursor answered “Upgrade your plan to
  continue”: Default’s Free plan has no requests left until Oct 23.", "This conversation can’t move to Team yet — start a new session on
  Team." (a link that opens a new session on Team), and Retry.

Different:
- **The model's name is the catalogue's**, "Claude Opus 5.5", where the board shortens it to "Opus 5.5". On the phone the chip's name
  gives way first — its effort and settings never shorten, as the effort never did — so it reads "Cl… High · 1M · Fast"; the menu, the
  context sheet's Model row and the chip's spoken label say it whole.
- **The model menu's title has no cube** (see "Everywhere").
- **The usage-limit card** adds "Auto-retry is off." and its button reads "Retry now", as for every engine and on the web.
- **The placeholder** takes one line of the phone's composer and is cut there; the board wraps it.

### iOS 6 · Modes and switching (`compare-ios-6-modes-and-switch-*`)

Scenes: `ios6-a-modes` (phone 2, D6 option A), `ios6-b-provider-blocked` (phone 4), `ios6-c-provider-draft` (phone 5).

Same as the board:
- **The modes**: all six; Default greyed with why, Accept Edits Current, Plan, Auto, Don't Ask with its note, Bypass.
- **A session that has talked** (C1): Automatic, Default, Team (Monthly 34%) and the Cursor key are listed and greyed, with "Cursor CLI
  can’t carry a conversation to another account or key yet. Start a new session to use one of these."
- **A new session's draft**: the same rows, each one a pick.

Different:
- **The modes' notes are the shared `permissionSemantics` ones**, as the coordinator ruled on 2026-10-18 and as the web says them:
  Default "Unsupported on Cursor CLI; session configuration is rejected", Don't Ask "Partly enforced, edits inside the workspace still
  run"; Plan and Auto have none. The board drew its own words.
- **The menu lists Bypass first**: iOS 26 lists a menu from the end nearest its control, and the mode menu opens upward from the
  composer; it does so for every engine.
- **The talked session's menu** is taken with the board's one Cursor key; with both of the fixture's keys it runs a row past the
  screen's foot.

## Found on the way

- **Auto's note ran into a fourth line** of an iPhone menu item, which ends at its third ("…no effort or co…", fixed in cf0ca8026):
  its long sentence is two items now.
- **The context ring took no tap on the phone** (fixed in 8d21aa08e). The ring is only a stroke — dashed for Cursor CLI — and a plain
  button takes a tap only where it draws, so a tap in its middle opened nothing. The whole gauge opens its sheet now.
- The probe's own faults, each fixed before the pictures' run: Settings presented in the launch's first moments was dropped; the
  Infrastructure row sits below the Settings sheet's fold; a menu row's subtitle is not in the accessibility tree.

## Probe branches (none merged)

- `probe/p7b-cursor-gates`: the client gates on 4771eab85, before the project merge (run 39165241380).
- `probe/p7b-cursor-shots`: the probe, last on e9e1b0bc1 (runs 39166881682, 39169547335, 39172008765, 39175852594 cancelled,
  39176229497, 39178766623; Android 39166881621, 39169563181, 39172013375, 39176234558, 39178766515). Its pictures and records:
  `probe/p7b-cursor-shots-results`.
- `probe/p7b-cursor-shots-3`: iOS 2, 4 and 6 again while the full run waited (run 39171352892), results in
  `probe/p7b-cursor-shots-3-results`.

## Gaps

- **Context and Speed against a real runner** are not run here: the runner reads the value and sets both since task
  34iDjteT5qGcwXKjAUKj1 (its own evidence and `scripts/test-cursor-model-variants.mjs`); the apps write it by the same shared rules
  (`CursorRuntime.encodeModel` / `decodeModel`, tested on the shared spec's cases).
- **The model menu's title has no Cursor cube** (iOS 5 ①): an image in one row of an iOS 26 menu moves every row's text.
- **A long model menu on the phone.** Cursor's catalogue lists 46 models (contract §10), so on an iPhone the menu's last rows — Effort,
  Context, Speed, Auto's note — are past the screen's foot, as Effort already is for any engine with a long list. The probe's
  synthesized swipe and drag did not scroll the open menu (run notes), so the rows are shown with a three-model catalogue; how far a
  finger scrolls it on a device was not checked here (P8).
- **Install and Reinstall** post `runners/:id/install {engine: "cursor"}`, as for every engine; the server takes it since task
  34iDkJiUemFVk3oqBYuJ0 landed on the project line. Not pressed against a real runner here (P8).
- **No real Cursor account, key, runner or prompt was used.** Every Cursor answer is a fixture in the shapes the runner and the server
  give. Signing in on another device is not measured (contract §17.1 item 6); iOS 3 assumes it works, as the board does.
- **The Mac** draws the same OrbitApp views and is built and tested in the same runs; its window was not photographed.
