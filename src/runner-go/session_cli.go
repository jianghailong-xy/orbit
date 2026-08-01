package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const sessionHelp = `orbit session — orchestrate Orbit sessions

Usage:
  orbit session create (--prompt TEXT | --prompt-file -) [options]
  orbit session list [--status STATUS] [--parent-session-id ID] [--json]
  orbit session search --query TEXT [--limit N] [--json]
  orbit session get SESSION_ID [--json]
  orbit session send SESSION_ID (--message TEXT | --message-file -) [--json]
  orbit session interrupt SESSION_ID [--json]
  orbit session merge SESSION_ID [--target-branch BRANCH] [--json]
  orbit session end SESSION_ID [--json]

Session orchestration is available only inside a live Orbit session whose agent
has enableOrchestration enabled. Run 'orbit session <command> --help' for options.
`

var sessionActionHelp = map[string]string{
	"create": `orbit session create — spawn an agent session

Usage:
  orbit session create (--prompt TEXT | --prompt-file -) [options]

Options:
  --prompt TEXT
  --prompt-file -          Read the prompt from stdin; filesystem paths are rejected
  --agent-id ID            Agent to run the session; defaults to ORBIT_AGENT_ID
  --agent-name NAME        Resolve an agent by name
  --title TITLE
  --model MODEL
  --wait[=BOOL]            Wait until the first turn settles
  --json
`,
	"list": `orbit session list — list sessions

Usage:
  orbit session list [--status PENDING|RUNNING|AWAITING_INPUT|SUCCEEDED|FAILED|CANCELLED|INTERRUPTED] [--parent-session-id ID] [--json]
`,
	"search": `orbit session search — search sessions

Usage:
  orbit session search --query TEXT [--limit N] [--json]
`,
	"get": `orbit session get — get a session's status and latest output

Usage:
  orbit session get SESSION_ID [--json]
`,
	"send": `orbit session send — send a follow-up message to a session

Usage:
  orbit session send SESSION_ID (--message TEXT | --message-file -) [--json]

--message-file accepts only '-' (stdin), so the CLI never opens an arbitrary path.
`,
	"interrupt": `orbit session interrupt — interrupt a session's current turn

Usage:
  orbit session interrupt SESSION_ID [--json]
`,
	"merge": `orbit session merge — merge a session's worktree branch

Usage:
  orbit session merge SESSION_ID [--target-branch BRANCH] [--json]
`,
	"end": `orbit session end — end and park a session

Usage:
  orbit session end SESSION_ID [--json]
`,
}

var sessionCLICapabilities = []cliCapabilitySpec{
	{Tool: "session_create", Argv: []string{"orbit", "session", "create"}, Usage: "orbit session create (--prompt TEXT | --prompt-file -) [options]", Arguments: []string{"--prompt <text> | --prompt-file - (required)", "--agent-id <id> | --agent-name <name>", "--title <text>", "--model <model>", "--wait[=true|false]", "--json"}, Mutates: true},
	{Tool: "session_list", Argv: []string{"orbit", "session", "list"}, Usage: "orbit session list [--status STATUS] [--parent-session-id ID] [--json]", Arguments: []string{"--status <PENDING|RUNNING|AWAITING_INPUT|SUCCEEDED|FAILED|CANCELLED|INTERRUPTED>", "--parent-session-id <id>", "--json"}},
	{Tool: "session_search", Argv: []string{"orbit", "session", "search"}, Usage: "orbit session search --query TEXT [--limit N] [--json]", Arguments: []string{"--query <text> (required)", "--limit <n>", "--json"}},
	{Tool: "session_get", Argv: []string{"orbit", "session", "get"}, Usage: "orbit session get SESSION_ID [--json]", Arguments: []string{"[session-id] (required)", "--json"}},
	{Tool: "session_send", Argv: []string{"orbit", "session", "send"}, Usage: "orbit session send SESSION_ID (--message TEXT | --message-file -) [--json]", Arguments: []string{"[session-id] (required)", "--message <text> | --message-file - (required)", "--json"}, Mutates: true},
	{Tool: "session_interrupt", Argv: []string{"orbit", "session", "interrupt"}, Usage: "orbit session interrupt SESSION_ID [--json]", Arguments: []string{"[session-id] (required)", "--json"}, Mutates: true},
	{Tool: "session_merge", Argv: []string{"orbit", "session", "merge"}, Usage: "orbit session merge SESSION_ID [--target-branch BRANCH] [--json]", Arguments: []string{"[session-id] (required)", "--target-branch <branch>", "--json"}, Mutates: true},
	{Tool: "session_end", Argv: []string{"orbit", "session", "end"}, Usage: "orbit session end SESSION_ID [--json]", Arguments: []string{"[session-id] (required)", "--json"}, Mutates: true},
}

// cmdSessionCLI is the native adapter for the MCP session_* orchestration tools.
// The environment gate controls discovery and fails closed locally; every request
// also carries the calling session so the control plane can authorize it against
// the current runner and Agent.enableOrchestration value.
func cmdSessionCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, sessionHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, sessionHelp)
			return err
		}
		h, ok := sessionActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := sessionActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, sessionHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	callerSessionID, err := requireCLIOrchestrationContext()
	if err != nil {
		return err
	}

	switch action {
	case "create":
		return cliSessionCreate(args[1:], in, out, callerSessionID)
	case "list":
		return cliSessionList(args[1:], out, callerSessionID)
	case "search":
		return cliSessionSearch(args[1:], out, callerSessionID)
	case "get":
		return cliSessionGet(args[1:], out, callerSessionID)
	case "send":
		return cliSessionSend(args[1:], in, out, callerSessionID)
	case "interrupt":
		return cliSessionInterrupt(args[1:], out, callerSessionID)
	case "merge":
		return cliSessionMerge(args[1:], out, callerSessionID)
	case "end":
		return cliSessionEnd(args[1:], out, callerSessionID)
	default:
		panic("unreachable session command")
	}
}

func requireCLIOrchestrationContext() (string, error) {
	if !mcpOrchestrationEnabled() {
		return "", fmt.Errorf(orchestrationOffMsg)
	}
	id := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if id == "" {
		return "", fmt.Errorf("session orchestration requires ORBIT_SESSION_ID context")
	}
	if err := validatePathSegmentID(id); err != nil {
		return "", fmt.Errorf("ORBIT_SESSION_ID %w", err)
	}
	return id, nil
}

func resolveSessionCLIId(leading string, trailing []string) (string, error) {
	if leading != "" && len(trailing) > 0 {
		return "", fmt.Errorf("unexpected arguments: %s", strings.Join(trailing, " "))
	}
	if leading == "" {
		if len(trailing) > 1 {
			return "", fmt.Errorf("expected one session id, got: %s", strings.Join(trailing, " "))
		}
		if len(trailing) == 1 {
			leading = trailing[0]
		}
	}
	if leading == "" {
		return "", fmt.Errorf("session id is required")
	}
	if err := validatePathSegmentID(leading); err != nil {
		return "", fmt.Errorf("session %w", err)
	}
	return leading, nil
}

func validateSessionCLIStatus(status string) error {
	if status == "" {
		return nil
	}
	switch status {
	case "PENDING", "RUNNING", "AWAITING_INPUT", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED":
		return nil
	default:
		return fmt.Errorf("status must be one of PENDING, RUNNING, AWAITING_INPUT, SUCCEEDED, FAILED, CANCELLED, INTERRUPTED")
	}
}

func cliSessionCreate(args []string, in io.Reader, out io.Writer, callerSessionID string) error {
	fs := newCLIFlagSet("orbit session create")
	prompt := fs.String("prompt", "", "session prompt")
	promptFile := fs.String("prompt-file", "", "read prompt from stdin (-)")
	agentID := fs.String("agent-id", "", "target agent id")
	agentName := fs.String("agent-name", "", "target agent name")
	title := fs.String("title", "", "session title")
	model := fs.String("model", "", "session model")
	wait := fs.Bool("wait", false, "wait until the first turn settles")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	promptText, promptSet, err := readCLIText(in, *prompt, flagWasSet(fs, "prompt"), *promptFile, flagWasSet(fs, "prompt-file"), "prompt")
	if err != nil {
		return err
	}
	if !promptSet || promptText == "" {
		return fmt.Errorf("--prompt or --prompt-file - is required")
	}
	if flagWasSet(fs, "agent-id") && flagWasSet(fs, "agent-name") {
		return fmt.Errorf("--agent-id and --agent-name cannot be used together")
	}
	body := map[string]interface{}{"prompt": promptText}
	if flagWasSet(fs, "agent-id") {
		if strings.TrimSpace(*agentID) == "" {
			return fmt.Errorf("--agent-id cannot be empty")
		}
		body["agentId"] = *agentID
	} else if flagWasSet(fs, "agent-name") {
		if strings.TrimSpace(*agentName) == "" {
			return fmt.Errorf("--agent-name cannot be empty")
		}
		body["agentName"] = *agentName
	} else if currentAgentID := strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID")); currentAgentID != "" {
		body["agentId"] = currentAgentID
	}
	if flagWasSet(fs, "title") {
		if strings.TrimSpace(*title) == "" {
			return fmt.Errorf("--title cannot be empty")
		}
		body["title"] = *title
	}
	if flagWasSet(fs, "model") {
		if strings.TrimSpace(*model) == "" {
			return fmt.Errorf("--model cannot be empty")
		}
		body["model"] = *model
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.createSession(callerSessionID, body)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	if *wait {
		raw, err = waitForSessionRaw(t, callerSessionID, raw)
		if err != nil {
			return fmt.Errorf("wait for session: %w", err)
		}
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionList(args []string, out io.Writer, callerSessionID string) error {
	fs := newCLIFlagSet("orbit session list")
	status := fs.String("status", "", "session status")
	parentSessionID := fs.String("parent-session-id", "", "parent session id")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if err := validateSessionCLIStatus(*status); err != nil {
		return err
	}
	if flagWasSet(fs, "status") && *status == "" {
		return fmt.Errorf("--status cannot be empty")
	}
	if flagWasSet(fs, "parent-session-id") {
		if err := validatePathSegmentID(*parentSessionID); err != nil {
			return fmt.Errorf("parent session %w", err)
		}
	}
	queryArgs := map[string]interface{}{}
	if *status != "" {
		queryArgs["status"] = *status
	}
	if *parentSessionID != "" {
		queryArgs["parentSessionId"] = *parentSessionID
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listSessions(callerSessionID, sessionListQuery(queryArgs))
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionSearch(args []string, out io.Writer, callerSessionID string) error {
	fs := newCLIFlagSet("orbit session search")
	query := fs.String("query", "", "search query")
	limit := fs.Int("limit", 0, "maximum hits")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if *query == "" {
		return fmt.Errorf("--query is required")
	}
	if flagWasSet(fs, "limit") && *limit <= 0 {
		return fmt.Errorf("--limit must be greater than zero")
	}
	queryArgs := map[string]interface{}{"query": *query}
	if *limit > 0 {
		queryArgs["limit"] = *limit
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.searchSessions(callerSessionID, sessionSearchQuery(queryArgs))
	if err != nil {
		return fmt.Errorf("search sessions: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionGet(args []string, out io.Writer, callerSessionID string) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit session get")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveSessionCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getSession(callerSessionID, id)
	if err != nil {
		return fmt.Errorf("get session: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionSend(args []string, in io.Reader, out io.Writer, callerSessionID string) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit session send")
	message := fs.String("message", "", "follow-up message")
	messageFile := fs.String("message-file", "", "read message from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveSessionCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	messageText, messageSet, err := readCLIText(in, *message, flagWasSet(fs, "message"), *messageFile, flagWasSet(fs, "message-file"), "message")
	if err != nil {
		return err
	}
	if !messageSet || messageText == "" {
		return fmt.Errorf("--message or --message-file - is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.sendSessionMessage(callerSessionID, id, map[string]interface{}{"message": messageText})
	if err != nil {
		return fmt.Errorf("send session message: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionInterrupt(args []string, out io.Writer, callerSessionID string) error {
	id, jsonOut, err := parseSessionTargetArgs("orbit session interrupt", args)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.interruptSession(callerSessionID, id)
	if err != nil {
		return fmt.Errorf("interrupt session: %w", err)
	}
	return writeCLIRawJSON(out, raw, jsonOut)
}

func cliSessionMerge(args []string, out io.Writer, callerSessionID string) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit session merge")
	targetBranch := fs.String("target-branch", "", "merge target branch")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveSessionCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	body := map[string]interface{}{}
	if flagWasSet(fs, "target-branch") {
		if strings.TrimSpace(*targetBranch) == "" {
			return fmt.Errorf("--target-branch cannot be empty")
		}
		body["targetBranch"] = *targetBranch
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.mergeSession(callerSessionID, id, body)
	if err != nil {
		return fmt.Errorf("merge session: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionEnd(args []string, out io.Writer, callerSessionID string) error {
	id, jsonOut, err := parseSessionTargetArgs("orbit session end", args)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.endSession(callerSessionID, id)
	if err != nil {
		return fmt.Errorf("end session: %w", err)
	}
	return writeCLIRawJSON(out, raw, jsonOut)
}

func parseSessionTargetArgs(name string, args []string) (string, bool, error) {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet(name)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return "", false, err
	}
	id, err := resolveSessionCLIId(id, fs.Args())
	if err != nil {
		return "", false, err
	}
	return id, *jsonOut, nil
}

// waitForSessionRaw mirrors MCP session_create(wait): poll until the first turn
// settles, then return the full sanitized orchestration detail.
func waitForSessionRaw(t *Transport, callerSessionID string, created json.RawMessage) (json.RawMessage, error) {
	var handle struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(created, &handle) != nil || handle.ID == "" {
		return created, nil
	}
	for i := 0; i < maxSessionWaitPolls; i++ {
		time.Sleep(sessionWaitInterval)
		raw, err := t.getSession(callerSessionID, handle.ID)
		if err != nil {
			return nil, fmt.Errorf("get session failed: %w", err)
		}
		var state struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(raw, &state) == nil && sessionSettled(state.Status) {
			return raw, nil
		}
	}
	raw, err := t.getSession(callerSessionID, handle.ID)
	if err != nil {
		return nil, fmt.Errorf("timed out; get session failed: %w", err)
	}
	return raw, nil
}
