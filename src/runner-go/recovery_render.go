package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// The recovery renderer (docs/recovery-contract.md §7): one failure, met by `orbit mcp` or by the CLI,
// becomes the same report — the contract's envelope plus the next step this surface can actually take.
// MCP keeps content[0].text and isError as they were and adds the report as structuredContent; the CLI
// prints the report as the one JSON document of a failed --json call and exits non-zero.
//
// The envelope comes from recoveryOf, so the code, effect, retry and actionCode are the same on both
// surfaces. Only the step differs: a tool name and its input over MCP, an absolute argv and its stdin at
// a terminal. A step is offered as "invoke" only when this process really exposes the tool or command;
// otherwise it degrades to ask_user, wait or manual. Nothing here ever builds a shell string.

// recoveryTextError retains a transport cause while preserving an existing human error line.
type recoveryTextError struct {
	text  string
	cause error
}

func (e *recoveryTextError) Error() string { return e.text }
func (e *recoveryTextError) Unwrap() error { return e.cause }

// recoveryReport is what a failed call reports. Text is the legacy human-readable text, filled in on the
// CLI only: over MCP the same text is already content[0].text.
type recoveryReport struct {
	OK    bool             `json:"ok"`
	Error recoveryEnvelope `json:"error"`
	Next  recoveryNext     `json:"next"`
	Text  string           `json:"text,omitempty"`
}

// recoveryNext is the one step to take next. Type is invoke, ask_user, wait or manual. An invoke names
// either Tool and Input (MCP) or Argv and Stdin (CLI); Argv[0] is an absolute path, and Stdin is the
// exact bytes to write to the command's standard input (null when it reads none).
type recoveryNext struct {
	Type         string                 `json:"type"`
	ActionCode   *string                `json:"actionCode"`
	Tool         string                 `json:"tool,omitempty"`
	Input        map[string]interface{} `json:"input,omitempty"`
	Argv         []string               `json:"argv,omitempty"`
	Stdin        *string                `json:"stdin,omitempty"`
	AfterSeconds *int                   `json:"afterSeconds"`
	Reason       string                 `json:"reason"`
}

const (
	recoveryNextInvoke  = "invoke"
	recoveryNextAskUser = "ask_user"
	recoveryNextWait    = "wait"
	recoveryNextManual  = "manual"
)

// recoveryLocalRefusedCode is the code of a failure this process made before sending anything.
const recoveryLocalRefusedCode = "LOCAL_INVALID_REQUEST"

// recoveryRequestIDArgs are the arguments that name a request id the server reads an earlier answer back
// by, as the MCP tools and the CLI flags spell them. Either one present means the request carried an id.
var recoveryRequestIDArgs = [][2]string{
	{"idempotencyKey", "--idempotency-key"},
	{"clientTurnId", "--client-turn-id"},
	{"triggerId", "--trigger-id"},
}

// recoveryReaders is the read-only tool that shows a resource of each type, and the input key it takes.
var recoveryReaders = map[string][2]string{
	"TASK":    {"task_get", "taskId"},
	"SESSION": {"session_get", "sessionId"},
	"PROJECT": {"project_get", "projectId"},
}

// ── what this process sent ─────────────────────────────────────────────────

// transportActivity counts the control-plane calls this process sent, the writes among them that were
// answered 2xx, and keeps the latest failures. A tool or command that failed reads it to tell a failure
// it made itself before sending anything (nothing written) from one the server answered, and to notice a
// write that went through before the call failed.
var transportActivity struct {
	mu       sync.Mutex
	sent     uint64
	writes   uint64
	failures []transportFailure
	seq      uint64
}

type transportFailure struct {
	seq        uint64
	err        error
	requestIDs map[string]string
}

const maxRecordedTransportFailures = 16

func noteTransportAttempt() {
	transportActivity.mu.Lock()
	transportActivity.sent++
	transportActivity.mu.Unlock()
}

func noteTransportResult(method string, err error, bodies ...interface{}) {
	transportActivity.mu.Lock()
	defer transportActivity.mu.Unlock()
	if err == nil {
		if method != http.MethodGet && method != http.MethodHead {
			transportActivity.writes++
		}
		return
	}
	transportActivity.seq++
	transportActivity.failures = append(transportActivity.failures, transportFailure{seq: transportActivity.seq, err: err, requestIDs: outboundRecoveryIDs(bodies)})
	if n := len(transportActivity.failures); n > maxRecordedTransportFailures {
		transportActivity.failures = transportActivity.failures[n-maxRecordedTransportFailures:]
	}
}

// Read IDs from the serialized outbound body, never from user text in argv.
func outboundRecoveryIDs(bodies []interface{}) map[string]string {
	ids := map[string]string{}
	if len(bodies) == 0 {
		return ids
	}
	data, err := json.Marshal(bodies[0])
	if err != nil {
		return ids
	}
	var body map[string]interface{}
	if json.Unmarshal(data, &body) != nil {
		return ids
	}
	if !mcpRequestIDSent(body) {
		return ids
	}
	for _, pair := range recoveryRequestIDArgs {
		if id, ok := body[pair[0]].(string); ok && strings.TrimSpace(id) != "" {
			ids[pair[0]] = id
		}
	}
	return ids
}

func (m transportMark) failedRequestIDs(err error, text ...string) map[string]string {
	transportActivity.mu.Lock()
	defer transportActivity.mu.Unlock()
	for i := len(transportActivity.failures) - 1; i >= 0; i-- {
		f := transportActivity.failures[i]
		matches := err != nil && errors.Is(err, f.err)
		if err == nil && len(text) > 0 && f.err.Error() != "" {
			matches = strings.Contains(text[0], f.err.Error())
		}
		if f.seq > m.seq && matches {
			return f.requestIDs
		}
	}
	return nil
}

// transportMark is the activity as it stood when a call began.
type transportMark struct{ sent, writes, seq uint64 }

func markTransportActivity() transportMark {
	transportActivity.mu.Lock()
	defer transportActivity.mu.Unlock()
	return transportMark{sent: transportActivity.sent, writes: transportActivity.writes, seq: transportActivity.seq}
}

// since says what happened after the mark: whether anything was sent, whether a write went through, and
// the failures, newest first.
func (m transportMark) since() (sent, wrote bool, failures []error) {
	transportActivity.mu.Lock()
	defer transportActivity.mu.Unlock()
	for i := len(transportActivity.failures) - 1; i >= 0; i-- {
		if f := transportActivity.failures[i]; f.seq > m.seq {
			failures = append(failures, f.err)
		}
	}
	return transportActivity.sent > m.sent, transportActivity.writes > m.writes, failures
}

// ── the envelope ───────────────────────────────────────────────────────────

func recoveryReadableError(err error) bool {
	var httpErr *transportHTTPError
	var local *recoveryLocalError
	if errors.As(err, &httpErr) || errors.As(err, &local) {
		return true
	}
	return recoveryOf(err, false).Kind == "TRANSPORT"
}

// recoveryForFailure reads one failed call into the envelope. err is the error when the caller still has
// it (the CLI), text what the caller printed (both). The error is read when it carries what the contract
// reads; otherwise the newest failure sent since mark whose text the printed text contains is; otherwise,
// when nothing was sent at all, it is a local refusal (nothing can have been written); and otherwise the
// outcome is UNKNOWN. A write that went through earlier in the same call means the call as a whole did
// not leave stored state untouched, so an effect NONE becomes UNKNOWN and is verified before anything is
// sent again.
func recoveryForFailure(err error, text string, mark transportMark, requestIDSent bool) recoveryEnvelope {
	sent, wrote, failures := mark.since()
	var env recoveryEnvelope
	switch {
	case err != nil && recoveryReadableError(err):
		env = recoveryOf(err, requestIDSent)
	default:
		found := false
		for _, f := range failures {
			if msg := f.Error(); msg != "" && strings.Contains(text, msg) {
				env, found = recoveryOf(f, requestIDSent), true
				break
			}
		}
		if !found {
			if !sent {
				env = recoveryOf(&recoveryLocalError{code: recoveryLocalRefusedCode, message: text}, requestIDSent)
			} else {
				env = recoveryOf(errors.New(text), requestIDSent)
			}
		}
	}
	if wrote && env.Effect == "NONE" {
		env.Effect = "UNKNOWN"
		finishRecovery(&env, "", env.Retry.AfterSeconds, requestIDSent, false)
	}
	return env
}

// ── the next step ──────────────────────────────────────────────────────────

// recoverySurface is what one surface can really do: call a read-only tool on one resource, or make the
// same call again. Each answers false when this process does not expose it.
type recoverySurface interface {
	read(tool, idKey, id string) (recoveryNext, bool)
	again() (recoveryNext, bool)
}

// recoveryResourceID is an id that may be handed on as one argument: a single safe path segment that
// cannot be read as a flag.
func recoveryResourceID(id string) bool {
	return id != "" && !strings.HasPrefix(id, "-") && validatePathSegmentID(id) == nil
}

func recoveryStep(kind string, env recoveryEnvelope, reason string) recoveryNext {
	return recoveryNext{Type: kind, ActionCode: env.ActionCode, AfterSeconds: env.Retry.AfterSeconds, Reason: reason}
}

func recoveryInvoke(n recoveryNext, env recoveryEnvelope, reason string) recoveryNext {
	n.Type, n.ActionCode, n.AfterSeconds, n.Reason = recoveryNextInvoke, env.ActionCode, env.Retry.AfterSeconds, reason
	return n
}

// renderRecoveryNext maps the envelope's semantic actionCode onto surface. It never offers a step that
// writes past a required user confirmation, and never an invoke the surface cannot run.
func renderRecoveryNext(env recoveryEnvelope, surface recoverySurface, requestIDSent bool) recoveryNext {
	action := ""
	if env.ActionCode != nil {
		action = *env.ActionCode
	}
	confirm := env.UserConfirmation == "REQUIRED"
	switch action {
	case "RETRY", "RETRY_SAME_REQUEST":
		if confirm {
			return recoveryStep(recoveryNextAskUser, env, "A person has to confirm before this request can be sent again.")
		}
		if action == "RETRY_SAME_REQUEST" && !requestIDSent {
			return recoveryStep(recoveryNextManual, env, "Only a resend under the same request id is safe, and this call carried none: read the resource's state before deciding.")
		}
		if n, ok := surface.again(); ok {
			reason := "Send the identical request again."
			if action == "RETRY_SAME_REQUEST" {
				reason = "Send the identical request again under the same request id; the server answers it once."
			}
			if env.Retry.AfterSeconds != nil {
				reason += " Wait afterSeconds first."
			}
			return recoveryInvoke(n, env, reason)
		}
		if env.Retry.AfterSeconds != nil {
			return recoveryStep(recoveryNextWait, env, "Wait afterSeconds; this surface cannot make the same call again by itself.")
		}
		return recoveryStep(recoveryNextManual, env, "The request may be sent again, but this surface cannot make the same call by itself.")
	case "VERIFY_STATE":
		for _, r := range env.Resources {
			reader, ok := recoveryReaders[r.Type]
			if !ok || !recoveryResourceID(r.ID) {
				continue
			}
			if n, ok := surface.read(reader[0], reader[1], r.ID); ok {
				return recoveryInvoke(n, env, "The outcome is not known: read the "+strings.ToLower(r.Type)+" before sending anything again.")
			}
		}
		return recoveryStep(recoveryNextManual, env, "The outcome is not known and no reader for it is available here: check the state by hand before sending anything again.")
	case "AWAIT_OWNER_DECISION":
		return recoveryStep(recoveryNextAskUser, env, "The account owner has to decide; nothing is sent again until they have.")
	case "":
		switch {
		case confirm || env.Actor == "USER":
			return recoveryStep(recoveryNextAskUser, env, "A person has to act before this can change.")
		case env.Effect == "COMMITTED":
			return recoveryStep(recoveryNextManual, env, "The write went through; do not send it again.")
		case env.Actor == "SYSTEM" || env.Retry.AfterSeconds != nil:
			return recoveryStep(recoveryNextWait, env, "The same answer comes back until the state changes.")
		}
		return recoveryStep(recoveryNextManual, env, "The same answer comes back until something outside this request changes.")
	}
	if confirm {
		return recoveryStep(recoveryNextAskUser, env, "A person has to confirm before a changed request can pass.")
	}
	return recoveryStep(recoveryNextManual, env, "Change the request as the message says; it is not accepted as sent.")
}

// ── MCP ────────────────────────────────────────────────────────────────────

type mcpRecoverySurface struct {
	listed map[string]bool
	tool   string
	input  map[string]interface{}
}

func (m mcpRecoverySurface) read(tool, idKey, id string) (recoveryNext, bool) {
	if !m.listed[tool] {
		return recoveryNext{}, false
	}
	return recoveryNext{Tool: tool, Input: map[string]interface{}{idKey: id}}, true
}

func (m mcpRecoverySurface) again() (recoveryNext, bool) {
	if !m.listed[m.tool] {
		return recoveryNext{}, false
	}
	input := make(map[string]interface{}, len(m.input))
	for k, v := range m.input {
		input[k] = v
	}
	return recoveryNext{Tool: m.tool, Input: input}, true
}

func mcpRequestIDSent(args map[string]interface{}) bool {
	for _, pair := range recoveryRequestIDArgs {
		if s, _ := args[pair[0]].(string); strings.TrimSpace(s) != "" {
			return true
		}
	}
	return false
}

// listedToolDescriptors is what tools/list answers.
func (s *mcpServer) listedToolDescriptors() []map[string]interface{} {
	tools := toolDescriptors(s.allowPermissionPrompt, s.orchestrationEnabled())
	if s.watchesOff {
		tools = withoutWatchTools(tools)
	}
	if s.wikiOff {
		tools = withoutWikiTools(tools)
	}
	if s.onlyTools != nil {
		tools = onlyMCPTools(tools, s.onlyTools)
	}
	// An error is a valid structured result too. Advertise both shapes, so clients that
	// validate outputSchema also accept recovery reports without losing the success schema.
	for _, tool := range tools {
		if schema, ok := tool["outputSchema"]; ok {
			tool["outputSchema"] = map[string]interface{}{"type": "object", "anyOf": []interface{}{schema, recoveryReportSchema()}}
		}
	}
	return tools
}

func recoveryReportSchema() map[string]interface{} {
	return map[string]interface{}{
		"type": "object", "required": []string{"ok", "error", "next"},
		"properties": map[string]interface{}{
			"ok":    map[string]interface{}{"const": false},
			"error": map[string]interface{}{"type": "object", "required": []string{"code", "message", "effect", "retry", "actionCode", "actor", "userConfirmation", "resources"}},
			"next":  map[string]interface{}{"type": "object", "required": []string{"type", "actionCode", "afterSeconds", "reason"}},
		},
	}
}

// listedTools is what tools/list answers, by name.
func (s *mcpServer) listedTools() map[string]map[string]interface{} {
	tools := s.listedToolDescriptors()
	byName := make(map[string]map[string]interface{}, len(tools))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); name != "" {
			byName[name] = tool
		}
	}
	return byName
}

// withRecovery preserves the legacy text and isError and adds the shared structured report.
// Schema-declared tools advertise a union of their success and recovery report shapes.
func (s *mcpServer) withRecovery(name string, args map[string]interface{}, mark transportMark, result map[string]interface{}) map[string]interface{} {
	if isErr, _ := result["isError"].(bool); !isErr {
		return result
	}
	if _, has := result["structuredContent"]; has {
		return result
	}
	content, _ := result["content"].([]map[string]interface{})
	if len(content) == 0 {
		return result
	}
	text, _ := content[0]["text"].(string)
	ids := mark.failedRequestIDs(nil, text)
	requestIDSent := len(ids) > 0
	env := recoveryForFailure(nil, text, mark, requestIDSent)
	listed := s.listedTools()
	names := make(map[string]bool, len(listed))
	for n := range listed {
		names[n] = true
	}
	if env.ActionCode != nil && *env.ActionCode == "RETRY_SAME_REQUEST" {
		for key, id := range ids {
			if args[key] != id {
				names[name] = false
			}
		}
	}
	report := recoveryReport{OK: false, Error: env, Next: renderRecoveryNext(env, mcpRecoverySurface{listed: names, tool: name, input: args}, requestIDSent)}
	result["structuredContent"] = report
	return result
}

// ── CLI ────────────────────────────────────────────────────────────────────

// cliStdinRecorder keeps what a command read from its standard input, so that the same command can be
// offered again with the same bytes. Past maxRecordedStdin it stops keeping and the command is no longer
// offered again.
type cliStdinRecorder struct {
	r        io.Reader
	data     []byte
	overflow bool
}

const maxRecordedStdin = 256 << 10

func (c *cliStdinRecorder) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 && !c.overflow {
		if len(c.data)+n > maxRecordedStdin {
			c.overflow, c.data = true, nil
		} else {
			c.data = append(c.data, p[:n]...)
		}
	}
	return n, err
}

type cliRecoverySurface struct {
	executable   string
	capabilities []cliCapability
	argv         []string // the command's arguments after the executable
	stdin        []byte
	replayStdin  bool // false when stdin may hold a credential, overflowed, or is not text
}

func (c cliRecoverySurface) capability(id string) (cliCapability, bool) {
	for _, cap := range c.capabilities {
		if cap.ID == id && cap.Available {
			return cap, true
		}
	}
	return cliCapability{}, false
}

func (c cliRecoverySurface) read(tool, idKey, id string) (recoveryNext, bool) {
	cap, ok := c.capability(tool)
	if !ok || len(cap.Argv) == 0 {
		return recoveryNext{}, false
	}
	argv := append(append([]string{}, cap.Argv...), id, "--json")
	return recoveryNext{Argv: argv}, true
}

func (c cliRecoverySurface) again() (recoveryNext, bool) {
	if c.executable == "" || !c.replayStdin {
		return recoveryNext{}, false
	}
	// Only a command this process advertises as available is offered again.
	matched := false
	for _, cap := range c.capabilities {
		if !cap.Available || len(cap.Argv) < 2 || len(cap.Argv)-1 > len(c.argv) {
			continue
		}
		prefix := true
		for i, word := range cap.Argv[1:] {
			if c.argv[i] != word {
				prefix = false
				break
			}
		}
		if prefix {
			matched = true
			break
		}
	}
	if !matched {
		return recoveryNext{}, false
	}
	n := recoveryNext{Argv: append([]string{c.executable}, c.argv...)}
	if len(c.stdin) > 0 {
		s := string(c.stdin)
		n.Stdin = &s
	}
	return n, true
}

// The CLI's registered capability signatures describe option value boundaries. Resolve the
// longest command prefix, including gated commands: authorization can fail before leaf parsing.
// Unknown options are errors rather than string options and do not consume a following flag.
var recoveryCLIOption = regexp.MustCompile(`--?[A-Za-z][A-Za-z0-9-]*`)

// These local utilities deliberately are not agent capabilities, but still accept JSON.
var recoveryUtilityCLI = []cliCapabilitySpec{
	{Argv: []string{"orbit", "capabilities"}, Arguments: []string{"--json"}},
	{Argv: []string{"orbit", "token", "list"}, Arguments: []string{"--json"}},
	{Argv: []string{"orbit", "token", "revoke"}, Arguments: []string{"[token-id]", "--json"}},
	{Argv: []string{"orbit", "token", "mint"}, Arguments: []string{"--scope <scope>", "--workspace-id <id>", "--agent-id <id>", "--label <text>", "--ttl <duration>", "--json"}},
}

func recoveryCLISpecGroups() [][]cliCapabilitySpec {
	return [][]cliCapabilitySpec{baseCLICapabilities, projectCLICapabilities, sessionCLICapabilities, agentCLICapabilities, runnerCLICapabilities, providerCLICapabilities, notifyCLICapabilities, watchCLICapabilities, wikiCLICapabilities, wikiImportCLICapabilities, fileCLICapabilities, userCLICapabilities, mergeReceiptCLICapabilities, recoveryUtilityCLI}
}

func recoveryCLIOptions(argv []string) (map[string]bool, int, int) {
	var selected *cliCapabilitySpec

	for _, group := range recoveryCLISpecGroups() {
		for i := range group {
			spec := &group[i]
			n := len(spec.Argv) - 1
			if n < 1 || n > len(argv) || (selected != nil && n <= len(selected.Argv)-1) {
				continue
			}
			match := true
			for j, word := range spec.Argv[1:] {
				if argv[j] != word {
					match = false
					break
				}
			}
			if match {
				selected = spec
			}
		}
	}
	options := map[string]bool{}
	if selected == nil {
		return options, len(argv), 0
	}
	positional := 0
	for _, arg := range selected.Arguments {
		if strings.HasPrefix(arg, "[") {
			positional++
		}
		arg = strings.SplitN(arg, " (", 2)[0]
		matches := recoveryCLIOption.FindAllStringIndex(arg, -1)
		for _, span := range matches {
			name := strings.TrimLeft(arg[span[0]:span[1]], "-")
			tail := arg[span[1]:]
			// A bare flag, a parenthesized description or [=true|false] takes no next token.
			boolean := tail == "" || strings.HasPrefix(tail, " (") || strings.HasPrefix(tail, "[=") || strings.HasPrefix(tail, " | --")
			options[name] = boolean
		}
	}
	// These commands peel every leading word, rather than one ID per slot.
	if selected.Tool == "wiki_search" || selected.Tool == "wiki_get" || selected.Tool == "wiki_note" {
		positional = -1
	}
	return options, len(selected.Argv) - 1, positional
}

func recoveryCLIValues(argv []string) map[string]string {
	options, start, positional := recoveryCLIOptions(argv)
	values := map[string]string{}
	for n := 0; (positional < 0 || n < positional) && start < len(argv) && (!strings.HasPrefix(argv[start], "-") || (positional < 0 && argv[start] == "-")); n++ {
		start++
	}
	for i := start; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			if len(argv) > 0 && (argv[0] == "api" || argv[0] == "file") {
				continue
			}
			break
		}
		name, value, equals := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		boolean, known := options[name]
		if !known {
			continue
		}
		if boolean {
			if !equals {
				value = "true"
			}
			parsed, err := strconv.ParseBool(value)
			if err != nil {
				continue
			}
			values[name] = strconv.FormatBool(parsed)
		} else {
			if !equals {
				if i+1 >= len(argv) {
					break
				}
				i++
				value = argv[i]
			}
			values[name] = value
		}
	}
	return values
}

func cliJSONRequested(argv []string) bool { return recoveryCLIValues(argv)["json"] == "true" }

// cliFailureReport is the report of a failed CLI command. argv is the command's arguments after the
// executable; text is the line a person would have read.
func cliFailureReport(err error, text string, mark transportMark, argv []string, stdin *cliStdinRecorder, replayStdin bool, capabilities []cliCapability, executable string) recoveryReport {
	ids := mark.failedRequestIDs(err)
	requestIDSent := len(ids) > 0
	env := recoveryForFailure(err, text, mark, requestIDSent)
	// A generated outbound ID still protects the write, but rerunning an argv that
	// does not carry that same ID would generate another one. Leave that replay manual.
	parsed := recoveryCLIValues(argv)
	for _, pair := range recoveryRequestIDArgs {
		if id := ids[pair[0]]; id != "" && parsed[strings.TrimPrefix(pair[1], "--")] != id {
			replayStdin = false
		}
	}
	surface := cliRecoverySurface{executable: executable, capabilities: capabilities, argv: argv, replayStdin: replayStdin}
	if stdin != nil {
		if stdin.overflow || !utf8.Valid(stdin.data) {
			surface.replayStdin = false
		}
		surface.stdin = stdin.data
	}
	return recoveryReport{OK: false, Error: env, Next: renderRecoveryNext(env, surface, requestIDSent), Text: text}
}

// writeCLIFailure prints a failed command's outcome: under --json the report as one JSON document on
// out (stdout), otherwise the legacy "orbit <cmd>: <error>" line on errOut, exactly as before.
func writeCLIFailure(prefix string, err error, mark transportMark, argv []string, stdin *cliStdinRecorder, replayStdin bool, out, errOut io.Writer) {
	text := prefix + ": " + err.Error()
	if !cliJSONRequested(argv) {
		_, _ = io.WriteString(errOut, text+"\n")
		return
	}
	executable := orbitCLIExecutable()
	var capabilities []cliCapability
	if executable != "" {
		capabilities = buildCLICapabilities(executable).Capabilities
	}
	report := cliFailureReport(err, text, mark, argv, stdin, replayStdin, capabilities, executable)
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	if enc.Encode(report) != nil {
		_, _ = io.WriteString(errOut, text+"\n")
	}
}

// runCLICommand runs one `orbit <command>` and, when it fails, reports the failure (writeCLIFailure) and
// exits 1. replayStdin is false for a command whose stdin may hold a credential: it is never repeated
// back, so such a command is not offered again with it.
func runCLICommand(prefix string, argv []string, replayStdin bool, run func(in io.Reader) error) {
	mark := markTransportActivity()
	stdin := &cliStdinRecorder{r: os.Stdin}
	stdout := os.Stdout
	var spool *os.File
	var err error
	// Spool JSON-mode output until the whole command succeeds. This preserves successful
	// NDJSON/paginated output while discarding partial pages if a later request fails.
	if cliJSONRequested(argv) {
		spool, err = os.CreateTemp("", "orbit-cli-output-*")
		if err == nil {
			os.Stdout = spool
		}
	}
	if err == nil {
		err = run(stdin)
	}
	os.Stdout = stdout
	if spool != nil {
		if err == nil {
			if _, err = spool.Seek(0, io.SeekStart); err == nil {
				_, err = io.Copy(stdout, spool)
			}
		}
		_ = spool.Close()
		_ = os.Remove(spool.Name())
	}
	if err != nil {
		writeCLIFailure(prefix, err, mark, argv, stdin, replayStdin, stdout, os.Stderr)
		os.Exit(1)
	}
}
