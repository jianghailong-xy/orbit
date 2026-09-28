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
// nobody to propose as. Four verbs have no tool beside them: `orbit wiki verify` (wiki_verify.go) and
// `orbit wiki import` (wiki_import.go) run a model, which is a runner's work rather than a tool call's,
// and `orbit wiki dossier` and `orbit wiki cursor advance` (wiki_dossier.go) are a Wiki maintenance
// run's, and no other session's.

const wikiHelp = `orbit wiki — read the Orbit wiki and propose to it

Usage:
  orbit wiki search <query> [--kind KIND]... [--topic SLUG] [--path PATH]... [--limit N] [--json]
  orbit wiki get <id>[,<id>...] [--include WHAT]... [--json]
  orbit wiki propose (--ops JSON | --ops-file -) [--rationale TEXT | --rationale-file -]
                     [--idempotency-key KEY] [--dry-run] [--json]
  orbit wiki import --from <dir|file> --space ID [--max-ops N] [--concurrency N] [--json]
  orbit wiki verify --space ID [--model MODEL] [--max N] [--json]
  orbit wiki dossier --space <id> [--after <token>] [--limit N] [--json]
  orbit wiki cursor advance --space <id> --to <token> [--outcome succeeded|failed|truncated]
                            [--error TEXT] [--json]

The wiki is this codebase's own knowledge: decisions and what they rejected, pitfalls and their
fixes, conventions, recipes. You READ it and you PROPOSE to it; you never decide. An agent's write
is a proposal that waits for the owner in Review — or, in an automatic space, for its verification,
which 'orbit wiki verify' runs with the local model — so never report one as saved.

'orbit wiki dossier' and 'orbit wiki cursor advance' are a Wiki maintenance run's, and no other
session's: the run reads what happened in its space since the cursor, proposes what it learned
citing the records behind it, and advances the cursor once it has processed a page.

These commands act for the session they run in (ORBIT_SESSION_ID): what it may read is what that
session's workspace is bound to, and its proposal is recorded against it.
Run 'orbit wiki <command> --help' for options.
`

var wikiActionHelp = map[string]string{
	// Written beside the command it documents (wiki_import.go), as its capability is.
	"import": wikiImportHelp,
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
	"verify": `orbit wiki verify — have the local model verify what this session proposed into an automatic space

Usage:
  orbit wiki verify --space ID [--model MODEL] [--effort LEVEL] [--max N] [--json]

Options:
  --space ID               The automatic space this session proposed into. Required
  --model MODEL            The model to verify with. Default: ANTHROPIC_MODEL, the model this
                           session's provider names, at its ANTHROPIC_BASE_URL
  --effort LEVEL           Have the model think, with this effort: low, medium, high, xhigh or max.
                           Default: it does not think, whatever effort the provider declares
  --max N                  Verify at most N ops in this run; the rest keep waiting for the next
  --json                   Print the run's summary as JSON

` + wikiVerifyPrecondition + `

Each op this session proposed that waits for its verification is handed, with the text of every
record it cites, to a clean Claude Code (--bare, no tools, no MCP server, an empty HOME and
CLAUDE_CONFIG_DIR, the token from ANTHROPIC_AUTH_TOKEN through an apiKeyHelper), and the model
answers supported, partial, unsupported or duplicate. Each verdict is reported as soon as it is
read. An answer that is not exactly a verdict reports nothing and counts as a failure; the command
stops at the first 401 from the model's endpoint and when the space is no longer automatic, and
exits non-zero when any op it looked at was left without a verdict.
`,
	"dossier": `orbit wiki dossier — read what happened in a space since its cursor, as its Wiki maintenance run

Usage:
  orbit wiki dossier --space <id> [--after <token>] [--limit N] [--json]

Options:
  --space ID               The space this maintenance run maintains. Required
  --after TOKEN            A cursor token an earlier page printed: this page starts after it, or
                           after the space's cursor when that is further. Default: the cursor
  --limit N                The sessions a page carries at most, 1 to ` + fmt.Sprint(wikiDossierPageSessionsMax) + `. Default: ` + fmt.Sprint(wikiDossierPageSessionsDefault) + `
  --json                   Print the page as the server's JSON

` + wikiDossierPrecondition + `

A page is the facts after its start — sessions that came to rest, tasks that finished, questions
answered, merge receipts, criteria revised — oldest first, and a dossier for each session they
name: its timeline compressed, redacted and cut to a token budget, each line led by its short name
(L1, L2 and so on), with sources naming the record behind each line. A batch project's sessions
are counted instead, and tool errors several sessions share are listed as error clusters. The page
ends with its cursor token and the 'orbit wiki cursor advance' that takes it; with more facts past
the page, --after the token reads the next one. Any session but a maintenance run of the space is
refused WIKI_NOT_MAINTENANCE_SESSION.
`,
	"cursor": `orbit wiki cursor — report how a Wiki maintenance run ended, and move the space's cursor

Usage:
  orbit wiki cursor advance --space <id> --to <token> [--outcome succeeded|failed|truncated]
                            [--error TEXT] [--json]

Commands:
  advance                  Report the run's outcome; a succeeded run moves the cursor to --to

Options:
  --space ID               The space this maintenance run maintains. Required
  --to TOKEN               The cursor token of the last page this run processed, as 'orbit wiki
                           dossier' printed it. Required when the run succeeded
  --outcome OUTCOME        How the run ended: ` + strings.Join(wikiCursorOutcomes, ", ") + `. Default: ` + wikiCursorOutcomes[0] + `
  --error TEXT             Why a failed or truncated run did not succeed; it is redacted and kept
                           as the space's last error
  --json                   Print the server's answer as JSON

` + wikiCursorPrecondition + `

Only a succeeded run moves the cursor, and only forward. A token behind it — another run went
further — is refused WIKI_CURSOR_BEHIND, and a token no page of this space handed out
WIKI_CURSOR_INVALID: both change nothing, and the command exits non-zero. A token the cursor already
stands at is a success that moves nothing. A failed or truncated run moves nothing either: it is
recorded, one more of the space's consecutive failures, and the command exits 0.
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
	{
		// A verb with no MCP tool beside it (contract `agentSurface.verify.tool`): it runs a model,
		// which is a runner's work, so its description is its own rather than a descriptor's.
		Tool:  "wiki_verify",
		Argv:  []string{"orbit", "wiki", "verify"},
		Usage: "orbit wiki verify --space ID [--model MODEL] [--effort LEVEL] [--max N] [--json]",
		Arguments: []string{
			"--space <id> (required; the automatic space this session proposed into)",
			"--model <model> (default ANTHROPIC_MODEL, the model this session's provider names)",
			"--effort <" + strings.Join(wikiVerifyEfforts, "|") + "> (default: the model does not think)",
			"--max <n> (verify at most n ops this run)",
			"--json",
		},
		Description: wikiVerifyDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space":  map[string]interface{}{"type": "string", "description": "The automatic space this session proposed into."},
				"model":  map[string]interface{}{"type": "string", "description": "The model to verify with; ANTHROPIC_MODEL, the one this session's provider names, when left out."},
				"effort": map[string]interface{}{"type": "string", "enum": wikiVerifyEfforts, "description": "Have the model think, with this effort. Left out, it does not think, whatever effort the session's provider declares."},
				"max":    map[string]interface{}{"type": "integer", "minimum": 1, "description": "Verify at most this many ops in this run; the rest keep waiting."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		// A Wiki maintenance run's two verbs, with no MCP tool beside them either (contract
		// `maintenance.cli.tool`): each is one kind of session's work, so each schema is its own.
		Tool:  "wiki_dossier",
		Argv:  []string{"orbit", "wiki", "dossier"},
		Usage: "orbit wiki dossier --space <id> [--after <token>] [--limit N] [--json]",
		Arguments: []string{
			"--space <id> (required; the space this maintenance run maintains)",
			"--after <token> (a cursor token an earlier page printed; default the space's cursor)",
			"--limit <n> (1-" + fmt.Sprint(wikiDossierPageSessionsMax) + " sessions a page carries; default " + fmt.Sprint(wikiDossierPageSessionsDefault) + ")",
			"--json",
		},
		Description: wikiDossierDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space": map[string]interface{}{"type": "string", "description": "The space this maintenance run maintains."},
				"after": map[string]interface{}{"type": "string", "description": "A cursor token an earlier page printed: the page starts after it, or after the space's cursor when that is further."},
				"limit": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": wikiDossierPageSessionsMax, "description": "The sessions the page carries at most; " + fmt.Sprint(wikiDossierPageSessionsDefault) + " when left out."},
			},
			"required": []string{"space"},
		},
		SessionOnly: true,
	},
	{
		Tool:  "wiki_cursor_advance",
		Argv:  []string{"orbit", "wiki", "cursor", "advance"},
		Usage: "orbit wiki cursor advance --space <id> --to <token> [--outcome succeeded|failed|truncated] [--error TEXT] [--json]",
		Arguments: []string{
			"--space <id> (required; the space this maintenance run maintains)",
			"--to <token> (required when the run succeeded; the cursor token of the last page it processed)",
			"--outcome <" + strings.Join(wikiCursorOutcomes, "|") + "> (default " + wikiCursorOutcomes[0] + "; only a succeeded run moves the cursor)",
			"--error <text> (why a failed or truncated run did not succeed)",
			"--json",
		},
		Description: wikiCursorAdvanceDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space":   map[string]interface{}{"type": "string", "description": "The space this maintenance run maintains."},
				"to":      map[string]interface{}{"type": "string", "description": "The cursor token of the last page this run processed. Required unless the outcome is failed or truncated."},
				"outcome": map[string]interface{}{"type": "string", "enum": wikiCursorOutcomes, "description": "How the run ended; " + wikiCursorOutcomes[0] + " when left out. Only a succeeded run moves the cursor."},
				"error":   map[string]interface{}{"type": "string", "description": "Why a failed or truncated run did not succeed."},
			},
			"required": []string{"space"},
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
	command := "orbit wiki " + action
	if action == "cursor" {
		// The cursor's one command is named rather than implied: a bare `orbit wiki cursor` is asking
		// what there is, and a word that is not `advance` is a command this build does not have.
		if len(args) == 1 {
			_, err := fmt.Fprint(out, h)
			return err
		}
		if args[1] != "advance" {
			return fmt.Errorf("unknown cursor command %q: its one command is advance, as in "+
				"'orbit wiki cursor advance --space <id> --to <token>'\n\n%s", args[1], h)
		}
		command += " advance"
	}
	ctx, err := wikiCLIContext(command)
	if err != nil {
		return err
	}
	switch action {
	case "import":
		return cliWikiImport(args[1:], out, ctx)
	case "search":
		return cliWikiSearch(args[1:], out, ctx)
	case "get":
		return cliWikiGet(args[1:], out, ctx)
	case "propose":
		return cliWikiPropose(args[1:], in, out, ctx)
	case "verify":
		return cliWikiVerify(args[1:], out, ctx)
	case "dossier":
		return cliWikiDossier(args[1:], out, ctx)
	case "cursor":
		return cliWikiCursorAdvance(args[2:], out, ctx)
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
