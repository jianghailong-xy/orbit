package main

// Orbit's approval gate on the Antigravity engine (`agy`).
//
// Headless agy cannot ask anyone. In its own modes an action that needs approval is refused on the
// spot, and a PreToolUse hook cannot overrule that refusal; only under --dangerously-skip-permissions
// is the hook the one thing that decides (docs/antigravity-runtime-contract.md §5.2, §5.4). So the
// modes whose promise is that a person is asked — Default and Accept Edits — run agy with that flag
// and two hooks of Orbit's own, written into the session's Gemini directory:
//
//   - PreToolUse: `orbit hook antigravity-approval <policy> <sha256>` reads the tool call agy is about
//     to make, applies the session's rules, and when a person has to decide files the same approval
//     card the Kimi bridge does and waits for the answer (cmdHookAntigravityApproval).
//   - PreInvocation: `orbit hook antigravity-heartbeat <file> <token>` notes every model call agy
//     makes, so the runner can tell a process that runs Orbit's hooks from one that does not.
//
// The flag turns agy's own checks off, so it is added only while the hooks are known to be in force,
// and the session is stopped — never run unguarded — the moment that is in doubt:
//
//  1. before agy starts, `agy --print=/hooks` has to list Orbit's two hooks, from the file Orbit
//     wrote, and nothing else (verifyAntigravityApprovalGate);
//  2. while it runs, every model call agy answers has to have been preceded by Orbit's heartbeat,
//     and hooks.json has to still hold the bytes Orbit wrote: agy re-reads that file as it goes,
//     so a command that rewrote it would change the gate under the running process
//     (agyApprovalGate.check, measured on agy 1.2.16).
//
// What agy 1.2.16 was measured to do with a PreToolUse hook's answer, under the flag: only
// `{"decision":"allow"}` (or an empty answer, or "ask") runs the tool; `{"decision":"deny",
// "reason":…}` refuses it and hands the model the reason; a hook that exits non-zero, prints
// anything unparseable, or outlives its timeout refuses it too. The hook therefore always prints
// exactly one decision, and exits non-zero when it cannot.
//
// Not every call reaches the hook. ask_question never does, but headless agy answers it itself with
// "User Skipped", and it runs nothing. A subagent's own tool calls never do either — they run with no
// hook at all — so the hook refuses to launch a subagent in the modes that ask.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// agyApprovalHookName names Orbit's entry in hooks.json, and is how Orbit recognizes the file as its
// own when a session leaves the modes that ask (removeAntigravityApprovalGate).
const agyApprovalHookName = "orbit-approval"

// agyApprovalHookTimeout is how long agy lets the approval hook run, and so how long a person has to
// answer a card. The turn waits that long, the way it waits on a Claude permission prompt; past it
// the call is refused. A var so the contract test can make it seconds.
var agyApprovalHookTimeout = 24 * time.Hour

// agyHeartbeatHookTimeout bounds the PreInvocation hook, which only appends a line to a file.
const agyHeartbeatHookTimeout = 30 * time.Second

// agyHooksCheckTimeout bounds `agy --print=/hooks`. A cold first start of the 200MB binary took ~12s.
const agyHooksCheckTimeout = time.Minute

// agyApprovalAnswerWithin is how long the hook waits for a person: a little less than agy gives it,
// so the denial is the hook's own, with a reason the model can read, rather than agy killing it.
func agyApprovalAnswerWithin(timeout time.Duration) time.Duration {
	margin := timeout / 10
	if margin > time.Minute {
		margin = time.Minute
	}
	return timeout - margin
}

// antigravityAsksForApproval is whether Orbit's approval gate is how agy runs in a mode: the modes
// whose promise is that a person decides what nobody approved. Plan and Don't Ask never ask — agy's
// own refusal is what they already promise — and Auto and Bypass never stop.
func antigravityAsksForApproval(mode string) bool {
	switch strings.TrimSpace(mode) {
	case "default", "acceptEdits":
		return true
	}
	return false
}

// agyApprovalPolicy is what the approval hook decides by: the session's mode and rules, as the runner
// had them when it started this agy. Written next to hooks.json, and named there with its SHA-256,
// so the hook refuses everything if the file is not the one the runner wrote.
type agyApprovalPolicy struct {
	SessionID       string   `json:"sessionId"`
	Mode            string   `json:"mode"`
	Workspace       string   `json:"workspace"`
	Uploads         string   `json:"uploads,omitempty"`
	GeminiDir       string   `json:"geminiDir"`
	AllowedTools    []string `json:"allowedTools,omitempty"`
	DisallowedTools []string `json:"disallowedTools,omitempty"`
	AnswerWithinMs  int64    `json:"answerWithinMs"`
}

// agyHookInput is the PreToolUse payload agy writes on the hook's stdin (contract §5.4). Unlike the
// stream, args are the call's whole parameters.
type agyHookInput struct {
	ToolCall struct {
		Name string                 `json:"name"`
		Args map[string]interface{} `json:"args"`
	} `json:"toolCall"`
	StepIdx               *int   `json:"stepIdx"`
	ConversationID        string `json:"conversationId"`
	ArtifactDirectoryPath string `json:"artifactDirectoryPath"`
}

// agyHookDecision is the hook's answer, in agy's words.
type agyHookDecision struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

func agyAllow() agyHookDecision { return agyHookDecision{Decision: "allow"} }

func agyDeny(reason string) agyHookDecision {
	return agyHookDecision{Decision: "deny", Reason: reason}
}

const agySubagentRefusal = "Subagents are not available in this session: a subagent's own tool calls" +
	" run without Orbit's approval, and this session's permission mode has a person approve what runs." +
	" Do the work yourself with your own tools."

const agyOrbitConfigRefusal = "This file is Orbit's own configuration for this session, which an agent" +
	" may not change."

// agyApprovalVerdict is what the session's policy says about one tool call: allow it, refuse it
// (with the reason the model is given), or put it to a person (ask).
type agyApprovalVerdict struct {
	decision string // "allow", "deny" or "ask"
	reason   string
}

// decideAntigravityToolCall applies the session's policy to one tool call, without asking anyone.
// Deny rules come first, as they hold in every mode; then what this session lets through without a
// person — Orbit's own MCP server, the session's allow rules, the tools that act only on agy's own
// bookkeeping, reads where agy itself reads freely, and in Accept Edits the workspace's files.
// Everything else is a person's to decide in the modes that ask, and refused in any other.
func decideAntigravityToolCall(policy *agyApprovalPolicy, in *agyHookInput) agyApprovalVerdict {
	raw := in.ToolCall.Name
	if raw == "" {
		return agyApprovalVerdict{"deny", "Orbit could not read which tool this call is for."}
	}
	args := in.ToolCall.Args
	if args == nil {
		args = map[string]interface{}{}
	}
	name, input := agyApprovalSubject(raw, args)
	switch raw {
	case "invoke_subagent", "define_subagent":
		return agyApprovalVerdict{"deny", agySubagentRefusal}
	}
	artifacts := agyArtifactDir(policy.GeminiDir, in.ArtifactDirectoryPath)
	target, writes := agyWriteTarget(raw, args)
	if writes && policy.GeminiDir != "" && pathWithin(target, policy.GeminiDir) && !(artifacts != "" && pathWithin(target, artifacts)) {
		return agyApprovalVerdict{"deny", agyOrbitConfigRefusal}
	}
	for _, rule := range policy.DisallowedTools {
		if agyRuleDenies(rule, name, input) {
			return agyApprovalVerdict{"deny", "A permission rule of this workspace denies " + name + " (" + strings.TrimSpace(rule) + ")."}
		}
	}
	if agyOrbitMCPCall(raw, args) {
		return agyApprovalVerdict{"allow", ""}
	}
	for _, rule := range policy.AllowedTools {
		if kimiToolMatchesRule(rule, name, input) {
			return agyApprovalVerdict{"allow", ""}
		}
	}
	switch raw {
	case "schedule", "manage_subagents", "ask_question":
		// A timer that prompts this same agent later, the list of subagents it cannot launch, and a
		// question headless agy answers itself ("User Skipped", contract §10.2): none of them acts.
		return agyApprovalVerdict{"allow", ""}
	case "manage_task":
		// The background commands this agent started: listing, reading and stopping them is its own
		// bookkeeping. Typing into one is running a command, and is asked like one.
		switch strings.ToLower(firstString(args, "Action")) {
		case "list", "status", "kill":
			return agyApprovalVerdict{"allow", ""}
		}
	case "view_file":
		// agy reads its workspace without asking in its own default mode (contract §5.3); the
		// session's uploads and the conversation's artifacts are where Orbit and agy put files for it.
		path := firstString(args, "AbsolutePath")
		if pathWithin(path, policy.Workspace) || pathWithin(path, policy.Uploads) || pathWithin(path, artifacts) {
			return agyApprovalVerdict{"allow", ""}
		}
	}
	if writes {
		// agy writes its own artifacts — plans, task lists — without asking, in every mode (measured
		// on 1.2.16); Accept Edits adds the workspace's files, except agy's own configuration there:
		// a .agents/hooks.json written into the checkout is loaded from the next turn on, and its
		// command runs before every tool call (measured on 1.2.16).
		if pathWithin(target, artifacts) ||
			(policy.Mode == "acceptEdits" && pathWithin(target, policy.Workspace) && !agyConfigPath(target)) {
			return agyApprovalVerdict{"allow", ""}
		}
	}
	if antigravityAsksForApproval(policy.Mode) {
		return agyApprovalVerdict{"ask", ""}
	}
	return agyApprovalVerdict{"deny", "This session's permission mode does not ask for approval, and nothing approved " + name + "."}
}

// agyApprovalSubject is a tool call as Orbit's rules and its approval card read it: the name and
// input claude would give the same call (canonicalAgyTool), with what agy's stream leaves out — the
// content of a write, the text of an edit — put back, because the card is what a person decides on.
func agyApprovalSubject(raw string, args map[string]interface{}) (string, map[string]interface{}) {
	put := func(out map[string]interface{}, key string, value interface{}) {
		if s, ok := value.(string); ok && s == "" {
			return
		}
		if value != nil {
			out[key] = value
		}
	}
	switch raw {
	case "run_command":
		input := map[string]interface{}{"command": firstString(args, "CommandLine")}
		put(input, "cwd", args["Cwd"])
		return "Bash", input
	case "view_file":
		return "Read", map[string]interface{}{"file_path": firstString(args, "AbsolutePath")}
	case "write_to_file":
		input := map[string]interface{}{"file_path": firstString(args, "TargetFile")}
		put(input, "content", args["CodeContent"])
		return "Write", input
	case "replace_file_content":
		input := map[string]interface{}{"file_path": firstString(args, "TargetFile")}
		put(input, "old_string", args["TargetContent"])
		put(input, "new_string", args["ReplacementContent"])
		return "Edit", input
	case "multi_replace_file_content":
		input := map[string]interface{}{"file_path": firstString(args, "TargetFile")}
		put(input, "edits", args["ReplacementChunks"])
		return "Edit", input
	}
	name, value := canonicalAgyTool(raw, args)
	input := mapValue(value)
	if input == nil {
		input = map[string]interface{}{}
	}
	return name, input
}

// agyConfigPath is whether a path is in an .agents directory, where agy finds a checkout's hooks,
// MCP servers and plugins (contract §3.5).
func agyConfigPath(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(filepath.Clean(path)), "/") {
		if part == ".agents" {
			return true
		}
	}
	return false
}

// agyWriteTarget is the file a call writes, for the tools that write one.
func agyWriteTarget(raw string, args map[string]interface{}) (string, bool) {
	switch raw {
	case "write_to_file", "replace_file_content", "multi_replace_file_content":
		return firstString(args, "TargetFile"), true
	}
	return "", false
}

// agyOrbitMCPCall is a call to Orbit's own MCP server, which the session's Gemini directory always
// registers as "orbit" (antigravityMCPServers): it reaches only this session's owner's Orbit, and
// asking about each task_get would make the server unusable.
func agyOrbitMCPCall(raw string, args map[string]interface{}) bool {
	switch raw {
	case "call_mcp_tool", "list_resources", "read_resource":
		return firstString(args, "ServerName") == "orbit"
	}
	return false
}

// agyArtifactDir is the conversation's artifact directory agy names in the payload, trusted only
// where agy keeps it: one directory below <gemini dir>/antigravity-cli/brain.
func agyArtifactDir(geminiDir, path string) string {
	if geminiDir == "" || path == "" || !filepath.IsAbs(path) {
		return ""
	}
	path = filepath.Clean(path)
	brain := filepath.Join(filepath.Clean(geminiDir), "antigravity-cli", "brain")
	if filepath.Dir(path) != brain {
		return ""
	}
	return path
}

// agyRuleDenies is a deny rule read the way a denial may be read: wider than written, never
// narrower. Non-shell rules match as Kimi's do. A shell rule denies any command line that has its
// words anywhere in it — `Bash(rm:*)` refuses `true && rm -f x` and `echo rm` alike — since agy's
// own copy of the rule (permissions.deny, which holds under the flag too) refuses those anyway, and
// a person should not be asked about a call that will be refused.
func agyRuleDenies(rule, name string, input map[string]interface{}) bool {
	rule = strings.TrimSpace(rule)
	if kimiToolMatchesRule(rule, name, input) {
		return true
	}
	if name != "Bash" {
		return false
	}
	open := strings.IndexByte(rule, '(')
	if open < 0 || !strings.HasSuffix(rule, ")") || strings.TrimSpace(rule[:open]) != "Bash" {
		return false
	}
	content := strings.TrimSpace(rule[open+1 : len(rule)-1])
	if prefix, ok := claudeBashRulePrefix(content); ok {
		if prefix == "" {
			return true
		}
		content = prefix
	}
	want := shellWords(content)
	if len(want) == 0 {
		return false
	}
	have := shellWords(firstString(input, "command"))
	for i := 0; i+len(want) <= len(have); i++ {
		match := true
		for j, word := range want {
			if have[i+j] != word {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// shellWords splits a command line at whitespace and at the characters shell syntax is made of, so
// `true&&rm -f x` reads as true, rm, -f, x.
func shellWords(line string) []string {
	return strings.FieldsFunc(line, func(r rune) bool {
		switch r {
		case ' ', '\t', '\n', '\r', ';', '&', '|', '<', '>', '(', ')', '`', '$', '"', '\'', '{', '}':
			return true
		}
		return false
	})
}

// pathWithin is whether path names root or something under it, once both are resolved. A path that
// cannot be resolved with certainty — relative, a dangling link, a parent that cannot be read — is
// not within anything.
func pathWithin(path, root string) bool {
	if strings.TrimSpace(path) == "" || strings.TrimSpace(root) == "" {
		return false
	}
	resolvedPath, ok := resolvePathForPolicy(path)
	if !ok {
		return false
	}
	resolvedRoot, ok := resolvePathForPolicy(root)
	if !ok {
		return false
	}
	rel, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// resolvePathForPolicy is an absolute path with every symlink in it resolved, for a path that may
// not exist yet (a file about to be written): its deepest existing ancestor is resolved, and the
// rest appended. A link that leads nowhere fails rather than reading as a new file, because
// writing through it creates whatever it points at.
func resolvePathForPolicy(path string) (string, bool) {
	if !filepath.IsAbs(path) {
		return "", false
	}
	current := filepath.Clean(path)
	rest := ""
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			return filepath.Join(resolved, rest), true
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", false
		}
		if _, err := os.Lstat(current); err == nil {
			return "", false // there, but leading nowhere
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", false
		}
		rest = filepath.Join(filepath.Base(current), rest)
		current = parent
	}
}

// ── The hooks ───────────────────────────────────────────────────────────────────────────────────

// cmdHookAntigravityApproval is the PreToolUse hook: one tool call in, one decision out. Whatever
// goes wrong is a denial, and a denial that cannot be written is a non-zero exit, which agy also
// treats as one: an empty answer would let the call run.
func cmdHookAntigravityApproval(args []string, stdin io.Reader, stdout io.Writer) int {
	decision := antigravityApprovalHookDecision(args, stdin)
	body, err := json.Marshal(decision)
	if err != nil {
		return 1
	}
	if _, err := stdout.Write(append(body, '\n')); err != nil {
		return 1
	}
	return 0
}

func antigravityApprovalHookDecision(args []string, stdin io.Reader) agyHookDecision {
	if len(args) != 2 {
		return agyDeny("Orbit's approval hook was started without its policy.")
	}
	policy, err := readAntigravityApprovalPolicy(args[0], args[1])
	if err != nil {
		return agyDeny("Orbit's approval policy for this session could not be read (" + err.Error() + "), so nothing runs without it.")
	}
	var in agyHookInput
	if err := json.NewDecoder(io.LimitReader(stdin, 16<<20)).Decode(&in); err != nil {
		return agyDeny("Orbit could not read this tool call: " + err.Error())
	}
	verdict := decideAntigravityToolCall(policy, &in)
	switch verdict.decision {
	case "allow":
		return agyAllow()
	case "ask":
		return askAntigravityApproval(policy, &in)
	}
	return agyDeny(verdict.reason)
}

// readAntigravityApprovalPolicy reads the policy the runner wrote, and only that one: its SHA-256
// is in the hook's own command line, in hooks.json, which the runner watches.
func readAntigravityApprovalPolicy(path, sum string) (*agyApprovalPolicy, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != strings.ToLower(strings.TrimSpace(sum)) {
		return nil, errors.New("it is not the policy the runner wrote")
	}
	var policy agyApprovalPolicy
	if err := json.Unmarshal(body, &policy); err != nil {
		return nil, err
	}
	if strings.TrimSpace(policy.SessionID) == "" {
		return nil, errors.New("it names no session")
	}
	return &policy, nil
}

// askAntigravityApproval puts one call to a person on the same card the Kimi and Codex bridges file,
// and waits for the answer — until the policy's deadline, after which no answer is a refusal. The
// card's toolUseId is the tool_use id the transcript gives the call (conversation:step), so a retried
// hook finds its card rather than filing a second one.
func askAntigravityApproval(policy *agyApprovalPolicy, in *agyHookInput) agyHookDecision {
	cfg := loadConfig()
	if cfg == nil {
		return agyDeny("Orbit could not ask for approval: this runner has no configuration.")
	}
	within := time.Duration(policy.AnswerWithinMs) * time.Millisecond
	if within <= 0 {
		within = agyApprovalAnswerWithin(agyApprovalHookTimeout)
	}
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	name, input := agyApprovalSubject(in.ToolCall.Name, in.ToolCall.Args)
	toolUseID := ""
	if in.StepIdx != nil && in.ConversationID != "" {
		toolUseID = in.ConversationID + ":" + fmt.Sprint(*in.StepIdx)
	}
	t := NewTransport(cfg.ServerURL, cfg.RunnerToken)
	approvalID, err := t.createApproval(ctx, policy.SessionID, map[string]interface{}{
		"toolName":  name,
		"input":     input,
		"toolUseId": toolUseID,
	})
	if err != nil {
		return agyDeny("Orbit could not ask for approval of this call: " + err.Error())
	}
	decision, err := awaitApprovalDecision(ctx, t, policy.SessionID, approvalID)
	if err != nil {
		if ctx.Err() != nil {
			return agyDeny(fmt.Sprintf("Nobody answered the approval request for this call within %s, so it was not run.", within.Round(time.Second)))
		}
		return agyDeny("Orbit could not get an answer to the approval request for this call: " + err.Error())
	}
	if decision.Status == "ALLOWED" {
		return agyAllow()
	}
	if message := strings.TrimSpace(decision.Message); message != "" {
		return agyDeny("The user denied this call: " + message)
	}
	return agyDeny("The user denied this call.")
}

// cmdHookAntigravityHeartbeat is the PreInvocation hook: it appends the process's token to the
// heartbeat file, one line per model call. agy goes on with the call whatever this does; a beat
// that is missing is the runner's to act on.
func cmdHookAntigravityHeartbeat(args []string, stdin io.Reader, stdout io.Writer) int {
	_, _ = io.Copy(io.Discard, io.LimitReader(stdin, 16<<20))
	if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
		return 1
	}
	f, err := os.OpenFile(args[0], os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return 1
	}
	_, werr := f.WriteString(args[1] + "\n")
	cerr := f.Close()
	if werr != nil || cerr != nil {
		return 1
	}
	_, _ = io.WriteString(stdout, "{}\n")
	return 0
}

// ── The runner's side ───────────────────────────────────────────────────────────────────────────

// agyApprovalGate is the gate one agy process runs behind: the hooks.json Orbit wrote for it, and
// the heartbeat its PreInvocation hook keeps.
type agyApprovalGate struct {
	hooksPath string
	hooks     []byte
	beatPath  string
	token     string
	// execDir is the checkout agy runs in, whose .agents/ agy re-reads too.
	execDir string
	// The agent_response steps this process has streamed, by step index: one per model call.
	responses map[int]bool
}

// agyHookAction is one hook as `agy --print=/hooks` lists it.
type agyHookAction struct {
	Event          string `json:"event"`
	Matcher        string `json:"matcher"`
	Type           string `json:"type"`
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

// installAntigravityApprovalGate writes Orbit's hooks and the policy they read into the session's
// Gemini directory, and returns once agy itself has confirmed it loads them — or an error, on which
// the session must not start.
func installAntigravityApprovalGate(ctx context.Context, job *ClaimedSession, execDir, geminiDir, orbitExe string) (*agyApprovalGate, error) {
	exe := orbitCLIPermissionExecutable(orbitExe)
	if exe == "" {
		return nil, errors.New("Orbit's approval hook cannot be installed: the runner's own executable path is not usable in a hook command")
	}
	dir := filepath.Join(geminiDir, "orbit")
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return nil, err
	}
	timeout := agyApprovalHookTimeout
	policy := agyApprovalPolicy{
		SessionID:       job.SessionID,
		Mode:            strings.TrimSpace(job.Agent.PermissionMode),
		Workspace:       execDir,
		Uploads:         uploadsDir(job.SessionID),
		GeminiDir:       geminiDir,
		AllowedTools:    job.Agent.AllowedTools,
		DisallowedTools: job.Agent.DisallowedTools,
		AnswerWithinMs:  agyApprovalAnswerWithin(timeout).Milliseconds(),
	}
	body, err := json.MarshalIndent(policy, "", "  ")
	if err != nil {
		return nil, err
	}
	policyPath := filepath.Join(dir, "approval-policy.json")
	if err := os.WriteFile(policyPath, body, 0o600); err != nil {
		return nil, fmt.Errorf("write the approval policy: %w", err)
	}
	digest := sha256.Sum256(body)
	token, err := agyHeartbeatToken()
	if err != nil {
		return nil, err
	}
	beatPath := filepath.Join(dir, "heartbeat")
	// A fresh count for a fresh process: nothing an earlier one wrote may stand in for this one's.
	if err := os.Remove(beatPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	want := []agyHookAction{
		{Event: "PreToolUse", Type: "command", TimeoutSeconds: int(timeout / time.Second),
			Command: shellQuote(exe) + " hook antigravity-approval " + shellQuote(policyPath) + " " + hex.EncodeToString(digest[:])},
		{Event: "PreInvocation", Type: "command", TimeoutSeconds: int(agyHeartbeatHookTimeout / time.Second),
			Command: shellQuote(exe) + " hook antigravity-heartbeat " + shellQuote(beatPath) + " " + token},
	}
	// The two shapes differ: PreToolUse entries carry a matcher ("" is every tool) around their
	// hooks, PreInvocation entries are the hook itself. PreInvocation written the other way does not
	// fail — it silently disables every hook in the file (contract §5.4).
	hooks := map[string]interface{}{agyApprovalHookName: map[string]interface{}{
		"PreToolUse": []interface{}{map[string]interface{}{
			"matcher": "",
			"hooks": []interface{}{map[string]interface{}{
				"type": "command", "command": want[0].Command, "timeout": want[0].TimeoutSeconds,
			}},
		}},
		"PreInvocation": []interface{}{map[string]interface{}{
			"type": "command", "command": want[1].Command, "timeout": want[1].TimeoutSeconds,
		}},
	}}
	hooksBody, err := json.MarshalIndent(hooks, "", "  ")
	if err != nil {
		return nil, err
	}
	hooksBody = append(hooksBody, '\n')
	hooksPath := filepath.Join(geminiDir, "config", "hooks.json")
	if err := os.WriteFile(hooksPath, hooksBody, 0o600); err != nil {
		return nil, fmt.Errorf("write hooks.json: %w", err)
	}
	if err := verifyAntigravityApprovalGate(ctx, job, execDir, geminiDir, hooksPath, want); err != nil {
		return nil, err
	}
	return &agyApprovalGate{hooksPath: hooksPath, hooks: hooksBody, beatPath: beatPath, token: token, execDir: execDir, responses: map[int]bool{}}, nil
}

func agyHeartbeatToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// verifyAntigravityApprovalGate asks agy, with the session's own directory, environment and working
// directory, which hooks it would run: `--print=/hooks` lists every hook agy loads and the file it came
// from (contract §5.4). It has to be exactly Orbit's two, from the file Orbit wrote. Anything else —
// agy failing, a hook missing or changed, another hook beside them, a repository's .agents/hooks.json —
// is a refusal: a hook nobody reviewed could answer "allow" for Orbit, and a missing one leaves the
// flag in charge alone.
func verifyAntigravityApprovalGate(ctx context.Context, job *ClaimedSession, execDir, geminiDir, hooksPath string, want []agyHookAction) error {
	cctx, cancel := context.WithTimeout(ctx, agyHooksCheckTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, agyExecutable, "--gemini_dir="+geminiDir, "--print=/hooks", "--output-format", "json")
	cmd.Dir = execDir
	cmd.Env = antigravityEnv(job, execDir)
	// Listing hooks reads no model, but agy will not start in API-key mode without a key: a session
	// that has none fails on its own first start, with agy's own words, rather than here.
	if strings.TrimSpace(envValue(cmd.Env, "GEMINI_API_KEY")) == "" {
		cmd.Env = envWithValue(cmd.Env, "GEMINI_API_KEY", antigravityModelCatalogPlaceholderKey)
	}
	cmd.Stdin = nil
	cmd.WaitDelay = 5 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(lastLine(stderr.String()))
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("could not confirm that Orbit's approval hook is loaded (agy --print=/hooks: %s), and in a mode that asks agy does not start without it", detail)
	}
	if problem := agyHooksListingProblem(out, hooksPath, want); problem != "" {
		return errors.New("Orbit's approval hook is not loaded as written (" + problem + "), and in a mode that asks agy does not start without it: nothing would ask before it acts")
	}
	return nil
}

// agyHooksListingProblem reads `agy --print=/hooks --output-format json` and says what is wrong with
// it, or "" when it lists exactly Orbit's hooks from Orbit's file.
func agyHooksListingProblem(out []byte, hooksPath string, want []agyHookAction) string {
	var listing struct {
		Status  string `json:"status"`
		Command struct {
			Name string `json:"name"`
			Data struct {
				Hooks []struct {
					Name    string          `json:"name"`
					Enabled bool            `json:"enabled"`
					Source  string          `json:"source"`
					Actions []agyHookAction `json:"actions"`
				} `json:"hooks"`
			} `json:"data"`
		} `json:"command"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &listing); err != nil {
		return "agy's answer was not the hook listing: " + clip(strings.TrimSpace(string(out)), 200)
	}
	if listing.Status != "SUCCESS" || listing.Command.Name != "hooks" {
		return "agy's answer was not the hook listing: status " + listing.Status
	}
	hooks := listing.Command.Data.Hooks
	if len(hooks) == 0 {
		return "agy lists no hooks"
	}
	for _, hook := range hooks {
		if hook.Name != agyApprovalHookName || !samePath(hook.Source, hooksPath) {
			return fmt.Sprintf("agy would also run hook %q from %s", hook.Name, hook.Source)
		}
	}
	if len(hooks) != 1 {
		return "agy lists Orbit's hook more than once"
	}
	hook := hooks[0]
	if !hook.Enabled {
		return "agy lists Orbit's hook as disabled"
	}
	if len(hook.Actions) != len(want) {
		return fmt.Sprintf("agy lists %d hook actions, want %d", len(hook.Actions), len(want))
	}
	for _, w := range want {
		found := false
		for _, a := range hook.Actions {
			if a.Event == w.Event && a.Type == w.Type && a.Command == w.Command && a.Matcher == "" && a.TimeoutSeconds == w.TimeoutSeconds {
				found = true
				break
			}
		}
		if !found {
			return "agy does not list Orbit's " + w.Event + " hook as written"
		}
	}
	return ""
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && ra == rb
}

// removeAntigravityApprovalGate takes Orbit's hooks out of a session's Gemini directory when its
// mode no longer asks: in Plan or Don't Ask the hook could only file cards for calls agy refuses
// anyway, and in Auto or Bypass it would ask where the session promised not to. A hooks.json that is
// not Orbit's is left alone.
func removeAntigravityApprovalGate(geminiDir string) error {
	path := filepath.Join(geminiDir, "config", "hooks.json")
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var hooks map[string]json.RawMessage
	if json.Unmarshal(body, &hooks) != nil {
		return nil
	}
	if _, ours := hooks[agyApprovalHookName]; !ours {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// check is the runtime half of the gate, run on every step agy streams. hooks.json has to still be
// the bytes Orbit wrote, and the checkout must not have grown hooks or MCP servers of its own: agy
// re-reads both as it goes, so a command that wrote either would change the gate under the running
// process (measured on 1.2.16). And every model call agy has answered has to have been preceded by
// Orbit's heartbeat: a process that answers without one is not running Orbit's hooks. Returns what
// is wrong, or "".
func (g *agyApprovalGate) check(step map[string]interface{}) string {
	body, err := os.ReadFile(g.hooksPath)
	if err != nil || !bytes.Equal(body, g.hooks) {
		return "its hooks.json was changed while agy was running"
	}
	if g.execDir != "" {
		if err := guardAntigravityProjectConfig(g.execDir, "default"); err != nil {
			return "the checkout now brings its own agy configuration (" + err.Error() + ")"
		}
	}
	if firstString(step, "step_type") != "agent_response" {
		return ""
	}
	index := toInt(step["step_index"])
	if g.responses[index] {
		return ""
	}
	g.responses[index] = true
	if beats := g.beats(); beats < len(g.responses) {
		return fmt.Sprintf("agy answered %d model call(s) and Orbit's hook saw %d", len(g.responses), beats)
	}
	return ""
}

// beats counts this process's heartbeats.
func (g *agyApprovalGate) beats() int {
	f, err := os.Open(g.beatPath)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == g.token {
			n++
		}
	}
	return n
}
