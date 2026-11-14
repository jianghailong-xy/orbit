package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
)

// Orbit's own Plan gate. A session in Plan mode reads, waits and asks the owner, and changes nothing until the
// plan is approved (docs/orbit-agent-contract.md §4.1, docs/permission-matrix.md). No engine holds Orbit's tools
// to that by itself: Claude Code runs whatever its allow rules cover, the Orbit CLI's writes included, and holds
// back an MCP tool only as far as its annotations say; Codex used to decline every Orbit call in Plan, reads
// included. So Orbit holds every engine to it in the two places each of its own calls goes through: `orbit mcp`
// (callTool, and Claude's permission_prompt for Orbit's tools) and the in-session CLI (runOrbitCLI). Both read the
// operation's Plan policy from the catalogue (operation.Plan) and the session's live permission mode from the
// runner that hosts it, the one process that sees the mode change mid-session: an owner switching it, Claude Code
// entering Plan by itself, or leaving it once a plan is approved.
//
// Like the background-job gate this protects against an agent acting ahead of a person, not against a hostile
// process: a shell that reads the runner's credential can write without asking anybody.

// planGateModeOp is the session socket's operation that answers the live mode (bgJobService.handle).
const planGateModeOp = "mode"

// planGateRefusalFormat is what a call Plan refuses returns, on both surfaces, naming the call as its surface
// spells it.
const planGateRefusalFormat = "Not run: this session is in Plan mode, which reads, waits and asks but changes " +
	"nothing until the plan is approved, and %s writes to Orbit. Nothing was written. Do not retry it, and do not " +
	"make the same write another way: the MCP tool and the orbit CLI refuse it alike. Put it in your plan, and " +
	"make it once the owner has approved the plan or switched this session out of Plan mode."

// planGateUnreadableFormat is what a write returns when the session's mode could not be read: a write is never made
// on a mode nobody could read.
const planGateUnreadableFormat = "Not run: Orbit could not read this session's permission mode (%v), so it did " +
	"not make this write. Nothing was written; try it again."

// sessionPermissionMode reads the permission mode the session this process runs in is in now, from the runner that
// hosts it. known is false where there is no such session to ask about: no ORBIT_SESSION_ID (a person's own
// terminal, or `orbit mcp` started by hand), or no runner-hosted socket to ask (a background job's environment
// carries the session but not the socket, and a runner whose job service did not start offers none). Then no gate
// applies. An error is a socket that is there and did not answer.
func sessionPermissionMode() (mode string, known bool, err error) {
	if strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")) == "" {
		return "", false, nil
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if socket == "" || token == "" {
		return "", false, nil
	}
	raw, err := bgSocketCall(socket, token, planGateModeOp, nil)
	if err != nil {
		return "", true, err
	}
	var answer struct {
		PermissionMode string `json:"permissionMode"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return "", true, err
	}
	if answer.PermissionMode == "" {
		return "", true, errors.New("the runner answered no permission mode")
	}
	return answer.PermissionMode, true, nil
}

// planGateEntry is what the gate needs to know about one operation, which none of the environment the catalogue is
// otherwise projected for can change.
type planGateEntry struct {
	tool string
	plan operationPlan
	mcp  bool
	// The CLI command's words after `orbit`, or nil when it has none.
	argv []string
}

// planGateTable indexes the catalogue's Plan policies by tool, built once: every call this process gates reads it,
// and none of what it holds depends on the environment that makes the catalogue itself uncacheable
// (operationCatalog).
var planGateTable = sync.OnceValue(func() map[string]planGateEntry {
	table := map[string]planGateEntry{}
	for _, op := range operationCatalog().Ops {
		entry := planGateEntry{tool: op.Tool, plan: op.Plan, mcp: op.MCP != nil}
		if op.CLI != nil && len(op.CLI.Argv) > 1 {
			entry.argv = append([]string(nil), op.CLI.Argv[1:]...)
		}
		table[op.Tool] = entry
	}
	return table
})

// planRefusal is the gate for one call: the refusal to return, or "" to run it. call names the call as its
// surface spells it, preview reports a call that writes nothing, and mode reads the session's live mode — only
// for a call Plan would refuse, so a read costs nothing.
func planRefusal(entry planGateEntry, call string, preview bool, mode func() (string, bool, error)) string {
	if entry.plan != planRefused || preview {
		return ""
	}
	current, known, err := mode()
	switch {
	case !known:
		return ""
	case err != nil:
		return fmt.Sprintf(planGateUnreadableFormat, err)
	case current == "plan":
		return fmt.Sprintf(planGateRefusalFormat, call)
	}
	return ""
}

// mcpPlanRefusal gates one MCP tool call: the refusal, or "" to run it. A tool the catalogue does not declare is not
// this gate's: callTool answers it as unknown.
func mcpPlanRefusal(name string, args map[string]interface{}, mode func() (string, bool, error)) string {
	entry, ok := planGateTable()[name]
	if !ok || !entry.mcp {
		return ""
	}
	preview := false
	if arg := catalogPlanPreviewArgs[name]; arg != "" {
		preview = getBool(args, arg)
	}
	return planRefusal(entry, name, preview, mode)
}

// cliPlanRefusal gates one command line of the in-session CLI, args being what follows `orbit`. A help request runs:
// it writes nothing.
func cliPlanRefusal(args []string, mode func() (string, bool, error)) error {
	entry, ok := cliPlanEntry(args)
	if !ok || wantsHelp(args[len(entry.argv):]) {
		return nil
	}
	call := "orbit " + strings.Join(entry.argv, " ")
	if refusal := planRefusal(entry, call, cliPlanPreview(entry.tool, args[len(entry.argv):]), mode); refusal != "" {
		return errors.New(refusal)
	}
	return nil
}

// cliPlanEntry is the catalogue operation a command line runs: the one whose command words are the longest prefix
// of it.
func cliPlanEntry(args []string) (planGateEntry, bool) {
	var best planGateEntry
	found := false
	for _, entry := range planGateTable() {
		if len(entry.argv) == 0 || len(entry.argv) > len(args) || (found && len(entry.argv) <= len(best.argv)) {
			continue
		}
		matches := true
		for i, word := range entry.argv {
			if args[i] != word {
				matches = false
				break
			}
		}
		if matches {
			best, found = entry, true
		}
	}
	return best, found
}

// cliPlanPreview reports a command line that writes nothing: `orbit task create-batch --dry-run` judges a plan, and
// `orbit task-list propose-dag` previews a change unless it is told to --apply it. A flag whose value is not a
// boolean never reads as a preview: the command refuses it anyway, and the gate does not guess.
func cliPlanPreview(tool string, flags []string) bool {
	switch tool {
	case "task_create_batch":
		set, value, valid := cliBoolFlag(flags, "dry-run")
		return set && valid && value
	case "tasklist_propose_dag":
		set, value, valid := cliBoolFlag(flags, "apply")
		return !set || (valid && !value)
	}
	return false
}

// cliBoolFlag reads one boolean flag the way the CLI's flag sets do (`--name`, `-name`, `--name=value`), the last
// one standing, up to a `--`.
func cliBoolFlag(args []string, name string) (set, value, valid bool) {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		flag, inline, hasInline := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if !strings.HasPrefix(arg, "-") || flag != name {
			continue
		}
		set, value, valid = true, true, true
		if hasInline {
			parsed, err := strconv.ParseBool(inline)
			value, valid = parsed, err == nil
		}
	}
	return set, value, valid
}
