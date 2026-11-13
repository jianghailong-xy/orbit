# Ollama as a local model provider: phase 0 compatibility record

**Status:** phase 0 of the project that adds Ollama as a local model provider (`34DuFmuOFfm2JjrANUpis`), task
`34DuK8TS34zi8lqCzvwos`, measured 2026-11-13 on the HPC runner host. This record freezes the default route that the
later phases implement. It adds no code and no `AgentProvider` value.

## 0. Decision (frozen)

| Question | Decision |
| --- | --- |
| Default runtime | **Claude Code** (`ModelProvider.runtime = "claude"`) |
| Dialect | **Anthropic Messages**, served by Ollama itself at `POST /v1/messages` |
| Endpoint rule | `baseUrl` is the Ollama root with no path: `http://127.0.0.1:11434`. Claude Code appends `/v1/messages`. Resolved on the runner the session runs on, so the session must run on the runner that hosts Ollama. |
| Second route | Codex (`runtime = "codex"`) works only on the **OpenAI Responses** dialect, `baseUrl = http://127.0.0.1:11434/v1`, and only once the connector-tool leak in §5.2 is fixed. Not the default; not needed for phase 1. |
| Chat Completions | **Not a route.** Codex 0.167.2 refuses `wire_api = "chat"` at config load (§4, B0). |
| New engine value | **None.** `AgentProvider.OLLAMA` is not added: Ollama is a `ModelProvider` row on an existing engine. |
| Context | At least 64K tokens, set on the Ollama server (`OLLAMA_CONTEXT_LENGTH=65536`) and declared on the row (`contextWindow: 65536`), which Orbit turns into `CLAUDE_CODE_MAX_CONTEXT_TOKENS=57344`. |
| Cloud | The Ollama server runs with `OLLAMA_NO_CLOUD=1`; the provider rejects `*-cloud` model ids (§6). |
| Continue to phase 1? | **Yes, on Claude Code + Messages,** with the requirements in §8. Codex stays behind the §5.2 fix. |

Why Claude Code: on the same model and context, every case in the matrix passed through Claude Code, including the
offline run with all non-loopback traffic dropped (§6.2). Codex passed the same functional cases, but only after a
change Orbit does not make today (`--disable apps`); as Orbit launches it now, its first request is 78,380 tokens
and overflows a 64K model (§5.2). The task's rule was "default to Claude; switch only for a measured gap", and the
measured gaps are all on the Codex side.

## 1. Environment and versions

| Item | Value |
| --- | --- |
| Host | HPC runner `workstation-gpu` (`34P34HcKKoFRn2j9KitgJ`), Linux 6.12, 24 cores, **14 GiB RAM**, 43 GiB swap |
| GPUs | 2 × AMD Radeon AI PRO R9700 (gfx1201, 32 GiB each), ROCm 7.2.4, no GPU peer-to-peer |
| Ollama | **0.40.16** (`ollama-linux-amd64` + `-rocm` tarballs from the GitHub release), unpacked to `/mnt/data/ollama`, run as the transient unit `ollama-orbit-p0` on `127.0.0.1:11434` |
| Claude Code | **2.1.323** |
| Codex CLI | **0.167.2** for the direct matrix B0–B7. The runner's engine update replaced it at 16:48 and left it broken (§7.6); reinstalled as **0.169.0**. |
| Orbit runner | **0.1.254**, self-updated to **0.1.256** at 17:05 during the run |
| Repository | main `3299e485a` |

Server settings used for the results below:

```sh
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=/mnt/data/ollama/models OLLAMA_CONTEXT_LENGTH=65536
OLLAMA_KEEP_ALIVE=-1 OLLAMA_NUM_PARALLEL=2 OLLAMA_NO_CLOUD=1 OLLAMA_DEBUG=1   # 2 slots from 22:28 (§7.7)
HIP_VISIBLE_DEVICES=0 OLLAMA_VULKAN=0          # one ROCm GPU, no Vulkan fallback
LLAMA_ARG_CTX_CHECKPOINTS=4 LLAMA_ARG_CACHE_RAM=1024   # cap llama-server's host-RAM caches (§7.3)
systemd: MemoryMax=8G MemorySwapMax=0 MemoryMin=4G OOMScoreAdjust=-900
         ExecStartPre= read lib/ollama/rocm_v7_2 into the unit's page cache   # §7.2-§7.4
```

These were arrived at during the run, one failure at a time (§7); the earlier cases ran with fewer of them, as noted
per case.

## 2. Model

**`qwen3.8:27b`** (digest `aaee06c39dcf`, 27.3B dense, Q4_K_M, 17.7 GB): Ollama lists `tools` and `thinking`
(levels low/medium/xhigh) and a 262,144-token native window; served at 65,536. It is the same family as the
`local-vllm` provider (Qwen3.8-27B-FP8) this host already runs Claude Code on.

`qwen3-coder:30b` (digest `06c1097efce0`, 30.5B MoE, Q4_K_M) was tried first and rejected: under Claude Code it
wrote its tool calls as plain text (`<function=Read> … </tool_call>`) in 3 of 4 tool turns, so the turn ended with
no tool executed, and it guessed `/root` as the working directory (§4, "qwen3-coder" column).

Both providers were registered as ordinary `ModelProvider` rows (owner-approved cards), nothing else:

| Slug | runtime | baseUrl | models |
| --- | --- | --- | --- |
| `ollama-hpc-messages` | claude | `http://127.0.0.1:11434` | `qwen3.8:27b` (64K, reasoning low/medium/xhigh), `qwen3-coder:30b` (64K) |
| `ollama-hpc-responses` | codex | `http://127.0.0.1:11434/v1` | `qwen3.8:27b` (64K), `qwen3-coder:30b` (64K) |

## 3. How it was tested

- **Direct matrix.** Each engine runs the way the runner starts it: Claude Code with exactly the environment
  `custom-provider.ts` `injectedEnv` builds for a claude row (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_MODEL`, `ENABLE_CLAUDEAI_MCP_SERVERS=0`, `CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1`,
  `CLAUDE_CODE_INLINE_TOOLS=false`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS=57344`). Codex runs with exactly the `-c` overrides
  `codex.go` `codexProviderArgs` builds plus `features.plugins=false`. Each case runs under `strace -e trace=connect`.
  Scripts: `route-a.sh`, `route-b.sh`, `interrupt-a.sh`.
- **Offline proof.** `offline.sh` runs each engine in its own cgroup, with an nftables rule that drops every
  non-loopback packet from it, after a self-check that `https://api.anthropic.com` fails and Ollama answers from inside.
- **Real Orbit runs.** A new Orbit session and an Orbit task run on `ollama-hpc-messages` (§5.1).
- **Request capture.** `capture/srv.py` stands in for the endpoint and records the request body Codex sends.

The kit and all raw outputs are in the task's uploads (`p0/`, listed in §9).

## 4. Test matrix (same model `qwen3.8:27b`, same 64K window)

Latency is wall time per `claude -p` / `codex exec` process. The Route A warm run used Ollama's Vulkan backend
(prefill 370 tok/s); Route B and the Orbit runs used ROCm. They are not like-for-like, and host load varied between them (§7.1).

| Case | A: Claude Code + Messages (`/`) | B: Codex + Responses (`/v1`, apps off) |
| --- | --- | --- |
| B0 Chat Completions | n/a | **Fail at config load, 0.4 s:** `` `wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"` `` — no request sent |
| Start + streaming | Pass, 72 s; 218 `content_block_delta` events, reply `PONG-A` | Pass, 26.6 s, reply `PONG-B`; request has `"stream": true` (Codex `exec --json` prints no deltas) |
| read / edit / bash | Pass, 78 s: `Read` → `Edit` → `Bash`, prints `5` | Pass, 10.3 s: `command_execution` → `file_change` → `command_execution`, prints `5` |
| Multi-turn in a new process (`--resume` / `exec resume`) | Pass, 37 s: recalls `5`, appends `resumed: yes` | Pass, 5.2 s: recalls `5`, appends `resumed: yes` |
| Interrupt mid-turn | Pass: SIGINT while the `tick` loop ran (2 ticks out); Claude Code records the call as rejected, exit 0 | Pass: SIGINT mid-turn, exit 1, thread kept |
| Continue after the interrupt (new process) | Pass: writes `after2.txt` = `CONTINUED` | Pass: writes `after.txt` = `CONTINUED` |
| Unknown model | `There's an issue with the selected model (no-such-model:1b). It may not exist or you may not have access to it.` exit 1 | `stream disconnected before completion: model 'no-such-model:1b' not found` after 5 reconnects, exit 1 |
| Endpoint down | `API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)` after 230–433 s of retries | **Never fails:** `Reconnecting... waiting for network` 24× over 20 min, killed by hand |
| Cold start (model not loaded) | 224 s with `qwen3-coder:30b` (load 2m10s); **never completes** for `qwen3.8:27b` under swap (§7.1) | same server-side behaviour |
| Fully offline (non-loopback dropped) | **Pass:** Read/Edit/Bash + resume, 693 s + 104 s; 102 packets dropped | First turn not completed: timed out while the Orbit probe held Ollama's single slot (§9 gaps) |
| As Orbit launches it today (no `--disable apps`) | — | **Fail every turn:** `request (78380 tokens) exceeds the available context size (65536 tokens)` (§5.2) |

`qwen3-coder:30b` through Route A (same harness, rejected model): cold start 224 s pass; read/edit/bash **fail**
(tool call printed as text); resume **fail** (same); interrupt pass; error texts identical to the table.

## 5. Real Orbit runs

### 5.1 Claude Code + Messages

Both runs used the `HPC` workspace (runner `workstation-gpu`, no worktree), provider `ollama-hpc-messages`, model
`qwen3.8:27b`, permission mode `auto`. The runner started Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:11434`,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=57344`, `--effort xhigh` and no `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (read from
`/proc/<pid>/environ` of the live process). Every `message.model` in both transcripts is `qwen3.8:27b`, and every
model request is in Ollama's access log.

| Step | New session `34wmwzBlVxO7Vk4xWLlDt` (probe A2) | Task run `34wtKTsxHsPmK3iDuDild`, session `5xkdVYat5NTzjtVl9G0tMn` |
| --- | --- | --- |
| Streaming reply | Pass | Pass |
| Write → Edit → Bash | Pass: `probe.py` written, `+` fixed to `*`, prints `42` | Pass: written, `+` fixed to `-`, prints `7` |
| Orbit MCP tool | `runner_list` → `5 runners online` | `runner_list` → 5 online |
| Multi-turn | Recalls `42` in a later turn | Recalls `7` and `5` from memory in a later turn, after two compactions |
| Engine process lost | Ollama was OOM-killed mid-turn; the turn ended `ECONNREFUSED`, the session `FAILED`; `session_send resumeIfEnded` revived it and the conversation carried on | — |
| Interrupt mid-command | `session_interrupt` while a foreground 20-step loop ran: stopped at 15/20, transcript `[Request interrupted by user for tool use]`, no process left | Same with a 30-step loop: stopped at 6/30 |
| Continue after interrupt | Next turn counted 15, said it was interrupted, appended `RESUMED` | Next turn counted 6, appended `RESUMED` |
| Compaction at 64K | Compacted once, carried on | Compacted twice, carried on |

What it took: both runs lost tool calls to the `auto` classifier (§7.7). The task run's `Write` was refused 9 times
with one Ollama slot, because the classifier's 35K-token prompt and the conversation evicted each other's cache, and
once more on the second slot while it was still cold; with `OLLAMA_NUM_PARALLEL=2` and that slot warm it passed.
An interrupt sent while the model had moved the command into an Orbit background job (`bg_run`) arrived after the
turn had already ended and acted as an ordinary next message; the interrupt rows above are the foreground reruns.

### 5.2 Codex: connector tools reach the custom endpoint

`codex.go` sets `features.plugins=false`, documented (on 0.161.0) as removing the login's `codex_apps` connector
tools. On 0.167.2 it no longer does. With the runner's exact overrides plus `features.plugins=false` the first `POST /v1/responses`
is 328,900 bytes with 22 tools, 10 of them `mcp__codex_apps__*` (`chatgpt_space`, `github`, `gmail`, `sites`, …);
without `plugins=false` it is 341,737 bytes, 314,962 of them tool schemas. Either way it is about 78K prompt tokens
on this model (`request (78380 tokens) exceeds the available context size (65536 tokens)`). `--disable apps`
brings it to 9 tools (≈40 KB) and the turns pass. Besides overflowing small windows, it hands the owner's ChatGPT
connector schemas to a third-party endpoint, and a model that calls one runs it against ChatGPT's cloud. Filed as
task `34wnlmNt2wLO1JxUs1IJB`. Until it lands, an Orbit Codex session on an Ollama row cannot run on a 64K model.

## 6. Cloud: where requests went

### 6.1 Inference

Every model request in every run is in Ollama's access log (`[GIN] … POST "/v1/messages?beta=true"` or
`POST "/v1/responses"` from `127.0.0.1`). No engine was configured with another model endpoint, and none switched to
one when Ollama failed: a down endpoint ends in `ECONNREFUSED` (Claude Code) or endless reconnects to the same
address (Codex); an unknown model ends in an error, not a substitute.

`strace -e trace=connect` per case (`connects.py`) shows each engine's **non-inference** traffic:

| Engine | Loopback | Elsewhere |
| --- | --- | --- |
| Claude Code (Orbit's env, nonessential traffic on) | 1 connection to `127.0.0.1:11434` per process | 4 × `160.79.104.10:443` (`api.anthropic.com`) per process, plus DNS |
| Codex | 1–6 connections to `127.0.0.1:11434` | `172.64.155.209:443` (`chatgpt.com`) and `104.18.32.47` (`ab.chatgpt.com`), 3–9 per process |

That traffic is the engines' own bootstrap, telemetry and account calls, already described in
`claude_region.go` (Claude Code sends a stored Claude login to `api.anthropic.com` at start unless
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`). Orbit sets that variable only when the region check says "blocked".

### 6.2 Offline proof

With nftables dropping every non-loopback packet from the engine's cgroup (self-check: `curl https://api.anthropic.com`
→ rc 6; `curl http://127.0.0.1:11434/api/version` → 200), Claude Code on Orbit's environment completed Read → Edit →
Bash (`sub` fixed, printed `5`) and a resumed second turn (`5`). The rule dropped 102 packets (6,426 bytes) that
Claude Code tried to send elsewhere. Nothing it needed was outside the host.

### 6.3 Ollama's own cloud models

Ollama forwards `*-cloud` model tags to ollama.com. Measured on 0.40.16 without `OLLAMA_NO_CLOUD`:
`POST /v1/messages {"model":"gpt-oss:20b-cloud"}` → `401 Unauthorized` after 409 ms, i.e. it went to ollama.com. With
`OLLAMA_NO_CLOUD=1`: `403 {"error":"ollama cloud is disabled: remote model is unavailable"}` on `/v1/messages` and
`/v1/responses`. A local-looking base URL is therefore not enough: the server flag and a model-id rule are both
required (§8).

## 7. Known limits and failures

1. **Cold start on a memory-starved host.** Loading `qwen3.8:27b` took 405–1,759 s here (spinning-disk model store,
   14 GiB RAM shared with ~20 sessions, mmap disabled by Ollama under pressure). Claude Code abandons a request after
   ~5m50s; Ollama then cancels the half-finished load, and the retry starts over: 6 consecutive `499`s, never loaded.
   A model must be warm before the engine's first request.
2. **Swapped server, starved GPU.** With the model split across both GPUs (no P2P), or with llama-server's host
   buffers swapped out (2.7–3.5 GB), GPU use sat at 3% and a 12–15K-token prefill did not finish in 6 minutes
   (`500`). Not swappable: 688 tok/s prefill, 13 tok/s decode on one GPU.
3. **OOM.** The global OOM killer chose llama-server twice (15:27 and 17:28), and at 18:59 it hit its own 8 GiB cap
   with 8.3 GB of host memory: for this hybrid (DeltaNet) model llama.cpp keeps a host-RAM prompt cache (limit
   8,192 MiB by default) and up to 32 context checkpoints of ~150 MB each, which grow with the conversation.
   `LLAMA_ARG_CACHE_RAM=1024` and `LLAMA_ARG_CTX_CHECKPOINTS=4` bound them; `OOMScoreAdjust=-900` moves the
   remaining risk onto other processes. That trade-off is the owner's on a shared host.
4. **GPU discovery watchdog.** Ollama probes each GPU library by starting llama-server under a fixed 30 s watchdog.
   With the ROCm libraries (2.6 GB) on a spinning disk and the host at load ~120, eight starts in a row missed it and
   came up **CPU only**, silently: the model then loaded into RAM and was OOM-killed. Reading the libraries in
   `ExecStartPre` with `MemoryMin=4G` protecting the unit's page cache fixed it on the first try.
5. **One request at a time.** With `OLLAMA_NUM_PARALLEL=1`, a second client queues; a queued request that waits
   more than ~6 min is cancelled. Two sessions on one Ollama slow each other down past that limit.
6. **Prompt size.** Claude Code's own prompt is ~10–12K tokens; with Orbit's MCP tools a real session sends
   15–18K. A 64K window leaves room for a working conversation but not for long tool outputs; auto-compaction
   triggers at 57,344 − 32,000 = 25,344 tokens of conversation.
7. **`auto` permission mode runs its classifier on the local model.** Every tool call in an `auto` session first
   sends a ~32K-token classifier request to the same Ollama model. When it does not answer in 60 s the call is
   refused (`qwen3.8:27b is temporarily unavailable (timed out), so auto mode cannot determine the safety of Write
   right now`) and the model retries: in the probe session 4 of 8 tool calls were refused this way before passing.
   With one slot the classifier and the conversation evict each other's cache, so every classifier call is a cold
   prefill; the task run lost 9 `Write`s that way. Two slots (`OLLAMA_NUM_PARALLEL=2`, 18.6 GB VRAM at 64K each)
   let each keep its prefix, after the classifier slot's first, cold call.
8. **Cost display.** Orbit priced the local session as if it were Claude (`costUsd 0.17` after one turn); a local row
   should report no cost.
9. **Engine updates on the runner.** The runner's own engine update replaced Codex mid-run and left
   `/usr/local/bin/codex` failing (`Missing optional dependency @openai/codex-linux-x64`); fixed by
   `npm install -g @openai/codex@0.169.0`.
10. **Codex specifics.** No model metadata for local ids (`Model metadata for qwen3.8:27b not found. Defaulting to
    fallback metadata`); `model_context_window` must be passed; it retries a dead endpoint forever.
11. **Error text.** Claude Code's unknown-model text is generic ("may not have access"); an Ollama row should check
    the model with `GET /api/tags` (or `POST /api/show`) before a session starts and say which model is missing.
    When Ollama dies mid-turn the session ends `FAILED` with `API Error: Connection refused … (ECONNREFUSED)`.

## 8. What phase 1 must implement

1. A runner-scoped Ollama provider: a `ModelProvider` row with `runtime = "claude"` and `baseUrl` = Ollama root, pinned
   to the runner that hosts it. No `AgentProvider.OLLAMA`.
2. Refuse model ids ending in `-cloud` or `:cloud`, and require (or verify) `OLLAMA_NO_CLOUD=1` on the server.
3. Health before dispatch: `GET /api/version`, `GET /api/tags` for the model, `GET /api/ps` for its loaded context;
   warm the model out of band (`POST /api/generate {"prompt":"","keep_alive":-1}`) and only then start the engine.
4. Context: require ≥ 65,536 from the server (`/api/ps` `context_length`) and declare it on the row.
5. Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for every session on a local row, not only when the region check
   blocks.
6. At least two Ollama slots per Claude Code session (`OLLAMA_NUM_PARALLEL=2`: the conversation and the `auto`
   classifier each keep a warm cache), and no more sessions than slots allow.
7. Host sizing and server settings: the runner host needs free RAM for llama-server's host caches (bounded with
   `LLAMA_ARG_CACHE_RAM` / `LLAMA_ARG_CTX_CHECKPOINTS`), the model store and Ollama's libraries on local fast disk,
   and a check that `/api/ps` reports a GPU (`size_vram` = `size`) rather than a silent CPU fallback.
8. `auto` mode: either point Claude Code's classifier at a model that answers within its 60 s budget or document that
   local rows run in `acceptEdits`/`default`; do not leave every tool call waiting on a second 32K request.
9. Report zero cost for local rows.
10. Codex stays out until `34wnlmNt2wLO1JxUs1IJB` lands (`features.apps=false`); then it is a second route on
   Responses, never Chat Completions.

## 9. Evidence index

All under the task's uploads `p0/`:

| Path | What |
| --- | --- |
| `route-a.sh`, `route-b.sh`, `interrupt-a.sh`, `offline.sh`, `connects.py` | The harness |
| `out-a/` | Route A on `qwen3.8:27b`: per case `*.jsonl` (stream-json), `*.strace`, `a4-interrupt.log` |
| `out-a-qwen3-coder/` | Route A on `qwen3-coder:30b` (rejected model) |
| `out-a-qwen38-coldloop/`, `out-a-qwen38-split-swap/` | The cold-load loop and the swapped two-GPU failure |
| `out-b0/`, `out-b/` | B0 (`wire_api="chat"`) and Route B with apps off |
| `out-b-apps-overflow/` | Route B as Orbit launches it, plus `captured-request-plugins-false.json` |
| `out-offline/` | Offline proof: `selfcheck.txt`, `nft-before.txt`, `nft-after-a-done.txt`, `summary.txt` |
| `orbit-session-a2/` | Real Orbit session `34wmwzBlVxO7Vk4xWLlDt`: Claude Code transcript, Ollama access log |
| `orbit-task-a/` | Real Orbit task run `34wtKTsxHsPmK3iDuDild`: transcript, Ollama access log |
| `capture/` (on the host, `/mnt/data/ollama/p0/capture`) | Request-capture listener used for §5.2 |
| `ollama-up.sh` | How the Ollama unit was finally started (§1) |
| `notes.md` | Timestamped notes (cloud-tag probe, loads, OOM kills) |
