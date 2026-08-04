package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
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
  orbit session complete SESSION_ID [--json]

Session orchestration is available inside a live Orbit session whose agent has
enableOrchestration enabled. Outside any session — a launchd/cron process with no
ORBIT_SESSION_ID — the runner credential alone allows get, list and send, scoped to
the sessions this runner hosts; set ORBIT_SERVICE_TOKEN to a credential from
'orbit token mint' to get exactly its scopes instead, including create.
Run 'orbit session <command> --help' for options.
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

Outside a session this needs ORBIT_SERVICE_TOKEN to carry the session:create scope; the
session starts the agent that token is pinned to, and --agent-id may only name that agent.
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

Reports status, numTurns and lastTurnAt, so a headless poller can tell whether a
long-lived session has finished the turn it was given.
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
	"complete": `orbit session complete — move a session to Completed

Usage:
  orbit session complete SESSION_ID [--json]
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
	{Tool: "session_complete", Argv: []string{"orbit", "session", "complete"}, Usage: "orbit session complete SESSION_ID [--json]", Arguments: []string{"[session-id] (required)", "--json"}, Mutates: true},
}

// headlessSessionCLICapabilities is what `orbit capabilities` advertises outside a session: the
// commands this process's credential actually reaches, re-described with their narrower scope.
func headlessSessionCLICapabilities(allowed map[string]bool) []cliCapabilitySpec {
	specs := make([]cliCapabilitySpec, 0, len(allowed))
	for _, spec := range sessionCLICapabilities {
		action := strings.TrimPrefix(spec.Tool, "session_")
		if !allowed[action] {
			continue
		}
		spec.Description = headlessActionDescription[action]
		specs = append(specs, spec)
	}
	return specs
}

// cmdSessionCLI is the native adapter for the MCP session_* orchestration tools.
// For an agent the environment gate controls discovery and fails closed locally; every
// request also carries the calling session, and Transport reads or refreshes its signed
// credential lazily so the control plane can authorize the exact runtime against the current
// Agent.enableOrchestration value. A caller with no session at all sends no session context,
// which is what asks the control plane for the narrower headless scope.
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
	ctx, err := requireCLIOrchestrationContext(action)
	if err != nil {
		return err
	}

	switch action {
	case "create":
		return cliSessionCreate(args[1:], in, out, ctx)
	case "list":
		return cliSessionList(args[1:], out, ctx)
	case "search":
		return cliSessionSearch(args[1:], out, ctx)
	case "get":
		return cliSessionGet(args[1:], out, ctx)
	case "send":
		return cliSessionSend(args[1:], in, out, ctx)
	case "interrupt":
		return cliSessionInterrupt(args[1:], out, ctx)
	case "merge":
		return cliSessionMerge(args[1:], out, ctx)
	case "end":
		return cliSessionEnd(args[1:], out, ctx)
	case "complete":
		return cliSessionComplete(args[1:], out, ctx)
	default:
		panic("unreachable session command")
	}
}

type cliOrchestrationContext struct {
	sessionID string
	token     string
	// A minted service credential from the environment, used INSTEAD of the runner credential
	// so the control plane authorizes exactly the scopes someone granted on purpose.
	serviceToken string
}

// sessionActionScope maps a session subcommand to the service-token scope that authorizes it.
// The lifecycle verbs are absent because no credential can grant them outside a session.
var sessionActionScope = map[string]string{
	"list":   "session:list",
	"get":    "session:get",
	"send":   "session:send",
	"create": "session:create",
}

// headlessActionDescription is what `orbit capabilities` advertises for each action outside a
// session, so the gate below and the advertisement cannot drift apart.
var headlessActionDescription = map[string]string{
	"list":   "List the sessions this runner hosts. Sessions on other runners are not listed; a token pinned to an agent sees only that agent's.",
	"get":    "Get one session's status, numTurns, lastTurnAt and latest output — enough for a headless poller to tell whether a long-lived session finished its turn. Limited to sessions this runner hosts.",
	"send":   "Queue a follow-up message for a session this runner hosts, as the runner owner. It neither spawns nor ends a session.",
	"create": "Start a session for the agent this service token is pinned to, on this runner. Requires a minted token with the session:create scope; the runner credential alone cannot spawn.",
}

// runnerCredentialActions are what the machine's own credential allows a headless caller: observe
// and message the sessions this runner already hosts. Creation is deliberately excluded — starting
// new work must come from a credential someone minted on purpose and can revoke on its own.
var runnerCredentialActions = []string{"get", "list", "send"}

// headlessAllowedActions resolves what this process may do outside a session. Without a service
// token that is the runner-credential subset; with one it is exactly the scopes it carries.
func headlessAllowedActions(service *serviceTokenClaims) map[string]bool {
	allowed := map[string]bool{}
	if service == nil {
		for _, action := range runnerCredentialActions {
			allowed[action] = true
		}
		return allowed
	}
	for action, scope := range sessionActionScope {
		if contains(service.Scopes, scope) {
			allowed[action] = true
		}
	}
	return allowed
}

func headlessActionList(allowed map[string]bool) string {
	actions := make([]string, 0, len(allowed))
	for action := range allowed {
		actions = append(actions, action)
	}
	sort.Strings(actions)
	if len(actions) == 0 {
		return "(none)"
	}
	return strings.Join(actions, ", ")
}

// requireCLIOrchestrationContext resolves how this process is allowed to reach the session API.
//
//   - ORBIT_SERVICE_TOKEN set: a headless process running on a credential someone minted for it.
//     The token is the whole authorization; the control plane confines it to its scopes, its
//     runner and its agent pin.
//   - otherwise, ORBIT_SESSION_ID set: an agent, unchanged — its agent's orchestration opt-in
//     plus the signed session credential Transport attaches.
//   - neither: headless on the runner credential, which reaches only this runner's own sessions
//     and cannot spawn.
func requireCLIOrchestrationContext(action string) (cliOrchestrationContext, error) {
	if service := currentServiceToken(); service != "" {
		claims := decodeServiceTokenClaims(service)
		// Unreadable claims (a truncated paste, a token from a newer CLI) are not judged here:
		// let the control plane reject it, so its error is the one the operator sees.
		if claims != nil && !headlessAllowedActions(claims)[action] {
			scope, grantable := sessionActionScope[action]
			if !grantable {
				// A lifecycle verb: no scope names it, so minting a wider token would not help.
				return cliOrchestrationContext{}, fmt.Errorf(
					"%s runs only inside a live Orbit session — no service token can grant it; this token allows: %s",
					action, headlessActionList(headlessAllowedActions(claims)))
			}
			return cliOrchestrationContext{}, fmt.Errorf(
				"%s needs the %s scope; this service token allows only: %s",
				action, scope, headlessActionList(headlessAllowedActions(claims)))
		}
		return cliOrchestrationContext{serviceToken: service}, nil
	}
	id := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if id == "" {
		allowed := headlessAllowedActions(nil)
		if allowed[action] {
			return cliOrchestrationContext{}, nil
		}
		return cliOrchestrationContext{}, fmt.Errorf(
			"session orchestration requires ORBIT_SESSION_ID context; without a session the runner credential allows only: %s (mint a scoped credential with `orbit token mint` for the rest)",
			headlessActionList(allowed))
	}
	if !mcpOrchestrationEnabled() {
		return cliOrchestrationContext{}, fmt.Errorf(orchestrationOffMsg)
	}
	if err := validatePathSegmentID(id); err != nil {
		return cliOrchestrationContext{}, fmt.Errorf("ORBIT_SESSION_ID %w", err)
	}
	token := strings.TrimSpace(os.Getenv(envOrchestrationToken))
	return cliOrchestrationContext{sessionID: id, token: token}, nil
}

// cliSessionTransport authenticates session calls with the service credential when the process
// was given one, and with the machine credential otherwise.
func cliSessionTransport(ctx cliOrchestrationContext) (*Transport, error) {
	t, err := cliTransport()
	if err != nil {
		return nil, err
	}
	if ctx.serviceToken != "" {
		return NewTransport(t.baseURL, ctx.serviceToken), nil
	}
	return t, nil
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

func cliSessionCreate(args []string, in io.Reader, out io.Writer, ctx cliOrchestrationContext) error {
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
	// --wait polls the new session, so refuse before spawning rather than after: a token that
	// may create but not read would otherwise leave a session running with no way to see it.
	if *wait && ctx.serviceToken != "" {
		if claims := decodeServiceTokenClaims(ctx.serviceToken); claims != nil && !contains(claims.Scopes, "session:get") {
			return fmt.Errorf("--wait polls the new session and needs the session:get scope; this token allows only: %s",
				headlessActionList(headlessAllowedActions(claims)))
		}
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
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.createSession(ctx.sessionID, ctx.token, body)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	if *wait {
		raw, err = waitForSessionRaw(t, ctx, raw)
		if err != nil {
			return fmt.Errorf("wait for session: %w", err)
		}
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionList(args []string, out io.Writer, ctx cliOrchestrationContext) error {
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
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.listSessions(ctx.sessionID, ctx.token, sessionListQuery(queryArgs))
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionSearch(args []string, out io.Writer, ctx cliOrchestrationContext) error {
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
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.searchSessions(ctx.sessionID, ctx.token, sessionSearchQuery(queryArgs))
	if err != nil {
		return fmt.Errorf("search sessions: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionGet(args []string, out io.Writer, ctx cliOrchestrationContext) error {
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
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.getSession(ctx.sessionID, ctx.token, id)
	if err != nil {
		return fmt.Errorf("get session: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionSend(args []string, in io.Reader, out io.Writer, ctx cliOrchestrationContext) error {
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
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.sendSessionMessage(ctx.sessionID, ctx.token, id, map[string]interface{}{"message": messageText})
	if err != nil {
		return fmt.Errorf("send session message: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionInterrupt(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	id, jsonOut, err := parseSessionTargetArgs("orbit session interrupt", args)
	if err != nil {
		return err
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.interruptSession(ctx.sessionID, ctx.token, id)
	if err != nil {
		return fmt.Errorf("interrupt session: %w", err)
	}
	return writeCLIRawJSON(out, raw, jsonOut)
}

func cliSessionMerge(args []string, out io.Writer, ctx cliOrchestrationContext) error {
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
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.mergeSession(ctx.sessionID, ctx.token, id, body)
	if err != nil {
		return fmt.Errorf("merge session: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliSessionEnd(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	id, jsonOut, err := parseSessionTargetArgs("orbit session end", args)
	if err != nil {
		return err
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.endSession(ctx.sessionID, ctx.token, id)
	if err != nil {
		return fmt.Errorf("end session: %w", err)
	}
	return writeCLIRawJSON(out, raw, jsonOut)
}

func cliSessionComplete(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	id, jsonOut, err := parseSessionTargetArgs("orbit session complete", args)
	if err != nil {
		return err
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.completeSession(ctx.sessionID, ctx.token, id)
	if err != nil {
		return fmt.Errorf("complete session: %w", err)
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
func waitForSessionRaw(t *Transport, ctx cliOrchestrationContext, created json.RawMessage) (json.RawMessage, error) {
	var handle struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(created, &handle) != nil || handle.ID == "" {
		return created, nil
	}
	for i := 0; i < maxSessionWaitPolls; i++ {
		time.Sleep(sessionWaitInterval)
		raw, err := t.getSession(ctx.sessionID, ctx.token, handle.ID)
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
	raw, err := t.getSession(ctx.sessionID, ctx.token, handle.ID)
	if err != nil {
		return nil, fmt.Errorf("timed out; get session failed: %w", err)
	}
	return raw, nil
}
