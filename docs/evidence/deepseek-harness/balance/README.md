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

FILLED IN BELOW
