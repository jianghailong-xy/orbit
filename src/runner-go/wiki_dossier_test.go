package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// `orbit wiki dossier` and `orbit wiki cursor advance` against a fake runner door (contract
// `maintenance`): what each verb sends, as whom, what it prints, and what each refusal reads as.

// maintenanceRequest is one request the fake maintenance door was sent.
type maintenanceRequest struct {
	method, path, uri, session string
	query                      url.Values
	body                       map[string]interface{}
}

// wikiMaintenanceDoor is the runner door's maintenance routes, answering each request with what
// reply says and recording every one, and a runner config pointing the CLI at it from inside the
// maintenance session a run would be.
func wikiMaintenanceDoor(t *testing.T, reply func(r *http.Request) (int, string)) func() []maintenanceRequest {
	t.Helper()
	var mu sync.Mutex
	var requests []maintenanceRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := maintenanceRequest{
			method: r.Method, path: r.URL.Path, uri: r.URL.RequestURI(), query: r.URL.Query(),
			session: r.Header.Get("X-Orbit-Session-Id"),
		}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &request.body); err != nil {
				t.Errorf("%s %s sent a body that is not JSON: %s", r.Method, r.URL.Path, raw)
			}
		}
		mu.Lock()
		requests = append(requests, request)
		mu.Unlock()
		status, body := reply(r)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	home := t.TempDir()
	// The command refuses an ORBIT_HOME anybody else could look into, so the fixture is private too.
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"serverUrl":` + strconv.Quote(srv.URL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "maintenance-session")
	t.Setenv(envWiki, "on")
	return func() []maintenanceRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]maintenanceRequest{}, requests...)
	}
}

// wikiDoorAnswer answers every request the same way.
func wikiDoorAnswer(status int, body string) func(*http.Request) (int, string) {
	return func(*http.Request) (int, string) { return status, body }
}

// wikiDossierPageReply is a page as the server hands it out: two dossiers (one cut to the budget and
// tainted, one already processed), a batch project's counts and an error cluster.
const wikiDossierPageReply = `{"spaceId":"space-1","cursor":"wc1.page-end","more":true,"facts":5,` +
	`"dossiers":[` +
	`{"sessionId":"s-alpha","taskId":"t-alpha","title":"Fix the trigram index",` +
	`"text":"SESSION: Fix the trigram index\nL1 owner: use pg_trgm, not ILIKE\nL2 $ npm test -> 3 failed","tokens":812,` +
	`"truncated":true,"tainted":true,"sources":[{"ref":"L1","kind":"turn","id":"turn-1"},{"ref":"L2","kind":"tool_call","id":"tc-2"}],` +
	`"hash":"3f2a9c1d04be77aa01","unchanged":false},` +
	`{"sessionId":"s-beta","taskId":null,"title":"Tidy","text":"SESSION: Tidy\nL1 done\n","tokens":40,"truncated":false,"tainted":false,` +
	`"sources":[{"ref":"L1","kind":"event","id":"ev-9"}],"hash":"0badc0ffee00","unchanged":true}],` +
	`"batches":[{"projectId":"p-fine","listId":null,"template":"Process shard #","tasks":120,"byStatus":{"FAILED":20,"DONE":100},` +
	`"sessions":3,"errors":[{"tool":"Bash","signature":"curl: (#) Could not resolve host","count":4}]}],` +
	`"errorClusters":[{"tool":"Bash","signature":"npm ERR! code E#","sessions":5,"occurrences":9,` +
	`"examples":[{"toolCallId":"tc-7","sessionId":"s-alpha","firstLine":"npm ERR! code E404"}]}],` +
	`"state":{"spaceId":"space-1","position":"wc1.watermark","backlog":40,"byKind":{"session_settled":30,"task_terminal":10,` +
	`"approval_answered":0,"merge_receipt":0,"criterion_revised":0},"pendingSessions":12,"oldestPendingAt":"2026-09-27T10:00:00.000Z",` +
	`"lagSeconds":3600,"lastOkAt":null,"lastRunAt":null,"lastOutcome":null,"consecutiveFailures":0,"lastError":null,` +
	`"due":{"backlog":true,"age":false}}}`

// wikiCursorStateReply is a cursor's state as both routes answer it; an empty position is a cursor
// never advanced.
func wikiCursorStateReply(position string, backlog, failures int) string {
	where := "null"
	if position != "" {
		where = strconv.Quote(position)
	}
	return `{"spaceId":"space-1","position":` + where + `,"backlog":` + strconv.Itoa(backlog) + `,"byKind":{"session_settled":` +
		strconv.Itoa(backlog) + `,"task_terminal":0,"approval_answered":0,"merge_receipt":0,"criterion_revised":0},` +
		`"pendingSessions":0,"oldestPendingAt":null,"lagSeconds":0,"lastOkAt":null,"lastRunAt":null,"lastOutcome":null,` +
		`"consecutiveFailures":` + strconv.Itoa(failures) + `,"lastError":null,"due":{"backlog":false,"age":false}}`
}

// wikiCursorAdvanceReply is the cursor route's 200.
func wikiCursorAdvanceReply(advanced bool, outcome, position string, backlog, failures int) string {
	return `{"advanced":` + strconv.FormatBool(advanced) + `,"outcome":"` + outcome + `","state":` +
		wikiCursorStateReply(position, backlog, failures) + `}`
}

func wikiMaintenanceContract(t *testing.T) map[string]interface{} {
	t.Helper()
	return wikiContract(t)["maintenance"].(map[string]interface{})
}

func wikiCLICapability(t *testing.T, tool string) cliCapabilitySpec {
	t.Helper()
	for _, spec := range wikiCLICapabilities {
		if spec.Tool == tool {
			return spec
		}
	}
	t.Fatalf("no %s among the wiki capabilities", tool)
	return cliCapabilitySpec{}
}

// collapsedSpace is text with every run of whitespace one space: a usage line the help wraps is
// still the one line the contract writes.
func collapsedSpace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func assertSaysAll(t *testing.T, what, text string, phrases ...string) {
	t.Helper()
	for _, phrase := range phrases {
		if !strings.Contains(text, phrase) {
			t.Errorf("%s does not say %q:\n%s", what, phrase, text)
		}
	}
}

// ── orbit wiki dossier ──────────────────────────────────────────────────────────────────────────

func TestWikiDossierReadsAPageAsTheCallingSession(t *testing.T) {
	requests := wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, wikiDossierPageReply))

	var out strings.Builder
	if err := cmdWikiCLI([]string{"dossier", "--space", "space-1", "--after", "wc1.before", "--limit", "5"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki dossier: %v", err)
	}
	sent := requests()
	if len(sent) != 1 {
		t.Fatalf("requests = %#v, want one page read", sent)
	}
	if sent[0].method != http.MethodGet || sent[0].path != "/api/runner/wiki/spaces/space-1/dossiers" {
		t.Errorf("the page was read with %s %s", sent[0].method, sent[0].path)
	}
	if !reflect.DeepEqual(sent[0].query, url.Values{"after": {"wc1.before"}, "limit": {"5"}}) {
		t.Errorf("the page was asked for with %v, want the flags' after and limit", sent[0].query)
	}
	if sent[0].session != "maintenance-session" {
		t.Errorf("the page was read as session %q, not the one the command runs in", sent[0].session)
	}

	text := out.String()
	assertSaysAll(t, "the page", text,
		"Space space-1: 2 dossiers, 1 batch and 1 error cluster on this page, covering 5 facts; backlog 40 after the space's cursor; more: yes.\n",
		"Cursor token: wc1.page-end\n",
		"When every dossier up to it is processed: orbit wiki cursor advance --space space-1 --to wc1.page-end\n",
		"More facts remain past this page: orbit wiki dossier --space space-1 --after wc1.page-end reads the next.\n",
		"\n── Dossier 1 of 2 · session s-alpha · task t-alpha · 812 tokens · truncated (cut to the budget) · tainted (it read the web) · hash 3f2a9c1d04be\n"+
			"SESSION: Fix the trigram index\nL1 owner: use pg_trgm, not ILIKE\nL2 $ npm test -> 3 failed\n"+
			"sources: L1=turn:turn-1 L2=tool_call:tc-2\n",
		"\n── Dossier 2 of 2 · session s-beta · 40 tokens · unchanged (already processed) · hash 0badc0ffee00\n"+
			"SESSION: Tidy\nL1 done\nsources: L1=event:ev-9\n",
		"\n── Batch · project p-fine · \"Process shard #\" · 120 tasks (DONE 100, FAILED 20) · 3 sessions on this page\n",
		"   errors: Bash \"curl: (#) Could not resolve host\" ×4\n",
		"\n── Error cluster · Bash \"npm ERR! code E#\" · 5 sessions, 9 occurrences\n",
		"   tool call tc-7 in session s-alpha: npm ERR! code E404\n",
	)
	// The command that ends the run comes before the first dossier: a run that stops reading half way
	// still knows how to say what it processed.
	if strings.Index(text, "orbit wiki cursor advance") > strings.Index(text, "── Dossier 1") {
		t.Errorf("the follow-up command is printed after the dossiers:\n%s", text)
	}

	// Without --after or --limit the page starts at the space's cursor, at the size the server gives.
	out.Reset()
	if err := cmdWikiCLI([]string{"dossier", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki dossier: %v", err)
	}
	if sent := requests(); len(sent) != 2 || sent[1].uri != "/api/runner/wiki/spaces/space-1/dossiers" {
		t.Errorf("a page with no flags was asked for as %#v, want no query at all", sent)
	}
}

func TestWikiDossierSaysSoWhenThePageIsEmpty(t *testing.T) {
	empty := `{"spaceId":"space-1","cursor":"wc1.watermark","more":false,"facts":0,"dossiers":[],"batches":[],"errorClusters":[],` +
		`"state":` + wikiCursorStateReply("wc1.watermark", 2, 0) + `}`
	wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, empty))
	var out strings.Builder
	if err := cmdWikiCLI([]string{"dossier", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki dossier: %v", err)
	}
	assertSaysAll(t, "an empty page", out.String(),
		"Space space-1: nothing on this page, as no fact after the space's cursor has settled yet; backlog 2 after the space's cursor; more: no.\n",
		"orbit wiki cursor advance --space space-1 --to wc1.watermark\n")
	if strings.Contains(out.String(), "--after") || strings.Contains(out.String(), "──") {
		t.Errorf("an empty page with nothing past it offers a next page or a section:\n%s", out.String())
	}
}

func TestWikiDossierJSONIsTheServersPage(t *testing.T) {
	wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, wikiDossierPageReply))
	var out strings.Builder
	if err := cmdWikiCLI([]string{"dossier", "--space", "space-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki dossier --json: %v", err)
	}
	var got, want interface{}
	if err := json.Unmarshal([]byte(out.String()), &got); err != nil {
		t.Fatalf("--json printed something that is not JSON: %v\n%s", err, out.String())
	}
	if err := json.Unmarshal([]byte(wikiDossierPageReply), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("--json printed\n%v\nwant the server's page whole\n%v", got, want)
	}
	if strings.Count(strings.TrimSpace(out.String()), "\n") != 0 {
		t.Errorf("--json is not one compact line:\n%s", out.String())
	}
}

func TestWikiDossierLimitIsOneToTheContractsMax(t *testing.T) {
	rules := wikiMaintenanceContract(t)["rules"].(map[string]interface{})
	if float64(wikiDossierPageSessionsMax) != rules["pageSessionsMax"].(float64) ||
		float64(wikiDossierPageSessionsDefault) != rules["pageSessionsDefault"].(float64) {
		t.Fatalf("a page carries %d sessions at most and %d by default here, the contract says %v and %v",
			wikiDossierPageSessionsMax, wikiDossierPageSessionsDefault, rules["pageSessionsMax"], rules["pageSessionsDefault"])
	}
	requests := wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, wikiDossierPageReply))
	for _, limit := range []string{"0", "-1", "51"} {
		err := cmdWikiCLI([]string{"dossier", "--space", "space-1", "--limit", limit}, strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "--limit must be a whole number from 1 to 50") {
			t.Errorf("--limit %s = %v, want it refused", limit, err)
		}
	}
	if err := cmdWikiCLI([]string{"dossier", "--space", "space-1", "--limit", "many"}, strings.NewReader(""), io.Discard); err == nil {
		t.Error("--limit many was accepted")
	}
	if err := cmdWikiCLI([]string{"dossier"}, strings.NewReader(""), io.Discard); err == nil || !strings.Contains(err.Error(), "--space is required") {
		t.Errorf("no --space = %v", err)
	}
	if sent := requests(); len(sent) != 0 {
		t.Fatalf("a refused page reached the server: %#v", sent)
	}
	for _, limit := range []string{"1", "50"} {
		if err := cmdWikiCLI([]string{"dossier", "--space", "space-1", "--limit", limit}, strings.NewReader(""), io.Discard); err != nil {
			t.Errorf("--limit %s: %v", limit, err)
		}
	}
	if sent := requests(); len(sent) != 2 || sent[0].query.Get("limit") != "1" || sent[1].query.Get("limit") != "50" {
		t.Errorf("the bounds were not sent as given: %#v", sent)
	}
	// The schema states the same bounds the parser holds a caller to.
	limit := wikiCLICapability(t, "wiki_dossier").InputSchema["properties"].(map[string]interface{})["limit"].(map[string]interface{})
	if limit["minimum"] != 1 || limit["maximum"] != wikiDossierPageSessionsMax {
		t.Errorf("the schema's limit = %#v", limit)
	}
}

func TestWikiDossierRefusalsAreSentences(t *testing.T) {
	assertWikiMaintenanceRefusals(t, []string{"dossier", "--space", "space-1"}, "orbit wiki dossier",
		"GET /api/runner/wiki/spaces/space-1/dossiers")

	// A token the page cannot start after is about --after, the flag that carried it.
	requests := wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusBadRequest,
		`{"code":"WIKI_CURSOR_INVALID","message":"the token is not a cursor token: a cursor token is what a dossier page of this space handed out, passed on unchanged"}`))
	var out strings.Builder
	err := cmdWikiCLI([]string{"dossier", "--space", "space-1", "--after", "not-a-token"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a token the server refused read as a page")
	}
	assertSaysAll(t, "the refusal", err.Error(), "orbit wiki dossier: --after is not a cursor token a dossier page of space space-1 handed out",
		"WIKI_CURSOR_INVALID: the token is not a cursor token", "Nothing was read or changed")
	if out.Len() != 0 || len(requests()) != 1 {
		t.Errorf("printed %q after %d requests", out.String(), len(requests()))
	}
}

// assertWikiMaintenanceRefusals runs argv against each refusal the maintenance routes share, and
// holds each to a sentence that says what happened rather than a status and a body.
func assertWikiMaintenanceRefusals(t *testing.T, argv []string, command, route string) {
	t.Helper()
	method, path, _ := strings.Cut(route, " ")
	for _, tc := range []struct {
		name   string
		status int
		reply  string
		says   []string
		never  []string
	}{
		{
			name:   "a session that is not the space's maintenance run",
			status: http.StatusForbidden,
			reply: `{"code":"WIKI_NOT_MAINTENANCE_SESSION","message":"only a Wiki maintenance run of this space reads its ` +
				`dossiers or moves its cursor: a session whose task is in the space's hidden «Wiki maintenance» list. This session is not one."}`,
			says: []string{command + ": only a Wiki maintenance run of space space-1", "hidden «Wiki maintenance» list",
				"this session is not one (WIKI_NOT_MAINTENANCE_SESSION)", "Nothing was read or changed"},
			never: []string{"-> 403"},
		},
		{
			name:   "a session this runner does not host",
			status: http.StatusForbidden,
			reply:  `{"statusCode":403,"message":"X-Orbit-Session-Id names no session this runner hosts","error":"Forbidden"}`,
			says:   []string{command + ": the Orbit server does not know this session (ORBIT_SESSION_ID)", "answered 403"},
			never:  []string{"WIKI_NOT_MAINTENANCE_SESSION", "{"},
		},
		{
			name:   "a server older than the maintenance door",
			status: http.StatusNotFound,
			reply:  `{"message":"Cannot ` + method + " " + path + `","error":"Not Found","statusCode":404}`,
			says:   []string{command + ": this Orbit server has no Wiki maintenance door yet", "it answered 404 for " + route, "Upgrade the Orbit server"},
			never:  []string{"no wiki space", "{"},
		},
		{
			name:   "a space of another account, or none",
			status: http.StatusNotFound,
			reply:  `{"statusCode":404,"message":"no such wiki space","error":"Not Found"}`,
			says:   []string{command + ": this account has no wiki space space-1", "Check --space"},
			never:  []string{"door", "Upgrade"},
		},
		{
			name:   "the wiki switched off for the account",
			status: http.StatusNotFound,
			reply:  `{"code":"WIKI_DISABLED","message":"the wiki is off for this account"}`,
			says:   []string{command + ": the Orbit wiki is not switched on", wikiDisabledCode},
			never:  []string{"door", "no wiki space"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := wikiMaintenanceDoor(t, wikiDoorAnswer(tc.status, tc.reply))
			var out strings.Builder
			err := cmdWikiCLI(argv, strings.NewReader(""), &out)
			if err == nil {
				t.Fatalf("%s answered %d and the command succeeded:\n%s", route, tc.status, out.String())
			}
			assertSaysAll(t, "the error", err.Error(), tc.says...)
			for _, phrase := range tc.never {
				if strings.Contains(err.Error(), phrase) {
					t.Errorf("the error says %q, which is not what happened: %v", phrase, err)
				}
			}
			if out.Len() != 0 {
				t.Errorf("a refusal printed an answer: %q", out.String())
			}
			if sent := requests(); len(sent) != 1 || sent[0].method+" "+sent[0].path != route {
				t.Errorf("requests = %#v, want the one call to %s", sent, route)
			}
		})
	}
}

// The precondition, word for word, before the mechanics; the usage, as the contract writes it; and
// a CLI-only verb whose schema is exactly the flags its parser takes.
func TestWikiDossierCopyIsTheContracts(t *testing.T) {
	cli := wikiMaintenanceContract(t)["cli"].(map[string]interface{})
	if cli["dossierPrecondition"] != wikiDossierPrecondition {
		t.Fatalf("the precondition this binary ships is not the contract's:\n here: %q\n there: %q", wikiDossierPrecondition, cli["dossierPrecondition"])
	}
	spec := wikiCLICapability(t, "wiki_dossier")
	if spec.Usage != cli["dossier"] {
		t.Errorf("the usage is %q here and %q in the contract", spec.Usage, cli["dossier"])
	}
	help := wikiActionHelp["dossier"]
	for what, text := range map[string]string{"orbit wiki dossier --help": help, "orbit wiki --help": wikiHelp} {
		if !strings.Contains(collapsedSpace(text), cli["dossier"].(string)) {
			t.Errorf("`%s` does not carry the contract's usage %q", what, cli["dossier"])
		}
	}
	if !strings.HasPrefix(spec.Description, wikiDossierPrecondition) {
		t.Errorf("the capability's description does not lead with the precondition: %q", spec.Description)
	}
	if !strings.Contains(help, wikiDossierPrecondition) || strings.Index(help, wikiDossierPrecondition) > strings.Index(help, "A page is the facts") {
		t.Error("the help does not state the precondition before the mechanics")
	}
	if !reflect.DeepEqual(spec.Argv, []string{"orbit", "wiki", "dossier"}) || !spec.SessionOnly || spec.Mutates {
		t.Errorf("the capability is %#v, want a session-only read at `orbit wiki dossier`", spec)
	}
	assertWikiCLIOnlyVerb(t, spec, "dossier", []string{"after", "limit", "space"}, cli["tool"])
}

// ── orbit wiki cursor advance ───────────────────────────────────────────────────────────────────

func TestWikiCursorAdvanceMovesTheCursorForASucceededRun(t *testing.T) {
	reply := wikiCursorAdvanceReply(true, "succeeded", "wc1.page-end", 12, 0)
	requests := wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, reply))

	var out strings.Builder
	if err := cmdWikiCLI([]string{"cursor", "advance", "--space", "space-1", "--to", "wc1.page-end"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki cursor advance: %v", err)
	}
	sent := requests()
	if len(sent) != 1 || sent[0].method != http.MethodPost || sent[0].uri != "/api/runner/wiki/spaces/space-1/cursor" {
		t.Fatalf("requests = %#v, want one POST to the space's cursor", sent)
	}
	if sent[0].session != "maintenance-session" {
		t.Errorf("the cursor was advanced as session %q, not the one the command runs in", sent[0].session)
	}
	if want := map[string]interface{}{"to": "wc1.page-end", "outcome": "succeeded"}; !reflect.DeepEqual(sent[0].body, want) {
		t.Errorf("the body = %#v, want %#v", sent[0].body, want)
	}
	if got := out.String(); got != "Advanced the cursor of space space-1: it stands at wc1.page-end, and the backlog is 12 facts.\n" {
		t.Errorf("the output = %q", got)
	}

	// --json prints the server's answer whole, for a script.
	out.Reset()
	if err := cmdWikiCLI([]string{"cursor", "advance", "--space", "space-1", "--to", "wc1.page-end", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki cursor advance --json: %v", err)
	}
	var got, want interface{}
	if err := json.Unmarshal([]byte(out.String()), &got); err != nil {
		t.Fatalf("--json printed something that is not JSON: %v\n%s", err, out.String())
	}
	_ = json.Unmarshal([]byte(reply), &want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("--json printed %v, want the server's answer %v", got, want)
	}
}

func TestWikiCursorAdvanceToWhereItStandsMovesNothing(t *testing.T) {
	wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, wikiCursorAdvanceReply(false, "succeeded", "wc1.page-end", 1, 0)))
	var out strings.Builder
	if err := cmdWikiCLI([]string{"cursor", "advance", "--space", "space-1", "--to", "wc1.page-end"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("a success that moves nothing is still a success: %v", err)
	}
	if got := out.String(); got != "The cursor of space space-1 already stood at this token, so nothing moved, and the run is "+
		"recorded as succeeded: it stands at wc1.page-end, and the backlog is 1 fact.\n" {
		t.Errorf("the output = %q", got)
	}
}

func TestWikiCursorFailedAndTruncatedRunsAreRecordedAndMoveNothing(t *testing.T) {
	for _, tc := range []struct {
		outcome, to, position string
		wantBody              map[string]interface{}
		says                  string
	}{
		{
			outcome: "failed", position: "wc1.watermark",
			wantBody: map[string]interface{}{"outcome": "failed", "error": "the model endpoint answered 401"},
			says: "Recorded the failed run in space space-1; the cursor did not move: it stands at wc1.watermark, and the " +
				"backlog is 40 facts. Consecutive failures: 3.\n",
		},
		{
			// A cut-short run may name the page it got to; that moves nothing either.
			outcome: "truncated", to: "wc1.page-end",
			wantBody: map[string]interface{}{"outcome": "truncated", "to": "wc1.page-end", "error": "the model endpoint answered 401"},
			says: "Recorded the truncated run in space space-1; the cursor did not move: it has not been advanced yet, and " +
				"the backlog is 40 facts. Consecutive failures: 3.\n",
		},
	} {
		t.Run(tc.outcome, func(t *testing.T) {
			requests := wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, wikiCursorAdvanceReply(false, tc.outcome, tc.position, 40, 3)))
			argv := []string{"cursor", "advance", "--space", "space-1", "--outcome", tc.outcome, "--error", "  the model endpoint answered 401 "}
			if tc.to != "" {
				argv = append(argv, "--to", tc.to)
			}
			var out strings.Builder
			if err := cmdWikiCLI(argv, strings.NewReader(""), &out); err != nil {
				t.Fatalf("a recorded failure exits non-zero: %v", err)
			}
			if sent := requests(); len(sent) != 1 || !reflect.DeepEqual(sent[0].body, tc.wantBody) {
				t.Errorf("requests = %#v, want one with the body %#v", sent, tc.wantBody)
			}
			if out.String() != tc.says {
				t.Errorf("the output = %q\nwant %q", out.String(), tc.says)
			}
		})
	}
}

func TestWikiCursorToIsRequiredOnlyForASucceededRun(t *testing.T) {
	requests := wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, wikiCursorAdvanceReply(false, "failed", "", 5, 1)))
	for _, argv := range [][]string{
		{"cursor", "advance", "--space", "space-1"},
		{"cursor", "advance", "--space", "space-1", "--outcome", "succeeded", "--to", "  "},
	} {
		err := cmdWikiCLI(argv, strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "--to is required when the run succeeded") || !strings.Contains(err.Error(), "--outcome failed") {
			t.Errorf("%v = %v, want --to asked for", argv, err)
		}
	}
	if sent := requests(); len(sent) != 0 {
		t.Fatalf("a succeeded run with no token reached the server: %#v", sent)
	}
	for _, outcome := range []string{"failed", "truncated"} {
		if err := cmdWikiCLI([]string{"cursor", "advance", "--space", "space-1", "--outcome", outcome}, strings.NewReader(""), io.Discard); err != nil {
			t.Errorf("a %s run with no token: %v", outcome, err)
		}
	}
	for _, sent := range requests() {
		if _, named := sent.body["to"]; named || sent.body["error"] != nil {
			t.Errorf("a run with no --to or --error sent %#v", sent.body)
		}
	}
	if len(requests()) != 2 {
		t.Errorf("requests = %#v, want the two failures recorded", requests())
	}
	if err := cmdWikiCLI([]string{"cursor", "advance", "--to", "wc1.x"}, strings.NewReader(""), io.Discard); err == nil || !strings.Contains(err.Error(), "--space is required") {
		t.Errorf("no --space = %v", err)
	}
}

func TestWikiCursorOutcomesAreTheContracts(t *testing.T) {
	var declared []string
	for _, outcome := range wikiMaintenanceContract(t)["cursor"].(map[string]interface{})["advance"].(map[string]interface{})["outcomes"].([]interface{}) {
		declared = append(declared, outcome.(string))
	}
	if !reflect.DeepEqual(wikiCursorOutcomes, declared) {
		t.Fatalf("outcomes here %v, in the contract %v", wikiCursorOutcomes, declared)
	}
	spec := wikiCLICapability(t, "wiki_cursor_advance")
	outcome := spec.InputSchema["properties"].(map[string]interface{})["outcome"].(map[string]interface{})
	if !reflect.DeepEqual(outcome["enum"], wikiCursorOutcomes) {
		t.Errorf("the schema offers outcomes %v", outcome["enum"])
	}
	if !strings.Contains(spec.Usage, "--outcome "+strings.Join(wikiCursorOutcomes, "|")) {
		t.Errorf("the usage does not name the outcomes: %q", spec.Usage)
	}
	requests := wikiMaintenanceDoor(t, wikiDoorAnswer(http.StatusOK, wikiCursorAdvanceReply(false, "failed", "", 0, 1)))
	for _, bad := range []string{"done", "Succeeded", ""} {
		err := cmdWikiCLI([]string{"cursor", "advance", "--space", "space-1", "--to", "wc1.x", "--outcome", bad}, strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "--outcome must be one of succeeded, failed, truncated") {
			t.Errorf("--outcome %q = %v", bad, err)
		}
	}
	if sent := requests(); len(sent) != 0 {
		t.Errorf("an outcome the contract does not have reached the server: %#v", sent)
	}
}

func TestWikiCursorBehindAndInvalidTokensFail(t *testing.T) {
	behind := `{"code":"WIKI_CURSOR_BEHIND","message":"the cursor is already past this token: another run advanced it further, ` +
		`and it only moves forward","state":` + wikiCursorStateReply("wc1.further", 3, 0) + `}`
	invalid := `{"code":"WIKI_CURSOR_INVALID","message":"the token names a position past every page this space has handed out"}`
	for _, tc := range []struct {
		name   string
		status int
		reply  string
		says   []string
	}{
		{"behind the cursor", http.StatusConflict, behind, []string{
			"orbit wiki cursor advance: the cursor of space space-1 is already past this token", "(WIKI_CURSOR_BEHIND)",
			"Nothing changed: it stands at wc1.further, and the backlog is 3 facts", "orbit wiki dossier --space space-1",
		}},
		{"a token no page handed out", http.StatusBadRequest, invalid, []string{
			"orbit wiki cursor advance: --to is not a cursor token a dossier page of space space-1 handed out",
			"WIKI_CURSOR_INVALID: the token names a position past every page this space has handed out", "Nothing was read or changed",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wikiMaintenanceDoor(t, wikiDoorAnswer(tc.status, tc.reply))
			for _, extra := range [][]string{nil, {"--json"}} {
				var out strings.Builder
				argv := append([]string{"cursor", "advance", "--space", "space-1", "--to", "wc1.page-end"}, extra...)
				err := cmdWikiCLI(argv, strings.NewReader(""), &out)
				if err == nil {
					t.Fatalf("%v answered %d and the command exits 0: %q", argv, tc.status, out.String())
				}
				assertSaysAll(t, "the error", err.Error(), tc.says...)
				if out.Len() != 0 {
					t.Errorf("a refused advance printed an answer: %q", out.String())
				}
			}
		})
	}
}

func TestWikiCursorRefusalsAreSentences(t *testing.T) {
	assertWikiMaintenanceRefusals(t, []string{"cursor", "advance", "--space", "space-1", "--to", "wc1.page-end"},
		"orbit wiki cursor advance", "POST /api/runner/wiki/spaces/space-1/cursor")
}

// The cursor's one command is named: asking for the cursor alone shows what there is, and any other
// word is refused naming the one that exists — before anything is read or sent.
func TestWikiCursorNeedsItsCommand(t *testing.T) {
	t.Setenv(envWiki, "on")
	t.Setenv("ORBIT_SESSION_ID", "maintenance-session")
	t.Setenv("ORBIT_HOME", t.TempDir())
	help := wikiActionHelp["cursor"]
	for _, argv := range [][]string{{"cursor"}, {"cursor", "--help"}, {"cursor", "advance", "--help"}, {"help", "cursor"}} {
		var out strings.Builder
		if err := cmdWikiCLI(argv, strings.NewReader(""), &out); err != nil || out.String() != help {
			t.Errorf("orbit wiki %s = %v, %q; want the cursor's help", strings.Join(argv, " "), err, out.String())
		}
	}
	for _, word := range []string{"reset", "--space", "advanced"} {
		err := cmdWikiCLI([]string{"cursor", word, "--space", "space-1"}, strings.NewReader(""), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "unknown cursor command "+strconv.Quote(word)) ||
			!strings.Contains(err.Error(), "orbit wiki cursor advance --space <id> --to <token>") {
			t.Errorf("orbit wiki cursor %s = %v, want it refused naming advance", word, err)
		}
	}
	assertSaysAll(t, "`orbit wiki cursor --help`", help, "advance ", "--space", "--to", "--outcome", "--error", "--json")
	assertSaysAll(t, "`orbit wiki dossier --help`", wikiActionHelp["dossier"], "--space", "--after", "--limit", "--json")
}

func TestWikiCursorCopyIsTheContracts(t *testing.T) {
	cli := wikiMaintenanceContract(t)["cli"].(map[string]interface{})
	if cli["cursorPrecondition"] != wikiCursorPrecondition {
		t.Fatalf("the precondition this binary ships is not the contract's:\n here: %q\n there: %q", wikiCursorPrecondition, cli["cursorPrecondition"])
	}
	spec := wikiCLICapability(t, "wiki_cursor_advance")
	if spec.Usage != cli["cursorAdvance"] {
		t.Errorf("the usage is %q here and %q in the contract", spec.Usage, cli["cursorAdvance"])
	}
	help := wikiActionHelp["cursor"]
	for what, text := range map[string]string{"orbit wiki cursor --help": help, "orbit wiki --help": wikiHelp} {
		if !strings.Contains(collapsedSpace(text), cli["cursorAdvance"].(string)) {
			t.Errorf("`%s` does not carry the contract's usage %q", what, cli["cursorAdvance"])
		}
	}
	if !strings.HasPrefix(spec.Description, wikiCursorPrecondition) {
		t.Errorf("the capability's description does not lead with the precondition: %q", spec.Description)
	}
	if !strings.Contains(help, wikiCursorPrecondition) || strings.Index(help, wikiCursorPrecondition) > strings.Index(help, "Only a succeeded run moves") {
		t.Error("the help does not state the precondition before the mechanics")
	}
	if !reflect.DeepEqual(spec.Argv, []string{"orbit", "wiki", "cursor", "advance"}) || !spec.SessionOnly || !spec.Mutates {
		t.Errorf("the capability is %#v, want a session-only write at `orbit wiki cursor advance`", spec)
	}
	for _, phrase := range []string{"WIKI_CURSOR_BEHIND", "WIKI_CURSOR_INVALID", "exits 0", "exit non-zero", "moves nothing"} {
		if !strings.Contains(spec.Description, phrase) {
			t.Errorf("the description does not say %q", phrase)
		}
	}
	assertWikiCLIOnlyVerb(t, spec, "cursor advance", []string{"error", "outcome", "space", "to"}, cli["tool"])

	// The refusals these verbs name are the contract's, at the statuses the contract gives them.
	statuses := map[string]float64{}
	for _, raw := range wikiContract(t)["refusals"].([]interface{}) {
		refusal := raw.(map[string]interface{})
		if code, ok := refusal["code"].(string); ok {
			statuses[code], _ = refusal["httpStatus"].(float64)
		}
	}
	for code, status := range map[string]float64{wikiNotMaintenanceSessionCode: 403, wikiCursorBehindCode: 409, wikiCursorInvalidCode: 400} {
		if statuses[code] != status {
			t.Errorf("the contract has %s at %v, this binary reads it at %v", code, statuses[code], status)
		}
	}
}

// assertWikiCLIOnlyVerb holds a maintenance verb to what the contract says of it — no MCP tool beside
// it — and its schema to exactly the flags its parser takes, with --space the one always required.
func assertWikiCLIOnlyVerb(t *testing.T, spec cliCapabilitySpec, verb string, flags []string, tool interface{}) {
	t.Helper()
	if text, _ := tool.(string); !strings.HasPrefix(text, "none") {
		t.Errorf("the contract gives the maintenance verbs a tool: %q", text)
	}
	if wikiToolNames[spec.Tool] || hasMCPTool(toolDescriptors(true, true), spec.Tool) {
		t.Errorf("%s is served as an MCP tool, and the contract says it has none", spec.Tool)
	}
	properties, _ := spec.InputSchema["properties"].(map[string]interface{})
	names := []string{}
	for name := range properties {
		names = append(names, name)
		if !writtenFlagIsParsed(verb, name) {
			t.Errorf("the schema names --%s, which `orbit wiki %s` does not take", name, verb)
		}
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, flags) || !reflect.DeepEqual(spec.InputSchema["required"], []string{"space"}) {
		t.Errorf("the schema = %#v, want the properties %v with space required", spec.InputSchema, flags)
	}
}

// ── Both ────────────────────────────────────────────────────────────────────────────────────────

// The routes the two verbs call are the contract's own: the dossier route and the cursor route, each
// one of the runner door's maintenance routes, and nothing else.
func TestWikiDossierAndCursorCallTheContractsMaintenanceRoutes(t *testing.T) {
	requests := wikiMaintenanceDoor(t, func(r *http.Request) (int, string) {
		if r.Method == http.MethodGet {
			return http.StatusOK, wikiDossierPageReply
		}
		return http.StatusOK, wikiCursorAdvanceReply(true, "succeeded", "wc1.page-end", 0, 0)
	})
	if err := cmdWikiCLI([]string{"dossier", "--space", "space-1", "--after", "wc1.before"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki dossier: %v", err)
	}
	if err := cmdWikiCLI([]string{"cursor", "advance", "--space", "space-1", "--to", "wc1.page-end"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki cursor advance: %v", err)
	}
	called := []string{}
	for _, sent := range requests() {
		called = append(called, sent.method+" "+strings.Replace(sent.path, "/spaces/space-1/", "/spaces/:id/", 1))
	}
	maintenance := wikiMaintenanceContract(t)
	want := []string{
		maintenance["dossier"].(map[string]interface{})["route"].(string),
		maintenance["cursor"].(map[string]interface{})["advance"].(map[string]interface{})["route"].(string),
	}
	if !reflect.DeepEqual(called, want) {
		t.Fatalf("the verbs called %v, the contract's routes are %v", called, want)
	}
	runner := wikiSurface(t)["doors"].(map[string]interface{})["runner"].(map[string]interface{})
	listed := map[string]bool{}
	for _, route := range runner["maintenanceRoutes"].([]interface{}) {
		listed[route.(string)] = true
	}
	for _, route := range called {
		if !listed[route] {
			t.Errorf("%s is not one of the runner door's maintenance routes %v", route, runner["maintenanceRoutes"])
		}
	}
}
