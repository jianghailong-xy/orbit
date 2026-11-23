# Agent instructions: units, shapes and engine profiles

Status: proposed, 2026-11-23. Drafted with claude-fable-5-2 from the code as of 1be368a6ee. No eval has been run yet, so every "after" size below is an estimate.

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
- **Versioning.** A manifest lists every unit's id with a hash of its text, plus a composite hash. The lead paragraph keeps its semantic version. Snapshots are generated for each canonical shape and profile, and the manifest hash is recorded in `agent_contract_telemetry`.
- **Contract test.** The test maps each §0 rule to a unit or a mechanism, not to fixed phrases in one text.

## 5. Extensibility

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

## 7. Open decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Disallow the engine's own Agent tool where delegate is served, as todo tools already are? | Owner's call. It removes the biggest steering rule but loses native sub-agents. |
| D2 | Keep `alwaysLoad` for notify (about 330 tokens) and delegate (about 692 tokens), or keep only their lines (about 35 and 60 tokens)? | Keep the lines, and drop `alwaysLoad` if the eval passes without it. |
| D3 | Require `autoRunWhenReady` on creates made from a session? | — |
| D4 | Have `orbit mcp` fill in an idempotency key when one is missing? | — |
| D5 | Keep the 500-byte reply-files paragraph, or cut it to one line plus a correction note on the next turn? | — |
| D6 | Keep one always-on sentence saying a refusal is final on every surface? | Yes |
| D7 | Add eval smoke coverage for Kimi and Cursor? | Without it, their text has to stay cautious. |
| D8 | Does a bare `orbit mcp` outside a session keep the full primer? | Yes |

**Recommended goal.** The instructions are about 1.9k tokens and prompt-cached, so bytes alone are the wrong target. The bigger costs are dilution, rules sent to shapes they don't apply to, Kimi's resend, and always-loaded descriptions. The goal is to hold the eval pass rate, cap the number of rules per shape, and allow no always-on unit without a guarding eval case.
