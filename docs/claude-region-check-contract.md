# Claude region check: contract (v1)

**Status:** the first task of project `34pUviip3QOsQ9iIAwHia` ("Claude region check"). It turns the project's
interface contract, items 1–12, into the document the server, runner and client tasks follow, and into
`src/shared`. Design of record: `docs/mocks/claude-region-check` (boards 01–04 and README.md). The board's English
copy is the copy to ship. A change to anything below changes this file first.

| What | Where |
| --- | --- |
| Supported list | `src/shared/src/claude-regions.ts`: `CLAUDE_SUPPORTED_COUNTRIES`, `CLAUDE_SUPPORTED_TERRITORIES`, `CLAUDE_EXCLUDED_REGIONS`, `CLAUDE_REGION_NAMES`, `CLAUDE_REGIONS_SOURCE_URL`, `CLAUDE_REGIONS_AS_OF` |
| Shared rules | `src/shared/src/claude-region-check.ts`: `regionVerdictFor`, `effectiveRegionVerdict`, `CLAUDE_REGION_CARRY_OVER_MS`, `credentialIsAnthropicBound`, `claudeRegionRefusedError`, `claudeRegionStoppedError` |
| Wire types | `src/shared/src/dto.ts`: `CLAUDE_REGION_V1`, `CLAUDE_REGION_UNSUPPORTED`, `CLAUDE_REGION_REFUSED_SUBTYPE`, `CLAUDE_REGION_STOPPED_SUBTYPE`, `ClaudeRegionVerdict`, `ClaudeRegionDecidedVerdict`, `ClaudeRegionCheckResponse`, `RunnerRegion`, `RunnerRegionView`, `ClaudeRegionCheckRequest`, `ClaudeRegionRefusal` |
| Specs | `src/shared/src/claude-regions.spec.ts`, `src/shared/src/claude-region-check.spec.ts` |

Everything is exported from `@orbit/shared`. Paths below are under `/api`.

## The owner's decisions (2026-10-31)

These bind every section below (README.md of the board, board 04).

| | Decision | What it means here |
| --- | --- | --- |
| ① | Only Anthropic-bound turns are checked. | Claude Code's own sign-in, an Anthropic key, a Claude pool (§8). Claude Code on a DeepSeek or vLLM key is not checked. |
| ② | Only Claude's own connection is checked. | One request per check, through the proxy Claude uses for api.anthropic.com (§3). Where the machine itself is does not count. |
| ③ | An unknown result keeps the last decided verdict for up to 24 h, otherwise counts as allowed. | §4, §5. A failed check never stops work; a deployment without Cloudflare never blocks. |
| ④ | A confirmed flip stops running turns. | Two blocked checks 60 seconds apart stop the running Anthropic-bound Claude turns (§10). |
| ⑤ | Runners without the capability are not gated. | §1. The server never falls back to where the heartbeat came from. |
| ⑥ | Claude only. | No other engine is checked or gated, even on an Anthropic key. |

## 1. Capability

`claude-region/v1`, `CLAUDE_REGION_V1` in `dto.ts`. A runner declares it in `x-orbit-runner-capabilities` once it
runs the check (§3) and gates its Anthropic-bound Claude turns on the result. runner-go asserts the string against
`dto.ts` the way `kimi_region_test.go` asserts `kimi-login-region/v1`: the source must keep the text
`CLAUDE_REGION_V1 = 'claude-region/v1'`.

Only a runner that declares it is ever gated: the claim hold (§11), the create refusal and the sign-in refusal (§12)
and the clients' region states apply to it alone. A runner without it has no effective verdict (§5), reads
`region: null` (§6) and runs as it does today (⑤).

## 2. Supported list

`src/shared/src/claude-regions.ts`, copied from Anthropic's Supported Regions Policy on **2026-10-31**
(`CLAUDE_REGIONS_AS_OF`). The source is `https://www.anthropic.com/legal/supported-regions`
(`CLAUDE_REGIONS_SOURCE_URL`). The address the board cites, `https://www.anthropic.com/supported-countries`,
answered 308 with it that day. The page then said "Effective Nov 12, 2026".

| Export | What it holds |
| --- | --- |
| `CLAUDE_SUPPORTED_COUNTRIES` | The page's list in its order and its words, each with its ISO 3166-1 alpha-2 code: 185 entries. |
| `CLAUDE_SUPPORTED_TERRITORIES` | The page's rule "Territories and dependencies of a listed country are also supported (for example, Puerto Rico as a territory of the United States)": every ISO 3166-1 entry ISO marks as not independent whose sovereign is listed, with that sovereign. 49 entries. |
| `CLAUDE_EXCLUDED_REGIONS` | Ukraine's exception, as ISO 3166-2 codes: `UA-43` Crimea, `UA-40` Sevastopol (Crimea is both), `UA-14` Donetsk, `UA-65` Kherson, `UA-09` Luhansk, `UA-23` Zaporizhzhia. |
| `CLAUDE_REGION_NAMES` | The name Orbit shows for every ISO 3166-1 code and Kosovo's `XK` (250): `mainland China`, `Hong Kong`, `Macau`, `Taiwan` as board 04 settles them; otherwise the plain English name. |

**Any country not listed is unsupported** ("Any country or region not listed is unsupported", the page). On
2026-10-31 that is 16 codes: AF Afghanistan, AQ Antarctica, BY Belarus, CN mainland China, CU Cuba, EH Western
Sahara, HK Hong Kong, IR Iran, KP North Korea, MM Myanmar, MO Macau, RU Russia, SY Syria, VE Venezuela, XK Kosovo,
YE Yemen; and the six Ukrainian codes above. Taiwan and Ukraine are listed. Antarctica, Western Sahara and Kosovo
are neither listed nor a territory of a listed country.

The list is read on the server only (board 01): the runner learns the verdict from the route (§3) and carries no
list of its own, so a change to Anthropic's list ships with one server release.

**Updating it:** fetch the page, replace `CLAUDE_SUPPORTED_COUNTRIES` entry by entry (its second column is the
page's words, so the two compare line for line), move `CLAUDE_REGIONS_AS_OF`, and update the counts the specs pin.

## 3. Check route

`GET /runner/region-check?viaProxy=0|1`, with the runner token like every runner route.

- **Plain HTTPS, never the runner link.** The request has to leave through Claude's proxy (②), so it is marked
  `@StaysOnHttps()` (`src/apiserver/src/runner-api/runner-link-required.ts`) and answers while
  `RUNNER_LINK_REQUIRED` is on.
- **The runner's side.** One request per check, through the proxy `claude` would use for `https://api.anthropic.com`
  (the process env, then the `env` of `settings.json`). `orbit register --proxy` puts the Orbit host into
  `NO_PROXY`, so the runner builds this request's transport with that proxy explicitly, and goes direct when there
  is none. `viaProxy=1` when it went through a proxy. Budget 3 seconds. A 404 (a server without the route) or any
  failure is unknown.
- **Geolocation** comes only from `CF-IPCountry` and `cf-region-code`, and only when the hop nginx saw
  (`X-Real-IP`) is inside `TRUSTED_PROXIES` (parsed in `src/apiserver/src/shared/public-surface.guard.ts`).
  Otherwise the answer is unknown. There is no bundled GeoIP.

**Decision:** `regionVerdictFor(country, regionCode)` with the two header values.

| Input | Answer |
| --- | --- |
| No country, Cloudflare's `XX` (no data) or `T1` (Tor), anything `CLAUDE_REGION_NAMES` does not hold | `unknown` |
| A country neither listed nor a territory of a listed one | `blocked`, with its name |
| `UA` with an excluded region (`43` or `UA-43`) | `blocked`, `regionCode: 'UA-43'`, `name: 'Crimea'` |
| `UA` with any other region | `allowed`, `regionCode` set, `name: 'Ukraine'` |
| `UA` with no region | `unknown`: the country alone cannot tell Kyiv from Crimea |
| Any other listed country or territory | `allowed`, with its name |

Cloudflare writes the region without its country (`43`); a full `UA-43` reads the same. `regionCode` is reported only
for a country the list splits by region (Ukraine) and is null everywhere else, so no other country's region is ever
carried or stored.

**The answer**, `ClaudeRegionCheckResponse`:

| Field | Type | Meaning |
| --- | --- | --- |
| `verdict` | `'allowed' \| 'blocked' \| 'unknown'` | `regionVerdictFor`'s, or `unknown` for an untrusted hop. |
| `country` | `string \| null` | ISO 3166-1 alpha-2; null when unknown. |
| `regionCode` | `string \| null` | ISO 3166-2, Ukraine only. |
| `name` | `string \| null` | {region} in board 04's copy; null when unknown. |
| `viaProxy` | `boolean` | The query parameter, echoed. |
| `asOf` | `string` | `CLAUDE_REGIONS_AS_OF`. |

`cf-region-code` is one of the headers Cloudflare's "Add visitor location headers" Managed Transform adds;
`CF-IPCountry` alone comes from the zone's IP Geolocation setting. On a zone without the transform, Ukraine answers
unknown, and the production rollout has to confirm orbitd.io sends it.

## 4. Storage: `runner.region`

`runner.region` (Json, nullable) holds a `RunnerRegion`:
`{ verdict, country, regionCode, name, viaProxy, decidedAt, checkedAt, blockedChecks }`. The check route is its
only writer.

| Result of a check | No row yet | A row |
| --- | --- | --- |
| `allowed` | Create it: the answer's fields, `decidedAt = checkedAt = now`, `blockedChecks: 0`. | Replace `verdict`, `country`, `regionCode`, `name`, `viaProxy`, `decidedAt`; `checkedAt = now`; `blockedChecks: 0`. |
| `blocked` | Create it as above with `blockedChecks: 1`. | Replace the same six fields; `checkedAt = now`; `blockedChecks + 1`. |
| `unknown` | Write nothing. | `checkedAt = now`, and nothing else. |

So a stored verdict is always a decided one (`ClaudeRegionDecidedVerdict`). `blockedChecks` counts consecutive
blocked results: an allowed one resets it and an unknown one leaves it.

- **Never an address.** The row holds the eight fields above and nothing else: no IP, no `X-Real-IP` or
  `X-Forwarded-For`, no city, no coordinates.
- **The runner does not report its verdict on the heartbeat.** The server's verdict comes from this route alone.

## 5. Effective verdict

`effectiveRegionVerdict(region, now)`: **blocked only when the stored verdict is blocked and `decidedAt` is under
24 hours old** (`CLAUDE_REGION_CARRY_OVER_MS`); everything else is allowed. runner-go carries its own last decided
verdict over for the same 24 hours.

| `runner.region` | Effective verdict |
| --- | --- |
| null (no row) | allowed |
| `allowed`, any age | allowed |
| `blocked`, decided under 24 hours ago | blocked |
| `blocked`, decided 24 hours ago or more | allowed |

A runner without `claude-region/v1` has no effective verdict and is never gated: callers pass null for it. A
deployment without Cloudflare never decides, so it never gates (③).

## 6. Reads

`GET /runners` and `GET /runners/:id` carry `region: RunnerRegionView | null` on every runner:
`{ verdict, country, regionCode, name, viaProxy, checkedAt }`, where `verdict` is the effective verdict (§5) and
the rest are the stored row's.

`region` is null for a runner that does not declare `claude-region/v1` and for one no check has decided yet. A
client that reads null, or an older client that reads nothing, draws what it draws today.

## 7. Check again

`POST /runners/:id/region-check`, owner JWT, refused while the runner is offline and for a runner that does not
declare `claude-region/v1`, which would never check. It records the request in `runner.region_check_requested_at`;
the next heartbeat response carries it the way `loginRequest` travels:

- `RunnerHeartbeatResponse.regionCheckRequest: { requestedAt }` (`ClaudeRegionCheckRequest`). Over the runner link
  it rides inside `HeartbeatAck.reconcile_json`, the same JSON, so it needs no proto change.
- The field is in `RunnerHeartbeatResponse`, with its entry in `HEARTBEAT_DELIVERIES`
  (`src/apiserver/src/runner-api/link-heartbeat.ts`): that table's type requires every member of the response, so
  the field cannot land without its writer. runner-go's `HeartbeatResponse` (`types.go`) gets the same field.
- The server sends it on every heartbeat response to a process that declares `claude-region/v1`, until a check at or
  after `requestedAt` reaches the check route, which clears the request whatever the check answered (an unknown one
  with no row records no `checkedAt`, §4). It stops after ten minutes without such a check. The runner checks at
  once, once per `requestedAt`.
- The result then goes through §3 and §4 like any other check.

Board 04 offers Check again on the session card and the machine page's Claude row; a client offers it only where
`region` is not null.

## 8. Anthropic-bound credential

**Server and web:** `credentialIsAnthropicBound(credential)` is true for:

- the engine's own sign-in, Claude Code's (`{ kind: 'login', engine: 'claude' }`);
- a Claude pool (`{ kind: 'pool', engine: 'claude' }`). Its members are Claude subscriptions that talk to
  Anthropic directly; the pool gateway serves Codex alone;
- a key whose preset is `anthropic`, or whose base URL's host is `anthropic.com` or a name under it
  (`api.anthropic.com`), compared without case or a trailing dot. A look-alike such as `anthropic.com.example` or
  `myanthropic.com` is not.

It is false for everything else: DeepSeek, Moonshot, GLM, MiniMax and Qwen keys and a local vLLM key even under
Claude Code, another engine's sign-in or pool, and OpenCode's own configuration. It takes an `EngineCredential`
(`providerEngines.ts`) or a web picker row, which knows a key's preset but not its endpoint.

A session is gated only when all four hold: its engine is `claude` (⑥), its credential is Anthropic-bound, its
runner declares `claude-region/v1`, and that runner's effective verdict is blocked.

**Runner:** it decides from the turn's environment instead. A Claude turn is Anthropic-bound when
`ANTHROPIC_BASE_URL` is empty or its host is `anthropic.com` or a name under it (read from the session env, then the
`env` of `CLAUDE_CONFIG_DIR/settings.json`, then the process env; the first that sets it wins), and neither Bedrock
(`CLAUDE_CODE_USE_BEDROCK`) nor Vertex (`CLAUDE_CODE_USE_VERTEX`) is enabled. `claudeTalksToMeasuredEndpoint` in
`claude_prompt_suggestion.go` shows how the base URL is read.

## 9. Refusal words

A refused turn's `session.error` is

```
CLAUDE_REGION_UNSUPPORTED: {machine}’s connection to Anthropic is in {region}, where Anthropic doesn’t offer Claude.
```

`claudeRegionRefusedError(machine, region)` writes it: `{machine}` is the runner's name and `{region}` the decided
name (`RunnerRegion.name`). The code is `CLAUDE_REGION_UNSUPPORTED`, a constant in `dto.ts` and in runner-go. The
`<CODE>: <sentence>` shape is the one clients already read a coded `session.error` with (`RunNeverStartedCard`).

Clients read the place for the card from `runner.region`, never by parsing the sentence.

## 10. Refusals and stops from a runner

| Subtype | When | `status` | `error` |
| --- | --- | --- | --- |
| `region_refused` (`CLAUDE_REGION_REFUSED_SUBTYPE`) | The runner did not spawn the engine for an Anthropic-bound Claude turn, or did not deliver a message to a running one, because its verdict is blocked. | `FAILED` | `claudeRegionRefusedError` (§9) |
| `region_stopped` (`CLAUDE_REGION_STOPPED_SUBTYPE`) | A flip confirmed by two blocked checks 60 seconds apart stopped a running Anthropic-bound Claude turn (④). | `FAILED` | `claudeRegionStoppedError` |

The runner reports either on finalize (`RunFinalizeRequest`) or on turn-complete (`TurnCompleteRequest`), whichever
ends what it refused or stopped. `status` is `FAILED`, as for `delivery_failed` (`claude_delivery.go`), so that a
control plane which predates the subtype records an ordinary failure with the sentence in view.

Where runner-go refuses (`claude_region.go`), each time on an answer from the route under 60 seconds old:

- **A cold start** refuses before anything is installed or spawned, and reports on finalize with the sentence in
  `error`.
- **A claim for a warm engine** recycles the engine instead of reusing it (`activatePrepared`), and the cold start
  that takes its place refuses as above.
- **A message handed to a running engine** is not written to it. Its turn is reported on turn-complete, with the
  sentence in `error` and `result`, and that report stops the engine. A steer is not refused: it joins a turn that
  is already running, which only ④ stops.
- **The turn-complete answer** ends the run whatever status it carries: a terminal one from a control plane that
  predates the subtype, or the session's waiting status from one that holds it. Nothing is finalized after it, and
  the run's inbox generation is released unless that status is terminal.

Because the runner refuses only on a fresh answer the route just gave it, `runner.region` reads blocked whenever
the runner refuses, as long as nothing else checked for that runner since.

A control plane that knows the subtypes does **not** fail the session:

- **`region_refused`:** the server puts the run back in the queue as a hold: `QUEUED`, with the sentence in
  `session.error`. The undelivered message stays queued and runs when the hold releases (§11).
- **`region_stopped`:** the stopped turn ends with the stopped sentence in `session.error`, and the session is not
  `FAILED`. Messages still queued, and the session's next turn, wait under the same hold until it releases. The
  stopped turn is not replayed.

The stopped `session.error`, from board 04:

```
CLAUDE_REGION_UNSUPPORTED: Claude Code stopped on {machine}: its connection to Anthropic is now in {region}, where Anthropic doesn’t offer Claude.
```

**The push** (board 04, "push (flip)") goes out once per confirmed flip: when a blocked result takes
`blockedChecks` to 2.

## 11. Holds and their release

A hold is the claim's own condition, evaluated at every claim. It lasts exactly while all four conditions of §8
hold, and nobody has to clear it. It releases on its own when:

- the effective verdict is allowed: an allowed check, or 24 hours since the last decided blocked one (§5);
- the session moves to a non-Anthropic provider (a DeepSeek or vLLM key under the same Claude Code);
- the session moves to another machine.

The claim that follows takes the session as usual, and clears `session.error` as every claim does. Only
Anthropic-bound Claude sessions are held. Every other session on the same runner is claimed as usual, and so is
every session on a runner without the capability.

## 12. New sessions and Claude sign-in

- **New sessions:** `POST /sessions` for an Anthropic-bound Claude session bound for a runner whose effective
  verdict is blocked answers **409** with a `ClaudeRegionRefusal` body: `{ code: 'CLAUDE_REGION_UNSUPPORTED',
  message, runnerId }`. The check sits beside the signed-out preflight
  (`src/apiserver/src/sessions/engine-signin-preflight.ts`, `ENGINE_SIGNED_OUT`). `message` is board 04's sentence:
  `Claude Code can’t use Anthropic on {machine}: its connection is in {region}, where Anthropic doesn’t offer Claude. Pick a key from another provider, or a workspace on another machine.`
- **Claude sign-in:** refused at dispatch on such a runner: the server sends no Claude login request, and the
  sign-in fails with board 04's sentence:
  `Claude sign-in isn’t available on {machine}: its connection to Anthropic is in {region}, where Anthropic doesn’t offer Claude.`
  The runner refuses `claude auth login` with the same sentence while its own verdict is blocked.

**The runner's other requests to Anthropic** wait on the answer its turns go by (§10: under 60 seconds old, else
asked now), and a blocked one stops them (`claudeConnectionBlocked` in `claude_region.go`):

- **Plan usage** (`planusage.go`, for Default and every added account): no read of `api.anthropic.com`, and no token
  refresh for one, since that talks to Anthropic too. Each account's probe logs
  `not reading Anthropic usage while anthropic is blocked — CLAUDE_REGION_UNSUPPORTED` once and keeps its last
  reading, as after any failed read. The first pass on an allowed answer reads again. No other engine's usage is
  checked (⑥).
- **Claude sign-in** (`login.go`): a login start fails at once with the sentence above, before an account is added
  or any process starts (no `script`, no `claude auth login`). The log says
  `login {attempt}: claude sign-in refused — CLAUDE_REGION_UNSUPPORTED`.
- **`orbit doctor`** (`doctor.go`) makes a check of its own when it starts, as the runner makes one (§3), which the
  route records like any other. While it answers blocked, Claude Code's line reads `Anthropic: region not supported`,
  doctor offers and suggests no Claude sign-in, and a `Claude region` section follows the engines (board 03). The
  address under it is `CLAUDE_REGIONS_SOURCE_URL` (§2). Its answer is the process's own check, so the gates below
  hold in doctor too.
- **The runner's own `claude` starts** go by the turns' rule (①): they wait only when the `claude` they would start is
  Anthropic-bound (§8, from that process's environment and `settings.json`) and the answer is blocked
  (`claudeStartBlocked`). A machine whose own Claude Code points at another provider keeps them. Any `claude` start
  can talk to Anthropic, because the CLI refreshes a due token as it starts.
  - Model calls fall back to what each already had: a commit message to the diffstat message (`worktree.go`) and a
    transcript summary to the mechanical digest (`transcript_rebuild.go`).
  - The slash-command registry probe (`slash_registry.go`) and the hourly model catalog (`claude_models.go`) start
    nothing and keep what they have. The first pass on an allowed answer reads again.
  - `claude auth status` (`probeAuthIn`, for Default and every account), `claude update` (`updateEngine`) and the
    installer's `claude install` (`installEngineNow`, `ensureEngine`) wait only where a login or key is stored
    (`claudeLoginBlocked`). Measured on Claude Code 2.1.316 through a recording proxy, each sends a stored login's
    token to `api.anthropic.com`, and with no login stored they send nothing credentialed. While waiting:
    - `auth status` answers unknown, which is never read as signed out;
    - an update is recorded as skipped with ``Not updated while this machine’s connection to Anthropic is in {region}, where Anthropic doesn’t offer Claude: `claude update` sends the Claude login stored here to Anthropic.``;
    - an install fails with `Claude Code isn’t installed on {machine} while its connection to Anthropic is in {region}, where Anthropic doesn’t offer Claude: its installer sends the Claude login stored there to Anthropic.`
  - Left as they are: `claude --version`, which connects nowhere; Anthropic-bound turns and deliveries, which have
    their own gates (§10); and what a person runs in their own terminal (`orbit resume`, doctor's interactive
    install).

## Copy of record (board 04)

Every sentence a person reads, word for word. `{machine}` is the runner's name, `{region}` is `region.name`.

| Where | Copy | Written by |
| --- | --- | --- |
| Session card, why | `Claude Code can’t use Anthropic on {machine}` | clients |
| Session card, body | `{machine}’s connection to Anthropic is in {region}, where Anthropic doesn’t offer Claude.` and the link `Supported regions` | clients |
| Session card, the machine's words | `CLAUDE_REGION_UNSUPPORTED · {CC}` / `Checked {time} · Claude’s connection: {region} (no proxy \| through a proxy)` | clients |
| Session card, buttons | `Use another provider` · `Move to another machine` · `Check again` | clients |
| Session list row and header | `Anthropic unavailable on {machine}` | clients |
| Stopped turn (④) | `Claude Code stopped on {machine}: its connection to Anthropic is now in {region}, where Anthropic doesn’t offer Claude.` | runner (§10) |
| Machine page attention line and badge | `Claude Code can’t use Anthropic here` · `Region not supported` | clients |
| Machine page note | `Claude’s connection from this machine is in {region}, where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys.` | clients |
| Provider menu and new session | `{credential} — Region not supported` / `Claude Code · Region not supported on this runner · Details` | clients |
| New session 409 | `Claude Code can’t use Anthropic on {machine}: its connection is in {region}, where Anthropic doesn’t offer Claude. Pick a key from another provider, or a workspace on another machine.` | server (§12) |
| Sign-in refused | `Claude sign-in isn’t available on {machine}: its connection to Anthropic is in {region}, where Anthropic doesn’t offer Claude.` | server and runner (§12) |
| Push (flip) | `Claude Code can’t use Anthropic on {machine} — its connection is now in {region}. Sessions on Anthropic accounts or keys there wait until you switch provider or move them.` | server (§10) |

The refusal sentence of §9 is the session card's body behind the code. New web copy goes in
`src/web/src/lib/claudeRegionCopy.ts`, never in `runnerCopy.ts`.

## Safety while landing

Each task lands on main alone, so each piece is safe without the others:

- a runner facing a server without the route reads 404 as unknown and runs (③);
- a server with no `runner.region` row gates nothing (§5);
- a server that predates the subtypes records `region_refused` and `region_stopped` as an ordinary `FAILED` turn with
  the sentence (§10);
- a client that reads no `region` draws what it draws today (§6).

## What the check does not see

Board 01 lists these for the help to say plainly:

- Only Claude's own connection (②). A proxy that leaves in a supported region passes, wherever the machine is.
- Unknown counts as allowed (③). A self-hosted deployment without Cloudflare cannot tell the region and never
  blocks. Production (orbitd.io) is behind Cloudflare.
- A runner without the capability is not gated until it updates itself (⑤).
- Ownership is out of scope. Anthropic's terms also restrict companies controlled from unsupported regions (the
  2025-09-05 update); that is not a property of a network.
- The list is copied by hand, with its date and source (§2).

## Readings this document adds

The project's twelve items leave these open. They are settled here so the parallel tasks agree.

1. Territories of listed countries are supported under their own codes (§2), from the page's own sentence.
   Antarctica, Western Sahara and Kosovo are unsupported: none is listed or a territory of a listed country.
2. `regionCode` is carried and stored for Ukraine only; Ukraine without a region is unknown (§3).
3. An unknown result with no row writes nothing, so a stored verdict is always decided (§4).
4. On the wire both subtypes carry `status: FAILED`, and both errors start with `CLAUDE_REGION_UNSUPPORTED: ` (§9,
   §10). A stopped turn is not replayed.
5. Check again is `regionCheckRequest: { requestedAt }`, sent until a check at or after it is recorded (§7), on
   `RunnerHeartbeatResponse` in `dto.ts`.
6. The 409 body is `ClaudeRegionRefusal` (§12), and the push goes out when `blockedChecks` reaches 2 (§10).
7. A key on the `anthropic` preset whose base URL was edited to another host counts as Anthropic-bound for the server
   and the web (§8), while the runner, which reads the environment, runs it. The runner keeps its verdict per proxy
   and the server keeps one per runner, so the two can disagree for a moment. The server and runner tasks decide how
   a refusal waits when `runner.region` already reads allowed.
8. Check again is refused for a runner that does not declare `claude-region/v1`, is handed only to a process that
   declares it, and stops after ten minutes without a check, so a runner whose checks cannot reach the route does not
   reconcile in full on every link beat for as long as it is down (§7).
9. A runner link call to the check route answers unknown, whatever its headers say: its connection is the link's,
   not Claude's (§3). runner-go lists the route among the controller's guarded routes (`linkDaemonRoutes`) as it lists
   the attachments, whose calls never go over the link either.
