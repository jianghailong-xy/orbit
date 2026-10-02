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
	// own is the run's own ops that wait for their verification, as the proposer's list hands them: a verdict
	// reported for one takes it off the list, so a second pass is handed what the first left. While it is nil,
	// verifications is answered once and the list is empty after.
	own   []map[string]interface{}
	check func(expect string) (int, string)
	// adoptable is what ended sessions left waiting, as the adoption list pages it; a verdict reported for one
	// takes it off the list, and adoptOutcome answers it (nil: applied as Auto). adoptMissing is a server that
	// predates the adoption routes.
	adoptable    []map[string]interface{}
	adoptOutcome func(verdict map[string]interface{}) map[string]interface{}
	adoptMissing bool
	verified     map[string]bool
	// The documents (wiki_maintain_docs_test.go). docs answers `GET …/maintenance/docs` (nil: a space with no
	// confirmed plan); plan and docsState `GET …/plan` and `GET …/docs`; material a section's material by
	// "slug#key"; withdraw and proposals the withdrawal and a plan proposal. Every document write is kept.
	docs      func() (int, string)
	plan      string
	docsState string
	material  map[string]string
	withdraw  func(body map[string]interface{}) (int, string)
	proposals func(body map[string]interface{}) (int, string)
}

func newFakeMaintainDoor(t *testing.T) *fakeMaintainDoor {
	t.Helper()
	d := &fakeMaintainDoor{pages: map[string]string{}, verified: map[string]bool{}}
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
			after := r.URL.Query().Get("after")
			page, ok := d.pages[after]
			if !ok {
				page = maintainPage(after, false)
			}
			status, body = http.StatusOK, maintainPageFrom(page, after)
		case r.Method == http.MethodPost && path == "maintenance/changesets" && d.propose != nil:
			ops, _ := request.body["ops"].([]interface{})
			dry, _ := request.body["dryRun"].(bool)
			status, body = d.propose(ops, dry)
		case r.Method == http.MethodGet && path == "verifications" && d.own != nil:
			status, body = http.StatusOK, d.ownPage()
		case r.Method == http.MethodGet && path == "verifications":
			status, body = http.StatusOK, firstNonEmpty(d.verifications, `{"spaceId":"space-1","mode":"automatic","items":[],"next":""}`)
			d.verifications = `{"spaceId":"space-1","mode":"automatic","items":[],"next":""}`
		case r.Method == http.MethodPost && path == "verifications":
			verdicts, _ := request.body["verdicts"].([]interface{})
			outcomes := []interface{}{}
			for _, v := range verdicts {
				verdict, _ := v.(map[string]interface{})
				d.mu.Lock()
				d.verified[fmt.Sprint(verdict["opId"])] = true
				d.mu.Unlock()
				outcomes = append(outcomes, map[string]interface{}{"opId": verdict["opId"], "status": "applied", "trust": "auto"})
			}
			raw, _ := json.Marshal(map[string]interface{}{"mode": "automatic", "outcomes": outcomes})
			status, body = http.StatusOK, string(raw)
		case path == "maintenance/verifications" && d.adoptMissing:
			status, body = http.StatusNotFound, `{"message":"Cannot `+r.Method+` `+r.URL.Path+`","error":"Not Found","statusCode":404}`
		case r.Method == http.MethodGet && path == "maintenance/verifications":
			status, body = http.StatusOK, d.adoptionPage(r.URL.Query())
		case r.Method == http.MethodPost && path == "maintenance/verifications":
			verdicts, _ := request.body["verdicts"].([]interface{})
			outcomes := []interface{}{}
			for _, v := range verdicts {
				verdict, _ := v.(map[string]interface{})
				outcome := map[string]interface{}{"opId": verdict["opId"], "status": "applied", "trust": "auto", "verdict": verdict["verdict"]}
				if d.adoptOutcome != nil {
					outcome = d.adoptOutcome(verdict)
				}
				d.mu.Lock()
				d.verified[fmt.Sprint(verdict["opId"])] = true
				d.mu.Unlock()
				outcomes = append(outcomes, outcome)
			}
			raw, _ := json.Marshal(map[string]interface{}{"mode": "automatic", "outcomes": outcomes})
			status, body = http.StatusOK, string(raw)
		case r.Method == http.MethodGet && path == "anchors":
			status, body = http.StatusOK, `{"spaceId":"space-1","repo":null,"entries":[],"next":null}`
		case r.Method == http.MethodGet && path == "maintenance/docs":
			status, body = http.StatusOK, `{"spaceId":"space-1","plan":null,"build":null,"sections":[],"unplaced":[],"unplacedMore":0,`+
				`"proposed":{"entryIds":[],"commits":[],"paths":[]}}`
			if d.docs != nil {
				status, body = d.docs()
			}
		case r.Method == http.MethodGet && path == "plan" && d.plan != "":
			status, body = http.StatusOK, d.plan
		case r.Method == http.MethodGet && path == "docs" && d.docsState != "":
			status, body = http.StatusOK, d.docsState
		case r.Method == http.MethodGet && strings.HasPrefix(path, "docs/") && strings.HasSuffix(path, "/material"):
			slug := strings.TrimSuffix(strings.TrimPrefix(path, "docs/"), "/material")
			status, body = http.StatusOK, firstNonEmpty(d.material[slug+"#"+r.URL.Query().Get("section")], `{"records":[],"unresolved":[]}`)
		case r.Method == http.MethodPost && strings.HasPrefix(path, "docs/") && strings.Count(path, "/") == 1:
			var sections []interface{}
			written, _ := request.body["sections"].([]interface{})
			for _, item := range written {
				section, _ := item.(map[string]interface{})
				sections = append(sections, map[string]interface{}{"key": section["key"], "outcome": "written", "stats": map[string]int{"sentences": 1}})
			}
			raw, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "slug": strings.TrimPrefix(path, "docs/"), "status": "ok",
				"sections": sections, "counts": map[string]int{"sentences": 1, "sourced": 1}})
			status, body = http.StatusOK, string(raw)
		case r.Method == http.MethodPost && path == "maintenance/docs/withdrawals" && d.withdraw != nil:
			status, body = d.withdraw(request.body)
		case r.Method == http.MethodPost && path == "plan/proposals" && d.proposals != nil:
			status, body = d.proposals(request.body)
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

// adoptionPage is the adoption list as the server pages it: the ops still waiting after `after`, oldest first,
// at most `limit`, and the last one's id as next when more wait.
func (d *fakeMaintainDoor) adoptionPage(query url.Values) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	limit, _ := strconv.Atoi(query.Get("limit"))
	after, started := query.Get("after"), query.Get("after") == ""
	items, next := []map[string]interface{}{}, ""
	for _, item := range d.adoptable {
		id := fmt.Sprint(item["opId"])
		if !started {
			started = id == after
			continue
		}
		if d.verified[id] {
			continue
		}
		if len(items) == limit {
			next = fmt.Sprint(items[len(items)-1]["opId"])
			break
		}
		items = append(items, item)
	}
	raw, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "mode": "automatic", "items": items, "next": next})
	return string(raw)
}

// ownPage is the run's own ops still waiting for their verification, as the proposer's list hands them.
func (d *fakeMaintainDoor) ownPage() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	items := []map[string]interface{}{}
	for _, item := range d.own {
		if !d.verified[fmt.Sprint(item["opId"])] {
			items = append(items, item)
		}
	}
	raw, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "mode": "automatic", "items": items, "next": ""})
	return string(raw)
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

// maintainPageFrom is a page as the server serves it, saying where it starts: after the token it was read
// after, or, for the first page, at the watermark — `tok-watermark` here.
func maintainPageFrom(page, after string) string {
	var body map[string]interface{}
	if json.Unmarshal([]byte(page), &body) != nil {
		return page
	}
	body["from"] = firstNonEmpty(after, "tok-watermark")
	raw, _ := json.Marshal(body)
	return string(raw)
}

// maintainDossier is one session's dossier, its lines L1… mapped to the records given, each with where in its
// record's text its words are: the spans given for it, or — for a line given none — the words after its
// speaker, whole, as a line the dossier copied from its record is.
func maintainDossier(session, title string, lines []string, records []string, spans map[int][]wikiDossierSpan, unchanged bool) map[string]interface{} {
	text := "SESSION: " + title + "\nanthropic/claude-opus-5 · started 2026-09-20 · status SUCCEEDED\n\n"
	sources := []interface{}{}
	for i, line := range lines {
		ref := "L" + strconv.Itoa(i+1)
		text += ref + " " + line + "\n"
		kind, id, _ := strings.Cut(records[i], ":")
		placed, given := spans[i]
		if !given {
			_, words, _ := strings.Cut(line, ": ")
			placed = []wikiDossierSpan{maintainSpan(0, words)}
		}
		sources = append(sources, map[string]interface{}{"ref": ref, "kind": kind, "id": id, "spans": placed})
	}
	return map[string]interface{}{"sessionId": session, "taskId": "", "title": title, "text": text, "tokens": 200,
		"truncated": false, "tainted": false, "sources": sources, "hash": strings.Repeat("c", 64), "unchanged": unchanged}
}

// maintainSpan is `words` at `start` of a record's text, counted as the server counts: in code points.
func maintainSpan(start int, words string) wikiDossierSpan {
	return wikiDossierSpan{Start: start, End: start + len([]rune(words)), Text: words}
}

// portDossier is a session about the repository: the owner's rule, a failure and its cause. The failure is a
// tool call, whose line is the dossier's writing — `$ command → ERR: first line` — and whose record is
// "Bash\ncommand: go test ./...\nconnect ECONNREFUSED 127.0.0.1:9000": its spans are the command and the output.
func portDossier(session string) map[string]interface{} {
	return maintainDossier(session, "修 fixture 的端口", []string{
		"owner: 以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。",
		"tool: $ go test ./... → ERR: connect ECONNREFUSED 127.0.0.1:9000",
		"agent: 根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。",
	}, []string{"turn:turn-1", "tool_call:call-2", "event:event-3"}, map[int][]wikiDossierSpan{
		1: {maintainSpan(14, "go test ./..."), maintainSpan(28, "connect ECONNREFUSED 127.0.0.1:9000")},
	}, false)
}

// werewolfDossier is a session of the same workspace about something else altogether.
func werewolfDossier(session string) map[string]interface{} {
	return maintainDossier(session, "设计狼人杀软件界面", []string{
		"owner: 12 人预女猎白，金神职红狼人绿村民，联网手机网页打字发言。",
	}, []string{"turn:turn-9"}, nil, false)
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
	if r.Verification == nil || r.Verification.Verified != 2 || r.Verification.Failed != 0 || r.Verification.Adopted != nil {
		t.Errorf("verification = %+v, want both ops verified and nothing adopted", r.Verification)
	}
	// With no confirmed plan the run writes no document, says so, and the topic articles are written no more.
	if r.Anchors == nil || r.Docs == nil || r.Docs.Skipped != "no_confirmed_plan" || r.Docs.PlanVersion != nil {
		t.Errorf("anchors %+v, documents %+v: both steps ran, and no document was written without a confirmed plan", r.Anchors, r.Docs)
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
	// After its own ops, the run asks what ended sessions left waiting: nothing, here.
	want := []string{"GET maintenance/run", "GET dossiers", "POST maintenance/changesets", "GET verifications",
		"POST verifications", "GET maintenance/verifications", "GET anchors", "GET maintenance/docs", "POST maintenance/finish"}
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
	if !reflect.DeepEqual(first["sources"], []interface{}{map[string]interface{}{"kind": "turn", "ref": "turn-1", "quote": "以后 fixture 里不要写死端口",
		"locator": map[string]interface{}{"start": float64(0), "end": float64(18)}}}) {
		t.Errorf("the source is not the record behind line L1, quoted where its words are: %v", first["sources"])
	}
	// The pitfall quotes the tool call's own output at the place its span names — not the line `$ go test ./...
	// → ERR: …` the dossier wrote for it.
	second := ops[1].(map[string]interface{})["sources"].([]interface{})[0].(map[string]interface{})
	if !reflect.DeepEqual(second, map[string]interface{}{"kind": "tool_call", "ref": "call-2", "quote": "connect ECONNREFUSED 127.0.0.1:9000",
		"locator": map[string]interface{}{"start": float64(28), "end": float64(63)}}) {
		t.Errorf("the corrected pitfall cites %v, want the tool call behind L2 quoted from its output's span", second)
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

// ── What ended sessions left waiting ────────────────────────────────────────────────────────────

// ownOps is the adoption tests' run's own two ops, as the proposer's verification list hands them.
const ownOps = `{"spaceId":"space-1","mode":"automatic","items":[` +
	`{"opId":"op-0","op":"add","entryId":"e-0","entry":{"kind":"convention","title":"fixture 不写死端口","summary":"s","fields":{}},"sources":[{"kind":"turn","ref":"turn-1","quote":"以后 fixture 里不要写死端口","text":"以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。","truncated":false}],"similar":[]},` +
	`{"opId":"op-1","op":"add","entryId":"e-1","entry":{"kind":"pitfall","title":"PORT","summary":"s","fields":{}},"sources":[{"kind":"tool_call","ref":"call-2","quote":null,"text":"connect ECONNREFUSED 127.0.0.1:9000","truncated":false}],"similar":[]}` +
	`],"next":""}`

// adoptedItem is op n of those ended sessions left waiting, as the adoption list hands it: its record's text,
// and among its neighbours the entry a later op made of the same knowledge, live since.
func adoptedItem(n int) map[string]interface{} {
	id := fmt.Sprintf("left-%02d", n)
	return map[string]interface{}{
		"opId": id, "changesetId": "cs-failed-run", "op": "add", "entryId": nil,
		"entry": map[string]interface{}{"kind": "pitfall", "title": fmt.Sprintf("Adopted claim %d", n), "summary": "s", "fields": map[string]interface{}{}},
		"sources": []interface{}{map[string]interface{}{"kind": "event", "ref": "event-" + id, "quote": nil,
			"text": fmt.Sprintf("what the failed run's session %d observed", n), "truncated": false}},
		"similar": []interface{}{map[string]interface{}{"id": "entry-later", "kind": "pitfall", "title": "The same claim, live since", "status": "active", "trust": "auto"}},
	}
}

// adoptionAnswers answers as the model would: the run's own ops and most adopted ones supported, adopted op 3 a
// duplicate of the later live entry it was offered, and adopted op 7 no verdict at all.
func adoptionAnswers(prompt string) (int, string) {
	switch {
	case strings.Contains(prompt, "==== CASE FILE ===="):
		return extractorAnswers(prompt)
	case strings.Contains(prompt, "Adopted claim 3\n"):
		return http.StatusOK, `{"verdict":"duplicate","reason":"the live entry says this","duplicateOf":"E1"}`
	case strings.Contains(prompt, "Adopted claim 7\n"):
		return http.StatusOK, "I cannot tell."
	}
	return http.StatusOK, `{"verdict":"supported","reason":"the cited record says exactly this"}`
}

// adoptedVerdicts is every verdict reported on the adoption route, in the order the run reported them.
func adoptedVerdicts(t *testing.T, door *fakeMaintainDoor) []map[string]interface{} {
	t.Helper()
	var out []map[string]interface{}
	for _, call := range door.calls() {
		if call.method == http.MethodPost && strings.HasSuffix(call.path, "/maintenance/verifications") {
			verdicts, _ := call.body["verdicts"].([]interface{})
			for _, v := range verdicts {
				out = append(out, v.(map[string]interface{}))
			}
		}
	}
	return out
}

// Three failed runs left 71 ops waiting in the owner's space, and only a proposer verifies its own. The next
// run verifies its own ops first, then adopts theirs — at most the contract's number a run, oldest first, on
// the adoption routes — and one left without a verdict waits for the run after, which takes the rest.
func TestWikiMaintainAdoptsWhatEndedSessionsLeftWaitingAfterItsOwnOps(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
	door.propose = pendingForVerification
	door.verifications = ownOps
	for n := 1; n <= wikiMaintainAdoptOpsMax+10; n++ {
		door.adoptable = append(door.adoptable, adoptedItem(n))
	}
	vllm := newFakeVLLM(t, adoptionAnswers)
	spawns := fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	// The one adopted op the model gave no verdict for fails nothing: the run succeeded and moved the cursor.
	if summary.Outcome != "succeeded" || !summary.Advanced || summary.Cursor != "tok-expect" {
		t.Errorf("summary = %+v, want a run that succeeded and advanced the cursor", summary)
	}
	v := summary.Report.Verification
	if v == nil || v.Verified != 2 || v.Failed != 0 || v.Adopted == nil || *v.Adopted != (wikiMaintainAdopted{Ops: wikiMaintainAdoptOpsMax, Verified: wikiMaintainAdoptOpsMax - 1, Failed: 1}) {
		t.Fatalf("verification = %+v (adopted %+v), want its own two verified, and %d adopted: all but one verified", v, v.Adopted, wikiMaintainAdoptOpsMax)
	}
	if v.WaitingForNextRun != 1 {
		t.Errorf("%d ops waiting for the next run, want the adopted one without a verdict", v.WaitingForNextRun)
	}

	// Its own ops first; then the adopted ones, oldest first and no more than the cap, each on the adoption
	// route — as the maintenance session, and with the verdict the model gave.
	var order []string
	for _, call := range door.calls() {
		if call.method != http.MethodPost {
			continue
		}
		switch call.path {
		case "/api/runner/wiki/spaces/space-1/verifications":
			order = append(order, "own")
		case "/api/runner/wiki/spaces/space-1/maintenance/verifications":
			order = append(order, "adopted")
			if call.session != "maintenance-session" {
				t.Errorf("an adopted op's verdict went as session %q", call.session)
			}
		}
	}
	if len(order) != 2+wikiMaintainAdoptOpsMax-1 || order[0] != "own" || order[1] != "own" || order[2] != "adopted" {
		t.Errorf("verdicts went %v: want the run's own two first, then the adopted ones", order)
	}
	adopted := adoptedVerdicts(t, door)
	for i, verdict := range adopted {
		n := i + 1
		if n >= 7 {
			n++ // op 7 had no verdict to report
		}
		if verdict["opId"] != fmt.Sprintf("left-%02d", n) || verdict["model"] != "qwen3.8-27b-fp8" {
			t.Fatalf("adopted verdict %d = %v, want left-%02d's, by the model", i, verdict, n)
		}
	}
	if duplicate := adopted[2]; duplicate["verdict"] != "duplicate" || duplicate["duplicateOf"] != "entry-later" {
		t.Errorf("the adopted op a later op made live = %v: want a duplicate of the live entry it was offered", duplicate)
	}
	for _, verdict := range adopted {
		if verdict["opId"] == fmt.Sprintf("left-%02d", wikiMaintainAdoptOpsMax+1) {
			t.Errorf("the run went past its cap: %v", verdict)
		}
	}
	// What the model was handed for an adopted op: its record, and the later live entry to name as a duplicate.
	var third string
	for _, spawn := range spawns() {
		if strings.Contains(spawn.Prompt, "Adopted claim 3\n") {
			third = spawn.Prompt
		}
	}
	for _, part := range []string{"what the failed run's session 3 observed", "- E1: [pitfall] The same claim, live since"} {
		if !strings.Contains(third, part) {
			t.Errorf("the adopted op's prompt does not carry %q:\n%s", part, third)
		}
	}
	// The list: one op first, to know whether there is anything to adopt, then page after page from the oldest.
	var pages []string
	for _, call := range door.of(http.MethodGet, "maintenance/verifications") {
		pages = append(pages, call.query.Get("after")+"/"+call.query.Get("limit"))
	}
	if want := []string{"/1", "/20", "left-20/20", "left-40/20"}; !reflect.DeepEqual(pages, want) {
		t.Errorf("the adoption list was read %v, want %v", pages, want)
	}

	// The report the server kept counts them apart, and every verdict's model call in the spend.
	report, _ := finished(t, door)["report"].(map[string]interface{})
	verification, _ := report["verification"].(map[string]interface{})
	if !reflect.DeepEqual(verification["adopted"], map[string]interface{}{"ops": float64(wikiMaintainAdoptOpsMax), "verified": float64(wikiMaintainAdoptOpsMax - 1), "failed": float64(1)}) {
		t.Errorf("the report's verification = %v", verification)
	}
	if tokens := summary.Report.Tokens; tokens.Calls != 2+2+wikiMaintainAdoptOpsMax {
		t.Errorf("tokens = %+v: want an extraction, its retry, two verdicts of its own and %d adopted", tokens, wikiMaintainAdoptOpsMax)
	}

	// The next run takes the rest: the ten past the cap, and the one the model gave no verdict for.
	var out strings.Builder
	if err := cmdWikiCLI([]string{"maintain", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("the next run: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "- adopted: 11 ops ended sessions left waiting for their verification, 10 verified, 1 without a verdict") {
		t.Errorf("the next run said:\n%s", out.String())
	}
	if got := len(adoptedVerdicts(t, door)); got != wikiMaintainAdoptOpsMax-1+10 {
		t.Errorf("%d adopted verdicts over two runs, want %d", got, wikiMaintainAdoptOpsMax-1+10)
	}
}

// A run that had nothing to extract still adopts: it sets the model up for what ended sessions left waiting.
func TestWikiMaintainAdoptsWhenItHasNothingOfItsOwn(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 0, "tok-expect")
	door.propose = func(ops []interface{}, dryRun bool) (int, string) {
		t.Errorf("the run proposed %v with no dossier to extract from", ops)
		return pendingForVerification(ops, dryRun)
	}
	door.adoptable = []map[string]interface{}{adoptedItem(1), adoptedItem(2)}
	vllm := newFakeVLLM(t, adoptionAnswers)
	spawns := fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	r := summary.Report
	if summary.Outcome != "succeeded" || r.Dossiers != 0 || r.Ops.Recorded != 0 || summary.Model != "qwen3.8-27b-fp8" {
		t.Errorf("summary = %+v", summary)
	}
	if r.Verification == nil || r.Verification.Adopted == nil || *r.Verification.Adopted != (wikiMaintainAdopted{Ops: 2, Verified: 2}) {
		t.Errorf("verification = %+v, want both adopted ops verified", r.Verification)
	}
	if n := len(spawns()); n != 2 {
		t.Errorf("%d model calls, want one per adopted op", n)
	}
	for _, call := range door.calls() {
		if call.path == "/api/runner/wiki/spaces/space-1/verifications" {
			t.Errorf("a run that recorded nothing asked for its own ops: %s %s", call.method, call.path)
		}
	}
}

// A server older than the adoption routes answers them 404 with no code: the run adopts nothing, and its own
// work stands. A Tiered space's run never asks at all: nothing waits for a verification there.
func TestWikiMaintainAdoptsNothingWhereThereIsNothingToAdoptFrom(t *testing.T) {
	for _, c := range []struct {
		name, mode string
		missing    bool
		asked      int
	}{
		{"a server that predates adoption", "automatic", true, 1},
		{"a tiered space", "tiered", false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newMaintainFixture(t)
			door := newFakeMaintainDoor(t)
			door.context = maintainContext(f, c.mode, 0, "tok-expect")
			door.adoptable = []map[string]interface{}{adoptedItem(1)}
			door.adoptMissing = c.missing
			vllm := newFakeVLLM(t, adoptionAnswers)
			spawns := fakeVerifyClaude(t)
			wikiMaintainSession(t, door.URL, vllm)

			summary, err := runMaintainCLI(t)
			if err != nil || summary.Outcome != "succeeded" || !summary.Advanced {
				t.Fatalf("orbit wiki maintain = %v, %+v: want its own work to stand", err, summary)
			}
			if summary.Report.Verification != nil || len(spawns()) != 0 || len(adoptedVerdicts(t, door)) != 0 {
				t.Errorf("verification %+v, %d model calls: want nothing adopted", summary.Report.Verification, len(spawns()))
			}
			if got := len(door.of(http.MethodGet, "maintenance/verifications")); got != c.asked {
				t.Errorf("the adoption list was asked %d times, want %d", got, c.asked)
			}
		})
	}
}

// ── An op the verification gets no verdict for ──────────────────────────────────────────────────

// ownItem is one of the run's own ops as the proposer's verification list hands it: a pitfall citing the
// tool call behind the port dossier's L2, with the neighbours given.
func ownItem(opID, title string, similar ...map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"opId": opID, "op": "add", "entryId": "e-" + opID,
		"entry": map[string]interface{}{"kind": "pitfall", "title": title, "summary": "s", "fields": map[string]interface{}{}},
		"sources": []interface{}{map[string]interface{}{"kind": "tool_call", "ref": "call-2", "quote": nil,
			"text": "connect ECONNREFUSED 127.0.0.1:9000", "truncated": false}},
		"similar": append([]map[string]interface{}{}, similar...),
	}
}

// The runs of 2026-09-30 and 10-01: the local model judged an op a duplicate of an entry its prompt did not
// list, and judged it so again when asked once more — and the whole run failed, its cursor unmoved, for one op
// in eighty-nine. Now the second asking says why the first answer was not taken and which numbers a duplicate
// may name; an op still without a verdict after it is not live and fails nothing: the run succeeds, the cursor
// advances, and the next run adopts the op — and reports its verdict once the entry it repeats is offered.
func TestWikiMaintainLeavesAnOpWithoutAVerdictToTheNextRun(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
	door.propose = pendingForVerification
	live := map[string]interface{}{"id": "entry-fixture", "kind": "convention", "title": "Fixtures hand out their ports", "status": "active", "trust": "auto"}
	proposed := map[string]interface{}{"id": "entry-port", "kind": "pitfall", "title": "PORT is read at import", "status": "proposed", "trust": "proposed"}
	door.own = []map[string]interface{}{ownItem("op-0", "fixture 不写死端口"), ownItem("op-1", "PORT 在导入时读取", live, proposed)}
	// The model takes op-1 for a duplicate of entry-port — E2, once it is live and listed after entry-fixture — which
	// is not live and so not listed: once, and again.
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		switch {
		case strings.Contains(prompt, "==== CASE FILE ===="):
			return extractorAnswers(prompt)
		case strings.Contains(prompt, "Title: PORT 在导入时读取\n"):
			return http.StatusOK, `{"verdict":"duplicate","reason":"the space already says this","duplicateOf":"E2"}`
		}
		return http.StatusOK, `{"verdict":"supported","reason":"the cited record says exactly this"}`
	})
	spawns := fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("an op without a verdict failed the run: %v\n%+v", err, summary)
	}
	// The run succeeded, and the cursor moved to the position its task expects.
	if summary.Outcome != "succeeded" || !summary.Advanced || summary.Cursor != "tok-expect" || summary.Error != "" {
		t.Errorf("summary = %+v, want a run that succeeded and advanced the cursor", summary)
	}
	end := finished(t, door)
	report, _ := end["report"].(map[string]interface{})
	if end["outcome"] != "succeeded" || end["to"] != "tok-expect" || end["error"] != nil || report["stoppedAt"] != nil {
		t.Errorf("the run ended %v", end)
	}
	// The report counts the op apart, as waiting for the next run.
	v := summary.Report.Verification
	if v == nil || v.Verified != 1 || v.Failed != 1 || v.WaitingForNextRun != 1 || v.Adopted != nil {
		t.Errorf("verification = %+v, want one verified and one waiting for the next run", v)
	}
	if verification, _ := report["verification"].(map[string]interface{}); verification["waitingForNextRun"] != float64(1) {
		t.Errorf("the report the server kept = %v", report)
	}
	if !strings.Contains(describeWikiMaintainSummary(summary), "\n- waiting for the next run: 1 op without a verdict, not live; the next run adopts it") {
		t.Errorf("the summary does not count it apart:\n%s", describeWikiMaintainSummary(summary))
	}
	// Nothing was reported for op-1, so nothing of it is live; and the run went on past the verification.
	for _, call := range door.of(http.MethodPost, "space-1/verifications") {
		for _, verdict := range call.body["verdicts"].([]interface{}) {
			if verdict.(map[string]interface{})["opId"] == "op-1" {
				t.Errorf("a verdict was reported for the op the model gave none for: %v", verdict)
			}
		}
	}
	if len(door.of(http.MethodGet, "anchors")) != 1 || len(door.of(http.MethodGet, "maintenance/docs")) != 1 {
		t.Error("the run stopped at the op without a verdict")
	}
	// The second pass asked about op-1 alone, saying why its answer was not taken and which numbers a duplicate
	// may name; op-0, verified the first time, was not asked again.
	var asked []string
	for _, spawn := range spawns() {
		switch {
		case strings.Contains(spawn.Prompt, "Title: PORT 在导入时读取\n"):
			asked = append(asked, spawn.Prompt)
		case strings.Contains(spawn.Prompt, "Title: fixture 不写死端口\n") && strings.Contains(spawn.Prompt, "not taken"):
			t.Errorf("an op that had its verdict was asked again:\n%s", spawn.Prompt)
		}
	}
	if len(asked) != 2 {
		t.Fatalf("op-1 was asked %d times, want twice", len(asked))
	}
	if strings.Contains(asked[0], "Your last answer was not taken") {
		t.Errorf("the first asking already says an answer was not taken:\n%s", asked[0])
	}
	for _, part := range []string{
		"## Your last answer was not taken",
		`your answer was not a verdict: a duplicate must name one of the listed entries by its number (E1), and "E2" is not one.`,
		"duplicateOf must be one of these numbers of the entries listed above: E1.",
	} {
		if !strings.Contains(asked[1], part) {
			t.Errorf("the second asking does not say %q:\n%s", part, asked[1])
		}
	}

	// The next run: the session that proposed op-1 has ended, so op-1 is among what ended sessions left waiting —
	// and entry-port has gone live since, so it is offered, and the model's duplicate is a verdict.
	door.pages[""] = maintainPage("tok-expect", false)
	door.adoptable = []map[string]interface{}{ownItem("op-1", "PORT 在导入时读取", live,
		map[string]interface{}{"id": "entry-port", "kind": "pitfall", "title": "PORT is read at import", "status": "active", "trust": "auto"})}
	door.adoptOutcome = func(verdict map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"opId": verdict["opId"], "status": "reinforced", "reinforced": true, "verdict": verdict["verdict"]}
	}
	var out strings.Builder
	if err := cmdWikiCLI([]string{"maintain", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("the next run: %v\n%s", err, out.String())
	}
	adopted := adoptedVerdicts(t, door)
	if len(adopted) != 1 || adopted[0]["opId"] != "op-1" || adopted[0]["verdict"] != "duplicate" || adopted[0]["duplicateOf"] != "entry-port" {
		t.Errorf("the next run reported %v, want op-1 a duplicate of entry-port", adopted)
	}
	for _, line := range []string{"op op-1 (PORT 在导入时读取): duplicate — a duplicate of entry-port: its sources were added there",
		"- adopted: 1 ops ended sessions left waiting for their verification, 1 verified, 0 without a verdict"} {
		if !strings.Contains(out.String(), line) {
			t.Errorf("the next run did not say %q:\n%s", line, out.String())
		}
	}
	if strings.Contains(out.String(), "waiting for the next run") {
		t.Errorf("the next run left something waiting:\n%s", out.String())
	}
	if ends := door.of(http.MethodPost, "maintenance/finish"); len(ends) != 2 || ends[1].body["outcome"] != "succeeded" {
		t.Errorf("the runs ended %v", ends)
	}
}

// What stops the verification still fails the run: the model's endpoint refusing the token stops it at the first
// op — every op after would be refused the same way — and the run ends failed at verify, its cursor unmoved.
func TestWikiMaintainStillFailsWhenTheVerificationIsRefusedTheToken(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 0, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, portDossier("session-a"))
	door.propose = pendingForVerification
	door.own = []map[string]interface{}{ownItem("op-0", "fixture 不写死端口"), ownItem("op-1", "PORT 在导入时读取")}
	door.adoptable = []map[string]interface{}{adoptedItem(1)}
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		if strings.Contains(prompt, "==== CASE FILE ====") {
			return extractorAnswers(prompt)
		}
		return http.StatusUnauthorized, ""
	})
	spawns := fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	summary, err := runMaintainCLI(t)
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "the cursor did not move") {
		t.Fatalf("a refused token in the verification = %v, want the run failed", err)
	}
	if summary.Outcome != "failed" || summary.Advanced {
		t.Errorf("summary = %+v", summary)
	}
	end := finished(t, door)
	report, _ := end["report"].(map[string]interface{})
	if end["outcome"] != "failed" || end["to"] != nil || report["stoppedAt"] != "verify" || !strings.Contains(fmt.Sprint(end["error"]), "401") {
		t.Errorf("the run ended %v", end)
	}
	asked := 0
	for _, spawn := range spawns() {
		if !strings.Contains(spawn.Prompt, "==== CASE FILE ====") {
			asked++
		}
	}
	if asked != 1 {
		t.Errorf("the model was asked for %d verdicts, want none after the first 401", asked)
	}
	if len(door.of(http.MethodGet, "space-1/verifications")) != 1 || len(door.of(http.MethodGet, "maintenance/verifications")) != 0 ||
		len(door.of(http.MethodGet, "anchors")) != 0 {
		t.Error("the run went on past the 401: a second pass, the adoption or the anchors")
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
	if len(door.of(http.MethodGet, "anchors")) != 0 || len(door.of(http.MethodGet, "maintenance/docs")) != 0 {
		t.Error("the run went on past the step that failed")
	}
}

// ── The breaker ─────────────────────────────────────────────────────────────────────────────────

// fakeRunBreaker answers proposals as the server's circuit breaker over a run does (wiki-maintenance-breaker.ts):
// the run began with `began` active entries and may change ten percent of them, `spent` of which its earlier
// changesets — an earlier attempt in the same session — already changed. A dry run answers with that reading
// and refuses, op by op, what is past it; a proposal records what fits, spends it, and refuses the rest.
type fakeRunBreaker struct {
	mu                      sync.Mutex
	began                   int
	spent                   int
	recorded                []string
	refusedDry, refusedLive int
}

func (b *fakeRunBreaker) propose(ops []interface{}, dryRun bool) (int, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	allowed := b.began * 10 / 100
	changed := b.spent
	outcomes := []interface{}{}
	for i, raw := range ops {
		if changed+1 > allowed {
			outcomes = append(outcomes, map[string]interface{}{"seq": i, "status": "refused", "reasons": []interface{}{map[string]interface{}{
				"code": "WIKI_QUOTA",
				"message": fmt.Sprintf("circuit breaker: this Wiki maintenance run has already changed %d of the %d entries the space held "+
					"active when it began, and one run may change at most 10%% of them — what is past that is the next run's", changed, b.began),
			}}})
			if dryRun {
				b.refusedDry++
			} else {
				b.refusedLive++
			}
			continue
		}
		changed++
		outcome := map[string]interface{}{"seq": i, "status": "pending", "waitsFor": "verification", "entryId": fmt.Sprintf("e-%d", changed)}
		if !dryRun {
			outcome["opId"] = fmt.Sprintf("op-%d", changed)
			entry, _ := raw.(map[string]interface{})["entry"].(map[string]interface{})
			b.recorded = append(b.recorded, fmt.Sprint(entry["title"]))
		}
		outcomes = append(outcomes, outcome)
	}
	body := map[string]interface{}{"changesetId": "cs-1", "ops": outcomes}
	if dryRun {
		body["changesetId"], body["dryRun"] = nil, true
		body["breaker"] = map[string]interface{}{"scope": "run", "activeAtStart": b.began, "changed": b.spent, "remaining": max(0, allowed-b.spent)}
	} else {
		b.spent = changed
	}
	raw, _ := json.Marshal(body)
	return http.StatusOK, string(raw)
}

// ruleDossier is a session whose case the model answers with three conventions of its own (ruleAnswers).
func ruleDossier(session string) map[string]interface{} {
	return maintainDossier(session, "规则 "+session, []string{"owner: 以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。"},
		[]string{"turn:turn-" + session}, nil, false)
}

// ruleAnswers answers a rule dossier's case with three conventions named after its session: session-b's and
// session-d's about the runner, the others' about testing, so a run's ops go into more than one batch.
func ruleAnswers(prompt string) (int, string) {
	_, rest, found := strings.Cut(prompt, "SESSION: 规则 ")
	if !found {
		return http.StatusOK, `{"verdict":"supported","reason":"the cited turn says exactly this"}`
	}
	session, _, _ := strings.Cut(rest, "\n")
	topic := map[bool]string{true: "runner", false: "testing"}[session == "session-b" || session == "session-d"]
	var entries []string
	for i := 1; i <= 3; i++ {
		entries = append(entries, fmt.Sprintf(`{"kind":"convention","title":"%s 的规则 %d","summary":"照做。","topic":%q,`+
			`"rule":"照做","scope":["全部"],"exceptions":"","anchors":{"paths":[],"commits":[]},`+
			`"sources":[{"ref":"L1","quote":"以后 fixture 里不要写死端口"}],"verified":false}`, session, i, topic))
	}
	return http.StatusOK, "[" + strings.Join(entries, ",") + "]"
}

// The run of 2026-09-28 14:32 (wiki_maintenance_run 01a0e868): a retry in the session of an attempt that had
// applied fourteen entries. Its context counted 229 active entries, the fourteen among them, and its own count
// let fifteen more through; the server counts the run by its session — from the 215 it began with, fourteen
// spent — and refused eight at the proposal, failing the run. Held to what the dry runs say instead, the run
// proposes the page that fits, holds back the page that does not, has nothing refused, and succeeds; its cursor
// stops where the page it held back starts.
func TestWikiMaintainHoldsItsBatchesToTheBreakerTheServerCounts(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 229, "tok-expect")
	door.pages[""] = maintainPage("tok-1", true, ruleDossier("session-a"), ruleDossier("session-b"))
	door.pages["tok-1"] = maintainPage("tok-expect", false, ruleDossier("session-c"))
	breaker := &fakeRunBreaker{began: 215, spent: 14}
	door.propose = breaker.propose
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, ruleAnswers))

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	// Each batch alone fits in what the run has left, as each of that run's did: a dry run passing one changeset
	// says nothing of the run.
	if breaker.refusedDry != 0 {
		t.Errorf("a dry run refused %d ops: the batches are meant to fit one at a time", breaker.refusedDry)
	}
	// Seven more the run may change: the first page's six fit, and the second page's three do not.
	ops := summary.Report.Ops
	if ops.Proposed != 6 || ops.Recorded != 6 || ops.Refused != 0 || ops.HeldBackByBreaker != 3 || ops.SelfCheckDropped != 0 {
		t.Errorf("ops = %+v, want six proposed and recorded, none refused, three held back by the breaker", ops)
	}
	// The self-check and the proposal agree: the server refused nothing the run proposed.
	if breaker.refusedLive != 0 || breaker.spent != 20 || len(breaker.recorded) != 6 {
		t.Errorf("the server refused %d of the run's ops and recorded %v: the self-check and the proposal disagree", breaker.refusedLive, breaker.recorded)
	}
	for _, title := range breaker.recorded {
		if strings.HasPrefix(title, "session-c") {
			t.Errorf("the run proposed %q, from the page it held back", title)
		}
	}
	end := finished(t, door)
	report, _ := end["report"].(map[string]interface{})
	held, _ := report["ops"].(map[string]interface{})
	if end["outcome"] != "succeeded" || end["to"] != "tok-1" || held["heldBackByBreaker"] != float64(3) || report["stoppedAt"] != nil {
		t.Errorf("the run ended %v, want succeeded at the start of the page it held back", end)
	}
	if summary.Outcome != "succeeded" {
		t.Errorf("summary = %+v", summary)
	}
	if text := describeWikiMaintainSummary(summary); !strings.Contains(text, "3 held back by the breaker") ||
		!strings.Contains(text, "the next run reads those dossiers again") {
		t.Errorf("the summary does not say what the breaker held back:\n%s", text)
	}
}

// A session on more than one page goes with the last of them, and from the first page that does not fit no
// page is proposed — not even one that would: the cursor cannot pass a page the run did not keep, so every
// page after it is read again, and what was proposed from one would be proposed twice.
func TestWikiMaintainHoldsBackEveryPageFromTheFirstThatDoesNotFit(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 150, "tok-expect")
	door.pages[""] = maintainPage("tok-1", true, ruleDossier("session-a"), ruleDossier("session-b"))
	door.pages["tok-1"] = maintainPage("tok-2", true, ruleDossier("session-b"), ruleDossier("session-c"))
	door.pages["tok-2"] = maintainPage("tok-expect", false, ruleDossier("session-d"))
	breaker := &fakeRunBreaker{began: 150, spent: 8}
	door.propose = breaker.propose
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, ruleAnswers))

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	// Seven more: session-a's three fit; the second page, where session-b is too, would take six more; the
	// third page's three would fit after the first, and are held back with the second.
	ops := summary.Report.Ops
	if ops.Proposed != 3 || ops.Refused != 0 || ops.HeldBackByBreaker != 9 {
		t.Errorf("ops = %+v, want session-a's three proposed and nine held back", ops)
	}
	for _, title := range breaker.recorded {
		if !strings.HasPrefix(title, "session-a ") {
			t.Errorf("the run proposed %q, which the page it held back or a later one hands out again", title)
		}
	}
	if end := finished(t, door); end["outcome"] != "succeeded" || end["to"] != "tok-1" {
		t.Errorf("the run ended %v, want succeeded at the start of the second page", end)
	}
}

// A retry after an attempt that spent everything the run may change: nothing fits, nothing is proposed, and the
// run succeeds where the cursor stands — the first page's start — so the next run, with a breaker of its own,
// reads every dossier again.
func TestWikiMaintainHeldBackFromItsFirstPageSucceedsWhereTheCursorStands(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "automatic", 236, "tok-expect")
	door.pages[""] = maintainPage("tok-expect", false, ruleDossier("session-a"))
	breaker := &fakeRunBreaker{began: 215, spent: 21}
	door.propose = breaker.propose
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, ruleAnswers))

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	if ops := summary.Report.Ops; ops.Proposed != 0 || ops.Refused != 0 || ops.HeldBackByBreaker != 3 {
		t.Errorf("ops = %+v, want nothing proposed and three held back", ops)
	}
	for _, proposal := range door.of(http.MethodPost, "maintenance/changesets") {
		if proposal.body["dryRun"] != true {
			t.Errorf("the run proposed %v with nothing left to change", proposal.body["ops"])
		}
	}
	if end := finished(t, door); end["outcome"] != "succeeded" || end["to"] != "tok-watermark" {
		t.Errorf("the run ended %v, want succeeded where the cursor stands", end)
	}
}

// A server whose dry runs say nothing of the breaker: the run holds its batches to the share of the active
// entries its context counted, as it did before they said it — held back, not failed.
func TestWikiMaintainHoldsBackByTheContextWhenTheDryRunsSayNothing(t *testing.T) {
	f := newMaintainFixture(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f, "tiered", 100, "tok-expect")
	door.pages[""] = maintainPage("tok-1", true, ruleDossier("session-a"), ruleDossier("session-b"))
	door.pages["tok-1"] = maintainPage("tok-expect", false, ruleDossier("session-c"), ruleDossier("session-d"))
	door.propose = func(ops []interface{}, dryRun bool) (int, string) {
		outcomes := []interface{}{}
		for i := range ops {
			outcomes = append(outcomes, map[string]interface{}{"seq": i, "status": "applied", "entryId": fmt.Sprintf("e-%d", i), "opId": fmt.Sprintf("op-%d", i)})
		}
		raw, _ := json.Marshal(map[string]interface{}{"changesetId": map[bool]interface{}{true: nil, false: "cs-1"}[dryRun], "dryRun": dryRun, "ops": outcomes})
		return http.StatusOK, string(raw)
	}
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, newFakeVLLM(t, ruleAnswers))

	summary, err := runMaintainCLI(t)
	if err != nil {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	// Ten of the hundred: the first page's six fit, the second page's six more do not.
	if ops := summary.Report.Ops; ops.Proposed != 6 || ops.Applied != 6 || ops.HeldBackByBreaker != 6 {
		t.Errorf("ops = %+v, want six proposed and six held back", ops)
	}
	if end := finished(t, door); end["outcome"] != "succeeded" || end["to"] != "tok-1" {
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
	if _, placed := source["locator"]; placed {
		t.Errorf("the proposal cites %v: the place of a quote it no longer carries", source)
	}
}

// A quote is the record's own words at the place the line's spans name. Found as a quote is compared —
// markdown marks, curly quotes and spacing aside — it is proposed as the record has it, with where it is; the
// dossier's own writing for the record, words across a gap the dossier cut, and words the redactor took out
// cite the record with neither. A quote not copied from its line at all is still a problem to ask about again.
func TestWikiMaintainQuotesTheRecordsOwnWordsWhereTheLineSaysTheyAre(t *testing.T) {
	long := strings.Repeat("端口从 fixture 的返回值里取，", 30)
	thought := []wikiDossierSpan{maintainSpan(0, "It turns out the port is read at import."), maintainSpan(58, "Actually the “fixture” sets it too late.")}
	dossier := wikiDossier{
		Text: "SESSION: 修端口\nclaude · started 2026-09-28 · status SUCCEEDED\n\n" +
			"L1 tool: $ go test ./... → ERR: exit status 1 … --- FAIL: TestPort (0.00s)\n" +
			"L2 agent: 根因：`src/app.go` 在导入时读取 **PORT**，fixture 之后才设置。\n" +
			"L3 think: It turns out the port is read at import. … Actually the “fixture” sets it too late.\n" +
			"L4 owner: 以后 fixture 里不要写死端口 token: [redacted] 🎯 always\n" +
			"L5 owner: " + long + "…[cut]\n",
		Sources: []wikiDossierSource{
			{Ref: "L1", Kind: "tool_call", ID: "call-1", Spans: []wikiDossierSpan{
				maintainSpan(14, "go test ./..."), maintainSpan(28, "exit status 1"), maintainSpan(1800, "--- FAIL: TestPort (0.00s)")}},
			{Ref: "L2", Kind: "event", ID: "event-2", Spans: []wikiDossierSpan{maintainSpan(0, "根因：`src/app.go` 在导入时读取 **PORT**，fixture 之后才设置。")}},
			{Ref: "L3", Kind: "event", ID: "event-3", Spans: thought},
			{Ref: "L4", Kind: "turn", ID: "turn-4", Spans: []wikiDossierSpan{maintainSpan(7, "以后 fixture 里不要写死端口 token: [redacted] 🎯 always")}},
			{Ref: "L5", Kind: "turn", ID: "turn-5", Spans: []wikiDossierSpan{maintainSpan(0, long)}},
		},
	}
	lines := wikiMaintainLines(dossier)
	cite := func(ref, quote string) (map[string]interface{}, []string) {
		t.Helper()
		sources, problems := wikiMaintainSources([]interface{}{map[string]interface{}{"ref": ref, "quote": quote}}, lines)
		if len(sources) == 0 {
			return nil, problems
		}
		return sources[0].(map[string]interface{}), problems
	}
	at := func(start, end int) map[string]interface{} { return map[string]interface{}{"start": start, "end": end} }
	for _, c := range []struct {
		why, ref, quote string
		want            map[string]interface{}
	}{
		{"a piece of the output, as the record has it", "L1", "exit status 1",
			map[string]interface{}{"kind": "tool_call", "ref": "call-1", "quote": "exit status 1", "locator": at(28, 41)}},
		{"the result's last line, far into the output", "L1", "FAIL: TestPort",
			map[string]interface{}{"kind": "tool_call", "ref": "call-1", "quote": "FAIL: TestPort", "locator": at(1804, 1818)}},
		{"the dossier's writing for the call: cited with no quote", "L1", "go test ./... → ERR: exit status 1",
			map[string]interface{}{"kind": "tool_call", "ref": "call-1"}},
		{"markdown the model left out: the record's words, marks and all", "L2", "根因：src/app.go 在导入时读取 PORT",
			map[string]interface{}{"kind": "event", "ref": "event-2", "quote": "根因：`src/app.go` 在导入时读取 **PORT", "locator": at(0, 29)}},
		{"a curly quote the model straightened, in the second sentence of a thought", "L3", `Actually the "fixture" sets it`,
			map[string]interface{}{"kind": "event", "ref": "event-3", "quote": "Actually the “fixture” sets it", "locator": at(58, 88)}},
		{"words across the gap the dossier cut between two sentences: no quote", "L3", "at import. … Actually",
			map[string]interface{}{"kind": "event", "ref": "event-3"}},
		{"words the redactor took out: no quote", "L4", "端口 token: [redacted]",
			map[string]interface{}{"kind": "turn", "ref": "turn-4"}},
		{"a character past the plane is one code point", "L4", "🎯 always",
			map[string]interface{}{"kind": "turn", "ref": "turn-4", "quote": "🎯 always", "locator": at(44, 52)}},
		{"a long quote, cut to the limit at the record's words", "L5", long,
			map[string]interface{}{"kind": "turn", "ref": "turn-5", "quote": string([]rune(long)[:wikiMaintainQuoteMaxChars]),
				"locator": at(0, wikiMaintainQuoteMaxChars)}},
	} {
		got, problems := cite(c.ref, c.quote)
		if len(problems) != 0 || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: cites %v (problems %v)\nwant %v", c.why, got, problems, c.want)
		}
	}
	// A quote the line does not say is the model's own, and asked about again, as before.
	if got, problems := cite("L1", "connection refused"); got != nil || len(problems) != 1 || !strings.Contains(problems[0], "not copied exactly") {
		t.Errorf("a quote that is not in its line: %v, problems %v", got, problems)
	}
	// A dossier from a server whose lines say nothing of where their words are: the line's words, as before.
	bare := wikiDossier{Text: "L1 owner: 以后 fixture 里不要写死端口\n", Sources: []wikiDossierSource{{Ref: "L1", Kind: "turn", ID: "turn-1"}}}
	sources, problems := wikiMaintainSources([]interface{}{map[string]interface{}{"ref": "L1", "quote": "不要写死端口"}}, wikiMaintainLines(bare))
	if len(problems) != 0 || !reflect.DeepEqual(sources, []interface{}{map[string]interface{}{"kind": "turn", "ref": "turn-1", "quote": "不要写死端口"}}) {
		t.Errorf("a line with no spans: %v, problems %v", sources, problems)
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
	// Five hours: the same clean start runs a plan job's draft (wiki_plan_draft.go), whose four steps and
	// three gate rounds take longer on a shared GPU than a maintenance run's three hours.
	if budget != "18000000" {
		t.Errorf("the run's budget is %s ms, want five hours", budget)
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
		"extractConcurrency": wikiMaintainExtractConcurrency, "adoptOpsMax": wikiMaintainAdoptOpsMax,
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
		"adoptions": "GET /api/runner/wiki/spaces/:id/" + wikiAdoptedVerifications.route,
		"adopt":     "POST /api/runner/wiki/spaces/:id/" + wikiAdoptedVerifications.route,
		"finish":    "POST /api/runner/wiki/spaces/:id/maintenance/finish", "check": "GET /api/runner/wiki/spaces/:id/maintenance/check",
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
