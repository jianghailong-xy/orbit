package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// The four bg_* tools an agent uses instead of Bash(run_in_background). They do
// not run anything themselves — `orbit mcp` is a child of the engine, so a
// process it started would die with the engine, which is the whole problem.
// Each call is forwarded to the runner over the session's socket, and the runner
// spawns and owns the process.

const (
	envBgSocket = "ORBIT_BG_SOCKET"
	envBgToken  = "ORBIT_BG_TOKEN"
	// The job a process IS, as opposed to the two above, which are how the engine's MCP child
	// reaches the service that starts jobs. Only a job's own environment carries this one, and the
	// launcher puts it there from the id it minted itself (background_job.go) — an agent may not
	// CLAIM a job any more than it may claim a session. A gated write reads it back and names it on
	// the confirmation card, which is what keeps that card off the turn-ended reaper: the process
	// polling for the answer outlives the turn (apiserver sessions/abandoned-approvals.ts).
	envBgJobID = "ORBIT_BG_JOB_ID"
)

// bgToolNames is the set callTool routes here, and the set the CLI parity census
// reads as deliberately having no `orbit` command (operation_catalog.go, CLIExempt).
var bgToolNames = map[string]string{
	"bg_run":    "run",
	"bg_output": "output",
	"bg_kill":   "kill",
	"bg_list":   "list",
}

// callBgTool forwards one bg_* call and reports whether it handled the name.
func (s *mcpServer) callBgTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	op, ok := bgToolNames[name]
	if !ok {
		return nil, false
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if socket == "" || token == "" {
		// Say so instead of quietly falling back to Bash(run_in_background): a
		// process the engine owns is exactly what the caller asked not to get, and
		// finding out hours later is the failure this replaces.
		return toolResult(fmt.Sprintf(
			"%s: this session has no runner-hosted background job service, so %s is unavailable."+
				" Do not fall back to Bash(run_in_background) — a job started that way is a child of"+
				" the coding-engine process and is killed when the engine is recycled. Run the command"+
				" in the foreground, or tell the user.", bgTransportUnavailable, name), true), true
	}
	raw, err := bgSocketCall(socket, token, op, args)
	if err != nil {
		return toolResult(name+" failed: "+err.Error(), true), true
	}
	return toolResult(prettyJSON(json.RawMessage(raw)), false), true
}
