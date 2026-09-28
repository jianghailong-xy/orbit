# TEMPORARY evidence probe — the shared pool in the iOS picker and composer

Lives only on the `-shots` branch; never merged, never pushed to the branch under test.

It photographs the change in `43f35dcba` (*a shared pool is a pick under Codex, in the session picker
and the composer*) on an iOS 26 simulator, over the same "Team Codex" fixture the shared-pool page
probe uses (`orbit/ios-macos-add-a-key-346895-shots`).

Two apps, one project, one job:

- **PoolProbe** — the pure views, with the real files copied in by `gen.py`:
  `Views/AgentIdentity.swift` whole (that is `ProviderSwitchSheet`, `ProviderMark` and
  `PoolCountBadge` verbatim), plus brace-balanced slices out of `Views/ComposerView.swift` for the
  composer's plan-usage pill and the pool row in its toolbar. The choices come from the real
  `SessionProviderChoices.choices(configured:catalog:engines:pools:)` over real
  `SharedPools.asProviderPool`-adapted pools and `ProviderPools.asProviders`.
- **OrbitProbe** — the *real* iOS app (`src/ios`'s target definition, re-declared here), driven by a
  UI test against a stub server on `127.0.0.1:8787` (`stub.py`, on the runner's host — the simulator
  reaches it directly; ATS is off in the generated copy of `Support/Info.plist`). The test signs in
  with the real `LoginView`, opens the real new-session draft, opens the real provider picker, picks
  Team Codex, and sends a message — so screens 1–4 are the app's own layout, not a composition.

The stub writes the `POST /api/sessions` body it received to `<shots>/session-create.json`; with
`provider: "team-codex"` in it, that file is the evidence the session was created on the pool.

`ios/run.sh` runs both schemes (each scheme's PNGs land in the shots directory via
`TEST_RUNNER_SHOTS_DIR`) and fails if not one PNG was produced. Run with
`bash .pool-probe/ios/run.sh`, or through the `pool-shots-ios` job in `.github/workflows/client.yml`
(dispatch: `gh workflow run client.yml --ref <shots branch>`).
