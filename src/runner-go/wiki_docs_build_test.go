package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// `orbit wiki docs build` against a fake vLLM endpoint, a fake runner door and a real git repository
// (contract `docs.build`, criterion 9). The fake model endpoint and the fake Claude Code are the ones of
// wiki_verify_test.go; the door is this file's own — the plan, what is written, a section's material,
// the document as written, and the writes, each recorded; the repository is a bare origin and a clone of
// it, so the command's fetch is a real one.

// docsBuildDoor is the runner door's plan and documents routes for space-1.
type docsBuildDoor struct {
	URL      string
	mu       sync.Mutex
	plan     map[string]interface{}
	planCode int
	planBody string
	state    map[string]interface{}
	material map[string]map[string]interface{}
	view     map[string]interface{}
	calls    []string
	sessions []string
	writes   []wikiDocWriteRequest
	raw      []string
}

func newDocsBuildDoor(t *testing.T) *docsBuildDoor {
	t.Helper()
	door := &docsBuildDoor{
		plan:     docsBuildPlan(),
		state:    map[string]interface{}{"spaceId": "space-1", "planVersion": 3, "docs": []interface{}{}},
		material: map[string]map[string]interface{}{"s3": docsBuildMaterial()},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		door.mu.Lock()
		defer door.mu.Unlock()
		call := r.Method + " " + r.URL.Path
		if r.URL.RawQuery != "" {
			call += "?" + r.URL.RawQuery
		}
		door.calls = append(door.calls, call)
		door.sessions = append(door.sessions, r.Header.Get("X-Orbit-Session-Id"))
		w.Header().Set("content-type", "application/json")
		const prefix = "/api/runner/wiki/spaces/space-1/"
		path := strings.TrimPrefix(r.URL.Path, prefix)
		reply := func(status int, value interface{}) {
			out, _ := json.Marshal(value)
			w.WriteHeader(status)
			_, _ = w.Write(out)
		}
		switch {
		case r.Method == http.MethodGet && path == "plan":
			if door.planCode != 0 {
				w.WriteHeader(door.planCode)
				_, _ = w.Write([]byte(door.planBody))
				return
			}
			reply(http.StatusOK, door.plan)
		case r.Method == http.MethodGet && path == "docs":
			reply(http.StatusOK, door.state)
		case r.Method == http.MethodGet && path == "docs/session-runtime/material":
			material, ok := door.material[r.URL.Query().Get("section")]
			if !ok {
				reply(http.StatusNotFound, map[string]string{"message": "no such section"})
				return
			}
			reply(http.StatusOK, material)
		case r.Method == http.MethodGet && path == "docs/session-runtime":
			if door.view == nil {
				reply(http.StatusNotFound, map[string]string{"message": "no such document"})
				return
			}
			reply(http.StatusOK, door.view)
		case r.Method == http.MethodPost && path == "docs/session-runtime":
			var body wikiDocWriteRequest
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("a write that is not JSON: %s", raw)
			}
			// The server's schema: a section's footnotes are a list, empty or not, and never null.
			var shape struct {
				Sections []map[string]json.RawMessage `json:"sections"`
			}
			_ = json.Unmarshal(raw, &shape)
			for i, section := range shape.Sections {
				if footnotes := strings.TrimSpace(string(section["footnotes"])); !strings.HasPrefix(footnotes, "[") {
					reply(http.StatusUnprocessableEntity, map[string]interface{}{"code": "WIKI_DOC_INVALID", "message": "the write does not have the shape",
						"errors": []interface{}{map[string]string{"path": fmt.Sprintf("sections[%d].footnotes", i), "message": "must be a list of at most 200 footnotes"}}})
					return
				}
			}
			door.raw = append(door.raw, string(raw))
			door.writes = append(door.writes, body)
			sections := []map[string]interface{}{}
			for _, section := range body.Sections {
				sections = append(sections, map[string]interface{}{"key": section.Key, "outcome": "written", "stats": map[string]int{"sentences": 3, "footnotes": len(section.Footnotes)}})
			}
			reply(http.StatusOK, map[string]interface{}{
				"spaceId": "space-1", "slug": "session-runtime", "docId": "doc-1", "planVersion": 3, "status": "ok",
				"sections": sections, "counts": map[string]int{"sentences": 9, "sourced": 8, "transition": 1},
			})
		default:
			reply(http.StatusNotFound, map[string]string{"message": "Cannot " + r.Method + " " + r.URL.Path})
		}
	}))
	t.Cleanup(srv.Close)
	door.URL = srv.URL
	return door
}

func (d *docsBuildDoor) Calls() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.calls...)
}

func (d *docsBuildDoor) Writes() []wikiDocWriteRequest {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]wikiDocWriteRequest{}, d.writes...)
}

// written is the section of that key as the writes carried it, the last time.
func (d *docsBuildDoor) written(t *testing.T, key string) wikiDocSection {
	t.Helper()
	writes := d.Writes()
	for i := len(writes) - 1; i >= 0; i-- {
		for _, section := range writes[i].Sections {
			if section.Key == key {
				return section
			}
		}
	}
	t.Fatalf("section %s was never written; writes: %+v", key, writes)
	return wikiDocSection{}
}

// docsBuildPlan is one confirmed document: an overview, a mechanism with a design document, code and a
// contract, and conventions with a session condition.
func docsBuildPlan() map[string]interface{} {
	section := func(key, title, kind string, sources map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"id": "sec-" + key, "key": key, "position": 0, "title": title, "kind": kind,
			"covers": title + "讲什么。", "length": 400, "sources": sources, "extra": map[string]interface{}{}}
	}
	return map[string]interface{}{
		"spaceId": "space-1",
		"confirmed": map[string]interface{}{
			"version": 3,
			"docs": []interface{}{map[string]interface{}{
				"slug": "session-runtime", "title": "会话运行模型", "question": "一个会话怎么运转？", "audience": []string{"新加入的开发者：读完能讲清一轮怎么投递"},
				"sections": []interface{}{
					section("s1", "总览", "overview", map[string]interface{}{"docs": []interface{}{}, "code": []interface{}{}, "contracts": []interface{}{}, "sessions": nil}),
					section("s2", "turn 怎么投递", "flow", map[string]interface{}{
						"docs":      []interface{}{map[string]interface{}{"path": "docs/design.md", "section": "2. Delivery"}},
						"code":      []interface{}{map[string]interface{}{"path": "src/runloop.go", "symbols": []string{"runLoop"}}},
						"contracts": []interface{}{map[string]interface{}{"path": "contracts/session.contract.json"}},
						"sessions":  nil,
					}),
					section("s3", "约定", "conventions", map[string]interface{}{
						"docs": []interface{}{}, "code": []interface{}{}, "contracts": []interface{}{},
						"sessions": map[string]interface{}{
							"projects": []interface{}{map[string]interface{}{"id": "01a0e39d-4375-7280-8aad-5200529cdec3", "title": "Runner 托管后台作业"}},
							"since":    "2026-09-01", "until": nil, "keywords": []string{"runner 宿主"}, "anchorPaths": []string{"src/"},
							"entryKinds": []string{"convention"}, "topics": []string{}, "evidence": "owner 说测试在哪跑",
						},
					}),
				},
			}},
		},
		"draft": nil, "proposals": []interface{}{},
	}
}

// The records the server hands out for s3: the owner's words, the settlement card's template (from the
// owner's client, so they read as the owner's), a delivery comment and the same comment again, a command's
// output found through an entry, and a record the merge will drop.
const (
	docsOwnerWords   = "全量测试在 runner 宿主上跑，别在引擎的 Bash 里跑。"
	docsTemplateTurn = "About “Runner 托管后台作业” — Orbit has not recorded it done. Every criterion is met.\n\nBlocked:\n(no criterion is individually blocked)"
	docsDelivery     = "交付：在 runner 宿主上跑完整包，env -u 清掉会话变量后 0 FAIL。"
	docsOutput       = "$ go test ./...\nok  orbit 412.7s\nthe suite ran on the runner host: 0 FAIL"
	docsOffTopic     = "今天午饭吃了面。"
)

func docsBuildRecord(kind, ref, weight string, owner bool, text string, via map[string]interface{}) map[string]interface{} {
	length := utf8.RuneCountInString(text)
	return map[string]interface{}{
		"kind": kind, "ref": ref, "found": map[bool]string{true: "entry", false: "search"}[via != nil], "via": via,
		"weight": weight, "ownerWords": owner, "label": "message", "at": "2026-09-20T10:00:00.000Z",
		"sessionId": "sess-1", "sessionTitle": "协调会话", "taskId": nil, "taskTitle": nil, "projectId": nil, "projectTitle": "Runner 托管后台作业",
		"notePath": nil, "text": text, "chars": map[string]int{"start": 0, "end": length}, "length": length,
	}
}

func docsBuildMaterial() map[string]interface{} {
	via := map[string]interface{}{"entryId": "entry-1", "title": "全量测试在宿主上跑", "kind": "convention", "quote": "the suite ran on the runner host"}
	return map[string]interface{}{
		"spaceId": "space-1", "slug": "session-runtime", "section": "s3", "planVersion": 3, "condition": nil,
		"entries": []interface{}{map[string]interface{}{"id": "entry-1", "kind": "convention", "title": "全量测试在宿主上跑", "summary": "…", "score": 5, "recordedAt": "2026-09-20T00:00:00.000Z"}},
		"records": []interface{}{
			docsBuildRecord("turn", "turn-owner", "decision", true, docsOwnerWords, nil),
			docsBuildRecord("turn", "turn-template", "decision", true, docsTemplateTurn, nil),
			docsBuildRecord("task_comment", "comment-1", "merge", false, docsDelivery, nil),
			docsBuildRecord("task_comment", "comment-2", "merge", false, docsDelivery, nil),
			docsBuildRecord("tool_call", "call-1", "output", false, docsOutput, via),
			docsBuildRecord("turn", "turn-lunch", "decision", true, docsOffTopic, nil),
		},
		"unresolved": []interface{}{},
	}
}

// The repository: a design document, code and a contract.
const (
	docsDesign = "# Design\n\n## 1. Transport\n\nThe runner polls the server over outbound HTTP; no inbound port is needed.\n\n" +
		"## 2. Delivery\n\nA turn is stored before it is delivered, and delivered at least once.\nDelivery is idempotent on the turn's id.\n\n" +
		"### 2.1 Retries\n\nA lost delivery is retried after the lease expires.\n\n## 3. Recovery\n\nSeq stays monotonic across respawn.\n"
	docsRunloop = "package main\n\n// runLoop claims work from the server and keeps the heartbeat going.\n// It never opens an inbound port.\n" +
		"func runLoop() {\n\tfor {\n\t\tclaim()\n\t}\n}\n\n// claim asks the server for the next session.\nfunc claim() {}\n"
	docsContract = "{\n  \"name\": \"session\",\n  \"delivery\": \"at least once, idempotent on the turn id\"\n}\n"
)

func newDocsBuildRepo(t *testing.T) *wikiAnchorsFixture {
	t.Helper()
	f := newWikiAnchorsFixture(t)
	f.push(t, "the documented code", func() {
		f.write(t, "docs/design.md", docsDesign)
		f.write(t, "src/runloop.go", docsRunloop)
		f.write(t, "contracts/session.contract.json", docsContract)
	})
	// The checkout fetches nothing by itself: the command's own fetch has to bring these commits in.
	return f
}

// docsModel is the fake model's side of a run: what each prompt is answered with. Each answer names the
// section by its title, as the prompt gives it.
type docsModel struct {
	mu      sync.Mutex
	prompts []string
	// write answers per section title; a second one, when present, answers a prompt that says what the
	// first draft got wrong. repair answers a quote asked for again, by the id asked about.
	write  map[string][]string
	repair map[string]string
	status int
}

func (m *docsModel) answer(prompt string) (int, string) {
	m.mu.Lock()
	m.prompts = append(m.prompts, prompt)
	m.mu.Unlock()
	if m.status != 0 {
		return m.status, ""
	}
	title := ""
	if match := regexp.MustCompile(`「([^」]+)」（`).FindStringSubmatch(prompt); match != nil {
		title = match[1]
	}
	switch {
	case strings.Contains(prompt, "做「归并」"):
		var lines []string
		for _, id := range regexp.MustCompile(`(?m)^\[([A-Z]\d+)\] `).FindAllStringSubmatch(prompt, -1) {
			switch {
			case id[1] == docsIDOf(prompt, docsOffTopic):
				lines = append(lines, id[1]+" | 舍弃 | 与本节无关")
			case id[1] == docsIDOf(prompt, docsOutput):
				lines = append(lines, id[1]+" | 合并到 "+docsIDOf(prompt, docsOwnerWords)+" | 说的是同一件事，owner 原话分量更重")
			default:
				lines = append(lines, id[1]+" | 采用 | 讲的正是本节")
			}
		}
		return http.StatusOK, strings.Join(lines, "\n") + "\n现状：\n- 本节的现状要点 [S1]\n"
	case strings.Contains(prompt, "补逐字引文"):
		var answers []string
		for _, id := range regexp.MustCompile(`(?m)^## \[([A-Z]\d+)\] 标在`).FindAllStringSubmatch(prompt, -1) {
			answers = append(answers, m.repair[id[1]])
		}
		return http.StatusOK, strings.Join(answers, "")
	case strings.Contains(prompt, "（概述，"):
		return http.StatusOK, "### 总览\n一轮先存后投，至少投递一次[F1]。运行约定是全量测试在 runner 宿主上跑[F4]。\n"
	case strings.Contains(prompt, "# 任务：写文档"):
		answers := m.write[title]
		if len(answers) == 0 {
			return http.StatusOK, ""
		}
		if strings.Contains(prompt, "上一稿的问题") && len(answers) > 1 {
			return http.StatusOK, answers[1]
		}
		return http.StatusOK, answers[0]
	}
	return http.StatusOK, "?"
}

// docsIDOf is the id the prompt gave the piece whose text begins with text.
func docsIDOf(prompt, text string) string {
	i := strings.Index(prompt, text)
	if i < 0 {
		return ""
	}
	headers := regexp.MustCompile(`(?m)^\[([A-Z]\d+)\] `).FindAllStringSubmatchIndex(prompt[:i], -1)
	if len(headers) == 0 {
		return ""
	}
	last := headers[len(headers)-1]
	return prompt[last[2]:last[3]]
}

func (m *docsModel) Prompts() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string{}, m.prompts...)
}

// The writer's answers for the two sections: s2 cites the design document, the code (a comment quoted
// across two of its lines) and the contract, with one quote from elsewhere in the design document and one
// made up; s3 cites the owner's words and the delivery comment — first with a paragraph that marks only its
// last sentence and with no quote for the comment, then marked sentence by sentence.
var (
	docsWriteS2 = "### turn 怎么投递\n" +
		"一轮 turn 先落库再投递，至少投递一次[D1]。runner 通过出站轮询领取工作，不开入站端口[C1]。" +
		"契约把投递写成至少一次、按 turn id 幂等[K1]。序号在重生后保持单调[D1][S9]，优先级仍是 [P0]。\n\n" +
		"引文：\n" +
		"[D1] 「A turn is stored before it is delivered」\n" +
		"[D1] 「Seq stays monotonic across respawn」\n" +
		"[C1] 「keeps the heartbeat going. It never opens an inbound port.」\n" +
		"[K1] 「The contract says delivery is exactly once」\n"
	docsWriteS3First = "### 约定\n" +
		"运行约定有两条。全量测试必须在 `runner 宿主` 上跑，不能在引擎 Bash 里跑。整包跑完要看 0 FAIL[S1][S3]。\n\n" +
		"引文：\n[S1] 「全量测试在 runner 宿主上跑」\n"
	docsWriteS3Second = "### 约定\n" +
		"全量测试必须在 `runner 宿主` 上跑，不能在引擎 Bash 里跑[S1]。整包跑完要看 0 FAIL[S3]。\n\n" +
		"引文：\n[S1] 「全量测试在 runner 宿主上跑」\n"
	docsRepairS3 = "[S3] 「在 runner 宿主上跑完整包」\n"
)

func newDocsModel() *docsModel {
	return &docsModel{
		write: map[string][]string{
			"turn 怎么投递": {docsWriteS2},
			"约定":        {docsWriteS3First, docsWriteS3Second},
		},
		repair: map[string]string{"S3": docsRepairS3},
	}
}

// docsBuildRun runs the command as the maintenance session and reads back its summary.
func docsBuildRun(t *testing.T, repo string, args ...string) (wikiDocsBuildSummary, string, error) {
	t.Helper()
	var out strings.Builder
	err := cmdWikiCLI(append([]string{"docs", "build", "--space", "space-1", "--repo", repo, "--json"}, args...), strings.NewReader(""), &out)
	var summary wikiDocsBuildSummary
	if jsonErr := json.Unmarshal([]byte(out.String()), &summary); jsonErr != nil && err == nil {
		t.Fatalf("--json printed %q: %v", out.String(), jsonErr)
	}
	return summary, out.String(), err
}

func docsBuildSetup(t *testing.T) (*docsBuildDoor, *docsModel, *fakeVLLM, func() []fakeVerifySpawn, *wikiAnchorsFixture) {
	t.Helper()
	repo := newDocsBuildRepo(t)
	door := newDocsBuildDoor(t)
	model := newDocsModel()
	vllm := newFakeVLLM(t, model.answer)
	spawns := fakeVerifyClaude(t)
	wikiArticlesSession(t, door.URL, vllm)
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	return door, model, vllm, spawns, repo
}

// ── A run ───────────────────────────────────────────────────────────────────────────────────────

func TestWikiArticleBuildWritesEachSectionThroughACleanClaudeCodeAndTheOverviewLast(t *testing.T) {
	door, model, vllm, spawns, repo := docsBuildSetup(t)
	head := mustGit(t, repo.seed, "rev-parse", "HEAD")
	summary, out, err := docsBuildRun(t, repo.checkout)
	if err != nil {
		t.Fatalf("orbit wiki docs build: %v\n%s", err, out)
	}
	if summary.Written != 3 || summary.Failed != 0 || summary.Unchanged != 0 || summary.PlanVersion != 3 || summary.RepoSha != head || summary.Model != "qwen3.8-27b-fp8" {
		t.Errorf("summary = %+v", summary)
	}

	// The door: the plan, what is written, s3's material, a write per section — the overview's last — all as
	// the maintenance session.
	calls := door.Calls()
	want := []string{
		"GET /api/runner/wiki/spaces/space-1/plan",
		"GET /api/runner/wiki/spaces/space-1/docs",
		"GET /api/runner/wiki/spaces/space-1/docs/session-runtime/material?section=s3",
		"POST /api/runner/wiki/spaces/space-1/docs/session-runtime",
		"POST /api/runner/wiki/spaces/space-1/docs/session-runtime",
		"POST /api/runner/wiki/spaces/space-1/docs/session-runtime",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("door calls = %#v\nwant %#v", calls, want)
	}
	for _, session := range door.sessions {
		if session != "maintenance-session" {
			t.Errorf("a call went as session %q", session)
		}
	}
	writes := door.Writes()
	var order []string
	for _, write := range writes {
		if write.PlanVersion != 3 || write.RepoSha != head || write.Model != "qwen3.8-27b-fp8" || len(write.Sections) != 1 {
			t.Errorf("a write = %+v", write)
		}
		order = append(order, write.Sections[0].Key)
	}
	if order[2] != "s1" || !(order[0] == "s2" && order[1] == "s3" || order[0] == "s3" && order[1] == "s2") {
		t.Errorf("the writes went %v: the overview is written last", order)
	}

	// Every model call a clean Claude Code, thinking off, the token as Bearer: none of the session's own.
	runs := spawns()
	if len(runs) == 0 || len(runs) != summary.Calls {
		t.Fatalf("%d spawns for %d calls", len(runs), summary.Calls)
	}
	for _, run := range runs {
		args := strings.Join(run.Args, " ")
		for _, flag := range []string{"-p", "--bare", "--tools", "--strict-mcp-config", "--no-session-persistence", "--system-prompt"} {
			if !strings.Contains(args, flag) {
				t.Errorf("a call was launched without %s: %s", flag, args)
			}
		}
		env := spawnEnv(run)
		if env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
			t.Errorf("a call thinks: effort %q, thinking tokens %q", env["CLAUDE_CODE_EFFORT_LEVEL"], env["MAX_THINKING_TOKENS"])
		}
		for _, leak := range []string{"ANTHROPIC_API_KEY", "ORBIT_SESSION_ID", "ORBIT_BG_TOKEN", "CLAUDE_CODE_MESSAGING_SOCKET"} {
			if _, ok := env[leak]; ok {
				t.Errorf("%s reached the clean call", leak)
			}
		}
		if !strings.Contains(run.Prompt, "#") {
			t.Errorf("an empty prompt: %q", run.Prompt)
		}
	}
	for _, request := range vllm.requests {
		if request.Authorization != "Bearer tok-local-vllm" || request.thinks() || request.Tools != 0 {
			t.Errorf("a request to the model: %+v", request)
		}
	}
	// Merge and write for each of the two sections; s2's made-up contract quote asked about once more; the
	// s3 draft asked again (a paragraph marked only at its end) and its missing quote asked for once; and the
	// overview.
	if summary.Calls != 3+4+1 {
		t.Errorf("model calls = %d, want 8 (%d prompts)", summary.Calls, len(model.Prompts()))
	}
	if summary.Usage.InputTokens == 0 || summary.Usage.OutputTokens == 0 {
		t.Errorf("the usage was not counted: %+v", summary.Usage)
	}
}

// ── The material: its cap, and the platform's template messages ─────────────────────────────────

func TestWikiArticleBuildCapsTheMaterialAndFiltersTheTemplateMessages(t *testing.T) {
	door, model, _, _, repo := docsBuildSetup(t)
	if _, out, err := docsBuildRun(t, repo.checkout); err != nil {
		t.Fatalf("orbit wiki docs build: %v\n%s", err, out)
	}
	// The template never reached the model, nor did the repeated comment: they were taken out by rule.
	for _, prompt := range model.Prompts() {
		if strings.Contains(prompt, "Orbit has not recorded it done") {
			t.Errorf("the settlement card's template reached the model: %.200s", prompt)
		}
		if strings.Count(prompt, docsDelivery) > 1 {
			t.Error("the same comment was handed to the model twice")
		}
	}
	ledger := map[string]wikiDocDisposition{}
	for _, disposition := range door.written(t, "s3").Dispositions {
		ledger[disposition.Ref] = disposition
	}
	if got := ledger["turn-template"]; got.Action != "filtered" || !strings.Contains(got.Reason, "复查模板") {
		t.Errorf("the template's disposition = %+v", got)
	}
	if got := ledger["comment-2"]; got.Action != "filtered" || !strings.Contains(got.Reason, "原文相同") {
		t.Errorf("the repeated comment's disposition = %+v", got)
	}

	// The cap, piece by piece: a mechanism's documents and code first, the rest's records first; the first
	// piece whatever its size; nothing past materialMaxChars.
	big := strings.Repeat("字", 9000)
	pieces := func() []*wikiDocPiece {
		return []*wikiDocPiece{
			{id: "D1", kind: "design_doc", text: big}, {id: "C1", kind: "code", text: big},
			{id: "S1", kind: "turn", text: big}, {id: "S2", kind: "turn", text: big},
		}
	}
	mechanism := pieces()
	wikiDocSelect("flow", mechanism)
	conventions := pieces()
	wikiDocSelect("conventions", conventions)
	actions := func(pieces []*wikiDocPiece) string {
		var out []string
		for _, piece := range pieces {
			out = append(out, piece.id+"="+map[bool]string{true: "handed", false: piece.action}[piece.handed])
		}
		return strings.Join(out, " ")
	}
	if got := actions(mechanism); got != "D1=handed C1=handed S1=over_cap S2=over_cap" {
		t.Errorf("a mechanism's material: %s", got)
	}
	if got := actions(conventions); got != "D1=over_cap C1=over_cap S1=handed S2=handed" {
		t.Errorf("the conventions' material: %s", got)
	}
	huge := []*wikiDocPiece{{id: "S1", kind: "turn", text: strings.Repeat("字", 30000)}, {id: "S2", kind: "turn", text: "短"}}
	wikiDocSelect("pitfalls", huge)
	if !huge[0].handed || huge[1].handed || huge[1].action != "over_cap" || !strings.Contains(huge[1].reason, "22000") {
		t.Errorf("the first piece is handed over whatever its size, and nothing after it past the cap: %+v %+v", *huge[0], *huge[1])
	}
	total := 0
	for _, piece := range conventions {
		if piece.handed {
			total += utf8.RuneCountInString(piece.text) + wikiDocMaterialHeaderChars
		}
	}
	if total > wikiDocMaterialMaxChars {
		t.Errorf("%d characters handed over, past the cap of %d", total, wikiDocMaterialMaxChars)
	}
	// Taken out by rule: a turn that is the template, whoever's client sent it; the same text twice.
	filtered := []*wikiDocPiece{
		{id: "S1", kind: "turn", text: "About \"Orbit Wiki\" — Orbit has not recorded it done. …"},
		{id: "S2", kind: "turn", text: "About the design: Orbit has not recorded it done yet, the owner says"},
		{id: "S3", kind: "task_comment", text: "About “x” — Orbit has not recorded it done."},
		{id: "S4", kind: "turn", text: "same"}, {id: "S5", kind: "turn", text: " same "},
	}
	wikiDocFilter(filtered)
	if got := actions(filtered); got != "S1=filtered S2= S3= S4= S5=filtered" {
		t.Errorf("filtered: %s", got)
	}
}

// ── What became of each piece ───────────────────────────────────────────────────────────────────

func TestWikiArticleBuildSendsWhatBecameOfEveryPieceWithItsSection(t *testing.T) {
	door, _, _, _, repo := docsBuildSetup(t)
	if _, out, err := docsBuildRun(t, repo.checkout); err != nil {
		t.Fatalf("orbit wiki docs build: %v\n%s", err, out)
	}
	s3 := door.written(t, "s3")
	type row struct{ material, kind, ref, action, into string }
	var got []row
	for _, d := range s3.Dispositions {
		into := ""
		if d.Into != nil {
			into = *d.Into
		}
		got = append(got, row{d.Material, d.Kind, d.Ref, d.Action, into})
		if strings.TrimSpace(d.Reason) == "" {
			t.Errorf("%s has no reason", d.Material)
		}
	}
	want := []row{
		{"S1", "turn", "turn-owner", "adopt", ""},
		{"S2", "turn", "turn-template", "filtered", ""},
		{"S3", "task_comment", "comment-1", "adopt", ""},
		{"S4", "task_comment", "comment-2", "filtered", ""},
		{"S5", "tool_call", "call-1", "merge", "S1"},
		{"S6", "turn", "turn-lunch", "drop", ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("s3's ledger =\n%+v\nwant\n%+v", got, want)
	}
	// Every piece of s2's material is in its ledger too, a repository piece named by its path and lines.
	s2 := door.written(t, "s2")
	var refs []string
	for _, d := range s2.Dispositions {
		refs = append(refs, d.Material+" "+d.Kind+" "+d.Ref+" "+d.Action)
	}
	wantRefs := []string{
		"D1 design_doc docs/design.md#L7-14 adopt",
		"C1 code src/runloop.go#L3-9 adopt",
		"K1 contract contracts/session.contract.json#L1-4 adopt",
	}
	if !reflect.DeepEqual(refs, wantRefs) {
		t.Errorf("s2's ledger = %v, want %v", refs, wantRefs)
	}
	// The overview merges nothing: its material is the other sections as written.
	if s1 := door.written(t, "s1"); len(s1.Dispositions) != 0 {
		t.Errorf("the overview's ledger = %+v", s1.Dispositions)
	}

	// The merge's answer read strictly: a merge into a piece that is not the section's is an adoption, and a
	// piece it said nothing of is adopted — each saying so.
	pieces := []*wikiDocPiece{{id: "S1", handed: true}, {id: "S2", handed: true}, {id: "S3", handed: true}, {id: "S4"}}
	state := wikiDocApplyMerge("S1 | 采用 | 原话\nS2 | 合并到 S9 | 同一件事\n[S4] | 舍弃 | 没交给它\n现状：\n- 第一条 [S1]\n- 第二条\n", pieces)
	if pieces[0].action != "adopt" || pieces[1].action != "adopt" || !strings.Contains(pieces[1].reason, "S9") ||
		pieces[2].action != "adopt" || !strings.Contains(pieces[2].reason, "按采用") || pieces[3].action != "" {
		t.Errorf("the merge read as %+v %+v %+v %+v", *pieces[0], *pieces[1], *pieces[2], *pieces[3])
	}
	if !reflect.DeepEqual(state, []string{"第一条 [S1]", "第二条"}) {
		t.Errorf("the state = %q", state)
	}
}

// ── The footnotes ───────────────────────────────────────────────────────────────────────────────

func TestWikiArticleBuildGivesEveryFootnoteItsVerbatimQuote(t *testing.T) {
	door, model, _, _, repo := docsBuildSetup(t)
	head := mustGit(t, repo.seed, "rev-parse", "HEAD")
	if _, out, err := docsBuildRun(t, repo.checkout); err != nil {
		t.Fatalf("orbit wiki docs build: %v\n%s", err, out)
	}
	s2 := door.written(t, "s2")
	// The body: markers numbered by first appearance, no material id and no quote block left, a marker naming
	// no piece of the section (S9) dropped, and brackets that are the text's own ([P0]) left alone.
	if s2.Markdown != "一轮 turn 先落库再投递，至少投递一次[1]。runner 通过出站轮询领取工作，不开入站端口[2]。契约把投递写成至少一次、按 turn id 幂等[3]。序号在重生后保持单调[1]，优先级仍是 [P0]。" {
		t.Errorf("s2's markdown = %q", s2.Markdown)
	}
	if len(s2.Footnotes) != 3 {
		t.Fatalf("s2's footnotes = %+v", s2.Footnotes)
	}
	design, code, contract := s2.Footnotes[0], s2.Footnotes[1], s2.Footnotes[2]
	for _, footnote := range s2.Footnotes {
		if footnote.Quote == nil || footnote.Sha != head || footnote.Lines == nil || footnote.Verified == nil || footnote.Excerpt == "" || footnote.Ref != "" {
			t.Errorf("a repository footnote = %+v", footnote)
		}
	}
	if design.Kind != "design_doc" || design.Path != "docs/design.md" || design.Section != "2. Delivery" || *design.Quote != "A turn is stored before it is delivered" {
		t.Errorf("the design footnote = %+v", design)
	}
	if code.Kind != "code" || code.Symbol != "runLoop" || *code.Quote != "keeps the heartbeat going. It never opens an inbound port." {
		t.Errorf("the code footnote = %+v", code)
	}
	if contract.Kind != "contract" || *contract.Quote != "The contract says delivery is exactly once" {
		t.Errorf("the contract footnote = %+v", contract)
	}

	// s3: a record's footnote carries its id, the range the server handed out and the entry it came through;
	// the quote the model left out was asked for once more, and the paragraph marked only at its end was
	// written again sentence by sentence.
	s3 := door.written(t, "s3")
	if s3.Markdown != "全量测试必须在 `runner 宿主` 上跑，不能在引擎 Bash 里跑[1]。整包跑完要看 0 FAIL[2]。" {
		t.Errorf("s3's markdown = %q", s3.Markdown)
	}
	if len(s3.Footnotes) != 2 {
		t.Fatalf("s3's footnotes = %+v", s3.Footnotes)
	}
	owner, comment := s3.Footnotes[0], s3.Footnotes[1]
	if owner.Kind != "turn" || owner.Ref != "turn-owner" || owner.Chars == nil || owner.Chars.End != utf8.RuneCountInString(docsOwnerWords) ||
		owner.Quote == nil || *owner.Quote != "全量测试在 runner 宿主上跑" || owner.Sha != "" || owner.Verified != nil {
		t.Errorf("the owner's footnote = %+v", owner)
	}
	if comment.Kind != "task_comment" || comment.Ref != "comment-1" || comment.Quote == nil || *comment.Quote != "在 runner 宿主上跑完整包" {
		t.Errorf("the comment's footnote = %+v", comment)
	}
	// s2 and s3 are written side by side, so the repair asked about s3 is found by what it asks about.
	var repair, again string
	for _, prompt := range model.Prompts() {
		if strings.Contains(prompt, "补逐字引文") && strings.Contains(prompt, "## [S3] 标在") {
			repair = prompt
		}
		if strings.Contains(prompt, "上一稿的问题") {
			again = prompt
		}
	}
	if !strings.Contains(repair, "[S3]") || !strings.Contains(repair, docsDelivery) || strings.Contains(repair, "[S1] 标在") {
		t.Errorf("the quote was asked for as %q", repair)
	}
	if !strings.Contains(again, "运行约定有两条") {
		t.Errorf("the paragraph marked only at its end was not asked about: %q", again)
	}
	// Every footnote of every section has its quote.
	for _, write := range door.Writes() {
		for _, section := range write.Sections {
			for _, footnote := range section.Footnotes {
				if footnote.Quote == nil || strings.TrimSpace(*footnote.Quote) == "" {
					t.Errorf("section %s has a footnote with no quote: %+v", section.Key, footnote)
				}
			}
		}
	}
	// The write prompt asks for the quotes, sentence by sentence, and for an abbreviation explained first.
	for _, prompt := range model.Prompts() {
		if strings.Contains(prompt, "# 任务：写文档") && !strings.Contains(prompt, "（概述，") {
			for _, rule := range []string{"每一个编号都必须有一行引文", "不能只在段末标一次", "SR50", "先用半句话说明它指什么"} {
				if !strings.Contains(prompt, rule) {
					t.Errorf("the write prompt does not say %q", rule)
				}
			}
		}
	}
}

// ── The repository's quotes, at the commit ──────────────────────────────────────────────────────

func TestWikiArticleBuildChecksRepositoryQuotesInTheFileAtTheCommit(t *testing.T) {
	door, _, _, _, repo := docsBuildSetup(t)
	// origin's main moves after the checkout was cloned: the command fetches it, and reads this commit.
	head := repo.push(t, "delivery reworded", func() {
		repo.write(t, "docs/design.md", strings.Replace(docsDesign, "and delivered at least once", "and delivered at least once, by the lease holder", 1))
	})
	summary, out, err := docsBuildRun(t, repo.checkout)
	if err != nil {
		t.Fatalf("orbit wiki docs build: %v\n%s", err, out)
	}
	if summary.RepoSha != head {
		t.Errorf("read at %s, origin/main is %s", summary.RepoSha, head)
	}
	s2 := door.written(t, "s2")
	design, code, contract := s2.Footnotes[0], s2.Footnotes[1], s2.Footnotes[2]
	// Found where it was taken from: the lines it is on.
	if !*design.Verified || design.Sha != head || *design.Lines != (wikiDocRange{Start: 9, End: 9}) || !strings.Contains(design.Excerpt, "by the lease holder") {
		t.Errorf("the design footnote = %+v", design)
	}
	// A comment's words quoted across two lines of it: found with the comment markers off.
	if !*code.Verified || *code.Lines != (wikiDocRange{Start: 3, End: 4}) {
		t.Errorf("the code footnote = %+v", code)
	}
	// Made up: not found, and said so; its lines the piece it names.
	if *contract.Verified || *contract.Lines != (wikiDocRange{Start: 1, End: 4}) {
		t.Errorf("the contract footnote = %+v", contract)
	}
	for _, footnote := range s2.Footnotes {
		if footnote.Sha != head {
			t.Errorf("a footnote read at %s, not origin/main %s", footnote.Sha, head)
		}
	}

	// The same check, on its own: within the lines first, then anywhere in the file; a quote translated, or
	// two passages spliced, is not found; a quote shorter than the contract's least is found nowhere.
	within := wikiDocRange{Start: 7, End: 14}
	for _, c := range []struct {
		quote string
		want  wikiDocRange
		found bool
	}{
		{"A turn is stored before it is delivered", wikiDocRange{Start: 9, End: 9}, true},
		{"Delivery is idempotent on the turn's id.", wikiDocRange{Start: 10, End: 10}, true},
		{"Seq stays monotonic across respawn", wikiDocRange{Start: 18, End: 18}, true},
		{"一轮 turn 先落库再投递", wikiDocRange{}, false},
		{"A turn is stored before it is delivered. Seq stays monotonic", wikiDocRange{}, false},
		{"A turn", wikiDocRange{Start: 9, End: 9}, true},
		{"Ab", wikiDocRange{}, false},
		{"“A turn is stored”，before it", wikiDocRange{}, false},
	} {
		got, found := wikiDocLocate(docsDesign, c.quote, &within)
		if found != c.found || (found && got != c.want) {
			t.Errorf("%q: found %v at %+v, want %v at %+v", c.quote, found, got, c.found, c.want)
		}
	}
	// Full-width punctuation and Markdown emphasis are folded as the server folds a record's quote.
	if _, found := wikiDocLocate("先存后投，**再**投递。", "先存后投,再投递.", nil); !found {
		t.Error("a quote folded differently from its original")
	}
}

// ── The overview, last; and a section whose material did not change ─────────────────────────────

func TestWikiArticleBuildLeavesASectionWhoseMaterialDidNotChangeAndWritesTheOverviewFromWhatIsWritten(t *testing.T) {
	door, model, _, _, repo := docsBuildSetup(t)
	if _, out, err := docsBuildRun(t, repo.checkout); err != nil {
		t.Fatalf("first run: %v\n%s", err, out)
	}
	first := map[string]wikiDocSection{}
	for _, key := range []string{"s1", "s2", "s3"} {
		first[key] = door.written(t, key)
	}
	// The overview was written from the sections as written: their text with their footnotes as [F<n>], and
	// its own footnotes are theirs — the same originals and the same quotes.
	var overviewPrompt string
	for _, prompt := range model.Prompts() {
		if strings.Contains(prompt, "（概述，") {
			overviewPrompt = prompt
		}
	}
	for _, want := range []string{"【第 2 节 turn 怎么投递】", "至少投递一次[F1]", "【第 3 节 约定】", "[F1] 「A turn is stored before it is delivered」"} {
		if !strings.Contains(overviewPrompt, want) {
			t.Errorf("the overview prompt does not carry %q:\n%s", want, overviewPrompt)
		}
	}
	s1 := first["s1"]
	if s1.Markdown != "一轮先存后投，至少投递一次[1]。运行约定是全量测试在 runner 宿主上跑[2]。" || len(s1.Footnotes) != 2 {
		t.Fatalf("the overview = %q %+v", s1.Markdown, s1.Footnotes)
	}
	if s1.Footnotes[0].Path != "docs/design.md" || *s1.Footnotes[0].Quote != *first["s2"].Footnotes[0].Quote || !*s1.Footnotes[0].Verified {
		t.Errorf("the overview's first footnote = %+v", s1.Footnotes[0])
	}
	if s1.Footnotes[1].Ref != "turn-owner" || *s1.Footnotes[1].Quote != *first["s3"].Footnotes[0].Quote || s1.Footnotes[1].Chars == nil {
		t.Errorf("the overview's second footnote = %+v", s1.Footnotes[1])
	}

	// What the server holds now: every section at the fingerprint it was written from.
	state := func(stale map[string]bool) map[string]interface{} {
		var sections []interface{}
		for _, key := range []string{"s1", "s2", "s3"} {
			sections = append(sections, map[string]interface{}{"key": key, "materialSha256": first[key].MaterialSha256, "repoSha": strings.Repeat("a", 40), "stale": stale[key], "generatedAt": "2026-09-29T00:00:00.000Z"})
		}
		return map[string]interface{}{"spaceId": "space-1", "planVersion": 3, "docs": []interface{}{map[string]interface{}{
			"slug": "session-runtime", "planVersion": 3, "status": "ok", "repoSha": strings.Repeat("a", 40), "updatedAt": "2026-09-29T00:00:00.000Z", "sections": sections,
		}}}
	}
	for key, section := range first {
		if len(section.MaterialSha256) != 64 {
			t.Errorf("%s's fingerprint = %q", key, section.MaterialSha256)
		}
	}
	if first["s2"].MaterialSha256 == first["s3"].MaterialSha256 || first["s1"].MaterialSha256 == first["s2"].MaterialSha256 {
		t.Error("two sections share a fingerprint")
	}

	// Nothing changed: nothing is asked of the model, nothing written — and the repository's own new
	// commit, which changes nothing a section reads, changes no fingerprint.
	repo.push(t, "an unrelated file", func() { repo.write(t, "README.md", "unrelated\n") })
	door.mu.Lock()
	door.state, door.writes, door.calls = state(nil), nil, nil
	door.mu.Unlock()
	before := len(model.Prompts())
	summary, out, err := docsBuildRun(t, repo.checkout)
	if err != nil {
		t.Fatalf("second run: %v\n%s", err, out)
	}
	if summary.Unchanged != 3 || summary.Written != 0 || summary.Calls != 0 || len(model.Prompts()) != before || len(door.Writes()) != 0 {
		t.Errorf("an unchanged document: %+v, %d prompts, %d writes", summary, len(model.Prompts())-before, len(door.Writes()))
	}
	for _, section := range summary.Docs[0].Sections {
		if section.MaterialSha256 != first[section.Key].MaterialSha256 {
			t.Errorf("%s's fingerprint moved with nothing it reads: %s → %s", section.Key, first[section.Key].MaterialSha256, section.MaterialSha256)
		}
	}

	// A section a sentence was withdrawn from is written again, though its material is the same; the overview,
	// whose sections' fingerprints did not move, is not.
	door.mu.Lock()
	door.state, door.writes = state(map[string]bool{"s3": true}), nil
	door.mu.Unlock()
	summary, out, err = docsBuildRun(t, repo.checkout)
	if err != nil {
		t.Fatalf("third run: %v\n%s", err, out)
	}
	var keys []string
	for _, write := range door.Writes() {
		keys = append(keys, write.Sections[0].Key)
	}
	if !reflect.DeepEqual(keys, []string{"s3"}) || summary.Written != 1 || summary.Unchanged != 2 {
		t.Errorf("a stale section: writes %v, summary %+v", keys, summary)
	}

	// The design document changes where s2 reads it: s2 is written again, and so is the overview, from s2 as
	// just written and from s3 as the server holds it (the document's read).
	repo.push(t, "delivery changed", func() {
		repo.write(t, "docs/design.md", strings.Replace(docsDesign, "at least once", "at least once, and acknowledged", 1))
	})
	door.mu.Lock()
	door.state, door.writes, door.calls = state(nil), nil, nil
	door.view = docsBuildView()
	door.mu.Unlock()
	summary, out, err = docsBuildRun(t, repo.checkout)
	if err != nil {
		t.Fatalf("fourth run: %v\n%s", err, out)
	}
	keys = nil
	for _, write := range door.Writes() {
		keys = append(keys, write.Sections[0].Key)
	}
	if !reflect.DeepEqual(keys, []string{"s2", "s1"}) || summary.Written != 2 || summary.Unchanged != 1 {
		t.Errorf("a changed design document: writes %v, summary %+v", keys, summary)
	}
	if door.written(t, "s2").MaterialSha256 == first["s2"].MaterialSha256 {
		t.Error("s2's fingerprint did not move with its design document")
	}
	calls := door.Calls()
	if !contains(calls, "GET /api/runner/wiki/spaces/space-1/docs/session-runtime") {
		t.Errorf("the overview did not read the sections it left alone: %v", calls)
	}
	overview := door.written(t, "s1")
	var fromStored bool
	for _, footnote := range overview.Footnotes {
		if footnote.Ref == "turn-owner" && footnote.Chars != nil && *footnote.Chars == (wikiDocRange{Start: 0, End: 16}) {
			fromStored = true
		}
	}
	if !fromStored {
		t.Errorf("the overview's footnotes do not carry s3's as the server holds them: %+v", overview.Footnotes)
	}
}

// docsBuildView is the document as the server holds it after the first run: s3's one sentence.
func docsBuildView() map[string]interface{} {
	text := func(s string) *string { return &s }
	return map[string]interface{}{
		"slug": "session-runtime",
		"sections": []interface{}{
			map[string]interface{}{"key": "s1", "title": "总览", "written": true, "blocks": []interface{}{}},
			map[string]interface{}{"key": "s2", "title": "turn 怎么投递", "written": true, "blocks": []interface{}{}},
			map[string]interface{}{"key": "s3", "title": "约定", "written": true, "blocks": []interface{}{
				map[string]interface{}{"kind": "paragraph", "text": nil, "sentences": []interface{}{
					map[string]interface{}{"text": "全量测试必须在 `runner 宿主` 上跑，不能在引擎 Bash 里跑。", "notes": []int{4}},
				}},
			}},
		},
		"footnotes": []interface{}{
			map[string]interface{}{"n": 4, "kind": "turn", "quote": text("全量测试在 runner 宿主上跑"), "recordId": "turn-owner", "charStart": 0, "charEnd": 16,
				"path": nil, "lineStart": nil, "lineEnd": nil, "section": nil, "symbol": nil, "viaEntryId": nil},
		},
	}
}

// ── A 401, and a caller that is not a maintenance run ───────────────────────────────────────────

func TestWikiArticleBuildStopsAtTheFirst401(t *testing.T) {
	door, model, _, _, repo := docsBuildSetup(t)
	model.status = http.StatusUnauthorized
	summary, _, err := docsBuildRun(t, repo.checkout)
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("a 401 did not stop the run: %v", err)
	}
	if len(door.Writes()) != 0 || summary.Written != 0 || summary.Stopped == "" {
		t.Errorf("after a 401: %d writes, %+v", len(door.Writes()), summary)
	}
	// Two sections were in flight at most; nothing was tried again, and the overview never asked.
	if n := len(model.Prompts()); n == 0 || n > 2 {
		t.Errorf("%d calls after a 401, want at most the two in flight", n)
	}
}

func TestWikiArticleBuildIsRefusedToAnyButAMaintenanceRun(t *testing.T) {
	door, model, _, _, repo := docsBuildSetup(t)
	door.planCode = http.StatusForbidden
	door.planBody = `{"code":"WIKI_NOT_MAINTENANCE_SESSION","message":"not a maintenance run"}`
	_, _, err := docsBuildRun(t, repo.checkout)
	if err == nil || !strings.Contains(err.Error(), "WIKI_NOT_MAINTENANCE_SESSION") || !strings.Contains(err.Error(), "Nothing was read or written") {
		t.Fatalf("a session that is not a maintenance run: %v", err)
	}
	if len(model.Prompts()) != 0 || len(door.Writes()) != 0 {
		t.Error("something was asked or written")
	}
	// --section names a section of --doc; a --doc the plan does not have is named in the refusal.
	if _, _, err := docsBuildRun(t, repo.checkout, "--section", "s2"); err == nil || !strings.Contains(err.Error(), "--doc") {
		t.Errorf("--section alone: %v", err)
	}
	door.planCode = 0
	if _, _, err := docsBuildRun(t, repo.checkout, "--doc", "no-such-doc"); err == nil || !strings.Contains(err.Error(), "no-such-doc") {
		t.Errorf("an unknown --doc: %v", err)
	}
}

func TestWikiArticleBuildWritesOnlyTheSectionItIsAskedFor(t *testing.T) {
	door, _, _, _, repo := docsBuildSetup(t)
	summary, out, err := docsBuildRun(t, repo.checkout, "--doc", "session-runtime", "--section", "s2")
	if err != nil {
		t.Fatalf("orbit wiki docs build --section s2: %v\n%s", err, out)
	}
	var keys []string
	for _, write := range door.Writes() {
		keys = append(keys, write.Sections[0].Key)
	}
	if !reflect.DeepEqual(keys, []string{"s2"}) || summary.Written != 1 || len(summary.Docs[0].Sections) != 1 {
		t.Errorf("--section s2 wrote %v: %+v", keys, summary)
	}
	for _, call := range door.Calls() {
		if strings.Contains(call, "material") {
			t.Errorf("--section s2 read another section's material: %s", call)
		}
	}
}

// ── The contract, and the three family tables ───────────────────────────────────────────────────

func TestWikiArticleBuildIsTheContractsCommand(t *testing.T) {
	docs := wikiContract(t)["docs"].(map[string]interface{})
	build := docs["build"].(map[string]interface{})
	if build["precondition"] != wikiDocsBuildPrecondition {
		t.Errorf("the precondition drifted from the contract:\n%q\n%q", build["precondition"], wikiDocsBuildPrecondition)
	}
	if !strings.HasPrefix(wikiDocsBuildDescription, wikiDocsBuildPrecondition) {
		t.Error("the description does not lead with the precondition")
	}
	rules := build["rules"].(map[string]interface{})
	if int(rules["materialMaxChars"].(float64)) != wikiDocMaterialMaxChars || int(rules["materialHeaderChars"].(float64)) != wikiDocMaterialHeaderChars ||
		int(rules["parallel"].(float64)) != wikiDocBuildParallel {
		t.Errorf("docs.build.rules = %v", rules)
	}
	if !strings.Contains(build["templates"].(string), "Orbit has not recorded it done") || !strings.HasPrefix(build["tool"].(string), "none") {
		t.Errorf("docs.build = %v", build)
	}
	// The capability is the contract's command line, CLI only, inside a session, and documented.
	var spec *cliCapabilitySpec
	for i := range wikiCLICapabilities {
		if wikiCLICapabilities[i].Tool == "wiki_docs_build" {
			spec = &wikiCLICapabilities[i]
		}
	}
	if spec == nil {
		t.Fatal("orbit wiki docs build is not among the wiki capabilities")
	}
	if spec.Usage != build["cli"] || !spec.SessionOnly || !spec.Mutates || spec.Description != wikiDocsBuildDescription ||
		!reflect.DeepEqual(spec.Argv, []string{"orbit", "wiki", "docs", "build"}) || !wikiCLIOnlyCapabilities[spec.Tool] {
		t.Errorf("the capability = %+v", *spec)
	}
	if !strings.Contains(wikiHelp, build["cli"].(string)[:len("orbit wiki docs build --space <id>")]) || !strings.Contains(wikiActionHelp["docs"], wikiDocsBuildPrecondition) {
		t.Error("the help does not document the command")
	}
	for _, flag := range []string{"--space", "--doc", "--section", "--repo", "--model", "--json"} {
		if !strings.Contains(wikiActionHelp["docs"], flag) || !writtenFlagIsParsed("docs build", strings.TrimPrefix(flag, "--")) {
			t.Errorf("%s is not documented and parsed", flag)
		}
	}
	// Pre-approved, as every advertised capability is.
	rule := "Bash(/usr/local/bin/orbit wiki docs build *)"
	if !contains(orbitCLIAllowedTools("/usr/local/bin/orbit", false), rule) {
		t.Errorf("%s is not pre-approved", rule)
	}
	// The routes the command calls are the contract's maintenance routes of the runner door.
	routes := docs["routes"].(map[string]interface{})
	maintenance := map[string]bool{}
	for _, route := range wikiContract(t)["agentSurface"].(map[string]interface{})["doors"].(map[string]interface{})["runner"].(map[string]interface{})["maintenanceRoutes"].([]interface{}) {
		maintenance[route.(string)] = true
	}
	for _, name := range []string{"writerState", "writerDoc", "material", "write"} {
		if !maintenance[routes[name].(string)] {
			t.Errorf("docs.routes.%s (%s) is not a maintenance route of the runner door", name, routes[name])
		}
	}
	// `orbit wiki docs` alone names its one command; another word is refused.
	var out strings.Builder
	if err := cmdWikiCLI([]string{"docs"}, strings.NewReader(""), &out); err != nil || !strings.Contains(out.String(), "orbit wiki docs build") {
		t.Errorf("orbit wiki docs: %v %q", err, out.String())
	}
	if err := cmdWikiCLI([]string{"docs", "write", "--space", "space-1"}, strings.NewReader(""), &out); err == nil || !strings.Contains(err.Error(), "its one command is build") {
		t.Errorf("orbit wiki docs write: %v", err)
	}
}

// The fingerprint is the section's definition and its material, as gathered — spelled one way whatever
// spelling a project id arrived in — and not the commit it was read at.
func TestWikiArticleBuildFingerprintIsTheDefinitionAndTheMaterial(t *testing.T) {
	var plan wikiDocsPlanAnswer
	raw, _ := json.Marshal(docsBuildPlan())
	if err := json.Unmarshal(raw, &plan); err != nil {
		t.Fatal(err)
	}
	section := plan.Confirmed.Docs[0].Sections[2]
	pieces := func() []*wikiDocPiece {
		return []*wikiDocPiece{{id: "S1", kind: "turn", ref: "01a0e39d-4375-7280-8aad-5200529cdec3", chars: wikiDocRange{Start: 0, End: 4}, text: "原话一句"}}
	}
	base := wikiDocFingerprint(section, pieces())
	spelled := section
	projects := append(spelled.Sources.Sessions.Projects[:0:0], spelled.Sources.Sessions.Projects...)
	projects[0].ID = publicID(projects[0].ID)
	copied := *spelled.Sources.Sessions
	copied.Projects = projects
	spelled.Sources.Sessions = &copied
	withPublic := pieces()
	withPublic[0].ref = publicID(withPublic[0].ref)
	if wikiDocFingerprint(spelled, withPublic) != base {
		t.Error("a project or record id spelled the other way moved the fingerprint")
	}
	changed := pieces()
	changed[0].text = "原话两句"
	if wikiDocFingerprint(section, changed) == base {
		t.Error("a piece's text changed and the fingerprint did not")
	}
	covers := section
	covers.Covers = "别的"
	if wikiDocFingerprint(covers, pieces()) == base {
		t.Error("the section's definition changed and the fingerprint did not")
	}
	var keys []string
	for key := range wikiDocDefinition(section) {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if !reflect.DeepEqual(keys, []string{"covers", "kind", "length", "sources", "title"}) {
		t.Errorf("the definition fingerprinted = %v, the contract's (title, kind, covers, length, sources)", keys)
	}
}

// A section the plan gives no material — 7.1's closing «约定», whose outline names nothing to take — is
// still written: the model is asked for its boundary alone, with no merge, and the write carries its
// footnotes and its ledger as empty lists, which the server's schema asks for (null is refused).
func TestWikiArticleBuildWritesASectionWithNoMaterialAsEmptyLists(t *testing.T) {
	door, model, _, _, repo := docsBuildSetup(t)
	door.mu.Lock()
	plan := door.plan["confirmed"].(map[string]interface{})["docs"].([]interface{})[0].(map[string]interface{})
	plan["sections"] = append(plan["sections"].([]interface{}), map[string]interface{}{
		"id": "sec-s4", "key": "s4", "position": 3, "title": "边界", "kind": "conventions", "covers": "本篇不讲什么。", "length": 200,
		"sources": map[string]interface{}{"docs": []interface{}{}, "code": []interface{}{}, "contracts": []interface{}{}, "sessions": nil},
		"extra": map[string]interface{}{},
	})
	door.mu.Unlock()
	model.write["边界"] = []string{"### 边界\n本篇只讲会话怎么运转，任务怎么派发另有专篇。\n"}
	summary, out, err := docsBuildRun(t, repo.checkout, "--doc", "session-runtime", "--section", "s4")
	if err != nil {
		t.Fatalf("orbit wiki docs build --section s4: %v\n%s", err, out)
	}
	if summary.Written != 1 || summary.Calls != 1 {
		t.Errorf("a section with no material: %+v (want it written from one call, with no merge)", summary)
	}
	prompts := model.Prompts()
	if len(prompts) != 1 || !strings.Contains(prompts[0], "归并后没有可用材料") || strings.Contains(prompts[0], "做「归并」") {
		t.Errorf("the one call was %q", prompts)
	}
	door.mu.Lock()
	raw := append([]string{}, door.raw...)
	door.mu.Unlock()
	if len(raw) != 1 || !strings.Contains(raw[0], `"footnotes":[]`) || !strings.Contains(raw[0], `"dispositions":[]`) {
		t.Errorf("the write sent %v: want its footnotes and its ledger as empty lists", raw)
	}
	if got := door.written(t, "s4"); got.Markdown != "本篇只讲会话怎么运转，任务怎么派发另有专篇。" {
		t.Errorf("the section = %q", got.Markdown)
	}
}
