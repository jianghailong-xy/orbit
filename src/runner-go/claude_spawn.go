package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// How Orbit drives the `claude` CLI: one process per session, spoken to in stream-json
// over a stdin that stays open (transportStreamJSON in providerRuntimes). Building the argv
// and starting the process live here rather than inside the session loop so both halves of
// that contract — what we ask the CLI to be, and the pipes we get back — can be exercised
// against the fake CLI without a session, a lease or a Transport.

// claudeCommandArgs builds the argv for one spawn. The user's prompt is deliberately NOT
// among these: this transport takes every turn as a `user` frame on stdin, so argv describes
// the process, never the conversation. Writes the merged MCP config into scratchDir and
// creates the uploads dir, since both are named by the flags returned.
//
// firstSpawn opens a new conversation (--session-id); a re-spawn continues the existing one
// (--resume), whose local transcript file the caller must have ensured already.
func claudeCommandArgs(job *ClaimedSession, scratchDir string, firstSpawn bool) []string {
	a := job.Agent
	// --max-turns / --max-budget-usd are process-wide (Phase 0), so they are
	// intentionally NOT passed for a long-lived interactive session.
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--replay-user-messages",
		"--verbose",
		"--model", a.Model,
		"--permission-mode", a.PermissionMode,
	}
	if a.Effort != "" {
		args = append(args, "--effort", a.Effort)
	}
	// Apply the agent's configured prompts (claim payload carries both; previously
	// dropped here). --system-prompt replaces the default, --append-system-prompt adds.
	// The Orbit CLI discovery instructions are platform instructions and therefore
	// always join the append prompt rather than replacing the provider's defaults.
	orbitExe := orbitCLIExecutable()
	args = appendClaudeAgentInstructionArgs(
		args,
		a,
		orbitExe,
		job.AllowOrchestration,
	)
	// Orbit ships its own task tools via the `orbit` MCP server (mcp__orbit__task_*).
	// Claude's built-in Task* tools collide by intent: an agent told to "create tasks"
	// reaches for them, but those entries are session-local todos that never reach
	// Orbit's DB — so the tasks never appear in the UI. Always disable the built-in
	// family so task work is forced through the orbit MCP server.
	if disallowed := withBuiltinTaskToolsDisallowed(a.DisallowedTools); len(disallowed) > 0 {
		args = append(args, "--disallowedTools", strings.Join(disallowed, ","))
	}
	// Always pass an --mcp-config: merge the agent's configured servers with the
	// built-in `orbit` server (this same binary in `mcp` mode), so every session can
	// manage Tasks. os.Executable() is resolved per-spawn, so it survives self-update.
	// The orbit entry carries an explicit timeout because permission_prompt blocks on a
	// human, which claude otherwise aborts after its 30-minute idle default (see
	// mcpToolTimeoutMs). Scoping it to this server leaves the agent's own MCP servers on
	// claude's normal timeouts, where an unresponsive server SHOULD self-heal.
	servers := map[string]interface{}{}
	for k, v := range a.McpConfig {
		servers[k] = v
	}
	if orbitExe != "" {
		servers["orbit"] = map[string]interface{}{
			"command": orbitExe,
			"args":    []string{"mcp"},
			"timeout": mcpToolTimeoutMs,
		}
	}
	if len(servers) > 0 {
		mcpPath := filepath.Join(scratchDir, "mcp.json")
		b, _ := json.Marshal(map[string]interface{}{"mcpServers": servers})
		_ = os.WriteFile(mcpPath, b, 0o644)
		args = append(args, "--mcp-config", mcpPath)
		// Route tool-permission prompts (incl. plan-mode ExitPlanMode) to the orbit MCP
		// server's permission_prompt tool, which blocks on a human allow/deny in the UI.
		// The orbit server is always injected above, so this target always exists.
		args = append(args, "--permission-prompt-tool", "mcp__orbit__permission_prompt")
	}
	if firstSpawn {
		args = append(args, "--session-id", job.SessionUUID)
	} else {
		// claude keeps the conversation in a local file keyed by cwd + session id, which this
		// machine may simply not have: the session's first spawn on a different runner, a wiped
		// ~/.claude, a moved worktree. The caller rebuilds that file from Orbit's own events
		// (ensureClaudeTranscript) before we get here, so --resume has something to resume.
		args = append(args, "--resume", job.SessionUUID)
	}
	// Uploaded attachments land in the session's uploads dir, which is OUTSIDE execDir so they
	// stay out of git (see writeUpload). Add it as an explicit working dir so claude can read
	// them without a per-read permission prompt; created up front so the flag points at an
	// existing dir even before the first upload arrives.
	upDir := uploadsDir(job.SessionID)
	if err := os.MkdirAll(upDir, 0o755); err == nil {
		args = append(args, "--add-dir", upDir)
	}
	return args
}

// claudeSpawn is a started `claude` process and the pipes that drive it. stdin stays open
// for the life of the session: it is how every user turn, interrupt and permission answer
// reaches the CLI, so a spawn that cannot hand one back is a failed spawn.
type claudeSpawn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
}

// spawnClaude starts the CLI in execDir with the session's environment. `claude` is
// resolved through PATH per spawn (never an absolute path captured earlier), which is
// also what lets tests put a fake CLI in front of it.
func spawnClaude(ctx context.Context, job *ClaimedSession, execDir string, args []string) (*claudeSpawn, error) {
	cmd := exec.CommandContext(ctx, "claude", args...)
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	// Start from the runner's own env, then layer the agent's custom env vars on top.
	cmd.Env = envWithAgent(job.Agent.Env)
	// Inject session context so the built-in `orbit mcp` server (a child of claude)
	// knows where it is. The runner token is NOT passed here — `orbit mcp` reads it
	// from config.json so it never lands in the claude process environment.
	// Appended last so a custom env var can't shadow the session context.
	//
	// Spelled base62, like every id the agent can see: these three are what `orbit mcp` and the
	// `orbit` CLI default to and echo back in help text, so a UUID here is a UUID in front of the
	// model. The control plane takes either spelling, so an older runner sending the raw form
	// keeps working — the flip is cosmetic on the wire and load-bearing only in what it shows.
	cmd.Env = append(cmd.Env,
		"ORBIT_SESSION_ID="+publicID(job.SessionID),
		"ORBIT_AGENT_ID="+publicID(job.AgentID), // empty => orbit mcp falls back to USER attribution
		"ORBIT_TASK_ID="+publicID(job.TaskID),   // empty => no "current task"
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(job.AllowOrchestration),
		"ORBIT_SPAWN_DEPTH="+strconv.Itoa(job.SpawnDepth),
	)
	sp := &claudeSpawn{cmd: cmd}
	var err error
	if sp.stdin, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	if sp.stdout, err = cmd.StdoutPipe(); err != nil {
		return nil, err
	}
	if sp.stderr, err = cmd.StderrPipe(); err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return sp, nil
}
