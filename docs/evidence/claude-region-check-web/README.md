# Claude region check: web, against board 02

Evidence for task "Region check: web" of project "Claude region check" (docs/claude-region-check-contract.md,
design of record docs/mocks/claude-region-check). Every frame here is the real page of this branch, in Chromium,
fed the board's own fixtures. Nothing is injected into the DOM; the board's prototype had to inject its machine
card, list words and header words (`capture/scenes.mjs` of the board).

## How the frames were made

- **The app:** this branch's `src/web` and `src/shared` on vite, with the repo's `src/web/ui-migration` fake API. The
  scenes are `capture/scenes.mjs`: board 02's own scenes (`docs/mocks/claude-region-check/capture/scenes.mjs`), with
  the verdict on `runner.region` instead of the prototype's engine health.
- **The data:** the board's fleet (`data.mjs`, a copy of `docs/mocks/infrastructure-focus/capture/data.mjs` with its
  import repointed, as the board's kit did), its keys and its session fixtures. The clock is the fixtures' frozen
  2026-09-28T12:00Z, the zone Asia/Shanghai, Inter / Noto Sans SC / JetBrains Mono at 2x.
  - HPC reads `region: { verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false,
    checkedAt: '2026-09-28T11:58:00Z' }` (19:58 in Asia/Shanghai).
  - The held session is `QUEUED` with the contract's refusal sentence as its error. That is the §9 sentence, without the
    prototype's `[CN]` suffix. Its transcript also holds the runner's own error event for the refusal, which draws
    nothing.
- **The crops:** board 02's six shots are cut from its full captures. `capture/findcrop.py` and
  `capture/findscaled.py` found each cut, and `capture/compose.py` cuts this branch's captures the same way:
  - the machine cards and the held session: the whole capture, scaled;
  - the first message: CSS px (620, 0)–(1280, 520), scaled;
  - the hero: (660, 330)–(1240, 770), scaled;
  - the Provider menu: (520, 350)–(1100, 710), unscaled.

  Then `compose.py` writes `frames/<frame>.compare.png` (board left, this branch right) and counts the differing
  pixels (`board-vs-real.txt`).
- **Run it again:** `unshare -n capture/run-ns.sh <tree> shoot.mjs <scene…>`, then `python3 capture/compose.py <out>`.
  The paths in the kit are this machine's; `capture/native.sh` is the OrbitKit/Android runner below.

## The six frames of board 02, and every difference

| Board 02 frame | This branch | Pixels that differ (of the shot) | What differs |
| --- | --- | --- | --- |
| A, today (`web-machine-today`) | `mm-null`: HPC with `region: null` | **0** | Nothing. |
| A, final (`web-machine-new`) | `mm-new` | 123, none by more than 30/255 | Anti-aliasing in "2.1.302 · 3 accounts": the real line is three text nodes, where the board injected one string. |
| B, held (`web-session-held`) | `s-B` | 1373 | Only the sidebar's ⌘P and ⌘1 chips and the right end of the selected workspace's tint, all within CSS x 236–270, which end a few px further left. Main's sidebar keeps room for its scrollbar since 4192bd06f (Sidebar scroll), which landed after d6f363a6c, the commit the board was captured on. Nothing in this task touches the sidebar. The list row ("Anthropic unavailable on HPC"), the header ("Anthropic unavailable on HPC · Open · 36m ago"), the missing working clock, the card and the composer are pixel for pixel the board's. |
| B, first message (`web-session-first`) | `s-A` | **0** | Nothing. |
| C, new session (`web-picker-closed`) | `hero-new` | **0** | Nothing: "Claude Code · Region not supported on this runner · Details". |
| C, Use another provider (`web-provider-menu`) | `prov-new` | **0** | Nothing. The menu was opened by pressing the card's **Use another provider**, where the board hovered the composer's Provider row. |

What the board does not draw, from the same kit (`extra/`):

- `mm-new-open.png`: the blocked Claude Code row with its accounts opened. The group is kept, and the head still shows
  the badge and —. Each account reads Signed in (never Available), shows — for quota, offers no Sign in, Re-sign in or
  renew, and none is marked NEXT.
- `hero-new-open.png`: the new-session engine list. Claude Code stays pickable, landing on the DeepSeek key
  ("DeepSeek V4.1 Flash 1017"), because another credential can run it. It greys only when none can (vitest).
- `s-stopped.png`: a turn stopped by a confirmed flip (decision ④). There is no card; the stopped sentence stands
  without its code under the turn, and the header keeps its ordinary words.
- `prov-new.png`: the whole page behind the Provider menu frame.

## A runner with region null draws what it draws today

`region-null.txt` compares the base tree (the project line's tip before this task, 442088f25, whose `src/web` is
main 598ebb401's) with this branch, scene by scene, at 2x. The scenes are: the HPC card with no `region` field, with
`region: null` and with an allowed region; a queued session; the new-session hero; and the composer's Provider menu.
**All nine comparisons are 0 differing pixels.** vitest asserts the same per surface: `RunnerEngines.claudeRegion` compares
markup, and `NewSessionProviderHero`, `sessionProviderChoices`, `runnerAttention` and `claudeRegion` compare results.

## Rules the iOS and Android tasks can follow

- **Held:** run state QUEUED and `session.error` starting `CLAUDE_REGION_UNSUPPORTED: ` (`claudeRegionHeld`). It draws:
  - the card, cause REGION_UNSUPPORTED (`RunNeverStartedCard`), read by that code alone and before any cause read by
    pattern, since a machine's name can hold those words;
  - 'Anthropic unavailable on {machine}' in the list row, the header and the status glyph's tip;
  - no working clock over its message.
- **The card's place** comes from `runner.region` while its verdict is blocked:
  - subject `CLAUDE_REGION_UNSUPPORTED · {regionCode ?? country}`, which names Ukraine's excluded regions by their own
    code (UA-43);
  - detail `Checked {HH:MM, or a weekday and HH:MM on another day} · Claude’s connection: {name} (no proxy | through a
    proxy)`;
  - body: the §9 sentence without its code, from the shared writer.

  With `region` null or no longer blocked, the body is `session.error` without its code, the subject is the bare code,
  and there is no detail.
- **Its presses:**
  - Use another provider opens the composer's model menu on its Provider level. It is drawn only where that menu lists
    more than one credential.
  - Move to another machine opens Move.
  - Check again (`POST /runners/:id/region-check`) is drawn only where `region` is not null. It reads the runners again
    every 2 s until `region.checkedAt` reaches the request, for up to 30 s.
  - A FAILED run from a control plane that predates the hold ends "Ended · no engine ran · 0 turns".
- **The transcript** (the coordinator's rule, `claudeRegionErrorLine`). For an `error` event whose message starts
  `CLAUDE_REGION_UNSUPPORTED: `:
  - a refusal draws **no line**, because the card says it, and the turn counts as answered (no "turn ended without a
    reply" marker);
  - the stopped sentence, matched by the whole shape of the shared `claudeRegionStoppedError` so that a machine named
    like it is still a refusal, draws as the turn's error line **without the code**;
  - a stopped turn has no card.
- **Provider rows** (`credentialIsAnthropicBound`, Claude Code only), on a blocked runner:
  - Claude Code's own sign-in, a Claude pool and a key on the `anthropic` preset read `{name} — Region not supported`.
    This outranks Not installed or Not signed in, because no install or sign-in changes it.
  - No accounts are offered under the sign-in.
  - The row names no fix. Its press still opens the machine's Claude Code row, which explains.
  - The engine row greys (`regionBlocked`) only when no credential can run Claude Code, and the hero then says
    **Details**.
- **The machine card** (board 02 A): the attention line, no Claude Code chip, the orange badge, — for quota, Check
  again in place of Add account, Sign in and Re-sign in, and the note with the check line. The attention kind is
  `claudeRegionUnsupported`:
  - tone warn, title "Claude Code can’t use Anthropic here";
  - detail "Anthropic doesn’t offer Claude in {region}." (board 03);
  - action `checkRegion`.

  While a machine is blocked, Claude Code's own signed-out and quota items are not raised, and a signed-out Claude Code
  does not count toward "No coding CLI signed in".

## Tests

**web vitest, 58 new tests:**

| File | New | What they cover |
| --- | --- | --- |
| `lib/claudeRegion.test.ts` | 7 | The runner verdict from `region` (null, absent and allowed are never blocked). The code read off an error. The transcript rule: a refusal draws no line, a stopped turn its sentence without the code, and a machine named like the stopped sentence is still a refusal. A held session and its words. The copy against the shared writer. |
| `components/RunNeverStartedCard.region.test.tsx` | 11 | The cause REGION_UNSUPPORTED: why, body, link, subject, detail, the three actions and the foot. The proxy wording. UA-43. The place taken from `region`, never from the sentence. The fallback when `region` is null or allowed. The cause outranks every pattern cause whatever the machine is called. The ended foot. No card for a stopped turn. The three buttons drawn, filled first, each running its own press. The busy state. In four zones. |
| `components/WorkspaceView.claudeRegion.test.tsx` | 7 | On the real session page: the card under the held message with its three ways out; Anthropic unavailable on HPC in the header and the list; no working clock and no coded line. Check again POSTs `/runners/:id/region-check`. Move opens SessionMoveModal. Use another provider opens the composer's Provider menu: Default, DeepSeek, `Personal Max — Region not supported`, `Work — Region not supported`, Local vLLM, and no "fix it →". |
| `lib/sessionProviderChoices.test.ts` | 7 | Anthropic-bound credentials (sign-in, Claude pool, Anthropic key) read Region not supported under Claude Code; other keys do not. Region outranks Not installed. Claude only. Null and allowed draw today's rows. The engine row stays pickable while another credential can run it, and greys only when none can. The draft's hero names the reason. |
| `components/NewSessionProviderHero.test.tsx` | 2 | Details, not Fix it, linking to the machine's Claude Code row. Null and allowed draw today's markup. |
| `components/RunnerEngines.claudeRegion.test.tsx` | 8 | The attention line and no Claude Code chip. The row as board 02 A: badge, —, Check again (no Add account or Sign in), the note with Supported regions, and the check line. The proxy wording. Check again POSTs, and is held while the machine is offline. The opened accounts. Null and allowed draw today's markup. |
| `lib/runnerAttention.test.ts` + `runnerAttention.cases.json` | 3 + 7 cases | `claudeRegionUnsupported`: its words, its order after Codex signed out, no Claude sign-in or quota item in its place, no "No coding CLI signed in" from a signed-out Claude, nothing while allowed, and only Offline while offline. The detail, params and action. |
| `components/Transcript.claudeRegion.test.tsx` | 4 | No line for a refusal, and the turn counts as answered. The stopped sentence without its code. Other errors as before. |
| `components/ui/Menu.submenuOpen.test.tsx` | 2 | A menu level its page opens (what Use another provider needs). A level nobody controls opens as before. |

- **Full web suite**, `VITEST_MAX_WORKERS=2 npx vitest run` in `src/web`, the project merge check's web step, at the runner's
  Asia/Shanghai: **461 files, 6082 tests, all passed.**
- **The touched files at UTC:** 55 files, 906 tests before the new ones, all passed. **At Asia/Shanghai:** 43 files, 691
  tests, all passed.
- **`npm run build -w @orbit/web`:** passes.
- **OrbitKit and Android against main.** runnerAttention.cases.json gained cases both native suites run, so
  `claudeRegionUnsupported` is ported to OrbitKit (`RunnerAttention`, `Runner.region`, `ClaudeRegionCopy` with
  `ClaudeRegionCopyParityTests`) and to Android (`RunnerPage`, with a `RunnerPageTest`). Both suites ran with
  `capture/native.sh` on git archives:
  - **OrbitKit:** `swift test` in swift:6.1, as ci.yml's Swift core.
  - **Android:** `:core:test :app:testDebugUnitTest`.

  | Suite | main b94defcbe | main + this branch (trial merge cf44bc276) |
  | --- | --- | --- |
  | OrbitKit `swift test` | 4274 tests, 5 skipped, 0 failures | 4277 tests, 5 skipped, 0 failures |
  | Android `:app:testDebugUnitTest` | 1972 tests, 0 failed | 1973 tests, 0 failed |
  | Android `:core:test` | 310 tests, 0 failed | 310 tests, 0 failed |

## Revision 2: the macOS and iOS apps build

Revision 1 added two enum cases to OrbitKit (ba56233df) and did not change OrbitApp:
`RunnerAttentionKind.claudeRegionUnsupported` and `RunnerAttentionActionKind.checkRegion`. OrbitApp switches over
both exhaustively:

- `runnerAttentionGlyph` in `Views/RunnerPageParts.swift`;
- `attentionButton` in `Views/SkillsRunnersView.swift`.

OrbitKit has no library evolution, so the macOS and iOS apps stopped compiling. Nothing that runs on Linux compiles
OrbitApp. **fed5eae30 adds both cases:**

- the glyph is `exclamationmark.triangle`, the warning the web draws;
- `.checkRegion` draws nothing (`EmptyView()`) until the iOS and macOS region task wires Check again.

**No other switch is left:**

- No other switch in OrbitApp or `src/ios` names a member of either enum. `SkillsRunnersView.swift:189` and
  `InfrastructureSections.swift:111` switch over `Infrastructure.Attention.Kind`, and `RunnerPageParts.swift:39` over
  `RunnerPageFormat.Presence`, neither of which changed.
- The other Swift API this branch changed (`Runner.region`, `RunnerAttentionRunner.region`, `noCliSignedIn`'s
  defaulted `region:`) is not constructed or referenced from OrbitApp or `src/ios`.
- In OrbitKit, the two files that use the enums have no platform gates, so the Linux suite compiled them.

**A real build of fed5eae30:** client.yml dispatched on `probe/region-check-web`, run **41247260446**, all jobs
**success**. The probe branch was deleted afterwards.

| Job | Conclusion | What its log says |
| --- | --- | --- |
| macOS (build + test), 124673338064 | success | OrbitKit `swift test` on macOS: "Executed 4180 tests, with 5 tests skipped and 0 failures", `ClaudeRegionCopyParityTests` among them. OrbitApp `swift build`: "[406/460] Compiling OrbitApp SkillsRunnersView.swift", "[456/482] Compiling OrbitApp RunnerPageParts.swift", "Build complete! (167.80s)". |
| iOS (generate + build), 124673337911 | success | "SwiftCompile normal arm64 …/OrbitApp/Views/SkillsRunnersView.swift (in target 'Orbit' from project 'Orbit')", the same for `RunnerPageParts.swift`, then "** BUILD SUCCEEDED **". |
| Navigation and Font tokens | success | |

- **Android:** reads `SkillsRunnersView.swift` only for an unrelated sentence (`InfrastructureCopyParityTest`), so
  revision 1's runs stand.
- **web vitest on fed5eae30:** 461 files, 6082 tests, all passed. The web did not change, so the screenshots stand.
