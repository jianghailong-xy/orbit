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

## Evidence

FILLED IN BELOW
