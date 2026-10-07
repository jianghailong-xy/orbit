package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// The person's side of `orbit task`, `orbit project` and `orbit session`
// (docs/personal-access-token-design.md §7.3), held against two control planes at once: the one the
// person's saved login names, and the one this machine's runner is registered with. Every command
// that runs as the person must reach the first on a user route with the personal access token; every
// one that does not must be refused before anything is sent; and nothing may ever reach the second,
// because a request there is the runner's credential used in the person's place.

// apiRequest is one request a fake control plane received.
type apiRequest struct {
	method, path, query, authorization, sessionHeader, body string
}

// recordingAPI records every request it is sent and answers each with answer.
type recordingAPI struct {
	*httptest.Server
	mu       sync.Mutex
	requests []apiRequest
}

func newRecordingAPI(t *testing.T, answer func(apiRequest) (int, string)) *recordingAPI {
	t.Helper()
	api := &recordingAPI{}
	api.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		req := apiRequest{
			method: r.Method, path: r.URL.Path, query: r.URL.RawQuery,
			authorization: r.Header.Get("Authorization"), sessionHeader: r.Header.Get("X-Orbit-Session-Id"),
			body: string(body),
		}
		api.mu.Lock()
		api.requests = append(api.requests, req)
		api.mu.Unlock()
		status, text := answer(req)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, text)
	}))
	t.Cleanup(api.Close)
	return api
}

func (a *recordingAPI) seen() []apiRequest {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]apiRequest{}, a.requests...)
}

// answerAsUserRoutes answers as the user API does: 401 to any token but the one the person saved, and
// for anything else a body naming the route that answered it — what a command has to print untouched.
// The task page is the exception, because `task list` prints its rows: two pages, joined by a cursor.
func answerAsUserRoutes(r apiRequest) (int, string) {
	if r.authorization != "Bearer "+laptopToken {
		return http.StatusUnauthorized, `{"message":"invalid token","error":"Unauthorized","statusCode":401}`
	}
	if r.method == http.MethodGet && r.path == "/api/tasks/page" {
		if strings.Contains(r.query, "cursor=c2") {
			return http.StatusOK, `{"items":[{"id":"t2","title":"second"}],"nextCursor":null}`
		}
		return http.StatusOK, `{"items":[{"id":"t1","title":"first"}],"nextCursor":"c2"}`
	}
	return http.StatusOK, `{"answeredBy":"` + r.method + ` ` + r.path + `"}`
}

// asYouBesideARunner is a machine where both could act: the runner's config.json names one control
// plane and the person's saved login another. The person comes first (§7.2).
func asYouBesideARunner(t *testing.T) (user, runner *recordingAPI) {
	t.Helper()
	userModeEnv(t)
	user = newRecordingAPI(t, answerAsUserRoutes)
	runner = newRecordingAPI(t, func(apiRequest) (int, string) {
		return http.StatusInternalServerError, `{"message":"the runner's credential was used in the person's place"}`
	})
	if err := saveConfig(&RunnerConfig{ServerURL: runner.URL, RunnerID: "runner-1", RunnerToken: "runner-secret", Name: "box"}); err != nil {
		t.Fatal(err)
	}
	loggedIn(t, user.URL, laptopToken)
	return user, runner
}

// orbitFamilies is each command family's entry point, as `orbit <family> ...` reaches it.
var orbitFamilies = map[string]func(args []string, in io.Reader, out io.Writer) error{
	"task":      cmdTaskCLI,
	"project":   cmdProjectCLI,
	"session":   cmdSessionCLI,
	"task-list": cmdTaskListCLI,
	"provider":  cmdProviderCLI,
	"notify":    func(args []string, _ io.Reader, out io.Writer) error { return cmdNotifyCLI(args, out) },
	"token":     func(args []string, _ io.Reader, out io.Writer) error { return cmdTokenCLI(args, out) },
	"agent":     func(args []string, _ io.Reader, out io.Writer) error { return cmdAgentCLI(args, out) },
}

// runOrbit runs `orbit <command> <args...>`, command being the words userModeActions keys it by.
func runOrbit(t *testing.T, command string, args []string, stdin io.Reader) (string, error) {
	t.Helper()
	words := strings.Fields(command)
	family, ok := orbitFamilies[words[0]]
	if !ok {
		t.Fatalf("no family %q", words[0])
	}
	var out bytes.Buffer
	err := family(append(words[1:], args...), stdin, &out)
	return out.String(), err
}

// jsonSubset reports what of want is missing from or different in the JSON object got.
func jsonSubset(t *testing.T, got, want string) []string {
	t.Helper()
	var have, need map[string]interface{}
	if err := json.Unmarshal([]byte(got), &have); err != nil {
		return []string{"the body is not a JSON object: " + got}
	}
	if err := json.Unmarshal([]byte(want), &need); err != nil {
		t.Fatalf("bad expectation %s: %v", want, err)
	}
	var wrong []string
	for key, value := range need {
		if actual, present := have[key]; !present || !reflect.DeepEqual(actual, value) {
			wrong = append(wrong, key+": got "+compactJSON(actual)+", want "+compactJSON(value))
		}
	}
	sort.Strings(wrong)
	return wrong
}

func compactJSON(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

const (
	contentSHA     = "0f343b0931126a20f133d67c2b018a3b5e4a0f0b9a2c3f1e5d7b6a8c9e0f1a2b"
	mergeSourceSHA = "1111111111111111111111111111111111111111"
	mergedSHA      = "2222222222222222222222222222222222222222"
)

// userModeRoutes is every command of the three families that runs as the person, with the user route
// it has to call and what it has to send there. The acceptance list of the task — list, get, create,
// update and comment of tasks, get and update of projects, list, get and send of sessions — is in it,
// and so is the rest: TestUserModeCommandsCallTheUserRoutesWithThePersonalAccessToken refuses to pass
// while a command userModeActions says runs as you has no row here.
var userModeRoutes = []struct {
	command string
	args    []string
	stdin   string
	method  string
	path    string
	query   map[string]string // query parameters it must carry
	body    string            // JSON fields its body must carry; "" checks nothing
	minted  []string          // body fields that must be present and non-empty, minted by the CLI
	noBody  bool
	output  string // what --json prints; "" for the route's own answer, untouched
}{
	{command: "task list", args: []string{"--status", "OPEN", "--project-id", "P1", "--label", "ship", "--min-priority", "1", "--limit", "5", "--json"},
		method: "GET", path: "/api/tasks/page",
		query:  map[string]string{"status": "OPEN", "projectId": "P1", "labels": "ship", "minPriority": "1", "limit": "5", "counts": "none"},
		output: `[{"id":"t1","title":"first"}]`},
	{command: "task labels", args: []string{"--list-id", "L1", "--json"}, method: "GET", path: "/api/tasks/labels", query: map[string]string{"listId": "L1"}},
	{command: "task get", args: []string{"t1", "--json"}, method: "GET", path: "/api/tasks/t1"},
	{command: "task attribution", args: []string{"t1", "--json"}, method: "GET", path: "/api/tasks/t1/attribution"},
	{command: "task evidence-list", args: []string{"t1", "--json"}, method: "GET", path: "/api/tasks/t1/evidence"},
	{command: "task evidence-submit", args: []string{"t1", "--evidence", `{"claim":"done"}`, "--source-session-id", "S1", "--idempotency-key", "k1", "--json"},
		method: "POST", path: "/api/tasks/t1/evidence", body: `{"sourceSessionId":"S1","evidence":{"claim":"done"},"idempotencyKey":"k1"}`},
	{command: "task create", args: []string{"--title", "Ship it", "--completion-criterion", "EVIDENCE_JUDGMENT", "--project-id", "P1", "--assignee-id", "W1", "--json"},
		method: "POST", path: "/api/tasks", body: `{"title":"Ship it","completionCriterion":"EVIDENCE_JUDGMENT","projectId":"P1","assigneeId":"W1"}`},
	{command: "task create-batch", args: []string{"--tasks-file", "-", "--json"}, stdin: `[{"title":"A","completionCriterion":"EVIDENCE_JUDGMENT"}]`,
		method: "POST", path: "/api/tasks/batch-create", body: `{"tasks":[{"title":"A","completionCriterion":"EVIDENCE_JUDGMENT"}]}`},
	{command: "task update", args: []string{"t1", "--title", "Renamed", "--json"}, method: "PATCH", path: "/api/tasks/t1", body: `{"title":"Renamed"}`},
	{command: "task reopen", args: []string{"t1", "--json"}, method: "PATCH", path: "/api/tasks/t1",
		body: `{"status":"OPEN","supersededByTaskId":null,"terminalReason":null}`},
	{command: "task delete", args: []string{"t1", "--json"}, method: "DELETE", path: "/api/tasks/t1", noBody: true},
	{command: "task start", args: []string{"t1", "--json"}, method: "POST", path: "/api/tasks/t1/execute", minted: []string{"triggerId"}},
	{command: "task comment", args: []string{"t1", "--body-file", "-", "--json"}, stdin: "looks good",
		method: "POST", path: "/api/tasks/t1/comments", body: `{"body":"looks good"}`},
	{command: "task progress", args: []string{"t1", "--phase", "tests", "--current", "2", "--total", "5", "--json"},
		method: "POST", path: "/api/tasks/t1/progress", body: `{"phase":"tests","current":2,"total":5}`},
	{command: "task progress", args: []string{"t1", "--json"}, method: "GET", path: "/api/tasks/t1/progress"},
	{command: "task dependency-graph", args: []string{"t1", "--max-depth", "2", "--json"},
		method: "GET", path: "/api/tasks/t1/dependency-graph", query: map[string]string{"maxDepth": "2"}},
	{command: "task dependency-add", args: []string{"t1", "--depends-on", "t2", "--json"},
		method: "POST", path: "/api/tasks/t1/dependencies", body: `{"dependsOnTaskId":"t2"}`},
	{command: "task dependency-remove", args: []string{"t1", "--depends-on", "t2", "--json"}, method: "DELETE", path: "/api/tasks/t1/dependencies/t2"},

	{command: "project get", args: []string{"P1", "--json"}, method: "GET", path: "/api/projects/P1"},
	{command: "project crossings", args: []string{"P1", "--state", "PENDING", "--json"},
		method: "GET", path: "/api/projects/P1/handoffs", query: map[string]string{"state": "PENDING"}},
	{command: "project resolve-blocker", args: []string{"P1", "--blocker-id", "B1", "--reason", "landed", "--json"},
		method: "POST", path: "/api/projects/P1/blockers/B1/resolve", body: `{"reason":"landed"}`},
	{command: "project merge-evidence", args: []string{"P1", "--requirement-id", "R1", "--target-branch", "main", "--content-hash", contentSHA, "--json"},
		method: "POST", path: "/api/projects/P1/acceptance/merge-evidence", body: `{"requirementId":"R1","targetBranch":"main","contentHash":"` + contentSHA + `"}`},
	// The person IS the approver the card would ask, so their own door queues the landing with no
	// card and no acting session — the reason is the whole of what they send.
	{command: "project skip-merge-check", args: []string{"P1", "T1", "--reason", "the check cannot pass here", "--json"},
		method: "POST", path: "/api/projects/P1/tasks/T1/integration/skip-merge-check", body: `{"reason":"the check cannot pass here"}`},
	{command: "project create", args: []string{"--title", "Next", "--goal", "ship it", "--workspace-id", "W1", "--json"},
		method: "POST", path: "/api/projects", body: `{"title":"Next","goal":"ship it","workspaceId":"W1"}`},
	{command: "project update", args: []string{"P1", "--title", "Renamed", "--json"}, method: "PATCH", path: "/api/projects/P1", body: `{"title":"Renamed"}`},
	{command: "project delete", args: []string{"P1", "--json"}, method: "DELETE", path: "/api/projects/P1", noBody: true},

	{command: "session list", args: []string{"--status", "RUNNING", "--parent-session-id", "S0", "--json"},
		method: "GET", path: "/api/sessions/compact", query: map[string]string{"status": "RUNNING", "parentSessionId": "S0"}},
	{command: "session search", args: []string{"--query", "deploy", "--limit", "3", "--json"},
		method: "GET", path: "/api/sessions/search", query: map[string]string{"q": "deploy", "limit": "3"}},
	{command: "session get", args: []string{"S1", "--json"}, method: "GET", path: "/api/sessions/S1/compact"},
	{command: "session send", args: []string{"S1", "--message-file", "-", "--client-turn-id", "turn-1", "--json"}, stdin: "hello",
		method: "POST", path: "/api/sessions/S1/turns", body: `{"content":"hello","clientTurnId":"turn-1"}`},
	{command: "session send", args: []string{"S1", "--message", "wake up", "--resume-if-ended", "--json"},
		method: "POST", path: "/api/sessions/S1/resume", body: `{"content":"wake up"}`, minted: []string{"clientTurnId"}},
	{command: "session interrupt", args: []string{"S1", "--json"}, method: "POST", path: "/api/sessions/S1/interrupt", noBody: true},
	{command: "session interrupt", args: []string{"S1", "--message", "do this instead", "--json"},
		method: "POST", path: "/api/sessions/S1/interrupt", body: `{"content":"do this instead"}`, minted: []string{"clientTurnId"}},
	{command: "session merge", args: []string{"S1", "--target-branch", "main", "--wait-seconds", "60", "--json"},
		method: "POST", path: "/api/sessions/S1/merge", body: `{"targetBranch":"main","waitSeconds":60}`},
	{command: "session merge-receipt", args: []string{"S1", "--result", "MERGED", "--source-sha", mergeSourceSHA, "--target-branch", "main", "--target-sha-after", mergedSHA, "--json"},
		method: "POST", path: "/api/sessions/S1/merge-receipts",
		body: `{"result":"MERGED","sourceSha":"` + mergeSourceSHA + `","targetBranch":"main","targetShaAfter":"` + mergedSHA + `"}`},
	{command: "session merge-receipts", args: []string{"S1", "--limit", "2", "--json"},
		method: "GET", path: "/api/sessions/S1/merge-receipts", query: map[string]string{"limit": "2"}},
	{command: "session end", args: []string{"S1", "--json"}, method: "POST", path: "/api/sessions/S1/end"},
	{command: "session complete", args: []string{"S1", "--json"}, method: "POST", path: "/api/sessions/S1/complete"},
	{command: "session delete", args: []string{"S1", "--json"}, method: "DELETE", path: "/api/sessions/S1", noBody: true},
}

// Acting as the person, every command of the three families that runs as them sends exactly one
// request: to the user route, never a runner route, with the personal access token, carrying no
// session — and prints what that route answered. The runner's control plane hears nothing.
func TestUserModeCommandsCallTheUserRoutesWithThePersonalAccessToken(t *testing.T) {
	exercised := map[string]bool{}
	for _, tc := range userModeRoutes {
		exercised[tc.command] = true
		t.Run(tc.command+" "+strings.Join(tc.args, " "), func(t *testing.T) {
			user, runner := asYouBesideARunner(t)
			out, err := runOrbit(t, tc.command, tc.args, strings.NewReader(tc.stdin))
			if err != nil {
				t.Fatalf("orbit %s: %v", tc.command, err)
			}
			if got := runner.seen(); len(got) != 0 {
				t.Fatalf("the runner's control plane was sent %+v", got)
			}
			requests := user.seen()
			if len(requests) != 1 {
				t.Fatalf("sent %d requests, want exactly one: %+v", len(requests), requests)
			}
			r := requests[0]
			if r.method != tc.method || r.path != tc.path {
				t.Errorf("request = %s %s, want %s %s", r.method, r.path, tc.method, tc.path)
			}
			if strings.HasPrefix(r.path, "/api/runner/") || !strings.HasPrefix(r.path, "/api/") {
				t.Errorf("%s is not a user route", r.path)
			}
			if r.authorization != "Bearer "+laptopToken {
				t.Errorf("authorization = %q, want the personal access token", r.authorization)
			}
			if r.sessionHeader != "" {
				t.Errorf("X-Orbit-Session-Id = %q: the person is nobody's session", r.sessionHeader)
			}
			query, err := url.ParseQuery(r.query)
			if err != nil {
				t.Fatal(err)
			}
			for key, want := range tc.query {
				if got := query.Get(key); got != want {
					t.Errorf("query %s = %q, want %q (query %s)", key, got, want, r.query)
				}
			}
			if tc.noBody && r.body != "" {
				t.Errorf("sent a body %s, want none", r.body)
			}
			if tc.body != "" {
				for _, wrong := range jsonSubset(t, r.body, tc.body) {
					t.Errorf("body %s", wrong)
				}
			}
			if len(tc.minted) > 0 {
				var fields map[string]interface{}
				_ = json.Unmarshal([]byte(r.body), &fields)
				for _, key := range tc.minted {
					if value, _ := fields[key].(string); value == "" {
						t.Errorf("body %s lacks a %s", r.body, key)
					}
				}
			}
			want := tc.output
			if want == "" {
				want = `{"answeredBy":"` + tc.method + ` ` + tc.path + `"}`
			}
			if strings.TrimSpace(out) != want {
				t.Errorf("printed %q, want %q", out, want)
			}
		})
	}
	var untested []string
	for command, reason := range userModeActions {
		family := strings.Fields(command)[0]
		if reason == "" && (family == "task" || family == "project" || family == "session") && !exercised[command] {
			untested = append(untested, command)
		}
	}
	sort.Strings(untested)
	if len(untested) > 0 {
		t.Errorf("these run as you and no case above shows which route they call: %v", untested)
	}
}

// failingReader is stdin for a command that must not read it.
type failingReader struct{ t *testing.T }

func (r failingReader) Read([]byte) (int, error) {
	r.t.Error("a refused command read stdin")
	return 0, io.EOF
}

// A command that does not run as the person says why and what to use instead — `orbit api` — and is
// refused before it reads or sends anything: no request to the person's control plane, and above all
// none to the runner's, whose credential is never used in the person's place.
func TestUserModeRefusesWhatDoesNotRunAsYouAndNeverUsesTheRunnerCredential(t *testing.T) {
	type refusal struct {
		command string
		args    []string
		says    string
	}
	var cases []refusal
	for command, reason := range userModeActions {
		family := strings.Fields(command)[0]
		if reason != "" && (family == "task" || family == "project" || family == "session") {
			cases = append(cases, refusal{command: command, args: []string{"ID-1", "--json"}, says: reason})
		}
	}
	sort.Slice(cases, func(i, j int) bool { return cases[i].command < cases[j].command })
	if len(cases) < 10 {
		t.Fatalf("only %d refused commands in the three families: the table lost them", len(cases))
	}
	// The machine's other commands: none has a form that runs as the person, so the runner's
	// credential is refused where they would take it.
	cases = append(cases,
		refusal{command: "task-list list", args: []string{"--json"}, says: userModeUnported},
		refusal{command: "provider list", args: []string{"--json"}, says: userModeUnported},
		refusal{command: "notify", args: []string{"--message", "build finished"}, says: userModeUnported},
		refusal{command: "token list", args: []string{"--json"}, says: userModeUnported},
		refusal{command: "agent list", args: []string{"--json"}, says: userModeUnported},
	)
	for _, tc := range cases {
		t.Run(tc.command, func(t *testing.T) {
			user, runner := asYouBesideARunner(t)
			out, err := runOrbit(t, tc.command, tc.args, failingReader{t})
			if err == nil {
				t.Fatalf("orbit %s ran as the person:\n%s", tc.command, out)
			}
			for _, want := range []string{"does not run as you", "the login `orbit login` saved in", tc.says, "`orbit api`"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("the refusal does not say %q:\n%v", want, err)
				}
			}
			if got := runner.seen(); len(got) != 0 {
				t.Errorf("the runner's control plane was sent %+v", got)
			}
			if got := user.seen(); len(got) != 0 {
				t.Errorf("a refused command sent %+v", got)
			}
			if out != "" {
				t.Errorf("a refused command printed %q", out)
			}
		})
	}
}

// A request for a reply needs a session to come back to, so the person's send refuses it rather than
// sending a plain message that silently asks for nothing.
func TestUserModeSendRefusesARequestForAReply(t *testing.T) {
	user, runner := asYouBesideARunner(t)
	_, err := runOrbit(t, "session send", []string{"S1", "--message", "which branch?", "--expect-reply", "--json"}, strings.NewReader(""))
	if err == nil || !strings.Contains(err.Error(), "--expect-reply needs a calling session") {
		t.Fatalf("err = %v", err)
	}
	if got := append(user.seen(), runner.seen()...); len(got) != 0 {
		t.Errorf("sent %+v", got)
	}
}

// --json prints the same shape as the person as it does as the runner: the user routes these
// commands call answer from the same reads the runner routes do, and `task list` prints the page's
// rows, which is what the runner route answers with.
func TestUserModePrintsWhatRunnerModePrints(t *testing.T) {
	rows := `[{"id":"t1","title":"first"}]`
	sessionRows := `[{"id":"S1","title":"a session","status":"RUNNING","runStatus":"RUNNING"}]`
	sessionDetail := `{"id":"S1","title":"a session","status":"AWAITING_INPUT","numTurns":7,"workspace":{"id":"W1","name":"w","model":null}}`
	runnerAPI := func(r apiRequest) (int, string) {
		switch {
		case r.path == "/api/runner/tasks":
			return http.StatusOK, rows
		case r.path == "/api/runner/tasks/page" && strings.Contains(r.query, "cursor=c2"):
			return http.StatusOK, `{"items":[{"id":"t2","title":"second"}],"nextCursor":null}`
		case r.path == "/api/runner/tasks/page":
			return http.StatusOK, `{"items":[{"id":"t1","title":"first"}],"nextCursor":"c2"}`
		case r.path == "/api/runner/sessions":
			return http.StatusOK, sessionRows
		case r.path == "/api/runner/sessions/S1":
			return http.StatusOK, sessionDetail
		}
		return http.StatusNotFound, `{}`
	}
	userAPI := func(r apiRequest) (int, string) {
		switch r.path {
		case "/api/sessions/compact":
			return http.StatusOK, sessionRows
		case "/api/sessions/S1/compact":
			return http.StatusOK, sessionDetail
		}
		return answerAsUserRoutes(r)
	}
	commands := []struct {
		command string
		args    []string
	}{
		{"task list", []string{"--status", "OPEN", "--json"}},
		{"task list", []string{"--status", "OPEN"}},
		{"task list", []string{"--all"}},
		{"session list", []string{"--json"}},
		{"session get", []string{"S1", "--json"}},
	}
	for _, c := range commands {
		t.Run(c.command+" "+strings.Join(c.args, " "), func(t *testing.T) {
			userModeEnv(t)
			asRunner := newRecordingAPI(t, runnerAPI)
			if err := saveConfig(&RunnerConfig{ServerURL: asRunner.URL, RunnerID: "runner-1", RunnerToken: "runner-secret"}); err != nil {
				t.Fatal(err)
			}
			byRunner, err := runOrbit(t, c.command, c.args, strings.NewReader(""))
			if err != nil {
				t.Fatalf("as the runner: %v", err)
			}
			for _, r := range asRunner.seen() {
				if r.authorization != "Bearer runner-secret" || !strings.HasPrefix(r.path, "/api/runner/") {
					t.Errorf("as the runner sent %s %s with %q", r.method, r.path, r.authorization)
				}
			}

			asUser := newRecordingAPI(t, userAPI)
			loggedIn(t, asUser.URL, laptopToken)
			byUser, err := runOrbit(t, c.command, c.args, strings.NewReader(""))
			if err != nil {
				t.Fatalf("as the person: %v", err)
			}
			if len(asUser.seen()) == 0 {
				t.Fatal("as the person nothing reached the user routes")
			}
			if byUser != byRunner {
				t.Errorf("as the person printed\n%s\nas the runner\n%s", byUser, byRunner)
			}
		})
	}
}

// A refused token is said the way every command acting as the person says it (§6.1) — and is an
// answer, so a walk does not retry it and a start does not resend it.
func TestUserModeSaysARefusedTokenIsInvalidRevokedOrExpired(t *testing.T) {
	for _, c := range []struct {
		command string
		args    []string
	}{
		{"task get", []string{"t1"}},
		{"task list", []string{"--all"}},
		{"task start", []string{"t1"}},
		{"session list", nil},
	} {
		t.Run(c.command, func(t *testing.T) {
			user, runner := asYouBesideARunner(t)
			loggedIn(t, user.URL, otherToken)
			_, err := runOrbit(t, c.command, c.args, strings.NewReader(""))
			if err == nil || !strings.Contains(err.Error(), "invalid, revoked or expired") || !strings.Contains(err.Error(), "Run `orbit login` again") {
				t.Fatalf("err = %v", err)
			}
			if got := user.seen(); len(got) != 1 {
				t.Errorf("sent %d requests for one refusal: %+v", len(got), got)
			}
			if got := runner.seen(); len(got) != 0 {
				t.Errorf("the runner's control plane was sent %+v", got)
			}
		})
	}
}

// A saved login that cannot be used still decides who the CLI is (§7.2): it is reported, and neither
// its token nor the runner's credential is sent anywhere.
func TestUserModeWithAnUnusableLoginSendsNothing(t *testing.T) {
	user, runner := asYouBesideARunner(t)
	if err := os.Chmod(userLoginFile(), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		command string
		args    []string
	}{
		{"task get", []string{"t1"}},
		{"project get", []string{"P1"}},
		{"session list", nil},
		{"task-list list", nil},
	} {
		if _, err := runOrbit(t, c.command, c.args, strings.NewReader("")); err == nil {
			t.Errorf("orbit %s ran", c.command)
		}
	}
	if got := append(user.seen(), runner.seen()...); len(got) != 0 {
		t.Errorf("sent %+v", got)
	}
}

// Inside a session the CLI acts as the session (§7.2), whatever else is on hand: a service token in
// its environment and a personal access token saved on the machine are both passed over, and the
// session commands carry the session and the runner's credential as they always have. Outside a
// session the service token is who the process is, as before.
func TestSessionCommandsInsideASessionActAsTheSessionBesideAServiceToken(t *testing.T) {
	userModeEnv(t)
	runner := newRecordingAPI(t, func(apiRequest) (int, string) { return http.StatusOK, `[]` })
	if err := saveConfig(&RunnerConfig{ServerURL: runner.URL, RunnerID: "runner-1", RunnerToken: "runner-secret"}); err != nil {
		t.Fatal(err)
	}
	user := newRecordingAPI(t, answerAsUserRoutes)
	loggedIn(t, user.URL, laptopToken)
	service := fakeServiceToken(t, []string{"session:list", "session:get"}, "agent-1", time.Hour)
	t.Setenv(envServiceToken, service)
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv(envOrchestrationToken, "session-token")

	for _, c := range []struct {
		command string
		args    []string
		path    string
	}{
		{"session list", []string{"--json"}, "/api/runner/sessions"},
		{"session merge-receipts", []string{"S1", "--json"}, "/api/runner/sessions/S1/merge-receipts"},
		{"task list", []string{"--json"}, "/api/runner/tasks"},
	} {
		before := len(runner.seen())
		if _, err := runOrbit(t, c.command, c.args, strings.NewReader("")); err != nil {
			t.Fatalf("orbit %s: %v", c.command, err)
		}
		sent := runner.seen()[before:]
		if len(sent) != 1 || sent[0].path != c.path {
			t.Fatalf("orbit %s sent %+v, want one request to %s", c.command, sent, c.path)
		}
		if sent[0].authorization != "Bearer runner-secret" {
			t.Errorf("orbit %s authorized with %q, want the runner credential the session rides on", c.command, sent[0].authorization)
		}
	}
	if sent := runner.seen()[0]; sent.sessionHeader != "caller-session" {
		t.Errorf("session list carried session %q, want the calling session", sent.sessionHeader)
	}
	if got := user.seen(); len(got) != 0 {
		t.Errorf("the personal access token was used inside a session: %+v", got)
	}

	doc := buildCLICapabilities("/usr/local/bin/orbit")
	if doc.Identity.Kind != identitySession || doc.Context.ServiceToken != nil {
		t.Errorf("identity %+v, service token %+v", doc.Identity, doc.Context.ServiceToken)
	}
	list := sessionCLICapabilityByID(doc.Capabilities, "session_list")
	if list == nil || list.Description == headlessActionDescription["list"] || !list.Available {
		t.Errorf("inside a session session_list is the orchestration command: %+v", list)
	}

	// Outside any session the service token decides, exactly as before.
	t.Setenv("ORBIT_SESSION_ID", "")
	before := len(runner.seen())
	if _, err := runOrbit(t, "session list", []string{"--json"}, strings.NewReader("")); err != nil {
		t.Fatal(err)
	}
	if sent := runner.seen()[before:]; len(sent) != 1 || sent[0].authorization != "Bearer "+service || sent[0].sessionHeader != "" {
		t.Errorf("outside a session sent %+v, want one request on the service token and no session", sent)
	}
}

// `orbit capabilities --json` marks every command it lists by whether it runs as this process's
// identity (§7.4): as the person, the three families as userModeActions says and the machine's other
// commands not at all, each refusal with its reason; as the runner, everything but `orbit api`.
func TestCapabilitiesMarkWhatRunsAsTheCurrentIdentity(t *testing.T) {
	asYouBesideARunner(t)
	doc := buildCLICapabilities("/usr/local/bin/orbit")
	if doc.Identity.Kind != identityUser || doc.Context.Actor != "user" {
		t.Fatalf("identity %+v, actor %q", doc.Identity, doc.Context.Actor)
	}
	byID := map[string]cliCapability{}
	for _, c := range doc.Capabilities {
		byID[c.ID] = c
		command := strings.Join(c.Argv[1:], " ")
		reason, listed := userModeActions[command]
		switch {
		case !listed:
			if c.Available || c.UnavailableReason != userModeUnported {
				t.Errorf("%s is the machine's and must not run as you: available=%v %q", c.ID, c.Available, c.UnavailableReason)
			}
		case c.Available != (reason == "") || c.UnavailableReason != reason:
			t.Errorf("%s: available=%v %q, want the table's %q", c.ID, c.Available, c.UnavailableReason, reason)
		}
		if headless, ok := headlessActionDescription[strings.TrimPrefix(c.ID, "session_")]; ok && strings.HasPrefix(c.ID, "session_") && c.Description == headless {
			t.Errorf("%s is described as the runner credential's headless door", c.ID)
		}
	}
	for _, id := range []string{"task_list", "task_get", "task_create", "task_update", "task_comment", "project_get", "project_update",
		"session_list", "session_get", "session_send", "merge_receipt", "api", "login", "whoami"} {
		if c, ok := byID[id]; !ok || !c.Available {
			t.Errorf("%s is not offered as running as you: %+v", id, c)
		}
	}
	for _, id := range []string{"task_batch_pin", "task_evidence_decide", "session_create", "session_import", "tasklist_list", "notify", "provider_list"} {
		if c, ok := byID[id]; !ok || c.Available || c.UnavailableReason == "" {
			t.Errorf("%s is not marked as not running as you: %+v", id, c)
		}
	}
	var text bytes.Buffer
	if err := cmdCapabilitiesCLI(nil, &text); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text.String(), "Not available here: "+userModeActions["task batch-pin"]) {
		t.Errorf("the text listing does not say what does not run as you:\n%s", text.String())
	}

	// The machine alone: everything listed runs as it, but `orbit api`, which acts only as the person.
	t.Setenv("ORBIT_HOME", t.TempDir())
	if err := saveConfig(&RunnerConfig{ServerURL: "http://127.0.0.1:9", RunnerID: "runner-1", RunnerToken: "runner-secret"}); err != nil {
		t.Fatal(err)
	}
	doc = buildCLICapabilities("/usr/local/bin/orbit")
	if doc.Identity.Kind != identityRunner || doc.Context.Actor != "runner_owner" {
		t.Fatalf("identity %+v, actor %q", doc.Identity, doc.Context.Actor)
	}
	for _, c := range doc.Capabilities {
		if c.ID == "api" {
			if c.Available || !strings.Contains(c.UnavailableReason, "not logged in") {
				t.Errorf("api as the runner: %+v", c)
			}
		} else if !c.Available {
			t.Errorf("%s does not run as the runner: %q", c.ID, c.UnavailableReason)
		}
	}
}

// userModeActions names every command of the three families, and nothing that is not one: a command
// added to a family without a decision about the person is caught here rather than refused in the
// field with a reason that does not fit it.
func TestUserModeCoversEveryTaskProjectAndSessionCommand(t *testing.T) {
	commands := map[string]bool{}
	for _, list := range [][]cliCapabilitySpec{
		baseCLICapabilities, projectCLICapabilities, sessionCLICapabilities, mergeReceiptCLICapabilities, watchCLICapabilities,
	} {
		for _, spec := range list {
			if family := spec.Argv[1]; family == "task" || family == "project" || family == "session" {
				commands[strings.Join(spec.Argv[1:], " ")] = true
			}
		}
	}
	var missing, stale []string
	for command := range commands {
		if _, listed := userModeActions[command]; !listed {
			missing = append(missing, command)
		}
	}
	for command := range userModeActions {
		family := strings.Fields(command)[0]
		if (family == "task" || family == "project" || family == "session") && !commands[command] {
			stale = append(stale, command)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	if len(missing) > 0 || len(stale) > 0 {
		t.Errorf("userModeActions misses %v and names %v, which no capability lists", missing, stale)
	}
}
