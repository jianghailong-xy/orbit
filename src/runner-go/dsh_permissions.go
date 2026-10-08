package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// dshPermissionPolicy is what an Orbit permission mode means on DeepSeek Harness 0.2.0-rc.2,
// as measured by the P4 real-CLI scenarios (docs/evidence/deepseek-harness/p4/):
//
//   - read-only: native writes, including a command's writes, are denied by the file sandbox. The
//     tool may retry once with sandbox_permissions + justification, which is the only thing that
//     raises session/request_permission.
//   - workspace-write: writes inside the workspace and the temp directories run without asking;
//     anything wider is denied unless such an escalation is approved.
//   - MCP tools never raise a permission request, whatever their annotations say, and the file
//     sandbox does not confine the network; Orbit's tool gate (dshToolGatePlugin) asks before a
//     third-party MCP tool and before a command that acts on another system, in every mode.
//   - A subagent's escalation never reaches ACP and its tool calls are not projected, so the
//     Orbit overlay removes the subagent tools (dshAgentOverlay).
//
// Plan, Accept Edits and Bypass have no enforceable equivalent and are refused, here and by
// the server (P0 contract §5).
type dshPermissionPolicy struct {
	FileMode string // DSH_PERMISSION_MODE, fixed when the process starts
	// Ask sends an escalation to an Orbit approval card; otherwise it is rejected unasked.
	Ask bool
	// ThirdPartyMCP admits servers the agent configured. dsh asks before none of their tools (the
	// tool gate asks before each), so only a mode whose unapproved actions are allowed mounts them.
	ThirdPartyMCP bool
	// RoutineEscalations lets the runner allow a routine escalation itself instead of filing a
	// card (dshAutoRoutineEscalation). Only Auto: in Default every write asks by design.
	RoutineEscalations bool
}

func dshPermissionPolicyFor(mode string) (dshPermissionPolicy, error) {
	switch mode {
	case "default":
		return dshPermissionPolicy{FileMode: "read-only", Ask: true}, nil
	case "dontAsk":
		return dshPermissionPolicy{FileMode: "read-only"}, nil
	case "auto", "":
		// An unset mode is the server's floor, Auto (apiserver common/permission-mode.ts).
		return dshPermissionPolicy{FileMode: "workspace-write", Ask: true, ThirdPartyMCP: true, RoutineEscalations: true}, nil
	}
	return dshPermissionPolicy{}, fmt.Errorf("DSH_PERMISSION_UNSUPPORTED: permission mode %q cannot be enforced by DeepSeek Harness; use Default, Auto or Don't Ask", mode)
}

const (
	dshAllowOnce  = "allow-once"
	dshRejectOnce = "reject-once"
)

// dshPermissionAsk is one session/request_permission joined to the tool call it names. dsh sends
// only the toolCallId, after draining that call's tool_call update.
type dshPermissionAsk struct {
	TurnID     string
	ToolCallID string
	Name       string
	Input      interface{}
}

// dshPermissionBridge answers dsh's approval requests. A request is answered once: allow-once
// only for an Orbit ALLOWED decision reached while its turn is still open, reject-once for a
// decision against it, cancelled otherwise. Closing the bridge (stop, settlement, transport
// loss) cancels every pending card, and the allow check and its write share one lock, so an
// answer that arrives after a stop can never reach dsh ahead of, or after, the cancellation.
type dshPermissionBridge struct {
	mu      sync.Mutex
	open    bool
	next    int
	pending map[int]context.CancelFunc
	wg      sync.WaitGroup
	policy  func() dshPermissionPolicy
	lookup  func(toolCallID string) (dshPermissionAsk, bool)
	decide  func(context.Context, dshPermissionAsk) string // option id, or "" for no decision
	reply   func(id interface{}, outcome map[string]interface{}) error
	emit    emitTurnFn
	// workspace is the session's canonical cwd, the root a routine escalation must stay in.
	workspace string
}

func newDshPermissionBridge(policy func() dshPermissionPolicy, lookup func(string) (dshPermissionAsk, bool),
	decide func(context.Context, dshPermissionAsk) string, emit emitTurnFn) *dshPermissionBridge {
	return &dshPermissionBridge{pending: map[int]context.CancelFunc{}, policy: policy, lookup: lookup, decide: decide, emit: emit}
}

// begin opens the bridge for a prompt that is about to be written.
func (b *dshPermissionBridge) begin() {
	b.mu.Lock()
	b.open = true
	b.mu.Unlock()
}

// close stops answering with anything but cancelled, and withdraws every pending card.
func (b *dshPermissionBridge) close() {
	b.mu.Lock()
	b.open = false
	for id, cancel := range b.pending {
		cancel()
		delete(b.pending, id)
	}
	b.mu.Unlock()
}

func (b *dshPermissionBridge) wait() { b.wg.Wait() }

func dshPermissionOutcome(optionID string) map[string]interface{} {
	if optionID == "" {
		return map[string]interface{}{"outcome": "cancelled"}
	}
	return map[string]interface{}{"outcome": "selected", "optionId": optionID}
}

// request runs on the ACP reader. It never blocks on a human: the decision is awaited on its own
// goroutine, so updates and the prompt response keep flowing while a card is open.
func (b *dshPermissionBridge) request(id interface{}, params map[string]interface{}) {
	callID := firstString(mapValue(params["toolCall"]), "toolCallId")
	ask, known := b.lookup(callID)
	note := func(subtype, reason string) {
		b.emit(ask.TurnID, evSystem, map[string]interface{}{"subtype": subtype, "provider": providerDsh,
			"toolCallId": callID, "name": ask.Name, "reason": reason})
	}
	// The two option ids P0 recorded. Anything else is a contract change, never a default allow.
	offered := map[string]bool{}
	options, _ := params["options"].([]interface{})
	for _, raw := range options {
		offered[firstString(mapValue(raw), "optionId")] = true
	}
	b.mu.Lock()
	open := b.open
	b.mu.Unlock()
	switch {
	case !open:
		b.answer(id, "")
		return
	case !offered[dshAllowOnce] || !offered[dshRejectOnce]:
		note("permission_denied", "DeepSeek Harness offered unknown approval options")
		b.answer(id, "")
		return
	case !known:
		// Without the call's name and arguments there is nothing a person could approve.
		note("permission_denied", "approval requested for a tool call Orbit has not received")
		b.answer(id, dshRejectOnce)
		return
	case !b.policy().Ask:
		note("permission_denied", "Don't Ask refuses without asking")
		b.answer(id, dshRejectOnce)
		return
	case b.policy().RoutineEscalations && dshAutoRoutineEscalation(ask, b.workspace):
		// Allowed here, without a card, under the same lock as any other allow.
		b.mu.Lock()
		allowed := b.open
		if allowed {
			b.answer(id, dshAllowOnce)
		} else {
			b.answer(id, "")
		}
		b.mu.Unlock()
		if allowed {
			note("permission_auto_allowed", "Auto allows a routine command in the workspace to run outside the file sandbox once")
		}
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.mu.Lock()
	if !b.open {
		b.mu.Unlock()
		cancel()
		b.answer(id, "")
		return
	}
	b.next++
	key := b.next
	b.pending[key] = cancel
	b.wg.Add(1)
	b.mu.Unlock()
	go func() {
		defer b.wg.Done()
		optionID := b.decide(ctx, ask)
		b.mu.Lock()
		defer b.mu.Unlock()
		if ctx.Err() != nil || !b.open {
			optionID = "" // stopped, settled or disconnected while the card was open
		}
		delete(b.pending, key)
		cancel()
		if err := b.reply(id, dshPermissionOutcome(optionID)); err != nil && !errors.Is(err, context.Canceled) {
			logln("dsh permission reply:", err)
		}
	}()
}

func (b *dshPermissionBridge) answer(id interface{}, optionID string) {
	if err := b.reply(id, dshPermissionOutcome(optionID)); err != nil {
		logln("dsh permission reply:", err)
	}
}

// bridgeDshPermission puts one escalation in front of a person as Orbit's approval card. Only
// ALLOWED allows, once; a card that cannot be filed or read is no decision at all.
func bridgeDshPermission(ctx context.Context, t *Transport, sessionID string, ask dshPermissionAsk) string {
	approvalID, err := t.createApproval(ctx, sessionID, map[string]interface{}{
		"toolName": ask.Name, "input": ask.Input, "toolUseId": ask.ToolCallID,
	})
	if err != nil {
		return ""
	}
	decision, err := awaitApprovalDecision(ctx, t, sessionID, approvalID)
	if err != nil {
		return ""
	}
	switch decision.Status {
	case "ALLOWED":
		return dshAllowOnce
	case "DENIED":
		return dshRejectOnce
	}
	return ""
}

// dshAutoRoutineEscalation reports whether Auto may allow one sandbox escalation without a person.
//
// The workspace-write sandbox puts places Orbit itself relies on outside the workspace: an isolated
// session's linked worktree keeps its index, objects and refs in the main repository's .git, and
// toolchains keep their caches under HOME. So a git commit or a go test there is denied, and the
// model's escalated retry used to file a card every time — 35 cards in 8 task runs on one runner,
// every one allowed. Approving an escalation runs the whole command without the sandbox
// (danger-full-access is the only wider mode), so this allows only a shell command that stays
// where the session works: its directory and every path it names are in the workspace or a
// temporary directory, and it is none of the high-impact commands Codex's Auto also leaves to a
// person (codexAutoApproval: pushes, fetches, installs, remote shells, inline interpreters, secret
// files, recursive deletes). Any other tool, or a command this cannot read, still asks.
func dshAutoRoutineEscalation(ask dshPermissionAsk, workspace string) bool {
	if ask.Name != "bash" || !filepath.IsAbs(workspace) {
		return false
	}
	input := mapValue(ask.Input)
	command := strings.TrimSpace(firstString(input, "command"))
	if command == "" || firstString(input, "sandbox_permissions") == "" {
		return false
	}
	cwd := workspace
	if dir := firstString(input, "workdir"); dir != "" {
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(workspace, dir)
		}
		cwd = filepath.Clean(dir)
	}
	allowed, decided := codexAutoApproval(codexApprovalRequest{}, map[string]interface{}{"command": command, "cwd": cwd},
		codexAutoApprovalContext{workspaceRoots: []string{workspace}})
	return allowed && decided && dshToolGateMatch(command) == "" && !dshContainerCommand.MatchString(command) &&
		dshCommandStaysInWorkspace(command, cwd, workspace)
}

// A container command is never a routine escalation: a test stack's docker runs unasked inside the
// sandbox, but one that needs to write outside it (its config, a context) may as well be a deploy.
var dshContainerCommand = regexp.MustCompile(dshCommandAt + `(?:docker|podman)\s`)

// dshToolGateRule names one kind of command that acts on another system, and the pattern that finds
// it in a command line.
type dshToolGateRule struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
}

// dshToolGateRules are the shell commands a DeepSeek Harness session asks about before they run, in
// every permission mode: ones that act on another system, which the file sandbox cannot see. The
// session's gate plugin (dshToolGatePlugin) asks before a command that matches one, and the runner
// answers the ask for the mode — a card in Default and Auto, a refusal in Don't Ask — and never
// treats a matching escalation as routine. A pattern is matched against the command with commit
// messages removed (here-document bodies read as text, quoted git -m messages), and must mean the
// same in Go and in JavaScript, which receives these very strings: no lookarounds, no inline flags.
//
// Narrow on purpose. Without a reviewer every match is a person's time: these match none of the
// 1,518 sandboxed commands in this runner's dsh sessions (2026-10-08), where Codex's Auto list
// matches about 130, mostly python -c, rm -rf, git fetch and GitHub reads. Containers are left
// out: here docker runs test stacks.
var dshToolGateRules = []dshToolGateRule{
	{"a push", dshCommandAt + `git(?:\s+(?:-C|-c)\s+[^\s;|&]+|\s+--?[a-z][a-z-]*(?:=[^\s;|&]*)?)*\s+push` + dshWordEnd},
	{"a remote shell or copy", dshCommandAt + `(?:(?:ssh|sftp)\s+[^\s;|&]|(?:scp|rsync)\s[^;|&\n]*[^\s;|&:'"]+:(?:[^/]|/[^/]|$))`},
	{"an HTTP write", dshCommandAt + `(?:curl|wget)\s(?:[^;|&\n]*\s)?(?:-X\s*['"]?(?:POST|PUT|PATCH|DELETE|post|put|patch|delete)|--request[\s=]['"]?(?:POST|PUT|PATCH|DELETE|post|put|patch|delete)|(?:-d|-F|-T|--data|--data-[a-z]+|--form|--form-string|--upload-file|--json|--post-data|--post-file|--method)(?:[\s=]|$))`},
	{"a GitHub change", dshCommandAt + `gh\s+(?:pr\s+(?:create|merge|close|comment|edit|review|ready|reopen)|release\s+(?:create|delete|upload|edit)|repo\s+(?:create|delete|edit|fork|rename|archive)|issue\s+(?:create|close|comment|edit|delete|transfer|reopen)|workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel|delete)|secret\s+(?:set|delete)|variable\s+(?:set|delete)|api\s(?:[^;|&\n]*\s)?(?:-X\s*['"]?(?:POST|PUT|PATCH|DELETE)|--method[\s=]['"]?(?:POST|PUT|PATCH|DELETE)|-[fF]\s|--field|--raw-field|--input))`},
	{"a cluster or cloud change", dshCommandAt + `(?:kubectl\s(?:[^;|&\n]*\s)?(?:apply|create|delete|edit|patch|replace|scale|rollout|set|drain|cordon|uncordon|annotate|label|taint|exec|cp)|helm\s(?:[^;|&\n]*\s)?(?:install|upgrade|uninstall|rollback|delete)|terraform\s(?:[^;|&\n]*\s)?(?:apply|destroy|import)|pulumi\s(?:[^;|&\n]*\s)?(?:up|destroy)|aws\s(?:[^;|&\n]*\s)?(?:s3\s+(?:cp|mv|rm|sync|rb|mb)|[a-z0-9-]+\s+(?:put|delete|create|update|terminate|run|start|stop|reboot|modify|attach|detach|invoke|publish|send)-[a-z0-9-]+)|gcloud\s[^;|&\n]*\s(?:create|delete|deploy|update)|az\s[^;|&\n]*\s(?:create|delete|update|start|stop|restart))` + dshWordEnd},
	{"a service change", dshCommandAt + `(?:systemctl\s(?:[^;|&\n]*\s)?(?:start|stop|restart|reload|enable|disable|mask|unmask|kill|isolate|daemon-reload)|service\s+[^\s;|&]+\s+(?:start|stop|restart|reload)|launchctl\s+(?:load|unload|start|stop|kickstart|bootout|bootstrap))` + dshWordEnd},
	{"a privilege change", dshCommandAt + `(?:sudo|doas|su|pkexec)` + dshWordEnd},
	{"a power change", dshCommandAt + `(?:shutdown|reboot|poweroff|halt)` + dshWordEnd},
	{"a publish", dshCommandAt + `(?:(?:npm|pnpm|yarn|cargo|gem)\s+publish|twine\s+upload|(?:docker|podman)\s+push)` + dshWordEnd},
}

const (
	// Where a program is run, not merely named: the start of a command, after a separator or an
	// opening bracket, past the words that only run another program (sudo, env, timeout N, A=b,
	// then, do). So `grep shutdown log` and `echo "ssh mux"` match nothing.
	dshCommandAt = `(?:^|[;|&({\n\x60])\s*(?:(?:sudo|doas|env|nohup|time|exec|then|do|else|elif|!|timeout\s+[^\s;|&]+|[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;|&]*))\s+)*`
	dshWordEnd   = `(?:$|[\s;|&)}\x60])`
)

var dshToolGatePatterns = func() []*regexp.Regexp {
	compiled := make([]*regexp.Regexp, len(dshToolGateRules))
	for i, rule := range dshToolGateRules {
		compiled[i] = regexp.MustCompile(rule.Pattern)
	}
	return compiled
}()

// dshToolGateMatch names the rule a shell command meets, or "" — what the gate plugin computes in
// the session, so the runner and the plugin read a command the same way.
func dshToolGateMatch(command string) string {
	text := dshWithoutHeredocData(command)
	for _, match := range slices.Backward(dshGitMessage.FindAllStringSubmatchIndex(text, -1)) {
		text = text[:match[2]] + "''" + text[match[3]:]
	}
	for i, pattern := range dshToolGatePatterns {
		if pattern.MatchString(text) {
			return dshToolGateRules[i].Name
		}
	}
	return ""
}

// dshWithoutHeredocData drops the body of each here-document that is read as text, such as a commit
// message; a body fed to an interpreter is code and stays, as does a body with no closing delimiter.
// The gate plugin carries the same function in JavaScript.
func dshWithoutHeredocData(command string) string {
	lines := strings.Split(command, "\n")
	kept := make([]string, 0, len(lines))
	for i := 0; i < len(lines); i++ {
		kept = append(kept, lines[i])
		match := dshHeredoc.FindStringSubmatchIndex(lines[i])
		if match == nil || dshHeredocInterpreter.MatchString(lines[i][:match[0]]) {
			continue
		}
		end := i + 1
		for end < len(lines) && strings.TrimLeft(lines[end], "\t") != lines[i][match[2]:match[3]] {
			end++
		}
		if end < len(lines) {
			i = end
		}
	}
	return strings.Join(kept, "\n")
}

var (
	// A here-document operator and its delimiter word, quoted or not.
	dshHeredoc = regexp.MustCompile(`<<-?[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`)
	// A program that would run a here-document as code rather than read it as text.
	dshHeredocInterpreter = regexp.MustCompile(`(?:^|[\s;|&(])(?:bash|sh|zsh|dash|ksh|eval|python[0-9.]*|node|perl|ruby|php)(?:\s[^;|&]*)?$`)
	// cd with no directory, or back to the previous one: neither can be placed.
	dshUnplacedCd = regexp.MustCompile(`(?:^|[\s;|&(])cd(?:\s+-)?\s*(?:$|[;|&)\n])`)
	// A message git commit, merge or tag is given with -m, quoted so that nothing in it runs:
	// single quotes, or double quotes with no $ and no backquote. It is text, such as "A / B".
	dshGitMessage = regexp.MustCompile(`\bgit\b[^;|&\n]*?\s(?:commit|merge|tag)\b[^;|&\n]*?\s(?:-m|--message)(?:=|\s+)('[^']*'|"(?:[^"\\$` + "`" + `]|\\.)*")`)
)

// dshCommandStaysInWorkspace reads every word of a command line that could name a path — commit
// messages excepted, here-documents fed to a non-interpreter and quoted -m text, as both are data
// — and requires each to be in the workspace or a temporary directory. It is not a shell parser:
// a word it cannot place (a HOME path, an unknown variable, a .. that leaves) fails the command,
// so a misreading can only ever lead to a card.
func dshCommandStaysInWorkspace(command, cwd, workspace string) bool {
	text, ok := dshWithoutHeredocBodies(command)
	if !ok {
		return false
	}
	for _, match := range slices.Backward(dshGitMessage.FindAllStringSubmatchIndex(text, -1)) {
		text = text[:match[2]] + "''" + text[match[3]:]
	}
	if strings.Contains(text, "$HOME") || strings.Contains(text, "${HOME}") || dshUnplacedCd.MatchString(text) {
		return false
	}
	text = strings.NewReplacer("${PWD}", cwd, "$PWD", cwd).Replace(text)
	roots := []string{workspace, "/tmp", os.TempDir()}
	for _, word := range strings.FieldsFunc(text, func(r rune) bool { return strings.ContainsRune(" \t\r\n;|&<>()'\"`=", r) }) {
		switch {
		case strings.Contains(word, "://"):
			continue // a URL, not a path
		case strings.HasPrefix(word, "~"), strings.HasPrefix(word, "$") && strings.Contains(word, "/"):
			return false
		case strings.HasPrefix(word, "/"):
			path := filepath.Clean(word)
			if path == "/dev/null" || path == "/dev/stdout" || path == "/dev/stderr" || path == "/dev/stdin" ||
				strings.HasPrefix(path, "/dev/fd/") || codexPathWithinRoots(path, roots) {
				continue
			}
			return false
		case word == ".." || strings.HasPrefix(word, "../") || strings.Contains(word, "/../") || strings.HasSuffix(word, "/.."):
			if !codexPathWithinRoots(filepath.Join(cwd, word), roots) {
				return false
			}
		}
	}
	return true
}

// dshWithoutHeredocBodies drops each here-document's body, so a commit message that mentions a
// path is not read as one. A body fed to an interpreter is code and fails the command, as does a
// body with no closing delimiter.
func dshWithoutHeredocBodies(command string) (string, bool) {
	lines := strings.Split(command, "\n")
	kept := make([]string, 0, len(lines))
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		kept = append(kept, line)
		for _, match := range dshHeredoc.FindAllStringSubmatchIndex(line, -1) {
			if dshHeredocInterpreter.MatchString(line[:match[0]]) {
				return "", false
			}
			delimiter, trimTabs := line[match[2]:match[3]], strings.HasPrefix(line[match[0]:], "<<-")
			end := i + 1
			for ; end < len(lines); end++ {
				body := lines[end]
				if trimTabs {
					body = strings.TrimLeft(body, "\t")
				}
				if body == delimiter {
					break
				}
			}
			if end == len(lines) {
				return "", false
			}
			i = end
		}
	}
	return strings.Join(kept, "\n"), true
}
