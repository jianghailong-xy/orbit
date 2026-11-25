# Agent instructions: units, shapes and engine profiles

Status: built (steps 0-7 of §6), 2026-11-25. §1-§3 are the problem as found on 2026-11-23; §4-§5 now describe the system as it is in `src/runner-go`; §8 says how to extend it and gives the final sizes.

## 1. Problem

The runner sends the same block of text to every coding engine. That text is the primer (`src/runner-go/agent_primer.go`) followed by the paragraphs `orbitCLIInstructions` adds (`src/runner-go/agent_instructions.go:85`).

- **Size.** The longest shape is 7,580 bytes, against a 7,680-byte budget. That budget was raised four times between 11-15 and 11-20 (6,400 → 6,656 → 7,424 → 7,680). The primer's own budget went from 3,200 to 3,456.
- **The duplicate primer.** Claude Code receives the primer twice: once as the MCP `initialize` instructions (`mcp.go:238`) and once again in `--append-system-prompt`.
- **No regression cases.** `agent_eval_scenarios_test.go` has no case for notify, delegate, `task_await`, `file_upload`, `wiki_search` or `task_progress_report`. Each of those paragraphs was justified by a one-off measurement written in a code comment, so none of them can be shown safe to remove.

## 2. Why it grows

1. **Always-on text is the cheapest fix.** It is the one channel every engine reliably shows, and adding to it takes one Go constant and a budget bump. As a result the same rule ends up stated several times:
   - delegate: a paragraph, its always-loaded description, and a guide topic;
   - wait: a paragraph and the `task_await` description;
   - progress: a paragraph and the `task_progress_report` description.
2. **Composition aims at the weakest engine.**
   - There is one text, which carriers then patch with `strings.Replace` (`cursor_acp.go`, `opencode.go`, `antigravity_home.go`).
   - Codex shows only the first 250 characters of the MCP instructions, which is why Claude Code pays for the primer twice.
3. **Session shape is three positional booleans** (`insideRecordedWork, watches, delegates`), so most paragraphs go to every shape.
   - A SubAgent gets the project-proposal paragraph.
   - A SubAgent is told both "Do not commit" (`subagent.go:80`) and the branch-commit note.
   - Sessions with orchestration on get the orchestration-off paragraph.
   - The wiki line hedges with "if your tool list has it" instead of being conditional.
4. **The ratchet has no release valve.** There is no eval case per paragraph and no way to run the eval without one paragraph.
5. **Every rule is paid for globally.** A failure seen on one model is fixed for every engine.
6. **The budget measures the wrong thing.** It counts the bytes of the longest shape. It does not count:
   - Kimi resending the text with every prompt;
   - the duplicate primer;
   - about 1,000 tokens of always-loaded tool descriptions.

## 3. Content kinds and channels

| Kind | The decision | Where it belongs |
|---|---|---|
| A. Disposition | Choosing Orbit over an engine built-in (todo, Agent tool, sleep, chat, `/tmp` files) | Always on, or remove the wrong option |
| B. Selection | Which Orbit object or tool | Tool names, the first sentence of a description, `guide` |
| C. Mechanics | How to call a tool | Schema and description |
| D. Recovery | What a result means and what to do next | The tool result or receipt (`Notes`, `error.retry`) |
| E. Situation | True only for this session or this moment | Text conditional on the session's shape, or a per-turn note (as `context_reset_note.go` does) |
| F. Environment | Facts only the runner knows (CLI path, tool spelling) | Always on, kept short |

Only kinds A and F need to be always on. A tool result cannot fix a call the agent never made, which is why kind A stays. On Claude Code, the pull channels (`guide`, capabilities) are not read unless the agent asks for them.

## 4. Target architecture

### 4.1 Instruction units

A registry sits beside `operationCatalog`, with one row per unit:

| Field | Meaning |
|---|---|
| `id` | e.g. `wait.use-await` |
| `owner` | The feature area and the ops it covers |
| `kind` | A–F |
| `appliesTo` | A predicate on `SessionShape` |
| `channel` | Preferred and fallback channels, stated against engine capabilities rather than engine names |
| `core` | At most 200 bytes, imperative, with tool names written as placeholders the composer renders in each engine's spelling |
| `detail` | Where the longer text lives: a tool description, a receipt note or a guide topic |
| `guardedBy` | The eval case id or ids. Required for any always-on unit. |
| `conflicts` | Units that must not be sent together |

### 4.2 Session shape and engine profile

**`SessionShape`** holds:
- the role: top-level, task run, coordinator, SubAgent, scheduled check-only, or help-ask;
- the switches: watch, browser, orchestration, wiki;
- the set of tools actually served, which comes from the same predicate that filters `tools/list`.

A unit that names a tool the session isn't served is dropped.

**`EngineProfile`** holds measured data for each engine version:
- how much of the MCP instructions the engine shows: whole, head, none or unknown;
- whether tool descriptions are eager or deferred;
- whether `alwaysLoad` is honoured;
- the carrier type: system prompt, per-turn, every prompt, or first prompt;
- whether instructions survive compaction;
- the per-value cap (Codex 900);
- whether the engine has a reset note.

Any value not yet measured takes the conservative choice, which is today's behaviour.

### 4.3 Composer

`compose(shape, profile)` returns four things: the system text, the MCP instructions, the set of tools to load up front, and the per-turn notes.

- Each unit is delivered once per engine. Only units marked as safety units are deliberately sent twice.
- Inside a runner session whose system carrier is confirmed, `initialize` answers with the primer's lead paragraph only.

### 4.4 Where a new fix goes

A fix starts at the top of this list. Taking a lower rung means saying why every rung above it can't work.

1. A mechanism: make the wrong action impossible, or the right one the default.
2. The tool's name or schema.
3. A note in the tool's result.
4. The tool's description. Its first 200 characters say when to use it and which built-in it replaces.
5. A per-turn note on the event.
6. An always-on line conditional on the session's shape.
7. Core always-on text.

### 4.5 Governance

- **Budget.** Each shape has a cap on always-on bytes and a cap on the number of rules. Always-loaded descriptions count against it, weighted by how often the carrier resends them.
- **Admission.** A unit enters rung 6 or 7 only if:
  - it is kind A or F;
  - an eval case fails without it;
  - it names the unit it evicts or compresses.
- **Sunset.** When the supported engine matrix changes, each always-on unit is run against its own case without its text. A unit whose case still passes is demoted.
- **Versioning.** A manifest lists every unit's id with a hash of its text, plus a composite hash (`composeManifest`, `instruction_units.go`). The lead paragraph keeps its semantic version. Snapshots are generated for each canonical shape and profile (`testdata/agent-primer/`), and the composite hash and unit ids are recorded in every `agent_contract_telemetry` summary (`instructionManifestHash`, `instructionUnits`, beside `instructionBytes`; §8.5).
- **Contract test.** The test maps each §0 rule to a unit or a mechanism, not to fixed phrases in one text.

## 5. Extensibility

The table below is the summary; §8 is the procedure for each row, as built.

| Change | How the design absorbs it |
|---|---|
| New engine | Add one profile and one carrier adapter. Values not yet probed stay conservative. |
| New tool or feature | Its guidance goes in its descriptor, its receipts and a guide topic. An always-on line needs admission and an eviction. |
| New session shape | Add a role value and its predicates. No carrier signature changes. |
| Feature switch | Units follow the set of served tools. |
| An engine changes which channels it shows | A weekly carrier probe in the eval asks for one canary token per channel, so a change shows up within a week. |
| A failure on one model | Handled through per-engine profiles and sunset runs, not per-model text. |

## 6. Migration

| # | Step | Expected saving |
|---|---|---|
| 0 | Add eval cases for the unguarded paragraphs, plus a switch to run without any one unit; record the baseline | none |
| 1 | Build the registry, `SessionShape`, `EngineProfile` and composer, with byte-identical output | none |
| 2 | Condition fixes: send each paragraph only to the shapes it applies to; fix the SubAgent commit contradiction | about 0.3–0.5 KB; about 1.8 KB for a SubAgent |
| 3 | Deliver the primer once: lead paragraph only over MCP inside Claude Code sessions; Kimi gets the text on its first prompt and after a reset | about 2.9 KB per Claude Code session |
| 4 | Move recovery advice into receipts, then shorten the cards and receipts paragraphs | about 0.9 KB |
| 5 | Merge sub-agents with delegate and the two CLI paragraphs; move start, project, wait and progress detail into descriptions | about 2.3 KB |
| 6 | Replace rules with mechanisms, per the owner's decisions in §7 | about 0.5 KB, and up to about 1,000 tokens |
| 7 | Turn on the governance rules from §4.5 | stops it growing back |

- Every step that removes or moves text runs its affected cases with that text left out, at ten or more runs per case. Three runs at a two-thirds pass bar cannot detect a rule whose removal moves failure from 0% to 20%.
- Kimi has no eval today. It needs at least a smoke run of E1, E3 and X2 before step 3 changes its carrier.

## 7. Decisions for the owner

The owner answered all eight on 2026-11-24 (D2, D6, D7 and D8 on the recommended defaults, recorded by the coordinator).
Step 6 implemented each answer; "Mechanism" says where, and the measurements are in
`docs/agent-instructions-eval-baseline.md`, "Step 6".

| # | Question | Owner's answer | Mechanism |
|---|---|---|---|
| D1 | Disallow the engine's own Agent tool where delegate is served, as todo tools already are? | Yes: disable the engine's own sub-agent tool in sessions where delegate is served, as the todo tools are. Then remove the always-on rule against the engine's own sub-agents. SubAgent sessions, which don't get delegate, keep the native tool. | `claude_spawn.go` adds `builtinSubAgentTools` (`Agent`, `Task`) to `--disallowedTools` when `shape.serves(delegate)` and the session is not a SubAgent. The handoff unit's clause "never your engine's own sub-agents or Agent tool" is the placeholder `{{own_subagents}}`, left out where the profile says the tool is off (`EngineProfile.OwnSubAgentsOff`, Claude Code). Codex and the other engines have no such switch, so their text keeps the clause. |
| D2 | Keep `alwaysLoad` for notify and delegate, or keep only their lines? | Default: keep the one-line rules, and drop `alwaysLoad` only if their step-0 cases pass without it at 10 or more runs. | See the baseline doc, "Step 6": the outcome is recorded there with the runs. |
| D3 | Require `autoRunWhenReady` on creates made from a session? | Yes: required on `task_create` and every `task_create_batch` item from an agent session (MCP and CLI); a person's create in the web UI is unaffected. A missing value is refused with a `fix_input` error naming the field and both meanings. Remove the lead's "Create is not start, but autoRunWhenReady defaults to true" sentence. | `task_create_autorun.go` (`requireRunnerTaskAutoRunDeclaration`), called by the MCP tools (`mcp.go`) and `orbit task create` / `create-batch` (`task_cli.go`). Tool descriptions, the guide recipes and the examples say it is required. Primer 1.8.0. |
| D4 | Have `orbit mcp` fill in an idempotency key when one is missing? | Yes: when `task_create` or `task_create_batch` arrives without one, `orbit mcp` derives a hash of the session id, the tool and the canonical arguments, valid for a bounded window; a key the caller gives wins. Remove the receipts paragraph's "Key task_create ..." sentence. | `derivedCreateKeys` (`task_create_autorun.go`), applied in `mcpServer.callTool`. **The window is 10 minutes** (`createKeyWindow`): inside it identical arguments get the same key, so a retry answers with the first write; after it the key changes, so a deliberate re-create files anew. Dry runs get none. Only `orbit mcp` derives: the CLI is one process per call and keeps no window, and the receipt's `idempotency.kind` is `caller_key` with the derived key. Primer 1.8.0. |
| D5 | Keep the 500-byte reply-files paragraph, or cut it to one line plus a correction note on the next turn? | Cut it to one sentence, and add a correction note: when a reply links a file that cannot be attached (outside the working directory and uploads directory, or missing), the runner tells the agent at the start of the next turn, naming the path and the directories that work. | `orbitReplyFileInstructions` is one sentence. `replyAttachmentIDs.remember` / `takeCorrection` (`reply_attachments.go`) keep what `attachLocalReplyFiles` could not attach; `runClaudeSessionProcess` leads the next message with `replyFileCorrection`. Claude Code only: Codex rewrites links at emit time and has no per-session memo to carry the note, so its paragraph is one sentence without a correction. |
| D6 | Keep one always-on sentence saying a refusal is final on every surface? | Yes (default). | Unchanged: `primer.cards`. |
| D7 | Add eval smoke coverage for Kimi and Cursor? | Default: no new Cursor coverage in this project; Kimi gets the E1, E3 and X2 smoke run in step 3; Cursor, OpenCode, Antigravity and DeepSeek Harness keep today's conservative carrier. | None in step 6. |
| D8 | Does a bare `orbit mcp` outside a session keep the full primer? | Yes (default). | Unchanged: `unknownEngineProfile`, which also keeps the sub-agent clause. |

**Recommended goal.** The instructions are about 1.9k tokens and prompt-cached, so bytes alone are the wrong target. The bigger costs are dilution, rules sent to shapes they don't apply to, Kimi's resend, and always-loaded descriptions. The goal is to hold the eval pass rate, cap the number of rules per shape, and allow no always-on unit without a guarding eval case.

## 8. As built: how to extend the instructions

All paths are in `src/runner-go`. Every carrier takes its text from `compose(shape, profile)` (`instruction_units.go`); nothing builds Orbit's instructions any other way.

### 8.1 The pieces

- **`instructionUnits`** is the registry: `id`, `owner`, `kind` (A to F; only A disposition and F environment may be always-on), `appliesTo(SessionShape)`, `channels` (`system`, `mcp-initialize`), `core` (text with `{{placeholders}}`), `tools` (a session served none of them is not given the unit), `detail`, `guardedBy` (eval scenario ids), `conflicts`, `skipOnProfile`, `safety`.
- **`SessionShape`**: `Role` (`top-level`, `task-run`, `subagent`, `scheduled-check-only`, `help-ask`, `coordinator`), `InsideRecordedWork`, the switches (`Watches`, `Browser`, `Orchestration`, `Wiki`, `Workflows`, `DriveMounted`), `Tools` (what `tools/list` serves) and `CLI`. `ClaimedSession.sessionShape` builds it. The runner cannot yet tell a coordinator from a top-level session; the server says so in each turn's context.
- **`EngineProfile`**: `MCPInstructions`, `ToolDescriptions`, `AlwaysLoad`, `Carrier` (`system prompt`, `per turn`, `every prompt`, `first prompt`), `SystemCarrier` and `SurvivesCompaction` (each yes, no or unknown), `ValueCapBytes`, `ResetNote`, `OrbitTools`, `OwnSubAgentsOff`, `ToolSearchNotes`. Seven engines have one (`engineProfiles`); `unknownEngineProfile` is for `orbit mcp` outside a session and repeats everything.
- **Placeholders** rendered by `renderInstructionUnit`: `{{cli}}`, `{{orbit_tools}}`, `{{toolsearch:<tool>}}`, `{{own_subagents}}`, `{{drive_root}}`. An unknown one fails `TestEveryUnitRendersOnEveryEngine`.

### 8.2 Add an engine

1. Add an `EngineProfile` and list it in `engineProfiles`. Fill in only what was measured; leave the rest `probeUnknown` / `mcpInstructionsUnknown`, which is the conservative behaviour (the unit is sent on both channels).
2. Add the carrier adapter where the engine is spawned: call `compose(job.sessionShape(cli), yourProfile).System` and put the text where the engine reads it (see `claude`'s `--append-system-prompt`, `codex_appserver.go`, `kimi_acp.go`, `cursor_acp.go`, `opencode.go`, `antigravity_home.go`, `dsh_environment.go`). The adapter does not edit the text; if the engine spells something differently, add a profile field and a placeholder. `Codex`-style value caps go in `ValueCapBytes`.
3. Make `orbit mcp` pick the profile (`engineProfile`, `mcp.go`).
4. Add the engine's shape to the snapshots (`TestEngineInstructionSnapshots`) and run the carrier probe. Set `SystemCarrier: probeYes` only after the eval shows paragraphs sent only on that carrier are acted on; that is what lets `initialize` shrink to the lead paragraph.

### 8.3 Add a tool or feature

1. Put the guidance where it belongs on the ladder in §4.4: the descriptor (its first 200 characters say when to use it and which built-in it replaces), the receipt's recovery note, and a guide topic. Stop there if the eval case passes.
2. An always-on unit is allowed only through admission (§8.6): a registry row of kind A or F, `tools` naming the tool so a session without it is not given the text, `guardedBy` naming existing scenarios in `agent_eval_scenarios_test.go`, a `core` within its paragraph and Codex value caps, and a cap bump in `alwaysOnBudgets` (`primer_once_test.go`) that the change has to defend. Add the unit's guarding scenario first and run it with `--leave-out <unit id>` to show the case fails without the unit.
3. Regenerate the snapshots and bump `agentPrimerVersion` (`agent_primer.go`), because the text changed. If a §0 rule changed, bump the contract version too (§8.7).

### 8.4 Add a session shape

Add a `sessionRole` value, set it in `sessionShape`, and give each unit that should (or should not) reach it an `appliesTo` predicate; use a switch field on `SessionShape` when the difference is a feature, not a role. No carrier signature changes. Add the shape to `instructionSnapshotShapes` and a budget row in `alwaysOnBudgets`; `TestAlwaysOnBudgetPerShape` fails for a shape with none.

### 8.5 Telemetry

`newSessionAgentContractTelemetry` composes the session's shape in Claude Code's spelling and records, in every turn summary: `instructionBytes`, `instructionManifestHash` (first 16 hex digits of the SHA-256 of the `id:hash` lines, one per unit in order, each hash the first 16 digits of the SHA-256 of the unit's rendered text) and `instructionUnits` (the ids sent). Two sessions ran under the same instructions exactly when the hashes match. Covered by `TestAgentContractTelemetryRecordsTheInstructionManifest`. A shape with no safe CLI path has no system text and records neither.

### 8.6 Admission and sunset, as enforced

- **Admission** (`TestEveryAlwaysOnUnitIsKindAOrFAndNamesItsEvalCase`): every registry unit is kind A or F and every `guardedBy` id is a real scenario. Five units without a case were demoted in step 7a. Not machine-checked: that the author names the unit evicted or compressed; the reviewer asks.
- **Caps** (`TestAlwaysOnBudgetPerShape`): each snapshot shape has a byte and rule cap equal to what it reached; raising one is a reviewed change. The project's goal for the longest Claude Code shape is 6,200 bytes, down from 8,315 before step 4 (approved by the owner on 2026-11-25, in place of the earlier 3,500); it is logged, not enforced.
- **Sunset**: when the engine matrix changes, run each unit's guarding scenario with `--leave-out <unit id>` (`docs/agent-instructions-eval-baseline.md`, "How it was run"); a unit whose case still passes at ten or more runs is demoted. D2 (`alwaysLoad` for notify and delegate) was dropped this way.

### 8.7 Final sizes

Always-on bytes and rules (the primer and what follows it, in `alwaysOnBudgets`), primer 1.8.0:

| Shape | Claude Code | Codex |
|---|---|---|
| free session, watch, top-level (longest) | 5,499 B, 17 rules | 5,164 B, 16 |
| free session, no watch, top-level | 5,358 B, 16 | 5,023 B, 15 |
| task run, watch, top-level | 5,091 B, 17 | 4,756 B, 16 |
| task run, no watch, top-level | 4,950 B, 16 | 4,615 B, 15 |
| scheduled check-only | 4,168 B, 14 | 3,749 B, 13 |
| orchestration on, no wiki, browser | 4,716 B, 15 | 4,381 B, 14 |
| SubAgent (watch) | 4,009 B, 13 | 3,590 B, 12 |
| SubAgent (no watch) | 3,868 B, 12 | 3,449 B, 11 |

Before the project the longest shape was 7,580 bytes. Over `initialize`, a Claude Code session gets the lead paragraph only. A change that alters the rules in the contract's §0 bumps `contractVersion` in `contracts/orbit-agent.contract.json`, the doc header and `agentContractVersion`, with a new primer version and snapshots.
