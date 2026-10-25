# Kimi Code accounts on iOS / macOS — evidence

Task 34cM1TV1GJPlqc6iTps0t (project 34cLiNWD4Qj0nQOpG4uZG, criterion 6): the native half of several Kimi
Code accounts per runner, built to the iOS board `docs/mocks/kimi-accounts/02-ios.html` with the owner's
calls of 2026-10-08 — the month drawn as one window (its total, `limit_month_total`), and NEXT marked
beside the next account's name on the engine pages of all four engines that keep accounts.

## What is here

- `compare.html` / `compare-1.png` … `compare-5.png` (one per stage) — each frame of the board (left, cut
  from `02-ios.html` by `frames.cjs`, kept in `design/`) beside the same screen photographed on the real
  iPhone app (right).
- `ios-*.png` — the real screens: the app's own `CompactShell` and Settings sheet, built from this
  branch's shared sources into a throwaway app on GitHub's `macos-26` runner (iPhone simulator, iOS 26),
  driven by XCUITest against a fixture API. Downscaled from 3x to 2x.
- `probe-harness/` — that probe as it ran: `stub.py` (the fixture API: one machine, HPC, with Claude
  Code, Codex, Kimi Code and Antigravity accounts, a Kimi sign-in relay and a Kimi session),
  `UITests/KimiShotTests.swift` (what is pressed, and what has to be on screen), `project.yml`,
  `run.sh` and the workflow (`client.probe.yml`). To run it again, copy it to `.kimi-probe/` at the
  repository root (its `../src` paths are relative to there) and push it with the workflow as
  `.github/workflows/client.yml` to a `probe/…` branch. All data in it is made up.
- `probe-results/` — what that run reported: the shot tests' summary and notes, the stub's request log, and
  the macOS and iOS build and test summaries.

## Results

### OrbitKit `swift test`

Linux, from the worktree root: `docker run --rm -v "$PWD":/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test`
(this task's runs kept the build in a scratch directory with `--scratch-path`).

| tree | tests | failed |
|---|---|---|
| main 721e48275 | 3449 | 12 |
| project line 6c10d1ed9 — this branch's base, the web half merged | 3449 | 12 |
| this branch: 83a84decc, bd4848bff, c16aa0ef5 | 3465 | 12 |

The 12 are the same lines on every tree — CodexSignInCopyParityTests (4), PoolAccessCopyParityTests (5) and
SharedPoolCopyParityTests (3), which read web copy that main's Base UI pass changed — so this branch adds no
red. Its 16 new cases pass: KimiAccountsTests (14) and RunnersPageWiringTests' two (NEXT beside the name;
Add Account's name before its site); KimiSiteTests' web-words case now also holds "…the kimi.com account you
are adding…" to RunnerSignIn.tsx.

macOS, the probe run's `macos-15` job: OrbitKit `swift test` fails the same 12 and passes all 21 Kimi
cases (`probe-results/macos-swift-test-*.txt`); OrbitApp `swift build` succeeds
(`probe-results/macos-orbitapp-build-tail.txt`).

### The real screens

Branch `probe/kimi-accounts-ios` at 517076472 — this branch at c16aa0ef5 plus the harness — run
https://github.com/jianghailong-xy/orbit/actions/runs/37815558798: the iPhone probe's 11 tests passed, the iOS
app's Simulator build and the Mac app's build succeeded (`probe-results/`, raw output on
`probe/kimi-accounts-ios-results`). The probe's first run, on 83a84decc, found the Mac build broken —
`PoolChip` lived in the iOS-only ProviderPoolViews.swift — which bd4848bff fixed by giving it a file of its
own.

| board (02-ios) | real screen |
|---|---|
| ① 现在 · an older runner | `ios-01-kimi-older-runner.png` |
| ① 改后 · one account | `ios-02-kimi-one-account.png` |
| ② Add Account: the name, then the site | `ios-03-add-account-name-then-sites.png`, `ios-04-add-account-no-name.png` |
| ② kimi.com picked: the device code | `ios-05-add-account-device-code-kimi-com.png` |
| ② approved: the card folds, Work joins | `ios-06-added-work-folded.png` |
| ③ two accounts, the engine page | `ios-07-kimi-two-accounts-next-default.png`, `ios-08-kimi-two-accounts-work.png` |
| ③ the runner page | `ios-09-runner-page-next.png` |
| ③ Work's Sign In Again | `ios-10a-work-menu.png`, `ios-10-work-sign-in-again-current-kimi-com.png` |
| the runner row, b and c | `ios-21-runner-row-one-account.png`, `ios-22-runner-row-work-signed-out.png`, `ios-23-kimi-work-signed-out.png` |
| ④ the session: Provider → Kimi's accounts, moved to Default | `ios-14-…` to `ios-19-plan-usage-default.png` |
| NEXT on the four engines (the owner's call) | `ios-07-…` (Kimi), `ios-11-claude-next-team.png`, `ios-12-codex-next-pro.png`, `ios-13-antigravity-next-default.png`; dark: `ios-20-…` |

Not photographed: the board's ④ 现在 (today's model menu, with no Provider row) and the Mac — the same views
in the Mac's own drawing, built by the same run but not drawn apart (the task's step 8).

### Making these again

`frames.cjs` cuts the board's frames into `design/`, `take-shots.py` brings a results branch's screens in
(3x → 2x, 256 colours), `render-stages.cjs` renders `compare.html` into `compare-1.png` … `compare-5.png` and
`squeeze.py` keeps those to 256 colours. The two `.cjs` scripts use the Playwright and fonts this host keeps in
`/var/tmp/kimi-accounts-ios` (see `docs/mocks/kimi-accounts/02-ios.html`).
