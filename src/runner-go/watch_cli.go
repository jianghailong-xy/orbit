package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// `orbit watch`, `orbit task await` and `orbit session await`: the CLI half of the watch tools
// (watch_tools.go), for shell composition inside a session. Like the MCP tools they act for the session
// they run in: a watch wakes that session, so a terminal outside one has nothing to act for.

const watchHelp = `orbit watch — wait on Orbit tasks and sessions without polling

Usage:
  orbit watch create --target KIND:ID [--target KIND:ID ...] (--predicate JSON | --predicate-file -) [options]
  orbit watch get WATCH_ID [--json]
  orbit watch list [--state STATE] [--json]
  orbit watch update WATCH_ID [--predicate JSON | --predicate-file -] [--ttl-seconds N] [--json]
  orbit watch cancel WATCH_ID [--json]

The common waits have their own commands:
  orbit task await --task-id ID[,ID...] [--until PRESET]
  orbit session await --session-id ID[,ID...] [--until PRESET]

A watch is held by Orbit's server, not by this process: it outlives this command, this shell
and the engine that ran it. When its condition holds, Orbit starts a turn in the session the
command ran in (ORBIT_SESSION_ID) saying what changed. So make a watch and end the turn; do
not wrap 'orbit task get' or 'orbit session get' in a sleep loop. Watches are made and read
from inside a session only.
Run 'orbit watch <command> --help' for options.
`

var watchActionHelp = map[string]string{
	"create": `orbit watch create — watch tasks or sessions and be woken when a condition holds

Usage:
  orbit watch create --target KIND:ID [--target KIND:ID ...] (--predicate JSON | --predicate-file -) [options]

Options:
  --target KIND:ID         A task or session to watch, as TASK:<id> or SESSION:<id>. Repeatable;
                           the set is fixed when the watch is made
  --predicate JSON         The condition in the v1 grammar: {"kind":"ALL"|"ANY","over":"ALL_TARGETS",
                           "leaf":LEAF} or {"kind":"ALL_OF"|"ANY_OF","operands":[...]}. Leaves:
                           TASK_TERMINAL, TASK_FAILED, TASK_DONE, SESSION_TURN_SETTLED,
                           SESSION_RUN_TERMINAL, SESSION_LIFECYCLE_TERMINAL, SESSION_NEEDS_ATTENTION
  --predicate-file -       Read the predicate from stdin; filesystem paths are rejected
  --predicate-version N    The grammar version (default 1)
  --action ACTION          RESUME_SESSION (default) starts a turn in this session when it holds;
                           NOTIFY_USER notifies the person instead
  --ttl-seconds N          How long it may wait: 60 to 2592000 (default 86400). If it runs out
                           first, the session is woken once with EXPIRED
  --idempotency-key KEY    Reuse it to retry a create whose answer you never saw
  --json

Watching sessions needs the orchestration grant reading them needs. A cancelled watch wakes
nobody; one that expires, is revoked or can no longer be decided wakes the session once.
`,
	"get": `orbit watch get — read one of this session's watches in full

Usage:
  orbit watch get WATCH_ID [--json]

Shows the watch's state, each target as last evaluated, every Match with its snapshot, and
whether each wake or notification was delivered.
`,
	"list": `orbit watch list — list this session's watches

Usage:
  orbit watch list [--state ACTIVE|PAUSED|MATCHED|EXPIRED|CANCELLED|REVOKED|UNRESOLVABLE] [--json]

Newest first, at most 100.
`,
	"update": `orbit watch update — change a live watch's condition or deadline

Usage:
  orbit watch update WATCH_ID [--predicate JSON | --predicate-file -] [--predicate-version N] [--ttl-seconds N] [--json]

Only an ACTIVE or PAUSED watch can be edited, and only its predicate and its deadline: its
targets and action stay as created. --ttl-seconds counts from now.
`,
	"cancel": `orbit watch cancel — cancel one of this session's watches

Usage:
  orbit watch cancel WATCH_ID [--json]

A cancelled watch wakes nobody. A watch that already matched or ended cannot be cancelled.
`,
}

var taskAwaitHelp = awaitHelp("orbit task await", "tasks finish", "task-id", "tasks", taskAwaitPresets)

var sessionAwaitHelp = awaitHelp("orbit session await", "sessions settle, need a person or end", "session-id", "sessions", sessionAwaitPresets)

func awaitHelp(command, when, idFlag, noun string, presets []watchAwaitPreset) string {
	var until strings.Builder
	for _, preset := range presets {
		fmt.Fprintf(&until, "\n                             %s: %s", preset.until, preset.description)
	}
	return fmt.Sprintf(`%[1]s — be woken when %[2]s

Usage:
  %[1]s --%[3]s ID[,ID...] [--until PRESET] [--ttl-seconds N] [--idempotency-key KEY] [--json]

Asks Orbit's server to watch exactly these %[4]s and to start a turn in this session
(ORBIT_SESSION_ID) when the condition holds, then returns at once: end the turn instead of
polling. If the watch expires first, the session is woken once with EXPIRED.

Options:
  --%[3]s ID[,ID...]      The %[4]s to wait for; repeatable
  --until PRESET           What to wait for (default %[5]s):%[6]s
  --ttl-seconds N          How long to wait at most: 60 to 2592000 (default 86400)
  --idempotency-key KEY    Reuse it to retry a call whose answer you never saw
  --json
`, command, when, idFlag, noun, presets[0].until, until.String())
}

// watchCLICapabilities are listed inside a session only (SessionOnly). session_await is not here: it sits
// with the session commands, behind the orchestration gate session_get is behind.
var watchCLICapabilities = []cliCapabilitySpec{
	{Tool: "watch_create", Argv: []string{"orbit", "watch", "create"}, Usage: "orbit watch create --target KIND:ID [--target KIND:ID ...] (--predicate JSON | --predicate-file -) [options]", Arguments: []string{"--target <TASK|SESSION>:<id> (targets; repeatable, at least one)", "--predicate <json> | --predicate-file - (required; the v1 grammar)", "--predicate-version <n> (predicateVersion; default 1)", "--action <RESUME_SESSION|NOTIFY_USER> (default RESUME_SESSION)", "--ttl-seconds <n> (60-2592000; default 86400)", "--idempotency-key <key>", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "watch_get", Argv: []string{"orbit", "watch", "get"}, Usage: "orbit watch get WATCH_ID [--json]", Arguments: []string{"[watch-id] (required)", "--json"}, SessionOnly: true},
	{Tool: "watch_list", Argv: []string{"orbit", "watch", "list"}, Usage: "orbit watch list [--state STATE] [--json]", Arguments: []string{"--state <" + strings.Join(watchStates, "|") + ">", "--json"}, SessionOnly: true},
	{Tool: "watch_update", Argv: []string{"orbit", "watch", "update"}, Usage: "orbit watch update WATCH_ID [--predicate JSON | --predicate-file -] [--ttl-seconds N] [--json]", Arguments: []string{"[watch-id] (required)", "--predicate <json> | --predicate-file -", "--predicate-version <n> (predicateVersion; default 1)", "--ttl-seconds <n> (60-2592000, counted from now)", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "watch_cancel", Argv: []string{"orbit", "watch", "cancel"}, Usage: "orbit watch cancel WATCH_ID [--json]", Arguments: []string{"[watch-id] (required)", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "task_await", Argv: []string{"orbit", "task", "await"}, Usage: "orbit task await --task-id ID[,ID...] [--until PRESET] [--ttl-seconds N] [--idempotency-key KEY] [--json]", Arguments: awaitCLIArguments("task-id", "taskIds", taskAwaitPresets), Mutates: true, SessionOnly: true},
}

func awaitCLIArguments(idFlag, param string, presets []watchAwaitPreset) []string {
	return []string{
		"--" + idFlag + " <id[,id...]> (" + param + "; repeatable, required)",
		"--until <" + strings.Join(awaitPresetNames(presets), "|") + "> (default " + presets[0].until + ")",
		"--ttl-seconds <n> (60-2592000; default 86400)",
		"--idempotency-key <key>",
		"--json",
	}
}

// watchCLIContext is the session a watch command acts for. There is no headless form: a watch wakes the
// session that makes it and is read back only by that session.
func watchCLIContext(command string) (cliOrchestrationContext, error) {
	id := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if id == "" {
		return cliOrchestrationContext{}, fmt.Errorf(
			"%s acts for the Orbit session it runs in (ORBIT_SESSION_ID), and there is none here: a watch wakes the session "+
				"that makes it. Run it from inside a session, or follow the work in the Orbit app", command)
	}
	if err := validatePathSegmentID(id); err != nil {
		return cliOrchestrationContext{}, fmt.Errorf("ORBIT_SESSION_ID %w", err)
	}
	return cliOrchestrationContext{sessionID: id, token: strings.TrimSpace(os.Getenv(envOrchestrationToken))}, nil
}

func cmdWatchCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, watchHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, watchHelp)
			return err
		}
		h, ok := watchActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := watchActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, watchHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	ctx, err := watchCLIContext("orbit watch " + action)
	if err != nil {
		return err
	}
	switch action {
	case "create":
		return cliWatchCreate(args[1:], in, out, ctx)
	case "get", "cancel":
		return cliWatchByID(action, args[1:], out, ctx)
	case "list":
		return cliWatchList(args[1:], out, ctx)
	case "update":
		return cliWatchUpdate(args[1:], in, out, ctx)
	default:
		panic("unreachable watch command")
	}
}

func cliWatchCreate(args []string, in io.Reader, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit watch create")
	var targets stringList
	fs.Var(&targets, "target", "a task or session to watch, as TASK:<id> or SESSION:<id> (repeatable)")
	predicate := fs.String("predicate", "", "the condition, as v1 predicate JSON")
	predicateFile := fs.String("predicate-file", "", "read the predicate from stdin (-)")
	predicateVersion := fs.Int("predicate-version", watchPredicateVersion, "the predicate grammar version")
	action := fs.String("action", "", "RESUME_SESSION or NOTIFY_USER")
	ttl := fs.Int("ttl-seconds", 0, "how long the watch may wait")
	key := fs.String("idempotency-key", "", "retry key")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	refs, err := parseWatchTargetFlags(targets)
	if err != nil {
		return err
	}
	parsed, set, err := readWatchPredicateFlags(in, fs, *predicate, *predicateFile)
	if err != nil {
		return err
	}
	if !set {
		return fmt.Errorf("--predicate or --predicate-file - is required")
	}
	body := map[string]interface{}{"predicateVersion": *predicateVersion, "predicate": parsed, "targets": refs}
	if flagWasSet(fs, "action") {
		body["action"] = strings.ToUpper(strings.TrimSpace(*action))
	}
	if flagWasSet(fs, "ttl-seconds") {
		if err := checkWatchTTLFlag(*ttl); err != nil {
			return err
		}
		body["ttlSeconds"] = *ttl
	}
	if k := strings.TrimSpace(*key); k != "" {
		body["idempotencyKey"] = k
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.createWatch(ctx.sessionID, ctx.token, body)
	if err != nil {
		return watchCallError("create watch", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliWatchByID(action string, args []string, out io.Writer, ctx cliOrchestrationContext) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit watch " + action)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveWatchCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if action == "cancel" {
		raw, err = t.cancelWatch(ctx.sessionID, ctx.token, id)
	} else {
		raw, err = t.getWatch(ctx.sessionID, ctx.token, id)
	}
	if err != nil {
		return watchCallError(action+" watch", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliWatchList(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit watch list")
	state := fs.String("state", "", "only watches in this state")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	want := strings.ToUpper(strings.TrimSpace(*state))
	if flagWasSet(fs, "state") && !contains(watchStates, want) {
		return fmt.Errorf("--state must be one of %s", strings.Join(watchStates, ", "))
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listWatches(ctx.sessionID, ctx.token, want)
	if err != nil {
		return watchCallError("list watches", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliWatchUpdate(args []string, in io.Reader, out io.Writer, ctx cliOrchestrationContext) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit watch update")
	predicate := fs.String("predicate", "", "the new condition, as v1 predicate JSON")
	predicateFile := fs.String("predicate-file", "", "read the predicate from stdin (-)")
	predicateVersion := fs.Int("predicate-version", watchPredicateVersion, "the predicate grammar version")
	ttl := fs.Int("ttl-seconds", 0, "the new deadline, counted from now")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveWatchCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	body := map[string]interface{}{}
	parsed, set, err := readWatchPredicateFlags(in, fs, *predicate, *predicateFile)
	if err != nil {
		return err
	}
	if set {
		body["predicate"] = parsed
		body["predicateVersion"] = *predicateVersion
	}
	if flagWasSet(fs, "ttl-seconds") {
		if err := checkWatchTTLFlag(*ttl); err != nil {
			return err
		}
		body["ttlSeconds"] = *ttl
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --predicate, --ttl-seconds, or both")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.updateWatch(ctx.sessionID, ctx.token, id, body)
	if err != nil {
		return watchCallError("update watch", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskAwait is `orbit task await`, the CLI half of task_await.
func cliTaskAwait(args []string, out io.Writer) error {
	ctx, err := watchCLIContext("orbit task await")
	if err != nil {
		return err
	}
	return cliAwait("orbit task await", "task-id", "TASK", taskAwaitPresets, args, out, ctx)
}

// cliSessionAwait is `orbit session await`. cmdSessionCLI has already resolved the orchestration context
// session_await needs, which has no headless form.
func cliSessionAwait(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	return cliAwait("orbit session await", "session-id", "SESSION", sessionAwaitPresets, args, out, ctx)
}

func cliAwait(command, idFlag, kind string, presets []watchAwaitPreset, args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet(command)
	var ids csvFlag
	fs.Var(&ids, idFlag, "ids to wait for (comma-separated, repeatable)")
	until := fs.String("until", "", "what to wait for")
	ttl := fs.Int("ttl-seconds", 0, "how long to wait at most")
	key := fs.String("idempotency-key", "", "retry key")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	unique := uniqueStrings(ids)
	if len(unique) == 0 {
		return fmt.Errorf("--%s is required: the ids to wait for", idFlag)
	}
	preset, err := awaitPreset(presets, *until)
	if err != nil {
		return fmt.Errorf("--%w", err)
	}
	ttlSeconds := 0
	if flagWasSet(fs, "ttl-seconds") {
		if err := checkWatchTTLFlag(*ttl); err != nil {
			return err
		}
		ttlSeconds = *ttl
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.createWatch(ctx.sessionID, ctx.token, awaitWatchBody(kind, unique, preset, ttlSeconds, strings.TrimSpace(*key)))
	if err != nil {
		return watchCallError(strings.TrimPrefix(command, "orbit "), err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func parseWatchTargetFlags(values []string) ([]watchTargetRef, error) {
	if len(values) == 0 {
		return nil, fmt.Errorf("--target is required: TASK:<id> or SESSION:<id>, repeatable")
	}
	refs := make([]watchTargetRef, 0, len(values))
	for _, value := range values {
		kind, id, ok := strings.Cut(value, ":")
		kind, id = strings.ToUpper(strings.TrimSpace(kind)), strings.TrimSpace(id)
		if !ok || kind == "" || id == "" {
			return nil, fmt.Errorf("--target %q is not KIND:ID (TASK:<id> or SESSION:<id>)", value)
		}
		refs = append(refs, watchTargetRef{Kind: kind, ID: id})
	}
	return refs, nil
}

// readWatchPredicateFlags reads --predicate or --predicate-file -, and reports whether either was given.
func readWatchPredicateFlags(in io.Reader, fs *flag.FlagSet, direct, file string) (map[string]interface{}, bool, error) {
	text, set, err := readCLIText(in, direct, flagWasSet(fs, "predicate"), file, flagWasSet(fs, "predicate-file"), "predicate")
	if err != nil || !set {
		return nil, false, err
	}
	predicate, err := parseWatchPredicateJSON(text)
	if err != nil {
		return nil, false, fmt.Errorf("--%w", err)
	}
	return predicate, true, nil
}

func checkWatchTTLFlag(ttl int) error {
	if checkWatchTTL(ttl) != nil {
		return fmt.Errorf("--ttl-seconds must be a whole number of seconds from %d to %d", watchMinTTLSeconds, watchMaxTTLSeconds)
	}
	return nil
}

func resolveWatchCLIId(leading string, trailing []string) (string, error) {
	if leading != "" && len(trailing) > 0 {
		return "", fmt.Errorf("unexpected arguments: %s", strings.Join(trailing, " "))
	}
	if leading == "" {
		if len(trailing) > 1 {
			return "", fmt.Errorf("expected one watch id, got: %s", strings.Join(trailing, " "))
		}
		if len(trailing) == 1 {
			leading = trailing[0]
		}
	}
	if leading == "" {
		return "", fmt.Errorf("watch id is required")
	}
	if err := validatePathSegmentID(leading); err != nil {
		return "", fmt.Errorf("watch %w", err)
	}
	return leading, nil
}
