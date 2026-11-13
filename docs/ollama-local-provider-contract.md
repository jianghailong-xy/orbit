# Runner-scoped Ollama provider: contract (phase 1)

**Status:** phase 1 of the project that adds Ollama as a local model provider (`34DuFmuOFfm2JjrANUpis`), task
`34DuK8Zn2Tvllpl9a1Tzs`. It builds on the route frozen in phase 0 (`docs/ollama-local-provider-phase0.md` §0):
Claude Code on Ollama's own Anthropic Messages endpoint at the server root, resolved on the runner that hosts
Ollama. Phase 1 defines the data model, the API contract and the dispatch guard. Probing (phase 2), affinity
scheduling and runtime hardening (phase 3) and the client UI (phases 4A/4B) build on it.

## 1. What a local provider is

A local Ollama is an ordinary `ModelProvider` row on an engine Orbit already runs. It is **not** an engine:
`AgentProvider` has no `OLLAMA` value, and the runner is handed a Claude Code job exactly as for any other
Anthropic-compatible key.

Three facts travel together on such a row, and both the service and the database hold them together:

| Fact | Column | Local Ollama | Every other row |
| --- | --- | --- | --- |
| Scope | `scope` | `runner` | `account` |
| Auth mode | `auth_mode` | `none` | `bearer` |
| Stored key | `api_key_enc` | `''` (no key) | AES-GCM ciphertext, as before |
| Runner | `runner_id` | one of the owner's runners, or NULL once that runner is removed | NULL |
| Owner | `owner_id` | the caller (personal only) | personal or shared, as before |
| Preset | `preset_slug` | `ollama` (`runnerScoped: true`) | any, as before |
| Runtime | `runtime` | `claude` | any, as before |

**Dialect** is not a column: it is `keyDialect(runtime)` (`@orbit/shared` openCodeKeys.ts), so a local
Ollama row speaks `anthropic`. Codex on Ollama's Responses endpoint stays out until task
`34wnlmNt2wLO1JxUs1IJB` lands (phase 0 §5.2); the engine table runs a local key on Claude Code alone
(`EngineCredential.local`, providerEngines.ts).

## 2. Migration 0646 `model_provider_runner_scope`

Adds `scope`, `runner_id` (FK `runner`, `ON DELETE SET NULL`), `auth_mode`, the probe columns
`probe_state`, `probe_version`, `probe_message`, `probed_at`, and `instance_models` (the instance's own model
catalogue as its runner discovered it). Every existing row becomes `account` / `bearer` with no runner and
no probe — what it already was. Constraints:

- `model_provider_scope_chk`, `model_provider_auth_mode_chk`: the two vocabularies.
- `model_provider_scope_auth_chk`: `scope = 'runner'` exactly when `auth_mode = 'none'`.
- `model_provider_auth_key_chk` (`NOT VALID`: new writes only): `auth_mode = 'none'` exactly when
  `api_key_enc = ''`.
- `model_provider_runner_scope_chk`: only a runner-scoped row names a runner, and only a personal row is
  runner-scoped.

`down.sql` reverses it and refuses while a runner-scoped row exists. Both scripts are re-runnable.

**Why the empty string and not NULL.** An older API replica reads `api_key_enc` as a non-null string. NULL
would break every read of that owner's providers on the old replica. `''` reads fine there. On dispatch the old
replica fails to decrypt it and refuses the session, so a replica that does not know about scope fails
closed for a runner-scoped row instead of dispatching it to any runner.

## 3. API

### 3.1 Writes (`POST /providers/mine`, `PATCH /providers/mine/:id`)

New optional fields on create: `scope`, `runnerId` (public id), `authMode`. `apiKey` becomes optional in the
DTO; the service still refuses a missing or empty one for every provider except a local Ollama
(`PROVIDER_API_KEY_REQUIRED`, 400).

Defaults follow the preset: `presetSlug: "ollama"` means `scope: runner` and `authMode: none`; anything else
means `account` and `bearer`. Refusals (all 400 with a `code`, except the runner lookup):

| Code | When |
| --- | --- |
| `PROVIDER_API_KEY_REQUIRED` | an account-scoped provider with no key or an empty one |
| `PROVIDER_SCOPE_AUTH_MISMATCH` | `authMode: none` without runner scope, or runner scope with `bearer` |
| `PROVIDER_RUNNER_REQUIRED` | a local preset without `runnerId` (or forced to account scope) |
| `RUNNER_NOT_FOUND` (404) | `runnerId` is not one of the caller's runners: missing and another owner's read the same |
| `PROVIDER_RUNNER_SHARED` | runner scope on a shared (admin) provider |
| `PROVIDER_RUNNER_PRESET` | runner scope on anything but a local preset |
| `PROVIDER_RUNNER_RUNTIME` | a local provider on any runtime but `claude` |
| `PROVIDER_API_KEY_UNUSED` | a key sent for a local provider (create or update) |
| `PROVIDER_CLOUD_MODEL` | a model id ending `-cloud` / `:cloud` (Ollama forwards those to ollama.com, phase 0 §6.3) |
| `PROVIDER_RUNNER_CATALOGUE` | `followsPreset: true` on a local provider |
| `PROVIDER_RUNNER_NOT_SCOPED` | `runnerId` on an account-scoped provider |

Scope and auth mode are fixed at creation. `PATCH { runnerId }` rebinds a local provider to another of the
caller's runners. A new runner or a new `baseUrl` clears the probe columns, because nothing has probed that
target yet. Ownership, encryption, admin-only shared rows and every other rule are unchanged.

`POST /providers/test` is unchanged. It refuses loopback and private hosts, so the control plane never
probes a local server. Probing is the runner's job (phase 2).

### 3.2 Reads

Every provider read gains `scope`, `authMode` and `runnerId`. A runner-scoped row also gains `local`
(`@orbit/shared` `LocalProviderStatus`). Old clients ignore all of them:

```ts
local: {
  state: 'READY' | 'UNREACHABLE' | 'MALFORMED' | 'CLOUD_ENABLED' | 'UNKNOWN' | 'DISABLED' | 'NO_RUNNER';
  capability: 'SUPPORTED' | 'UNKNOWN';
  probedAt: string | null;
  version: string | null;
  models: { value: string; label?: string; contextWindow?: number; tools?: boolean }[] | null;
}
```

- `runnerId` is served only while that runner still belongs to the row's owner. Otherwise it is `null` and
  `state` is `NO_RUNNER`. This applies to a runner moved to another account and to one that was removed.
- `capability` is `SUPPORTED` only when the runner has reported capabilities and declared
  `ollama-probe/v1` (`OLLAMA_PROBE_CAPABILITY`). An older runner is `UNKNOWN`, and so is `state`, whatever
  a stale probe said. A missing field is never read as healthy.
- `probe_message` is never served.
- `GET /providers` (the picker) and `GET /runner/providers` (`listUsable`) still carry no `baseUrl` and no
  key. `listUsable` adds `scope`/`runnerId` on a runner-scoped entry only, so every other entry reads
  byte for byte as before.
- `GET /providers/mine` and the admin list keep `baseUrl` for the owner's own edit form, as before.
  `hasApiKey` is `false` for a local provider, and `GET /providers/mine/:id/key` answers 404.

## 4. Dispatch: fail closed

`resolveProviderExec` takes the assigned runner's id. For a runner-scoped row it refuses:

- `LOCAL_PROVIDER_NO_RUNNER` when the row has no runner, because the runner was removed;
- `LOCAL_PROVIDER_ELSEWHERE` when the session is on any other runner, or the door named none.

On its own runner, the engine gets `ANTHROPIC_BASE_URL` = the row's `baseUrl` and
`ANTHROPIC_AUTH_TOKEN` = `LOCAL_AUTH_PLACEHOLDER`. The placeholder is built into the job's environment at
dispatch and stored nowhere. It is needed because Claude Code given no token would send the runner's own
Claude sign-in to the endpoint.

The claim SQL claims a session on a runner-scoped row only on `runner_id`. The claim's late check and the
reclaim put a session that reaches the refusal anyway back to PENDING with the reason. The existing
refusals still apply unchanged: a disabled row (`provider is disabled`), a deleted one
(`provider not available`), and another owner's row (`usableProviderScope`). A session on a local provider
waits; it is never turned into a built-in Claude or Codex session on the runner's own sign-in.

## 5. Left to later phases

- Phase 2: the runner probe that writes `probe_*` and `instance_models`, and declares `ollama-probe/v1`.
- Phase 3: affinity scheduling that assigns a new session to the provider's runner, the capability gate
  (refusing an `UNKNOWN` runner before dispatch), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, zero cost,
  readable PENDING reasons, and the provider-switch door, which today refuses a local provider for a session
  not yet on its runner.
- Phases 4A/4B: the connect flow and pickers. The web gallery leaves runner-scoped presets out until 4A
  draws a runner chooser; native clients show the generic mark.
