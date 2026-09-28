package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// `orbit wiki articles` against a fake vLLM endpoint and a fake runner door (contract `articles`).
//
// The three stand-ins of wiki_verify_test.go, reused: the fake model endpoint, and the fake Claude
// Code — this test binary behind a shim — that reads the prompt on stdin, runs the apiKeyHelper, calls
// the endpoint with the Bearer token it printed and answers in --output-format json. The door is this
// file's own: the plan, each topic's input, and the write, each recorded.

// fakeArticlesDoor is the runner door's three article routes for space-1.
type fakeArticlesDoor struct {
	URL      string
	mu       sync.Mutex
	plan     map[string]interface{}
	planCode int
	planBody string
	inputs   map[string]map[string]interface{}
	answer   func(slug string, body wikiArticleWrite) (int, string)
	calls    []string
	sessions []string
	writes   map[string]wikiArticleWrite
}

func newFakeArticlesDoor(t *testing.T, topics []map[string]interface{}, inputs map[string]map[string]interface{}) *fakeArticlesDoor {
	t.Helper()
	door := &fakeArticlesDoor{
		plan:   map[string]interface{}{"spaceId": "space-1", "seeded": 0, "entries": 0, "unassigned": 0, "topics": topics},
		inputs: inputs,
		writes: map[string]wikiArticleWrite{},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		door.mu.Lock()
		defer door.mu.Unlock()
		door.calls = append(door.calls, r.Method+" "+r.URL.Path)
		door.sessions = append(door.sessions, r.Header.Get("X-Orbit-Session-Id"))
		w.Header().Set("content-type", "application/json")
		const prefix = "/api/runner/wiki/spaces/space-1/"
		path := strings.TrimPrefix(r.URL.Path, prefix)
		switch {
		case r.Method == http.MethodPost && path == "article-plan":
			if door.planCode != 0 {
				w.WriteHeader(door.planCode)
				_, _ = w.Write([]byte(door.planBody))
				return
			}
			out, _ := json.Marshal(door.plan)
			_, _ = w.Write(out)
		case r.Method == http.MethodGet && strings.HasPrefix(path, "articles/") && strings.HasSuffix(path, "/input"):
			slug := strings.TrimSuffix(strings.TrimPrefix(path, "articles/"), "/input")
			input, ok := door.inputs[slug]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"no such wiki topic"}`))
				return
			}
			out, _ := json.Marshal(input)
			_, _ = w.Write(out)
		case r.Method == http.MethodPost && strings.HasPrefix(path, "articles/"):
			slug := strings.TrimPrefix(path, "articles/")
			var body wikiArticleWrite
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("a write that is not JSON: %s", raw)
			}
			door.writes[slug] = body
			status, answer := http.StatusOK, ""
			if door.answer != nil {
				status, answer = door.answer(slug, body)
			}
			if answer == "" {
				answer = writtenAnswer(slug, body)
			}
			w.WriteHeader(status)
			_, _ = w.Write([]byte(answer))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot ` + r.Method + ` ` + r.URL.Path + `"}`))
		}
	}))
	t.Cleanup(srv.Close)
	door.URL = srv.URL
	return door
}

// writtenAnswer is the server's answer to a write it kept whole.
func writtenAnswer(slug string, body wikiArticleWrite) string {
	parts := []map[string]interface{}{}
	for _, part := range body.Articles {
		parts = append(parts, map[string]interface{}{"part": part.Part, "kind": part.Kind, "title": part.Title, "kept": true,
			"stats": map[string]int{"sentences": 10, "sentencesDeleted": 1, "markers": 12, "markersStripped": 1, "sentencesTrimmed": 0, "chars": 600, "footnotes": 5}})
	}
	out, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "slug": slug, "written": true, "unchanged": false, "reason": nil, "parts": parts,
		"stats": map[string]int{"sentences": 10 * len(parts), "sentencesDeleted": len(parts), "markers": 12 * len(parts), "markersStripped": len(parts), "chars": 600 * len(parts), "footnotes": 5 * len(parts)}})
	return string(out)
}

func (d *fakeArticlesDoor) Calls() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.calls...)
}

func (d *fakeArticlesDoor) Write(slug string) (wikiArticleWrite, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	body, ok := d.writes[slug]
	return body, ok
}

// planTopic is one topic of the plan.
func planTopic(slug string, entries int, changed bool) map[string]interface{} {
	return map[string]interface{}{"slug": slug, "title": "Topic " + slug, "category": "data", "entryCount": entries,
		"entrySetSha256": strings.Repeat("a", 63) + "1", "articleSha256": nil, "generatedAt": nil, "changed": changed}
}

// topicInput is one topic's input: entries in the server's ranked order (sources, most first).
func topicInput(slug string, entries []map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"spaceId":        "space-1",
		"topic":          map[string]interface{}{"slug": slug, "title": "主题 " + slug, "category": "data", "description": "About " + slug},
		"entrySetSha256": "sha-of-" + slug,
		"articleSha256":  nil,
		"entries":        entries,
	}
}

// articleEntry is one entry of an input, anchored at path.
func articleEntry(id, title, summary, path string, sources int) map[string]interface{} {
	return map[string]interface{}{
		"id": id, "revision": 1, "kind": "pitfall", "title": title, "summary": summary,
		"fields":  map[string]interface{}{"symptom": "It broke.", "cause": "An order.", "fix": "Another order."},
		"paths":   []string{path},
		"sources": sources, "trust": "owner", "recordedAt": "2026-09-27T00:00:00.000Z",
	}
}

// smallTopic is n entries under one directory.
func smallTopic(slug string, n int) []map[string]interface{} {
	out := []map[string]interface{}{}
	for i := 0; i < n; i++ {
		out = append(out, articleEntry(fmt.Sprintf("e-%s-%d", slug, i), fmt.Sprintf("%s 的第 %d 条经验", slug, i),
			fmt.Sprintf("关于 %s 的第 %d 条经验说明。", slug, i), fmt.Sprintf("src/%s/file%d.ts", slug, i), n-i))
	}
	return out
}

// twoClusterTopic is 60 entries in two clusters that share no path and no word: migrations, and the web.
func twoClusterTopic(slug string) []map[string]interface{} {
	out := []map[string]interface{}{}
	for i := 0; i < 30; i++ {
		out = append(out, articleEntry(fmt.Sprintf("mig-%d", i), fmt.Sprintf("migration numbering rule %d", i),
			fmt.Sprintf("prisma migration ledger collision %d", i), fmt.Sprintf("src/apiserver/prisma/migrations/03%02d_x/migration.sql", i), 90-i))
		out = append(out, articleEntry(fmt.Sprintf("web-%d", i), fmt.Sprintf("vitest harness quirk %d", i),
			fmt.Sprintf("react component render stub %d", i), fmt.Sprintf("src/web/src/components/Widget%d.tsx", i), 60-i))
	}
	return out
}

// longArticle is a draft of about 600 characters, every sentence footnoted within 1..notes.
func longArticle(title string, notes int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", title)
	for i := 0; i < 16; i++ {
		if i == 5 || i == 11 {
			fmt.Fprintf(&b, "\n## 第 %d 节\n\n", i)
		}
		fmt.Fprintf(&b, "这是第 %d 句，它说明这个主题的一条规则和它背后的原因[%d]。", i+1, i%notes+1)
	}
	return b.String()
}

// articleAnswers answers as a model would: a group's name, an overview, or an article.
func articleAnswers(prompt string) (int, string) {
	switch {
	case strings.Contains(prompt, "起一个简短的中文小标题"):
		return http.StatusOK, "「迁移与界面」"
	case strings.Contains(prompt, "Write the overview"):
		return http.StatusOK, longArticle("总览", 2)
	}
	return http.StatusOK, longArticle("文章", 3)
}

// wikiArticlesSession points the CLI at the door and the model endpoint as a maintenance session on the
// local model's provider has them — and plants what must NOT reach the clean call, thinking included.
func wikiArticlesSession(t *testing.T, doorURL string, vllm *fakeVLLM) {
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
	t.Setenv("ANTHROPIC_BASE_URL", vllm.URL)
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "tok-local-vllm")
	t.Setenv("ANTHROPIC_MODEL", "qwen3.8-27b-fp8")
	t.Setenv("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "131072")
	t.Setenv("ANTHROPIC_API_KEY", "sk-must-not-reach-the-writer")
	t.Setenv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/the-session-own-socket.sock")
	t.Setenv("ORBIT_BG_TOKEN", "bg-token-must-not-leak")
	// The provider declared an effort for the session's own work; the writer does not think with it.
	t.Setenv("CLAUDE_CODE_EFFORT_LEVEL", "high")
	t.Setenv("MAX_THINKING_TOKENS", "31999")
}

func spawnEnv(spawn fakeVerifySpawn) map[string]string {
	env := map[string]string{}
	for _, pair := range spawn.Env {
		if key, value, ok := strings.Cut(pair, "="); ok {
			env[key] = value
		}
	}
	return env
}

// ── A run ───────────────────────────────────────────────────────────────────────────────────────

func TestWikiArticleRunWritesTheChangedTopicsThroughACleanClaudeCode(t *testing.T) {
	small := smallTopic("database", 3)
	big := twoClusterTopic("testing")
	door := newFakeArticlesDoor(t,
		[]map[string]interface{}{planTopic("database", 3, true), planTopic("sessions", 7, false), planTopic("testing", 60, true)},
		map[string]map[string]interface{}{"database": topicInput("database", small), "testing": topicInput("testing", big), "sessions": topicInput("sessions", smallTopic("sessions", 7))},
	)
	vllm := newFakeVLLM(t, articleAnswers)
	spawns := fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)
	realHome, _ := os.UserHomeDir()

	var out strings.Builder
	if err := cmdWikiCLI([]string{"articles", "--space", "space-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki articles: %v\n%s", err, out.String())
	}
	var summary wikiArticlesSummary
	if err := json.Unmarshal([]byte(out.String()), &summary); err != nil {
		t.Fatalf("--json printed %q: %v", out.String(), err)
	}
	if summary.Written != 2 || summary.Failed != 0 || summary.Unchanged != 0 || summary.Model != "qwen3.8-27b-fp8" {
		t.Errorf("summary = %+v", summary)
	}
	// One call for the small topic; for the big one, a name and an article per group and the overview.
	if summary.Calls != 1+2+2+1 {
		t.Errorf("model calls = %d, want 6", summary.Calls)
	}

	// The door: the plan, then only the changed topics' inputs and writes, all as the calling session.
	calls := door.Calls()
	want := []string{
		"POST /api/runner/wiki/spaces/space-1/article-plan",
		"GET /api/runner/wiki/spaces/space-1/articles/database/input",
		"POST /api/runner/wiki/spaces/space-1/articles/database",
		"GET /api/runner/wiki/spaces/space-1/articles/testing/input",
		"POST /api/runner/wiki/spaces/space-1/articles/testing",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("door calls = %#v\nwant %#v", calls, want)
	}
	for _, session := range door.sessions {
		if session != "maintenance-session" {
			t.Errorf("a call went as session %q", session)
		}
	}

	// The small topic: one article, its notes the entries it was written from in the input's order.
	written, _ := door.Write("database")
	if written.EntrySetSha256 != "sha-of-database" || written.Model != "qwen3.8-27b-fp8" || len(written.Articles) != 1 {
		t.Fatalf("the database write = %+v", written)
	}
	part := written.Articles[0]
	if part.Part != 0 || part.Kind != "article" || part.Title != "文章" || !strings.Contains(part.Markdown, "[1]") {
		t.Errorf("the database article = %+v", part)
	}
	if !reflect.DeepEqual(part.Notes, []string{"e-database-0", "e-database-1", "e-database-2"}) {
		t.Errorf("notes = %v, want the entries in the input's order", part.Notes)
	}

	// The big topic: an overview and one subtopic per cluster — grouped by paths and words, so neither
	// group mixes the clusters — every entry in exactly one group, and each named by the model.
	split, _ := door.Write("testing")
	if len(split.Articles) != 3 || split.Articles[0].Kind != "overview" || split.Articles[0].Part != 0 || split.Articles[0].Title != "总览" {
		t.Fatalf("the testing write = %d parts, first %+v", len(split.Articles), split.Articles[0])
	}
	seen := map[string]int{}
	for i, sub := range split.Articles[1:] {
		if sub.Part != i+1 || sub.Kind != "subtopic" || sub.Title != "文章" {
			t.Errorf("part %d = %d %s %q", i+1, sub.Part, sub.Kind, sub.Title)
		}
		clusters := map[string]bool{}
		for _, id := range sub.Entries {
			seen[id]++
			clusters[strings.SplitN(id, "-", 2)[0]] = true
		}
		if len(clusters) != 1 || len(sub.Entries) != 30 {
			t.Errorf("part %d mixes clusters %v over %d entries: grouping by paths should keep them apart", sub.Part, clusters, len(sub.Entries))
		}
		for _, note := range sub.Notes {
			if !contains(sub.Entries, note) {
				t.Errorf("part %d cites %s, which is not of its group", sub.Part, note)
			}
		}
	}
	if len(seen) != 60 {
		t.Errorf("%d of 60 entries are in a group", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s is in %d groups", id, n)
		}
	}
	// The overview is written from the best of each group: two apiece.
	if notes := split.Articles[0].Notes; len(notes) != 4 {
		t.Errorf("the overview's notes = %v", notes)
	}
	// The groups are named one after another, each told the names already taken.
	var naming []string
	for _, request := range vllm.Requests() {
		if strings.Contains(request.Prompt, "起一个简短的中文小标题") {
			naming = append(naming, request.Prompt)
		}
	}
	if len(naming) != 2 || strings.Contains(naming[0], "已经叫") || !strings.Contains(naming[1], "同一主题的其他组已经叫：迁移与界面") {
		t.Errorf("the naming prompts do not carry the names already taken: %q", naming)
	}

	// Every model call: the clean launch with the writer's system prompt, thinking off whatever the
	// provider declared, and nothing of the session's besides the endpoint, token and window.
	runs := spawns()
	if len(runs) != 6 {
		t.Fatalf("Claude Code ran %d times, want 6", len(runs))
	}
	for _, run := range runs {
		settings := ""
		for i, arg := range run.Args {
			if arg == "--settings" && i+1 < len(run.Args) {
				settings = run.Args[i+1]
			}
		}
		if want := wikiArticleClaudeArgs("qwen3.8-27b-fp8", settings, wikiArticleSystemPrompt); !reflect.DeepEqual(run.Args, want) {
			t.Fatalf("argv = %#v\nwant %#v", run.Args, want)
		}
		verify := wikiVerifyClaudeArgs("qwen3.8-27b-fp8", settings)
		for i := range verify {
			if i > 0 && verify[i-1] == "--system-prompt" {
				continue
			}
			if verify[i] != run.Args[i] {
				t.Errorf("argv[%d] = %q: the verifier's launch has %q there", i, run.Args[i], verify[i])
			}
		}
		for _, flag := range []string{"-p", "--bare", "--strict-mcp-config", "--no-session-persistence"} {
			if !contains(run.Args, flag) {
				t.Errorf("argv does not pass %s", flag)
			}
		}
		env := spawnEnv(run)
		if env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
			t.Errorf("thinking is not off: CLAUDE_CODE_EFFORT_LEVEL=%q MAX_THINKING_TOKENS=%q", env["CLAUDE_CODE_EFFORT_LEVEL"], env["MAX_THINKING_TOKENS"])
		}
		for key, value := range env {
			switch {
			case key == fakeVerifyClaudeDirEnv:
			case strings.HasPrefix(key, "ORBIT_"):
				t.Errorf("the session's %s=%s reached the clean call", key, value)
			case strings.HasPrefix(key, "CLAUDE_CODE_") && key != "CLAUDE_CODE_MAX_CONTEXT_TOKENS" &&
				key != "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" && key != "CLAUDE_CODE_EFFORT_LEVEL":
				t.Errorf("the session's own Claude Code variable %s=%s reached the clean call", key, value)
			}
		}
		if _, leaked := env["ANTHROPIC_API_KEY"]; leaked {
			t.Error("ANTHROPIC_API_KEY reached the clean call")
		}
		if env["ANTHROPIC_AUTH_TOKEN"] != "tok-local-vllm" || env["ANTHROPIC_BASE_URL"] != vllm.URL {
			t.Errorf("the provider's endpoint and token did not reach it: %v", env)
		}
		if home := env["HOME"]; home == "" || home == realHome || env["CLAUDE_CONFIG_DIR"] == "" || filepath.Dir(home) != run.Cwd {
			t.Errorf("HOME=%q CLAUDE_CONFIG_DIR=%q cwd=%q: want fresh dirs of one scratch dir", home, env["CLAUDE_CONFIG_DIR"], run.Cwd)
		}
		if _, err := os.Stat(run.Cwd); !os.IsNotExist(err) {
			t.Errorf("the scratch dir %s outlived the call", run.Cwd)
		}
		if strings.Contains(run.Prompt, "maintenance-session") {
			t.Error("the prompt carries the session")
		}
	}
	for _, request := range vllm.Requests() {
		if request.Authorization != "Bearer tok-local-vllm" || request.APIKey != "" || request.Tools != 0 || request.Model != "qwen3.8-27b-fp8" {
			t.Errorf("the endpoint was asked with %q / x-api-key %q, %d tools, model %q", request.Authorization, request.APIKey, request.Tools, request.Model)
		}
		if !strings.Contains(request.System, "encyclopedia-style wiki articles") {
			t.Errorf("the writer's system prompt did not reach the model: %s", request.System)
		}
	}
}

func TestWikiArticleWritesNothingForATopicWhoseEntriesDidNotChange(t *testing.T) {
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("sessions", 7, false)},
		map[string]map[string]interface{}{"sessions": topicInput("sessions", smallTopic("sessions", 7))})
	vllm := newFakeVLLM(t, articleAnswers)
	spawns := fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)

	var out strings.Builder
	if err := cmdWikiCLI([]string{"articles", "--space", "space-1", "--topic", "sessions"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki articles --topic sessions: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "nothing is written") {
		t.Errorf("output = %q", out.String())
	}
	if calls := door.Calls(); !reflect.DeepEqual(calls, []string{"POST /api/runner/wiki/spaces/space-1/article-plan"}) {
		t.Errorf("door calls = %v: an unchanged topic is neither read nor written", calls)
	}
	if len(spawns()) != 0 || len(vllm.Requests()) != 0 {
		t.Error("the model was asked about a topic whose entries did not change")
	}
	// A topic the space does not have is named as such.
	err := cmdWikiCLI([]string{"articles", "--space", "space-1", "--topic", "no-such"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), `has no topic "no-such"`) {
		t.Errorf("an unknown topic = %v", err)
	}
}

func TestWikiArticleStopsAtTheFirst401(t *testing.T) {
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("database", 3, true), planTopic("testing", 3, true)},
		map[string]map[string]interface{}{"database": topicInput("database", smallTopic("database", 3)), "testing": topicInput("testing", smallTopic("testing", 3))})
	vllm := newFakeVLLM(t, func(string) (int, string) { return http.StatusUnauthorized, "" })
	fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)

	var out strings.Builder
	err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("a 401 = %v\n%s", err, out.String())
	}
	if n := len(vllm.Requests()); n != 1 {
		t.Errorf("the endpoint was asked %d times: the run stops at the first 401", n)
	}
	for _, call := range door.Calls() {
		if strings.Contains(call, "testing") || (strings.HasPrefix(call, "POST") && strings.Contains(call, "/articles/")) {
			t.Errorf("after the 401 the run went on: %s", call)
		}
	}
}

// flakyModel is an endpoint that fails the first `failures` messages with a 500 an overloaded server
// sends — not a 401 — and answers every later one with a long article.
func flakyModel(t *testing.T, failures int) (url string, asked func() int) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			w.WriteHeader(http.StatusOK)
			return
		}
		mu.Lock()
		n++
		fail := n <= failures
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"api_error","message":"the engine is overloaded"}}`))
			return
		}
		out, _ := json.Marshal(map[string]interface{}{"type": "message", "role": "assistant",
			"content": []map[string]interface{}{{"type": "text", "text": longArticle("重试之后", 3)}}})
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() int {
		mu.Lock()
		defer mu.Unlock()
		return n
	}
}

func TestWikiArticleTriesAFailedCallAgainButNeverA401(t *testing.T) {
	previous := wikiArticleRetryWaits
	wikiArticleRetryWaits = []time.Duration{0, 0, 0}
	t.Cleanup(func() { wikiArticleRetryWaits = previous })
	fakeVerifyClaude(t)

	// One 500, then an answer: the article is written, and both calls are counted.
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("database", 3, true)},
		map[string]map[string]interface{}{"database": topicInput("database", smallTopic("database", 3))})
	url, asked := flakyModel(t, 1)
	wikiArticlesSession(t, door.URL, &fakeVLLM{URL: url})
	var out strings.Builder
	if err := cmdWikiCLI([]string{"articles", "--space", "space-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("a call that failed once: %v\n%s", err, out.String())
	}
	var summary wikiArticlesSummary
	_ = json.Unmarshal([]byte(out.String()), &summary)
	if written, _ := door.Write("database"); len(written.Articles) != 1 || written.Articles[0].Title != "重试之后" || asked() != 2 || summary.Calls != 2 {
		t.Errorf("after one failure: write %+v, endpoint asked %d times, %d calls counted", written.Articles, asked(), summary.Calls)
	}

	// Failing every time: the topic is left unwritten, after the three tries.
	door = newFakeArticlesDoor(t, []map[string]interface{}{planTopic("database", 3, true)},
		map[string]map[string]interface{}{"database": topicInput("database", smallTopic("database", 3))})
	url, asked = flakyModel(t, 100)
	wikiArticlesSession(t, door.URL, &fakeVLLM{URL: url})
	err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "1 topic was left unwritten") || asked() != len(wikiArticleRetryWaits) {
		t.Errorf("failing every time = %v after %d calls", err, asked())
	}
	if _, wrote := door.Write("database"); wrote {
		t.Error("a topic whose article never came back was written")
	}
}

func TestWikiArticleAsksAgainOnceWhenADraftFallsShort(t *testing.T) {
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("database", 10, true)},
		map[string]map[string]interface{}{"database": topicInput("database", smallTopic("database", 10))})
	var mu sync.Mutex
	asked := 0
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		asked++
		if asked == 1 {
			return http.StatusOK, "# 太短\n只有一句[1]。另一句没有脚注。"
		}
		if !strings.Contains(prompt, "A previous draft kept only") {
			t.Errorf("the second ask does not say why: %q", prompt[len(prompt)-200:])
		}
		return http.StatusOK, longArticle("够长", 5)
	})
	fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)

	if err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki articles: %v", err)
	}
	written, _ := door.Write("database")
	if len(written.Articles) != 1 || written.Articles[0].Title != "够长" {
		t.Fatalf("the write carries %+v, want the longer second draft", written.Articles)
	}
	if asked != 2 {
		t.Errorf("the model was asked %d times, want twice", asked)
	}
}

func TestWikiArticleIsRefusedToAnyButAMaintenanceRun(t *testing.T) {
	door := newFakeArticlesDoor(t, nil, nil)
	door.planCode = http.StatusForbidden
	door.planBody = `{"code":"WIKI_NOT_MAINTENANCE_SESSION","message":"only a Wiki maintenance run of this space writes its articles"}`
	vllm := newFakeVLLM(t, articleAnswers)
	spawns := fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)

	err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "only a Wiki maintenance run of space space-1 writes its articles") ||
		!strings.Contains(err.Error(), "WIKI_NOT_MAINTENANCE_SESSION") {
		t.Fatalf("refused = %v", err)
	}
	if len(spawns()) != 0 || len(door.Calls()) != 1 {
		t.Errorf("a refused plan went on: %v", door.Calls())
	}
}

func TestWikiArticleCountsAStaleWriteAsAFailure(t *testing.T) {
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("database", 3, true)},
		map[string]map[string]interface{}{"database": topicInput("database", smallTopic("database", 3))})
	door.answer = func(string, wikiArticleWrite) (int, string) {
		return http.StatusConflict, `{"code":"WIKI_ARTICLE_STALE","message":"the entries of topic database changed while its articles were written"}`
	}
	vllm := newFakeVLLM(t, articleAnswers)
	fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)

	var out strings.Builder
	err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "1 topic was left unwritten") {
		t.Fatalf("a stale write = %v", err)
	}
	if !strings.Contains(out.String(), "WIKI_ARTICLE_STALE") || !strings.Contains(out.String(), "changed while its articles were written") {
		t.Errorf("the output does not say why: %q", out.String())
	}
}

// ── The pieces ──────────────────────────────────────────────────────────────────────────────────

func TestWikiArticleGroupsByPathsFirstAndTheSameWayEveryTime(t *testing.T) {
	var entries []wikiArticleEntry
	dirs := []string{"src/apiserver/prisma/migrations", "src/web/src/components", "src/runner-go/worktree"}
	for i := 0; i < 90; i++ {
		dir := dirs[i%3]
		// The words are shared across the clusters on purpose: only the paths tell them apart.
		entries = append(entries, wikiArticleEntry{ID: fmt.Sprintf("%d", i), Title: fmt.Sprintf("一条关于顺序的经验 %d", i),
			Summary: "按顺序做，别跳步。", Paths: []string{fmt.Sprintf("%s/f%d.ts", dir, i)}, Sources: 90 - i})
	}
	groups := groupWikiArticleEntries(entries)
	if len(groups) != 3 {
		t.Fatalf("%d groups, want ceil(90/40)=3", len(groups))
	}
	for _, group := range groups {
		dir := entries[group[0]].Paths[0]
		dir = dir[:strings.LastIndex(dir, "/")]
		for _, i := range group {
			if !strings.HasPrefix(entries[i].Paths[0], dir+"/") {
				t.Errorf("group led by %s holds %s", dir, entries[i].Paths[0])
			}
		}
	}
	again := groupWikiArticleEntries(entries)
	if !reflect.DeepEqual(groups, again) {
		t.Error("the same entries grouped twice gave two answers")
	}
	// Few entries: two groups at least, none below rules.groupMin unless nothing reaches it.
	few := groupWikiArticleEntries(entries[:50])
	for _, group := range few {
		if len(group) < wikiArticleGroupMin {
			t.Errorf("a group of %d, below %d", len(group), wikiArticleGroupMin)
		}
	}
}

func TestWikiArticleDraftCharsCountsWhatTheServerWouldKeep(t *testing.T) {
	draft := strings.Join([]string{
		"# 标题不算",
		"第一句有脚注[1]。第二句没有。",
		"第三句的脚注越界[9]。",
		"- `arr[0]` 是代码，第四句有脚注[2]。",
		"## 小节也不算",
		"The fifth sentence counts. [2]",
	}, "\n")
	// Kept: 第一句有脚注。(7) · `arr[0]` 是代码，第四句有脚注。(19) · The fifth sentence counts.(26)
	want := utf8.RuneCountInString("第一句有脚注。") + utf8.RuneCountInString("`arr[0]` 是代码，第四句有脚注。") + utf8.RuneCountInString("The fifth sentence counts.")
	if got := wikiArticleDraftChars(draft, 2); got != want {
		t.Errorf("draft chars = %d, want %d", got, want)
	}
	if got := wikiArticleSentences("一。二[1][2]。三」[3]。four. five"); !reflect.DeepEqual(got, []string{"一。", "二[1][2]。", "三」[3]。", "four.", " five"}) {
		t.Errorf("sentences = %#v", got)
	}
	// Code a model left outside backticks is not a sentence's end; an ASCII question after a word is.
	if got := wikiArticleSentences("lastTurnAt ?? createdAt 降序[1]。为什么? 因为[2]。a != b 时成立[3]！"); !reflect.DeepEqual(got,
		[]string{"lastTurnAt ?? createdAt 降序[1]。", "为什么?", " 因为[2]。", "a != b 时成立[3]！"}) {
		t.Errorf("sentences = %#v", got)
	}
	if got := wikiArticleTitle("前言\n# **标题** [3]\n正文", "fallback"); got != "标题" {
		t.Errorf("title = %q", got)
	}
	if got := wikiArticleTitle("没有标题", "fallback"); got != "fallback" {
		t.Errorf("title = %q", got)
	}
	if got := wikiArticleGroupName("好的，这组的小标题是：\n「迁移与写入清单」"); got != "迁移与写入清单" {
		t.Errorf("group name = %q", got)
	}
	if got := wikiArticleFallbackName([]wikiArticleEntry{{Paths: []string{"src/web/src/a.ts"}}, {Paths: []string{"src/web/src/b.ts", "docs/x.md"}}}); got != "src/web/src" {
		t.Errorf("fallback name = %q", got)
	}
	text, usage, err := readWikiModelResult([]byte("noise\n" + `{"type":"result","is_error":false,"result":"好","usage":{"input_tokens":120,"cache_read_input_tokens":30,"output_tokens":45}}`))
	if err != nil || text != "好" || usage.InputTokens != 150 || usage.OutputTokens != 45 {
		t.Errorf("result = %q %+v %v", text, usage, err)
	}
	if _, _, err := readWikiModelResult([]byte(`{"is_error":true,"api_error_status":401,"result":"Invalid API key"}`)); err == nil {
		t.Error("a 401 read as an answer")
	} else if _, ok := err.(*wikiArticleAuthError); !ok {
		t.Errorf("a 401 = %T %v", err, err)
	}
}

// The command, its words and its numbers are the contract's.
func TestWikiArticleIsTheContractsCommand(t *testing.T) {
	articles := wikiContract(t)["articles"].(map[string]interface{})
	rules := articles["rules"].(map[string]interface{})
	for name, value := range map[string]int{
		"minChars": wikiArticleMinChars, "maxChars": wikiArticleMaxChars, "splitAbove": wikiArticleSplitAbove,
		"groupTarget": wikiArticleGroupTarget, "groupsMax": wikiArticleGroupsMax, "groupMin": wikiArticleGroupMin,
		"entriesPerArticle": wikiArticleEntriesPerArticle, "titleMaxChars": wikiArticleTitleMaxChars,
	} {
		if int(rules[name].(float64)) != value {
			t.Errorf("rules.%s = %v, this build has %d", name, rules[name], value)
		}
	}
	cli := articles["cli"].(map[string]interface{})
	if cli["precondition"] != wikiArticlesPrecondition {
		t.Errorf("the precondition drifted from the contract:\n%q\n%q", cli["precondition"], wikiArticlesPrecondition)
	}
	if !strings.HasPrefix(wikiArticlesDescription, wikiArticlesPrecondition) {
		t.Error("the description does not lead with its precondition")
	}
	var spec *cliCapabilitySpec
	for i := range wikiCLICapabilities {
		if wikiCLICapabilities[i].Tool == "wiki_articles" {
			spec = &wikiCLICapabilities[i]
		}
	}
	if spec == nil || spec.Usage != cli["articles"] || !spec.SessionOnly || spec.Description != wikiArticlesDescription {
		t.Fatalf("the capability = %+v, the contract's usage %q", spec, cli["articles"])
	}
	if !strings.Contains(wikiActionHelp["articles"], wikiArticlesPrecondition) || !strings.Contains(wikiHelp, "orbit wiki articles --space") {
		t.Error("the help does not carry the command and its precondition")
	}
	// The routes it calls are the contract's, and the runner door's maintenance routes.
	routes := articles["routes"].(map[string]interface{})
	maintenance := wikiContract(t)["agentSurface"].(map[string]interface{})["doors"].(map[string]interface{})["runner"].(map[string]interface{})["maintenanceRoutes"].([]interface{})
	for _, name := range []string{"plan", "input", "write"} {
		found := false
		for _, route := range maintenance {
			if route == routes[name] {
				found = true
			}
		}
		if !found {
			t.Errorf("route %s (%v) is not a maintenance route", name, routes[name])
		}
	}
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("database", 3, true)},
		map[string]map[string]interface{}{"database": topicInput("database", smallTopic("database", 3))})
	vllm := newFakeVLLM(t, articleAnswers)
	fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)
	if err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki articles: %v", err)
	}
	called := map[string]bool{}
	for _, call := range door.Calls() {
		called[strings.Replace(strings.Replace(call, "space-1", ":id", 1), "/database", "/:slug", 1)] = true
	}
	for _, name := range []string{"plan", "input", "write"} {
		if !called[routes[name].(string)] {
			t.Errorf("the run never called %s (%v): it called %v", name, routes[name], door.Calls())
		}
	}
	// And it is pre-approved for the session it is for, like every wiki verb.
	if rules := strings.Join(orbitCLIAllowedTools("/usr/local/bin/orbit", false), "\n"); !strings.Contains(rules, "Bash(/usr/local/bin/orbit wiki articles *)") {
		t.Errorf("orbit wiki articles is not pre-approved: %s", rules)
	}
}

// ── The real Claude Code, where this machine has one ────────────────────────────────────────────

// The fake Claude Code does what the clean launch should make the real one do; this holds the real one
// to it, and to the one thing only the real one can show: with CLAUDE_CODE_EFFORT_LEVEL=unset and
// MAX_THINKING_TOKENS=0, the request asks for no effort and no thinking, whatever the session's own
// provider declared.
func TestWikiArticleDrivesTheRealClaudeCodeWithThinkingOff(t *testing.T) {
	exe := requireRealClaude(t)
	door := newFakeArticlesDoor(t, []map[string]interface{}{planTopic("database", 3, true)},
		map[string]map[string]interface{}{"database": topicInput("database", smallTopic("database", 3))})
	vllm := newFakeVLLM(t, articleAnswers)
	var mu sync.Mutex
	var bodies []map[string]interface{}
	recorder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/messages") {
			var body map[string]interface{}
			_ = json.Unmarshal(raw, &body)
			mu.Lock()
			bodies = append(bodies, body)
			mu.Unlock()
		}
		forward, _ := http.NewRequest(r.Method, vllm.URL+r.URL.RequestURI(), bytes.NewReader(raw))
		forward.Header = r.Header.Clone()
		answer, err := http.DefaultClient.Do(forward)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer answer.Body.Close()
		for key, values := range answer.Header {
			w.Header()[key] = values
		}
		w.WriteHeader(answer.StatusCode)
		_, _ = io.Copy(w, answer.Body)
	}))
	t.Cleanup(recorder.Close)
	wikiArticlesSession(t, door.URL, &fakeVLLM{URL: recorder.URL})
	previous := wikiVerifyClaudeBinary
	wikiVerifyClaudeBinary = exe
	t.Cleanup(func() { wikiVerifyClaudeBinary = previous })

	var out strings.Builder
	if err := cmdWikiCLI([]string{"articles", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki articles with %s: %v\n%s", exe, err, out.String())
	}
	if written, ok := door.Write("database"); !ok || len(written.Articles) != 1 || !strings.Contains(written.Articles[0].Markdown, "[1]") {
		t.Fatalf("the write = %+v", written)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("the real Claude Code asked the endpoint %d times, want once", len(bodies))
	}
	body := bodies[0]
	if config, ok := body["output_config"].(map[string]interface{}); ok && config["effort"] != nil {
		t.Errorf("the request asks for effort %v: thinking is not off", config["effort"])
	}
	if thinking, ok := body["thinking"].(map[string]interface{}); ok && thinking["type"] != "disabled" {
		t.Errorf("the request asks for thinking %v", thinking)
	}
	if tools, _ := body["tools"].([]interface{}); len(tools) != 0 {
		t.Errorf("the request offers %d tools", len(tools))
	}
	system, _ := json.Marshal(body["system"])
	if !strings.Contains(string(system), "encyclopedia-style wiki articles") || len(system) > 4_000 {
		t.Errorf("the system prompt is not the writer's alone (%d bytes): %s", len(system), system)
	}
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	t.Logf("the request's keys: %v", keys)
}
