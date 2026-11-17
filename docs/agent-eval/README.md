# Accepted agent-contract eval reports

`baseline.json` is the last black-box report of the agent-contract eval accepted for the supported matrix, and
`baseline.md` its rendering (both written by `scripts/agent-eval.sh`, see
[`../agent-contract-eval.md`](../agent-contract-eval.md)). The weekly workflow and every run given
`--baseline docs/agent-eval/baseline.json` compare themselves with it cell by cell, and a cell that passed here and
fails there fails the release gate.

A report is accepted by committing it here, in the change that also records what it measured in the supported
matrix (`eval.supportedMatrix` in [`contracts/orbit-agent.contract.json`](../../contracts/orbit-agent.contract.json))
and in the contract's §8.3. A report carries no prompt, reply, argument value, id, path or credential, so it can be
committed as it was written.

## The current baseline

Measured 2026-11-16 on commit `1d882a28be` (P2-01) on this repository's runner host, one `scripts/agent-eval.sh live`
job per engine version and model, merged into one report with `scripts/agent-eval.sh merge`. A cell is a scenario on
an engine and a model, so the two Codex versions share their cells; §8.3 of the contract gives each version's own
results:

| Engine | Version | Model | Runs per scenario |
| --- | --- | --- | --- |
| Claude Code | 2.1.325 | `claude-sonnet-5-5` | 3 |
| Claude Code | 2.1.325 | `claude-opus-5-5` | 3 |
| Codex | 0.169.0 | `gpt-6.1-sol` | 3 |
| Codex | 0.167.2 (pinned with `--codex-bin`) | `gpt-6.1-sol` | 1 |

The runs kept their transcripts on the host (`--transcripts`), and the reports were graded again from them with the
graders of the commit that accepted them (`scripts/agent-eval.sh regrade`): a grader fix made after a run (grader
version 5, a link to a plan file read as a claim) re-reads what the engines did instead of running them again. The
suite hash in the report names those graders.

Two cases are not applicable on this host and are listed as skipped in the report:

- `E1-record-task/bypassPermissions` on Claude Code: the runner is root, and a root runner does not offer
  `bypassPermissions` to Claude Code (`permission_modes.go`). A non-root runner, such as the weekly workflow's, runs it.
- `X1-mcp-missing-cli-fallback` on Claude Code: Claude Code 2.1.325 runs no turn without Orbit's MCP server, because
  the session's `--permission-prompt-tool` is Orbit's `permission_prompt`.
