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
	Name         string              `json:"name"`
	Kind         string              `json:"kind"`
	Target       wikiPlanLength      `json:"target"`
	Base         json.RawMessage     `json:"base"`
	Instructions string              `json:"instructions"`
	Catalogue    string              `json:"catalogue"`
	Details      map[string]string   `json:"details"`
	Outlines     map[string]string   `json:"outlines"`
	Rewrites     map[string]string   `json:"rewrites"`
	Prompts      map[string]string   `json:"prompts"`
	Draft        json.RawMessage     `json:"draft"`
	Errors       []wikiPlanGateError `json:"errors"`
	RepoCheck    wikiPlanRepoCheck   `json:"repoCheck"`
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
		"docs/mocks/21-plan.md":    "# A mock\n\n## Mock heading\n",
		"docs/evidence/run.md":     "# Evidence\n\n## Not a document\n",
		"notes/ops.md":             "# Ops notes\n\n## On call\n",
		"src/app/main.go":          "package app\n\ntype Server struct{}\n\nfunc Serve() error { return nil }\n\nfunc (s *Server) Handle() {}\n",
		"src/app/store.go":         "package app\n\ntype Store struct{}\n\nfunc (s *Store) Save() error { return nil }\n\nconst storeVersion = 2\n",
		"src/app/store_test.go":    "package app\n\nfunc TestStoreSaves() {}\n",
		"src/web/client.ts":        "export class Client {\n  fetchPlan() {\n    return localHelper();\n  }\n}\n\nexport function render() {}\n\nfunction localHelper() {\n  return 1;\n}\n",
		"src/web/api.controller.ts": "import { Controller, Get, Post } from '@nestjs/common';\n\n@Controller('items')\nexport class ItemsController {\n" +
			"  @Get(':id')\n  find() {\n    return 1;\n  }\n\n  @Post()\n  create() {\n    return 2;\n  }\n}\n",
		"src/web/main.tsx":                   "export function App() {\n  return null;\n}\n",
		"src/ios/ContentView.swift":           "import SwiftUI\n\nstruct ContentView: View {\n    var body: some View { Text(\"hi\") }\n    func refresh() {}\n}\n\nextension ContentView {\n    private func hidden() {}\n}\n",
		"src/apiserver/prisma/schema.prisma":  "model User {\n  id String @id\n}\n\nmodel Space {\n  id String @id\n}\n",
		"src/apiserver/src/app.module.ts":     "export class AppModule {}\n",
		"contracts/app.contract.json":         "{\"name\":\"app\",\"routes\":[],\"version\":1}\n",
		"contracts/wiki.contract.json":        "{\"a\":1,\"b\":2,\"c\":3,\"d\":4,\"e\":5,\"f\":6,\"g\":7,\"h\":8,\"i\":9,\"j\":10,\"k\":11,\"l\":12,\"m\":13,\"n\":14,\"o\":15}\n",
		"package.json":                        "{\"name\":\"app\"}\n",
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
		if i%4 == 0 {
			title = "执行任务：" + title
		}
		var project interface{}
		if i%3 == 0 {
			project = "App 项目"
		}
		sessions = append(sessions, map[string]interface{}{"title": title, "month": fmt.Sprintf("2026-%02d", 8+i%2), "task": i%4 == 0,
			"project": project, "provider": []string{"claude", "codex", "kimi"}[i%3]})
	}
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
		"sessions": map[string]interface{}{"days": 90, "total": 31, "items": sessions},
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
const wikiPlanFixtureCatalogue = "前言不算\n## 1. 产品 `product` —— 这个服务是什么、怎么运转\n" +
	"- 1.1 服务概览 `service-overview`｜这个服务是什么、由哪些部分组成｜含：定位；组件；入口\n" +
	"- 1.2 存储 `storage`｜数据怎么存、怎么取｜含：Store；保存\n" +
	"- 1.3 接口 `api`｜有哪些接口｜含：路由；客户端｜备注：多余\n" +
	"## 2. 开发约定 `dev` —— 给写代码的 agent 看的约定 [agents]\n" +
	"- 2.1 测试约定 `testing`｜怎么跑测试｜含：go test；夹具\n"

const wikiPlanFixtureDetailsProduct = "### 1.1 服务概览\n读者：新加入的开发者：读完能说出服务由哪些部分组成\n含：定位；组件；入口\n不含：存储细节（见 1.2）；接口（见 1.3）\n篇幅：800–1200 字\n" +
	"文档：docs/architecture.md、docs/README.md\n代码：src/app/\n契约：contracts/app.contract.json\n主题：storage-topic\n项目：「App 项目」\n\n" +
	"### 1.2 存储\n读者：写存储代码的人：读完能改 Store\n含：Store 的结构；保存流程\n不含：测试怎么跑（见 2.1）\n篇幅：600–900 字\n" +
	"文档：docs/wiki-design.md\n代码：src/app/store.go\n契约：无\n主题：无\n项目：无\n\n" +
	"### 1.3 接口\n读者：调用接口的人：读完能调用 ItemsController\n含：路由；客户端\n不含：存储（见 9.9）\n篇幅：约 700 字\n" +
	"文档：docs/missing.md\n代码：src/web/（client.ts、api.controller.ts）\n契约：contracts/app.contract.json\n主题：无\n项目：「同名项目」\n"

const wikiPlanFixtureDetailsDev = "### 2.1 测试约定\n读者：写代码的 agent：读完知道怎么跑测试\n含：go test；夹具\n不含：存储（见 1.2）\n篇幅：400–600 字\n" +
	"文档：无\n代码：src/web/\n契约：无\n主题：无\n项目：无\n"

const wikiPlanFixtureOutlineOverview = "### 1. 总览 | overview | 200\n讲什么：概括第 2、3 节。\n" +
	"### 2. 组件 | concepts | 400\n讲什么：Server 与 Store 两个组件，存储细节见 1.2。\n" +
	"- 文档：docs/architecture.md § Execution model\n- 文档：docs/architecture.md § Realtime and recovery - 2. 加固后的恢复策略（契约 §6.4、§6.5）\n" +
	"- 代码：src/app/main.go: Server, Serve(), Server.Handle\n- 契约：contracts/app.contract.json\n" +
	"### 3. 已知的坑 | pitfalls | 300\n讲什么：启动时的坑。\n" +
	"- 会话：项目「App 项目」「同名项目」「`App 项目`」；时间 2026-09-01 至 今；关键词 启动、端口；锚点 src/app/；kind `pitfall`/\"decision\"/dicision；主题 storage-topic、\"ops-topic\"、nope-topic；要找：owner 说端口不能写死的原话\n" +
	"### 4. 运维 | ops | 200\n讲什么：部署见 4.4，另见 1.3、1.1。\n- 文档：docs/wiki-design.md § 5. 运维 — 部署\n- 文档：notes/ops.md § 正文\n"

const wikiPlanFixtureOutlineStorage = "### 1. 保存流程 | flow | 500\n讲什么：Store.Load 怎么读，见 9.9。\n" +
	"- 文档：docs/wiki-design.md § 5. 不存在的章节\n- 文档：docs/wiki-design.md § 4. 写路径 - 4.4 锚点、§ （4.5 数据模型（新表 `share_link`））\n" +
	"- 代码：src/app/store.go: Store.Save, Store.Load, storeVersion\n- 代码：src/app/missing.go: Foo\n- 备注：这一行不在格式里\n" +
	"### 2. 约定 | conventions | 二百\n讲什么：保存前先校验，\n校验写在 Save 里。\n" +
	"- 会话：项目「把「什么算完成」从项目末尾搬到开工前」；时间 2026-09-30 至 2026-09-01；未知部分\n" +
	"### 3. 杂项 | misc | 100\n讲什么：其他。\n"

const wikiPlanFixtureOutlineAPI = "### 1. 路由 | interface | 400\n讲什么：ItemsController 的路由。\n" +
	"- 代码：src/web/api.controller.ts: ItemsController.find [GET /api/items/:id], ItemsController.create, ItemsController.destroy\n" +
	"- 代码：src/web/client.ts: Client.fetchPlan, localHelper, render(); src/web/*.tsx: App()\n" +
	"- 代码：src/ios/ContentView.swift: ContentView, refresh(), ext ContentView, hidden()\n" +
	"- 代码：src/**/schema.prisma: User\n"

const wikiPlanFixtureOutlineTesting = "### 1. 怎么跑测试 | conventions | 300\n讲什么：用 go test 跑，组件见 1.1。\n" +
	"- 代码：src/web/client.ts: Client.fetchPlan, render()\n- 代码：src/app/store_test.go: TestStoreSaves\n"

const wikiPlanFixtureRewriteTesting = "标题：测试约定\n问题：怎么跑测试？\n读者：写代码的 agent：读完知道怎么跑测试\n含：go test；保存前校验\n篇幅：400–600 字\n" +
	"### 1. 怎么跑测试 | conventions | 300\n讲什么：用 go test 跑。\n- 代码：src/web/client.ts: render()\n" +
	"### 2. 保存约定 | conventions | 200\n讲什么：保存前先校验，见 1.2。\n" +
	"- 会话：项目「App 项目」「p2」；关键词 保存；kind convention；要找：owner 说保存前要校验的原话\n"

const wikiPlanFixtureRevisionMoves = "## 1. 产品 `product` —— 这个服务是什么\n" +
	"- 1.1 服务概览 `service-overview`｜是什么｜来源：1.1｜含：定位\n" +
	"- 1.2 存储 `storage`｜怎么存｜来源：1.2｜含：保存\n" +
	"- 1.3 存储决策 `storage-decisions`｜为什么这么存｜来源：无｜含：决策\n" +
	"- 1.4 合并 `merged`｜合起来｜来源：1.1、1.2｜含：合并\n" +
	"## 2. 开发约定 `dev` —— 给 agent 的约定 [agents]\n" +
	"- 2.1 测试约定 `testing`｜怎么跑测试｜来源：2.1｜含：go test\n" +
	"### 移到给 agent 的大类的节\n- 1.1 §3 → 2.1\n- 1.2 §3 → 2.1\n- 1.2 §9 → 2.1\n- 7.7 §1 → 2.1\n- 1.2 §2 → 1.2\n- 2.1 §1 → 9.9\n"

const wikiPlanFixtureRevisionGood = "## 1. 产品 `product` —— 这个服务是什么\n" +
	"- 1.1 服务概览 `service-overview`｜是什么｜来源：1.1｜含：定位\n" +
	"- 1.2 存储 `storage`｜怎么存｜来源：1.2｜含：保存\n" +
	"## 2. 开发约定 `dev` —— 给 agent 的约定 [agents]\n" +
	"- 2.1 测试约定 `testing`｜怎么跑测试与保存前的校验｜来源：2.1｜含：go test；保存前校验\n" +
	"### 移到给 agent 的大类的节\n- 1.2 §2 → 2.1\n"

const wikiPlanFixtureLeavesProtectedOut = "## 1. 产品 `product` —— 是什么\n- 1.1 存储 `storage`｜怎么存｜含：保存\n" +
	"## 2. 开发约定 `development` —— 约定 [agents]\n- 2.1 测试约定 `testing`｜怎么测｜含：go test\n"

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
		r.Details = map[string]string{"1": wikiPlanFixtureDetailsProduct, "2": wikiPlanFixtureDetailsDev}
		r.Outlines = map[string]string{"service-overview": wikiPlanFixtureOutlineOverview, "storage": wikiPlanFixtureOutlineStorage,
			"api": wikiPlanFixtureOutlineAPI, "testing": wikiPlanFixtureOutlineTesting}
		return r
	}
	return []wikiPlanFixtureRound{
		// The Go test's own draft, every reference there: nothing for the gate to find.
		{Name: "draft-clean", Kind: "draft", Target: wikiPlanLength{Min: 3, Max: 3}, Catalogue: planSkeleton,
			Details:  map[string]string{"1": planDetailsProduct, "2": planDetailsDev},
			Outlines: map[string]string{"service-overview": planOutlineOverview, "storage": planOutlineStorage, "testing": planOutlineTesting}},
		// Every kind of thing a model gets wrong, in one round.
		draftAnswers(wikiPlanFixtureRound{Name: "draft-wrong", Kind: "draft", Target: wikiPlanLength{Min: 3, Max: 3}, Catalogue: wikiPlanFixtureCatalogue}),
		// A document left with no body, a count below the target, and a catalogue with no agents' category.
		{Name: "draft-short", Kind: "draft", Target: wikiPlanLength{Min: 5, Max: 8},
			Catalogue: "## 1. 产品 —— 是什么\n- 1.1 概览 `overview`｜是什么｜含：定位\n- 1.2 Bad Slug `Bad_Slug`｜怎么存｜含：保存\n",
			Details:   map[string]string{"1": "### 1.1 概览\n读者：甲：读完能改\n含：定位\n篇幅：300–500 字\n"},
			Outlines:  map[string]string{"overview": "### 1. 总览 | overview | 200\n讲什么：概括。\n"}},
		// A draft against a version whose protected document the catalogue leaves out.
		{Name: "draft-protected", Kind: "draft", Target: wikiPlanLength{Min: 1, Max: 5}, Base: wikiPlanFixtureBase(), Catalogue: wikiPlanFixtureLeavesProtectedOut,
			Details:  map[string]string{"1": planDetailsProduct, "2": planDetailsDev},
			Outlines: map[string]string{"storage": planOutlineStorage, "testing": planOutlineTesting}},
		// A revision that moves sections it may not, and merges a protected document.
		{Name: "revise-moves", Kind: "revise", Target: wikiPlanLength{Min: 3, Max: 3}, Base: wikiPlanFixtureBase(),
			Instructions: "把存储的约定移到开发约定里，篇数不变。", Catalogue: wikiPlanFixtureRevisionMoves,
			Rewrites: map[string]string{"testing": wikiPlanFixtureRewriteTesting, "merged": "标题：合并\n问题：？\n读者：甲：乙\n含：合并\n篇幅：100–200 字\n### 1. 合 | other | 100\n讲什么：合。\n"}},
		// The revision the owner asked for: one convention moved into the agents' category.
		{Name: "revise-good", Kind: "revise", Target: wikiPlanLength{Min: 3, Max: 3}, Base: wikiPlanFixtureBase(),
			Instructions: "把存储的约定移到开发约定里。", Catalogue: wikiPlanFixtureRevisionGood,
			Rewrites: map[string]string{"testing": wikiPlanFixtureRewriteTesting}},
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
		{Kind: "catalogue", Text: "前言不算\n## 1. 产品 `product` —— 是什么\n- 1.1 概览 `overview`｜是什么｜来源：1.1、1.3｜含：定位；组件\n" +
			"## 3. 开发约定 `dev` —— 约定 [agents]\n- 3.4 测试 `testing`｜怎么测｜来源：无｜含：go test\n### 移到给 agent 的大类的节\n- 1.2 §4 → 3.4\n- 无\n- 1.9 §1 -> 8.8\n"},
		{Kind: "catalogue", Text: "### 2、 运维 `ops` — 怎么部署（给 agent）\n* 2.1 **部署** `deploy`｜怎么发｜含：步骤\n"},
		{Kind: "catalogue", Text: "没有目录\n"},
		{Kind: "body", Text: "### 1.2 存储\n读者：甲：读完能改；乙：读完能查\n含：一；二\n不含：三（见 2.1）\n篇幅：1,200–2,000 字\n备注：多余\n" +
			"### 1. 保存 | Flow | 约 500 字\n讲什么：先存，\n再返回。\n- 文档：docs/a.md § 3. 章节、§ 4. 另一章\n- 代码：src/dir/（a.go、b.go）: A, B.c\n" +
			"- 会话：项目「甲」「乙」；时间 2026-09-01 至 今；关键词 x、y；锚点 src/；kind pitfall/decision；主题 t1；要找：原话；其余\n- 附注：不在格式里\n"},
		{Kind: "body", Text: "### 1.1 概览\n读者：甲：读完能改\n" +
			"### 1. 模型 | concepts | 300\n讲什么：数据模型。\n- 文档：docs/a.md § 4. 数据模型（新表 `share_link`）、§ （5. 接口）\n- 文档：docs/b.md § 正文\n" +
			"- 文档：docs/c.md § 2. 恢复策略（契约 §6.4、§6.5）、§ 3. 下一节\n" +
			"- 代码：src/a.ts: x; src/b.ts: y, z；w\n- 会话：项目「把「什么算完成」从项目末尾搬到开工前」「甲」；要找：原话\n" +
			"### 2、 接口 ｜ interface ｜ 1200\ncovers: an English label\n- 会话与条目：条目 kind recipe concept；现有主题 a、b；锚点路径 src/x/\n- 契约：contracts/a.json（主契约）、contracts/b.json\n"},
		{Kind: "details", Text: "### 1.1 概览\n读者：甲：读完能改\n含：一\n篇幅：300 字\n文档：docs/a.md（设计）\n代码：src/（x.go、y.go）\n主题：`t1`、「t2」\n项目：「甲」、乙\n\n### 1.2 第二\n标题：另一个\n"},
		{Kind: "paths", Text: "src/dir/（x.ts、y.ts）、`src/z.go`（入口）、docs/（总览）；「src/q/」"},
		{Kind: "paths", Text: "无"},
		{Kind: "unwrap", Text: "（4. 写路径）"}, {Kind: "unwrap", Text: "写路径）"}, {Kind: "unwrap", Text: "（写路径"},
		{Kind: "unwrap", Text: "（a）（b）"}, {Kind: "unwrap", Text: "Data model (Prisma)"}, {Kind: "unwrap", Text: "  ((深))  "},
		{Kind: "range", Text: "1,200–2,000 字"}, {Kind: "range", Text: "约 1500 字"}, {Kind: "range", Text: "2000-1000"}, {Kind: "range", Text: "没有数"},
		{Kind: "renumber", Text: "细节见 1.3，另见 1.1、1.2；→ 2.9；see 1.1 and 1.3；参见1.2"},
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

func wikiPlanFixtureHeader(h wikiPlanHeader) map[string]interface{} {
	return map[string]interface{}{"title": h.Title, "question": h.Question, "audience": nonNil(h.Audience), "scopeIn": nonNil(h.ScopeIn),
		"scopeOut": nonNil(h.ScopeOut), "length": h.Length, "keyDocs": nonNil(h.KeyDocs), "keyCode": nonNil(h.KeyCode),
		"keyContracts": nonNil(h.KeyContracts), "topics": nonNil(h.Topics), "projects": nonNil(h.Projects)}
}

func wikiPlanFixtureSections(sections []wikiPlanSectionDraft) []interface{} {
	out := []interface{}{}
	for _, s := range sections {
		docs := []interface{}{}
		for _, d := range s.Docs {
			var section interface{}
			if d.Section != nil {
				section = *d.Section
			}
			docs = append(docs, map[string]interface{}{"path": d.Path, "section": section})
		}
		code := []interface{}{}
		for _, c := range s.Code {
			code = append(code, map[string]interface{}{"path": c.Path, "symbols": nonNil(c.Symbols)})
		}
		var sessions interface{}
		if c := s.Sessions; c != nil {
			sessions = map[string]interface{}{"projects": nonNil(c.Projects), "keywords": nonNil(c.Keywords), "anchorPaths": nonNil(c.AnchorPaths),
				"entryKinds": nonNil(c.EntryKinds), "topics": nonNil(c.Topics), "since": c.Since, "until": c.Until, "evidence": c.Evidence, "stray": nonNil(c.Stray)}
		}
		out = append(out, map[string]interface{}{"title": s.Title, "kind": s.Kind, "length": s.Length, "covers": s.Covers, "docs": docs, "code": code,
			"contracts": nonNil(s.Contracts), "sessions": sessions, "stray": nonNil(s.Stray)})
	}
	return out
}

func wikiPlanFixtureCatalogueRead(c *wikiPlanCatalogue) interface{} {
	if c == nil {
		return nil
	}
	cats := []interface{}{}
	for _, cat := range c.Cats {
		cats = append(cats, map[string]interface{}{"key": cat.Key, "title": cat.Title, "question": cat.Question, "forAgents": cat.ForAgents})
	}
	units := []interface{}{}
	for _, u := range c.Units {
		units = append(units, map[string]interface{}{"cat": u.Cat, "slug": u.Slug, "title": u.Title, "question": u.Question,
			"cardScope": nonNil(u.CardScope), "sources": nonNil(u.Sources), "stray": nonNil(u.Stray)})
	}
	moves := []interface{}{}
	for _, m := range c.Moves {
		var target interface{}
		if m.Target != nil {
			target = m.Target.Slug
		}
		moves = append(moves, map[string]interface{}{"from": m.From, "section": m.Section, "to": m.To, "target": target})
	}
	return map[string]interface{}{"cats": cats, "units": units, "moves": moves, "stray": nonNil(c.Stray)}
}

func wikiPlanFixtureReadOf(read wikiPlanFixtureRead) interface{} {
	switch read.Kind {
	case "catalogue":
		return wikiPlanFixtureCatalogueRead(parseWikiPlanCatalogue(read.Text))
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
		return map[string]interface{}{"min": min, "max": max, "ok": ok}
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
	return strings.ReplaceAll(prompt, "只读取出，"+today+"；", "只读取出，"+wikiPlanFixtureDate+"；")
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
			if answer, ok := round.Rewrites[unit.Slug]; ok {
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
			prompts["details/"+strconv.Itoa(c+1)] = r.detailMaterials() + "\n# 文档目录\n" + text + "\n" + r.detailPrompt(c, ids)
			if answer, ok := round.Details[strconv.Itoa(c+1)]; ok {
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
			prompts["outline/"+unit.Slug] = r.docMaterials(unit) + "\n# 文档目录\n" + text + "\n" + r.outlinePrompt(unit)
			if answer, ok := round.Outlines[unit.Slug]; ok {
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
		"codeExcerpt": repo.codeExcerpt([]string{"src/app/", "src/web/*.ts", "`src/ios/ContentView.swift`", "src/nope/"}, 16000),
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
