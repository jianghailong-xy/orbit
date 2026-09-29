package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// `orbit wiki dossier` and `orbit wiki cursor advance`: a Wiki maintenance run's reading and its
// bookkeeping (contracts/wiki.contract.json `maintenance`, design §8.2 step 1).
//
// ONLY A MAINTENANCE RUN OF THE SPACE READS THIS: a session whose task is in the space's hidden «Wiki
// maintenance» list. What happened in the space since its cursor — sessions that came to rest, tasks
// that finished, questions answered, merge receipts, criteria revised — comes back as a page of
// dossiers, each session's timeline compressed, redacted and cut to a budget, every line led by a short
// name that maps to the first-hand record it came from. The run reads a page, proposes what it learned
// citing THOSE records, and then says it is done: `cursor advance --to` the page's token moves the
// space's cursor past everything the page covered, so the next run starts after it. The server asks
// its one test of a maintenance session on every call; any other session is refused
// WIKI_NOT_MAINTENANCE_SESSION, so neither verb is a power an ordinary session could use.
//
// ONLY A SUCCEEDED RUN MOVES THE CURSOR. A run that failed or was cut short says so, and the server
// counts it — the space's consecutive failures are how the owner hears that maintenance is stuck —
// while the cursor stays where the last good run left it, so what the failed run read is read again
// by the next one. The one thing a run must not do is the easy one: advance past a page it did not
// finish, which drops everything it never got to.
//
// Neither verb has an MCP tool beside it (contract `maintenance.cli.tool`): they are one kind of
// session's work, and that session has a shell.

// wikiDossierPrecondition and wikiCursorPrecondition are contracts/wiki.contract.json
// `maintenance.cli.dossierPrecondition` and `cursorPrecondition`, word for word, and
// wiki_dossier_test.go holds them equal. Each leads its verb's description for the reason
// wikiVerifyPrecondition leads verify's: what a reader must not do is what the mechanics make easy —
// cite the dossier, which is a digest, and advance past a run that did not finish.
const wikiDossierPrecondition = "Read dossiers only as a Wiki maintenance run of the space, and cite the records " +
	"their lines name, never the dossier itself: a dossier is sessions compressed, redacted and cut to a budget, " +
	"not a record."

const wikiCursorPrecondition = "Advance the cursor only when the run succeeded and every dossier up to the token " +
	"was processed: a run that failed or was cut short reports that outcome instead, and moves nothing."

const wikiDossierDescription = wikiDossierPrecondition + " This is a Wiki maintenance run's reading: one page of " +
	"what happened in --space since its cursor (sessions that came to rest, tasks that finished, questions answered, " +
	"merge receipts, criteria revised), oldest first, with one dossier for each session those facts name — its " +
	"timeline compressed, redacted and cut to a token budget, each line led by its short name (L1, L2 and so on), and " +
	"sources mapping each name to the turn, event, tool call, task, comment, approval, merge receipt or owner decision " +
	"it came from, which is what a proposal cites, and to where in that record's text the line's words are (@start-end, " +
	"code points of the record's redacted text: a quote copied from there is the record's own words). A batch " +
	"project's sessions come as counts rather than a dossier " +
	"each, and tool errors several of the space's sessions share come as error clusters. The page ends with its " +
	"cursor token: `orbit wiki cursor advance --to` that token is how the run says it processed everything up to it, " +
	"and when more is true, --after the same token reads the next page. Any session but a maintenance run of the " +
	"space is refused WIKI_NOT_MAINTENANCE_SESSION."

const wikiCursorAdvanceDescription = wikiCursorPrecondition + " This is how a Wiki maintenance run says it is " +
	"done. --outcome succeeded, the default, with --to the cursor token of the last page it processed, moves the " +
	"space's cursor to that token, forward only: a token behind the cursor (another run went further) is refused " +
	"WIKI_CURSOR_BEHIND and one no page of this space handed out WIKI_CURSOR_INVALID, both change nothing and exit " +
	"non-zero, and a token the cursor already stands at is a success that moves nothing. --outcome failed or truncated, " +
	"with --error saying why, moves nothing either: it records the failure, one more of the space's consecutive " +
	"failures, and exits 0. Any session but a maintenance run of the space is refused WIKI_NOT_MAINTENANCE_SESSION."

// wikiCursorOutcomes is contracts/wiki.contract.json `maintenance.cursor.advance.outcomes`, in its
// order: how a run ended. Only the first moves the cursor.
var wikiCursorOutcomes = []string{"succeeded", "failed", "truncated"}

// The contract's page sizes (`maintenance.rules`): a page carries at most this many sessions, and this
// many when --limit is left out.
const (
	wikiDossierPageSessionsMax     = 50
	wikiDossierPageSessionsDefault = 20
	// A page builds up to fifty dossiers, each from a session's whole timeline, which is a heavier read
	// than the runner door's others: this is how long one may take before the command gives up on it.
	wikiDossierPageTimeout = 2 * time.Minute
)

// The refusals only these routes give (contract `refusals`).
const (
	wikiNotMaintenanceSessionCode = "WIKI_NOT_MAINTENANCE_SESSION"
	wikiCursorBehindCode          = "WIKI_CURSOR_BEHIND"
	wikiCursorInvalidCode         = "WIKI_CURSOR_INVALID"
)

// ── The server's two routes ─────────────────────────────────────────────────────────────────────
//
// Only what the text form prints is read here: `--json` prints the server's own answer, whole.

// wikiDossierPage is `GET /api/runner/wiki/spaces/:id/dossiers` (contract `maintenance.dossier`).
type wikiDossierPage struct {
	SpaceID       string             `json:"spaceId"`
	Cursor        string             `json:"cursor"`
	More          bool               `json:"more"`
	Facts         int                `json:"facts"`
	Dossiers      []wikiDossier      `json:"dossiers"`
	Batches       []wikiDossierBatch `json:"batches"`
	ErrorClusters []wikiErrorCluster `json:"errorClusters"`
	State         wikiCursorState    `json:"state"`
}

// wikiDossier is one session's dossier. Its text is the only copy there is: the server keeps its
// sources and its hash, never the text.
type wikiDossier struct {
	SessionID string              `json:"sessionId"`
	TaskID    string              `json:"taskId"`
	Title     string              `json:"title"`
	Text      string              `json:"text"`
	Tokens    int                 `json:"tokens"`
	Truncated bool                `json:"truncated"`
	Tainted   bool                `json:"tainted"`
	Sources   []wikiDossierSource `json:"sources"`
	Hash      string              `json:"hash"`
	Unchanged bool                `json:"unchanged"`
}

// wikiDossierSource is one line's first-hand record — what a proposal made from the dossier cites — and
// where in that record's text the line's words are (contract `maintenance.dossier.spans`).
type wikiDossierSource struct {
	Ref   string            `json:"ref"`
	Kind  string            `json:"kind"`
	ID    string            `json:"id"`
	Spans []wikiDossierSpan `json:"spans"`
}

// wikiDossierSpan is one piece of a line's words in its record: from Start to End in code points of the
// record's text — the text a quote of it is checked against, redacted — and the words found there. A line
// the dossier compressed has a span for each piece of its record it kept: a tool call's command and its
// result's first and last line, a thought's signal sentences.
type wikiDossierSpan struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

// wikiDossierBatch is a batch project's sessions of the page, which come as counts and no dossier each.
type wikiDossierBatch struct {
	ProjectID string         `json:"projectId"`
	ListID    string         `json:"listId"`
	Template  string         `json:"template"`
	Tasks     int            `json:"tasks"`
	ByStatus  map[string]int `json:"byStatus"`
	Sessions  int            `json:"sessions"`
	Errors    []struct {
		Tool      string `json:"tool"`
		Signature string `json:"signature"`
		Count     int    `json:"count"`
	} `json:"errors"`
}

// wikiErrorCluster is one tool error signature enough of the space's sessions share.
type wikiErrorCluster struct {
	Tool        string `json:"tool"`
	Signature   string `json:"signature"`
	Sessions    int    `json:"sessions"`
	Occurrences int    `json:"occurrences"`
	Examples    []struct {
		ToolCallID string `json:"toolCallId"`
		SessionID  string `json:"sessionId"`
		FirstLine  string `json:"firstLine"`
	} `json:"examples"`
}

// wikiCursorState is where a space's cursor stands, as both routes answer it.
type wikiCursorState struct {
	Position            string `json:"position"`
	Backlog             int    `json:"backlog"`
	ConsecutiveFailures int    `json:"consecutiveFailures"`
}

// wikiCursorAdvanceAnswer is `POST /api/runner/wiki/spaces/:id/cursor`'s answer.
type wikiCursorAdvanceAnswer struct {
	Advanced bool            `json:"advanced"`
	Outcome  string          `json:"outcome"`
	State    wikiCursorState `json:"state"`
}

// ── The commands ────────────────────────────────────────────────────────────────────────────────

func cliWikiDossier(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki dossier")
	space := fs.String("space", "", "the space this maintenance run maintains")
	after := fs.String("after", "", "a cursor token an earlier page printed")
	limit := fs.Int("limit", 0, "the sessions a page carries at most")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID, err := wikiMaintenanceSpace(*space)
	if err != nil {
		return err
	}
	if flagWasSet(fs, "limit") && (*limit < 1 || *limit > wikiDossierPageSessionsMax) {
		return fmt.Errorf("--limit must be a whole number from 1 to %d: the sessions a page carries", wikiDossierPageSessionsMax)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listWikiDossiers(ctx.sessionID, spaceID, strings.TrimSpace(*after), *limit)
	if err != nil {
		return wikiMaintenanceCallError("orbit wiki dossier", spaceID, "--after", err)
	}
	if *jsonOut {
		return writeCLIRawJSON(out, raw, true)
	}
	var page wikiDossierPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return fmt.Errorf("orbit wiki dossier: the server's page is not the shape this build reads: %w", err)
	}
	_, err = fmt.Fprint(out, describeWikiDossierPage(spaceID, page))
	return err
}

func cliWikiCursorAdvance(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit wiki cursor advance")
	space := fs.String("space", "", "the space this maintenance run maintains")
	to := fs.String("to", "", "the cursor token of the last page this run processed")
	outcome := fs.String("outcome", wikiCursorOutcomes[0], "how the run ended")
	why := fs.String("error", "", "why the run did not succeed")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	spaceID, err := wikiMaintenanceSpace(*space)
	if err != nil {
		return err
	}
	ended := strings.TrimSpace(*outcome)
	if !contains(wikiCursorOutcomes, ended) {
		return fmt.Errorf("--outcome must be one of %s", strings.Join(wikiCursorOutcomes, ", "))
	}
	token := strings.TrimSpace(*to)
	if ended == "succeeded" && token == "" {
		return fmt.Errorf("--to is required when the run succeeded: the cursor token of the last page it processed, as " +
			"`orbit wiki dossier` printed it. A run that failed or was cut short passes --outcome failed or " +
			"--outcome truncated instead, and moves nothing")
	}
	body := map[string]interface{}{"outcome": ended}
	if token != "" {
		body["to"] = token
	}
	if text := strings.TrimSpace(*why); text != "" {
		body["error"] = text
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.advanceWikiCursor(ctx.sessionID, spaceID, body)
	if err != nil {
		return wikiCursorAdvanceError(spaceID, err)
	}
	if *jsonOut {
		return writeCLIRawJSON(out, raw, true)
	}
	var answer wikiCursorAdvanceAnswer
	if err := json.Unmarshal(raw, &answer); err != nil {
		return fmt.Errorf("orbit wiki cursor advance: the server's answer is not the shape this build reads: %w", err)
	}
	_, err = fmt.Fprintln(out, describeWikiCursorAdvance(spaceID, answer))
	return err
}

// wikiMaintenanceSpace is --space, checked: both verbs name the space in the path.
func wikiMaintenanceSpace(value string) (string, error) {
	spaceID := strings.TrimSpace(value)
	if spaceID == "" {
		return "", fmt.Errorf("--space is required: the space this maintenance run maintains")
	}
	if err := validatePathSegmentID(spaceID); err != nil {
		return "", fmt.Errorf("--space %w", err)
	}
	return spaceID, nil
}

// ── What the caller reads ───────────────────────────────────────────────────────────────────────

// describeWikiDossierPage is the page as a run reads it: what it holds and the command that ends it
// first, so a run that stops reading half way still knows how to say it is done, then each dossier
// whole, with the records its lines name, then the batches and error clusters in a line or two each.
func describeWikiDossierPage(spaceID string, page wikiDossierPage) string {
	var b strings.Builder
	if page.Facts == 0 && len(page.Dossiers) == 0 && len(page.Batches) == 0 {
		fmt.Fprintf(&b, "Space %s: nothing on this page, as no fact after the space's cursor has settled yet", spaceID)
	} else {
		fmt.Fprintf(&b, "Space %s: %s, %s and %s on this page, covering %s", spaceID,
			wikiCount(len(page.Dossiers), "dossier", "dossiers"), wikiCount(len(page.Batches), "batch", "batches"),
			wikiCount(len(page.ErrorClusters), "error cluster", "error clusters"), wikiCount(page.Facts, "fact", "facts"))
	}
	more := "no"
	if page.More {
		more = "yes"
	}
	fmt.Fprintf(&b, "; backlog %d after the space's cursor; more: %s.\n", page.State.Backlog, more)
	fmt.Fprintf(&b, "Cursor token: %s\n", page.Cursor)
	fmt.Fprintf(&b, "When every dossier up to it is processed: orbit wiki cursor advance --space %s --to %s\n", spaceID, page.Cursor)
	if page.More {
		fmt.Fprintf(&b, "More facts remain past this page: orbit wiki dossier --space %s --after %s reads the next.\n", spaceID, page.Cursor)
	}
	for i, dossier := range page.Dossiers {
		header := []string{fmt.Sprintf("Dossier %d of %d", i+1, len(page.Dossiers)), "session " + dossier.SessionID}
		if dossier.TaskID != "" {
			header = append(header, "task "+dossier.TaskID)
		}
		header = append(header, wikiCount(dossier.Tokens, "token", "tokens"))
		if dossier.Truncated {
			header = append(header, "truncated (cut to the budget)")
		}
		if dossier.Tainted {
			header = append(header, "tainted (it read the web)")
		}
		if dossier.Unchanged {
			header = append(header, "unchanged (already processed)")
		}
		header = append(header, "hash "+shortWikiHash(dossier.Hash))
		fmt.Fprintf(&b, "\n── %s\n%s\n", strings.Join(header, " · "), strings.TrimRight(dossier.Text, "\n"))
		sources := make([]string, 0, len(dossier.Sources))
		for _, source := range dossier.Sources {
			sources = append(sources, source.Ref+"="+source.Kind+":"+source.ID+wikiDossierSpansAt(source.Spans))
		}
		if len(sources) == 0 {
			sources = append(sources, "none")
		}
		fmt.Fprintf(&b, "sources: %s\n", strings.Join(sources, " "))
	}
	for _, batch := range page.Batches {
		header := []string{"Batch"}
		switch {
		case batch.ProjectID != "":
			header = append(header, "project "+batch.ProjectID)
		case batch.ListID != "":
			header = append(header, "list "+batch.ListID)
		}
		statuses := make([]string, 0, len(batch.ByStatus))
		for status := range batch.ByStatus {
			statuses = append(statuses, status)
		}
		sort.Strings(statuses)
		for i, status := range statuses {
			statuses[i] = fmt.Sprintf("%s %d", status, batch.ByStatus[status])
		}
		header = append(header, fmt.Sprintf("%q", batch.Template),
			fmt.Sprintf("%s (%s)", wikiCount(batch.Tasks, "task", "tasks"), strings.Join(statuses, ", ")),
			wikiCount(batch.Sessions, "session", "sessions")+" on this page")
		fmt.Fprintf(&b, "\n── %s\n", strings.Join(header, " · "))
		if len(batch.Errors) > 0 {
			errs := make([]string, 0, len(batch.Errors))
			for _, e := range batch.Errors {
				errs = append(errs, fmt.Sprintf("%s %q ×%d", e.Tool, e.Signature, e.Count))
			}
			fmt.Fprintf(&b, "   errors: %s\n", strings.Join(errs, ", "))
		}
	}
	for _, cluster := range page.ErrorClusters {
		fmt.Fprintf(&b, "\n── Error cluster · %s %q · %s, %s\n", cluster.Tool, cluster.Signature,
			wikiCount(cluster.Sessions, "session", "sessions"), wikiCount(cluster.Occurrences, "occurrence", "occurrences"))
		for _, example := range cluster.Examples {
			fmt.Fprintf(&b, "   tool call %s in session %s: %s\n", example.ToolCallID, example.SessionID, example.FirstLine)
		}
	}
	return b.String()
}

// wikiDossierSpansAt is where a line's words are in its record, as the sources line prints it:
// `@12-40,52-60`, code points of the record's redacted text.
func wikiDossierSpansAt(spans []wikiDossierSpan) string {
	if len(spans) == 0 {
		return ""
	}
	at := make([]string, 0, len(spans))
	for _, span := range spans {
		at = append(at, fmt.Sprintf("%d-%d", span.Start, span.End))
	}
	return "@" + strings.Join(at, ",")
}

// shortWikiHash is enough of a dossier's hash to tell two apart at a glance.
func shortWikiHash(hash string) string {
	if len(hash) > 12 {
		return hash[:12]
	}
	return hash
}

// describeWikiCursorAdvance says what the run's report came to: whether the cursor moved, and where
// it stands now.
func describeWikiCursorAdvance(spaceID string, answer wikiCursorAdvanceAnswer) string {
	switch {
	case answer.Outcome != "" && answer.Outcome != "succeeded":
		return fmt.Sprintf("Recorded the %s run in space %s; the cursor did not move: %s. Consecutive failures: %d.",
			answer.Outcome, spaceID, wikiCursorStands(answer.State), answer.State.ConsecutiveFailures)
	case answer.Advanced:
		return fmt.Sprintf("Advanced the cursor of space %s: %s.", spaceID, wikiCursorStands(answer.State))
	}
	return fmt.Sprintf("The cursor of space %s already stood at this token, so nothing moved, and the run is recorded "+
		"as succeeded: %s.", spaceID, wikiCursorStands(answer.State))
}

// wikiCursorStands is where a space's cursor is and what is after it, in words.
func wikiCursorStands(state wikiCursorState) string {
	where := "it has not been advanced yet"
	if state.Position != "" {
		where = "it stands at " + state.Position
	}
	return fmt.Sprintf("%s, and the backlog is %s", where, wikiCount(state.Backlog, "fact", "facts"))
}

// ── Errors, in words ────────────────────────────────────────────────────────────────────────────

// wikiCursorAdvanceError is the two refusals only an advance meets, each a sentence that says the
// cursor did not move, and everything else as the dossier route says it.
func wikiCursorAdvanceError(spaceID string, err error) error {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusConflict && httpErr.code() == wikiCursorBehindCode {
		// The refusal carries the cursor as it stands, so the sentence can say where that is.
		var refusal struct {
			State wikiCursorState `json:"state"`
		}
		_ = json.Unmarshal([]byte(httpErr.body), &refusal)
		return fmt.Errorf("orbit wiki cursor advance: the cursor of space %s is already past this token — another run "+
			"advanced it further, and it only moves forward (%s). Nothing changed: %s; what is after it is `orbit wiki "+
			"dossier --space %s`", spaceID, wikiCursorBehindCode, wikiCursorStands(refusal.State), spaceID)
	}
	return wikiMaintenanceCallError("orbit wiki cursor advance", spaceID, "--to", err)
}

// wikiMaintenanceCallError says what failed. tokenFlag is the flag that carried the command's cursor
// token, which is what a WIKI_CURSOR_INVALID is about.
func wikiMaintenanceCallError(command, spaceID, tokenFlag string, err error) error {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return fmt.Errorf("%s: %w", command, err)
	}
	code := httpErr.code()
	switch {
	case wikiDisabledByServer(err):
		return wikiCallError(command, err)
	case code == wikiNotMaintenanceSessionCode:
		return fmt.Errorf("%s: only a Wiki maintenance run of space %s reads its dossiers and moves its cursor — a "+
			"session whose task is in the space's hidden «Wiki maintenance» list — and this session is not one (%s). "+
			"Nothing was read or changed: maintenance is those tasks' work, not this session's", command, spaceID, code)
	case code == wikiCursorInvalidCode:
		return fmt.Errorf("%s: %s is not a cursor token a dossier page of space %s handed out (%s: %s). Nothing was "+
			"read or changed: pass a token a page of this space printed, as it printed it", command, tokenFlag, spaceID,
			code, refusalMessageOf(err))
	case code != "":
		return fmt.Errorf("%s: %w", command, err)
	case httpErr.statusCode == http.StatusForbidden:
		return fmt.Errorf("%s: the Orbit server does not know this session (ORBIT_SESSION_ID) as one this runner "+
			"hosts, so it answered 403 and nothing was read or changed. Run it from inside the maintenance session, "+
			"on the machine that runs it", command)
	case wikiMaintenanceDoorMissing(err):
		return fmt.Errorf("%s: this Orbit server has no Wiki maintenance door yet (it answered 404 for %s /api%s): "+
			"it predates the dossiers and the cursor, so nothing was read or changed. Upgrade the Orbit server",
			command, httpErr.method, strings.SplitN(httpErr.path, "?", 2)[0])
	case httpErr.statusCode == http.StatusNotFound:
		return fmt.Errorf("%s: this account has no wiki space %s (the server answered 404, which is its answer for "+
			"another account's space too), so nothing was read or changed. Check --space", command, spaceID)
	}
	return fmt.Errorf("%s: %w", command, err)
}

// wikiMaintenanceDoorMissing reports a control plane that predates the maintenance routes: this binary
// can be newer than the server it talks to, and a phase-1 server has the wiki door without them. A
// route Nest does not have answers 404 too, but never with a code, and never with "no such wiki
// space", the only 404 these routes give themselves.
func wikiMaintenanceDoorMissing(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound &&
		strings.HasPrefix(httpErr.path, "/runner/wiki/spaces/") && httpErr.code() == "" &&
		!strings.Contains(httpErr.body, "no such wiki space")
}
