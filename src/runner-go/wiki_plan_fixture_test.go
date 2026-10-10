package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The plan's deterministic half, held to one fixture that the server's TypeScript port is held to as well
// (src/apiserver/src/wiki-worker/wiki-plan-golden.spec.ts): the line format read back, the repository's
// references checked, the materials laid out, every step's prompt, and what the gate makes of a round's answers
// — the draft it assembles, the errors it finds and the repository check it reports. Both paths run side by side
// until P10 (contract `plan.jobs.server`), and the project's criterion asks that the same materials give the same
// gate conclusions on both.
//
// The repository is a real checkout read the runner's way (wikiPlanRepo), and what crosses to the server is what
// the runner's repository operations hand it: the snapshot index wiki-repo-op/v1 builds of the same checkout
// (wikiRepoOpSnapshot) and the text of each file a read would answer with. Every input is this file's, and every
// output is this code's. To write them again after a deliberate change to it:
//
//	ORBIT_WIKI_PLAN_FIXTURE=write go test -run TestWikiPlanFixtureIsTheServersToo .
//
// and then make the TypeScript port answer the same.

const wikiPlanFixturePath = "../shared/src/wiki-plan.fixture.json"

// The day every prompt's head names: a fixture written today and checked tomorrow must read the same.
const wikiPlanFixtureDate = "2026-10-08"

type wikiPlanFixtureCheck struct {
	Kind  string `json:"kind"`
	Where string `json:"where"`
	What  string `json:"what,omitempty"`
	Found bool   `json:"found"`
}

type wikiPlanFixtureRead struct {
	Kind string      `json:"kind"`
	Text string      `json:"text"`
	Read interface{} `json:"read"`
}

type wikiPlanFixtureRound struct {
	Name         string                 `json:"name"`
	Kind         string                 `json:"kind"`
	Target       wikiPlanLength         `json:"target"`
	Base         json.RawMessage        `json:"base"`
	Instructions string                 `json:"instructions"`
	Catalogue    string                 `json:"catalogue"`
	Details      wikiPlanFixtureAnswers `json:"details"`
	Outlines     wikiPlanFixtureAnswers `json:"outlines"`
	Rewrites     wikiPlanFixtureAnswers `json:"rewrites"`
	Prompts      map[string]string      `json:"prompts"`
	Draft        json.RawMessage        `json:"draft"`
	Errors       []wikiPlanGateError    `json:"errors"`
	RepoCheck    wikiPlanRepoCheck      `json:"repoCheck"`
}

// wikiPlanFixtureAnswers are a round's answers to one step, unit by unit, in the order the fixture lists them:
// the fixture is held byte for byte, and a map would write them sorted.
type wikiPlanFixtureAnswers []wikiPlanFixtureAnswer

type wikiPlanFixtureAnswer struct{ unit, text string }

func (a wikiPlanFixtureAnswers) answer(unit string) (string, bool) {
	for _, x := range a {
		if x.unit == unit {
			return x.text, true
		}
	}
	return "", false
}

// MarshalJSON writes the answers as one object, each unit's in its place.
func (a wikiPlanFixtureAnswers) MarshalJSON() ([]byte, error) {
	if a == nil {
		return []byte("null"), nil
	}
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	b.WriteByte('{')
	for i, x := range a {
		if i > 0 {
			b.WriteByte(',')
		}
		if err := encoder.Encode(x.unit); err != nil {
			return nil, err
		}
		b.Truncate(b.Len() - 1)
		b.WriteByte(':')
		if err := encoder.Encode(x.text); err != nil {
			return nil, err
		}
		b.Truncate(b.Len() - 1)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

type wikiPlanFixture struct {
	Why       string                 `json:"why"`
	Write     string                 `json:"write"`
	Date      string                 `json:"date"`
	Files     map[string]string      `json:"files"`
	Index     json.RawMessage        `json:"index"`
	Materials json.RawMessage        `json:"materials"`
	Texts     map[string]string      `json:"texts"`
	Checks    []wikiPlanFixtureCheck `json:"checks"`
	Reads     []wikiPlanFixtureRead  `json:"reads"`
	Rounds    []wikiPlanFixtureRound `json:"rounds"`
}

// ── The inputs ──────────────────────────────────────────────────────────────────────────────────────

// wikiPlanFixtureFiles is the repository: documents with code fences, numbered and parenthesised headings and
// a mockup; code in Go, TypeScript (a controller, a function no export names) and Swift; a directory of more
// than forty files; a schema; contracts.
func wikiPlanFixtureFiles() map[string]string {
	files := map[string]string{
		"README.md":            "# App\n\nApp is the spec's small service: it serves what its store keeps, and its tests run on fixtures.\n",
		"docs/README.md":       "# Docs\n\nStart with the architecture.\n\n## 入门\n\nRead it first.\n\n### 安装\n\nnpm ci.\n",
		"docs/architecture.md": "# Architecture\n\nApp is a server and a store.\n\n## Execution model\n\nThe server serves.\n\n## Realtime and recovery\n\nIt recovers.\n\n### 2. 加固后的恢复策略（契约 §6.4、§6.5）\n\nHardened.\n",
		"docs/wiki-design.md": "# Wiki design\n\n## 4. 写路径\n\nWrites.\n\n### 4.4 锚点\n\nAnchors.\n\n### 4.5 数据模型（新表 `share_link`）\n\nTables.\n\n" +
			"```md\n## 这不是一个章节\n```\n\n## 5. 运维 — 部署\n\nDeploys.\n",
		"docs/mocks/21-plan.md": "# A mock\n\n## Mock heading\n",
		"docs/evidence/run.md":  "# Evidence\n\n## Not a document\n",
		"notes/ops.md":          "# Ops notes\n\n## On call\n",
		"src/app/main.go":       "package app\n\ntype Server struct{}\n\nfunc Serve() error { return nil }\n\nfunc (s *Server) Handle() {}\n",
		"src/app/store.go":      "package app\n\ntype Store struct{}\n\nfunc (s *Store) Save() error { return nil }\n\nconst storeVersion = 2\n",
		"src/app/store_test.go": "package app\n\nfunc TestStoreSaves() {}\n",
		"src/web/client.ts":     "export class Client {\n  fetchPlan() {\n    return localHelper();\n  }\n}\n\nexport function render() {}\n\nfunction localHelper() {\n  return 1;\n}\n",
		"src/web/api.controller.ts": "import { Controller, Get, Post } from '@nestjs/common';\n\n@Controller('items')\nexport class ItemsController {\n" +
			"  @Get(':id')\n  find() {\n    return 1;\n  }\n\n  @Post()\n  create() {\n    return 2;\n  }\n}\n",
		"src/web/main.tsx":                   "export function App() {\n  return null;\n}\n",
		"src/ios/ContentView.swift":          "import SwiftUI\n\nstruct ContentView: View {\n    var body: some View { Text(\"hi\") }\n    func refresh() {}\n}\n\nextension ContentView {\n    private func hidden() {}\n}\n",
		"src/apiserver/prisma/schema.prisma": "model User {\n  id String @id\n}\n\nmodel Space {\n  id String @id\n}\n",
		"src/apiserver/src/app.module.ts":    "export class AppModule {}\n",
		"contracts/app.contract.json":        "{\"name\":\"app\",\"routes\":[],\"version\":1}\n",
		"contracts/wiki.contract.json":       "{\"a\":1,\"b\":2,\"c\":3,\"d\":4,\"e\":5,\"f\":6,\"g\":7,\"h\":8,\"i\":9,\"j\":10,\"k\":11,\"l\":12,\"m\":13,\"n\":14,\"o\":15}\n",
		"package.json":                       "{\"name\":\"app\"}\n",
	}
	for i := 1; i <= 23; i++ {
		files[fmt.Sprintf("src/big/alpha_%02d.go", i)] = fmt.Sprintf("package big\n\nfunc Alpha%02d() {}\n", i)
		files[fmt.Sprintf("src/big/beta-%02d.go", i)] = fmt.Sprintf("package big\n\nfunc Beta%02d() {}\n", i)
	}
	return files
}

// wikiPlanFixtureMaterials is what the plan's materials route answers for the fixture's space: projects (two
// sharing a title), sessions enough to cluster, entries and topics.
func wikiPlanFixtureMaterials() map[string]interface{} {
	var sessions []interface{}
	themes := []string{"存储改造 store save", "端口写死 port config", "plan draft 起草目录", "runner heartbeat 心跳", "wiki import 导入笔记"}
	for i := 0; i < 30; i++ {
		theme := themes[i%len(themes)]
		title := fmt.Sprintf("%s 第%d轮", theme, i/len(themes)+1)
		switch i % 8 {
		case 0:
			title = "执行任务：" + title
		case 4:
			title = "Task: " + title
		}
		var project interface{}
		if i%3 == 0 {
			project = "App 项目"
		}
		sessions = append(sessions, map[string]interface{}{"title": title, "month": fmt.Sprintf("2026-%02d", 8+i%2), "task": i%4 == 0,
			"project": project, "provider": []string{"claude", "codex", "kimi"}[i%3]})
	}
	sessions = append(sessions,
		map[string]interface{}{"title": "Judgment: App 项目", "month": "2026-09", "task": false, "project": "App 项目", "provider": "claude"},
		map[string]interface{}{"title": "判断：App 项目", "month": "2026-08", "task": false, "project": "App 项目", "provider": "codex"})
	return map[string]interface{}{
		"spaceId": "space-1", "title": "App", "asOf": "2026-10-08T00:00:00.000Z",
		"repo":      map[string]interface{}{"urlNorm": "github.com/acme/app", "rootCommitSha": nil},
		"workspace": map[string]interface{}{"id": "ws-1", "workDir": "~/app"},
		"projects": []interface{}{
			map[string]interface{}{"id": "p1", "title": "App 项目", "status": "OPEN", "createdAt": "2026-09-01T00:00:00.000Z", "tasks": 12, "sessions": 9},
			map[string]interface{}{"id": "p2", "title": "同名项目", "status": "OPEN", "createdAt": "2026-09-02T00:00:00.000Z", "tasks": 1, "sessions": 0},
			map[string]interface{}{"id": "p3", "title": "同名项目", "status": "DONE", "createdAt": "2026-09-03T00:00:00.000Z", "tasks": 1, "sessions": 0},
			map[string]interface{}{"id": "p4", "title": "把「什么算完成」从项目末尾搬到开工前", "status": "OPEN", "createdAt": "2026-09-04T00:00:00.000Z", "tasks": 3, "sessions": 2},
		},
		"sessions": map[string]interface{}{"days": 90, "total": 33, "items": sessions},
		"entries": []interface{}{
			map[string]interface{}{"kind": "convention", "status": "active", "count": 2},
			map[string]interface{}{"kind": "pitfall", "status": "active", "count": 3},
		},
		"topics": []interface{}{
			map[string]interface{}{"slug": "storage-topic", "title": "存储", "category": "data", "pathPrefixes": []interface{}{"src/app/"}, "active": 3,
				"recent": []interface{}{map[string]interface{}{"kind": "pitfall", "title": "端口不能写死"}}},
			map[string]interface{}{"slug": "ops-topic", "title": "运维", "category": nil, "pathPrefixes": []interface{}{}, "active": 0, "recent": []interface{}{}},
		},
	}
}

// What a model writes, right and wrong: the catalogue, a category's details and a document's outline.
const wikiPlanFixtureCatalogue = "A preamble that does not count\n## 1. Product `product` — What this service is and how it works\n" +
	"- 1.1 Service overview `service-overview` | What this service is and what it is made of | Includes: purpose; components; entry points\n" +
	"- 1.2 Storage `storage` | How data is stored and read | Includes: Store; saving\n" +
	"- 1.3 Interfaces `api` | What interfaces there are | Includes: routes; the client | Note: extra\n" +
	"## 2. Development conventions `dev` — The conventions for the agents that write code [agents]\n" +
	"- 2.1 Testing conventions `testing` | How to run the tests | Includes: go test; fixtures\n"

const wikiPlanFixtureDetailsProduct = "### 1.1 Service overview\nAudience: developers new to the project: can name the parts of the service once they have read it\n" +
	"Includes: purpose; components; entry points\nExcludes: storage details (see 1.2); interfaces and testing (see 1.3 and 2.1)\n" +
	"Length: 800–1200 characters\nDocs: docs/architecture.md, docs/README.md\nCode: src/app/\nContracts: contracts/app.contract.json\n" +
	"Topics: storage-topic\nProjects: 「App 项目」\n\n### 1.2 Storage\nAudience: people who write storage code: can change Store once they have read it\n" +
	"Includes: the structure of Store; the saving flow\nExcludes: how to run the tests (see 2.1)\nLength: 600–900 characters\nDocs: docs/wiki-design.md\n" +
	"Code: src/app/store.go\nContracts: none\nTopics: none\nProjects: none\n\n### 1.3 Interfaces\n" +
	"Audience: people who call the interfaces: can call ItemsController once they have read it\nIncludes: routes; the client\n" +
	"Excludes: storage (see 9.9)\nLength: about 700 characters\nDocs: docs/missing.md\nCode: src/web/ (client.ts, api.controller.ts)\n" +
	"Contracts: contracts/app.contract.json\nTopics: none\nProjects: 「同名项目」\n"

const wikiPlanFixtureDetailsDev = "### 2.1 Testing conventions\nAudience: agents that write code: know how to run the tests once they have read it\nIncludes: go test; fixtures\n" +
	"Excludes: storage (see 1.2)\nLength: 400–600 characters\nDocs: none\nCode: src/web/\nContracts: none\nTopics: none\nProjects: none\n"

const wikiPlanFixtureOutlineOverview = "### 1. Overview | overview | 200\nCovers: sums up sections 2 and 3.\n### 2. Components | concepts | 400\n" +
	"Covers: the two components, Server and Store; storage details: see 1.2.\n- Docs: docs/architecture.md § Execution model\n" +
	"- Docs: docs/architecture.md § Realtime and recovery - 2. 加固后的恢复策略（契约 §6.4、§6.5）\n- Code: src/app/main.go: Server, Serve(), Server.Handle\n" +
	"- Contracts: contracts/app.contract.json\n### 3. Known pitfalls | pitfalls | 300\nCovers: the pitfalls at startup.\n" +
	"- Sessions: projects 「App 项目」「同名项目」「`App 项目`」; dates 2026-09-01 to now; keywords startup, port; anchors src/app/; kind `pitfall`/\"decision\"/dicision; topics storage-topic, \"ops-topic\", nope-topic; look for: the owner's words saying the port must not be hard-coded\n" +
	"### 4. Operations | ops | 200\nCovers: deployment, see 4.4; see also 1.3, 1.1.\n- Docs: docs/wiki-design.md § 5. 运维 — 部署\n" +
	"- Docs: notes/ops.md § whole document\n"

const wikiPlanFixtureOutlineStorage = "### 1. The saving flow | flow | 500\nCovers: how Store.Load reads, see 9.9.\n- Docs: docs/wiki-design.md § 5. A section that is not there\n" +
	"- Docs: docs/wiki-design.md § 4. 写路径 - 4.4 锚点, § (4.5 数据模型（新表 `share_link`）)\n- Code: src/app/store.go: Store.Save, Store.Load, storeVersion\n" +
	"- Code: src/app/missing.go: Foo\n- Note: this line is not in the format\n### 2. Conventions | conventions | two hundred\n" +
	"Covers: validate before saving,\nthe validation lives in Save.\n" +
	"- Sessions: projects 「把「什么算完成」从项目末尾搬到开工前」; dates 2026-09-30 to 2026-09-01; an unknown part\n### 3. Miscellany | misc | 100\nCovers: the rest.\n"

const wikiPlanFixtureOutlineAPI = "### 1. Routes | interface | 400\nCovers: the routes of ItemsController.\n" +
	"- Code: src/web/api.controller.ts: ItemsController.find [GET /api/items/:id], ItemsController.create, ItemsController.destroy\n" +
	"- Code: src/web/client.ts: Client.fetchPlan, localHelper, render(); src/web/*.tsx: App()\n" +
	"- Code: src/ios/ContentView.swift: ContentView, refresh(), ext ContentView, hidden()\n- Code: src/**/schema.prisma: User\n"

const wikiPlanFixtureOutlineTesting = "### 1. How to run the tests | conventions | 300\nCovers: run them with go test; for the components, see 1.1.\n" +
	"- Code: src/web/client.ts: Client.fetchPlan, render()\n- Code: src/app/store_test.go: TestStoreSaves\n"

const wikiPlanFixtureRewriteTesting = "Title: Testing conventions\nQuestion: How do I run the tests?\nAudience: agents that write code: know how to run the tests once they have read it\n" +
	"Includes: go test; validate before saving\nLength: 400–600 characters\n### 1. How to run the tests | conventions | 300\n" +
	"Covers: run them with go test.\n- Code: src/web/client.ts: render()\n### 2. Saving conventions | conventions | 200\n" +
	"Covers: validate before saving, see 1.2.\n- Sessions: projects 「App 项目」「p2」; keywords 保存; kind convention; look for: owner 说保存前要校验的原话\n"

const wikiPlanFixtureRevisionMoves = "## 1. Product `product` — What this service is\n- 1.1 Service overview `service-overview` | What it is | Sources: 1.1 | Includes: purpose\n" +
	"- 1.2 Storage `storage` | How it is stored | Sources: 1.2 | Includes: saving\n" +
	"- 1.3 Storage decisions `storage-decisions` | Why it is stored this way | Sources: none | Includes: decisions\n" +
	"- 1.4 Merged `merged` | Put together | Sources: 1.1, 1.2 | Includes: merging\n" +
	"## 2. Development conventions `dev` — Conventions for the agents [agents]\n" +
	"- 2.1 Testing conventions `testing` | How to run the tests | Sources: 2.1 | Includes: go test\n### Sections moved into the agents' category\n" +
	"- 1.1 §3 → 2.1\n- 1.2 §3 → 2.1\n- 1.2 §9 → 2.1\n- 7.7 §1 → 2.1\n- 1.2 §2 → 1.2\n- 2.1 §1 → 9.9\n"

const wikiPlanFixtureRevisionGood = "## 1. Product `product` — What this service is\n- 1.1 Service overview `service-overview` | What it is | Sources: 1.1 | Includes: purpose\n" +
	"- 1.2 Storage `storage` | How it is stored | Sources: 1.2 | Includes: saving\n" +
	"## 2. Development conventions `dev` — Conventions for the agents [agents]\n" +
	"- 2.1 Testing conventions `testing` | How to run the tests, and the validation before saving | Sources: 2.1 | Includes: go test; validate before saving\n" +
	"### Sections moved into the agents' category\n- 1.2 §2 → 2.1\n"

const wikiPlanFixtureLeavesProtectedOut = "## 1. Product `product` — What it is\n- 1.1 Storage `storage` | How it is stored | Includes: saving\n" +
	"## 2. Development conventions `development` — Conventions [agents]\n- 2.1 Testing conventions `testing` | How to test | Includes: go test\n"

// wikiPlanFixtureBase is a confirmed version of three documents, the first protected, whose sections name
// a project by title and by an id, and a protected document that leaves a scope to another.
func wikiPlanFixtureBase() json.RawMessage {
	base := planBase()
	docs := base["docs"].([]interface{})
	overview := docs[0].(map[string]interface{})
	overview["scopeOut"] = []interface{}{map[string]interface{}{"text": "存储细节", "docs": []interface{}{"storage"}}}
	section := docs[1].(map[string]interface{})["sections"].([]map[string]interface{})[1]
	section["sources"] = map[string]interface{}{"docs": []interface{}{}, "code": []interface{}{map[string]interface{}{"path": "src/app/store.go", "symbols": []interface{}{"Store.Save"}}},
		"contracts": []interface{}{},
		"sessions": map[string]interface{}{"projects": []interface{}{
			map[string]interface{}{"id": "p1", "title": "App 项目"}, map[string]interface{}{"id": "p2", "title": "同名项目"}},
			"since": nil, "until": nil, "keywords": []interface{}{"保存"}, "anchorPaths": []interface{}{}, "entryKinds": []interface{}{"convention"},
			"topics": []interface{}{}, "evidence": "owner 说保存前要校验的原话"}}
	raw, _ := json.Marshal(base)
	return raw
}

// wikiPlanFixtureRounds are the rounds: what a run is asked to draft, and the answers its model gives.
func wikiPlanFixtureRounds() []wikiPlanFixtureRound {
	draftAnswers := func(r wikiPlanFixtureRound) wikiPlanFixtureRound {
		r.Details = wikiPlanFixtureAnswers{{"1", wikiPlanFixtureDetailsProduct}, {"2", wikiPlanFixtureDetailsDev}}
		r.Outlines = wikiPlanFixtureAnswers{{"service-overview", wikiPlanFixtureOutlineOverview}, {"storage", wikiPlanFixtureOutlineStorage},
			{"api", wikiPlanFixtureOutlineAPI}, {"testing", wikiPlanFixtureOutlineTesting}}
		return r
	}
	return []wikiPlanFixtureRound{
		// The Go test's own draft, every reference there: nothing for the gate to find.
		{Name: "draft-clean", Kind: "draft", Target: wikiPlanLength{Min: 3, Max: 3}, Catalogue: planSkeleton,
			Details:  wikiPlanFixtureAnswers{{"1", planDetailsProduct}, {"2", planDetailsDev}},
			Outlines: wikiPlanFixtureAnswers{{"service-overview", planOutlineOverview}, {"storage", planOutlineStorage}, {"testing", planOutlineTesting}}},
		// Every kind of thing a model gets wrong, in one round.
		draftAnswers(wikiPlanFixtureRound{Name: "draft-wrong", Kind: "draft", Target: wikiPlanLength{Min: 3, Max: 3}, Catalogue: wikiPlanFixtureCatalogue}),
		// A document left with no body, a count below the target, and a catalogue with no agents' category.
		{Name: "draft-short", Kind: "draft", Target: wikiPlanLength{Min: 5, Max: 8},
			Catalogue: "## 1. Product — What it is\n- 1.1 Overview `overview` | What it is | Includes: purpose\n" +
				"- 1.2 Bad Slug `Bad_Slug` | How it is stored | Includes: saving\n",
			Details:  wikiPlanFixtureAnswers{{"1", "### 1.1 Overview\nAudience: A: can change it once they have read it\nIncludes: purpose\nLength: 300–500 characters\n"}},
			Outlines: wikiPlanFixtureAnswers{{"overview", "### 1. Overview | overview | 200\nCovers: a summary.\n"}}},
		// A draft against a version whose protected document the catalogue leaves out.
		{Name: "draft-protected", Kind: "draft", Target: wikiPlanLength{Min: 1, Max: 5}, Base: wikiPlanFixtureBase(), Catalogue: wikiPlanFixtureLeavesProtectedOut,
			Details:  wikiPlanFixtureAnswers{{"1", planDetailsProduct}, {"2", planDetailsDev}},
			Outlines: wikiPlanFixtureAnswers{{"storage", planOutlineStorage}, {"testing", planOutlineTesting}}},
		// A revision that moves sections it may not, and merges a protected document.
		{Name: "revise-moves", Kind: "revise", Target: wikiPlanLength{Min: 3, Max: 3}, Base: wikiPlanFixtureBase(),
			Instructions: "把存储的约定移到开发约定里，篇数不变。", Catalogue: wikiPlanFixtureRevisionMoves,
			Rewrites: wikiPlanFixtureAnswers{{"testing", wikiPlanFixtureRewriteTesting},
				{"merged", "Title: Merged\nQuestion: ?\nAudience: A: B\nIncludes: merging\nLength: 100–200 characters\n### 1. Merge | other | 100\nCovers: merging.\n"}}},
		// The revision the owner asked for: one convention moved into the agents' category.
		{Name: "revise-good", Kind: "revise", Target: wikiPlanLength{Min: 3, Max: 3}, Base: wikiPlanFixtureBase(),
			Instructions: "把存储的约定移到开发约定里。", Catalogue: wikiPlanFixtureRevisionGood,
			Rewrites: wikiPlanFixtureAnswers{{"testing", wikiPlanFixtureRewriteTesting}}},
	}
}

// wikiPlanFixtureCheckInputs are the references the repository is asked about.
func wikiPlanFixtureCheckInputs() []wikiPlanFixtureCheck {
	var out []wikiPlanFixtureCheck
	for _, c := range [][2]string{
		{"src/app/main.go", "Server"}, {"src/app/main.go", "Serve()"}, {"src/app/main.go", "Server.Handle"}, {"src/app/main.go", "`Serve`"},
		{"src/app/", "Store.Save"}, {"src/app/*.go", "Store.Save"}, {"src/web/client.ts", "Client.fetchPlan"}, {"src/web/client.ts", "render()"},
		{"src/web/client.ts", "localHelper"}, {"src/web/client.ts", "Client.localHelper"}, {"src/web/api.controller.ts", "ItemsController.find [GET /api/items/:id]"},
		{"src/web/api.controller.ts", "ItemsController.find"}, {"src/ios/ContentView.swift", "ext ContentView"}, {"src/ios/ContentView.swift", "hidden()"},
		{"src/app/main.go", "Store.Save"}, {"src/app/store.go", "Store.Load"}, {"src/app/store.go", "TestStoreSaves"}, {"src/big/", "Alpha07()"},
		{"README.md", "App"}, {"src/app/store.go", "（Store.Save）"}, {"src/app/store.go", ""},
	} {
		out = append(out, wikiPlanFixtureCheck{Kind: "symbol", Where: c[0], What: c[1]})
	}
	for _, c := range [][2]string{
		{"docs/wiki-design.md", "4.4 锚点"}, {"docs/wiki-design.md", "锚点"}, {"docs/wiki-design.md", "§ 4. 写路径"}, {"docs/architecture.md", "execution model"},
		{"docs/wiki-design.md", "这不是一个章节"}, {"docs/architecture.md", "Deployment"}, {"docs/wiki-design.md", "4. 写路径 - 4.4 锚点"},
		{"docs/wiki-design.md", "写路径 > 锚点"}, {"docs/wiki-design.md", "4.4 锚点 - 4. 写路径"}, {"docs/architecture.md", "Execution model - Realtime and recovery"},
		{"docs/wiki-design.md", "5. 运维 — 部署"}, {"docs/wiki-design.md", "运维 - 部署"}, {"docs/architecture.md", "加固后的恢复策略（契约 §6.4、§6.5）"},
		{"./docs/README.md", "入门"}, {"docs/mocks/21-plan.md", "Mock heading"}, {"notes/ops.md", "On call"}, {"docs/wiki-design.md", "4.5 数据模型(新表 share_link)"},
	} {
		out = append(out, wikiPlanFixtureCheck{Kind: "docSection", Where: c[0], What: c[1]})
	}
	for _, p := range []string{"docs/architecture.md", "src/app", "src/app/", "src/**/*.ts", "src/app/missing.go", "src/nope/", "`src/web/client.ts`", "./README.md",
		"src/web/*.tsx", "src/big/alpha_0?.go", "src/big/[ab]*", "src/**", "src/[", ""} {
		out = append(out, wikiPlanFixtureCheck{Kind: "path", Where: p})
	}
	return out
}

// wikiPlanFixtureReadInputs are the line format's harder cases, each read the way a run reads it.
func wikiPlanFixtureReadInputs() []wikiPlanFixtureRead {
	return []wikiPlanFixtureRead{
		{Kind: "catalogue", Text: "A preamble that does not count\n## 1. Product `product` — What it is\n" +
			"- 1.1 Overview `overview` | What it is | Sources: 1.1, 1.3 | Includes: purpose; components\n" +
			"## 3. Development conventions `dev` — Conventions [agents]\n- 3.4 Testing `testing` | How to test | Sources: none | Includes: go test\n" +
			"### Sections moved into the agents' category\n- 1.2 §4 → 3.4\n- none\n- 1.9 §1 -> 8.8\n"},
		{Kind: "catalogue", Text: "### 2、 Operations `ops` — How to deploy（给 agent）\n* 2.1 **Deploy** `deploy`｜How to ship it｜Includes：steps\n"},
		{Kind: "catalogue", Text: "No catalogue here\n"},
		{Kind: "body", Text: "### 1.2 Storage\nAudience: A: can change it once they have read it; B: can look it up once they have read it\nIncludes: one; two\n" +
			"Excludes: three (see 2.1)\nLength: 1,200–2,000 characters\nNote: extra\n### 1. Saving | Flow | about 500 characters\nCovers: store first,\n" +
			"then return.\n- Docs: docs/a.md § 3. A section, § 4. Another section\n- Code: src/dir/ (a.go, b.go): A, B.c\n" +
			"- Sessions: projects 「A」「B」; dates 2026-09-01 to now; keywords x, y; anchors src/; kind pitfall/decision; topics t1; look for: the words said; the rest\n" +
			"- Aside: not in the format\n"},
		{Kind: "body", Text: "### 1.1 Overview\nAudience: A: can change it once they have read it\n### 1. Model | concepts | 300\nCovers: the data model.\n" +
			"- Docs: docs/a.md § 4. Data model (new table `share_link`), § (5. Interface)\n- Docs: docs/b.md § whole document\n" +
			"- Docs: docs/c.md § 2. Recovery (contract §6.4, §6.5), § 3. The next section\n- Code: src/a.ts: x; src/b.ts: y, z；w\n" +
			"- Sessions: projects 「把「什么算完成」从项目末尾搬到开工前」「A」; look for: the words said\n### 2、 Interface ｜ interface ｜ 1200\nCOVERS: a label in capitals\n" +
			"- Sessions: entry kind recipe concept; existing topics a, b; anchor paths src/x/\n" +
			"- Contracts: contracts/a.json (the main contract), contracts/b.json\n"},
		{Kind: "details", Text: "### 1.1 Overview\nAudience: A: can change it once they have read it\nIncludes: one\nLength: 300 characters\nDocs: docs/a.md (design)\n" +
			"Code: src/ (x.go, y.go)\nTopics: `t1`, 「t2」\nProjects: 「A」, B\n\n### 1.2 The second\nTitle: Another one\n"},
		{Kind: "paths", Text: "src/dir/（x.ts、y.ts）、`src/z.go`（entry）、docs/（overview）；「src/q/」"},
		{Kind: "paths", Text: "none"},
		{Kind: "unwrap", Text: "（4. Write path）"},
		{Kind: "unwrap", Text: "Write path）"},
		{Kind: "unwrap", Text: "（Write path"},
		{Kind: "unwrap", Text: "（a）（b）"},
		{Kind: "unwrap", Text: "Data model (Prisma)"},
		{Kind: "unwrap", Text: "  ((deep))  "},
		{Kind: "range", Text: "1,200–2,000 characters"},
		{Kind: "range", Text: "about 1500 characters"},
		{Kind: "range", Text: "2000-1000"},
		{Kind: "range", Text: "no number"},
		{Kind: "renumber", Text: "Details: see 1.3, and see also 1.1, 1.2; → 2.9; see 1.1 and 1.3; 细节见 1.3，另见 1.1、1.2；参见1.2"},
	}
}

// ── Running the inputs through the runner's code ───────────────────────────────────────────────────

// wikiPlanFixtureGit runs git with the identity and the clock fixed, so the fixture's commits are the same
// commits every time the fixture is written.
func wikiPlanFixtureGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@orbit", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@orbit",
		"GIT_AUTHOR_DATE=2026-10-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-10-01T00:00:00Z", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func wikiPlanFixtureCheckout(t *testing.T, files map[string]string) (string, string) {
	t.Helper()
	root := t.TempDir()
	wikiPlanFixtureGit(t, root, "init", "-q", "-b", "main")
	for name, content := range files {
		file := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	wikiPlanFixtureGit(t, root, "add", ".")
	wikiPlanFixtureGit(t, root, "commit", "-q", "-m", "first")
	return root, wikiPlanFixtureGit(t, root, "rev-parse", "HEAD")
}

func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

// What the line format reads, as the fixture holds it: field by field, in the order of the fields read.

type wikiPlanFixtureHeaderRead struct {
	Title        string   `json:"title"`
	Question     string   `json:"question"`
	Audience     []string `json:"audience"`
	ScopeIn      []string `json:"scopeIn"`
	ScopeOut     []string `json:"scopeOut"`
	Length       string   `json:"length"`
	KeyDocs      []string `json:"keyDocs"`
	KeyCode      []string `json:"keyCode"`
	KeyContracts []string `json:"keyContracts"`
	Topics       []string `json:"topics"`
	Projects     []string `json:"projects"`
}

type wikiPlanFixtureSectionRead struct {
	Title     string                       `json:"title"`
	Kind      string                       `json:"kind"`
	Length    string                       `json:"length"`
	Covers    string                       `json:"covers"`
	Docs      []wikiPlanDocSource          `json:"docs"`
	Code      []wikiPlanFixtureCodeRead    `json:"code"`
	Contracts []string                     `json:"contracts"`
	Sessions  *wikiPlanFixtureSessionsRead `json:"sessions"`
	Stray     []string                     `json:"stray"`
}

type wikiPlanFixtureCodeRead struct {
	Path    string   `json:"path"`
	Symbols []string `json:"symbols"`
}

type wikiPlanFixtureSessionsRead struct {
	Projects    []string `json:"projects"`
	Keywords    []string `json:"keywords"`
	AnchorPaths []string `json:"anchorPaths"`
	EntryKinds  []string `json:"entryKinds"`
	Topics      []string `json:"topics"`
	Since       string   `json:"since"`
	Until       string   `json:"until"`
	Evidence    string   `json:"evidence"`
	Stray       []string `json:"stray"`
}

type wikiPlanFixtureCatalogueRead struct {
	Cats  []wikiPlanFixtureCatRead  `json:"cats"`
	Units []wikiPlanFixtureUnitRead `json:"units"`
	Moves []wikiPlanFixtureMoveRead `json:"moves"`
	Stray []string                  `json:"stray"`
}

type wikiPlanFixtureCatRead struct {
	Key       string `json:"key"`
	Title     string `json:"title"`
	Question  string `json:"question"`
	ForAgents bool   `json:"forAgents"`
}

type wikiPlanFixtureUnitRead struct {
	Cat       int      `json:"cat"`
	Slug      string   `json:"slug"`
	Title     string   `json:"title"`
	Question  string   `json:"question"`
	CardScope []string `json:"cardScope"`
	Sources   []string `json:"sources"`
	Stray     []string `json:"stray"`
}

type wikiPlanFixtureMoveRead struct {
	From    string  `json:"from"`
	Section int     `json:"section"`
	To      string  `json:"to"`
	Target  *string `json:"target"`
}

func wikiPlanFixtureHeader(h wikiPlanHeader) wikiPlanFixtureHeaderRead {
	return wikiPlanFixtureHeaderRead{Title: h.Title, Question: h.Question, Audience: nonNil(h.Audience), ScopeIn: nonNil(h.ScopeIn),
		ScopeOut: nonNil(h.ScopeOut), Length: h.Length, KeyDocs: nonNil(h.KeyDocs), KeyCode: nonNil(h.KeyCode),
		KeyContracts: nonNil(h.KeyContracts), Topics: nonNil(h.Topics), Projects: nonNil(h.Projects)}
}

func wikiPlanFixtureSections(sections []wikiPlanSectionDraft) []wikiPlanFixtureSectionRead {
	out := []wikiPlanFixtureSectionRead{}
	for _, s := range sections {
		docs := append([]wikiPlanDocSource{}, s.Docs...)
		code := []wikiPlanFixtureCodeRead{}
		for _, c := range s.Code {
			code = append(code, wikiPlanFixtureCodeRead{Path: c.Path, Symbols: nonNil(c.Symbols)})
		}
		var sessions *wikiPlanFixtureSessionsRead
		if c := s.Sessions; c != nil {
			sessions = &wikiPlanFixtureSessionsRead{Projects: nonNil(c.Projects), Keywords: nonNil(c.Keywords), AnchorPaths: nonNil(c.AnchorPaths),
				EntryKinds: nonNil(c.EntryKinds), Topics: nonNil(c.Topics), Since: c.Since, Until: c.Until, Evidence: c.Evidence, Stray: nonNil(c.Stray)}
		}
		out = append(out, wikiPlanFixtureSectionRead{Title: s.Title, Kind: s.Kind, Length: s.Length, Covers: s.Covers, Docs: docs, Code: code,
			Contracts: nonNil(s.Contracts), Sessions: sessions, Stray: nonNil(s.Stray)})
	}
	return out
}

func wikiPlanFixtureCatalogueOf(c *wikiPlanCatalogue) *wikiPlanFixtureCatalogueRead {
	if c == nil {
		return nil
	}
	out := &wikiPlanFixtureCatalogueRead{Cats: []wikiPlanFixtureCatRead{}, Units: []wikiPlanFixtureUnitRead{}, Moves: []wikiPlanFixtureMoveRead{},
		Stray: nonNil(c.Stray)}
	for _, cat := range c.Cats {
		out.Cats = append(out.Cats, wikiPlanFixtureCatRead{Key: cat.Key, Title: cat.Title, Question: cat.Question, ForAgents: cat.ForAgents})
	}
	for _, u := range c.Units {
		out.Units = append(out.Units, wikiPlanFixtureUnitRead{Cat: u.Cat, Slug: u.Slug, Title: u.Title, Question: u.Question,
			CardScope: nonNil(u.CardScope), Sources: nonNil(u.Sources), Stray: nonNil(u.Stray)})
	}
	for _, m := range c.Moves {
		var target *string
		if m.Target != nil {
			target = &m.Target.Slug
		}
		out.Moves = append(out.Moves, wikiPlanFixtureMoveRead{From: m.From, Section: m.Section, To: m.To, Target: target})
	}
	return out
}

func wikiPlanFixtureReadOf(read wikiPlanFixtureRead) interface{} {
	switch read.Kind {
	case "catalogue":
		if c := wikiPlanFixtureCatalogueOf(parseWikiPlanCatalogue(read.Text)); c != nil {
			return c
		}
		return nil
	case "body":
		header, sections, stray := parseWikiPlanDocBody(read.Text)
		return map[string]interface{}{"header": wikiPlanFixtureHeader(header), "sections": wikiPlanFixtureSections(sections), "stray": nonNil(stray)}
	case "details":
		out := map[string]interface{}{}
		for id, header := range parseWikiPlanDetails(read.Text) {
			out[id] = wikiPlanFixtureHeader(header)
		}
		return out
	case "paths":
		return nonNil(wikiPlanPaths(read.Text))
	case "unwrap":
		return wikiPlanUnwrap(read.Text)
	case "range":
		min, max, ok := wikiPlanRange(read.Text)
		return struct {
			Min int  `json:"min"`
			Max int  `json:"max"`
			OK  bool `json:"ok"`
		}{min, max, ok}
	case "renumber":
		then := map[string]string{"1.1": "a", "1.2": "b", "1.3": "c"}
		now := map[string]string{"a": "1.1", "c": "1.2"}
		text, unknown := wikiPlanRenumber(read.Text, func(id string) (string, bool) {
			slug, ok := then[id]
			if !ok {
				return "", false
			}
			n, ok := now[slug]
			return n, ok
		})
		return map[string]interface{}{"text": text, "unknown": nonNil(unknown)}
	}
	return nil
}

func wikiPlanFixtureCheckOf(repo *wikiPlanRepo, c wikiPlanFixtureCheck) bool {
	switch c.Kind {
	case "symbol":
		return repo.hasSymbol(c.Where, c.What)
	case "docSection":
		return repo.hasDocSection(c.Where, c.What)
	}
	return repo.hasPath(c.Where)
}

// wikiPlanFixtureDated is a prompt with the day its head names set to the fixture's.
func wikiPlanFixtureDated(prompt string) string {
	today := time.Now().UTC().Format("2006-01-02")
	return strings.ReplaceAll(prompt, "and Orbit, "+today+"; ", "and Orbit, "+wikiPlanFixtureDate+"; ")
}

// wikiPlanFixtureRun runs one round as a run of the drafting job runs it — the version revised read, the
// catalogue adopted, each step's prompt built and its answer taken in, the draft assembled and gated — and
// writes what it came to into the round.
func wikiPlanFixtureRun(t *testing.T, repo *wikiPlanRepo, materials wikiPlanMaterialsRead, round *wikiPlanFixtureRound) {
	t.Helper()
	r := &wikiPlanRun{repo: repo, online: materials, target: round.Target, opts: wikiPlanOptions{kind: round.Kind}, progress: io.Discard}
	r.job.Space.Title = materials.Title
	r.instructions = round.Instructions
	r.baseIDs, r.baseDocs = map[string]string{}, map[string]wikiPlanDocRead{}
	if len(round.Base) > 0 && string(round.Base) != "null" {
		var base wikiPlanVersionRead
		if err := json.Unmarshal(round.Base, &base); err != nil {
			t.Fatal(err)
		}
		r.base = &base
		for c, cat := range base.Categories {
			n := 0
			for _, doc := range base.Docs {
				if doc.Category == cat.Key {
					n++
					r.baseIDs[fmt.Sprintf("%d.%d", c+1, n)] = doc.Slug
					r.baseDocs[doc.Slug] = doc
				}
			}
		}
	}
	revision := round.Kind == "revise" && r.base != nil
	prompts := map[string]string{}
	if revision {
		prompts["revise-catalogue"] = r.revisionCataloguePrompt(nil, "")
	} else {
		prompts["skeleton"] = r.fullMaterials() + "\n" + r.skeletonPrompt()
	}
	catalogue := parseWikiPlanCatalogue(round.Catalogue)
	if catalogue == nil {
		t.Fatalf("round %s: its catalogue does not read", round.Name)
	}
	r.adoptCatalogue(catalogue, revision)
	text := r.catalogueText()
	if revision {
		refs := r.currentRefs()
		for _, unit := range r.units {
			if unit.Protected != nil || unit.Kept != nil {
				continue
			}
			prompts["revise-doc/"+unit.Slug] = r.rewritePrompt(unit, text)
			if answer, ok := round.Rewrites.answer(unit.Slug); ok {
				header, sections, stray := parseWikiPlanDocBody(answer)
				unit.Header, unit.Sections, unit.Stray, unit.HasBody, unit.Refs, unit.Kept = header, sections, stray, true, refs, nil
			}
		}
	} else {
		// The rules' prompt is built as draft() builds it: before any document's details are taken in.
		prompts["rules"] = r.rulesPrompt()
		byCat := map[int][]*wikiPlanUnit{}
		var cats []int
		for _, unit := range r.units {
			if _, ok := byCat[unit.Cat]; !ok {
				cats = append(cats, unit.Cat)
			}
			byCat[unit.Cat] = append(byCat[unit.Cat], unit)
		}
		for _, c := range cats {
			var ids []string
			for _, unit := range byCat[c] {
				ids = append(ids, unit.ID)
			}
			prompts["details/"+strconv.Itoa(c+1)] = r.detailMaterials() + "\n# Document catalogue\n" + text + "\n" + r.detailPrompt(c, ids)
			if answer, ok := round.Details.answer(strconv.Itoa(c + 1)); ok {
				details := parseWikiPlanDetails(answer)
				for _, unit := range byCat[c] {
					if header, ok := details[unit.ID]; ok {
						unit.Header = header
					}
				}
			}
		}
		refs := r.currentRefs()
		// As writeBodies does: every document of the catalogue, a protected one too (its body is then not used).
		for _, unit := range r.units {
			prompts["outline/"+unit.Slug] = r.docMaterials(unit) + "\n# Document catalogue\n" + text + "\n" + r.outlinePrompt(unit)
			if answer, ok := round.Outlines.answer(unit.Slug); ok {
				_, sections, stray := parseWikiPlanDocBody(answer)
				unit.Sections, unit.Stray, unit.HasBody, unit.Refs = sections, stray, true, refs
			}
		}
	}
	a := r.assemble()
	lines := r.errorLines(a.errors, a)
	prompts["errors"] = lines
	if revision {
		prompts["revise-catalogue-again"] = r.revisionCataloguePrompt(a.errors, lines)
	} else {
		prompts["catalogue-redo"] = r.catalogueRedoPrompt(lines)
	}
	byUnit := map[*wikiPlanUnit][]wikiPlanGateError{}
	for _, e := range a.errors {
		if i, ok := wikiPlanDocIndex(e.Path); ok && !wikiPlanCatalogueLevel(e.Path) && i < len(a.units) && a.units[i].Protected == nil {
			byUnit[a.units[i]] = append(byUnit[a.units[i]], e)
		}
	}
	catalogueNow := r.catalogueText()
	for _, unit := range a.units {
		if errs, ok := byUnit[unit]; ok {
			prompts["redo-doc/"+unit.Slug] = r.docMaterials(unit) + "\n" + r.redoDocPrompt(unit, errs, a, catalogueNow)
		}
	}
	for name, prompt := range prompts {
		prompts[name] = wikiPlanFixtureDated(prompt)
	}
	draft, err := json.Marshal(a.plan)
	if err != nil {
		t.Fatal(err)
	}
	errs := append([]wikiPlanGateError{}, a.errors...)
	sort.SliceStable(errs, func(i, j int) bool {
		if errs[i].Check != errs[j].Check {
			return errs[i].Check < errs[j].Check
		}
		if errs[i].Path != errs[j].Path {
			return errs[i].Path < errs[j].Path
		}
		return errs[i].Message < errs[j].Message
	})
	round.Prompts, round.Draft, round.Errors, round.RepoCheck = prompts, draft, errs, a.repo
}

// wikiPlanFixtureBuild is the whole fixture, every output this code's.
func wikiPlanFixtureBuild(t *testing.T) wikiPlanFixture {
	t.Helper()
	files := wikiPlanFixtureFiles()
	root, head := wikiPlanFixtureCheckout(t, files)
	outcome := wikiRepoOpSnapshot(WikiRepoOpCommand{}, root, head, wikiRepoOpInput{})
	index, ok := outcome.result["index"].(string)
	if outcome.state != "succeeded" || !ok {
		t.Fatalf("the snapshot of the fixture: %+v", outcome)
	}
	repo, err := loadWikiPlanRepo(root, head)
	if err != nil {
		t.Fatal(err)
	}
	materialsRaw, _ := json.Marshal(wikiPlanFixtureMaterials())
	var materials wikiPlanMaterialsRead
	if err := json.Unmarshal(materialsRaw, &materials); err != nil {
		t.Fatal(err)
	}
	fixture := wikiPlanFixture{
		Why: "The plan's deterministic half on the runner (src/runner-go/wiki_plan_*.go) and on the server " +
			"(src/apiserver/src/wiki-worker/wiki-plan-*.ts): the same repository, materials and answers give the same reading, " +
			"the same prompts, the same draft and the same gate errors (contract plan.jobs.server).",
		Write: "ORBIT_WIKI_PLAN_FIXTURE=write go test -run TestWikiPlanFixtureIsTheServersToo . (in src/runner-go)",
		Date:  wikiPlanFixtureDate, Files: files, Index: json.RawMessage(index), Materials: materialsRaw,
	}
	fixture.Texts = map[string]string{
		"layout/32000": repo.layoutText(32000), "layout/26000": repo.layoutText(26000), "layout/900": repo.layoutText(900),
		"docsTree/45000": repo.docsTreeText(45000), "docsTree/30000": repo.docsTreeText(30000), "docsTree/600": repo.docsTreeText(600),
		"contracts": repo.contractsText(), "docIndex": repo.docIndexText(),
		"overview/14000": repo.overviewText(14000), "overview/10000": repo.overviewText(10000), "overview/80": repo.overviewText(80),
		"codeExcerpt":     repo.codeExcerpt([]string{"src/app/", "src/web/*.ts", "`src/ios/ContentView.swift`", "src/nope/"}, 16000),
		"codeExcerpt/120": repo.codeExcerpt([]string{"src/big/"}, 120), "codeExcerpt/none": repo.codeExcerpt([]string{"docs/"}, 16000),
		"docBlock": repo.docBlock("docs/wiki-design.md", 6),
		"projects": materials.projectsText(), "sessions": materials.sessionsText(), "space": materials.spaceText(),
		"topicsBrief": materials.topicsBrief(), "topicBlocks": materials.topicBlocks([]string{"`storage-topic`", "missing"}),
	}
	for _, c := range wikiPlanFixtureCheckInputs() {
		c.Found = wikiPlanFixtureCheckOf(repo, c)
		fixture.Checks = append(fixture.Checks, c)
	}
	for _, read := range wikiPlanFixtureReadInputs() {
		read.Read = wikiPlanFixtureReadOf(read)
		fixture.Reads = append(fixture.Reads, read)
	}
	for _, round := range wikiPlanFixtureRounds() {
		round := round
		wikiPlanFixtureRun(t, repo, materials, &round)
		fixture.Rounds = append(fixture.Rounds, round)
	}
	return fixture
}

func wikiPlanFixtureBytes(t *testing.T, fixture wikiPlanFixture) []byte {
	t.Helper()
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(fixture); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestWikiPlanFixtureIsTheServersToo(t *testing.T) {
	got := wikiPlanFixtureBytes(t, wikiPlanFixtureBuild(t))
	if os.Getenv("ORBIT_WIKI_PLAN_FIXTURE") == "write" {
		if err := os.WriteFile(wikiPlanFixturePath, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s (%d bytes)", wikiPlanFixturePath, len(got))
		return
	}
	want, err := os.ReadFile(wikiPlanFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		gotLines, wantLines := strings.Split(string(got), "\n"), strings.Split(string(want), "\n")
		for i := 0; i < len(gotLines) && i < len(wantLines); i++ {
			if gotLines[i] != wantLines[i] {
				t.Fatalf("the fixture is not what this code makes of its inputs, from line %d:\n got %s\nwant %s\n(write it again with %s)",
					i+1, gotLines[i], wantLines[i], "ORBIT_WIKI_PLAN_FIXTURE=write")
			}
		}
		t.Fatalf("the fixture is not what this code makes of its inputs: %d lines, want %d", len(gotLines), len(wantLines))
	}
}
