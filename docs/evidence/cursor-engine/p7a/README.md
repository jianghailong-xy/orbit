# Cursor CLI on the web (P7a): the real pages beside the owner's board

This is the evidence for task 34h05g3120eIgrBmwn9hY, P7a: the web's Cursor CLI screens, in project 34gyHIZv301nDWxKP9XkO.

The board is `docs/mocks/cursor-engine/` (T0, af84e78dc). The owner confirmed it on 2026-10-17, with D1–D6 as recommended and D6 as option A. The coordinator's rulings are in the task's comments.

**Result.** All 36 "after" scenes of Web 1–6 were captured from the real page, in light and dark. Each capture sits beside the board's frame of the same name.

- Web 1 and Web 3 match the board frame for frame.
- Web 2, 4, 5 and 6 match except for the differences listed below. Each one comes from a coordinator ruling, or from a fact of the runner or the shared tables that the board's prototype didn't have.

Two kinds of board frame are not drawn: the `-now` frames (main before this change) and `w6-modes-b` (D6's option B, which the owner did not choose).

## Files

- `compare-<board>-<theme>.png`: 12 sheets, one per board (Web 1–6) and theme. Each row is one scene: the board's frame on the left, the capture on the right, at the same scale.
- `shots/<scene>-<theme>.png`: the 72 captures (36 scenes × 2 themes), under the board's frame names, in 256 colours.
- `capture/`: the kit that took them (see below).

## How the frames were taken

- **The app.** This branch's `src/web` and `src/shared` ran on vite dev (`capture/vite.mjs`) inside a private network namespace (`unshare -n`, `capture/run-ns.sh`). Nothing reached the network.
- **The API.** The repo's own fake API answered: `src/web/ui-migration/fixtures.mjs` and `session-fixtures.mjs`, with their fixed clock. Each scene's own answers came first (`capture/lib.mjs`). The data, in `capture/data.mjs`, has Cursor CLI reported the way the runner reports it:
  - **hpc**: runner 0.1.262 with Cursor CLI 2026.10.14-941492e. Default (Free plan, no reading) and Team (Pro, monthly 34%) are signed in.
  - **mac-studio**: runner 0.1.236, which predates Cursor CLI.
  - **build-box**: a runner that knows Cursor CLI but doesn't have it installed.
  - **Keys**: they include two Cursor keys, one of them refused by Cursor.
- **The shots.** Playwright's Chromium at 2× scale, en-US, Asia/Shanghai. The board's own fonts (`FONTCONFIG_FILE=/var/tmp/cursor-engine-mock/fonts.conf`) were used, so the two sides compare. Clips, selectors and frame names follow the board's `capture/scene-list.mjs` (this kit's copy is `capture/scene-list.mjs`).
- **The sheets.** `capture/compare.py` lays each board frame beside its capture. `capture/quantize.py` makes the 256-colour copies.

To take them again:

1. `unshare -n capture/run-ns.sh scenes.mjs [scene ...]`
2. `python3 -I capture/compare.py docs/mocks/cursor-engine/shots <shots> <out>`

The scripts name their own directory (`/mnt/data/tmp/p7a-shots`) and the worktree they read (`/root/.orbit/worktrees/50304226-…`, the task's first run) outright.

**Taken again from the final tree.** The task's first run stopped when its runner went offline. On 2026-10-18 the second run re-ran this kit from 64d68ad86 (tree b28a05ea7), with those two paths pointed at its own worktree and directory.
- 67 of the 72 frames came out byte-identical to the captures these copies were made from.
- The other 5 (`w3-add-pending` ×2, `w3-resign-link-dark`, `w5-running-pane` ×2) differ only inside one spinner, caught at another angle.

## Board by board

### Web 1 · New session (`compare-web-1-new-session-*`)

Scenes: `w1-engines-new`, `w1-row-not-installed`, `w1-row-signed-out`, `w1-row-update-runner`, `w1-row-version`.

Same as the board:
- Cursor CLI is listed last, with the cube and its model, Auto.
- The four ways a runner can't run it each show as the row's tag.

### Web 2 · Infrastructure (`compare-web-2-infrastructure-*`)

Scenes: `w2-overview-new`, `w2-machine-folded`, `w2-machine-open`, `w2-state-not-installed`, `w2-state-update-runner`, `w2-state-signed-out`, `w2-state-wrong-version`, `w2-attention`.

Same as the board:
- the seventh engine card;
- the machine's row: the pinned version, "pinned · checked …", Add account, and its accounts by their Orbit names with their plans;
- "Usage unavailable" where Cursor reports no share used, and a reading only above 0%;
- the four states, with Install, Update runner, Sign in and Reinstall;
- the attention line;
- every machine's count of engines signed in (Cursor CLI is counted wherever its row can get it signed in, installed or not, as with every other engine).

Different:
- `w2-state-wrong-version`: the board draws "···" beside Reinstall, and the page doesn't.
  - The runner reports no sign-in for a build it won't run: `checkCursor` in `src/runner-go/cursor_health.go` returns before the login probe.
  - That row's menu holds only Re-sign in and Pause, and both need a signed-in account, so it would be empty.
- One state the board doesn't draw: "Not supported here", for `CURSOR_PLATFORM_UNSUPPORTED`. Its hint is the runner's own sentence (contract §1). It is covered in `RunnerEngines.cursor.test.tsx`.

### Web 3 · Add account, Re-sign in, Remove (`compare-web-3-add-account-*`)

Scenes: `w3-add-pending`, `w3-add-link`, `w3-add-expired`, `w3-add-done`, `w3-resign-menu`, `w3-resign-link`, `w3-remove-confirm`, `w3-remove-refused`.

Same as the board:
- the sign-in link, with the time it has left, and "Get a new link" once it has expired;
- Re-sign in on an account;
- Remove, with its confirmation and the in-use refusal.

### Web 4 · API key (`compare-web-4-api-key-*`)

Scenes: `w4-gallery-new`, `w4-connect`, `w4-connect-invalid`, `w4-connect-unreachable`, `w4-keys-new`.

Same as the board:
- the gallery's Cursor card;
- the Connect Cursor form, at `/providers/new/cursor-api`;
- a refused key shows Cursor's words, as the server sends them, and offers no "Save anyway";
- a check that couldn't reach Cursor offers "Save anyway";
- a refused key's row says "Rejected by Cursor · … · Paste a new key".

Different:
- **"Who gets this key", first bullet.** This follows P0c's finding, as the coordinator ruled on 2026-10-17. The page says "Sessions on Cursor CLI hand it to the CLI on the runner, and commands the agent runs there can't read it." The board says commands can read the key. The finding was measured on Linux. P0b couldn't check it on macOS without a key; its follow-up (34hO5vUuVSUNrTdtUxF6b) will.
- **The keys table's Models column** shows "—" where the board's fixture shows "7". A Cursor key has no model list of its own: the shared preset `cursor-api` has `models: []` and `modelsFromRuntime: true`. Its models are Cursor CLI's, on each machine.

### Web 5 · Session (`compare-web-5-session-*`)

Scenes: `w5-model-menu`, `w5-model-variant`, `w5-running`, `w5-running-pane`, `w5-context`, `w5-quota`.

Same as the board:
- the model menu: Provider, then Auto first, then the catalogue, with Effort for a model that takes it;
- while a turn runs, the "queued for the next turn" note and the composer's placeholder;
- Context "Unavailable";
- the usage-limit card: the account and its plan, Cursor's own words, the reset day, and "start a new session on Team".

Different:
- **No Context or Speed row.** The chip reads "Claude Opus 5.5 High", not "… High · 1M · Fast".
  - The runner sets only a Cursor session's model and effort (`configure` in `src/runner-go/cursor_acp.go`), and a session has no field for the other two.
  - The board's own notes already drop Speed, since P1 declares no fast. Context goes for the same reason.
- **The Auto note** ends "…and Auto has no effort to set." The board's version is "no effort or context to set", but with no context row there is no context to mention.

### Web 6 · Modes and switching (`compare-web-6-modes-and-switch-*`)

Scenes: `w6-modes-a`, `w7-switch-blocked`, `w7-switch-draft`, `w7-switch-open`.

Same as the board:
- Default is greyed with its reason, and Accept Edits is the default. Plan, Auto, Don't Ask and Bypass are offered.
- On a session that has talked, the other accounts and keys are greyed, with the note.
- On a draft or a session that hasn't talked, every account and key can be picked.

Different:
- **The modes' short notes** are the shared `permissionSemantics` ones, as the coordinator ruled on 2026-10-17: use those, don't write new ones.
  - Default: "unsupported on Cursor CLI; session configuration is rejected".
  - Don't Ask: "partly enforced, edits inside the workspace still run".
  - Plan and Auto: no note.

  The board had wording of its own. The same applies to the draft's mode chip, which reads "Auto" rather than "Auto — file edits aren't reviewed".
- **`w7-switch-draft`**: the draft's composer shows the quota of the account Automatic would start it on (Team, monthly 34%), as it does for every engine that keeps accounts. The board's draft shows none.

## When Cursor CLI appears (P9: runners first)

`webShowsEngine('cursor', runners)` in `src/web/src/lib/runnerEngines.ts` is true once some runner of the account knows Cursor CLI. A runner knows it if it declares `provider:cursor`, or reports a `cursor` engine, installed or not (`runnerKnowsCursor` in `src/web/src/lib/cursorRuntime.ts`).

Until then, no page draws Cursor CLI: not the engine pickers, the Infrastructure card or rows, Needs attention, the gallery card, or the task engine select. See the "is nowhere…" tests in `InfrastructurePage.cursor.test.tsx` and `runnerEngines.test.ts`. So the entry opens only after the runners are updated, which is P9's order.

The gate deliberately also accepts a runner that only reports the engine. A runner declares `provider:cursor` only once the pinned build is installed and the session driver is in place. A gate on the capability alone would hide the Install that gets it there. If the coordinator rules for the stricter gate, it is a one-line change in `runnerKnowsCursor`.

## Gaps

- **The server refuses Install and Reinstall today.**
  - The web posts `POST /runners/:id/install {engine: 'cursor'}`, as it does for every engine.
  - `StartInstallDto` (`src/apiserver/src/runners/dto.ts`) allows only claude, codex, kimi, antigravity, opencode and dsh, so the server answers 400. This is true on the project line and on main.
  - The runner already installs Cursor CLI. The fix is outside this task's paths, so it is raised with the coordinator.
- **No real Cursor account, key or prompt was used.** Every Cursor answer here is a fixture in the shape the runner and server give (contract §8–13).
- **Signing in on another device is not measured yet** (contract §17.1 item 6). Web 3 assumes it works, as the board does.
- **"Who gets this key" rests on P0c's Linux finding.** macOS waits on P0b's follow-up (34hO5vUuVSUNrTdtUxF6b).
- **No frame shows a refused move.** A session that has talked can't be moved to another account or key; the page refuses before sending, as P6b's server does. If such a request does reach the server, the 409's sentence appears in the page's usual "Couldn't switch the provider / account" toast.

## Checks

The commands and their exit codes are in the task's evidence and comments:
- the web vitest suite;
- the Cursor test files and `copyLanguage.test.ts`;
- the web typecheck;
- the web build;
- OrbitKit's Swift tests, which read web sources;
- the full chain, run on the merged project line.
