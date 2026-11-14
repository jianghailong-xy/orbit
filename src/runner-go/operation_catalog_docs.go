package main

// docs/operation-catalog.md is a public, human-readable view of the catalogue. It is rendered from
// the same rows the two surfaces are projected from, so it cannot describe an operation the runner
// does not serve or miss one it does. operation_catalog_test.go fails when the committed file and
// the renderer disagree; the test re-renders it when ORBIT_UPDATE_CATALOG_DOC=1.

import (
	"fmt"
	"sort"
	"strings"
)

func renderOperationCatalogMarkdown() string {
	built := operationCatalog()
	var b strings.Builder
	fmt.Fprintf(&b, "# Orbit operation catalogue v%s\n\n", operationCatalogVersion)
	fmt.Fprintf(&b, "> Generated from `src/runner-go/operation_catalog.go` — do not edit by hand.\n")
	fmt.Fprintf(&b, "> Content hash: `%s`.\n\n", built.Hash)
	b.WriteString("Every operation an Orbit agent can call is declared once in the operation catalogue. ")
	b.WriteString("This table is that catalogue rendered for a person: `orbit capabilities --json` and the MCP ")
	b.WriteString("`tools/list` payload are its two machine surfaces, and the leaf `--help` texts are held to it ")
	b.WriteString("by tests. `MCP` and `CLI` say how each surface reaches the operation — `always`, an ")
	b.WriteString("`orchestration` grant, an engine `permission_prompt` bridge, `session`-only, `headless`-only, ")
	b.WriteString("or a `watch_switch`/`wiki_switch` — and `absent` when that surface deliberately has no door. ")
	b.WriteString("Gates that must hold together are joined with `+` (for example `orchestration+watch_switch`). ")
	b.WriteString("`Idempotency` is `read` (safe to repeat), `caller_key` (retry with the same key), ")
	b.WriteString("`server_key` (a redelivered turn deduplicates) or `none` (re-read before retrying). ")
	b.WriteString("`Plan` is what a session in Plan mode gets: the call `runs`, is `refused` with what to do instead, ")
	b.WriteString("or its `own_gate` decides; the per-engine matrix is docs/permission-matrix.md.\n\n")

	b.WriteString("## Reading it a piece at a time\n\n")
	b.WriteString("`orbit capabilities --json` is the whole catalogue as one process is offered it, which is larger ")
	b.WriteString("than any engine shows a model at once. An agent that wants one operation asks for less: ")
	b.WriteString("`--summary` (one row per command, and the commands not offered here grouped under why), ")
	b.WriteString("`--family NAME` (one family, each command with its absolute argv, approval, success evidence and ")
	b.WriteString("a minimal example) or `--id ID` (one operation in full, both surfaces' examples included). The ")
	b.WriteString("`guide` MCP tool and `orbit guide [TOPIC] --json` arrange the same rows by what a person asks ")
	b.WriteString("for: without a topic they answer the objects and the intent routes, and with one its recipe. ")
	fmt.Fprintf(&b, "Guide %s has these topics (a `?` marks an optional step):\n\n", agentGuideVersion)
	b.WriteString("| Topic | Routes | Steps | Intent |\n| --- | --- | --- | --- |\n")
	for _, topic := range guideTopics {
		var routes, steps []string
		for _, route := range guideRoutes {
			if route.Topic == topic.ID {
				routes = append(routes, route.Route)
			}
		}
		for _, step := range topic.Steps {
			name := "`" + step.Op + "`"
			if step.Optional {
				name += "?"
			}
			steps = append(steps, name)
		}
		if len(routes) == 0 {
			routes = []string{"—"}
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s |\n", topic.ID, strings.Join(routes, ", "),
			strings.Join(steps, " → "), escapeTable(topic.Intent))
	}
	b.WriteString("\n")

	b.WriteString("| Operation | Object | Risk | Writes | Approval | Destructive | Idempotency | Plan | MCP | CLI | Intent |\n")
	b.WriteString("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
	for _, op := range built.Ops {
		availability := op.availability()
		approval := string(op.Approval)
		if op.ApprovalKey != "" {
			approval += " (`" + op.ApprovalKey + "`)"
		}
		cli := availability.CLI
		if op.CLI != nil {
			cli += " — `" + strings.Join(op.CLI.Argv, " ") + "`"
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n",
			op.Tool, op.Object, op.Risk, yesNo(op.Mutates), approval, yesNo(op.Destructive),
			op.Idempotency, op.Plan, availability.MCP, cli, escapeTable(op.Intent))
	}

	b.WriteString("\n## Writes Plan mode runs\n\n")
	b.WriteString("Plan reads, waits and asks the owner, and refuses every other write. These are the writes it runs, ")
	b.WriteString("and the operations whose own gate decides there; a preview (`task_create_batch` with `dryRun`, ")
	b.WriteString("`orbit task create-batch --dry-run`, `orbit task-list propose-dag` without `--apply`) writes nothing ")
	b.WriteString("and runs like a read.\n\n")
	b.WriteString("| Operation | Plan | Why |\n| --- | --- | --- |\n")
	for _, op := range built.Ops {
		if op.PlanReason != "" {
			fmt.Fprintf(&b, "| `%s` | %s | %s |\n", op.Tool, op.Plan, escapeTable(op.PlanReason))
		}
	}

	var mcpOnly, cliOnly []*operation
	for _, op := range built.Ops {
		switch {
		case op.MCP != nil && op.CLI == nil:
			mcpOnly = append(mcpOnly, op)
		case op.MCP == nil && op.CLI != nil:
			cliOnly = append(cliOnly, op)
		}
	}
	sort.Slice(mcpOnly, func(i, j int) bool { return mcpOnly[i].Tool < mcpOnly[j].Tool })
	sort.Slice(cliOnly, func(i, j int) bool { return cliOnly[i].Tool < cliOnly[j].Tool })

	b.WriteString("\n## Deliberately absent surfaces\n\n")
	b.WriteString("An operation missing from one surface is a declared decision, not drift: the catalogue row says why.\n\n")
	b.WriteString("| Operation | Surface without a door | Why |\n| --- | --- | --- |\n")
	for _, op := range mcpOnly {
		fmt.Fprintf(&b, "| `%s` | CLI | %s |\n", op.Tool, escapeTable(op.CLIExempt))
	}
	for _, op := range cliOnly {
		fmt.Fprintf(&b, "| `%s` | MCP | %s |\n", op.Tool, escapeTable(op.MCPExempt))
	}

	b.WriteString("\n## Receipts and retries\n\n")
	b.WriteString("Each operation states what proves it succeeded and how a retry is made safe. Read them from\n")
	b.WriteString("`orbit capabilities --json` (`successEvidence`, `retry`) or from the row above; the rules they\n")
	b.WriteString("follow are docs/orbit-agent-contract.md §5.2 and §6.\n")
	return b.String()
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func escapeTable(value string) string {
	value = strings.ReplaceAll(value, "|", "\\|")
	return strings.ReplaceAll(value, "\n", " ")
}
