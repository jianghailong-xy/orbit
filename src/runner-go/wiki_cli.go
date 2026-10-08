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
// nobody to propose as. Eight verbs have no tool beside them: `orbit wiki verify` (wiki_verify.go) and
// `orbit wiki import` (wiki_import.go) run a model, which is a runner's work rather than a tool call's,
// and `orbit wiki dossier`, `orbit wiki cursor advance` (wiki_dossier.go), `orbit wiki anchors
// verify` (wiki_anchors.go), `orbit wiki articles` (wiki_articles.go), `orbit wiki docs build`
// (wiki_docs_build.go) and `orbit wiki maintain` (wiki_maintain.go) are a Wiki maintenance run's, and no
// other session's. `orbit wiki check`
// (wiki_maintain.go) is the one with a headless form: it is a maintenance task's acceptance command,
// which runs after the session's turn in a shell with no session. `orbit wiki plan draft|revise|check`
// (wiki_plan_cli.go) are a plan job's run and its task's acceptance command, in the same two shapes.

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
  orbit wiki anchors verify --space <id> [--repo <path>] [--json]
  orbit wiki articles --space <id> [--topic <slug>] [--model MODEL] [--json]
  orbit wiki docs build --space <id> [--doc <slug>] [--section <key>] [--repo <path>]
                        [--model MODEL] [--json]
  orbit wiki maintain --space <id> [--model MODEL] [--concurrency N] [--json]
  orbit wiki check --space <id> --expect-cursor <token> [--json]
  orbit wiki plan draft --space <id> [--target MIN-MAX] [--model MODEL] [--concurrency N] [--work-dir DIR] [--json]
  orbit wiki plan revise --space <id> [--instructions <file>] [--target MIN-MAX] [...] [--json]
  orbit wiki plan check --space <id> --job <id> [--json]

The wiki is this codebase's own knowledge: decisions and what they rejected, pitfalls and their
fixes, conventions, recipes. You READ it and you PROPOSE to it; you never decide. An agent's write
is a proposal that waits for the owner in Review — or, in an automatic space, for its verification,
which 'orbit wiki verify' runs with the local model — so never report one as saved.

'orbit wiki dossier', 'orbit wiki cursor advance', 'orbit wiki anchors verify', 'orbit wiki
articles', 'orbit wiki docs build' and 'orbit wiki maintain' are a Wiki maintenance run's, and no
other session's: the run reads what happened in its space since the cursor, proposes what it
learned citing the records behind it, re-verifies the anchors of its space's entries on
origin/main, advances the cursor once it has processed a page, and writes again the sections of the
documents of the plan its owner confirmed that its entries and origin/main's changes touched,
proposing a change to the plan for what fits no section. 'orbit wiki maintain' does all of it in one
run ('orbit wiki articles' is the topic articles' command, which it no longer runs); 'orbit wiki check'
is its task's acceptance command, and needs no session. 'orbit wiki plan draft' and 'orbit wiki
plan revise' are a plan job's run — the task the server makes for a draft of the space's plan — and
'orbit wiki plan check' is that task's acceptance command; 'orbit wiki docs build' is also the run of
the build job the owner's confirmation of a plan version makes.

These commands act for the session they run in (ORBIT_SESSION_ID): what it may read is what that
session's workspace is bound to, and its proposal is recorded against it.
Run 'orbit wiki <command> --help' for options.
`

var wikiActionHelp = map[string]string{
	// Written beside the command it documents (wiki_import.go), as its capability is.
	"import": wikiImportHelp,
	// The plan job's three verbs, written beside them (wiki_plan_cli.go).
	"plan": wikiPlanHelp,
	"maintain": `orbit wiki maintain — run a space's Wiki maintenance, whole, as its maintenance run

Usage:
  orbit wiki maintain --space <id> [--model MODEL] [--concurrency N] [--json]

Options:
  --space ID               The space this maintenance run maintains. Required
  --model MODEL            The model to extract with. Default: ANTHROPIC_MODEL, the model this
                           session's provider names, at its ANTHROPIC_BASE_URL
  --concurrency N          Model calls in flight at once while extracting, 1 to 16. Default: ` + fmt.Sprint(wikiMaintainExtractConcurrency) + `
  --json                   Print the run's summary as JSON

` + wikiMaintainPrecondition + `

It reads where the run starts, fetches the maintenance workspace's checkout (a clone of the space's
repository, or the run fails), reads the dossiers from the space's cursor up to the position its
task expects, and has the local model extract at most ` + fmt.Sprint(wikiMaintainEntriesPerSession) + ` entries from each through a clean
Claude Code (--bare, no tools, an empty HOME and CLAUDE_CONFIG_DIR, the token through an
apiKeyHelper, thinking off). Each entry is checked against its dossier (every source a line of it,
its quote copied from that line) and the checkout (anchors that exist on origin/main); a session
about something else than the repository gives none. The entries are proposed by topic, with dryRun
first; the ops the review mode would apply may change at most the circuit breaker's share of the
active entries. Then, in an automatic space, the run's ops are verified; the anchors are
re-verified; only the sections of the confirmed plan's documents that the run touched are written
again — the ones an entry that changed fits, the ones whose design documents, code or contracts
changed on origin/main (a cited file gone withdraws the sentences citing it), and, with no build
waiting, the ones never written — and one change to the plan is proposed at most for what fits no
section, a new design document under docs/ among it; with no confirmed plan no document is written;
and the cursor advances. Any step before the documents that fails ends the run failed and moves
nothing; the documents' step reports what it could not do and fails nothing. Nor does an op the
verification gets no verdict for: it is asked about once more — told, when its answer was not a
verdict, why, and which ids a duplicate may name — and one still without a verdict is not live and
keeps waiting; the next run adopts it. A 401 from the model's endpoint still fails the run. It
prints what it did, the token spend included, and exits non-zero when the run failed.
`,
	"check": `orbit wiki check — whether a Wiki maintenance run did what its task expected

Usage:
  orbit wiki check --space <id> --expect-cursor <token> [--json]

Options:
  --space ID               The space the maintenance task maintains. Required
  --expect-cursor TOKEN    The cursor token the task was made with. Required
  --json                   Print the server's answer as JSON

` + wikiCheckPrecondition + `

It exits 0 when the space's cursor is at or past the position the token names, and the run of the
task that expects it ended succeeded with none of its ops refused; otherwise it prints each reason
and exits non-zero. It reads and changes nothing else, and needs no session.
`,
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

A source is {"kind": KIND, "ref": REF, "quote": TEXT}, and what REF is depends on the kind:
  turn, event, task, task_comment, approval, merge_receipt, note
                   the record's id: its UUID, or the short id Orbit shows. A turn of this session
                   is {"kind":"turn","session":"self"} and takes no ref
  owner_decision   the id of the project blocker the owner resolved with a note
  tool_call        the tool call's id, or the tool_use_id its engine gave the call (toolu_…,
                   call_…): this session's own call first, else the one session of the owner's
                   that made it
  commit           the commit's full sha
  evidence, criterion, url
                   cannot be cited yet
A ref that names nothing is refused, naming the source as ops[i].sources[j].ref.
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
exits non-zero when any op it looked at was left without a verdict. A Wiki maintenance run does not
go by that exit: what its verification leaves without a verdict waits for the next run, and fails
nothing.
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
	"anchors": `orbit wiki anchors — re-verify the anchors of a space's entries on origin/main, as its Wiki maintenance run

Usage:
  orbit wiki anchors verify --space <id> [--repo <path>] [--json]

Commands:
  verify                   Fetch origin's main, check every path, symbol and commit anchor, and report

Options:
  --space ID               The space this maintenance run maintains. Required
  --repo PATH              The checkout of the space's repository to re-verify in. Default: the work
                           directory of the space's workspace on this runner (a leading ~ is this
                           runner's home)
  --json                   Print the run's summary as JSON

` + wikiAnchorsVerifyPrecondition + `

It fetches origin's main into origin/main and checks each anchor of the space's live entries on the
commit origin/main then names: a path with git cat-file -e, a symbol by hashing the ` + fmt.Sprint(wikiAnchorSymbolRegionLines) + ` lines from
the first line git grep -w finds it on, a commit with git merge-base --is-ancestor (a sha that is not
an ancestor of origin/main is missing). Each page of entries is reported as it is checked. An entry
whose anchor changed or went missing is out of the push at once, with one system challenge in the
owner's Review. It exits non-zero when the fetch failed, when git could not check an anchor, or when
the server refused an entry; an entry that moved since the list was read is stale, and read again by
the next run. Any session but a maintenance run of the space is refused WIKI_NOT_MAINTENANCE_SESSION.
`,
	"docs": `orbit wiki docs — write a space's documents from the plan its owner confirmed, as its Wiki maintenance run

Usage:
  orbit wiki docs build --space <id> [--doc <slug>] [--section <key>] [--repo <path>] [--model MODEL] [--json]

Commands:
  build                    Gather each section's material, merge it, write it, check its quotes, and write it

Options:
  --space ID               The space this maintenance run maintains. Required
  --doc SLUG               Only this document of the confirmed plan. Default: every document of it
  --section KEY            Only this section of --doc
  --repo PATH              The checkout of the space's repository to read at origin/main. Default: the
                           working directory's checkout
  --model MODEL            The model to write with. Default: ANTHROPIC_MODEL, the model this
                           session's provider names, at its ANTHROPIC_BASE_URL
  --json                   Print the run's summary as JSON

` + wikiDocsBuildPrecondition + `

It fetches origin's main into the checkout and reads the confirmed plan. For each section it gathers the
material the plan names: design-document sections, code symbols (with the comment above them) and
contracts at the commit origin/main names, and — for a section with a session condition — the records
the server finds by it, redacted and placed. The platform's template messages and repeated texts are
taken out, and the rest cut to ` + fmt.Sprint(wikiDocMaterialMaxChars) + ` characters. A section whose fingerprint (its plan definition and
that material) is the one the server holds, and from which nothing was withdrawn, is left as it is,
without asking the model. Otherwise a clean Claude Code (--bare, no tools, no MCP server, an empty HOME
and CLAUDE_CONFIG_DIR, the token from ANTHROPIC_AUTH_TOKEN through an apiKeyHelper, thinking off) merges
the material — adopt, merge into another, or drop, each with a reason, sent with the section — and
writes the section, a verbatim quote for every footnote. A repository quote is looked for in the file at
the commit, and its lines are where it was found; the server checks a record's quote itself. A
document's overview is written last, from its other sections as they are written. The command stops at
the first 401 from the model's endpoint, and exits non-zero when any section it took up was left
unwritten. Any session but a maintenance run of the space is refused WIKI_NOT_MAINTENANCE_SESSION.

For an account the Orbit server runs the wiki for (ORBIT_WIKI_EXECUTOR server, or canary with the
account on its list) the server answers WIKI_SERVER_EXECUTES instead: its wiki worker builds the
documents when the owner confirms a plan, with the deployment's System model. The command then asks no
model, says so and exits 0; a build job's run ends its job failed, saying why.
`,
	"articles": `orbit wiki articles — have the local model write the articles of a space's changed topics, as its Wiki maintenance run

Usage:
  orbit wiki articles --space <id> [--topic <slug>] [--model MODEL] [--json]

Options:
  --space ID               The space this maintenance run maintains. Required
  --topic SLUG             Only this topic, and only if its entries changed. Default: every topic whose
                           entries changed since its articles were written
  --model MODEL            The model to write with. Default: ANTHROPIC_MODEL, the model this
                           session's provider names, at its ANTHROPIC_BASE_URL
  --json                   Print the run's summary as JSON

` + wikiArticlesPrecondition + `

The server's plan names the topics whose entry set changed; a space with no topic is given the
default ones first. Each such topic's entries are read, and a topic of more than ` + fmt.Sprint(wikiArticleSplitAbove) + ` entries is
grouped into subtopics by their anchor paths and words. A clean Claude Code (--bare, no tools, no
MCP server, an empty HOME and CLAUDE_CONFIG_DIR, the token from ANTHROPIC_AUTH_TOKEN through an
apiKeyHelper, thinking off) names each group and writes each article — ` + fmt.Sprint(wikiArticleMinChars) + ` to ` + fmt.Sprint(wikiArticleMaxChars) + ` characters,
every sentence footnoted — from the entries alone. The server keeps a footnote only when it names an
entry of the topic, deletes a sentence left without one, cuts what passes ` + fmt.Sprint(wikiArticleMaxChars) + ` characters, and
writes nothing for a topic whose entries did not change. The command stops at the first 401 from
the model's endpoint, and exits non-zero when any topic it took up was left unwritten. Any session
but a maintenance run of the space is refused WIKI_NOT_MAINTENANCE_SESSION.

For an account the Orbit server runs the wiki for (ORBIT_WIKI_EXECUTOR server, or canary with the
account on its list) the server answers WIKI_SERVER_EXECUTES instead: its wiki worker writes the
articles after a maintenance run, with the deployment's System model. The command then asks no model,
says so and exits 0.
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
	{
		// The anchor re-verification (contract `anchorRules.verify`): a maintenance run's verb like the two
		// above, and one that runs git in a checkout, which is a runner's work rather than a tool call's.
		Tool:  "wiki_anchors_verify",
		Argv:  []string{"orbit", "wiki", "anchors", "verify"},
		Usage: "orbit wiki anchors verify --space <id> [--repo <path>] [--json]",
		Arguments: []string{
			"--space <id> (required; the space this maintenance run maintains)",
			"--repo <path> (the checkout to re-verify in; default the work directory of the space's workspace on this runner)",
			"--json",
		},
		Description: wikiAnchorsVerifyDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space": map[string]interface{}{"type": "string", "description": "The space this maintenance run maintains."},
				"repo":  map[string]interface{}{"type": "string", "description": "The checkout of the space's repository to re-verify in; the work directory of the space's workspace on this runner when left out."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		// The maintenance run's articles (contract `articles.cli`): CLI only, like the three above, and a
		// model's work like verify.
		Tool:  "wiki_articles",
		Argv:  []string{"orbit", "wiki", "articles"},
		Usage: "orbit wiki articles --space <id> [--topic <slug>] [--model MODEL] [--json]",
		Arguments: []string{
			"--space <id> (required; the space this maintenance run maintains)",
			"--topic <slug> (only this topic; default every topic whose entries changed)",
			"--model <model> (default ANTHROPIC_MODEL, the model this session's provider names)",
			"--json",
		},
		Description: wikiArticlesDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space": map[string]interface{}{"type": "string", "description": "The space this maintenance run maintains."},
				"topic": map[string]interface{}{"type": "string", "description": "Only this topic's articles, and only if its entries changed; every changed topic when left out."},
				"model": map[string]interface{}{"type": "string", "description": "The model to write with; ANTHROPIC_MODEL, the one this session's provider names, when left out."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		// The maintenance run's documents (contract `docs.build`): CLI only like the articles, a model's
		// work, with a sub-command named like the anchors' re-verification.
		Tool:  "wiki_docs_build",
		Argv:  []string{"orbit", "wiki", "docs", "build"},
		Usage: "orbit wiki docs build --space <id> [--doc <slug>] [--section <key>] [--repo <path>] [--model MODEL] [--json]",
		Arguments: []string{
			"--space <id> (required; the space this maintenance run maintains)",
			"--doc <slug> (only this document of the confirmed plan; default every document)",
			"--section <key> (only this section of the --doc document)",
			"--repo <path> (the checkout to read at origin/main; default the working directory's)",
			"--model <model> (default ANTHROPIC_MODEL, the model this session's provider names)",
			"--json",
		},
		Description: wikiDocsBuildDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space":   map[string]interface{}{"type": "string", "description": "The space this maintenance run maintains."},
				"doc":     map[string]interface{}{"type": "string", "description": "Only this document of the confirmed plan, by its slug; every document when left out."},
				"section": map[string]interface{}{"type": "string", "description": "Only this section of the document doc names, by its key."},
				"repo":    map[string]interface{}{"type": "string", "description": "The checkout of the space's repository to read at origin/main; the working directory's when left out."},
				"model":   map[string]interface{}{"type": "string", "description": "The model to write with; ANTHROPIC_MODEL, the one this session's provider names, when left out."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		// The maintenance job's run (contract `maintenance.job.cli`): the whole pipeline in one command.
		Tool:  "wiki_maintain",
		Argv:  []string{"orbit", "wiki", "maintain"},
		Usage: "orbit wiki maintain --space <id> [--model MODEL] [--concurrency N] [--json]",
		Arguments: []string{
			"--space <id> (required; the space this maintenance run maintains)",
			"--model <model> (default ANTHROPIC_MODEL, the model this session's provider names)",
			"--concurrency <n> (1-16 model calls in flight while extracting; default " + fmt.Sprint(wikiMaintainExtractConcurrency) + ")",
			"--json",
		},
		Description: wikiMaintainDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space":       map[string]interface{}{"type": "string", "description": "The space this maintenance run maintains."},
				"model":       map[string]interface{}{"type": "string", "description": "The model to extract with; ANTHROPIC_MODEL, the one this session's provider names, when left out."},
				"concurrency": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 16, "description": "Model calls in flight at once while extracting."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		// The maintenance task's acceptance command: headless, since that command runs with no session.
		Tool:  "wiki_check",
		Argv:  []string{"orbit", "wiki", "check"},
		Usage: "orbit wiki check --space <id> --expect-cursor <token> [--json]",
		Arguments: []string{
			"--space <id> (required; the space the maintenance task maintains)",
			"--expect-cursor <token> (required; the cursor token the task was made with)",
			"--json",
		},
		Description: wikiCheckDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space":         map[string]interface{}{"type": "string", "description": "The space the maintenance task maintains."},
				"expect-cursor": map[string]interface{}{"type": "string", "description": "The cursor token the maintenance task was made with."},
			},
			"required": []string{"space", "expect-cursor"},
		},
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
	if action == "anchors" {
		// Like the cursor, a verb named rather than implied: its one command is verify.
		if len(args) == 1 {
			_, err := fmt.Fprint(out, h)
			return err
		}
		if args[1] != "verify" {
			return fmt.Errorf("unknown anchors command %q: its one command is verify, as in "+
				"'orbit wiki anchors verify --space <id>'\n\n%s", args[1], h)
		}
		command += " verify"
	}
	if action == "docs" {
		// Like the anchors, a verb named rather than implied: its one command is build.
		if len(args) == 1 {
			_, err := fmt.Fprint(out, h)
			return err
		}
		if args[1] != "build" {
			return fmt.Errorf("unknown docs command %q: its one command is build, as in "+
				"'orbit wiki docs build --space <id>'\n\n%s", args[1], h)
		}
		command += " build"
	}
	if action == "check" {
		// A maintenance task's acceptance command: it runs after the session's turn, with no session.
		return cliWikiCheck(args[1:], out)
	}
	if action == "plan" {
		// Three verbs, one of them — check, a plan job's acceptance command — with no session: each
		// asks for the session context itself when it needs one.
		return cliWikiPlan(args[1:], in, out)
	}
	ctx, err := wikiCLIContext(command)
	if err != nil {
		return err
	}
	switch action {
	case "maintain":
		return cliWikiMaintain(args[1:], out, ctx)
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
	case "anchors":
		return cliWikiAnchorsVerify(args[2:], out, ctx)
	case "articles":
		return cliWikiArticles(args[1:], out, ctx)
	case "docs":
		return cliWikiDocsBuild(args[2:], out, ctx)
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
