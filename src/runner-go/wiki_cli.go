package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// `orbit wiki search|get|propose`: the CLI half of the wiki tools (wiki_tools.go), for shell
// composition inside a session. Like the MCP tools they act for the session they run in — what a
// session may read is what its bound workspace shares, and a proposal is recorded against it — so
// there is no headless form: at a terminal outside a session there is nowhere to read from and
// nobody to propose as.

const wikiHelp = `orbit wiki — read the Orbit wiki and propose to it

Usage:
  orbit wiki search <query> [--kind KIND]... [--topic SLUG] [--path PATH]... [--limit N] [--json]
  orbit wiki get <id>[,<id>...] [--include WHAT]... [--json]
  orbit wiki propose (--ops JSON | --ops-file -) [--rationale TEXT | --rationale-file -]
                     [--idempotency-key KEY] [--dry-run] [--json]

The wiki is this codebase's own knowledge: decisions and what they rejected, pitfalls and their
fixes, conventions, recipes. You READ it and you PROPOSE to it; you never decide. An agent's write
is a proposal that waits for the owner in Review, so never report one as saved.

These commands act for the session they run in (ORBIT_SESSION_ID): what it may read is what that
session's workspace is bound to, and its proposal is recorded against it.
Run 'orbit wiki <command> --help' for options.
`

var wikiActionHelp = map[string]string{
	"search": `orbit wiki search — what the wiki already knows about this codebase

Usage:
  orbit wiki search <query> [--kind KIND]... [--topic SLUG] [--path PATH]... [--limit N] [--json]

Options:
  [query]                  The first argument: the words to look for, or one repo-relative path.
                           Required for words; a path goes to the path leg
  --kind KIND              Only entries of this kind: ` + strings.Join(wikiEntryKinds, ", ") + `. Repeatable
  --topic SLUG             Only entries filed under this topic slug
  --path PATH              A repo-relative path: entries anchored or triggered under it are
                           recalled by the path leg whether or not the query names it. Repeatable
  --limit N                How many entries to return at most, 1 to 10
  --json

Search before proposing: a near neighbour is better reinforced than duplicated, and a proposal's
answer names what it resembles.
`,
	"get": `orbit wiki get — read whole entries, with their sources and anchors

Usage:
  orbit wiki get <id>[,<id>...] [--include WHAT]... [--json]

Options:
  [ids]                    1 to 10 entry ids, comma-separated or repeated. Required
  --include WHAT           What each entry carries: sources (the records it came from, and the
                           default), anchors (always carried), history (every revision, with the
                           sources too), or none for the entry alone. Repeatable
  --json

An id this session may not read is reported beside the ones that were. Read the sources before
relying on an entry: a claim whose sources you cannot open is a claim you cannot check.
`,
	"propose": `orbit wiki propose — propose what this session learned, for the owner's review

Usage:
  orbit wiki propose (--ops JSON | --ops-file -) [--rationale TEXT | --rationale-file -]
                     [--idempotency-key KEY] [--dry-run] [--json]

Options:
  --ops JSON               The ops, as a JSON array, or as a whole {"ops":[...],"rationale":"...",
                           "idempotencyKey":"..."} body
  --ops-file -             Read the ops from stdin (the design's --file ops.json, by another name)
  --rationale TEXT         Why this batch is worth recording; required
  --rationale-file -       Read the rationale from stdin
  --idempotency-key KEY    Required: the same key with the same request returns the recorded answer,
                           so a retry after an answer you never saw proposes nothing twice
  --dry-run                Check every op and answer as the request would, recording nothing
  --json

An op is one of add / reinforce / amend / supersede / retire / challenge, and cites the records it
came from. Record only what someone could not read from the code; a claim you cannot cite is not
ready. What this writes waits for the owner — do not tell the user it is saved.
`,
}

// wikiCLICapabilities are listed inside a session only (SessionOnly): every one of them reads or
// proposes as the session it runs in, and a terminal outside one has nothing to act for.
var wikiCLICapabilities = []cliCapabilitySpec{
	{
		Tool:  "wiki_search",
		Argv:  []string{"orbit", "wiki", "search"},
		Usage: "orbit wiki search <query> [--kind KIND]... [--topic SLUG] [--path PATH]... [--limit N] [--json]",
		Arguments: []string{
			"[query] (required; the words to look for, or one repo-relative path)",
			"--kind <" + strings.Join(wikiEntryKinds, "|") + "> (kinds; repeatable)",
			"--topic <slug>",
			"--path <repo-relative path> (paths; repeatable)",
			"--limit <n> (1-" + fmt.Sprint(wikiSearchLimitMax) + ")",
			"--json",
		},
		SessionOnly: true,
	},
	{
		Tool:  "wiki_get",
		Argv:  []string{"orbit", "wiki", "get"},
		Usage: "orbit wiki get <id>[,<id>...] [--include WHAT]... [--json]",
		Arguments: []string{
			"[ids] (required; 1 to " + fmt.Sprint(wikiGetIDsMax) + " entry ids, comma-separated or repeated)",
			"--include <" + strings.Join(append(append([]string{}, wikiIncludes...), "none"), "|") + "> (repeatable; default sources)",
			"--json",
		},
		SessionOnly: true,
	},
	{
		Tool:  "wiki_propose",
		Argv:  []string{"orbit", "wiki", "propose"},
		Usage: "orbit wiki propose (--ops JSON | --ops-file -) [--rationale TEXT | --rationale-file -] [--idempotency-key KEY] [--dry-run] [--json]",
		Arguments: []string{
			`--ops <json> | --ops-file - (required; the ops array, or a whole {"ops":...} body)`,
			"--rationale <text> | --rationale-file - (required)",
			"--idempotency-key <key> (required)",
			"--dry-run (dryRun)",
			"--json",
		},
		Mutates:     true,
		SessionOnly: true,
	},
}

// wikiCLIContext is the session a wiki command acts for. There is no headless form, and no
// orchestration token: the runner door authenticates the machine and reads the session header, and
// what that session may read is what its bound workspace shares.
func wikiCLIContext(command string) (cliOrchestrationContext, error) {
	id := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if id == "" {
		return cliOrchestrationContext{}, fmt.Errorf(
			"%s acts for the Orbit session it runs in (ORBIT_SESSION_ID), and there is none here: what it may read "+
				"is what that session's workspace is bound to, and its proposal is recorded against that session. Run "+
				"it from inside a session, or read the wiki in the Orbit app", command)
	}
	if err := validatePathSegmentID(id); err != nil {
		return cliOrchestrationContext{}, fmt.Errorf("ORBIT_SESSION_ID %w", err)
	}
	if !wikiEnabledFromEnv() {
		return cliOrchestrationContext{}, fmt.Errorf("%s", wikiOffMessage(command))
	}
	return cliOrchestrationContext{sessionID: id}, nil
}

func cmdWikiCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, wikiHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, wikiHelp)
			return err
		}
		h, ok := wikiActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := wikiActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, wikiHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	ctx, err := wikiCLIContext("orbit wiki " + action)
	if err != nil {
		return err
	}
	switch action {
	case "search":
		return cliWikiSearch(args[1:], out, ctx)
	case "get":
		return cliWikiGet(args[1:], out, ctx)
	case "propose":
		return cliWikiPropose(args[1:], in, out, ctx)
	default:
		panic("unreachable wiki command")
	}
}

func cliWikiSearch(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki search")
	var kinds, paths stringList
	fs.Var(&kinds, "kind", "only entries of this kind")
	fs.Var(&paths, "path", "a repo-relative path to recall by")
	topic := fs.String("topic", "", "only entries filed under this topic slug")
	limit := fs.Int("limit", 0, "how many entries to return at most")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	// The query comes first in the usage line and the flags may follow it: Go's flag package stops
	// at the first argument that is not a flag, so the words in front of the flags are taken off
	// before it parses rather than after.
	words, rest := peelLeadingPositionals(args)
	if err := fs.Parse(rest); err != nil {
		return err
	}
	// Copied rather than appended onto `words`: that slice still shares its array with the flags
	// this command parsed out of the same argument list.
	toolArgs, err := wikiSearchToolArgs(append(append([]string{}, words...), fs.Args()...), kinds, *topic, paths, *limit, flagWasSet(fs, "limit"))
	if err != nil {
		return err
	}
	return runWikiCLIAnswer("wiki_search", toolArgs, out, *jsonOut, ctx)
}

func cliWikiGet(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki get")
	var include stringList
	fs.Var(&include, "include", "what each entry carries: sources, anchors, history or none")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	ids, rest := peelLeadingPositionals(args)
	if err := fs.Parse(rest); err != nil {
		return err
	}
	toolArgs, err := wikiGetToolArgs(append(append([]string{}, ids...), fs.Args()...), include)
	if err != nil {
		return err
	}
	return runWikiCLIAnswer("wiki_get", toolArgs, out, *jsonOut, ctx)
}

// peelLeadingPositionals takes the arguments in front of the first flag. Go's flag package stops
// parsing at the first of them, so without this `orbit wiki search trgm index --kind decision` reads
// its own flags as more words.
func peelLeadingPositionals(args []string) ([]string, []string) {
	for i, arg := range args {
		if strings.HasPrefix(arg, "-") && arg != "-" {
			return args[:i], args[i:]
		}
	}
	return args, nil
}

func cliWikiPropose(args []string, in io.Reader, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki propose")
	ops := fs.String("ops", "", "the ops, as a JSON array or a whole propose body")
	opsFile := fs.String("ops-file", "", "read the ops from stdin (-)")
	rationale := fs.String("rationale", "", "why this batch is worth recording")
	rationaleFile := fs.String("rationale-file", "", "read the rationale from stdin (-)")
	key := fs.String("idempotency-key", "", "the retry key")
	dryRun := fs.Bool("dry-run", false, "check every op and record nothing")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	toolArgs, err := wikiProposeToolArgs(in, fs, *ops, *opsFile, *rationale, *rationaleFile, *key, *dryRun)
	if err != nil {
		return err
	}
	return runWikiCLIAnswer("wiki_propose", toolArgs, out, *jsonOut, ctx)
}

// runWikiCLIAnswer runs one wiki tool for the CLI: the same runWikiTool the MCP door calls, and the
// same text it hands a model. --json prints the structured answer alone, for a script.
func runWikiCLIAnswer(tool string, args map[string]interface{}, out io.Writer, jsonOut bool, ctx cliOrchestrationContext) error {
	t, err := cliTransport()
	if err != nil {
		return err
	}
	answer, err := runWikiTool(t, ctx, tool, args)
	if err != nil {
		return err
	}
	if !jsonOut {
		_, err := fmt.Fprintln(out, answer.Text)
		return err
	}
	raw, err := json.Marshal(answer.Data)
	if err != nil {
		return err
	}
	return writeCLIRawJSON(out, raw, true)
}

// ── Flags to tool arguments ─────────────────────────────────────────────────────────────────────
//
// These build the argument map wiki_search / wiki_get / wiki_propose read, which is the same map
// over MCP and at a terminal: one set of rules, two doors.

func wikiSearchToolArgs(positional []string, kinds stringList, topic string, paths stringList, limit int, limitSet bool) (map[string]interface{}, error) {
	// A query the shell split into words is read as one query rather than refused: `orbit wiki search
	// trgm index` means what `orbit wiki search "trgm index"` means.
	query := strings.TrimSpace(strings.Join(positional, " "))
	args := map[string]interface{}{}
	if query != "" {
		args["query"] = query
	}
	if len(kinds) > 0 {
		args["kinds"] = []string(kinds)
	}
	if strings.TrimSpace(topic) != "" {
		args["topic"] = strings.TrimSpace(topic)
	}
	if len(paths) > 0 {
		args["paths"] = []string(paths)
	}
	if limitSet {
		if limit < 1 || limit > wikiSearchLimitMax {
			return nil, fmt.Errorf("--limit must be a whole number from 1 to %d", wikiSearchLimitMax)
		}
		args["limit"] = float64(limit)
	}
	if query == "" && len(paths) == 0 {
		return nil, fmt.Errorf("the query is required: the words to look for, or a repo-relative path")
	}
	return args, nil
}

func wikiGetToolArgs(positional []string, include stringList) (map[string]interface{}, error) {
	ids := []string{}
	for _, value := range positional {
		ids = append(ids, strings.Split(value, ",")...)
	}
	ids = uniqueStrings(trimmed(ids))
	if len(ids) == 0 {
		return nil, fmt.Errorf("the entry ids are required: 1 to %d of them, comma-separated or repeated", wikiGetIDsMax)
	}
	if len(ids) > wikiGetIDsMax {
		return nil, fmt.Errorf("at most %d entry ids in one call, got %d: read them in two calls", wikiGetIDsMax, len(ids))
	}
	args := map[string]interface{}{"ids": ids}
	if len(include) > 0 {
		args["include"] = []string(include)
	}
	return args, nil
}

func wikiProposeToolArgs(in io.Reader, fs *flag.FlagSet, ops, opsFile, rationale, rationaleFile, key string, dryRun bool) (map[string]interface{}, error) {
	if opsFile == "-" && rationaleFile == "-" && flagWasSet(fs, "ops-file") && flagWasSet(fs, "rationale-file") {
		return nil, fmt.Errorf("--ops-file - and --rationale-file - cannot both read stdin: pass one of the two inline")
	}
	text, set, err := readCLIText(in, ops, flagWasSet(fs, "ops"), opsFile, flagWasSet(fs, "ops-file"), "ops")
	if err != nil {
		return nil, err
	}
	if !set {
		return nil, fmt.Errorf(`--ops or --ops-file - is required: a JSON array of ops, or a whole {"ops":[...],"rationale":"..."} body`)
	}
	body, err := readWikiProposeBody(text)
	if err != nil {
		return nil, err
	}
	// The flag wins over the body: a body is a file, and the flag is what somebody typed now.
	rationaleText, _, err := readCLIText(in, rationale, flagWasSet(fs, "rationale"), rationaleFile, flagWasSet(fs, "rationale-file"), "rationale")
	if err != nil {
		return nil, err
	}
	value := firstNonEmpty(strings.TrimSpace(rationaleText), strings.TrimSpace(body.Rationale))
	if value == "" {
		return nil, fmt.Errorf("--rationale is required (or carry it in the --ops-file body): why this batch is worth recording")
	}
	keyValue := firstNonEmpty(strings.TrimSpace(key), strings.TrimSpace(body.IdempotencyKey))
	if keyValue == "" {
		return nil, fmt.Errorf("--idempotency-key is required: the same key with the same request returns the recorded " +
			"answer, so a retry after an answer you never saw proposes nothing twice")
	}
	args := map[string]interface{}{"ops": body.Ops, "rationale": value, "idempotencyKey": keyValue}
	if dryRun || body.DryRun {
		args["dryRun"] = true
	}
	return args, nil
}

// wikiProposeBody is --ops read either way: the ops array on its own, or the whole propose body,
// which is how a file written for this command usually looks.
type wikiProposeBody struct {
	Ops            []interface{}
	Rationale      string
	IdempotencyKey string
	DryRun         bool
}

func readWikiProposeBody(raw string) (wikiProposeBody, error) {
	trimmed := strings.TrimSpace(raw)
	var array []interface{}
	if json.Unmarshal([]byte(trimmed), &array) == nil && array != nil {
		return wikiProposeBody{Ops: array}, nil
	}
	var body struct {
		Ops            []interface{} `json:"ops"`
		Rationale      string        `json:"rationale"`
		IdempotencyKey string        `json:"idempotencyKey"`
		DryRun         bool          `json:"dryRun"`
	}
	if err := json.Unmarshal([]byte(trimmed), &body); err != nil || body.Ops == nil {
		return wikiProposeBody{}, fmt.Errorf(`the ops must be a JSON array, or an object like {"ops":[...],"rationale":"...","idempotencyKey":"..."}`)
	}
	return wikiProposeBody{Ops: body.Ops, Rationale: body.Rationale, IdempotencyKey: body.IdempotencyKey, DryRun: body.DryRun}, nil
}

func trimmed(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, strings.TrimSpace(value))
	}
	return out
}
