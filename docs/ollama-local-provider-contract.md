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
  state: 'READY' | 'UNREACHABLE' | 'MALFORMED' | 'CLOUD_ENABLED' | 'NO_MODELS' | 'MODEL_MISSING'
       | 'CAPABILITY_MISSING' | 'REFUSED' | 'STALE' | 'UNKNOWN' | 'DISABLED' | 'NO_RUNNER';
  capability: 'SUPPORTED' | 'UNKNOWN';
  probedAt: string | null;
  version: string | null;
  latencyMs: number | null;
  models: { value: string; label?: string; contextWindow?: number; tools?: boolean;
            parameterSize?: string; quantization?: string }[] | null;
}
```

The probe states and `STALE` are defined in §6.

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

- Phase 3 is §7. Zero cost for local rows is still open.
- Phases 4A/4B: the connect flow and pickers. The web gallery leaves runner-scoped presets out until 4A
  draws a runner chooser; native clients show the generic mark.

## 6. The runner's probe (phase 2)

Task `34DuK8eT068Um725SVPV7`. The runner probes; the control plane and the browser never reach a local endpoint.

### 6.1 The heartbeat round trip

1. Every full heartbeat answer carries `localProviders: LocalProviderTarget[]`: the enabled runner-scoped rows bound
   to that runner and owned by its owner, at most 16, each `{ providerId, baseUrl, models }`. `models` is the row's
   list and default model, with no cloud model. An empty list means none. A quiet link answer leaves the field out,
   and the runner keeps the set it has. Creating, editing and deleting a local provider marks its runner changed,
   and both runners when it moves (`HEARTBEAT_DELIVERIES.localProviders`).
2. The runner (`src/runner-go/local_provider_probe.go`) probes the set right away when it changes, and again every
   60 s (`LOCAL_PROBE_INTERVAL_MS`). It never waits on the heartbeat, and the heartbeat never waits on it.
3. The next heartbeat body carries `localProviderProbes: LocalProviderProbe[]`, one per target:
   `{ providerId, baseUrl, state, version?, checkedAt, latencyMs?, reason?, models }`. `models` is `null` when the
   server did not answer the inventory.
4. The server keeps a report only on a row that is `scope = 'runner'`, bound to the reporting runner, owned by that
   runner's owner, and still at the `baseUrl` that was probed. The HTTPS route and the link's one-statement report
   writer run the same UPDATE (`localProviderProbesSql`). Every field is sanitized again
   (`sanitizeLocalProviderProbe`, `sanitizeInstanceModels`). `probed_at` is the runner's `checkedAt`, clamped to
   now, so a report that is sent again unchanged does not make an old probe look fresh. A report with no
   catalogue keeps the stored one. Migration 0647 adds `probe_latency_ms`, which is cleared with the other probe
   columns on a rebind.
5. Declaring `ollama-probe/v1` turns `capability` to `SUPPORTED`.

### 6.2 What one probe does

| Step | Call | Limits |
| --- | --- | --- |
| Readiness | `GET /api/version`, timed: `latencyMs`, `version` | 3 s, 4 KiB |
| Inventory | `GET /api/tags` | 5 s, 4 MiB, at most 200 models |
| Capabilities | `POST /api/show {"model": name}`: `capabilities` has `tools`; the largest `*.context_length` in `model_info` | 5 s, 2 MiB, 4 at a time, at most 64 per cycle, cached only by a full digest, exactly `sha256:` and 64 hex digits; a model with any other digest (`unknown`, truncated, another algorithm) is shown every cycle |

The models the row names are shown first, so the cap never hides them. A whole cycle is bounded at 45 s, with 4
targets probed at a time. Nothing is installed, pulled or removed. No prompt is sent.

### 6.3 States

| State | When |
| --- | --- |
| `READY` | The server answered, and every model the row names is served with `tools` and at least 65,536 tokens of context (`LOCAL_MIN_CONTEXT_WINDOW`). With no model named, any local model will do. |
| `UNREACHABLE` | Connection refused, a timeout, DNS, or an HTTP error status (`reason`: `connection_refused`, `timeout`, `http_500`, …). |
| `MALFORMED` | Bad JSON, a redirect, a body over its cap, a content type other than `application/json`, a charset other than UTF-8 or invalid UTF-8, a compressed body, or no version. |
| `NO_MODELS` | The server serves no local model. Cloud models (`-cloud`/`:cloud`, or a `remote_host`) are not counted. |
| `MODEL_MISSING` | A named model is not listed, or `/api/show` answers 404 for it (removed). `llama3` matches `llama3:latest`. Tags are part of the name. |
| `CAPABILITY_MISSING` | A named model has no `tools`, its context is under 65,536, or its capabilities could not be read (`no_tools:m`, `context:m:n`, `context_unknown:m`, `capabilities_unknown:m`). |
| `REFUSED` | The runner will not probe the endpoint (§6.4). |
| `STALE` | Read-time only: the stored probe is older than `LOCAL_PROBE_STALE_MS` (5 min), because the runner went offline or its probe stopped. |
| `UNKNOWN` | Never probed, or the runner does not declare `ollama-probe/v1`. |

`reason` is a short machine code. It is stored in `probe_message` and never served. A probe result never holds a
response body, a prompt or a key. The catalogue keeps a name, `contextWindow`, `tools`, `parameterSize` and
`quantization`. Template, licence, system prompt, parameters and every other field of `/api/show` are dropped.

### 6.4 What the runner will connect to

- `http` or `https` only. No userinfo, query or fragment. No path except `/`, and a trailing slash is fine.
- Loopback only by default: `127.0.0.0/8`, `::1` and `localhost`. The address actually dialled is checked again
  at connect time, so a name that resolves elsewhere is refused. `0.0.0.0`, private, link-local and metadata
  addresses are refused.
- The runner's owner can allow more on that machine only, with `ORBIT_OLLAMA_ALLOWED_HOSTS`: host names, IPs or
  CIDR prefixes, comma- or space-separated. A host name listed there may resolve to any address. The control plane
  cannot widen this list.
- No proxy (the environment's `HTTP_PROXY` is ignored). No redirect is followed. No transparent decompression.
  Response headers are capped at 16 KiB.

## 7. Dispatch readiness and failing closed (phase 3)

Task `34DuK8hgYpZdMfSAydDJ0`. One rule, `localProviderReadiness` (`@orbit/shared` localProvider.ts), decides whether a
session may run on a runner-scoped provider now. Every door applies it, with the runner the session is (or would be)
on and the model it would run:

| Door | Where | On refusal |
| --- | --- | --- |
| Session create (also task start, a mention reply) | `SessionsService.create` → `assertLocalProviderStartable` | 400 with the code; nothing written |
| Task create, and a task edit that moves the provider, model or assignee | `TasksService.assertLocalPinStartable` | 400 with the code; nothing written |
| Claim | `QueueService.pausedPendingSessions` holds it before the claim; `resolveProviderExec` refuses it at the build | stays PENDING, `error` = the sentence |
| Reclaim (runner restart) | `RunnerApiController.reclaim` → `resolveProviderExec` | left out, PENDING ones marked with the sentence |
| Provider switch, any config change | `SessionsService.updateConfig` → `resolveProviderExec` | 400 with the code |
| Reload (a switch's respawn) | `reloadProviderEnv` → `resolveProviderExec` | not handed out; refusal is the sentence |

The checks, in order, each with a stable code (`LOCAL_PROVIDER_REFUSAL_CODES`):

| Code | When | Clears on its own |
| --- | --- | --- |
| `LOCAL_PROVIDER_DISABLED` | the row is off | no |
| `LOCAL_PROVIDER_NO_RUNNER` | no runner bound, or it is no longer the row owner's | no |
| `LOCAL_PROVIDER_ELSEWHERE` | the session is on any other runner, or none | no |
| `LOCAL_PROVIDER_RUNNER_OUTDATED` | the runner has not declared `ollama-probe/v1` | no |
| `LOCAL_PROVIDER_UNPROBED` | no probe yet | yes |
| `LOCAL_PROVIDER_STALE` | the probe is older than `LOCAL_PROBE_STALE_MS` | yes |
| `LOCAL_PROVIDER_UNREACHABLE` | the probe got no answer: stopped, cold-starting, busy | yes |
| `LOCAL_PROVIDER_MISCONFIGURED` | `MALFORMED`, `REFUSED`, `CLOUD_ENABLED`, or a `-cloud` model | no |
| `LOCAL_PROVIDER_NO_MODELS` | the instance serves no local model | no |
| `LOCAL_PROVIDER_MODEL_MISSING` | the model is not in the instance's catalogue, or nothing names one | no |
| `LOCAL_PROVIDER_CAPABILITY_MISSING` | the model lacks `tools`, or its context is unknown or under 65,536 | no |

The model is the session's own, else the row's default, else the first it lists (`localTargetModel`): never the
built-in Claude default. `llama3` matches `llama3:latest`. A row-level `MODEL_MISSING`/`CAPABILITY_MISSING` about
another model the row names does not refuse a session whose own model is fine.

A held session waits PENDING with a sentence beginning `Local provider ` (`LOCAL_PROVIDER_ERROR_PREFIX`), which the
claim clears when it finally claims it. A hold is re-judged on each poll from the stored probe; nothing re-sends it
on a timer, so neither kind of hold is a retry loop. No refusal moves the session onto another runner, another
credential or the runner's own Claude sign-in.

**What a claim hands the runner** on a local row: Claude Code, the model, `ANTHROPIC_BASE_URL` = the row's
`baseUrl`, `ANTHROPIC_AUTH_TOKEN` = `LOCAL_AUTH_PLACEHOLDER` (built at dispatch, stored nowhere),
`ANTHROPIC_MODEL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and the workspace environment without
`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, so no cloud credential typed into the workspace reaches the local
endpoint. A provider switch stays on the session's engine: Claude Code may move between a cloud key and a local
provider on its own runner; another engine is `PROVIDER_ENGINE_INCOMPATIBLE`.

**Failures during a run.** `isRetryableApiErrorText` (`@orbit/shared` events.ts) does not re-send what Ollama says
can never succeed, whatever the status: `requires more system memory`, `llama runner process has terminated`,
`out of memory`, `try pulling it first` (`LOCAL_SERVER_FATAL_ERROR_MARKERS`). A busy server (503), an overloaded
one, a timeout during a cold load and a bare 500 stay retryable, within `MAX_API_ERROR_RETRIES` (3).

Tests: `src/shared/src/localProviderReadiness.spec.ts`, and `src/apiserver/src/providers/local-provider-dispatch.pg.spec.ts`,
which runs every door against a fake Ollama on loopback.
