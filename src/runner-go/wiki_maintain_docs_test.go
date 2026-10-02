package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
)

// A maintenance run's documents (contract `maintenance.job.docs`, criterion 3 revision 3): the sections its
// entries fit and the ones whose repository material changed on origin/main are written again, and no
// other; a cited file gone from origin/main withdraws what cites it; a design document no section cites is
// one plan proposal; and with no confirmed plan nothing is written. Against the fake door of
// wiki_maintain_test.go, the fake model endpoint and Claude Code of wiki_verify_test.go, and a real git
// origin with commits pushed to it between the documents' writing and the run.

// docsFixture is the space's repository: a bare origin, a seed that pushes to it, and the maintenance
// workspace's checkout of it.
type docsFixture struct {
	maintainFixture
	seed string
}

func newDocsFixture(t *testing.T, files map[string]string) docsFixture {
	t.Helper()
	base := t.TempDir()
	f := docsFixture{maintainFixture: maintainFixture{bare: filepath.Join(base, "app.git"), checkout: filepath.Join(base, "app")}, seed: filepath.Join(base, "seed")}
	mustGit(t, base, "init", "-q", "--bare", "-b", "main", f.bare)
	if err := os.MkdirAll(f.seed, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.seed, "init", "-q", "-b", "main")
	mustGit(t, f.seed, "config", "user.email", "test@orbit")
	mustGit(t, f.seed, "config", "user.name", "Test")
	f.write(t, files)
	mustGit(t, f.seed, "add", "-A")
	mustGit(t, f.seed, "commit", "-q", "-m", "first")
	f.first = mustGit(t, f.seed, "rev-parse", "HEAD")
	mustGit(t, f.seed, "remote", "add", "origin", f.bare)
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	mustGit(t, base, "clone", "-q", f.bare, f.checkout)
	return f
}

// write puts files in the seed; an empty content removes one.
func (f docsFixture) write(t *testing.T, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(f.seed, name)
		if content == "" {
			_ = os.Remove(path)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// push lands a commit on origin's main; the checkout sees it only when the run fetches.
func (f docsFixture) push(t *testing.T, message string, change func()) string {
	t.Helper()
	change()
	mustGit(t, f.seed, "add", "-A")
	mustGit(t, f.seed, "commit", "-q", "-m", message)
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	return mustGit(t, f.seed, "rev-parse", "HEAD")
}

const (
	docsDesignBefore = "# Runner 设计\n\n## 1. 传输\n\nrunner 通过出站 HTTP 轮询服务器，不需要入站端口。\n\n## 2. 投递\n\n一轮 turn 先落库再投递，至少投递一次。\n"
	docsDesignAfter  = "# Runner 设计\n\n## 1. 传输\n\nrunner 通过出站 HTTP 轮询服务器，不需要入站端口。\n\n## 2. 投递\n\n一轮 turn 先落库再投递，至少投递一次，按 turn id 幂等。\n"
	docsNewDesign    = "# 账号代管\n\n服务器替 owner 保管 Codex 登录，runner 取用时由服务器下发，登录不落在 runner 上。\n\n" +
		"## 1. 保管\n\n登录只在服务器上加密保存。\n\n## 2. 下发\n\nrunner 每次启动会话时向服务器要一次。\n"
)

// docsRepo is the repository as the documents were written from it.
func docsRepo(t *testing.T) docsFixture {
	return newDocsFixture(t, map[string]string{
		"README.md":      "# App\n\nApp is the spec's small service whose runner polls the server and runs the sessions it claims.\n",
		"docs/design.md": docsDesignBefore,
		"docs/old.md":    "# 旧设计\n\n## 概要\n\n这份文档讲旧的领取方式。\n",
		"docs/moved.md":  "# 派发\n\n## 概要\n\n讲派发怎么把会话交给 runner。\n",
		"src/app.go":     "package app\n\n// Serve answers the port.\nfunc Serve() {}\n",
	})
}

// docsPlanFor is the confirmed plan's one document, as `GET …/plan` answers it: sections citing the design
// document's two sections, the two files that will be gone, and a convention found in the sessions.
func docsPlanFor() string {
	section := func(key, title, kind string, sources map[string]interface{}) map[string]interface{} {
		full := map[string]interface{}{"docs": []interface{}{}, "code": []interface{}{}, "contracts": []interface{}{}, "sessions": nil}
		for k, v := range sources {
			full[k] = v
		}
		return map[string]interface{}{"id": "sec-" + key, "key": key, "position": 0, "title": title, "kind": kind, "covers": title + "讲什么。",
			"length": 400, "sources": full, "extra": map[string]interface{}{}}
	}
	doc := func(path, heading string) map[string]interface{} {
		if heading == "" {
			return map[string]interface{}{"path": path, "section": nil}
		}
		return map[string]interface{}{"path": path, "section": heading}
	}
	plan := map[string]interface{}{
		"spaceId": "space-1",
		"confirmed": map[string]interface{}{
			"version": 4, "status": "confirmed", "target": map[string]int{"min": 1, "max": 10},
			"categories": []interface{}{map[string]interface{}{"key": "ops", "title": "运维", "question": "runner 怎么跑", "forAgents": false, "extra": map[string]interface{}{}}},
			"newFields":  []interface{}{},
			"docs": []interface{}{map[string]interface{}{
				"category": "ops", "slug": "runner", "title": "Runner", "question": "runner 怎么领取和投递？", "audience": []string{"开发者：读完能讲清投递"},
				"scopeIn": []string{"传输", "投递"}, "scopeOut": []interface{}{}, "length": map[string]int{"min": 800, "max": 3000}, "protected": false,
				"extra": map[string]interface{}{},
				"sections": []interface{}{
					section("s1", "传输", "flow", map[string]interface{}{"docs": []interface{}{doc("docs/design.md", "1. 传输")}}),
					section("s2", "投递", "flow", map[string]interface{}{"docs": []interface{}{doc("docs/design.md", "2. 投递")}}),
					section("s3", "旧的领取", "concepts", map[string]interface{}{"docs": []interface{}{doc("docs/old.md", "")}}),
					section("s4", "派发", "concepts", map[string]interface{}{"docs": []interface{}{doc("docs/moved.md", "")}}),
					section("s5", "约定", "conventions", map[string]interface{}{"sessions": map[string]interface{}{
						"projects": []interface{}{}, "since": nil, "until": nil, "keywords": []string{"runner 宿主"}, "anchorPaths": []string{},
						"entryKinds": []string{"convention"}, "topics": []string{}, "evidence": "owner 说测试在哪跑",
					}}),
				},
			}},
		},
		"draft": nil, "proposals": []interface{}{}, "job": nil,
	}
	raw, _ := json.Marshal(plan)
	return string(raw)
}

// docsWrittenAt is `GET …/docs`: every section of the document written at `sha`, from material nobody can match.
func docsWrittenAt(sha string, keys ...string) string {
	var sections []interface{}
	for _, key := range keys {
		sections = append(sections, map[string]interface{}{"key": key, "materialSha256": strings.Repeat("0", 64), "repoSha": sha, "stale": false,
			"generatedAt": "2026-09-29T10:00:00.000Z"})
	}
	raw, _ := json.Marshal(map[string]interface{}{"spaceId": "space-1", "planVersion": 4, "docs": []interface{}{map[string]interface{}{
		"slug": "runner", "planVersion": 4, "status": "ok", "repoSha": sha, "updatedAt": "2026-09-29T10:00:00.000Z", "sections": sections,
	}}})
	return string(raw)
}

// docsAffectedAnswer is `GET …/maintenance/docs`: the convention to write again for an entry that fits it,
// an entry that fits nothing, and the commit the plan's references were checked at.
func docsAffectedAnswer(planSha string, unplaced ...map[string]interface{}) func() (int, string) {
	return func() (int, string) {
		if unplaced == nil {
			unplaced = []map[string]interface{}{}
		}
		raw, _ := json.Marshal(map[string]interface{}{
			"spaceId": "space-1",
			"plan":    map[string]interface{}{"version": 4, "confirmedAt": "2026-09-29T09:00:00.000Z", "repoSha": planSha, "draftedAt": "2026-09-28T09:00:00.000Z"},
			"build":   nil,
			"sections": []interface{}{map[string]interface{}{"doc": "runner", "key": "s5", "repoSha": planSha, "generatedAt": "2026-09-29T10:00:00.000Z",
				"stale": false, "entryIds": []string{"e-7"}}},
			"unplaced": unplaced, "unplacedMore": 0,
			"proposed": map[string]interface{}{"entryIds": []string{}, "commits": []string{}, "paths": []string{}},
		})
		return http.StatusOK, string(raw)
	}
}

// docsMaterialS5 is the server's half of the convention: the owner's words.
const docsMaterialS5 = `{"spaceId":"space-1","slug":"runner","section":"s5","planVersion":4,"condition":null,"entries":[],"records":[` +
	`{"kind":"turn","ref":"turn-7","found":"search","via":null,"weight":"decision","ownerWords":true,"label":"message","at":"2026-09-29T08:00:00.000Z",` +
	`"sessionId":"sess-7","sessionTitle":"协调会话","taskId":null,"taskTitle":null,"projectId":null,"projectTitle":null,"notePath":null,` +
	`"text":"全量测试在 runner 宿主上跑，别在引擎的 Bash 里跑。","chars":{"start":0,"end":27},"length":27}],"unresolved":[]}`

// docsRunModel is the model's side of the run's documents: a merge adopts everything, a section is written
// citing its first piece, and a plan proposal is answered from `proposals`, one answer a round.
type docsRunModel struct {
	mu        sync.Mutex
	prompts   []string
	proposals []string
}

func (m *docsRunModel) answer(prompt string) (int, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.prompts = append(m.prompts, prompt)
	title := ""
	if match := regexp.MustCompile(`「([^」]+)」（`).FindStringSubmatch(prompt); match != nil {
		title = match[1]
	}
	switch {
	case strings.Contains(prompt, "维护作业的 plan 修改建议"):
		if len(m.proposals) == 0 {
			return http.StatusOK, "放入：runner"
		}
		next := m.proposals[0]
		m.proposals = m.proposals[1:]
		return http.StatusOK, next
	case strings.Contains(prompt, "做「归并」"):
		var lines []string
		for _, id := range regexp.MustCompile(`(?m)^\[([A-Z]\d+)\] `).FindAllStringSubmatch(prompt, -1) {
			lines = append(lines, id[1]+" | 采用 | 讲的正是本节")
		}
		return http.StatusOK, strings.Join(lines, "\n") + "\n现状：\n- 本节的现状要点\n"
	case strings.Contains(prompt, "# 任务：写文档"):
		switch title {
		case "投递":
			return http.StatusOK, "### 投递\n一轮 turn 先落库再投递，至少投递一次，按 turn id 幂等[D1]。\n\n引文：\n[D1] 「至少投递一次，按 turn id 幂等」\n"
		case "约定":
			return http.StatusOK, "### 约定\n全量测试在 runner 宿主上跑[S1]。\n\n引文：\n[S1] 「全量测试在 runner 宿主上跑」\n"
		default:
			return http.StatusOK, "### " + title + "\n这一节讲的文件已不在 origin/main 上。\n"
		}
	}
	return http.StatusOK, "?"
}

func (m *docsRunModel) Prompts() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string{}, m.prompts...)
}

// docsWrites is every section a run wrote, by key, with the write that carried it.
func docsWrites(t *testing.T, door *fakeMaintainDoor) map[string]map[string]interface{} {
	t.Helper()
	out := map[string]map[string]interface{}{}
	for _, write := range door.of(http.MethodPost, "docs/runner") {
		sections, _ := write.body["sections"].([]interface{})
		for _, item := range sections {
			section, _ := item.(map[string]interface{})
			key, _ := section["key"].(string)
			section["_repoSha"] = write.body["repoSha"]
			section["_planVersion"] = write.body["planVersion"]
			out[key] = section
		}
	}
	return out
}

func keysOfWrites(writes map[string]map[string]interface{}) []string {
	var keys []string
	for key := range writes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// ── The sections the run's facts touched, and no other ──────────────────────────────────────────

func TestWikiMaintainWritesOnlyTheSectionsItsEntriesAndOriginMainTouched(t *testing.T) {
	f := docsRepo(t)
	written := f.first
	// After the documents were written, origin/main changed: the design document's section 2 (section 1 is
	// as it was), one cited file deleted, one renamed, and a design document nobody cites added.
	head := f.push(t, "the design moves on", func() {
		f.write(t, map[string]string{"docs/design.md": docsDesignAfter, "docs/old.md": "", "docs/moved.md": "",
			"docs/dispatch.md": "# 派发\n\n## 概要\n\n讲派发怎么把会话交给 runner。\n"})
	})
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f.maintainFixture, "tiered", 0, "tok-expect")
	door.propose = pendingForVerification
	door.docs = docsAffectedAnswer(written)
	door.plan = docsPlanFor()
	door.docsState = docsWrittenAt(written, "s1", "s2", "s3", "s4", "s5")
	door.material = map[string]string{"runner#s5": docsMaterialS5}
	var withdrawals []map[string]interface{}
	door.withdraw = func(body map[string]interface{}) (int, string) {
		withdrawals = append(withdrawals, body)
		return http.StatusOK, `{"spaceId":"space-1","withdrawn":2,"sections":[{"doc":"runner","key":"s3"},{"doc":"runner","key":"s4"}]}`
	}
	model := &docsRunModel{}
	vllm := newFakeVLLM(t, model.answer)
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	summary, err := runMaintainCLI(t)
	if err != nil || summary.Outcome != "succeeded" {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	d := summary.Report.Docs
	if d == nil || d.PlanVersion == nil || *d.PlanVersion != 4 || d.RepoSha != head {
		t.Fatalf("the documents' report = %+v, want plan version 4 at origin/main %s", d, head)
	}
	// The design document's section 2 changed and section 1 did not: only the section citing section 2 —
	// and the two citing the files that are gone — are the repository's; the convention is the entries'.
	if d.Affected.ByRepo != 3 || d.Affected.ByEntries != 1 || d.Affected.Unwritten != 0 || d.Affected.Total != 4 {
		t.Errorf("affected = %+v, want 3 by the repository (s2, s3, s4), 1 by the entries (s5), 4 in all", d.Affected)
	}
	writes := docsWrites(t, door)
	if got := keysOfWrites(writes); !reflect.DeepEqual(got, []string{"s2", "s3", "s4", "s5"}) {
		t.Errorf("the run wrote %v, want s2, s3, s4 and s5 — not s1, whose design-document section did not change", got)
	}
	if d.Sections.Written != 4 || d.Sections.Failed != 0 {
		t.Errorf("sections = %+v, want 4 written", d.Sections)
	}
	// Written at the commit the comparison was made at: the section's repoSha and its footnote's sha are the new commit.
	s2 := writes["s2"]
	if s2["_repoSha"] != head || s2["_planVersion"] != float64(4) {
		t.Errorf("s2 was written at %v from version %v, want %s from 4", s2["_repoSha"], s2["_planVersion"], head)
	}
	footnotes, _ := s2["footnotes"].([]interface{})
	if len(footnotes) != 1 || footnotes[0].(map[string]interface{})["sha"] != head || footnotes[0].(map[string]interface{})["path"] != "docs/design.md" ||
		footnotes[0].(map[string]interface{})["verified"] != true {
		t.Errorf("s2's footnote = %v, want docs/design.md at %s, its quote found there", footnotes, head)
	}
	// Only the sections' own files were read: the design document's section 1 twice (at both commits),
	// nothing of README or src.
	for _, prompt := range model.Prompts() {
		if strings.Contains(prompt, "「传输」（") && (strings.Contains(prompt, "# 任务：写文档") || strings.Contains(prompt, "做「归并」")) {
			t.Errorf("section 1 was taken up though what it cites did not change")
		}
	}
	// The files gone: withdrawn once, at the new commit, deleted and renamed as git says.
	if len(withdrawals) != 1 {
		t.Fatalf("withdrawals = %v, want one", withdrawals)
	}
	if withdrawals[0]["repoSha"] != head {
		t.Errorf("the withdrawal names %v, want the new commit %s", withdrawals[0]["repoSha"], head)
	}
	gone, _ := json.Marshal(withdrawals[0]["paths"])
	if string(gone) != `[{"change":"renamed","path":"docs/moved.md","to":"docs/dispatch.md"},{"change":"deleted","path":"docs/old.md"}]` {
		t.Errorf("the paths withdrawn = %s", gone)
	}
	if d.Withdrawn.Paths != 2 || d.Withdrawn.Sentences != 2 {
		t.Errorf("withdrawn = %+v, want 2 sentences citing 2 files", d.Withdrawn)
	}
	// Every call as the maintenance session, and the model's tokens counted with the run's.
	for _, call := range door.calls() {
		if call.session != "maintenance-session" {
			t.Errorf("%s %s went as session %q", call.method, call.path, call.session)
		}
	}
	if summary.Report.Tokens.Calls == 0 || summary.Report.Tokens.Input == 0 {
		t.Errorf("the documents' model calls are not in the run's tokens: %+v", summary.Report.Tokens)
	}
	text := describeWikiMaintainSummary(summary)
	for _, want := range []string{"documents (plan version 4", "4 sections to write again — 1 by the entries, 3 by the repository", "withdrawn: 2 sentences citing 2 files"} {
		if !strings.Contains(text, want) {
			t.Errorf("the summary does not say %q:\n%s", want, text)
		}
	}
}

// ── A design document no section cites is one proposal ───────────────────────────────────────────

func TestWikiMaintainProposesOneChangeForANewDesignDocumentNoSectionCites(t *testing.T) {
	f := docsRepo(t)
	written := f.first
	head := f.push(t, "a new design document", func() {
		f.write(t, map[string]string{"docs/new-design.md": docsNewDesign, "docs/mocks/screen.md": "# 效果图\n\n一张图。\n",
			"docs/evidence/run.md": "# 证据\n\n跑的记录。\n"})
	})
	added := mustGit(t, f.seed, "log", "-1", "--format=%H", "--", "docs/new-design.md")
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f.maintainFixture, "tiered", 0, "tok-expect")
	door.propose = pendingForVerification
	door.docs = docsAffectedAnswer(written, map[string]interface{}{"id": "e-9", "kind": "concept", "title": "Codex 登录由服务器保管",
		"summary": "登录只在服务器上，runner 用时下发。", "topics": []string{}, "anchorPaths": []string{}, "changedAt": "2026-09-30T01:00:00.000Z"})
	door.plan = docsPlanFor()
	door.docsState = docsWrittenAt(written, "s1", "s2", "s3", "s4", "s5")
	door.material = map[string]string{"runner#s5": docsMaterialS5}
	var proposals []map[string]interface{}
	door.proposals = func(body map[string]interface{}) (int, string) {
		proposals = append(proposals, body)
		if len(proposals) == 1 {
			return http.StatusUnprocessableEntity, `{"code":"WIKI_PLAN_GATE","message":"The proposal did not pass the plan's gate (schema): 1 error.",` +
				`"errors":[{"check":"schema","path":"change.doc.sections[5].covers","message":"is at most 2000 characters"}]}`
		}
		return http.StatusOK, `{"id":"proposal-1","status":"pending"}`
	}
	good := "放入：runner\n理由：新设计文档 docs/new-design.md 讲 Codex 登录由服务器保管和下发，plan 里没有一节讲它；放进《Runner》新增一节。\n覆盖：K1、K2\n" +
		"### 1. 账号代管 | concepts | 400\n讲什么：登录由服务器保管，runner 用时下发。\n- 文档：docs/new-design.md § 1. 保管\n"
	model := &docsRunModel{proposals: []string{
		// Round 1: a section heading origin/main does not have — this runner's gate finds it.
		strings.Replace(good, "§ 1. 保管", "§ 9. 不存在", 1),
		// Round 2: the server's gate finds something; round 3 passes.
		good,
		good,
	}}
	vllm := newFakeVLLM(t, model.answer)
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	summary, err := runMaintainCLI(t)
	if err != nil || summary.Outcome != "succeeded" {
		t.Fatalf("orbit wiki maintain: %v\n%+v", err, summary)
	}
	d := summary.Report.Docs
	if d == nil || d.Unplaced.DesignDocs != 1 || d.Unplaced.Entries != 1 {
		t.Fatalf("unplaced = %+v, want the one design document (not docs/mocks, not docs/evidence) and the one entry", d)
	}
	p := d.Proposal
	if p == nil || p.Outcome != "proposed" || p.ID != "proposal-1" || p.Doc != "runner" || p.NewDoc || p.Facts != 2 || p.Rounds != 3 {
		t.Fatalf("proposal = %+v, want proposal-1 on runner, from 2 facts, on round 3", p)
	}
	// One proposal a run: the gate's refusal was answered by a second send, not by a second proposal.
	if len(proposals) != 2 {
		t.Fatalf("the run sent %d proposals, want the refused one and the one that passed", len(proposals))
	}
	last := proposals[1]
	facts, _ := json.Marshal(last["facts"])
	if want := `[{"id":"` + added + `","kind":"commit"},{"id":"e-9","kind":"entry"}]`; string(facts) != want {
		t.Errorf("facts = %s, want the commit that added the document (%s) and the entry", facts, added)
	}
	if reason, _ := last["reason"].(string); !strings.Contains(reason, "docs/new-design.md") {
		t.Errorf("the reason does not say what the knowledge is: %q", reason)
	}
	change := last["change"].(map[string]interface{})
	doc := change["doc"].(map[string]interface{})
	sections := doc["sections"].([]interface{})
	if doc["slug"] != "runner" || len(sections) != 6 {
		t.Fatalf("the change = %v, want the plan's document with one section more", doc)
	}
	for i, key := range []string{"s1", "s2", "s3", "s4", "s5"} {
		if sections[i].(map[string]interface{})["key"] != key {
			t.Errorf("section %d of the change is %v, want the plan's %s kept as it was", i, sections[i], key)
		}
	}
	added6 := sections[5].(map[string]interface{})
	source, _ := json.Marshal(added6["sources"].(map[string]interface{})["docs"])
	if added6["title"] != "账号代管" || added6["kind"] != "concepts" || string(source) != `[{"path":"docs/new-design.md","section":"1. 保管"}]` {
		t.Errorf("the new section = %v", added6)
	}
	// What the model was told: the knowledge — the design document with its headings, and the entry — and the plan.
	var asked []string
	for _, prompt := range model.Prompts() {
		if strings.Contains(prompt, "维护作业的 plan 修改建议") {
			asked = append(asked, prompt)
		}
	}
	if len(asked) != 3 {
		t.Fatalf("the proposal was asked %d times, want 3 rounds", len(asked))
	}
	// One place, one subject: what does not belong with the group waits for the next run.
	for _, want := range []string{"[K1] 新设计文档 docs/new-design.md「账号代管」", "## 1. 保管", "[K2] 条目（concept）「Codex 登录由服务器保管」", "`runner`《Runner》",
		"留给下一次维护作业再提", "不要为了一次放完，把不相干的知识凑进同一篇或同一节"} {
		if !strings.Contains(asked[0], want) {
			t.Errorf("the proposal prompt does not say %q", want)
		}
	}
	for _, never := range []string{"docs/mocks/screen.md", "docs/evidence/run.md"} {
		if strings.Contains(asked[0], never) {
			t.Errorf("the proposal prompt offers %s, which is no design document", never)
		}
	}
	if !strings.Contains(asked[1], "9. 不存在") || !strings.Contains(asked[1], "上一次的答案有这些问题") {
		t.Errorf("round 2 was not told what this runner's gate found")
	}
	if !strings.Contains(asked[2], "is at most 2000 characters") {
		t.Errorf("round 3 was not told what the server's gate found")
	}
	_ = head
}

// ── No confirmed plan, no document ──────────────────────────────────────────────────────────────

// 10-01 10:40Z: a proposal's session condition named its kind `decision`, in backticks, and the server's gate
// refused it three rounds running with «`decision` is no kind of entry: one of principle, convention, decision,
// …», which reads as decision refused for being decision. The run reads a closed-set value as what its wrapping
// holds before it sends the proposal (contract `plan.gate.values`), and names back what it refuses quoted.
func TestWikiMaintainProposalReadsAWrappedKindBareAndNamesWhatItRefusesQuoted(t *testing.T) {
	raw, _ := json.Marshal(planBase())
	var plan wikiPlanVersionRead
	if err := json.Unmarshal(raw, &plan); err != nil {
		t.Fatal(err)
	}
	items := []wikiProposalItem{{ID: "K1", entry: &wikiUnplacedEntry{ID: "entry-1", Kind: "convention", Title: "收工前 rebase 到 main"}}}
	answer := parseWikiProposal("放入：storage\n理由：收工的约定没有地方放。\n覆盖：K1\n" +
		"### 1. 收工约定 | conventions | 300\n讲什么：收工前 rebase 到 main、写明分支和 sha、不自己 merge。\n" +
		"- 会话：关键词 rebase、merge；kind `decision`/\"convention\"；主题 `storage-topic`；要找：owner 说收工前要 rebase 的原话\n")
	request, problems := assembleWikiProposal(plan, answer, items, nil)
	if len(problems) != 0 {
		t.Fatalf("a wrapped kind was refused: %v", problems)
	}
	sections := request.Change.Doc.Sections
	sessions := sections[len(sections)-1].Sources.Sessions
	if sessions == nil || !reflect.DeepEqual(sessions.EntryKinds, []string{"decision", "convention"}) || !reflect.DeepEqual(sessions.Topics, []string{"storage-topic"}) {
		t.Errorf("the proposal carries the session condition %+v, want its kinds and topic bare", sessions)
	}

	answer = parseWikiProposal("放入：`storage-docs`\n理由：收工的约定没有地方放。\n覆盖：K1、K7\n" +
		"### 1. 收工约定 | convention | 300\n讲什么：收工前 rebase 到 main。\n- 会话：关键词 rebase\n")
	_, problems = assembleWikiProposal(plan, answer, items, nil)
	for _, want := range []string{
		`「覆盖」里的 "K7" 不是新知识的编号`,
		`第 1 节的 type "convention" 不是节的类型`,
		`「放入」"storage-docs" 不是目录里的一篇`,
	} {
		found := false
		for _, problem := range problems {
			found = found || strings.HasPrefix(problem, want)
		}
		if !found {
			t.Errorf("the problems do not say %q: %v", want, problems)
		}
	}
}

func TestWikiMaintainWritesNoDocumentWithoutAConfirmedPlan(t *testing.T) {
	f := docsRepo(t)
	door := newFakeMaintainDoor(t)
	door.context = maintainContext(f.maintainFixture, "tiered", 0, "tok-expect")
	door.propose = pendingForVerification
	// The server's answer for a space whose plan nobody confirmed (the fake door's default).
	vllm := newFakeVLLM(t, (&docsRunModel{}).answer)
	fakeVerifyClaude(t)
	wikiMaintainSession(t, door.URL, vllm)

	summary, err := runMaintainCLI(t)
	if err != nil || summary.Outcome != "succeeded" {
		t.Fatalf("a run with no confirmed plan still succeeds: %v %+v", err, summary)
	}
	if d := summary.Report.Docs; d == nil || d.Skipped != "no_confirmed_plan" || d.PlanVersion != nil || d.Proposal != nil {
		t.Errorf("documents = %+v, want none written: no confirmed plan", d)
	}
	for _, call := range door.calls() {
		route := strings.TrimPrefix(call.path, "/api/runner/wiki/spaces/space-1/")
		if route == "plan" || route == "docs" || strings.HasPrefix(route, "docs/") || route == "maintenance/docs/withdrawals" || route == "plan/proposals" {
			t.Errorf("%s %s was called with no confirmed plan", call.method, route)
		}
	}
	if len(door.of(http.MethodGet, "maintenance/docs")) != 1 {
		t.Errorf("the run did not ask what to write")
	}
	if !strings.Contains(describeWikiMaintainSummary(summary), "no confirmed plan") {
		t.Errorf("the summary does not say there is no confirmed plan:\n%s", describeWikiMaintainSummary(summary))
	}
	end := finished(t, door)
	report, _ := end["report"].(map[string]interface{})
	docs, _ := report["docs"].(map[string]interface{})
	if docs["skipped"] != "no_confirmed_plan" || docs["planVersion"] != nil {
		t.Errorf("the report the server kept says %v", docs)
	}
}

// ── The contract's numbers ──────────────────────────────────────────────────────────────────────

func TestWikiMaintainDocsIsTheContracts(t *testing.T) {
	job := wikiContract(t)["maintenance"].(map[string]interface{})["job"].(map[string]interface{})
	docs := job["docs"].(map[string]interface{})
	rules := docs["rules"].(map[string]interface{})
	if int(rules["proposalRoundsMax"].(float64)) != wikiMaintainProposalRoundsMax || int(rules["proposalItemsMax"].(float64)) != wikiMaintainProposalItemsMax {
		t.Errorf("maintenance.job.docs.rules = %v, this build has %d rounds and %d items", rules, wikiMaintainProposalRoundsMax, wikiMaintainProposalItemsMax)
	}
	var skipped []string
	for _, reason := range docs["skipped"].([]interface{}) {
		skipped = append(skipped, reason.(string))
	}
	if !reflect.DeepEqual(skipped, []string{"no_confirmed_plan", "no_server_support"}) {
		t.Errorf("maintenance.job.docs.skipped = %v", skipped)
	}
	routes := job["routes"].(map[string]interface{})
	maintenance := wikiContract(t)["agentSurface"].(map[string]interface{})["doors"].(map[string]interface{})["runner"].(map[string]interface{})["maintenanceRoutes"].([]interface{})
	for name, path := range map[string]string{
		"docs": "GET /api/runner/wiki/spaces/:id/maintenance/docs", "withdraw": "POST /api/runner/wiki/spaces/:id/maintenance/docs/withdrawals",
	} {
		if routes[name] != path {
			t.Errorf("maintenance.job.routes.%s = %v, this build calls %s", name, routes[name], path)
		}
		found := false
		for _, route := range maintenance {
			found = found || route == path
		}
		if !found {
			t.Errorf("%s is not a runner-door maintenance route", path)
		}
	}
	// No step of the run writes the topic articles any more; the documents step comes after the anchors.
	var steps []string
	for _, step := range job["run"].(map[string]interface{})["steps"].([]interface{}) {
		steps = append(steps, strings.SplitN(step.(string), ":", 2)[0])
	}
	if !reflect.DeepEqual(steps, []string{"context", "checkout", "dossiers", "extract", "self-check", "breaker", "propose", "verify", "anchors", "docs", "finish"}) {
		t.Errorf("the run's steps = %v", steps)
	}
	if !contains(wikiPlanFactKinds, "commit") {
		t.Errorf("a proposal cannot name the commit that added a design document: %v", wikiPlanFactKinds)
	}
	for _, excluded := range wikiMaintainDocsExcluded {
		if !strings.Contains(docs["unplaced"].(string), strings.TrimSuffix(excluded, "/")) {
			t.Errorf("maintenance.job.docs.unplaced does not leave out %s", excluded)
		}
	}
}
