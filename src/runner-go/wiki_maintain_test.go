package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// `orbit wiki maintain` and `orbit wiki check` (contract `maintenance.job`, criterion 3), against a fake
// runner door that answers every route a run reaches, the fake vLLM endpoint and fake Claude Code of
// wiki_verify_test.go, and a real git checkout with an origin to fetch from.

// maintainRequest is one request the fake door was sent.
type maintainRequest struct {
	method, path, session string
	query                 url.Values
	body                  map[string]interface{}
}

// fakeMaintainDoor is the runner door as a run meets it. Each field decides one route's answer; a nil one
// answers as a space with nothing there would.
type fakeMaintainDoor struct {
	URL      string
	mu       sync.Mutex
	requests []maintainRequest

	context func() (int, string)
	// pages answers each dossier page by the `after` it was asked for.
	pages map[string]string
	// propose answers a proposal, dry run or not, by its ops.
	propose       func(ops []interface{}, dryRun bool) (int, string)
	verifications string
	check         func(expect string) (int, string)
}

func newFakeMaintainDoor(t *testing.T) *fakeMaintainDoor {
	t.Helper()
	d := &fakeMaintainDoor{pages: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := maintainRequest{method: r.Method, path: r.URL.Path, query: r.URL.Query(), session: r.Header.Get("X-Orbit-Session-Id")}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &request.body); err != nil {
				t.Errorf("%s %s sent a body that is not JSON: %s", r.Method, r.URL.Path, raw)
			}
		}
		d.mu.Lock()
		d.requests = append(d.requests, request)
		d.mu.Unlock()
		status, body := http.StatusNotFound, `{"message":"no such route"}`
		path := strings.TrimPrefix(r.URL.Path, "/api/runner/wiki/spaces/space-1/")
		switch {
		case r.Method == http.MethodGet && path == "maintenance/run" && d.context != nil:
			status, body = d.context()
		case r.Method == http.MethodGet && path == "dossiers":
			page, ok := d.pages[r.URL.Query().Get("after")]
			if !ok {
				page = maintainPage(r.URL.Query().Get("after"), false)
			}
			status, body = http.StatusOK, page
		case r.Method == http.MethodPost && path == "maintenance/changesets" && d.propose != nil:
			ops, _ := request.body["ops"].([]interface{})
			dry, _ := request.body["dryRun"].(bool)
			status, body = d.propose(ops, dry)
		case r.Method == http.MethodGet && path == "verifications":
			status, body = http.StatusOK, firstNonEmpty(d.verifications, `{"spaceId":"space-1","mode":"automatic","items":[],"next":""}`)
			d.verifications = `{"spaceId":"space-1","mode":"automatic","items":[],"next":""}`
		case r.Method == http.MethodPost && path == "verifications":
			verdicts, _ := request.body["verdicts"].([]interface{})
			outcomes := []interface{}{}
			for _, v := range verdicts {
				verdict, _ := v.(map[string]interface{})
				outcomes = append(outcomes, map[string]interface{}{"opId": verdict["opId"], "status": "applied", "trust": "auto"})
			}
			raw, _ := json.Marshal(map[string]interface{}{"mode": "automatic", "outcomes": outcomes})
			status, body = http.StatusOK, string(raw)
		case r.Method == http.MethodGet && path == "anchors":
			status, body = http.StatusOK, `{"spaceId":"space-1","repo":null,"entries":[],"next":null}`
		case r.Method == http.MethodPost && path == "article-plan":
			raw, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "seeded": 0, "entries": 2, "unassigned": 0,
				"topics": []interface{}{planTopic("testing", 2, false)}})
			status, body = http.StatusOK, string(raw)
		case r.Method == http.MethodPost && path == "maintenance/finish":
			outcome, _ := request.body["outcome"].(string)
			advanced := outcome == "succeeded"
			raw, _ := json.Marshal(map[string]interface{}{"advanced": advanced, "outcome": outcome,
				"state": map[string]interface{}{"position": map[bool]string{true: "tok-expect", false: ""}[advanced], "backlog": 0, "consecutiveFailures": map[bool]int{true: 0, false: 1}[advanced]}})
			status, body = http.StatusOK, string(raw)
		case r.Method == http.MethodGet && path == "maintenance/check" && d.check != nil:
			status, body = d.check(r.URL.Query().Get("expect"))
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	d.URL = srv.URL
	return d
}

func (d *fakeMaintainDoor) calls() []maintainRequest {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]maintainRequest{}, d.requests...)
}

// of is every request the door took to one route.
func (d *fakeMaintainDoor) of(method, path string) []maintainRequest {
	var out []maintainRequest
	for _, request := range d.calls() {
		if request.method == method && strings.HasSuffix(request.path, "/"+path) {
			out = append(out, request)
		}
	}
	return out
}

// maintainPage is a page with nothing on it, ending at `cursor`.
func maintainPage(cursor string, more bool, dossiers ...map[string]interface{}) string {
	if dossiers == nil {
		dossiers = []map[string]interface{}{}
	}
	raw, _ := json.Marshal(map[string]interface{}{
		"spaceId": "space-1", "cursor": firstNonEmpty(cursor, "tok-expect"), "more": more, "facts": len(dossiers),
		"dossiers": dossiers, "batches": []interface{}{}, "errorClusters": []interface{}{},
		"state": map[string]interface{}{"position": nil, "backlog": len(dossiers), "consecutiveFailures": 0},
	})
	return string(raw)
}

// maintainDossier is one session's dossier, its lines L1… mapped to the records given.
func maintainDossier(session, title string, lines []string, records []string, unchanged bool) map[string]interface{} {
	text := "SESSION: " + title + "\nanthropic/claude-opus-5 · started 2026-09-20 · status SUCCEEDED\n\n"
	sources := []interface{}{}
	for i, line := range lines {
		ref := "L" + strconv.Itoa(i+1)
		text += ref + " " + line + "\n"
		kind, id, _ := strings.Cut(records[i], ":")
		sources = append(sources, map[string]interface{}{"ref": ref, "kind": kind, "id": id})
	}
	return map[string]interface{}{"sessionId": session, "taskId": "", "title": title, "text": text, "tokens": 200,
		"truncated": false, "tainted": false, "sources": sources, "hash": strings.Repeat("c", 64), "unchanged": unchanged}
}

// portDossier is a session about the repository: the owner's rule, a failure and its cause.
func portDossier(session string) map[string]interface{} {
	return maintainDossier(session, "修 fixture 的端口", []string{
		"owner: 以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。",
		"tool: $ go test ./... → ERR: connect ECONNREFUSED 127.0.0.1:9000",
		"agent: 根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。",
	}, []string{"turn:turn-1", "tool_call:call-2", "event:event-3"}, false)
}

// werewolfDossier is a session of the same workspace about something else altogether.
func werewolfDossier(session string) map[string]interface{} {
	return maintainDossier(session, "设计狼人杀软件界面", []string{
		"owner: 12 人预女猎白，金神职红狼人绿村民，联网手机网页打字发言。",
	}, []string{"turn:turn-9"}, false)
}

// maintainFixture is a bare origin and a checkout of it — what the maintenance workspace's work directory
// holds — with src/app.go on origin/main.
type maintainFixture struct {
	checkout, bare, first string
}

func newMaintainFixture(t *testing.T) maintainFixture {
	t.Helper()
	base := t.TempDir()
	f := maintainFixture{bare: filepath.Join(base, "app.git"), checkout: filepath.Join(base, "app")}
	seed := filepath.Join(base, "seed")
	mustGit(t, base, "init", "-q", "--bare", "-b", "main", f.bare)
	if err := os.MkdirAll(filepath.Join(seed, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, seed, "init", "-q", "-b", "main")
	mustGit(t, seed, "config", "user.email", "test@orbit")
	mustGit(t, seed, "config", "user.name", "Test")
	for name, content := range map[string]string{
		"src/app.go": "package app\n",
		"README.md":  "<h1>App</h1>\n\n# App\n\nApp is the spec's small service that reads a PORT and serves what its fixtures give it.\n",
	} {
		if err := os.WriteFile(filepath.Join(seed, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, seed, "add", ".")
	mustGit(t, seed, "commit", "-q", "-m", "first")
	f.first = mustGit(t, seed, "rev-parse", "HEAD")
	mustGit(t, seed, "remote", "add", "origin", f.bare)
	mustGit(t, seed, "push", "-q", "origin", "main")
	mustGit(t, base, "clone", "-q", f.bare, f.checkout)
	return f
}

// maintainContext is the run's context for the fixture's checkout, as the server would answer it.
func maintainContext(f maintainFixture, mode string, active int, expect string) func() (int, string) {
	return func() (int, string) {
		raw, _ := json.Marshal(map[string]interface{}{
			"spaceId": "space-1", "title": "app",
			"repo":       map[string]interface{}{"urlNorm": normalizeWikiRepoURL(f.bare), "rootCommitSha": f.first},
			"reviewMode": mode, "activeEntries": active,
			"breaker":   map[string]interface{}{"minActiveEntries": 100, "maxChangedPercent": 10},
			"workspace": map[string]interface{}{"id": "ws-1", "workDir": f.checkout},
			"topics": []interface{}{
				map[string]interface{}{"slug": "testing", "title": "测试", "description": "Tests: fixtures, flakes."},
				map[string]interface{}{"slug": "runner", "title": "Runner", "description": nil},
			},
			"taskId": "task-1", "expect": expect, "runSessions": 20,
		})
		return http.StatusOK, string(raw)
	}
}

// wikiMaintainSession points the CLI at the door and the model endpoint as a maintenance session on the
// local model's provider has them, with what must not reach the clean call planted beside them.
func wikiMaintainSession(t *testing.T, doorURL string, vllm *fakeVLLM) {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"serverUrl":` + strconv.Quote(doorURL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "maintenance-session")
	t.Setenv(envWiki, "on")
	if vllm != nil {
		t.Setenv("ANTHROPIC_BASE_URL", vllm.URL)
	}
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "tok-local-vllm")
	t.Setenv("ANTHROPIC_MODEL", "qwen3.8-27b-fp8")
	t.Setenv("ANTHROPIC_API_KEY", "sk-must-not-reach-the-extractor")
	t.Setenv("CLAUDE_CODE_EFFORT_LEVEL", "high")
	t.Setenv("MAX_THINKING_TOKENS", "31999")
}

// extractorAnswers answers as the model would: a verdict for a verification, {"offTopic": true} for the
// werewolf case, and for the port case three entries — one to keep, one anchored outside the repository,
// and one whose quote is not copied from its line, which the retry corrects.
func extractorAnswers(prompt string) (int, string) {
	switch {
	case !strings.Contains(prompt, "==== CASE FILE ===="):
		return http.StatusOK, `{"verdict":"supported","reason":"the cited turn says exactly this"}`
	case strings.Contains(prompt, "SOME ENTRIES IN YOUR ANSWER WERE REJECTED"):
		return http.StatusOK, `[{"kind":"pitfall","title":"PORT 在导入时读取，fixture 之后再设无效","summary":"PORT 必须在导入前设好。","topic":"testing","trigger":{"paths":["src/app.go"],"commands":["go test ./..."],"errorSignature":"connect ECONNREFUSED"},"symptom":"测试报 ECONNREFUSED","cause":"导入时读取 PORT","fix":"fixture 返回 url","anchors":{"paths":["src/app.go"],"commits":[]},"sources":[{"ref":"L2","quote":"connect ECONNREFUSED 127.0.0.1:9000"}],"verified":true}]`
	case strings.Contains(prompt, "狼人杀"):
		return http.StatusOK, `{"offTopic": true}`
	}
	return http.StatusOK, "```json\n" + `[{"kind":"convention","title":"fixture 不写死端口","summary":"端口一律从 fixture 的返回值取。","topic":"testing","rule":"fixture 里不要写死端口","scope":["测试 fixture"],"exceptions":"","anchors":{"paths":["src/app.go"],"commits":[]},"sources":[{"ref":"L1","quote":"以后 fixture 里不要写死端口"}],"verified":false},
 {"kind":"pitfall","title":"游戏面板渲染慢","summary":"面板重绘太频繁。","topic":"testing","trigger":{"paths":["src/components/GameBoard.tsx"],"commands":[],"errorSignature":""},"symptom":"卡顿","cause":"重绘","fix":"节流","anchors":{"paths":["src/components/GameBoard.tsx"],"commits":[]},"sources":[{"ref":"L3","quote":"根因：src/app.go 在导入时读取 PORT"}],"verified":false},
 {"kind":"pitfall","title":"PORT 在导入时读取，fixture 之后再设无效","summary":"PORT 必须在导入前设好。","topic":"testing","trigger":{"paths":["src/app.go"],"commands":[],"errorSignature":""},"symptom":"测试报错","cause":"导入时读取","fix":"fixture 返回 url","anchors":{"paths":["src/app.go"],"commits":[]},"sources":[{"ref":"L2","quote":"connection refused"}],"verified":true},
 {"kind":"principle","title":"一切从简","summary":"越简单越好。","statement":"从简","rationale":"少出错","anchors":{"paths":[],"commits":[]},"sources":[{"ref":"L1","quote":"以后 fixture"}],"verified":false}]` + "\n```"
}

// pendingForVerification answers a proposal as an automatic space does: every op waits for its verdict.
func pendingForVerification(ops []interface{}, dryRun bool) (int, string) {
	outcomes := []interface{}{}
	for i := range ops {
		outcome := map[string]interface{}{"seq": i, "status": "pending", "waitsFor": "verification", "entryId": fmt.Sprintf("e-%d", i)}
		if !dryRun {
			outcome["opId"] = fmt.Sprintf("op-%d", i)
		}
		outcomes = append(outcomes, outcome)
	}
	raw, _ := json.Marshal(map[string]interface{}{"changesetId": map[bool]interface{}{true: nil, false: "cs-1"}[dryRun], "dryRun": dryRun, "ops": outcomes})
	return http.StatusOK, string(raw)
}

func runMaintainCLI(t *testing.T, args ...string) (wikiMaintainSummary, error) {
	t.Helper()
	var out strings.Builder
	err := cmdWikiCLI(append([]string{"maintain", "--space", "space-1", "--json"}, args...), strings.NewReader(""), &out)
	var summary wikiMaintainSummary
	if jsonErr := json.Unmarshal([]byte(out.String()), &summary); jsonErr != nil {
		t.Fatalf("--json printed %q: %v (the run: %v)", out.String(), jsonErr, err)
	}
	return summary, err
}

// finished is what the run told the server when it ended.
func finished(t *testing.T, door *fakeMaintainDoor) map[string]interface{} {
	t.Helper()
	ends := door.of(http.MethodPost, "maintenance/finish")
	if len(ends) != 1 {
		t.Fatalf("the run ended %d times, want once: %v", len(ends), door.calls())
	}
	return ends[0].body
}

// ── A run ───────────────────────────────────────────────────────────────────────────────────────

func TestWikiMaintainRunsThePipelineAndAdvancesTheCursor(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-1", true, portDossier("session-a"), werewolfDossier("session-b"))
	unchanged := portDossier("session-c")
	unchanged["unchanged"] = true
	door.pages["tok-1"] = maintainPage("tok-expect", false, unchanged)
	door.propose = pendingForVerification
	door.verifications = `{"spaceId":"space-1","mode":"automatic","items":[` +
		`{"opId":"op-0","op":"add","entryId":"e-0","entry":{"kind":"convention","title":"fixture 不写死端口","summary":"s","fields":{}},"sources":[{"kind":"turn","ref":"turn-1","quote":"以后 fixture 里不要写死端口","text":"以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。","truncated":false}],"similar":[]},` +
		`{"opId":"op-1","op":"add","entryId":"e-1","entry":{"kind":"pitfall","title":"PORT","summary":"s","fields":{}},"sources":[{"kind":"tool_call","ref":"call-2","quote":null,"text":"connect ECONNREFUSED 127.0.0.1:9000","truncated":false}],"similar":[]}` +
		`],"next":""}`
	vllm := newFakeVLLM(t, extractorAnswers)
	spawns := fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)
	realHome, _ := os.UserHomeDir()

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	r := summary.Report
	if summary.Outcome != "succeeded" || !summary.Advanced || summary.Cursor != "tok-expect" || summary.Model != "qwen3.8-27b-fp8" {
		t.Errorf("summary = %+v", summary)
	}
	if r.Sessions != 3 || r.Dossiers != 2 || r.Unchanged != 1 || r.OffTopic != 1 {
		t.Errorf("sessions %d, dossiers %d, unchanged %d, off topic %d: want 3, 2, 1, 1", r.Sessions, r.Dossiers, r.Unchanged, r.OffTopic)
	}
	// Four entries from the port case: one kept at once, one anchored outside the repository, one a
	// principle, and one whose quote was not from its line — which the retry brought back.
	if r.Entries.Kept != 2 || r.Entries.Foreign != 1 || r.Entries.Principles != 1 || r.Entries.Dropped != 0 {
		t.Errorf("entries = %+v, want 2 kept, 1 foreign, 1 principle, none dropped in the end", r.Entries)
	}
	if r.Ops.Proposed != 2 || r.Ops.Recorded != 2 || r.Ops.Waiting != 2 || r.Ops.Refused != 0 {
		t.Errorf("ops = %+v", r.Ops)
	}
	if r.Verification == nil || r.Verification.Verified != 2 || r.Verification.Failed != 0 {
		t.Errorf("verification = %+v, want both ops verified", r.Verification)
	}
	if r.Anchors == nil || r.Articles == nil || r.Articles.Failed != 0 {
		t.Errorf("anchors %+v, articles %+v: both steps ran", r.Anchors, r.Articles)
	}
	// Two extraction calls, a retry, and two verdicts: each counted, with what the endpoint said it cost.
	if r.Tokens.Calls != 5 || r.Tokens.Input != 5*50 || r.Tokens.Output != 5*20 {
		t.Errorf("tokens = %+v, want 5 calls of 50 in and 20 out", r.Tokens)
	}

	// The door: every step, in order, all as the maintenance session.
	var steps []string
	for _, call := range door.calls() {
		if call.session != "maintenance-session" {
			t.Errorf("%s %s went as session %q", call.method, call.path, call.session)
		}
		step := call.method + " " + strings.TrimPrefix(call.path, "/api/runner/wiki/spaces/space-1/")
		if len(steps) == 0 || steps[len(steps)-1] != step {
			steps = append(steps, step)
		}
	}
	want := []string{"GET maintenance/run", "GET dossiers", "POST maintenance/changesets", "GET verifications",
		"POST verifications", "GET anchors", "POST article-plan", "POST maintenance/finish"}
	if !reflect.DeepEqual(steps, want) {
		t.Errorf("the run went %v\nwant %v", steps, want)
	}
	// The pages stop at the position the task expects, and read on from each page's token.
	pages := door.of(http.MethodGet, "dossiers")
	if len(pages) != 2 || pages[0].query.Get("until") != "tok-expect" || pages[1].query.Get("after") != "tok-1" {
		t.Errorf("pages = %+v", pages)
	}
	// The proposals: dry run first, then the same ops, as the maintenance run's.
	proposals := door.of(http.MethodPost, "maintenance/changesets")
	if len(proposals) != 2 || proposals[0].body["dryRun"] != true || proposals[1].body["dryRun"] != nil {
		t.Fatalf("proposals = %+v, want a dry run and then the proposal", proposals)
	}
	if key, _ := proposals[1].body["idempotencyKey"].(string); !strings.HasPrefix(key, "wiki-maintain-") {
		t.Errorf("the proposal carries no idempotency key: %v", proposals[1].body)
	}
	ops := proposals[1].body["ops"].([]interface{})
	first := ops[0].(map[string]interface{})
	entry := first["entry"].(map[string]interface{})
	if entry["kind"] != "convention" || !reflect.DeepEqual(entry["topics"], []interface{}{"testing"}) ||
		!reflect.DeepEqual(entry["anchors"], []interface{}{map[string]interface{}{"type": "path", "path": "src/app.go"}}) {
		t.Errorf("the first add = %v", first)
	}
	if !reflect.DeepEqual(first["sources"], []interface{}{map[string]interface{}{"kind": "turn", "ref": "turn-1", "quote": "以后 fixture 里不要写死端口"}}) {
		t.Errorf("the source is not the record behind line L1: %v", first["sources"])
	}
	second := ops[1].(map[string]interface{})["sources"].([]interface{})[0].(map[string]interface{})
	if second["kind"] != "tool_call" || second["ref"] != "call-2" {
		t.Errorf("the corrected pitfall cites %v, want the tool call behind L2", second)
	}

	// The end: succeeded, to the last page's token, with the report and its spend.
	end := finished(t, door)
	if end["outcome"] != "succeeded" || end["to"] != "tok-expect" {
		t.Errorf("the run ended %v", end)
	}
	report, _ := end["report"].(map[string]interface{})
	tokens, _ := report["tokens"].(map[string]interface{})
	if tokens["calls"] != float64(5) || report["offTopic"] != float64(1) {
		t.Errorf("the report the server kept = %v", report)
	}

	// Every model call went through a clean Claude Code, and none of them thought.
	extraction := 0
	for _, spawn := range spawns() {
		env := spawnEnv(spawn)
		args := strings.Join(spawn.Args, " ")
		if !strings.Contains(args, "--bare") || !strings.Contains(args, "--strict-mcp-config") || !strings.Contains(args, "--no-session-persistence") {
			t.Errorf("not a clean launch: %v", spawn.Args)
		}
		if env["HOME"] == realHome || env["ANTHROPIC_API_KEY"] != "" || env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
			t.Errorf("the clean call's environment leaked: HOME=%q key=%q effort=%q thinking=%q", env["HOME"], env["ANTHROPIC_API_KEY"],
				env["CLAUDE_CODE_EFFORT_LEVEL"], env["MAX_THINKING_TOKENS"])
		}
		if strings.Contains(spawn.Prompt, "==== CASE FILE ====") {
			extraction++
			if !strings.Contains(args, wikiMaintainSystemPrompt) {
				t.Errorf("an extraction without the extractor's system prompt: %v", spawn.Args)
			}
		}
	}
	if extraction != 3 {
		t.Errorf("extraction calls = %d, want the two cases and one retry", extraction)
	}
	for _, request := range vllm.Requests() {
		if request.Authorization != "Bearer tok-local-vllm" || request.APIKey != "" || request.thinks() {
			t.Errorf("a request to the model: auth %q key %q thinking %s effort %q", request.Authorization, request.APIKey, request.Thinking, request.Effort)
		}
	}
	// What the model was told: this repository, what it is, and what to answer for a case about something else.
	var prompt string
	for _, request := range vllm.Requests() {
		if strings.Contains(request.Prompt, "修 fixture 的端口") && !strings.Contains(request.Prompt, "REJECTED") {
			prompt = request.Prompt
		}
	}
	for _, want := range []string{`THE REPOSITORY: "app"`, normalizeWikiRepoURL(f.bare), "App is the spec's small service",
		`{"offTopic": true}`, "at most 6 objects", "- testing: Tests: fixtures, flakes.", "- runner: Runner"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("the extraction prompt does not say %q", want)
		}
	}
}

// A session in the same workspace about another product — the demo's werewolf game — gives no entry,
// and an entry whose code anchors all point outside the repository is dropped: both counted.
func TestWikiMaintainTakesNothingFromASessionAboutSomethingElse(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, werewolfDossier("session-b"))
	door.propose = func(ops []interface{}, dryRun bool) (int, string) {
		t.Errorf("the run proposed %v from a session about something else", ops)
		return pendingForVerification(ops, dryRun)
	}
	vllm := newFakeVLLM(t, extractorAnswers)
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)
	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v", err)
	}
	if summary.Report.OffTopic != 1 || summary.Report.Entries.Kept != 0 || summary.Report.Ops.Proposed != 0 {
		t.Errorf("report = %+v", summary.Report)
	}
	if end := finished(t, door); end["outcome"] != "succeeded" {
		t.Errorf("a run with nothing to propose still covered its sessions: %v", end)
	}
	// The anchor half, on its own: a path of this repository holds, one of another does not.
	repo := openWikiImportRepoAt(f.checkout)
	if repo == nil {
		t.Fatal("the checkout does not open")
	}
	if len(repo.anchors(map[string]interface{}{"paths": []interface{}{"src/components/GameBoard.tsx"}})) != 0 {
		t.Error("a path outside the repository was taken as an anchor")
	}
}

// A line of a dossier runs on as far as its own four-space indent does — through its blank lines too —
// and a quote from its third paragraph is a quote from that line.
func TestWikiMaintainReadsALineOfManyParagraphsWhole(t *testing.T) {
	dossier := wikiDossier{
		Text: "SESSION: a long prompt\nclaude · started 2026-09-27 · status SUCCEEDED\n\n" +
			"L1 taskprompt: 请开始执行任务「近邻查询走索引」。\n    \n    任务描述：\n    ## 背景\n      - `nearNeighbours` 随行数线性增长；\n" +
			"   … (3 lines omitted)\n" +
			"L5 owner: 先诊断，再改。\n" +
			"SESSION: not a continuation\n",
		Sources: []wikiDossierSource{{Ref: "L1", Kind: "turn", ID: "turn-1"}, {Ref: "L5", Kind: "turn", ID: "turn-5"}},
	}
	lines := wikiMaintainLines(dossier)
	if got := lines["L1"].text; got != "请开始执行任务「近邻查询走索引」。\n\n任务描述：\n## 背景\n  - `nearNeighbours` 随行数线性增长；" {
		t.Errorf("L1 = %q", got)
	}
	if got := lines["L5"].text; got != "先诊断，再改。" {
		t.Errorf("L5 = %q: the header after it is not part of it", got)
	}
	sources, problems := wikiMaintainSources([]interface{}{
		map[string]interface{}{"ref": "L1", "quote": "nearNeighbours 随行数线性增长"},
	}, lines)
	if len(problems) != 0 || len(sources) != 1 {
		t.Errorf("a quote from the line's third paragraph: sources %v, problems %v", sources, problems)
	}
}

// ── Failures move nothing ───────────────────────────────────────────────────────────────────────

func TestWikiMaintainMovesNothingWhenTheServerRefusesAnOp(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
	door.propose = func(ops []interface{}, dryRun bool) (int, string) {
		if dryRun {
			return pendingForVerification(ops, dryRun)
		}
		// What passed the dry run is refused now: its record went away in between.
		raw, _ := json.Marshal(map[string]interface{}{"changesetId": "cs-1", "ops": []interface{}{
			map[string]interface{}{"seq": 0, "status": "applied", "opId": "op-0", "entryId": "e-0"},
			map[string]interface{}{"seq": 1, "status": "refused", "reasons": []interface{}{map[string]interface{}{"code": "WIKI_SOURCE_UNRESOLVED", "message": "no such record"}}},
		}})
		return http.StatusOK, string(raw)
	}
	vllm := newFakeVLLM(t, extractorAnswers)
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)
	summary, err := runMaintainCLI(t)
	if err == nil || !strings.Contains(err.Error(), "the cursor did not move") {
		t.Fatalf("a run with a refused op succeeded: %v", err)
	}
	end := finished(t, door)
	report, _ := end["report"].(map[string]interface{})
	ops, _ := report["ops"].(map[string]interface{})
	if end["outcome"] != "failed" || end["to"] != nil || report["stoppedAt"] != "propose" || ops["refused"] != float64(1) {
		t.Errorf("the run ended %v", end)
	}
	if len(summary.Refused) != 1 || !strings.Contains(summary.Refused[0], "WIKI_SOURCE_UNRESOLVED") {
		t.Errorf("refused = %v", summary.Refused)
	}
	if len(door.of(http.MethodGet, "anchors")) != 0 || len(door.of(http.MethodPost, "article-plan")) != 0 {
		t.Error("the run went on past the step that failed")
	}
}

func TestWikiMaintainTripsTheBreakerBeforeProposingAnything(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 100, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"), portDossier("session-b"))
	door.propose = func(ops []interface{}, dryRun bool) (int, string) {
		if !dryRun {
			t.Errorf("the run proposed %d ops past the breaker", len(ops))
		}
		outcomes := []interface{}{}
		for i := range ops {
			outcomes = append(outcomes, map[string]interface{}{"seq": i, "status": "applied", "entryId": fmt.Sprintf("e-%d", i)})
		}
		raw, _ := json.Marshal(map[string]interface{}{"changesetId": nil, "dryRun": true, "ops": outcomes})
		return http.StatusOK, string(raw)
	}
	counter := 0
	var mu sync.Mutex
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		mu.Lock()
		counter++
		n := counter
		mu.Unlock()
		// Six conventions a case, each its own: twelve the mode would apply, of a hundred active entries.
		var entries []string
		for i := 0; i < 6; i++ {
			entries = append(entries, fmt.Sprintf(`{"kind":"convention","title":"规则 %d-%d","summary":"照做。","topic":"testing","rule":"照做","scope":["全部"],"exceptions":"","anchors":{"paths":[],"commits":[]},"sources":[{"ref":"L1","quote":"以后 fixture 里不要写死端口"}]}`, n, i))
		}
		return http.StatusOK, "[" + strings.Join(entries, ",") + "]"
	})
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)
	_, err := runMaintainCLI(t)
	if err == nil {
		t.Fatal("a run past the breaker succeeded")
	}
	end := finished(t, door)
	report, _ := end["report"].(map[string]interface{})
	if end["outcome"] != "failed" || report["stoppedAt"] != "breaker" || !strings.Contains(fmt.Sprint(end["error"]), "circuit breaker") {
		t.Errorf("the run ended %v", end)
	}
}

func TestWikiMaintainStopsAtTheFirst401(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"), portDossier("session-b"), portDossier("session-c"))
	vllm := newFakeVLLM(t, func(string) (int, string) { return http.StatusUnauthorized, "" })
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)
	_, err := runMaintainCLI(t, "--concurrency", "1")
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("a refused token did not stop the run: %v", err)
	}
	if n := len(vllm.Requests()); n != 1 {
		t.Errorf("the model was asked %d times after it refused the token, want once", n)
	}
	if end := finished(t, door); end["outcome"] != "failed" {
		t.Errorf("the run ended %v", end)
	}
}

func TestWikiMaintainRefusesACheckoutOfAnotherRepository(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = func() (int, string) {
		status, body := maintainContext(f, "tiered", 0, "tok-expect")()
		return status, strings.Replace(body, strconv.Quote(normalizeWikiRepoURL(f.bare)), `"github.com/someone/else"`, 1)
	}
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, extractorAnswers))
	_, err := runMaintainCLI(t)
	if err == nil || !strings.Contains(err.Error(), "not of the space's repository github.com/someone/else") {
		t.Fatalf("a checkout of another repository was run in: %v", err)
	}
	if len(door.of(http.MethodGet, "dossiers")) != 0 {
		t.Error("the run read dossiers it could not check")
	}
	end := finished(t, door)
	if report, _ := end["report"].(map[string]interface{}); end["outcome"] != "failed" || report["stoppedAt"] != "checkout" {
		t.Errorf("the run ended %v", end)
	}
}

func TestWikiMaintainCitesTheRecordWithoutTheQuoteTheServerDoesNotFind(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
	var dryRuns int
	door.propose = func(ops []interface{}, dryRun bool) (int, string) {
		outcomes := []interface{}{}
		if dryRun {
			dryRuns++
		}
		for i, raw := range ops {
			op := raw.(map[string]interface{})
			source := op["sources"].([]interface{})[0].(map[string]interface{})
			if _, quoted := source["quote"]; quoted && dryRun && i == 0 {
				outcomes = append(outcomes, map[string]interface{}{"seq": i, "status": "refused",
					"reasons": []interface{}{map[string]interface{}{"code": "WIKI_QUOTE_NOT_FOUND", "message": "not in the record"}}})
				continue
			}
			outcomes = append(outcomes, map[string]interface{}{"seq": i, "status": "applied", "opId": fmt.Sprintf("op-%d", i)})
		}
		raw, _ := json.Marshal(map[string]interface{}{"changesetId": "cs-1", "dryRun": dryRun, "ops": outcomes})
		return http.StatusOK, string(raw)
	}
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, extractorAnswers))
	if _, err := runMaintainCLI(t); err != nil {
		t.Fatalf("orbit wiki maintain: %v", err)
	}
	if dryRuns != 2 {
		t.Errorf("dry runs = %d, want the batch checked again without the quote", dryRuns)
	}
	proposals := door.of(http.MethodPost, "maintenance/changesets")
	last := proposals[len(proposals)-1].body["ops"].([]interface{})[0].(map[string]interface{})
	source := last["sources"].([]interface{})[0].(map[string]interface{})
	if _, quoted := source["quote"]; quoted || source["ref"] != "turn-1" {
		t.Errorf("the proposal cites %v, want the record with no quote", source)
	}
}

func TestWikiMaintainIsRefusedToAnyButAMaintenanceRun(t *testing.T) {
	door := newFakeMaintainDoor(t)
	door.context = func() (int, string) {
		return http.StatusForbidden, `{"code":"WIKI_NOT_MAINTENANCE_SESSION","message":"only a Wiki maintenance run of this space"}`
	}
	wikiMaintainSession(t, door.URL, nil)
	var out strings.Builder
	err := cmdWikiCLI([]string{"maintain", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "this session is not one (WIKI_NOT_MAINTENANCE_SESSION)") {
		t.Fatalf("a session that is not a maintenance run ran it: %v", err)
	}
	if len(door.of(http.MethodPost, "maintenance/finish")) != 0 {
		t.Error("a refused run told the server it ended")
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	if err := cmdWikiCLI([]string{"maintain", "--space", "space-1"}, strings.NewReader(""), io.Discard); err == nil ||
		!strings.Contains(err.Error(), "acts for the Orbit session it runs in") {
		t.Errorf("maintain ran outside a session: %v", err)
	}
}

// ── What it is made of ──────────────────────────────────────────────────────────────────────────

// The maintenance session's one Bash call is the whole run: Claude Code must neither kill it at two
// minutes nor move it to the background, where a session with no Read could never learn how it ended.
func TestWikiMaintainCleanStartLetsTheRunFinish(t *testing.T) {
	job := maintenanceJob(t)
	_, env, _ := startMaintenance(t, job, true)
	budget := strconv.FormatInt(wikiMaintainRunBudget.Milliseconds(), 10)
	for key, want := range map[string]string{
		"BASH_DEFAULT_TIMEOUT_MS":              budget,
		"BASH_MAX_TIMEOUT_MS":                  budget,
		"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
	} {
		if env[key] != want {
			t.Errorf("%s=%q, want %q", key, env[key], want)
		}
	}
	if budget != "10800000" {
		t.Errorf("the run's budget is %s ms, want three hours", budget)
	}
}

func TestWikiMaintainExpandsTheTildeToTheAccountsHome(t *testing.T) {
	account, err := user.Current()
	if err != nil || account.HomeDir == "" {
		t.Skip("no account database entry to read a home from")
	}
	// Inside a maintenance session HOME is the session's own empty directory.
	t.Setenv("HOME", t.TempDir())
	if got := wikiMaintainExpand("~/orbit"); got != filepath.Join(account.HomeDir, "orbit") {
		t.Errorf("~/orbit = %q, want the account's %q", got, filepath.Join(account.HomeDir, "orbit"))
	}
	if got := wikiMaintainExpand("/srv/orbit"); got != "/srv/orbit" {
		t.Errorf("an absolute directory changed: %q", got)
	}
}

func TestWikiMaintainNormalizesRepositoriesAsTheServerDoes(t *testing.T) {
	for raw, want := range map[string]string{
		"git@github.com:a/b.git":         "github.com/a/b",
		"https://github.com/a/b":         "github.com/a/b",
		"https://github.com/a/b/":        "github.com/a/b",
		"ssh://git@GitHub.com/a/b.git":   "github.com/a/b",
		"https://user:pw@GitHub.com/a/b": "github.com/a/b",
		"/srv/git/app.git":               "/srv/git/app",
	} {
		if got := normalizeWikiRepoURL(raw); got != want {
			t.Errorf("%s = %q, want %q", raw, got, want)
		}
	}
}

func TestWikiMaintainIsTheContractsCommand(t *testing.T) {
	job := wikiContract(t)["maintenance"].(map[string]interface{})["job"].(map[string]interface{})
	rules := job["rules"].(map[string]interface{})
	for name, value := range map[string]int{
		"runSessionsMax": wikiMaintainRunSessionsMax, "entriesPerSessionMax": wikiMaintainEntriesPerSession,
		"extractConcurrency": wikiMaintainExtractConcurrency,
	} {
		if int(rules[name].(float64)) != value {
			t.Errorf("rules.%s = %v, this build has %d", name, rules[name], value)
		}
	}
	cli := job["cli"].(map[string]interface{})
	if cli["maintainPrecondition"] != wikiMaintainPrecondition || cli["checkPrecondition"] != wikiCheckPrecondition {
		t.Errorf("the preconditions drifted from the contract:\n%q\n%q", cli["maintainPrecondition"], cli["checkPrecondition"])
	}
	if !strings.HasPrefix(wikiMaintainDescription, wikiMaintainPrecondition) || !strings.HasPrefix(wikiCheckDescription, wikiCheckPrecondition) {
		t.Error("a description does not lead with its precondition")
	}
	specs := map[string]*cliCapabilitySpec{}
	for i := range wikiCLICapabilities {
		specs[wikiCLICapabilities[i].Tool] = &wikiCLICapabilities[i]
	}
	if spec := specs["wiki_maintain"]; spec == nil || spec.Usage != cli["maintain"] || !spec.SessionOnly || spec.Description != wikiMaintainDescription {
		t.Errorf("the maintain capability = %+v, the contract's usage %q", spec, cli["maintain"])
	}
	if spec := specs["wiki_check"]; spec == nil || spec.Usage != cli["check"] || spec.SessionOnly || spec.Description != wikiCheckDescription {
		t.Errorf("the check capability = %+v, the contract's usage %q", spec, cli["check"])
	}
	// The routes it calls are the contract's, and every one a runner-door maintenance route.
	routes := job["routes"].(map[string]interface{})
	maintenance := wikiContract(t)["agentSurface"].(map[string]interface{})["doors"].(map[string]interface{})["runner"].(map[string]interface{})["maintenanceRoutes"].([]interface{})
	for name, path := range map[string]string{
		"context": "GET /api/runner/wiki/spaces/:id/maintenance/run", "propose": "POST /api/runner/wiki/spaces/:id/maintenance/changesets",
		"finish": "POST /api/runner/wiki/spaces/:id/maintenance/finish", "check": "GET /api/runner/wiki/spaces/:id/maintenance/check",
	} {
		if routes[name] != path {
			t.Errorf("routes.%s = %v, this build calls %s", name, routes[name], path)
		}
		found := false
		for _, route := range maintenance {
			found = found || route == path
		}
		if !found {
			t.Errorf("%s is not a runner-door maintenance route", path)
		}
	}
	// The task's command is the check, as the server writes it.
	task := job["task"].(map[string]interface{})
	if task["acceptanceCommand"] != "orbit wiki check --space <id> --expect-cursor <token>" || !strings.HasPrefix(cli["check"].(string), task["acceptanceCommand"].(string)) {
		t.Errorf("the task's command %q is not the check's usage %q", task["acceptanceCommand"], cli["check"])
	}
	for _, verb := range []string{"maintain", "check"} {
		if !strings.Contains(wikiHelp, "orbit wiki "+verb+" --space") {
			t.Errorf("orbit wiki --help does not list %s", verb)
		}
	}
	if rules := strings.Join(orbitCLIAllowedTools("/usr/local/bin/orbit", false), "\n"); !strings.Contains(rules, "Bash(/usr/local/bin/orbit wiki maintain *)") {
		t.Errorf("orbit wiki maintain is not pre-approved for the maintenance session: %s", rules)
	}
}

// ── orbit wiki check ────────────────────────────────────────────────────────────────────────────

func TestWikiCheckExitsNonZeroUnlessTheRunDidWhatItsTaskExpected(t *testing.T) {
	door := newFakeMaintainDoor(t)
	var answer string
	door.check = func(expect string) (int, string) {
		if expect != "tok-expect" {
			t.Errorf("the check asked about %q", expect)
		}
		return http.StatusOK, answer
	}
	wikiMaintainSession(t, door.URL, nil)
	run := func() (string, error) {
		var out strings.Builder
		err := cmdWikiCLI([]string{"check", "--space", "space-1", "--expect-cursor", "tok-expect"}, strings.NewReader(""), &out)
		return out.String(), err
	}

	// The cursor did not move to the token: non-zero, and it says why.
	answer = `{"spaceId":"space-1","expect":"tok-expect","position":"tok-before","reached":false,"run":{"taskId":"task-1","sessionId":"s","outcome":"truncated","opsRefused":null,"endedAt":"2026-09-28T06:00:00Z"},"ok":false,"problems":["The space's cursor stands before the position this task expects: the run did not get through its dossiers, or did not advance the cursor.","The run ended truncated: the run reached its limit of 120 model turns."]}`
	out, err := run()
	if err == nil {
		t.Fatal("a cursor that did not reach the token passed the check")
	}
	if !strings.Contains(out, "stands before the position") || !strings.Contains(out, "ended truncated") {
		t.Errorf("the check did not say why: %q", out)
	}

	// The cursor reached it, but the server refused ops of the run: non-zero still.
	answer = `{"spaceId":"space-1","expect":"tok-expect","position":"tok-expect","reached":true,"run":{"taskId":"task-1","sessionId":"s","outcome":"succeeded","opsRefused":2,"endedAt":"2026-09-28T06:00:00Z"},"ok":false,"problems":["The server refused 2 of the run's ops."]}`
	if out, err := run(); err == nil || !strings.Contains(out, "refused 2 of the run's ops") {
		t.Fatalf("a run with refused ops passed the check: %v %q", err, out)
	}

	// Reached, succeeded, nothing refused: 0.
	answer = `{"spaceId":"space-1","expect":"tok-expect","position":"tok-expect","reached":true,"run":{"taskId":"task-1","sessionId":"s","outcome":"succeeded","opsRefused":0,"endedAt":"2026-09-28T06:00:00Z"},"ok":true,"problems":[]}`
	if out, err := run(); err != nil || !strings.Contains(out, "reached the position the task expects") {
		t.Fatalf("a run that did its task failed the check: %v %q", err, out)
	}

	// It asks as the runner, with no session — the acceptance command's shell has none — even from inside one.
	for _, call := range door.of(http.MethodGet, "maintenance/check") {
		if call.session != "" {
			t.Errorf("the check sent a session header %q", call.session)
		}
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	if _, err := run(); err != nil {
		t.Errorf("the check needs a session it does not have: %v", err)
	}
}

func TestWikiCheckRefusesWhatIsNotAToken(t *testing.T) {
	door := newFakeMaintainDoor(t)
	door.check = func(string) (int, string) {
		return http.StatusBadRequest, `{"code":"WIKI_CURSOR_INVALID","message":"the token does not decode"}`
	}
	wikiMaintainSession(t, door.URL, nil)
	err := cmdWikiCLI([]string{"check", "--space", "space-1", "--expect-cursor", "nonsense"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "WIKI_CURSOR_INVALID") {
		t.Errorf("a token that does not decode: %v", err)
	}
	if err := cmdWikiCLI([]string{"check", "--space", "space-1"}, strings.NewReader(""), io.Discard); err == nil ||
		!strings.Contains(err.Error(), "--expect-cursor is required") {
		t.Errorf("a check with no token: %v", err)
	}
}
