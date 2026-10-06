# P5 — DeepSeek Harness on Web, macOS and iOS

Task: [P5：接通 Web、macOS 和 iOS 的 DeepSeek Harness 操作链](orbit-task:34ZvIEP5zPthoB44dNQBn).
Branch `orbit/p5-web-macos-ios-deepseek-harness-aa3ee1`. Executed on HPC (Linux), no local Mac:
Web was driven in headless Chromium; macOS/iOS were compiled and photographed on GitHub Actions
through push-triggered probe branches (never merged).

## What the clients do now

- **Identity.** A configured key with runtime `dsh` (preset `deepseek-harness`) resolves to the
  `dsh` runtime in web `runtimeForProvider` and native `AgentDefaults.runtime` /
  `SessionProviderChoices.executingRuntime`. The existing `deepseek` preset keeps running on Claude
  Code; picker rows say which: `DeepSeek Harness · Harness` vs `DeepSeek · Claude Code`, Providers
  says "Runs on DeepSeek Harness" / "Runs on Claude Code".
- **Model / thinking level.** From the assigned runner's `modelCatalog.dsh` (opaque ACP values, the
  row's `reasoningLevels`, e.g. Off/Low/High/Max). A model the runner has not reported offers Default
  only; nothing falls back to a Claude model (`defaultModel` is `''`).
- **Approvals.** A Harness card offers Approve / Reject (web) and Allow / Deny (native) only — no
  "Always allow" / "Allow & remember": the runner's Harness bridge answers each ask once and drops
  remember rules (dsh_permissions.go). Decided by the session's runtime (`approvalRememberOffered`,
  `Approvals.rememberOffered`); every other runtime keeps remember.
- **Permission modes.** Only Default, Auto and Don't Ask are selectable; Plan, Accept Edits and
  Bypass are disabled with the shared table's note (web) / "— not on DeepSeek Harness" (native), and
  a stored unsupported mode is clamped to Default. Parity: web test compares with
  `derivePermissionSemantics(...).honored`; OrbitKit test parses `DSH_PERMISSION_MODES` from
  `src/shared/src/enums.ts`.
- **Availability.** `dshRunnerState` (web) / `DshRuntime.state` (native): no `provider:dsh`
  capability → "Update runner"; `DSH_PLATFORM_UNSUPPORTED`/`DSH_NODE_UNSUPPORTED` → "Not supported
  here"; not installed → "Not installed" (Install from Providers / the runner's engine page / the
  repair card); incompatible version → "Unsupported version". No Harness key → a "DeepSeek Harness —
  Add API key" row that opens the connect form.
- **Session failures.** `dshRepair` / `DshRuntime.repair` turn `DSH_CREDENTIAL_MISSING`, a rejected
  key (the runner's own invalid-key evidence only, not rate limits), the old-runner refusal,
  `DSH_NOT_INSTALLED` and platform refusals into cards with the fix (Update the API key, Install,
  Retry).
- **Interaction limits.** No runner slash commands and no `!` shell turns on Harness (the runner has
  no shell bridge); messages sent mid-turn queue (shared `supportsMidTurnSteer` is NEVER for dsh).
  Text/thinking blocks render as they arrive — the runner emits committed ACP blocks, not tokens.

## Operation chain evidence

All three clients ran against fixtures that advance only when the client sends the real request;
none of this is a real runner or model (end-to-end with real dsh is P6).

| Step | Web (real console, Chromium) | iOS (iPhone simulator) | macOS |
|---|---|---|---|
| choose engine / model / effort / mode | `web/web-1b-provider-picker-*`, `web-2-mode-menu-*`, `web-2b-model-menu-*`, `web-2c-effort-menu-*` | `ios/1b-provider-picker-*`, `2-mode-menu-*`, `2b-model-menu-*` | `mac/1b-provider-picker-*`, `2-mode-menu-*` |
| run (send → thinking, text, tool + result) | `web-3-running-*` | `3a-compose-typed-light`, `3b-running-light` | same names |
| approve | `web-4-approval-*` → Approve | `4-approval-*` → Allow | same |
| after approval (write done, next tool running) | `web-5-approved-running-*` | `5-approved-running-*` | same |
| stop | `web-6-stopped-*` (tool failed, interrupted) | `6-stopped-*` | same |
| continue | `web-7-resumed-*` | `7-resumed-*` | same |
| invalid key / no key / not installed / old runner | `web-8*` | `8*` | same |
| picker: old runner / not installed / no key | `web-9*` | `9*` | same |
| Providers / connect / runner engine row | `web-10*`, `web-11*` | — | — |

Each platform's request log shows the presses reached the fixture as the client's own requests:
`POST /api/sessions` (provider from the workspace, opaque model token, `permissionMode`), the
approval decision `{"behavior":"allow"}`, `POST …/interrupt`, and the follow-up turn —
`web/requests.log` (light and dark passes), `ios/writes.txt`, `mac/writes.txt`.

Fixture/live differences: the fixtures append canned events when the request arrives; web and native
receive them over the same SSE stream format the server uses (`data:` frames). Session creation does
not go through server admission, so the old-runner state is shown as the queued refusal message rather
than the 409 the server returns at create time.

## Reproduce

- Web: `web-rig/` — `node server.ts` (fake API with a live SSE session stream, port 3995), vite with
  `vite.config.mjs`, then `THEME=light|dark node drive.mjs ./plan-full.mjs` and `./plan-menus.mjs`
  (headless Chromium over CDP). `server.ts` and `vite.config.mjs` name this worktree's absolute path;
  point them at your checkout. The frames in `web/` were taken on `7ca6ab87e` (half size);
  `web/requests.log` holds both passes' requests, and the four writes appear once per theme.
- Native: probe branch `probe/p5-dsh-shots` (`.dsh-probe/`: `stub.py`, iOS `CompactShell` / Mac
  `MainView` probe apps, `DshShotTests` XCUITests that fail on any state that does not render);
  results on `probe/p5-dsh-shots-results`.

## Runs and results (code under test: `c5cc1e0fe` — P5 merged with `origin/main` 5b132c135, plus the remember and Mac-menu fixes)

- The approval chain is created in **Default** on every platform (the clients pick Default in the
  Mode menu; the fixtures echo the requested mode): under P4's semantics Default makes the NOTES.md
  write ask, Auto would not. Every create body carries `"permissionMode":"default"`
  (`web/requests.log`, `ios/writes.txt`, `mac/writes.txt`), and the native tests fail without it.
- Native shots: GitHub Actions run 37396127964 on probe `probe/p5-dsh-shots` (cef716b87 = `c5cc1e0fe`
  + `.dsh-probe/` + a push-triggered workflow; copies in `probe-harness/`), results branch
  `probe/p5-dsh-shots-results` (3bb160b83). iPhone (newest simulator) 5/5 and Mac 5/5 XCUITests passed.
  The tests `XCTFail` on any state that does not render, on a missing engine switch or Mode item, and
  on any of the writes missing from the stub's log (`native-test-summary.txt`, `*-notes.txt`). iPhone
  pictures are stored at half size.
- Client compile gates: run 37396122482 on `probe/p5-dsh-clients` (`c5cc1e0fe` + gates-only
  client.yml, `probe-harness/client-gates.yml`): macOS OrbitKit `swift test` 2966 executed / 5 skipped /
  0 failures, OrbitApp `swift build` success, iOS simulator build success.
- OrbitKit on Linux (swift:6.1 docker, `cef6c8e0d`; `c5cc1e0fe` changes only OrbitApp's ComposerView):
  2966 executed / 5 skipped / 0 failures.
- Merge check on `c5cc1e0fe` (`merge-check-c5cc1e0fe.txt`): `npm run build` 0, `npm test -w
  @orbit/shared` 0, `npm test -w @orbit/apiserver` 0 (4422), `npm test -w @orbit/web` 0 (3931),
  `go test ./...` in src/runner-go 0.
- Web frames in `web/` were taken on `cef6c8e0d`, whose web code is identical to `c5cc1e0fe`;
  `web/requests.log` holds both passes.

Probe branches `probe/p5-dsh-shots`, `probe/p5-dsh-clients` and their `-results` branches are
temporary and never merged. Earlier shots runs are not evidence — notably 37343111078, whose tests
could not fail and whose console frames show a cached transcript (no stream in that stub).

## Not established here

- No real runner, dsh process or model: every state comes from the fixtures above. Real dsh +
  runner end to end is P6.
- macOS: the model menu is photographed open (`mac/2b-model-menu-*`), its Effort submenu is not; the
  levels are covered by OrbitKit tests and by the iPhone and web menus. The Mac shots also showed that
  every row of the composer's menus carried a tick (pre-existing, not Harness-specific); fixed in
  `c5cc1e0fe`.
- When the assigned runner reports no Harness catalogue (an old runner), a session's opaque model
  value is shown raw in the composer; a workspace still set to a deleted Harness key shows the slug
  with the generic removed-provider fallback ("Claude via deepseek-harness").
- Platforms other than the newest iPhone simulator and the CI Mac (no iPad, no physical device).
