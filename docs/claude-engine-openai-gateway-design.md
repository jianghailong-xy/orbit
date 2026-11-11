<!-- 2026-11-11 · owner took D1–D8 as recommended; project 34vZPMzFs7c8OTMPJYYHn. Board: docs/mocks/claude-openai-gateway/01-architecture.html (+ PNGs). §8 answered by P0. -->

# Claude Code on an OpenAI key, through Orbit's own gateway

A person who has added an OpenAI API key can start a session on the **Claude Code** engine and pick a GPT model.
Nothing else is set up: no LiteLLM, no proxy, no environment variables. Orbit's API server translates between the
two protocols itself. Claude Code speaks Anthropic Messages to `/api/gw/anthropic`, the gateway sends OpenAI
Responses to OpenAI with the key it holds, and it streams the answer back as Anthropic events.

The design follows the owner's direction: Orbit hides what users would otherwise configure themselves,
so the gateway is part of the product rather than something users run.

## 1. Where things stand

Claude Code already runs other vendors' models. The Z.AI, MiniMax, Qwen and DeepSeek presets
(`src/shared/src/providerPresets.ts`) point it at each vendor's Anthropic-compatible endpoint. What a session on such
a key gets is built in `injectedEnv` (`src/apiserver/src/providers/custom-provider.ts`, its `claudeEnv` block):

- `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` from the key row.
- `CLAUDE_CODE_INLINE_TOOLS=false` for an endpoint that is not Anthropic's.
- `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1`, so Explore runs the session model and not an "opus" id.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from the catalog window, kept an eighth short of the real window.
- `CLAUDE_CODE_EFFORT_LEVEL=unset` for a model that takes no effort.

The runner skips the Anthropic region check for any base URL that is not Anthropic's
(`claudeTurnIsAnthropicBound`, `src/runner-go/claude_region.go`).

OpenAI has no Anthropic-compatible endpoint, so an OpenAI key cannot run on Claude Code today. The compatibility
table (`docs/provider-engine-contract.md` §2.1, `keyEngines` in `src/shared/src/providerEngines.ts`) gives an
OpenAI Responses key `codex` and `opencode` only.

Orbit already runs a gateway of its own for Codex pools, `/api/gw/codex` (`pool-gateway.controller.ts`,
`pool-gateway.service.ts`, `codex-login-gateway.ts`):

- The engine gets a per-session Orbit token, never the key (`mintPoolGatewayToken`, `orbit-gw-…`, 7-day TTL pushed
  out on every claim).
- The gateway picks the key, waits out or records rate limits (`rateLimitWait`, `throttledUntil`), marks spent and
  invalid keys, and reads usage off the passing stream (`responses-stream-tap.ts`, `openai-prices.ts`).
- The runner reaches it at `PUBLIC_ORIGIN` + `/api/gw/codex` (`poolGatewayUrl`).

| | Today | This design |
|---|---|---|
| Engines for an OpenAI API key | `codex` (default), `opencode` | `codex` (default), `claude`, `opencode` |
| What the runner holds for that key on `claude` | n/a | an Orbit session token; the key stays on the server |
| Who translates Anthropic ⇄ OpenAI | nobody (users would run LiteLLM themselves) | the API server, `/api/gw/anthropic` |
| Translation state | n/a | none on the server: what must survive a turn travels in the transcript (§4.3) |

## 2. Goals and non-goals

**Goals**

1. Adding an OpenAI key is the whole set-up. Choosing Claude Code and a GPT model is the whole choice.
2. Everything Orbit does for a Claude session keeps working: tools, MCP, subagents, skills, compaction, resume,
   effort, auto-retry, cost and usage.
3. The key never reaches the runner, so commands the agent runs cannot read it.
4. A deployment that does not turn the gateway on behaves exactly as today, field for field.

**Non-goals**

- **ChatGPT logins.** The Codex pools' ChatGPT accounts are not offered to Claude Code (decision D4).
- **A general translation proxy.** The gateway serves Orbit's own Claude Code sessions, authenticated by Orbit's own
  tokens. It is not an endpoint for other clients.
- **Changing what `codex` does with an OpenAI key.** Codex stays the default engine for it (D7).
- **Gemini and Moonshot keys.** The same gateway shape could carry them later. Not in this design.

## 3. What a person sees

1. **Infrastructure page.** Adding an OpenAI key is unchanged. The key's engine list reads "Codex · Claude Code ·
   OpenCode". The clients read that list from the API's `engines` field (contract §6.3), so the clients need no new
   logic for it.
2. **Connection form.** The line saying which processes the key is handed to (wiki entry 34dgAezaocJUDulv5Kc40) says
   that on Claude Code the key stays on the Orbit server. P3 found that only the web had such a block, and only for
   DeepSeek and Cursor keys. It added one for OpenAI keys. The Claude Code line shows when the server lists Claude
   Code among the key's engines; a key not yet saved has no such list, so it shows on a saved key. iOS, macOS and
   Android have no connection form: keys are added and edited on the web.
3. **New session.** The engine picker offers Claude Code for the OpenAI key. The model list is the key's GPT models.
4. **In the session.** Nothing differs from a DeepSeek-on-Claude-Code session: the same tool cards, effort control,
   compaction and cost line.
5. **Errors.** A spent key, an invalid key or a model the key cannot use is reported in Orbit's words, naming the key
   (§5.4). The Codex gateway does the same today.

All new copy is English (CLAUDE.md §5).

## 4. Design

### 4.1 Components

```
runner                                 API server                                   OpenAI
claude ── Messages (SSE) ──▶ /api/gw/anthropic/v1/messages
          Bearer orbit-gwk-…           1. token → (session, key, owner)       ── Responses (SSE) ──▶ /v1/responses
                                       2. request: Messages → Responses               Bearer sk-…
                                       3. stream: Responses events → Messages events
                                       4. usage, errors, key state
```

- **Route.** `@Controller('gw/anthropic')`, beside `gw/codex`. The CLI appends `/v1/messages` to its base URL and
  adds `?beta=true` (memory: the path must be matched without the query). The gateway answers:
  - `POST /v1/messages`: the turn, streamed or not.
  - `POST /v1/messages/count_tokens`: a count (§4.6).
  - Anything else gets a refusal in Anthropic's error shape, the way `gatewayAllows` refuses unlisted Codex paths.
    That includes the `HEAD <base>/api/hello` the CLI sends before its first request. The recorder answered it 404
    and the session ran normally (P0, `fixtures/claude-cli-2.1.322/basic.json` request 1).
- **Translator.** A pure module, `src/apiserver/src/providers/anthropic-gateway/`: `toResponsesRequest(body, ctx)`
  and a stream converter fed Responses SSE bytes that emits Messages SSE bytes. It does no I/O, so it can be tested
  against recorded fixtures alone.
- **Upstream.** The key row's `baseUrl` + `/responses`, sent with the existing `sendUpstream` / `relayStream`
  helpers (`relayStream` takes a conversion, so the translator sits between the upstream's bytes and the CLI's).
  Nothing the CLI sent is forwarded as a header: the gateway builds the request's headers itself (type, accept,
  the key), so the caller's `OpenAI-Organization` and `OpenAI-Project` never reach OpenAI (wiki pitfall
  34mMW9abYYvUTlWPS4nti), nor its Anthropic headers. Which hosts are allowed is decision D3.

### 4.2 Tokens and dispatch

- **Token.** A new table, `key_gateway_token`: `id`, `sessionId`, `providerId` (the key row), `userId`,
  `tokenHash`, `expiresAt`, `revokedAt`. The prefix is `orbit-gwk-`. It follows `mintPoolGatewayToken`: minted on
  each claim, reclaim and provider-switch reload; older tokens of the same session and key stay good, because a warm
  engine keeps the environment it was spawned with. A token is revoked when:
  - the session ends,
  - the key is deleted (the rows go with it), disabled or rotated — a new secret, endpoint or protocol
    (`revoked_at`, set by the key's update),
  - the owner's account is disabled (refused as `ACCOUNT_DISABLED`, as `gw/codex` does).

  It is a new table rather than a nullable `poolId` on `PoolGatewayToken`, so the pool tables' invariants and
  tenant-isolation cases stay as they are.
- **Compatibility.** `keyEngines` adds `claude` for the `openai` dialect, after `codex`, only when the deployment has
  the gateway on (D6): `ORBIT_CLAUDE_OPENAI_GATEWAY=true` (docs/configuration.md), and only for a key whose endpoint
  the gateway may call (§5.3). `EngineCredential` gains no
  field: the server passes the switch (`EngineTableOptions.anthropicGateway`) when it builds the `engines` list. The
  Swift and Kotlin mirrors take no switch: the clients read a key's engines off `/providers`.
- **Environment.** In the `claudeEnv` branch, a key whose dialect is `openai` gets:
  - `ANTHROPIC_BASE_URL = PUBLIC_ORIGIN + /api/gw/anthropic` and `ANTHROPIC_AUTH_TOKEN = orbit-gwk-…`
    instead of the row's endpoint and key.
  - `ANTHROPIC_DEFAULT_HAIKU_MODEL` = the key's small model (§4.5).
  - A build that minted no token (a read that dispatches nothing) gets an empty `ANTHROPIC_AUTH_TOKEN`, never the
    key.
  - The rest of the block as today: `ANTHROPIC_MODEL`, inline tools off (the host is not Anthropic's), the Explore
    switch, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, effort.

  The sign-in preflight already treats `ANTHROPIC_AUTH_TOKEN` as the session's own credential
  (`engine-signin-preflight.ts`), so it does not refuse the session for the runner's missing Claude login.
- **Runner.** No change expected: it already reaches `PUBLIC_ORIGIN` for `gw/codex`, and the region check already
  passes non-Anthropic hosts. The region check is confirmed from the code: `claudeTurnIsAnthropicBound` returns false
  for any `ANTHROPIC_BASE_URL` that `isAnthropicHost` does not name. Reaching the gateway from a real runner is
  P1's end-to-end run.
- **Prompt suggestions** stay off: the gateway is not a measured endpoint (`prompt-suggestions-switch.ts`). Turning
  them on is later work.

### 4.3 Request mapping (Messages → Responses)

Every request is sent with `store: false` and `include: ["reasoning.encrypted_content"]`, so OpenAI keeps nothing and
the server keeps nothing. Reasoning comes back encrypted and travels inside the transcript.

| Anthropic request | Responses request |
|---|---|
| `system` (string or text blocks) | `instructions` (blocks joined; `cache_control` dropped) |
| the `system` block `x-anthropic-billing-header: cc_version=…` (always the first block, P0) | dropped |
| a message with `role: "system"` (the CLI puts its environment and tool notices between user turns, P0) | `message` item, role `developer`, `input_text`, in place |
| user `text` / `image` (base64 or URL) / `document` (PDF) | `message` item, `input_text` / `input_image` (data URL) / `input_file` |
| assistant `text` | `message` item, role assistant, `output_text` |
| assistant `tool_use {id, name, input}` | `function_call {call_id: id, name, arguments: JSON}` (no item `id`) |
| user `tool_result {tool_use_id, content, is_error}` | `function_call_output {call_id, output}`; error flag folded into the text as `Error: …`; a result with images is a list of `input_text` / `input_image` parts (§8) |
| `tool_result` content `tool_reference {tool_name}` (ToolSearch's answer) | the line `Tool loaded: <name>`, and the named tool is declared from then on |
| assistant `thinking {thinking, signature}` whose signature carries an Orbit envelope | `reasoning {encrypted_content, summary}` decoded from the envelope; sent without the item `id`, as Codex does, since with `store: false` OpenAI has no item to look an id up against |
| `thinking` / `redacted_thinking` without an envelope (from an earlier Anthropic or DeepSeek turn) | dropped |
| `tools[]` (custom) | `{type: function, name, description, parameters: input_schema, strict: false}` |
| `tools[]` with `defer_loading: true` | left out until a `tool_reference` names it; `DeferredToolPlaceholder` is never sent |
| `tools[]` server tool `web_search_*` | `{type: web_search}` (§4.7) |
| `tools[]` any other server tool (`web_fetch_*`, …) | dropped and reported to the caller |
| `tool_choice` auto / any / tool / none | `auto` / `required` / `{type: function, name}` / `none`; `disable_parallel_tool_use` → `parallel_tool_calls: false` |
| `max_tokens` | `max_output_tokens` |
| effort (`output_config.effort`, or a `thinking` budget when no effort is sent) | `reasoning: {effort, summary: "auto"}`: low, medium, high, xhigh; `max` → `xhigh`; held to the model's highest declared level; no effort and no thinking → no `reasoning` |
| `thinking: {type: "adaptive", display: "updates"}`, `context_management` | dropped |
| `temperature`, `top_p`, `top_k`, `stop_sequences` | dropped (reasoning models reject them) |
| `metadata.user_id` | not sent; `prompt_cache_key` = the session id, so OpenAI's own caching keeps one prefix per session |
| `model` | §4.5 |

**The reasoning envelope.** Claude Code keeps `thinking` blocks in its transcript and sends them back with their
`signature` untouched. The gateway therefore puts OpenAI's reasoning item into the signature:
`orbit1.<base64url(JSON {id, encrypted_content})>`. On the next request it decodes the envelope back into a
`reasoning` input item. A signature without the `orbit1.` prefix is not ours, so its block is dropped. This keeps the
gateway stateless across several API servers (`gateway/several-apiservers`), restarts and resumes, and a session that
switches its model away and back loses nothing it could still use.

The translator is `src/apiserver/src/providers/anthropic-gateway/` (`toResponsesRequest`, `toInputTokensRequest`,
`MessagesStreamConverter`, `assembleMessage`, `upstreamModel`), tested by `providers/anthropic-gateway.spec.ts` against
requests claude 2.1.322 really sent (`providers/fixtures/claude-cli-2.1.322/`, recorded with
`scripts/claude-gateway-recorder/`). What the CLI sends for effort is in §8.

### 4.4 Stream mapping (Responses → Messages)

| Responses event | Messages events |
|---|---|
| `response.created` | `message_start` (id, model, `usage.input_tokens` 0 until the end) |
| `response.output_item.added` message | `content_block_start {type: text}` |
| `response.output_text.delta` | `content_block_delta {text_delta}` |
| `response.output_item.added` reasoning | `content_block_start {type: thinking}` |
| `response.reasoning_summary_text.delta` | `content_block_delta {thinking_delta}`; a second and later summary part (`reasoning_summary_part.added`) is preceded by a blank line |
| `response.output_item.done` reasoning | `content_block_delta {signature_delta: orbit1.…}`, then `content_block_stop` |
| `response.output_item.added` function_call | `content_block_start {type: tool_use, id: call_id, name, input: {}}` |
| `response.function_call_arguments.delta` | `content_block_delta {input_json_delta}` |
| `response.output_item.done` function_call that had no argument deltas | one `input_json_delta` with its `arguments`, then `content_block_stop` |
| `response.output_item.done` (others) | `content_block_stop` |
| `response.output_item.done` web_search_call with a `search` action | `server_tool_use` and `web_search_tool_result` blocks (§4.7) |
| `response.output_item.added` of any other item | nothing |
| `response.completed` / `.incomplete` | blocks still open are stopped, then `message_delta {stop_reason, usage}`, then `message_stop` |
| `response.failed`, stream `error` | an Anthropic `error` event (§5.4) |
| the upstream ends without any of the above | an `error` event `api_error`, never a silent end |

- **Stop reason:** a function call in the output → `tool_use`; `incomplete` for `max_output_tokens` → `max_tokens`;
  a content filter → `refusal`; otherwise `end_turn`.
- **Usage:** `input_tokens` = input − cached; `cache_read_input_tokens` = `input_tokens_details.cached_tokens`;
  `output_tokens` = output, reasoning included.
- **Keep-alive:** `ping` events while the upstream is silent, so neither nginx nor the CLI times out during a long
  reasoning phase.
- **Non-streaming requests** go upstream streamed and are assembled into one Messages response.

### 4.5 Models

- **The session model** (a GPT id) passes through as `model`.
- **Background requests.** Claude Code sends some requests on its "haiku" slot: WebFetch summaries, small side
  questions. P0 recorded one (a WebFetch summary, `tools: []`, no `thinking`). With `ANTHROPIC_DEFAULT_HAIKU_MODEL`
  unset it carried the session model (`gpt-5.5`), not a Claude id; with it set, that model
  (`toolsearch-r2.json`, `toolsearch-haikur2.json`). A headless runner session sent no title request. Subagents ran on
  the session model (`subagent-r2.json`). Dispatch sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` to the key's small model: the
  first `mini` model of the key's list, the preset's or the row's own (`gatewaySmallModel`); none, and it is unset. As a backstop, the gateway also rewrites any `claude-*haiku*` id to
  that model, and any other `claude-*` id to the session model, so no request reaches OpenAI with a Claude id.
- **Context windows.** The `openai` preset's models (`providerPresets.ts`) need a `contextWindow`, so
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set. Without it the CLI assumes 200k.
- **Catalog and effort levels** come from the key's models, as for any other key on Claude Code
  (`declaredReasoningLevels(row, model, CLAUDE)`).

### 4.6 count_tokens and compaction

- `POST /v1/messages/count_tokens?beta=true` translates the body as in §4.3 (`toInputTokensRequest`) and asks OpenAI's
  input-token count endpoint. If that endpoint fails, it answers an estimate of characters ÷ 4
  (`estimateInputTokens`). An over-count only makes the CLI compact a little early. P0 saw the CLI call it only for
  `/context`: 23 calls, each `{model, messages, tools}` with no `system`, one per prompt section, one for the tool
  set, and one per deferred tool alone (`context-x.json`). Ordinary turns and compaction never called it. So a slow or
  estimated count costs nothing on the turn path.
- **Overflow.** An upstream `context_length_exceeded` is answered as Anthropic's 400 `invalid_request_error`
  "prompt is too long: N tokens > M maximum", the wording Claude Code reacts to by compacting
  (`anthropicError`; M is the declared window, N the estimate, at least M + 1). P0 confirmed the wording on 2.1.322
  (§8).

### 4.7 Web search (P3, decision D5)

Claude Code's WebSearch is a client tool that runs its own request. Recorded from claude 2.1.322
(`fixtures/claude-cli-2.1.322/websearch.json`): WebSearch is a deferred tool, loaded by ToolSearch. When the model
calls it, the CLI sends a separate `/v1/messages` request. That request has a short system prompt of its own, the user
text `Perform a web search for the query: <query>`, `tool_choice: auto` and exactly one tool:
`{type: "web_search_20250305", name: "web_search", max_uses: 8}`. The CLI reads two blocks from the answer: the query
from a `server_tool_use` block, and `{title, url}` of each result from a `web_search_tool_result` block. It counts each
search, and sends its model a `tool_result` of `Web search results for query: "<q>"`, then `Links: [{title, url}, …]`,
then the answer text. The CLI lists the links before the text, whatever order the blocks came in.

| Anthropic | OpenAI Responses |
|---|---|
| `web_search_*` server tool | `{type: "web_search"}`; `allowed_domains` → `filters.allowed_domains`; `user_location` as is; `blocked_domains` and `max_uses` have no equivalent and are not sent |
| — | on an OpenAI key, `include` adds `web_search_call.action.sources`, so the call lists every page it read. A login pool does not ask: nobody has recorded the Codex backend's answer to that include. |
| `server_tool_use {id: srvtoolu_<call id>, name: web_search, input: {query}}` | `web_search_call` done with `action.type: search`; the query is `action.query` |
| `web_search_tool_result {tool_use_id, content: [web_search_result {title, url, encrypted_content: "", page_age: null}]}` | the call's `action.sources` (title = URL; OpenAI gives none). A call without sources gets its result block once the answer is done: the answer's `url_citation`s, with their titles. A cited page that no result listed is added the same way. |
| `usage.server_tool_use.web_search_requests` | the number of searches |

The `open_page` and `find_in_page` actions are not searches, so they write no block. Both upstreams use the same
translator, so a Claude Code session on an OpenAI key and one on the owner's own Codex login pool search the same
way. The real CLI runs a search on each of the two upstreams in `anthropic-gateway-cli.e2e.ts`. OpenAI's
per-search fee is not priced (openai-prices prices tokens only), so the cost line leaves it out.

## 5. Security, quota and failure

### 5.1 The key

- The key is decrypted on the API server only for the upstream request. It is never in the runner's environment,
  the session's env or a log.
- This is stronger than any key session today: wiki entry 34dgAezaocJUDulv5Kc40 records that commands run under
  Claude Code can read the key.

### 5.2 Tokens

- A token authenticates (session, key, owner) and nothing more. It is good only for the gateway's paths.
- It is stored only as a hash and listed in `tenant-isolation-runner-cases.ts` beside `gw/codex`.
- A stolen token spends the key only until the session ends or the TTL runs out (7 days, pushed out on each claim),
  and only on the paths in §4.1.

### 5.3 Outbound requests (SSRF)

The API server now makes requests to a URL taken from the key row. A key row whose `baseUrl` points at an internal
address would turn the server into a proxy into its own network. Decision D3 picks the rule. The recommendation:
`api.openai.com` only at first, plus hosts the deployment admin lists in an environment variable. Redirects are not
followed.

As built (P2, `gateway-upstream.ts`):

- The variable is `ORBIT_GATEWAY_UPSTREAM_HOSTS` (docs/configuration.md): host names, comma- or space-separated.
- A key's endpoint must be an `https` URL, with no user name or password, on `api.openai.com` or a listed host. An IP
  literal must be listed and public.
- Before connecting, the gateway resolves the host. If any address it resolves to is not public, the request is
  refused. Non-public means loopback, private, link-local, carrier-grade NAT, multicast, reserved, unique-local,
  IPv4-mapped and NAT64. The connection is then pinned to the address that was checked, so a second lookup cannot
  answer differently.
- A refused key's request gets 403 `permission_error`, naming the key and why, and nothing connects. A resolver
  failure is 529, like an unreachable upstream.
- A 3xx from upstream is answered as 502 `api_error`, and its `Location` is not passed on. For `count_tokens`, the
  estimate answers instead.
- With the flag on, a key whose endpoint fails the URL rule is not offered `claude` at all
  (`engineTableOptions(baseUrl)`). What a listed name resolves to is checked at each request.

### 5.4 Errors and quota

Errors are answered in Anthropic's shape, `{type: "error", error: {type, message}}`, so the CLI's own retries and
Orbit's auto-retry (`auto-retry.service.ts`, which matches "529 … overloaded_error") keep working. The table is
`gatewayFailure` (`anthropic-gateway.service.ts`). P2 measured how claude 2.1.322 reacts to each answer. It retries
every one of them up to ten times over about three minutes, a 401 and a 429 included, unless the answer carries
`x-should-retry: false`. So the gateway sends that header on every row but the overload and the overflow.

| Upstream | Answered | What the CLI does (2.1.322) | Also |
|---|---|---|---|
| 401 | 401 `authentication_error` "OpenAI refused the key "<label>": … Orbit marked it invalid: add a new key in Providers to go on." | fails the turn: "Failed to authenticate. API Error: 401 …" | marks the key INVALID (`key_check_state`, as a Cursor key's check records a refusal), only while the row still holds the refused secret. Later turns are refused by the gateway without asking OpenAI, until a new secret clears the mark. Ingestion reads the words as a sign-in failure and arms nothing. |
| 403 | 403 `permission_error` "The key "<label>" may not use the model "<model>" on OpenAI: …" | fails the turn: "Failed to authenticate. API Error: 403 …" | nothing armed |
| 404 / `model_not_found` | 404 `not_found_error` "OpenAI has no model "<model>" for the key "<label>": …" | fails the turn in its own words: "There's an issue with the selected model (<model>) …" | nothing armed |
| 429 `rate_limit_exceeded` | waited out on the same key within `sendUpstream`'s bound (`rateLimitWait`: 4 sends, ≤ 20 s a wait, ≤ 40 s in all); then 429 `rate_limit_error` "OpenAI is rate-limiting the key "<label>", and was still refusing after the Orbit gateway waited: …" | inside the bound it never sees the limit. Past it, it fails the turn once: "API Error: Request rejected (429) · …" | auto-retry arms on the API-error ladder |
| 429 `insufficient_quota` (and the rest of `SPENT_ERROR_CODES`) | 429 `rate_limit_error` "You hit your usage limit on the OpenAI key "<label>" · resets Dec 1, 12:00am (UTC)" | fails the turn once: "API Error: Request rejected (429) · You hit your usage limit …" | records `model_provider.spent_until` (migration 0520). It is the reset OpenAI names, else the first of next month (`spentUntil`). The next answered request clears it, and so does a new secret. Ingestion reads the words as a spent quota and arms the retry for that reset (below). |
| 5xx / overload / unreachable | 529 `overloaded_error` "OpenAI could not answer (<status>): …" | retries on its own and usually completes. If it still fails: "API Error: 529 …" | auto-retry re-sends on the API-error ladder |
| `context_length_exceeded` | 400 `invalid_request_error` "prompt is too long: N tokens > M maximum" | compacts and retries the turn (§4.6) | |

**The quota wording.** For a key session, Orbit's quota handling reads the reply itself: `isUsageLimitErrorText`,
then `parseQuotaResetAt` in `quotaRetryAt`. The runner's account snapshot says nothing about a key. The reply must
open with the quota sentence: the marker may start at character 40 at the latest (`USAGE_LIMIT_MARKER_MAX_OFFSET`;
the Go, Kotlin and Swift mirrors read the same 40). The CLI prints a 429 as "API Error: Request rejected (429) ·
<message>", which is 36 characters. "You hit your usage limit" therefore puts the marker at exactly 40, and "You've hit
…" would be one too far. The reset carries its date and is named in UTC, which `parseQuotaResetAt` reads back to the
minute. Anthropic's `anthropic-ratelimit-unified-*` headers were tried as well: for a session that is not a claude.ai
subscriber the CLI ignores them, so they change nothing.

**Failures inside the stream.** OpenAI may report a failure as the stream's first event (`response.failed` or
`error`, after `response.created`) instead of as an error status. The gateway reads up to that first event before it
sends its own head (`earlyFailure`), so such a failure is answered exactly like the error status above, with its
status and side effect. A failure after output has begun can only be an SSE `error` event. On such an event the CLI
drops the stream and asks again unstreamed. The gateway answers an unstreamed request by reading the response whole,
so a failure there is answered with its status too, never as a 200. Either way, the key is marked as the table says.

### 5.5 Cost and usage

- The gateway reads each answer's usage off the Responses stream as it passes, with the tap the pool gateway uses
  (`responses-stream-tap.ts`), and never buffers the stream for it. An unstreamed answer is read the same way, from
  the body it already reads whole. The usage is priced with `openai-prices.ts` at the model and tier the answer
  names. One write per answer, after the answer is out, records it three ways: a `key_gateway_usage` row per session
  and key (migration 0525: input with cached included, cached, output with reasoning included, reasoning, and
  `cost_micros`), a `usage` row (input counted without the cached part, as a Claude row counts it, with the cached
  part as `cache_read_input_tokens`), and the cost added to `session.cost_usd`.
- Claude Code's own `total_cost_usd` for a GPT id is its guess from its own price table. Under D8, turn-complete
  books neither that figure nor the CLI's `modelUsage` for a session the gateway books (`gatewayBooksSpend`: Claude
  Code on the key a gateway token was minted for). It still keeps the CLI's running totals, so that the next
  completion is measured from them. Spec: `key-gateway-usage.pg.spec.ts`.

### 5.6 Load

Each such turn is a long-lived stream through the API server, in addition to today's traffic. Streams are relayed,
not buffered, and the server holds at most one SSE event per stream (as `responses-stream-tap` does). P2 measures
memory and connection counts with 20 concurrent sessions.

## 6. Decisions for the owner

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Who translates | **A** a translator written in the API server · B a LiteLLM container behind the gateway, which still does tokens, keys and usage | **A**: no new container in Compose, Kubernetes or self-hosted installs, and errors, quota and haiku mapping stay in Orbit's code. LiteLLM's mapping serves as a reference in tests. |
| D2 | Upstream API | **A** Responses · B Chat Completions | **A**: OpenAI's current API, encrypted reasoning that survives turns, and the same API the Codex gateway already reads. |
| D3 | Which keys may use the gateway | **A** host `api.openai.com`, plus hosts an admin lists · B any OpenAI-dialect row, with private addresses blocked | **A** first (§5.3); B later if people ask for Azure or other Responses-compatible hosts. |
| D4 | ChatGPT logins (Codex pools) on Claude Code | **A** not offered · B offered later as an opt-in | **A**: ChatGPT's Codex backend is not a public API, and on a hosted multi-user service an account ban is the owner's risk. **Amended 2026-11-11:** offered on the account owner's own Codex login pool only, behind its own flag, with no disguise (§9). |
| D5 | Claude Code's web search (an Anthropic server tool) | **A** first release: the tool reports "not available on this model"; mapped to OpenAI's `web_search` in P3 · B mapped from P1 | **A**: the mapping is the largest single piece and the rest does not depend on it. P3 mapped it (§4.7). |
| D6 | Rollout | **A** deployment flag, default off, until the P3 quality gate passes · B on from P1 | **A**: the engine only shows up once it is known to work. |
| D7 | Default engine for an OpenAI key | **A** stays `codex` · B `claude` | **A**: nothing changes for anyone who doesn't pick Claude Code. |
| D8 | Cost line for these sessions | **A** the gateway's priced usage · B the CLI's own figure | **A**: the CLI does not know GPT prices. |

## 7. Phases

Each phase depends on the one before it.

| Phase | What | Done when |
|---|---|---|
| **P0 Spike** | Record what Claude Code (the version the runner ships) sends to a fake Anthropic endpoint: paths, headers, effort fields, haiku requests, count_tokens, and the overflow wording. Write the translator against those fixtures. Run it once against OpenAI from a scratch script. | A recorded 10-turn session with parallel tool calls, a subagent, reasoning carried across turns and one compaction completes through the translator against OpenAI. Each P0 question in this document has a recorded answer. |
| **P1 Wiring** | `gw/anthropic` route, `key_gateway_token` and its migration, dispatch environment, compatibility behind the D6 flag, contract §2.1 and §4.2 updated, tenant-isolation cases. | With the flag on, a session on an OpenAI key and Claude Code runs end to end on a real runner. With it off, the dispatch environment and `engines` of every existing session are unchanged (the `provider-engine-resolution` comparison). |
| **P2 Production behaviour** | Error and quota mapping (§5.4), rate-limit waits, key marking, usage and cost (§5.5), count_tokens, haiku mapping, load check (§5.6). | Each row of §5.4 has a test that drives the real CLI through the gateway against a fake upstream (`anthropic-gateway-cli.e2e.ts`, `npm run test:gateway-cli`). 20 concurrent sessions stay within the server's memory budget. |
| **P2b Owner's Codex login pool** | Claude Code on the account owner's own Codex login pool behind `ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY` (§9). | The probe accepts an undisguised request; specs show no account token in the environment, shared pools refused and flag-off parity; a real-runner session on the owner's pool. |
| **P3 Quality and release** | The same task set on `codex` + GPT and on `claude` + GPT; web search mapping (D5); copy, docs and the connection-form line. | The owner reads the comparison and decides whether to turn the flag on. |

## 8. What P0 answered

These were the open questions. P0 answered them on 2026-11-11 by recording **claude 2.1.322**, the version this
runner installs, against a fake Anthropic endpoint. The run used the runner's own flags (`claude_spawn.go`) and the
`claudeEnv` block of `injectedEnv`: `CLAUDE_CODE_INLINE_TOOLS=false`, `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1`,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `ENABLE_CLAUDEAI_MCP_SERVERS=0`, an `orbit-gwk-` bearer token, and `--model gpt-5.5`.
The recordings are in `src/apiserver/src/providers/fixtures/claude-cli-2.1.322/`, and the recipe is
`scripts/claude-gateway-recorder/`.

No OpenAI API key was available to P0: the account has none, and the environment has none. The questions about
OpenAI's side are therefore answered from OpenAI's API reference and stay marked as not measured. The P1/P2
end-to-end run against OpenAI settles them.

1. **Which effort fields Claude Code sends for a non-Claude id, and whether `--effort` reaches the request.**
   It does. Every request carries `output_config: {effort}`, with the `--effort` level verbatim: `low`, `medium`,
   `high`, `xhigh`, `max`. With no flag it is `high`. Beside it the request carries
   `thinking: {type: "adaptive", display: "updates"}` and the `effort-2025-11-24` beta header, at every level.
   No `budget_tokens` is ever sent (`effort-{low,medium,high,xhigh,max,none}.json`). The translator maps the effort
   as §4.3 says. `CLAUDE_CODE_EFFORT_LEVEL=unset` was not recorded. `custom-provider.ts` documents it as the CLI's
   spelling for "send no effort parameter". With no effort and no thinking in the request, the translator sends no
   `reasoning`.
2. **Whether OpenAI's input-token count endpoint accepts the same body as `/responses`.** Not measured: no key.
   OpenAI's reference documents `POST /v1/responses/input_tokens`, taking the same `model`, `input`,
   `instructions` and `tools`, and the translator builds exactly that body (`toInputTokensRequest`). The
   recordings make the question matter less than assumed. The CLI calls count_tokens only for `/context`, never on
   a turn or a compaction (`context-x.json`), so the ÷ 4 fallback is a safe answer whenever the endpoint refuses.
3. **Whether a `function_call_output` may carry images.** The CLI side is recorded. Read on a PNG returns a
   `tool_result` whose content is `[{type: "image", source: {type: "base64", media_type: "image/png", data}}]`
   (`image-r2.json`). OpenAI's reference documents `function_call_output.output` as a string or a list of
   `input_text` / `input_image` / `input_file` parts. The translator sends that list, so no extra user message is
   needed. Not measured against OpenAI: no key. If the live API refuses it, the fallback in the earlier draft (a
   following user message) is a change local to `translateToolResult`.
4. **Whether Claude Code accepts an arbitrary string as a `thinking` signature from a non-Anthropic host.**
   It does. The recorder answered thinking blocks whose signature was `orbit1.<base64url JSON>`. The CLI kept each
   one byte for byte and sent it back on the next request of the same turn (`thinking.json`) and on later user
   turns (`thinkturns.json`: the third request carries both earlier thinking blocks). It also sends
   `context_management: {edits: [{type: "clear_thinking_20251015", keep: "all"}]}`, which asks the server to keep
   every thinking block. The translator drops that field and keeps them all.
5. **The exact "prompt is too long" wording the CLI matches.** It is a case-insensitive substring match: the CLI
   checks for `prompt is too long` (or `input is too long for requested model`) in the error message. It reads the
   two numbers with `prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)`, and its list of known API messages holds
   `^prompt is too long: \d+ tokens > \d+ maximum$` (strings of the 2.1.322 binary). Behaviour, recorded:
   - On a 400 `invalid_request_error` "prompt is too long: 250000 tokens > 200000 maximum" in the second turn, the
     CLI sent a compaction request ("…create a detailed summary of the conversation…"), wrote an automatic
     `compact_boundary` and retried the turn on the compacted conversation (`toolong-r2.json`).
   - The same 400 on the very first exchange ends the turn with `terminal_reason: "prompt_too_long"`: "A
     single-exchange conversation cannot be compacted" (`toolong.json`).
   - OpenAI's own wording, "Your input exceeds the context window of this model…", made the CLI re-send the same
     request once and never compact (`toolong-openai.json`). So the gateway must rewrite `context_length_exceeded`
     into the Anthropic wording, as §4.6 says.

**What else the recordings changed in this design:**
- The CLI sends `role: "system"` messages inside `messages`, and an `x-anthropic-billing-header` block first in
  `system`. Both rows were added to §4.3.
- Deferred tools come as `defer_loading: true` plus a `DeferredToolPlaceholder`, and ToolSearch answers with
  `tool_reference` blocks that Anthropic's server expands (`toolsearch-r2.json`). The translator now does that
  expansion itself (§4.3).
- The CLI sends `HEAD <base>/api/hello` before its first request (§4.1).
- The headers are `authorization: Bearer <token>`, `anthropic-version: 2023-06-01`, a long `anthropic-beta` list,
  `x-app: cli`, `user-agent: claude-cli/2.1.322 (external, sdk-cli)` and `x-claude-code-session-id`. No `x-api-key`
  is sent (`basic.json`).
- Subagents send the main request's shape on the session model, with `cc_is_subagent=true` in the billing block
  (`subagent-r2.json`).

## 9. Claude Code on the owner's own Codex login pool (P2b)

Decision D4 as amended on 2026-11-11: Claude Code may run on the account owner's **own** Codex login pool, the
ChatGPT accounts they signed in to a pool they made and did not share. Shared pools, and other people's accounts,
are not offered. It sits behind its own deployment flag, `ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY` (off by default,
separate from `ORBIT_CLAUDE_OPENAI_GATEWAY`; [configuration](configuration.md)). No impersonation: Orbit never
sends Codex's system prompt, a Codex user agent or any other disguise to get a request accepted.

### 9.1 The probe

Before anything was built, one request was sent on 2026-11-11 to ChatGPT's Codex backend through the login gateway's
own auth (production `/api/gw/codex`, on the session token of a codex session on the owner's pool `codex-pool`,
from the HPC runner):

- Body: a real `claude -p` 2.1.322 first request, recorded locally with its full system prompt (5,599 characters;
  the checked-in fixtures elide it), translated by `anthropic-gateway/request.ts` for `gpt-5.6-sol`. Its
  `instructions` were Claude Code's own prompt; 21 tools; `max_output_tokens` and `reasoning` as translated.
- Headers: `content-type`, `accept: text/event-stream`, `user-agent: claude-cli/2.1.322 (external, sdk-cli)` and
  the Orbit token. The login gateway of that time added its codex-turn extras (`version`, `x-codex-routing-hint`,
  zstd); the shipped upstream sends none of them (§9.3).
- Answer: **200**, a complete stream, model `gpt-5.6-sol`, 15,505 input and 5 output tokens, text "ok",
  `x-codex-plan-type: pro`. The backend did not refuse Claude Code's own instructions or client, so the build went
  ahead.

### 9.2 Dispatch

- **Compatibility.** The shared table gains `{ kind: 'pool', engine: 'codex', ownLogin: true }` with
  `EngineTableOptions.codexLoginGateway`. With the flag on, such a pool runs `codex` (still the default, D7) and
  `claude`. `ownLogin` is decided on the server (`codex-login-claude.ts` `isOwnCodexLoginPool`: `shared = false`,
  `owner_id` = the session's owner, `engine = 'codex'`) and only while the flag is on. The pool views
  (`GET /providers/pools`) carry `engines` only with the flag on; the runner's provider list (`listUsable`) names
  them for the caller's own pool. The claim's SQL takes `engine = 'claude'` on such a pool only with the flag on.
- **Account.** Each claim chooses the account as for codex (`QueueService.resolveLoginPool` →
  `choosePoolCredential`), but among the accounts the session's owner signed in themselves, and never the pool's
  API keys. The choice is recorded in `pool_codex_account_id`, as for codex.
- **Environment.** `ANTHROPIC_BASE_URL` = `PUBLIC_ORIGIN` + `/api/gw/anthropic`; `ANTHROPIC_AUTH_TOKEN` = the
  pool's own `orbit-gwl-` session token (`mintPoolLoginToken`, the same `pool_login_token` table, hash only, no
  account named). No `OPENAI_*`, `CODEX_HOME`, account id or account token. No `ANTHROPIC_DEFAULT_HAIKU_MODEL`: a
  ChatGPT plan serves the models its Codex catalogue lists, so the haiku slot falls back to the session model.
  The model space is Codex's, as the runner's own Codex catalogue reports it; `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
  comes from that catalogue's window for the model, with the usual eighth held back. No table or column was
  added.

### 9.3 The gateway

`/api/gw/anthropic` answers a login pool's token with `AnthropicLoginGatewayService`. The token must belong to an
open session on engine `claude` on its owner's own unshared Codex pool, with the flag on and no end asked for
(`PoolLoginGatewayService.caller(token, 'claude')`). `/api/gw/codex` refuses such a session's token, and
`/api/gw/anthropic` refuses a codex session's.

- The request is translated as an OpenAI key's is (§4.3) and sent to `CHATGPT_CODEX_BASE/responses` with
  `content-type`, `accept`, `Authorization: Bearer <access token>`, `ChatGPT-Account-ID`, and Claude Code's own
  `User-Agent` as it came. Nothing else is sent: no `version`, `x-codex-routing-hint`, zstd body or guardian
  metadata (those stay codex-only in `loginProviderRequest`), and no Codex prompt.
- The account checks, the refresh (ahead of expiry, and once on a 401), the rate-limit wait, the `spent_until` and
  `throttled_until` marks, the transcript notices and the usage ledger are the login gateway's own code, split
  out of `PoolLoginGatewayService.forward` (`accountFor`, `exchange`, `readUsage`, `answeredWhole`,
  `streamEnded`), which codex's path now calls too.
- Failures reach the CLI in Anthropic's shape with §5.4's statuses, worded for "the ChatGPT account <email> of
  the pool "<label>"". A spent subscription is a 429 starting "You hit your usage limit on …", resetting at the
  reset the login gateway records. The login gateway's own refusals (signed out, paused, no account, disabled)
  are 403 `permission_error` with `x-should-retry: false`; an unreachable backend is 529.
- `count_tokens` answers the characters ÷ 4 estimate (§4.6): the Codex backend has no count endpoint.

### 9.4 Usage and cost

Each answer's usage goes into `pool_login_usage` with its price, as for codex sessions (`PoolLoginLedger`). It is
also booked on the session (`cost_usd` plus a `usage` row, priced with `openai-prices`), and turn-complete then
books none of the CLI's own figure (`gatewayBooksSpend` counts a Claude session's login-pool token). D8 holds.

### 9.5 Copy

Where the engine picker lists the pool under Claude Code (web, iOS/macOS, Android), it says: "Runs Claude Code on
your ChatGPT account outside the official Codex CLI. OpenAI may restrict the account."

### 9.6 Specs

- `gateway-flag-parity.spec.ts`: three new cases (Claude Code on the own pool, Codex and Claude Code on a shared
  pool), recorded at d07cdd060. Off, nothing differs; on, only the own pool's `engines` and its Claude Code
  session do.
- `codex-login-claude.pg.spec.ts`: on real PostgreSQL, the claim's environment holds no account token or id. Shared
  and other people's pools are refused. The request on the wire is Claude Code's own, usage and cost are booked,
  and the spent and refresh paths work.

