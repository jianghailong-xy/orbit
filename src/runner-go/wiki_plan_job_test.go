package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// `orbit wiki plan draft | revise | check` (contract `plan.jobs`, criterion 11), against a fake runner door
// that answers every route a plan job's run reaches, the fake vLLM endpoint and fake Claude Code of
// wiki_verify_test.go — whose answers stream, as a real one's do — and a real git checkout with an origin.
//
// The model is scripted by what each prompt asks: the catalogue, a category's details, a document's
// outline, the rules, a revision's catalogue and rewrites, and a redo. What the tests read back is what the
// door was sent — the draft, the rounds, the job's end — and what the work directory kept.

// ── The door ────────────────────────────────────────────────────────────────────────────────────

type fakePlanDoor struct {
	URL      string
	mu       sync.Mutex
	requests []maintainRequest

	job       map[string]interface{}
	state     map[string]interface{}
	materials map[string]interface{}
	// drafts answers each draft submitted, by its number from 1.
	drafts func(n int, body map[string]interface{}) (int, string)
	check  func(job string) (int, string)
}

func newFakePlanDoor(t *testing.T, f maintainFixture) *fakePlanDoor {
	t.Helper()
	d := &fakePlanDoor{
		job: map[string]interface{}{
			"job": map[string]interface{}{"id": "job-1", "spaceId": "space-1", "kind": "draft", "trigger": "space_created", "state": "running",
				"instructions": nil, "attemptsMax": 3},
			"space": map[string]interface{}{"id": "space-1", "title": "App",
				"repo":      map[string]interface{}{"urlNorm": normalizeWikiRepoURL(f.bare), "rootCommitSha": f.first},
				"workspace": map[string]interface{}{"id": "ws-1", "workDir": f.checkout}},
		},
		state: map[string]interface{}{"spaceId": "space-1", "confirmed": nil, "draft": nil, "proposals": []interface{}{}, "job": nil},
		materials: map[string]interface{}{
			"spaceId": "space-1", "title": "App", "asOf": "2026-09-29T00:00:00.000Z",
			"repo":      map[string]interface{}{"urlNorm": normalizeWikiRepoURL(f.bare), "rootCommitSha": f.first},
			"workspace": map[string]interface{}{"id": "ws-1", "workDir": f.checkout},
			"projects": []interface{}{
				map[string]interface{}{"id": "p1", "title": "App 项目", "status": "OPEN", "createdAt": "2026-09-01T00:00:00.000Z", "tasks": 12, "sessions": 9},
				map[string]interface{}{"id": "p2", "title": "同名项目", "status": "OPEN", "createdAt": "2026-09-02T00:00:00.000Z", "tasks": 1, "sessions": 0},
				map[string]interface{}{"id": "p3", "title": "同名项目", "status": "DONE", "createdAt": "2026-09-03T00:00:00.000Z", "tasks": 1, "sessions": 0},
			},
			"sessions": map[string]interface{}{"days": 90, "total": 4, "items": []interface{}{
				map[string]interface{}{"title": "执行任务：App 存储改造", "month": "2026-09", "task": true, "project": "App 项目", "provider": "claude"},
				map[string]interface{}{"title": "App 存储怎么保存", "month": "2026-09", "task": false, "project": nil, "provider": "claude"},
				map[string]interface{}{"title": "修端口写死的坑", "month": "2026-08", "task": false, "project": nil, "provider": "codex"},
				map[string]interface{}{"title": "修端口写死的测试", "month": "2026-08", "task": false, "project": nil, "provider": "codex"},
			}},
			"entries": []interface{}{map[string]interface{}{"kind": "pitfall", "status": "active", "count": 3}},
			"topics": []interface{}{map[string]interface{}{"slug": "storage-topic", "title": "存储", "category": "data",
				"pathPrefixes": []interface{}{"src/app/"}, "active": 3,
				"recent": []interface{}{map[string]interface{}{"kind": "pitfall", "title": "端口不能写死"}}}},
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := maintainRequest{method: r.Method, path: r.URL.Path, query: r.URL.Query(), session: r.Header.Get("X-Orbit-Session-Id")}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &request.body); err != nil {
				t.Errorf("%s %s sent a body that is not JSON: %s", r.Method, r.URL.Path, raw)
			}
		}
		d.mu.Lock()
		d.requests = append(d.requests, request)
		drafts := 0
		for _, req := range d.requests {
			if req.method == http.MethodPost && strings.HasSuffix(req.path, "/plan/drafts") {
				drafts++
			}
		}
		d.mu.Unlock()
		status, body := http.StatusNotFound, `{"message":"no such route"}`
		path := strings.TrimPrefix(r.URL.Path, "/api/runner/wiki/spaces/space-1/")
		jsonOf := func(v interface{}) string {
			raw, _ := json.Marshal(v)
			return string(raw)
		}
		switch {
		case r.Method == http.MethodGet && path == "plan/job":
			status, body = http.StatusOK, jsonOf(d.job)
		case r.Method == http.MethodGet && path == "plan":
			status, body = http.StatusOK, jsonOf(d.state)
		case r.Method == http.MethodGet && path == "plan/materials":
			status, body = http.StatusOK, jsonOf(d.materials)
		case r.Method == http.MethodPost && path == "plan/job/progress":
			status, body = http.StatusOK, jsonOf(d.job["job"])
		case r.Method == http.MethodPost && path == "plan/drafts":
			status, body = http.StatusOK, `{"version":1,"status":"draft"}`
			if d.drafts != nil {
				status, body = d.drafts(drafts, request.body)
			}
		case r.Method == http.MethodPost && path == "plan/job/finish":
			status, body = http.StatusOK, jsonOf(d.job["job"])
		case r.Method == http.MethodGet && path == "plan/check" && d.check != nil:
			status, body = d.check(r.URL.Query().Get("jobId"))
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	d.URL = srv.URL
	return d
}

func (d *fakePlanDoor) of(method, path string) []maintainRequest {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []maintainRequest
	for _, request := range d.requests {
		if request.method == method && strings.HasSuffix(request.path, "/"+path) {
			out = append(out, request)
		}
	}
	return out
}

// ── The repository ──────────────────────────────────────────────────────────────────────────────

// newPlanFixture is a repository with documents, code in two languages and a contract, pushed to an origin,
// and a clone of it: the maintenance workspace's checkout.
func newPlanFixture(t *testing.T) maintainFixture {
	t.Helper()
	base := t.TempDir()
	f := maintainFixture{bare: filepath.Join(base, "app.git"), checkout: filepath.Join(base, "app")}
	seed := filepath.Join(base, "seed")
	mustGit(t, base, "init", "-q", "--bare", "-b", "main", f.bare)
	mustGit(t, base, "init", "-q", "-b", "main", seed)
	mustGit(t, seed, "config", "user.email", "test@orbit")
	mustGit(t, seed, "config", "user.name", "Test")
	for name, content := range map[string]string{
		"README.md":                   "# App\n\nApp is the spec's small service: it serves what its store keeps, and its tests run on fixtures.\n",
		"docs/architecture.md":        "# Architecture\n\nApp is a server and a store.\n\n## Execution model\n\nThe server serves.\n\n## Realtime and recovery\n\nIt recovers.\n",
		"docs/wiki-design.md":         "# Wiki design\n\n## 4. 写路径\n\nWrites.\n\n### 4.4 锚点\n\nAnchors.\n\n```md\n## 这不是一个章节\n```\n",
		"docs/mocks/21-plan.md":       "# A mock\n\n## Mock heading\n",
		"src/app/main.go":             "package app\n\ntype Server struct{}\n\nfunc Serve() error { return nil }\n\nfunc (s *Server) Handle() {}\n",
		"src/app/store.go":            "package app\n\ntype Store struct{}\n\nfunc (s *Store) Save() error { return nil }\n",
		"src/app/store_test.go":       "package app\n\nfunc TestStoreSaves() {}\n",
		"src/web/client.ts":           "export class Client {\n  fetchPlan() {\n    return 1;\n  }\n}\n\nexport function render() {}\n",
		"contracts/app.contract.json": "{\"name\":\"app\",\"routes\":[]}\n",
	} {
		file := filepath.Join(seed, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
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

// ── The model ───────────────────────────────────────────────────────────────────────────────────

const planSkeleton = "## 1. 产品 `product` —— 这个服务是什么、怎么运转\n" +
	"- 1.1 服务概览 `service-overview`｜这个服务是什么、由哪些部分组成｜含：定位；组件；入口\n" +
	"- 1.2 存储 `storage`｜数据怎么存、怎么取｜含：Store；保存\n" +
	"## 2. 开发约定 `dev` —— 给写代码的 agent 看的约定 [agents]\n" +
	"- 2.1 测试约定 `testing`｜怎么跑测试｜含：go test；夹具\n"

const planDetailsProduct = "### 1.1 服务概览\n读者：新加入的开发者：读完能说出服务由哪些部分组成\n含：定位；组件；入口\n不含：存储细节（见 1.2）\n篇幅：800–1200 字\n" +
	"文档：docs/architecture.md\n代码：src/app/\n契约：contracts/app.contract.json\n主题：storage-topic\n项目：「App 项目」\n\n" +
	"### 1.2 存储\n读者：写存储代码的人：读完能改 Store\n含：Store 的结构；保存流程\n不含：测试怎么跑（见 2.1）\n篇幅：600–900 字\n" +
	"文档：docs/wiki-design.md\n代码：src/app/store.go\n契约：无\n主题：无\n项目：无\n"

const planDetailsDev = "### 2.1 测试约定\n读者：写代码的 agent：读完知道怎么跑测试\n含：go test；夹具\n不含：存储（见 1.2）\n篇幅：400–600 字\n" +
	"文档：无\n代码：src/web/\n契约：无\n主题：无\n项目：无\n"

const planOutlineOverview = "### 1. 总览 | overview | 200\n讲什么：概括第 2、3 节。\n" +
	"### 2. 组件 | concepts | 400\n讲什么：Server 与 Store 两个组件，存储细节见 1.2。\n" +
	"- 文档：docs/architecture.md § Execution model\n- 代码：src/app/main.go: Server, Serve()\n- 契约：contracts/app.contract.json\n" +
	"### 3. 已知的坑 | pitfalls | 300\n讲什么：启动时的坑。\n" +
	"- 会话：项目「App 项目」；时间 2026-09-01 至 今；关键词 启动、端口；锚点 src/app/；kind pitfall；主题 storage-topic；要找：owner 说端口不能写死的原话\n"

const planOutlineStorage = "### 1. 保存流程 | flow | 500\n讲什么：Store.Save 怎么保存。\n" +
	"- 文档：docs/wiki-design.md § 4.4 锚点\n- 代码：src/app/store.go: Store.Save\n" +
	"### 2. 约定 | conventions | 200\n讲什么：保存前先校验。\n"

// planOutlineStorageWrong names a symbol, a docs section and a file that are not there, points at a
// document the plan does not have, and writes a line the format does not have.
const planOutlineStorageWrong = "### 1. 保存流程 | flow | 500\n讲什么：Store.Load 怎么读，见 9.9。\n" +
	"- 文档：docs/wiki-design.md § 5. 不存在的章节\n- 代码：src/app/store.go: Store.Save, Store.Load\n- 代码：src/app/missing.go: Foo\n" +
	"- 备注：这一行不在格式里\n" +
	"### 2. 约定 | conventions | 200\n讲什么：保存前先校验。\n"

const planOutlineTesting = "### 1. 怎么跑测试 | conventions | 300\n讲什么：用 go test 跑，组件见 1.1。\n" +
	"- 代码：src/web/client.ts: Client.fetchPlan, render()\n"

const planRules = "## 引用规则\n1. 脚注引一手原文。\n## 归并规则\n1. 新决定覆盖旧的。\n## 维护规则\n1. 只重写受影响的节。\n"

// planModel answers each prompt as the scripted model would, and keeps what it was asked.
type planModel struct {
	mu      sync.Mutex
	prompts []string
	// skeleton answers the catalogue by the time it is asked for (1, 2, …); without it, planSkeleton.
	skeleton  func(n int) string
	skeletons int
	// outline answers a document's outline by its title; redo a redo of it.
	outline func(title string) string
	redo    func(title string, prompt string) string
	// revise answers a revision's catalogue by its round (1, 2, …), and rewrite a revision's document.
	revise  func(round int, prompt string) string
	rewrite func(title string) string
	rounds  int
}

var planTitleIn = regexp.MustCompile(`《([^》]+)》`)

func (m *planModel) answer(prompt string) (int, string) {
	m.mu.Lock()
	m.prompts = append(m.prompts, prompt)
	m.mu.Unlock()
	title := ""
	if t := planTitleIn.FindStringSubmatch(prompt[strings.LastIndex(prompt, "# 任务"):]); t != nil {
		title = t[1]
	}
	switch {
	case strings.Contains(prompt, "第一步：文档目录的骨架"), strings.Contains(prompt, "# 任务：改正 wiki「"):
		if m.skeleton != nil {
			m.mu.Lock()
			m.skeletons++
			n := m.skeletons
			m.mu.Unlock()
			return http.StatusOK, m.skeleton(n)
		}
		return http.StatusOK, planSkeleton
	case strings.Contains(prompt, "第二步：给大类「产品」"):
		return http.StatusOK, planDetailsProduct
	case strings.Contains(prompt, "第二步：给大类「开发约定」"):
		return http.StatusOK, planDetailsDev
	case strings.Contains(prompt, "第三步 —— 给《"):
		if m.outline != nil {
			if answer := m.outline(title); answer != "" {
				return http.StatusOK, answer
			}
		}
		return http.StatusOK, map[string]string{"服务概览": planOutlineOverview, "存储": planOutlineStorage, "测试约定": planOutlineTesting}[title]
	case strings.Contains(prompt, "第四步 —— 三条规则的草案"):
		return http.StatusOK, planRules
	case strings.Contains(prompt, "按 owner 的要求修订 plan 的目录"):
		m.mu.Lock()
		m.rounds++
		round := m.rounds
		m.mu.Unlock()
		return http.StatusOK, m.revise(round, prompt)
	case strings.Contains(prompt, "# 任务：写新草稿里《"):
		return http.StatusOK, m.rewrite(title)
	case strings.Contains(prompt, "# 任务：改正 plan 里《"):
		return http.StatusOK, m.redo(title, prompt)
	}
	return http.StatusOK, "（不认得的提示）"
}

func (m *planModel) asked(marker string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, prompt := range m.prompts {
		if strings.Contains(prompt, marker) {
			out = append(out, prompt)
		}
	}
	return out
}

// planSession points the CLI at the door and the model endpoint as a plan job's session has them, with
// what must not reach a clean call planted beside them; the waits are shortened for the fake endpoint.
func planSession(t *testing.T, doorURL string, vllm *fakeVLLM) {
	t.Helper()
	wikiMaintainSession(t, doorURL, vllm)
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	t.Setenv("ORBIT_TASK_ID", "")
	t.Setenv("ORBIT_AGENT_ID", "")
	waits, poll := wikiPlanRetryWaits, wikiPlanHealthPoll
	wikiPlanRetryWaits, wikiPlanHealthPoll = []time.Duration{0, 0, 0}, 10*time.Millisecond
	t.Cleanup(func() { wikiPlanRetryWaits, wikiPlanHealthPoll = waits, poll })
}

func runPlanCLI(t *testing.T, work string, args ...string) (wikiPlanSummary, string, error) {
	t.Helper()
	var out strings.Builder
	err := cmdWikiCLI(append(append([]string{"plan"}, args...), "--space", "space-1", "--work-dir", work, "--json"), strings.NewReader(""), &out)
	var summary wikiPlanSummary
	if jsonErr := json.Unmarshal([]byte(out.String()), &summary); jsonErr != nil {
		t.Fatalf("--json printed %q: %v (the run: %v)", out.String(), jsonErr, err)
	}
	return summary, out.String(), err
}

// draftSent is the one draft the server was sent, as JSON.
func draftSent(t *testing.T, door *fakePlanDoor, n int) wikiPlanDraftRequest {
	t.Helper()
	drafts := door.of(http.MethodPost, "plan/drafts")
	if len(drafts) < n {
		t.Fatalf("the server was sent %d drafts, want at least %d", len(drafts), n)
	}
	raw, _ := json.Marshal(drafts[n-1].body)
	var request wikiPlanDraftRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	return request
}

func planFinish(t *testing.T, door *fakePlanDoor) map[string]interface{} {
	t.Helper()
	ends := door.of(http.MethodPost, "plan/job/finish")
	if len(ends) != 1 {
		t.Fatalf("the job ended %d times, want once", len(ends))
	}
	return ends[0].body
}

func planAttempts(door *fakePlanDoor) []int {
	var out []int
	for _, request := range door.of(http.MethodPost, "plan/job/progress") {
		n, _ := request.body["attempt"].(float64)
		out = append(out, int(n))
	}
	return out
}

// ── The four steps ──────────────────────────────────────────────────────────────────────────────

func TestWikiPlanDraftsInFourStepsEachStreamedToDisk(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	model := &planModel{}
	vllm := newFakeVLLM(t, model.answer)
	planSession(t, door.URL, vllm)
	spawns := fakeVerifyClaude(t)
	work := t.TempDir()
	// What another job left in the directory is not this run's: not its answers, and not its ledger.
	if err := os.MkdirAll(filepath.Join(work, "a1"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"meta.json": `{"job":"another"}`, "a1/skeleton-catalogue.md": "stale", "calls.jsonl": `{"step":"stale"}` + "\n"} {
		if err := os.WriteFile(filepath.Join(work, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	summary, printed, err := runPlanCLI(t, work, "draft", "--target", "3-3")
	if err != nil {
		t.Fatalf("orbit wiki plan draft: %v\n%s", err, printed)
	}
	if summary.Outcome != "succeeded" || summary.Version == nil || *summary.Version != 1 {
		t.Fatalf("the run did not store version 1: %+v", summary)
	}
	if ledger, _ := os.ReadFile(filepath.Join(work, "calls.jsonl")); strings.Contains(string(ledger), "stale") ||
		strings.Count(string(ledger), "\n") != summary.Report.Tokens.Calls {
		t.Errorf("the ledger is not this run's %d calls:\n%s", summary.Report.Tokens.Calls, ledger)
	}

	// The order: the catalogue first, every category's details before any outline, the rules beside them.
	var order []string
	for _, request := range vllm.Requests() {
		switch {
		case strings.Contains(request.Prompt, "第一步"):
			order = append(order, "skeleton")
		case strings.Contains(request.Prompt, "第二步"):
			order = append(order, "details")
		case strings.Contains(request.Prompt, "第三步"):
			order = append(order, "outline")
		case strings.Contains(request.Prompt, "第四步"):
			order = append(order, "rules")
		}
	}
	if len(order) != 7 || order[0] != "skeleton" {
		t.Fatalf("the calls were %v, want the catalogue, two categories' details, three outlines and the rules", order)
	}
	lastDetails, firstOutline := -1, len(order)
	for i, step := range order {
		if step == "details" {
			lastDetails = i
		}
		if step == "outline" && i < firstOutline {
			firstOutline = i
		}
	}
	if lastDetails > firstOutline {
		t.Errorf("an outline was asked for before every category's details: %v", order)
	}
	// Each outline was asked with its own document's materials: its docs' whole heading tree and its code's symbols.
	for _, prompt := range model.asked("第三步 —— 给《存储》") {
		if !strings.Contains(prompt, "### docs/wiki-design.md") || !strings.Contains(prompt, "- 4. 写路径") ||
			!strings.Contains(prompt, "src/app/store.go: Store, Store.Save") {
			t.Errorf("the outline of 存储 was not given its targeted materials:\n%s", prompt)
		}
		if strings.Contains(prompt, "这不是一个章节") || strings.Contains(prompt, "Mock heading") {
			t.Errorf("a heading inside a code fence, or a mockup's, reached the materials")
		}
	}

	// Every answer streamed into the work directory as it came, and was kept.
	streams, _ := filepath.Glob(filepath.Join(work, "streams", "a1-*.jsonl"))
	if len(streams) != 7 {
		t.Fatalf("%d streams were kept, want one a call: %v", len(streams), streams)
	}
	for _, stream := range streams {
		raw, _ := os.ReadFile(stream)
		var types []string
		scanner := bufio.NewScanner(bytes.NewReader(raw))
		scanner.Buffer(make([]byte, 1<<20), 1<<24)
		for scanner.Scan() {
			var event struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(scanner.Bytes(), &event)
			types = append(types, event.Type)
		}
		if len(types) < 4 || types[0] != "system" || types[1] != "stream_event" || types[len(types)-1] != "result" {
			t.Errorf("%s is not an answer streamed as it arrived: %v", filepath.Base(stream), types)
		}
		if text := wikiPlanStreamedText(raw); strings.TrimSpace(text) == "" {
			t.Errorf("%s carried no text before its result", filepath.Base(stream))
		}
	}
	for _, name := range []string{"a1/skeleton-catalogue.md", "a1/details-1-1.1_1.2.md", "a1/outline-storage.md", "a1/rules-rules.md", "a1/draft.json", "materials/repo.md", "materials/sessions.md", "calls.jsonl"} {
		if _, err := os.Stat(filepath.Join(work, name)); err != nil {
			t.Errorf("the work directory has no %s", name)
		}
	}

	// The clean launch: bare, no settings source, no tool, no MCP server, streamed; nothing of the session's.
	for _, spawn := range spawns() {
		joined := strings.Join(spawn.Args, " ")
		for _, want := range []string{"-p", "--bare", "--strict-mcp-config", "--no-session-persistence", "--verbose", "--include-partial-messages"} {
			if !strings.Contains(joined, want) {
				t.Errorf("the launch lacks %s: %q", want, spawn.Args)
			}
		}
		if value, _ := argAfter(spawn.Args, "--output-format"); value != "stream-json" {
			t.Errorf("the answer is not streamed: %q", spawn.Args)
		}
		if value, found := argAfter(spawn.Args, "--setting-sources"); !found || value != "" {
			t.Errorf("--setting-sources is not '': %q", spawn.Args)
		}
		if value, found := argAfter(spawn.Args, "--tools"); !found || value != "" {
			t.Errorf("the call has tools: %q", spawn.Args)
		}
		env := spawnEnv(spawn)
		if env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
			t.Errorf("thinking is not off: %v", env)
		}
		for _, key := range []string{"ANTHROPIC_API_KEY", "ORBIT_SESSION_ID", "ORBIT_HOME"} {
			if _, ok := env[key]; ok {
				t.Errorf("%s reached the clean call", key)
			}
		}
		if env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "" || !strings.HasPrefix(env["HOME"], os.TempDir()) {
			t.Errorf("the call's HOME or output budget is not the clean one: %v", env)
		}
	}
	for _, request := range vllm.Requests() {
		if request.Authorization != "Bearer tok-local-vllm" || request.APIKey != "" || request.thinks() {
			t.Errorf("a request authenticated or thought wrongly: %+v", request)
		}
	}

	// What the server was sent: the whole plan, gated here first, with the repository's check at its sha.
	if got := planAttempts(door); !reflect.DeepEqual(got, []int{1}) {
		t.Errorf("the rounds reported were %v, want [1]", got)
	}
	sent := draftSent(t, door, 1)
	if sent.BaseVersion != nil || sent.Target == nil || *sent.Target != (wikiPlanLength{Min: 3, Max: 3}) || sent.Model != "qwen3.8-27b-fp8" {
		t.Errorf("the draft's envelope: %+v", sent)
	}
	if len(sent.Plan.Categories) != 2 || !sent.Plan.Categories[1].ForAgents || sent.Plan.Categories[1].Key != "dev" {
		t.Errorf("the categories: %+v", sent.Plan.Categories)
	}
	if len(sent.Plan.Docs) != 3 {
		t.Fatalf("the draft has %d documents", len(sent.Plan.Docs))
	}
	overview := sent.Plan.Docs[0]
	if overview.Slug != "service-overview" || overview.Category != "product" || overview.Length != (wikiPlanLength{Min: 800, Max: 1200}) {
		t.Errorf("the first document: %+v", overview)
	}
	if !reflect.DeepEqual(overview.ScopeOut, []wikiPlanScopeOut{{Text: "存储细节", Docs: []string{"storage"}}}) {
		t.Errorf("what it leaves to 1.2 is not by its slug: %+v", overview.ScopeOut)
	}
	components := overview.Sections[1]
	if components.Kind != "concepts" || components.Length != 400 || !strings.Contains(components.Covers, "见 1.2") ||
		!reflect.DeepEqual(components.Sources.Code, []wikiPlanCodeSource{{Path: "src/app/main.go", Symbols: []string{"Server", "Serve()"}}}) ||
		len(components.Sources.Docs) != 1 || *components.Sources.Docs[0].Section != "Execution model" {
		t.Errorf("a mechanism section: %+v", components)
	}
	sessions := overview.Sections[2].Sources.Sessions
	if sessions == nil || !reflect.DeepEqual(sessions.Projects, []string{"App 项目"}) || *sessions.Since != "2026-09-01" || sessions.Until != nil ||
		!reflect.DeepEqual(sessions.EntryKinds, []string{"pitfall"}) || !reflect.DeepEqual(sessions.Topics, []string{"storage-topic"}) ||
		sessions.Evidence != "owner 说端口不能写死的原话" {
		t.Errorf("a pitfalls section's session condition: %+v", sessions)
	}
	head := strings.TrimSpace(mustGit(t, f.checkout, "rev-parse", "origin/main"))
	if sent.RepoCheck.Sha != head || sent.RepoCheck.Checked < 8 || len(sent.RepoCheck.Missing) != 0 {
		t.Errorf("the repository's check: %+v (origin/main %s)", sent.RepoCheck, head)
	}

	// How the job ended, and what the session prints of it.
	end := planFinish(t, door)
	if end["outcome"] != "succeeded" || end["version"] != float64(1) || end["errors"] != nil || end["draft"] != nil {
		t.Errorf("the job's end: %v", end)
	}
	report, _ := end["report"].(map[string]interface{})
	tokens, _ := report["tokens"].(map[string]interface{})
	if report["docs"] != float64(3) || report["sections"] != float64(6) || tokens["calls"] != float64(7) || tokens["input"].(float64) <= 0 ||
		!strings.Contains(fmt.Sprint(report["rulesDraft"]), "## 引用规则") {
		t.Errorf("the report: %v", report)
	}
	for _, request := range door.of(http.MethodPost, "plan/job/finish") {
		if request.session != "maintenance-session" {
			t.Errorf("the job's end was not the session's: %q", request.session)
		}
	}
	if text := describeWikiPlanSummary(summary); !strings.Contains(text, "stored as version 1") || !strings.Contains(text, "Tokens:") ||
		!strings.Contains(text, "round 1: passed") {
		t.Errorf("what the session reports: %s", text)
	}
}

// ── The count, before any document ──────────────────────────────────────────────────────────────

// planSkeletonFour is planSkeleton with one document more.
const planSkeletonFour = "## 1. 产品 `product` —— 这个服务是什么、怎么运转\n" +
	"- 1.1 服务概览 `service-overview`｜这个服务是什么、由哪些部分组成｜含：定位；组件；入口\n" +
	"- 1.2 存储 `storage`｜数据怎么存、怎么取｜含：Store；保存\n" +
	"- 1.3 发布渠道 `release-channels`｜版本从哪里发出去｜含：渠道；节奏\n" +
	"## 2. 开发约定 `dev` —— 给写代码的 agent 看的约定 [agents]\n" +
	"- 2.1 测试约定 `testing`｜怎么跑测试｜含：go test；夹具\n"

func TestWikiPlanSendsACatalogueOutsideTheTargetBackBeforeAnyDocument(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	model := &planModel{skeleton: func(n int) string {
		if n == 1 {
			return planSkeletonFour
		}
		return planSkeleton
	}}
	vllm := newFakeVLLM(t, model.answer)
	planSession(t, door.URL, vllm)
	fakeVerifyClaude(t)

	summary, printed, err := runPlanCLI(t, t.TempDir(), "draft", "--target", "3-3")
	if err != nil {
		t.Fatalf("orbit wiki plan draft: %v\n%s", err, printed)
	}
	// The catalogue of four went back with the gate's own count error before anything else was asked.
	var order []string
	for _, request := range vllm.Requests() {
		switch {
		case strings.Contains(request.Prompt, "第一步"):
			order = append(order, "catalogue")
		case strings.Contains(request.Prompt, "第二步"), strings.Contains(request.Prompt, "第三步"), strings.Contains(request.Prompt, "第四步"):
			order = append(order, "body")
			if strings.Contains(request.Prompt, "release-channels") {
				t.Errorf("a document was written for the catalogue that was sent back:\n%s", request.Prompt)
			}
		}
	}
	if len(order) != 8 || order[0] != "catalogue" || order[1] != "catalogue" || strings.Count(strings.Join(order, " "), "catalogue") != 2 {
		t.Errorf("the calls: %v, want the catalogue twice and then the six the draft of three documents asks", order)
	}
	again := model.asked("# 任务：改正 wiki「")
	if len(again) != 1 || !strings.Contains(again[0], "[docCount] plan.docs：the plan has 4 documents; it must have 3 to 3: "+
		"merge documents that answer the same reader's question — 1 too many") || !strings.Contains(again[0], "release-channels") {
		t.Fatalf("the catalogue was not sent back with its count: %d prompts\n%s", len(again), strings.Join(again, "\n----\n"))
	}
	// Not a round: the one draft went through the gates at the first.
	if got := planAttempts(door); !reflect.DeepEqual(got, []int{1}) {
		t.Errorf("the rounds reported were %v, want [1]", got)
	}
	if sent := draftSent(t, door, 1); len(sent.Plan.Docs) != 3 {
		t.Errorf("the draft sent has %d documents", len(sent.Plan.Docs))
	}
	if summary.Outcome != "succeeded" || len(summary.Report.Attempts) != 1 || summary.Report.Tokens.Calls != 8 {
		t.Errorf("the summary: %+v", summary)
	}
}

func TestWikiPlanLeavesACountStillOutsideTheTargetToTheGate(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	model := &planModel{}
	vllm := newFakeVLLM(t, model.answer)
	planSession(t, door.URL, vllm)
	fakeVerifyClaude(t)

	summary, printed, err := runPlanCLI(t, t.TempDir(), "draft", "--target", "4-5")
	if err == nil || !strings.Contains(err.Error(), "did not pass the plan's gate in 3 rounds") {
		t.Fatalf("a catalogue that stayed at three documents for a target of 4–5: %v\n%s", err, printed)
	}
	// Each round: the catalogue, then twice more with the count before any document; then the gate judges.
	if n := len(model.asked("第一步")); n != 9 {
		t.Errorf("the catalogue was asked for %d times, want 3 in each of 3 rounds", n)
	}
	again := model.asked("# 任务：改正 wiki「")
	if len(again) != 8 {
		t.Fatalf("the catalogue was sent back %d times, want 8", len(again))
	}
	for _, prompt := range again {
		if !strings.Contains(prompt, "[docCount] plan.docs：the plan has 3 documents; it must have 4 to 5: split the broadest documents, "+
			"or add the ones the categories are missing — 1 too few") {
			t.Errorf("a catalogue sent back without its count:\n%s", prompt)
		}
	}
	// The documents were written once: the catalogues sent back kept every one of them.
	if n := len(model.asked("第二步")) + len(model.asked("第三步 —— 给《")); n != 5 {
		t.Errorf("%d details and outlines were asked for, want the first round's 5", n)
	}
	if n := len(door.of(http.MethodPost, "plan/drafts")); n != 0 {
		t.Errorf("the server was sent %d drafts this runner's gate refused", n)
	}
	if got := planAttempts(door); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Errorf("the rounds reported were %v", got)
	}
	for _, round := range summary.Report.Attempts {
		if round.Checks["docCount"] != 1 {
			t.Errorf("a round without the count: %+v", round)
		}
	}
	end := planFinish(t, door)
	if errs, _ := end["errors"].([]interface{}); end["outcome"] != "failed" || len(errs) != 1 || !strings.Contains(fmt.Sprint(errs[0]), "docCount") {
		t.Errorf("the job's end: %v", end)
	}
}

// ── References, and a round with the gate's errors ──────────────────────────────────────────────

func TestWikiPlanChecksRepositoryAndCrossReferencesAndRedoesWithTheErrors(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	model := &planModel{
		outline: func(title string) string {
			if title == "存储" {
				return planOutlineStorageWrong
			}
			return ""
		},
		redo: func(title, prompt string) string {
			return "标题：存储\n" + planOutlineStorage
		},
	}
	vllm := newFakeVLLM(t, model.answer)
	planSession(t, door.URL, vllm)
	fakeVerifyClaude(t)

	summary, printed, err := runPlanCLI(t, t.TempDir(), "draft", "--target", "3-3")
	if err != nil {
		t.Fatalf("orbit wiki plan draft: %v\n%s", err, printed)
	}
	// The first round never reached the server: this runner's gate stopped it.
	if n := len(door.of(http.MethodPost, "plan/drafts")); n != 1 {
		t.Fatalf("the server was sent %d drafts, want only the second round's", n)
	}
	if got := planAttempts(door); !reflect.DeepEqual(got, []int{1, 2}) {
		t.Errorf("the rounds reported were %v, want [1 2]", got)
	}
	first := summary.Report.Attempts[0]
	if first.Local != 5 || first.Server != 0 || first.Checks["references"] != 4 || first.Checks["schema"] != 1 {
		t.Errorf("the first round: %+v", first)
	}
	// Only the document with the errors was written again, with every error, and what it could name instead.
	redos := model.asked("# 任务：改正 plan 里《")
	if len(redos) != 1 || !strings.Contains(redos[0], "改正 plan 里《存储》") {
		t.Fatalf("the redo prompts: %d", len(redos))
	}
	for _, want := range []string{
		"Store.Load is no symbol of src/app/store.go", "it declares: Store; Store.Save",
		"has no section «5. 不存在的章节»", "its sections are: 4. 写路径; 4.4 锚点",
		"src/app/missing.go is no file or directory",
		"points at 9.9, which is no document of this plan",
		"«备注：这一行不在格式里» is not a line of a section",
		"1.2《存储》 第 1 节「保存流程」",
	} {
		if !strings.Contains(redos[0], want) {
			t.Errorf("the redo prompt does not say %q:\n%s", want, redos[0])
		}
	}
	sent := draftSent(t, door, 1)
	storage := sent.Plan.Docs[1]
	if storage.Slug != "storage" || len(storage.Audience) == 0 || storage.Length.Min != 600 ||
		!reflect.DeepEqual(storage.Sections[0].Sources.Code, []wikiPlanCodeSource{{Path: "src/app/store.go", Symbols: []string{"Store.Save"}}}) {
		t.Errorf("the redone document kept its header and fixed its sources: %+v", storage)
	}
	if len(sent.RepoCheck.Missing) != 0 {
		t.Errorf("the draft sent names what is not there: %+v", sent.RepoCheck.Missing)
	}
}

func TestWikiPlanReferencesAreHeldToTheTreeAtItsSha(t *testing.T) {
	f := newPlanFixture(t)
	head := strings.TrimSpace(mustGit(t, f.checkout, "rev-parse", "origin/main"))
	repo, err := loadWikiPlanRepo(f.checkout, head)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		where, symbol string
		want          bool
	}{
		{"src/app/main.go", "Server", true},
		{"src/app/main.go", "Serve()", true},
		{"src/app/main.go", "Server.Handle", true},
		{"src/app/main.go", "`Serve`", true},
		{"src/app/", "Store.Save", true},
		{"src/app/*.go", "Store.Save", true},
		{"src/web/client.ts", "Client.fetchPlan", true},
		{"src/web/client.ts", "render()", true},
		{"src/app/main.go", "Store.Save", false},
		{"src/app/store.go", "Store.Load", false},
		{"src/app/store.go", "TestStoreSaves", false},
	} {
		if got := repo.hasSymbol(c.where, c.symbol); got != c.want {
			t.Errorf("hasSymbol(%s, %s) = %v, want %v", c.where, c.symbol, got, c.want)
		}
	}
	for _, c := range []struct {
		file, section string
		want          bool
	}{
		{"docs/wiki-design.md", "4.4 锚点", true},
		{"docs/wiki-design.md", "锚点", true},
		{"docs/wiki-design.md", "§ 4. 写路径", true},
		{"docs/architecture.md", "execution model", true},
		{"docs/wiki-design.md", "这不是一个章节", false},
		{"docs/architecture.md", "Deployment", false},
		// A subsection named by the heading it sits under, as a model reads the documents' list.
		{"docs/wiki-design.md", "4. 写路径 - 4.4 锚点", true},
		{"docs/wiki-design.md", "写路径 > 锚点", true},
		{"docs/wiki-design.md", "4.4 锚点 - 4. 写路径", false},
		{"docs/architecture.md", "Execution model - Realtime and recovery", false},
	} {
		if got := repo.hasDocSection(c.file, c.section); got != c.want {
			t.Errorf("hasDocSection(%s, %s) = %v, want %v", c.file, c.section, got, c.want)
		}
	}
	for _, c := range []struct {
		path string
		want bool
	}{{"docs/architecture.md", true}, {"src/app", true}, {"src/app/", true}, {"src/**/*.ts", true}, {"src/app/missing.go", false}, {"src/nope/", false}} {
		if got := repo.hasPath(c.path); got != c.want {
			t.Errorf("hasPath(%s) = %v, want %v", c.path, got, c.want)
		}
	}
	if docs := strings.Join(repo.docFiles(), " "); strings.Contains(docs, "docs/mocks/") || !strings.Contains(docs, "docs/architecture.md") {
		t.Errorf("the documents a plan drafts from: %s", docs)
	}
	// A number of a document in the text is resolved through the catalogue it was written against.
	then := map[string]string{"1.1": "a", "1.2": "b", "1.3": "c"}
	now := map[string]string{"a": "1.1", "c": "1.2"}
	rename := func(id string) (string, bool) {
		slug, ok := then[id]
		if !ok {
			return "", false
		}
		n, ok := now[slug]
		return n, ok
	}
	text, unknown := wikiPlanRenumber("细节见 1.3，另见 1.1、1.2；→ 2.9", rename)
	if text != "细节见 1.2，另见 1.1、1.2；→ 2.9" || !reflect.DeepEqual(unknown, []string{"1.2", "2.9"}) {
		t.Errorf("renumbered %q, unknown %v", text, unknown)
	}
}

// ── The server's gate, three rounds, and the end ────────────────────────────────────────────────

func TestWikiPlanHandsTheServersErrorsBackAndFailsAtTheLimit(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	refusal := `{"code":"WIKI_PLAN_GATE","message":"The draft did not pass the plan's gate (references): 1 error.","errors":[` +
		`{"check":"references","path":"plan.docs[0].sections[2].sources.sessions.projects[0]","message":"no project of this account is titled «App 项目» or has that id"}]}`
	door.drafts = func(n int, body map[string]interface{}) (int, string) { return http.StatusUnprocessableEntity, refusal }
	model := &planModel{redo: func(title, prompt string) string { return planOutlineOverview }}
	vllm := newFakeVLLM(t, model.answer)
	planSession(t, door.URL, vllm)
	fakeVerifyClaude(t)

	summary, printed, err := runPlanCLI(t, t.TempDir(), "draft", "--target", "3-3")
	if err == nil {
		t.Fatalf("a draft the server refused three times was reported stored: %s", printed)
	}
	if !strings.Contains(err.Error(), "did not pass the plan's gate in 3 rounds") {
		t.Errorf("the failure: %v", err)
	}
	if n := len(door.of(http.MethodPost, "plan/drafts")); n != 3 {
		t.Errorf("the server was sent %d drafts, want 3", n)
	}
	if got := planAttempts(door); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Errorf("the rounds reported were %v", got)
	}
	redos := model.asked("# 任务：改正 plan 里《服务概览》")
	if len(redos) != 2 {
		t.Fatalf("the document was written again %d times, want twice", len(redos))
	}
	for _, prompt := range redos {
		if !strings.Contains(prompt, "[references] 1.1《服务概览》 第 3 节「已知的坑」 · sources.sessions.projects[0]：no project of this account is titled «App 项目»") {
			t.Errorf("the redo does not hand the server's error back:\n%s", prompt)
		}
	}
	end := planFinish(t, door)
	if end["outcome"] != "failed" || end["attempt"] != float64(3) {
		t.Errorf("the job's end: %v", end)
	}
	errs, _ := end["errors"].([]interface{})
	if len(errs) != 1 || !strings.Contains(fmt.Sprint(errs[0]), "plan.docs[0].sections[2].sources.sessions.projects[0]") {
		t.Errorf("the end does not carry the last round's errors: %v", end["errors"])
	}
	draft, _ := end["draft"].(map[string]interface{})
	if docs, _ := draft["docs"].([]interface{}); len(docs) != 3 {
		t.Errorf("the end does not carry the last draft: %v", end["draft"])
	}
	if len(summary.Report.Attempts) != 3 || summary.Report.Attempts[2].Server != 1 || summary.Outcome != "failed" {
		t.Errorf("the summary: %+v", summary)
	}
	if text := describeWikiPlanSummary(summary); !strings.Contains(text, "The last round's errors:") ||
		!strings.Contains(text, "round 3: the server's gate found 1 error (references 1)") {
		t.Errorf("what the session reports: %s", text)
	}
}

// ── A revision: protected documents, moves, and the count ───────────────────────────────────────

// planBase is a confirmed version of three documents, the first protected.
func planBase() map[string]interface{} {
	section := func(key, title, kind string, sources map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"id": "sec-" + key, "key": key, "position": 0, "title": title, "kind": kind, "covers": title + "的内容。",
			"length": 300, "extra": map[string]interface{}{}, "sources": sources}
	}
	empty := map[string]interface{}{"docs": []interface{}{}, "code": []interface{}{}, "contracts": []interface{}{}, "sessions": nil}
	withCode := map[string]interface{}{"docs": []interface{}{map[string]interface{}{"path": "docs/architecture.md", "section": "Execution model"}},
		"code": []interface{}{map[string]interface{}{"path": "src/app/main.go", "symbols": []interface{}{"Server"}}}, "contracts": []interface{}{},
		"sessions": nil}
	doc := func(category, slug, title string, protected bool, sections ...map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"id": "doc-" + slug, "position": 0, "category": category, "slug": slug, "title": title,
			"question": title + "是什么？", "audience": []interface{}{"开发者：读完能改它"}, "scopeIn": []interface{}{title},
			"scopeOut": []interface{}{}, "length": map[string]interface{}{"min": 500, "max": 900}, "protected": protected,
			"extra": map[string]interface{}{}, "sections": sections}
	}
	return map[string]interface{}{
		"id": "plan-1", "spaceId": "space-1", "version": 1, "status": "confirmed", "origin": "maintenance", "baseVersion": nil,
		"target": map[string]interface{}{"min": 3, "max": 3},
		"categories": []interface{}{
			map[string]interface{}{"key": "product", "title": "产品", "question": "这个服务是什么", "forAgents": false, "extra": map[string]interface{}{}},
			map[string]interface{}{"key": "dev", "title": "开发约定", "question": "给 agent 的约定", "forAgents": true, "extra": map[string]interface{}{}},
		},
		"newFields": []interface{}{},
		"docs": []interface{}{
			doc("product", "service-overview", "服务概览", true,
				section("s1", "总览", "overview", empty), section("s2", "组件", "concepts", withCode), section("s3", "已知的坑", "pitfalls", empty)),
			doc("product", "storage", "存储", false,
				section("s1", "保存流程", "flow", empty), section("s2", "保存约定", "conventions", empty), section("s3", "决策与理由", "decisions", empty)),
			doc("dev", "testing", "测试约定", false, section("s1", "怎么跑测试", "conventions", empty)),
		},
	}
}

func TestWikiPlanRevisionKeepsProtectedDocumentsMovesOnlyConventionsAndHoldsTheCount(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	door.state["confirmed"] = planBase()
	job := door.job["job"].(map[string]interface{})
	job["kind"], job["trigger"], job["instructions"] = "revise", "owner", "把存储的约定移到开发约定里，篇数不变。"
	model := &planModel{
		revise: func(round int, prompt string) string {
			if round == 1 {
				// Four documents for a target of three; a section moved out of the protected document, and a
				// decisions section moved into the agents' category.
				return "## 1. 产品 `product` —— 这个服务是什么\n" +
					"- 1.1 服务概览 `service-overview`｜是什么｜来源：1.1｜含：定位\n" +
					"- 1.2 存储 `storage`｜怎么存｜来源：1.2｜含：保存\n" +
					"- 1.3 存储决策 `storage-decisions`｜为什么这么存｜来源：无｜含：决策\n" +
					"## 2. 开发约定 `dev` —— 给 agent 的约定 [agents]\n" +
					"- 2.1 测试约定 `testing`｜怎么跑测试｜来源：2.1｜含：go test\n" +
					"### 移到给 agent 的大类的节\n- 1.1 §3 → 2.1\n- 1.2 §3 → 2.1\n"
			}
			return "## 1. 产品 `product` —— 这个服务是什么\n" +
				"- 1.1 服务概览 `service-overview`｜是什么｜来源：1.1｜含：定位\n" +
				"- 1.2 存储 `storage`｜怎么存｜来源：1.2｜含：保存\n" +
				"## 2. 开发约定 `dev` —— 给 agent 的约定 [agents]\n" +
				"- 2.1 测试约定 `testing`｜怎么跑测试与保存前的校验｜来源：2.1｜含：go test；保存前校验\n" +
				"### 移到给 agent 的大类的节\n- 1.2 §2 → 2.1\n"
		},
		rewrite: func(title string) string {
			return "标题：" + title + "\n问题：怎么跑测试？\n读者：写代码的 agent：读完知道怎么跑测试\n含：go test；保存前校验\n篇幅：400–600 字\n" +
				"### 1. 怎么跑测试 | conventions | 300\n讲什么：用 go test 跑。\n- 代码：src/web/client.ts: render()\n" +
				"### 2. 保存约定 | conventions | 200\n讲什么：保存前先校验，见 1.2。\n"
		},
	}
	vllm := newFakeVLLM(t, model.answer)
	planSession(t, door.URL, vllm)
	fakeVerifyClaude(t)

	summary, printed, err := runPlanCLI(t, t.TempDir(), "revise")
	if err != nil {
		t.Fatalf("orbit wiki plan revise: %v\n%s", err, printed)
	}
	first := summary.Report.Attempts[0]
	if first.Server != 0 || first.Checks["docCount"] != 1 || first.Checks["protected"] != 2 {
		t.Errorf("the first round: %+v", first)
	}
	catalogues := model.asked("按 owner 的要求修订 plan 的目录")
	if len(catalogues) != 2 {
		t.Fatalf("the catalogue was asked for %d times, want twice", len(catalogues))
	}
	if !strings.Contains(catalogues[0], "把存储的约定移到开发约定里") || !strings.Contains(catalogues[0], "服务概览 `service-overview`［受保护］") ||
		!strings.Contains(catalogues[0], "§2 保存约定（conventions）") {
		t.Errorf("the revision was not asked from the version, its protection and the owner's words:\n%s", catalogues[0])
	}
	for _, want := range []string{
		"the plan has 4 documents; it must have 3 to 3",
		"moves §3 out of 1.1 «服务概览», which is protected",
		"moves §3 «决策与理由» of 1.2, a decisions section: only a conventions section moves",
	} {
		if !strings.Contains(catalogues[1], want) {
			t.Errorf("the second catalogue prompt does not say %q:\n%s", want, catalogues[1])
		}
	}
	if n := len(door.of(http.MethodPost, "plan/drafts")); n != 1 {
		t.Fatalf("the server was sent %d drafts, want the second round's alone", n)
	}
	sent := draftSent(t, door, 1)
	if sent.BaseVersion == nil || *sent.BaseVersion != 1 || len(sent.Plan.Docs) != 3 {
		t.Fatalf("the draft: base %v, %d documents", sent.BaseVersion, len(sent.Plan.Docs))
	}
	// The protected document is carried exactly as it was: its fields, its sections and their keys.
	var read wikiPlanDocRead
	raw, _ := json.Marshal(planBase()["docs"].([]interface{})[0])
	_ = json.Unmarshal(raw, &read)
	if want := wikiPlanDocInput(read); !reflect.DeepEqual(sent.Plan.Docs[0], want) {
		t.Errorf("the protected document changed:\n got %+v\nwant %+v", sent.Plan.Docs[0], want)
	}
	// The document the convention moved out of keeps the rest of its outline; the one it moved into has it.
	var titles []string
	for _, s := range sent.Plan.Docs[1].Sections {
		titles = append(titles, s.Title)
	}
	if !reflect.DeepEqual(titles, []string{"保存流程", "决策与理由"}) || sent.Plan.Docs[1].Sections[0].Key != "s1" {
		t.Errorf("the document a section moved out of: %v", titles)
	}
	testing := sent.Plan.Docs[2]
	if len(testing.Sections) != 2 || testing.Sections[1].Title != "保存约定" || !strings.Contains(testing.Sections[1].Covers, "见 1.2") {
		t.Errorf("the document the convention moved into: %+v", testing.Sections)
	}
	rewrites := model.asked("# 任务：写新草稿里《")
	if len(rewrites) == 0 || !strings.Contains(rewrites[len(rewrites)-1], "【现在的 1.2 第 2 节（移入本篇）】") {
		t.Errorf("the rewrite was not handed the moved section")
	}
}

func TestWikiPlanDraftKeepsTheProtectedDocumentsOfTheVersionItRevises(t *testing.T) {
	r := &wikiPlanRun{target: wikiPlanLength{Min: 1, Max: 5}, repo: &wikiPlanRepo{sha: "abc", fileSet: map[string]bool{}, dirs: map[string]bool{}}}
	raw, _ := json.Marshal(planBase())
	var base wikiPlanVersionRead
	if err := json.Unmarshal(raw, &base); err != nil {
		t.Fatal(err)
	}
	r.base, r.baseIDs, r.baseDocs = &base, map[string]string{}, map[string]wikiPlanDocRead{}
	for i, doc := range base.Docs {
		r.baseIDs[fmt.Sprintf("1.%d", i+1)] = doc.Slug
		r.baseDocs[doc.Slug] = doc
	}
	// A catalogue that leaves the protected document out.
	catalogue := parseWikiPlanCatalogue("## 1. 产品 `product` —— 是什么\n- 1.1 存储 `storage`｜怎么存｜含：保存\n" +
		"## 2. 开发约定 `dev` —— 约定 [agents]\n- 2.1 测试约定 `testing`｜怎么测｜含：go test\n")
	r.adoptCatalogue(catalogue, false)
	assembled := r.assemble()
	found := false
	for _, e := range assembled.errors {
		if e.Check == "protected" && e.Path == "plan.docs" && strings.Contains(e.Message, "(`service-overview`) is protected") {
			found = true
		}
		if e.Check == "protected" && !wikiPlanCatalogueLevel(e.Path) {
			t.Errorf("a protected document's error is not the catalogue's to fix: %+v", e)
		}
	}
	if !found {
		t.Errorf("a catalogue without the protected document passed: %+v", assembled.errors)
	}
	// Named again, it is carried as it was, whatever the model would have written of it.
	catalogue = parseWikiPlanCatalogue("## 1. 产品 `product` —— 是什么\n- 1.1 另一个标题 `service-overview`｜别的问题｜含：别的\n- 1.2 存储 `storage`｜怎么存｜含：保存\n" +
		"## 2. 开发约定 `dev` —— 约定 [agents]\n- 2.1 测试约定 `testing`｜怎么测｜含：go test\n")
	r.adoptCatalogue(catalogue, false)
	assembled = r.assemble()
	if want := wikiPlanDocInput(base.Docs[0]); !reflect.DeepEqual(assembled.plan.Docs[0], want) {
		t.Errorf("the protected document was not carried as it was: %+v", assembled.plan.Docs[0])
	}
	for _, e := range assembled.errors {
		if e.Check == "protected" {
			t.Errorf("a carried protected document was refused: %+v", e)
		}
	}
	// The count, against its target.
	r.target = wikiPlanLength{Min: 20, Max: 35}
	assembled = r.assemble()
	counted := false
	for _, e := range assembled.errors {
		counted = counted || (e.Check == "docCount" && e.Path == "plan.docs" && strings.Contains(e.Message, "the plan has 3 documents; it must have 20 to 35"))
	}
	if !counted {
		t.Errorf("a draft of 3 documents passed a target of 20–35: %+v", assembled.errors)
	}
}

// ── The endpoint ────────────────────────────────────────────────────────────────────────────────

func TestWikiPlanStopsAtTheFirst401(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	vllm := newFakeVLLM(t, func(prompt string) (int, string) { return http.StatusUnauthorized, "" })
	planSession(t, door.URL, vllm)
	fakeVerifyClaude(t)

	_, _, err := runPlanCLI(t, t.TempDir(), "draft", "--target", "3-3")
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("a 401 did not end the run: %v", err)
	}
	if n := len(vllm.Requests()); n != 1 {
		t.Errorf("the endpoint was asked %d times after it refused the token, want once", n)
	}
	end := planFinish(t, door)
	if end["outcome"] != "failed" || !strings.Contains(fmt.Sprint(end["error"]), "401") {
		t.Errorf("the job's end: %v", end)
	}
	if n := len(door.of(http.MethodPost, "plan/drafts")); n != 0 {
		t.Errorf("a draft was sent after a 401")
	}
}

func TestWikiPlanWaitsForTheEndpointsHealth(t *testing.T) {
	var mu sync.Mutex
	asked := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked++
		n := asked
		mu.Unlock()
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	wait, poll := wikiPlanHealthWait, wikiPlanHealthPoll
	wikiPlanHealthWait, wikiPlanHealthPoll = 5*time.Second, 10*time.Millisecond
	defer func() { wikiPlanHealthWait, wikiPlanHealthPoll = wait, poll }()
	var progress strings.Builder
	if err := wikiPlanWaitForEndpoint(srv.URL, &progress); err != nil {
		t.Fatalf("the endpoint came up and the wait gave up: %v", err)
	}
	if asked != 3 || !strings.Contains(progress.String(), "waiting for it") {
		t.Errorf("asked %d times; said %q", asked, progress.String())
	}
	wikiPlanHealthWait = 30 * time.Millisecond
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer down.Close()
	if err := wikiPlanWaitForEndpoint(down.URL, io.Discard); err == nil || !strings.Contains(err.Error(), "did not answer /health") {
		t.Errorf("an endpoint that never came up: %v", err)
	}
}

// ── The line format ─────────────────────────────────────────────────────────────────────────────

func TestWikiPlanReadsTheCompactLineFormat(t *testing.T) {
	catalogue := parseWikiPlanCatalogue("前言不算\n## 1. 产品 `product` —— 是什么\n- 1.1 概览 `overview`｜是什么｜来源：1.1、1.3｜含：定位；组件\n" +
		"## 3. 开发约定 `dev` —— 约定 [agents]\n- 3.4 测试 `testing`｜怎么测｜来源：无｜含：go test\n### 移到给 agent 的大类的节\n- 1.2 §4 → 3.4\n- 无\n")
	if catalogue == nil || len(catalogue.Cats) != 2 || len(catalogue.Units) != 2 {
		t.Fatalf("the catalogue: %+v", catalogue)
	}
	if !catalogue.Cats[1].ForAgents || catalogue.Cats[1].Key != "dev" || catalogue.Cats[1].Question != "约定" || catalogue.Cats[0].ForAgents {
		t.Errorf("the categories: %+v", catalogue.Cats)
	}
	overview := catalogue.Units[0]
	if overview.Slug != "overview" || !reflect.DeepEqual(overview.Sources, []string{"1.1", "1.3"}) || !reflect.DeepEqual(overview.CardScope, []string{"定位", "组件"}) {
		t.Errorf("a card: %+v", overview)
	}
	if len(catalogue.Moves) != 1 || catalogue.Moves[0].From != "1.2" || catalogue.Moves[0].Section != 4 || catalogue.Moves[0].Target != catalogue.Units[1] {
		t.Errorf("the moves: %+v", catalogue.Moves)
	}
	if !reflect.DeepEqual(catalogue.Stray, []string{"前言不算"}) {
		t.Errorf("stray: %v", catalogue.Stray)
	}
	header, sections, stray := parseWikiPlanDocBody("### 1.2 存储\n读者：甲：读完能改；乙：读完能查\n含：一；二\n不含：三（见 2.1）\n篇幅：1,200–2,000 字\n备注：多余\n" +
		"### 1. 保存 | Flow | 约 500 字\n讲什么：先存，\n再返回。\n- 文档：docs/a.md § 3. 章节、§ 4. 另一章\n- 代码：src/dir/（a.go、b.go）: A, B.c\n" +
		"- 会话：项目「甲」「乙」；时间 2026-09-01 至 今；关键词 x、y；锚点 src/；kind pitfall/decision；主题 t1；要找：原话；其余\n- 附注：不在格式里\n")
	if !reflect.DeepEqual(header.Audience, []string{"甲：读完能改", "乙：读完能查"}) || !reflect.DeepEqual(header.ScopeOut, []string{"三（见 2.1）"}) ||
		header.Length != "1,200–2,000 字" || !reflect.DeepEqual(stray, []string{"备注：多余"}) {
		t.Errorf("the header: %+v, stray %v", header, stray)
	}
	if min, max, ok := wikiPlanRange(header.Length); !ok || min != 1200 || max != 2000 {
		t.Errorf("the length: %d–%d", min, max)
	}
	if len(sections) != 1 {
		t.Fatalf("sections: %+v", sections)
	}
	s := sections[0]
	if s.Kind != "flow" || s.Covers != "先存， 再返回。" || len(s.Docs) != 2 || *s.Docs[1].Section != "4. 另一章" ||
		!reflect.DeepEqual(s.Code, []wikiPlanCodeSource{{Path: "src/dir/a.go", Symbols: []string{"A", "B.c"}}, {Path: "src/dir/b.go", Symbols: []string{"A", "B.c"}}}) {
		t.Errorf("a section: %+v", s)
	}
	c := s.Sessions
	if c == nil || !reflect.DeepEqual(c.Projects, []string{"甲", "乙"}) || c.Since != "2026-09-01" || c.Until != "" ||
		!reflect.DeepEqual(c.EntryKinds, []string{"pitfall", "decision"}) || c.Evidence != "原话；其余" || !reflect.DeepEqual(s.Stray, []string{"附注：不在格式里"}) {
		t.Errorf("a session condition: %+v, stray %v", c, s.Stray)
	}

	// As the real model wrote them: a heading that ends in its own parenthesis, one it wrapped in them, the
	// whole of a document, two files' symbols on one line, and a project whose title has 「」 in it.
	_, sections, _ = parseWikiPlanDocBody("### 1.1 概览\n读者：甲：读完能改\n" +
		"### 1. 模型 | concepts | 300\n讲什么：数据模型。\n- 文档：docs/a.md § 4. 数据模型（新表 `share_link`）、§ （5. 接口）\n- 文档：docs/b.md § 正文\n" +
		"- 代码：src/a.ts: x; src/b.ts: y, z；w\n- 会话：项目「把「什么算完成」从项目末尾搬到开工前」「甲」；要找：原话\n")
	if len(sections) != 1 {
		t.Fatalf("sections: %+v", sections)
	}
	s = sections[0]
	if len(s.Docs) != 3 || s.Docs[0].Section == nil || *s.Docs[0].Section != "4. 数据模型（新表 `share_link`）" ||
		s.Docs[1].Section == nil || *s.Docs[1].Section != "5. 接口" || s.Docs[2].Path != "docs/b.md" || s.Docs[2].Section != nil {
		t.Errorf("the documents' sections: %+v", s.Docs)
	}
	if !reflect.DeepEqual(s.Code, []wikiPlanCodeSource{{Path: "src/a.ts", Symbols: []string{"x"}}, {Path: "src/b.ts", Symbols: []string{"y", "z", "w"}}}) {
		t.Errorf("the code: %+v", s.Code)
	}
	if s.Sessions == nil || !reflect.DeepEqual(s.Sessions.Projects, []string{"把「什么算完成」从项目末尾搬到开工前", "甲"}) {
		t.Errorf("the projects: %+v", s.Sessions)
	}
	for in, want := range map[string]string{"（4. 写路径）": "4. 写路径", "写路径）": "写路径", "（写路径": "写路径", "（a）（b）": "（a）（b）", "Data model (Prisma)": "Data model (Prisma)"} {
		if got := wikiPlanUnwrap(in); got != want {
			t.Errorf("wikiPlanUnwrap(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

func TestWikiPlanIsTheContractsCommand(t *testing.T) {
	contract := wikiContract(t)
	jobs := contract["plan"].(map[string]interface{})["jobs"].(map[string]interface{})
	cli := jobs["cli"].(map[string]interface{})
	specs := map[string]cliCapabilitySpec{}
	for _, spec := range wikiPlanCLICapabilities {
		specs[spec.Tool] = spec
	}
	for tool, key := range map[string]string{"wiki_plan_draft": "draft", "wiki_plan_revise": "revise", "wiki_plan_check": "check"} {
		spec, ok := specs[tool]
		if !ok || spec.Usage != cli[key] {
			t.Errorf("%s's usage is %q, the contract's %q", tool, spec.Usage, cli[key])
		}
	}
	for want, got := range map[interface{}]string{
		cli["draftPrecondition"]:  wikiPlanDraftPrecondition,
		cli["revisePrecondition"]: wikiPlanRevisePrecondition,
		cli["checkPrecondition"]:  wikiPlanCheckPrecondition,
	} {
		if want != got {
			t.Errorf("a precondition is %q, the contract's %q", got, want)
		}
	}
	for tool, precondition := range map[string]string{"wiki_plan_draft": wikiPlanDraftPrecondition, "wiki_plan_revise": wikiPlanRevisePrecondition, "wiki_plan_check": wikiPlanCheckPrecondition} {
		if !strings.HasPrefix(specs[tool].Description, precondition) {
			t.Errorf("%s's description does not lead with its precondition", tool)
		}
	}
	if !specs["wiki_plan_draft"].SessionOnly || !specs["wiki_plan_revise"].SessionOnly || specs["wiki_plan_check"].SessionOnly {
		t.Errorf("draft and revise are a session's, check a headless command's")
	}
	// The numbers and routes this side runs by are the contract's.
	rules := jobs["rules"].(map[string]interface{})
	if rules["attemptsMax"] != float64(wikiPlanAttemptsMax) || rules["draftMaxBytes"] != float64(wikiPlanDraftMaxBytes) {
		t.Errorf("the rules: %v", rules)
	}
	if contract["plan"].(map[string]interface{})["rules"].(map[string]interface{})["errorsMax"] != float64(wikiPlanErrorsMax) {
		t.Errorf("errorsMax is not the contract's")
	}
	routes := jobs["routes"].(map[string]interface{})
	for name, suffix := range map[string]string{"context": "/plan/job", "progress": "/plan/job/progress", "finish": "/plan/job/finish", "check": "/plan/check", "materials": "/plan/materials"} {
		if route, _ := routes[name].(string); !strings.HasSuffix(route, suffix) || !strings.Contains(route, "/api/runner/wiki/spaces/:id/") {
			t.Errorf("the route %s is %q, and this build calls …%s", name, route, suffix)
		}
	}
	found := false
	for _, raw := range contract["refusals"].([]interface{}) {
		refusal := raw.(map[string]interface{})
		if refusal["code"] == wikiPlanNoJobCode {
			found = refusal["httpStatus"] == float64(http.StatusConflict)
		}
	}
	if !found {
		t.Errorf("%s is not the contract's 409", wikiPlanNoJobCode)
	}
	if !reflect.DeepEqual(keysOfMap(jobs["kinds"]), []string{"build", "draft", "revise"}) {
		t.Errorf("the kinds: %v", keysOfMap(jobs["kinds"]))
	}
	// The three family tables: capabilities, the help, and the pre-approval every advertised verb needs.
	t.Setenv(envWiki, "on")
	rules2 := strings.Join(orbitCLIAllowedTools("/usr/local/bin/orbit", false), "\n")
	for _, spec := range wikiPlanCLICapabilities {
		verb := strings.Join(spec.Argv[2:], " ")
		if !strings.Contains(rules2, "Bash(/usr/local/bin/orbit wiki "+verb+" *)") {
			t.Errorf("orbit wiki %s is pre-approved for nobody", verb)
		}
		for _, argument := range spec.Arguments {
			for _, flag := range regexp.MustCompile(`--[a-z][a-z-]*`).FindAllString(argument, -1) {
				if !strings.Contains(wikiActionHelp["plan"], flag) {
					t.Errorf("`orbit wiki plan --help` does not document %s", flag)
				}
				if !planFlagIsParsed(spec.Argv[3], strings.TrimPrefix(flag, "--")) {
					t.Errorf("capabilities advertise %s for `orbit wiki %s`, which its parser does not take", flag, verb)
				}
			}
		}
	}
}

func keysOfMap(raw interface{}) []string {
	var out []string
	for key := range raw.(map[string]interface{}) {
		out = append(out, key)
	}
	sortStrings(out)
	return out
}

// planFlagIsParsed registers a plan verb's flags the way the command does and reports whether name is one.
func planFlagIsParsed(verb, name string) bool {
	known := map[string][]string{
		"draft":  {"space", "target", "model", "concurrency", "work-dir", "json"},
		"revise": {"space", "instructions", "target", "model", "concurrency", "work-dir", "json"},
		"check":  {"space", "job", "json"},
	}
	for _, flag := range known[verb] {
		if flag == name {
			return true
		}
	}
	return false
}

func TestWikiPlanCheckExitsNonZeroUnlessTheJobStoredADraft(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	ok := true
	door.check = func(job string) (int, string) {
		if job != "job-1" {
			return http.StatusNotFound, `{"message":"no such plan job"}`
		}
		if ok {
			return http.StatusOK, `{"spaceId":"space-1","jobId":"job-1","kind":"draft","outcome":"succeeded","version":2,"ok":true,"problems":[]}`
		}
		return http.StatusOK, `{"spaceId":"space-1","jobId":"job-1","kind":"draft","outcome":"failed","version":null,"ok":false,` +
			`"problems":["The run ended failed (the gate's last round found 3 errors)."]}`
	}
	planSession(t, door.URL, nil)
	t.Setenv("ORBIT_SESSION_ID", "")
	var out strings.Builder
	if err := cmdWikiCLI([]string{"plan", "check", "--space", "space-1", "--job", "job-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("a job that stored a draft failed its check: %v", err)
	}
	if !strings.Contains(out.String(), "stored version 2") {
		t.Errorf("printed %q", out.String())
	}
	ok = false
	out.Reset()
	err := cmdWikiCLI([]string{"plan", "check", "--space", "space-1", "--job", "job-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(out.String(), "the gate's last round found 3 errors") {
		t.Errorf("a failed job passed its check, or said nothing of why: %v %q", err, out.String())
	}
	if err := cmdWikiCLI([]string{"plan", "check", "--space", "space-1", "--job", "job-2"}, strings.NewReader(""), &out); err == nil || !strings.Contains(err.Error(), "no such plan job") {
		t.Errorf("an unknown job: %v", err)
	}
	for _, request := range door.of(http.MethodGet, "plan/check") {
		if request.session != "" {
			t.Errorf("the check named a session: %q", request.session)
		}
	}
	if err := cmdWikiCLI([]string{"plan", "check", "--space", "space-1"}, strings.NewReader(""), &out); err == nil || !strings.Contains(err.Error(), "--job is required") {
		t.Errorf("a check with no job: %v", err)
	}
	if err := cmdWikiCLI([]string{"plan", "publish"}, strings.NewReader(""), &out); err == nil || !strings.Contains(err.Error(), "draft, revise and check") {
		t.Errorf("an unknown plan command: %v", err)
	}
}

func TestWikiPlanRunsOnlyAsItsJob(t *testing.T) {
	f := newPlanFixture(t)
	door := newFakePlanDoor(t, f)
	job := door.job["job"].(map[string]interface{})
	job["state"] = "failed"
	vllm := newFakeVLLM(t, func(prompt string) (int, string) { return http.StatusOK, "" })
	planSession(t, door.URL, vllm)
	fakeVerifyClaude(t)
	_, _, err := runPlanCLI(t, t.TempDir(), "draft")
	if err == nil || !strings.Contains(err.Error(), "is failed, not running") {
		t.Errorf("a job that ended ran again: %v", err)
	}
	if len(vllm.Requests()) != 0 || len(door.of(http.MethodPost, "plan/job/finish")) != 0 {
		t.Errorf("an ended job asked the model or ended again")
	}
	// A revision needs the owner's words: from --instructions, or the job's.
	job["state"], job["kind"] = "running", "revise"
	door.state["confirmed"] = planBase()
	_, _, err = runPlanCLI(t, t.TempDir(), "revise")
	if err == nil || !strings.Contains(err.Error(), "needs the owner's instructions") {
		t.Errorf("a revision with no instructions: %v", err)
	}
	if end := planFinish(t, door); end["outcome"] != "failed" {
		t.Errorf("the job's end: %v", end)
	}
}
