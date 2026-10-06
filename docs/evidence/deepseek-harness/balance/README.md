# DeepSeek account balance on Web and iOS

Task: [（首版后）在 Web 和 iOS 的 DeepSeek provider 处展示账户余额](orbit-task:34ayVD7EJu0uIG1SCgBPv) — the
owner's option D (2026-10-06): show the DeepSeek account's balance, nothing else. Mocks the owner confirmed:
`mocks/deepseek-balance/` (web-01…05, ios-01, light and dark) in the coordinator's uploads.

DeepSeek reports one thing about an account's money, `GET https://api.deepseek.com/user/balance`
(`is_available`, `balance_infos[]` of string amounts). It has no per-request or per-day spend API, so what
is shown is the balance of the whole account the key belongs to — every app and person using that
account draws on it — and every surface says so.

## What was built

- **apiserver** — `GET /api/providers/mine/:id/balance` (`providers/deepseek-balance.service.ts`). The
  server decrypts the stored key and asks DeepSeek's fixed `/user/balance`; the key never leaves it (no
  response carries it, and DeepSeek's error text — which can quote the key — is never passed on).
  Reads are cached per key, keyed by an HMAC of the key under a per-process secret: 90 s, shared by
  every provider holding that key (each names the others in `sharedWith`). `?refresh=1` skips the cache
  but asks DeepSeek at most once per 10 s for a key; concurrent reads share the request in flight.
  Success `{ ok: true, balances, isAvailable, fetchedAt, sharedWith }`; failure `{ ok: false, reason:
  KEY_REJECTED | NETWORK | UPSTREAM_ERROR, message, fetchedAt, sharedWith }` with no amount at all (an
  unreadable body, or one listing no currency, is UPSTREAM_ERROR, never zero). A DeepSeek key is
  preset `deepseek` / `deepseek-harness`, or a custom provider whose endpoint host is `api.deepseek.com`;
  any other provider is refused 400, another owner's 404. Types in `src/shared/src/dto.ts`
  (`ProviderBalance`).
- **Web** — `components/DeepSeekBalance.tsx` (+ `.css`), `lib/deepseekBalance.ts`. The Providers list gives
  each DeepSeek row a balance line; a DeepSeek key's edit page has a "DeepSeek account balance" section right
  under the API key: normal, multi-currency, too low (`is_available=false`: red alert, real amount, "Top up
  on DeepSeek" to platform.deepseek.com/top_up), key rejected, network error, DeepSeek error, loading. A
  failure shows why and Retry, and "Balance unknown" — no amount anywhere; no `?? 0` fallback exists.
- **iOS** (OrbitKit + OrbitApp) — `OrbitKit/App/DeepSeekBalance.swift`, `Models/ProviderBalance.swift`,
  `APIClient.providerBalance`, `NavNode.providerDetail`; `ProviderPoolViews.swift` (`DeepSeekKeyPageView`,
  the key rows), `SettingsSheet.swift` (loads the balances, registers the page), `AgentsModel.swift` (the
  reads). In Settings → Providers a DeepSeek key's row ends with its total ("Unavailable" in orange when
  there is none) and opens a read-only page whose first section is the balance; changing the key still
  happens on the web. macOS has no Providers page, so nothing changed there beyond the shared sources
  compiling.

## Tests

- **Server** — `src/apiserver/src/providers/deepseek-balance.spec.ts`, 15 cases: the fixed `/user/balance` URL
  with `Bearer <stored key>` and `redirect: manual`, never the preset's `/anthropic` base; every currency kept;
  `is_available=false` with its real amount; 401 and 403 → KEY_REJECTED with no amount and none of DeepSeek's
  error text; refused/unreachable and timed-out → NETWORK; 503/429/302 and unreadable or empty bodies →
  UPSTREAM_ERROR; two providers holding one key share one read (one request, same `fetchedAt`, each names the
  other) while another key is another read; reads arriving together share the request in flight; 90 s cache;
  `refresh` skips it but asks DeepSeek at most once per 10 s for a key (a refresh through one provider serves
  the other); a failed read is cached and retried by a refresh past the throttle; only the owner's own
  DeepSeek keys (another owner's 404, Anthropic and a non-DeepSeek custom host 400, keyless 404); the
  detection rule; the parser. `pool-security-boundary.pg.spec.ts` now sweeps the route: the owner's
  DeepSeek key answers 200 with a balance and no credential in the body, another owner 404, a non-DeepSeek
  key 400, a shared provider 404, a pool id 404 (as the owner and as a person of the pool). Three other pg
  specs that build `ProvidersController` provide its new dependency.
- **Web** — `components/DeepSeekBalance.test.tsx` (21) and `lib/deepseekBalance.test.ts` (11): every state of
  the list line and the edit section (normal, multi-currency, too low with the top-up link and button, key
  rejected, network, upstream, a request that never reached the server, loading), each failure and loading
  asserted to show no currency sign and no 0; Retry/Refresh send `?refresh=1` and the sibling provider's read
  is invalidated; the pages: which rows get a line (both presets and a custom `api.deepseek.com`, not
  Anthropic or another custom host), the section sits right under the key, nothing on a page that only
  connects a key; and a source check that neither file falls back with `?? 0` / `|| 0`.
- **OrbitKit** — `DeepSeekBalanceTests` (10): decoding the server's answers (public-id twins included), the
  state each comes to (a read, low, every failure, the unreachable request, an `ok` with no balance → failure,
  never zero), the row's value ("Unavailable" in orange, never an amount, for every failure), amounts,
  splits, times, which providers are DeepSeek keys and the slug match from the catalogue row.
  `DeepSeekBalanceCopyParityTests` (4) hold the phone's words to the web source.

## Screenshots

### Web — the real console, light and dark (`web/`)

This checkout's own web console, served by vite (`web-rig/vite.config.mjs`) with `/api` answered by
`web-rig/server.mjs`, whose DeepSeek keys answer the balance route in the server's shape and in every state;
headless Chromium driven by `web-rig/drive.mjs` signs in with a fake token, opens each page, waits until the
state it is meant to show has rendered, presses Refresh where a user would, and screenshots at 2×. Each
check it makes is in `web/checks-light.json` (34/34) and `web/checks-dark.json` (33/33; Refresh is pressed
in the light pass only); a page that did not render its state fails the run.

| Mock | Screenshot (`-light` / `-dark`) | What it shows |
|---|---|---|
| web-01 | `web-01-providers` | DeepSeek and DeepSeek Harness on one key: the same "Account balance ¥110.00 · updated 2 min ago ⟳"; Anthropic and Kimi have none |
| web-02 | `web-02-providers-states` | every row state: normal, two currencies, too low (red, "Top up on DeepSeek ↗"), API key rejected, network error, DeepSeek error (orange, "Retry"), loading ("Checking account balance…") |
| web-03 | `web-03-edit-deepseek` | the DeepSeek key's edit page: the section right under the API key — total, granted/topped-up bar and legend, "Updated 2 min ago", Refresh, "Top up on DeepSeek ↗", the whole-account note, "Same DeepSeek account as DeepSeek Harness — both show this balance." |
| web-04 | `web-04-edit-deepseek-harness` | the same for the DeepSeek Harness key, naming DeepSeek |
| web-05 | `web-05a…f-section-*` | the section in each other state: multi-currency, too low, key rejected, network, upstream error, loading — the failures say why, "Balance unknown", Retry, and no amount |
| — | `web-06-edit-refreshed-light` | after pressing Refresh: `?refresh=1` reached the fixture and the section reads "Updated just now" |

### iPhone — the app on the simulator, light and dark (`ios/`)

The iPhone app's own `CompactShell` and Settings sheet, built from this branch's shared sources into a
throwaway app (`probe-harness/`, pushed as the never-merged branch `probe/ds-balance-shots`) on GitHub's
macOS runner, against `probe-harness/stub.py` — the fixture API's DeepSeek keys answer the balance route in
every state. Each launch lands on Settings; `BalanceShotTests` taps its Providers row and each DeepSeek row,
presses Refresh and Retry, and fails on any state that does not render, on a row of another vendor that opens
anything, and on a failure or loading page that shows any amount (`¥`, `$` or `0.00`). Pictures are stored
at half size.

Run **37444789565** on probe commit `1d226459d` (= `b6879ca74` + `.dsb-probe/` + a push-triggered workflow), newest
iPhone simulator on `macos-26`: `BalanceShotTests` 2/2 passed, 0 failures (`ios/summary.txt`, notes in
`ios/*-notes.txt`); every page's accessibility tree is on the results branch `probe/ds-balance-shots-results`.
The app's own requests are in `ios/balance-requests.txt` — including the two presses, `GET
/api/providers/mine/p-ds/balance?refresh=1` (Refresh) and `…/p-old/balance?refresh=1` (Retry).

| Mock (ios-01) | Screenshot (`-light` / `-dark`) | What it shows |
|---|---|---|
| Providers 列表 | `ios-01-providers` | "Your API keys": DeepSeek and DeepSeek Harness end with the same ¥110.00 and open a page; Anthropic and Kimi are unchanged and open nothing |
| — | `ios-04-providers-states` | ¥0.42 in red (too low), "Unavailable" in orange (rejected key, unreachable), "¥110.00 · $5.00", nothing while loading |
| DeepSeek 详情 · 正常 | `ios-02-deepseek`, `ios-03-deepseek-harness` | the balance section first: total, granted/topped-up bar, Updated, Refresh, Top up on DeepSeek; the whole-account footnote and "Same DeepSeek account as …"; then Runs on / Default model / Endpoint, "Adding or changing a key happens on the web." |
| — | `ios-02b-deepseek-refreshed-light` | after Refresh: "Updated Just now" |
| DeepSeek 详情 · 无法获取（Key 无效） | `ios-06-key-rejected`, `ios-07-network` | the orange block with the reason ("Change the key on the web, then retry." for a rejected key), Balance Unknown, Last tried, Retry — no amount |
| DeepSeek 详情 · 余额不足 | `ios-05-low` | the red alert first, the real ¥0.42, and the prominent "Top up on DeepSeek ↗" (Safari) |
| — | `ios-08-multi-currency`, `ios-09-loading` | two currencies, each with its own bar; "Checking balance…" with no number |

Earlier runs of the same probe are not evidence: 37440215512 never drew a page (the probe app put the model
in the environment inside the sheet modifier, so the sheet had none — a harness bug, fixed in
`probe-harness/ios/DsbProbe.swift`), and 37442347703 passed but opened Providers programmatically while the
sheet was still presenting, which left the large title over the list's first section in its list frames;
the run above taps the Settings row instead.

## Merge check and client gates

- **Merge check** on `4a5d8289177fb6aefc46e782fe076e1110677c99` — this branch with the latest `origin/main`
  (`162774e52`) merged in — each step run on its own (`merge-check-4a5d82891.txt`, Orbit job
  `bgj_c996beaf69bf`): `npm run build` **0**; `npm test -w @orbit/shared` **0** (393); `npm test -w
  @orbit/apiserver` **0** (4518 tests, 4518 pass, 0 skipped); `npm test -w @orbit/web` **0** (325 files,
  4097 tests); `(cd src/runner-go && go test ./...)` **0**.
- **Client compile gates** (client.yml's own jobs, pushed as `probe/ds-balance-clients`):
  run **37441771692** on `b6879ca74` (this branch + main `5a8edfd62`; nothing under `src/macos`, `src/ios`,
  `.github` or `scripts/ci` differs from `4a5d82891`) — font tokens, navigation gate, macOS (OrbitKit `swift
  test`: 3127 executed, 5 skipped, 0 failures, `DeepSeekBalanceTests` and `DeepSeekBalanceCopyParityTests`
  passed; OrbitApp `swift build` succeeded) and the iOS simulator build, all success. Earlier run
  37439559983 on the feature commit `936ebbd3c`: the same, 3113 executed, 0 failures.
- **OrbitKit on Linux** (`swift:6.1` image, Orbit job `bgj_e876126c4cda`): 3113 executed, 5 skipped, 0
  failures.
- **pg** (`scripts/run-pg-spec.sh`, Orbit jobs `bgj_ba5ebdab740a` on the branch and `bgj_5b1753765479` on its
  clean base `ca7fdc3ff`, compared by `bgj_ce3bb589205e` into `pg-branch-vs-base.txt`): the four specs that
  build `ProvidersController` fail exactly as on the clean base — pre-existing pool/dispatch reds on main.
  On the branch the credential sweep that now asks the balance route passes, and the route census's only
  unswept route is the pre-existing `POST providers/pools/:id/members/:memberId/pause`, on both.

## Reproduce

- Server, Web, OrbitKit: `cd src/apiserver && npx tsc -p tsconfig.test.json && node --test
  build/providers/deepseek-balance.spec.js`; `cd src/web && npx vitest run src/components/DeepSeekBalance.test.tsx
  src/lib/deepseekBalance.test.ts`; OrbitKit in the `swift:6.1` image: `swift test --filter DeepSeekBalance`.
- pg: `scripts/run-pg-spec.sh src/apiserver/src/providers/{pool-security-boundary,codex-login-scope,pool-admission-closure,provider-pool-usage}.pg.spec.ts`.
- Web pictures: `node web-rig/server.mjs`, then from `src/web` `../../node_modules/.bin/vite --config
  ../../docs/evidence/deepseek-harness/balance/web-rig/vite.config.mjs`, then `FONTCONFIG_FILE=<a fonts.conf
  aliasing -apple-system/system-ui to Inter and PingFang SC to Noto Sans SC> node web-rig/drive.mjs <out> light|dark`.
- iPhone pictures: push `probe-harness/` as `.dsb-probe/` and `probe-harness/client-shots.yml` as
  `.github/workflows/client.yml` on top of the commit under test to a `probe/…` branch; the report job pushes
  the pictures to `probe/ds-balance-shots-results`. Gates: `probe-harness/client-gates.yml` the same way.

## Not established here

- No real DeepSeek account or key was used: every balance and failure in the pictures comes from fixtures,
  shaped after DeepSeek's documented `/user/balance` answer and error codes. What a live 401 or a live
  outage looks like on the wire was not observed.
- macOS has no Providers page (Settings → Providers is iOS only, as in the mocks, which show only the
  iPhone), so there is no macOS row to open; the shared OrbitKit/OrbitApp code compiles for macOS (gates).
- Two deliberate differences from the mocks: the iPhone failure footnote says "No amount is shown until
  DeepSeek answers." without the mock's "…never drawn as ¥0.00" (no ¥0.00 may appear on a failure screen),
  and the web multi-currency section keeps the whole-account note above the currency sentence.
- `src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift` and `Views/SettingsSheet.swift` are outside the
  task's original path list (the app's API client lives only in its models, and Settings' navigation
  destinations are registered in the sheet); the coordinator added both to the scope in project
  34b7qmu7w992fd5pVBHYW's instructions.
- The four pg specs touched fail on this branch exactly as on its clean base (pre-existing pool/dispatch
  reds, see `pg-branch-vs-base.txt`); the new route's own checks inside them pass.
