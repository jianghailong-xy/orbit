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
)

// bgToolNames is the set callTool routes here, and the set the CLI parity census
// reads as deliberately having no `orbit` command (see cliParityExemptTools).
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

// bgToolDescriptors is the agent-facing contract for the four tools. It takes
// toolDescriptors' own schema helper so both surfaces are built the same way.
func bgToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	jobIDProp := map[string]interface{}{
		"type":        "string",
		"description": "The jobId bg_run returned.",
	}
	return []map[string]interface{}{
		{
			"name": "bg_run",
			"description": "Run a command in the background, hosted by the Orbit runner rather than by this" +
				" coding-engine process. Use this instead of Bash with run_in_background: a shell started that" +
				" way is a child of the engine, so recycling the engine (idle TTL, memory pressure) kills it" +
				" mid-build. A job started here ends only when it exits, when the session ends, or when you" +
				" kill it. It also registers as a writer of the checkout, so a merge or commit is refused" +
				" while it runs instead of rewriting files underneath it. Read its output with bg_output.",
			"inputSchema": obj(map[string]interface{}{
				"command": map[string]interface{}{
					"type":        "string",
					"description": "The shell command, exactly as you would type it. Pipes and redirection are fine — this is one string, not an argv, so no extra quoting is needed.",
				},
				"kind": map[string]interface{}{
					"type": "string",
					"enum": []string{bgKindService, bgKindJob},
					"description": "What this process is FOR, which decides what happens to it when the checkout has to be" +
						" drained. \"service\" is valuable while it runs and cheap to restart (dev server, watcher): it is" +
						" killed at once. \"job\" is valuable when it finishes and expensive to restart (build, test suite," +
						" migration): it is waited for. Nothing in a command line tells these apart, so say which.",
				},
				"cwd": map[string]interface{}{
					"type":        "string",
					"description": "Working directory; defaults to the session's checkout. Must be inside it (or the session's uploads dir).",
				},
				"description": map[string]interface{}{
					"type":        "string",
					"description": "Short human label. A merge refused because this job is running names it by this.",
				},
				"env": map[string]interface{}{
					"type":        "object",
					"description": "Extra environment variables, layered over the agent's own.",
				},
			}, "command", "kind"),
		},
		{
			"name": "bg_output",
			"description": "Read a runner-hosted job's output. Returns its status and, once it has ended, the exact exit" +
				" code the runner's own wait() reported. Pass the previous call's nextOffset as sinceOffset to read only" +
				" what is new. The output file belongs to the runner, so this keeps working across an engine restart.",
			"inputSchema": obj(map[string]interface{}{
				"jobId": jobIDProp,
				"tail": map[string]interface{}{
					"type":        "number",
					"description": "Read at most this many bytes from the end (default 16384). Mutually exclusive with sinceOffset.",
				},
				"sinceOffset": map[string]interface{}{
					"type":        "number",
					"description": "Read from this byte offset — the nextOffset of your previous read. Mutually exclusive with tail.",
				},
			}, "jobId"),
		},
		{
			"name": "bg_kill",
			"description": "Stop a runner-hosted job. A job that already ended on its own is reported as it actually" +
				" ended, with its real exit code, rather than as killed.",
			"inputSchema": obj(map[string]interface{}{"jobId": jobIDProp}, "jobId"),
		},
		{
			"name": "bg_list",
			"description": "List this session's runner-hosted background jobs. This is how you find work you left running" +
				" before an engine restart or a compaction — the ids stay valid for the life of the session.",
			"inputSchema": obj(map[string]interface{}{
				"includeFinished": map[string]interface{}{
					"type":        "boolean",
					"description": "Also list jobs that have already ended (default false).",
				},
			}),
		},
	}
}
