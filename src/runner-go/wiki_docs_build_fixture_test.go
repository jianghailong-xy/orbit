package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The documents build's deterministic half, held to one fixture that the server's TypeScript port is held to as
// well (src/apiserver/src/wiki-worker/wiki-docs-build-golden.spec.ts): each section's material as gathered from a
// checkout at one commit and from the records, what the filter and the cap made of it, its fingerprint, the merge
// prompt, what a scripted merge answer is read as, the write prompt, the draft a scripted answer is read as, the
// footnotes with their quotes found in the files, the quote repair and the rewrite asked for, the ledger, and the
// overview over the sections as written — and a quote's lines, a line's sentences, a sentence's fact tokens. Both
// paths write documents side by side until P10 (contract `docs.build.server`), a section's fingerprint decides
// whether either writes it again, and the project's criterion asks that the same input give the same
// deterministic answer on both.
//
// The fixture's outputs are this code's. To write them again after a deliberate change to it:
//
//	ORBIT_WIKI_DOCS_BUILD_FIXTURE=write go test -run TestWikiDocsBuildFixtureIsTheServersToo .
//
// and then make the TypeScript port answer the same.

const wikiDocsBuildFixturePath = "../shared/src/wiki-docs-build.fixture.json"

// The commit the fixture names: the checkout's own sha differs from run to run, and is written as this.
const wikiDocsBuildFixtureSha = "5ca1ab1e0ddba11c0ffee5ca1ab1e0ddba11c0ff"

type wikiDocsBuildFixtureRecord struct {
	Kind       string `json:"kind"`
	Ref        string `json:"ref"`
	Weight     string `json:"weight"`
	OwnerWords bool   `json:"ownerWords"`
	Text       string `json:"text"`
	Via        *struct {
		EntryID string `json:"entryId"`
		Title   string `json:"title"`
		Kind    string `json:"kind"`
	} `json:"via"`
}

type wikiDocsBuildFixturePiece struct {
	ID      string       `json:"id"`
	Kind    string       `json:"kind"`
	Path    string       `json:"path"`
	Lines   wikiDocRange `json:"lines"`
	Section string       `json:"section"`
	Symbol  string       `json:"symbol"`
	Ref     string       `json:"ref"`
	Chars   wikiDocRange `json:"chars"`
	Text    string       `json:"text"`
	Action  string       `json:"action"`
	Into    string       `json:"into"`
	Reason  string       `json:"reason"`
	Handed  bool         `json:"handed"`
}

type wikiDocsBuildFixtureSection struct {
	Key          string                      `json:"key"`
	Pieces       []wikiDocsBuildFixturePiece `json:"pieces"`
	Missing      []string                    `json:"missing"`
	Selected     []wikiDocsBuildFixturePiece `json:"selected"`
	Fingerprint  string                      `json:"fingerprint"`
	MergePrompt  string                      `json:"mergePrompt"`
	State        []string                    `json:"state"`
	Merged       []wikiDocsBuildFixturePiece `json:"merged"`
	WritePrompt  string                      `json:"writePrompt"`
	Lonely       []string                    `json:"lonely"`
	AgainPrompt  string                      `json:"againPrompt"`
	Body         string                      `json:"body"`
	Quotes       map[string][]string         `json:"quotes"`
	Unfound      []string                    `json:"unfound"`
	RepairPrompt string                      `json:"repairPrompt"`
	Markdown     string                      `json:"markdown"`
	Footnotes    []wikiDocFootnote           `json:"footnotes"`
	Counts       map[string]int              `json:"counts"`
	Dispositions []wikiDocDisposition        `json:"dispositions"`
}

type wikiDocsBuildFixture struct {
	Why     string                                  `json:"why"`
	Write   string                                  `json:"write"`
	Sha     string                                  `json:"sha"`
	Files   map[string]string                       `json:"files"`
	Doc     json.RawMessage                         `json:"doc"`
	Records map[string][]wikiDocsBuildFixtureRecord `json:"records"`
	Answers struct {
		Merge    map[string]string   `json:"merge"`
		Write    map[string][]string `json:"write"`
		Repair   map[string]string   `json:"repair"`
		Overview string              `json:"overview"`
	} `json:"answers"`
	Sections []wikiDocsBuildFixtureSection `json:"sections"`
	Overview struct {
		Key         string                `json:"key"`
		Fingerprint string                `json:"fingerprint"`
		Sections    []string              `json:"sections"`
		Notes       []wikiDocsFixtureNote `json:"notes"`
		Prompt      string                `json:"prompt"`
		Markdown    string                `json:"markdown"`
		Footnotes   []wikiDocFootnote     `json:"footnotes"`
	} `json:"overview"`
	Locate []struct {
		Path   string        `json:"path"`
		Quote  string        `json:"quote"`
		Within *wikiDocRange `json:"within"`
		Found  *wikiDocRange `json:"found"`
	} `json:"locate"`
	Sentences []struct {
		Line      string   `json:"line"`
		Sentences []string `json:"sentences"`
	} `json:"sentences"`
	FactTokens []struct {
		Sentence string   `json:"sentence"`
		Tokens   []string `json:"tokens"`
	} `json:"factTokens"`
}

type wikiDocsFixtureNote struct {
	ID       string          `json:"id"`
	Footnote wikiDocFootnote `json:"footnote"`
}

func wikiDocsFixturePieces(pieces []*wikiDocPiece) []wikiDocsBuildFixturePiece {
	out := []wikiDocsBuildFixturePiece{}
	for _, p := range pieces {
		out = append(out, wikiDocsBuildFixturePiece{
			ID: p.id, Kind: p.kind, Path: p.path, Lines: p.lines, Section: p.section, Symbol: p.symbol, Ref: p.ref, Chars: p.chars,
			Text: p.text, Action: p.action, Into: p.into, Reason: p.reason, Handed: p.handed,
		})
	}
	return out
}

// wikiDocsBuildFixtureInputs is what the fixture is made of when it is written afresh.
func wikiDocsBuildFixtureInputs() wikiDocsBuildFixture {
	var f wikiDocsBuildFixture
	f.Why = "One input, one deterministic answer on both paths: what src/runner-go/wiki_docs_build.go makes of a confirmed " +
		"document's sections — the material, the filter and the cap, the fingerprint, the prompts, the merge and the draft " +
		"as read, the footnotes and their quotes found in the files, the ledger, the overview — and the TypeScript port in " +
		"src/apiserver/src/wiki-worker must make the same of it, byte for byte."
	f.Write = "ORBIT_WIKI_DOCS_BUILD_FIXTURE=write go test -run TestWikiDocsBuildFixtureIsTheServersToo ."
	f.Sha = wikiDocsBuildFixtureSha
	f.Files = map[string]string{
		"docs/design.md":                  docsDesign,
		"src/runloop.go":                  docsRunloop,
		"contracts/session.contract.json": docsContract,
		"docs/contract.md": "# Contract\n\n## 2. Space\n\nOne space a repository.\n\n## 19. 维护作业：由事实建任务\n\nThe trigger.\n\n" +
			"### 19.4 `orbit wiki maintain --space <id> [--json]`\n\nThe run reads its dossiers, writes its entries and advances the cursor.\n\n" +
			"### 19.5 `orbit wiki check --space <id>`\n\nThe check.\n",
		"src/scheduler.ts": "// The scheduler: claims a session for a runner and hands it the next turn.\n" +
			"import { Queue } from './queue';\n\n" +
			"/** A scheduler of turns. */\nexport class Scheduler {\n  constructor(private readonly queue: Queue) {}\n\n" +
			"  /** Claim the next turn for a runner, or null when there is none. */\n  async claim(runner: string): Promise<string | null> {\n" +
			"    return this.queue.pop(runner);\n  }\n}\n\n" +
			"// dispatchTurn hands a claimed turn to its runner exactly once.\nexport function dispatchTurn(turn: string): boolean {\n  return turn !== '';\n}\n\n" +
			"export const LEASE_SECONDS = 60;\n",
	}
	doc := map[string]interface{}{
		"slug": "session-runtime", "title": "会话运行模型", "question": "一个会话怎么运转？",
		"audience": []string{"新加入的开发者：读完能讲清一轮怎么投递", "运维"},
		"sections": []interface{}{
			map[string]interface{}{"key": "s1", "title": "总览", "kind": "overview", "covers": "这篇讲什么。", "length": 300,
				"sources": map[string]interface{}{"docs": []interface{}{}, "code": []interface{}{}, "contracts": []interface{}{}, "sessions": nil}},
			map[string]interface{}{"key": "s2", "title": "turn 怎么投递", "kind": "flow", "covers": "一轮 turn 从落库到投递。", "length": 400,
				"sources": map[string]interface{}{
					"docs":      []interface{}{map[string]interface{}{"path": "docs/design.md", "section": "2. Delivery"}},
					"code":      []interface{}{map[string]interface{}{"path": "src/runloop.go", "symbols": []string{"runLoop"}}},
					"contracts": []interface{}{map[string]interface{}{"path": "contracts/session.contract.json"}},
					"sessions":  nil,
				}},
			map[string]interface{}{"key": "s3", "title": "约定", "kind": "conventions", "covers": "运行测试的约定。", "length": 400,
				"sources": map[string]interface{}{
					"docs": []interface{}{}, "code": []interface{}{}, "contracts": []interface{}{},
					"sessions": map[string]interface{}{
						"projects": []interface{}{map[string]interface{}{"id": "01a0e39d-4375-7280-8aad-5200529cdec3"}, map[string]interface{}{"id": "Hj3uw4A4Qd1qZ4Zt9tTxQ"}},
						"since":    "2026-09-01", "until": nil, "keywords": []string{"runner 宿主"}, "anchorPaths": []string{"src/"},
						"entryKinds": []string{"convention"}, "topics": []string{}, "evidence": "owner 说测试在哪跑 <&>",
					},
				}},
			map[string]interface{}{"key": "s4", "title": "调度接口 Scheduler", "kind": "interface", "covers": "`dispatchTurn` 和 `Scheduler.claim` 怎么领取与投递。", "length": 500,
				"sources": map[string]interface{}{
					"docs":      []interface{}{map[string]interface{}{"path": "docs/contract.md", "section": "19.4 `orbit wiki maintain --space <id> [--model MODEL] [--json]`"}, map[string]interface{}{"path": "docs/missing.md", "section": nil}},
					"code":      []interface{}{map[string]interface{}{"path": "src/scheduler.ts", "symbols": []string{"Scheduler.claim", "nowhere"}}, map[string]interface{}{"path": "./src/scheduler.ts", "symbols": []string{}}},
					"contracts": []interface{}{map[string]interface{}{"path": "`contracts/session.contract.json`"}},
					"sessions":  nil,
				}},
			map[string]interface{}{"key": "s5", "title": "数据与配置", "kind": "data", "covers": "数据。", "length": 200,
				"sources": map[string]interface{}{
					"docs":      []interface{}{map[string]interface{}{"path": "docs/design.md", "section": nil}},
					"code":      []interface{}{},
					"contracts": []interface{}{},
					"sessions":  nil,
				}},
			// Sources whose paths hold a wildcard and are no file of the commit: git takes `<sha>:<path>` for a
			// pathspec, and `git show` exits 0 printing nothing — an empty file. Escaped, a wildcard is no pattern.
			map[string]interface{}{"key": "s6", "title": "通配符来源", "kind": "flow", "covers": "来源路径带通配符时读到什么。", "length": 300,
				"sources": map[string]interface{}{
					"docs": []interface{}{map[string]interface{}{"path": "docs/*.md", "section": nil}},
					"code": []interface{}{
						map[string]interface{}{"path": "src/*.go", "symbols": []string{}},
						map[string]interface{}{"path": "src/sched?ler.ts", "symbols": []string{"Scheduler.claim"}},
						map[string]interface{}{"path": "src/\\*.go", "symbols": []string{}},
					},
					"contracts": []interface{}{map[string]interface{}{"path": "contracts/[s]ession.contract.json"}},
					"sessions":  nil,
				}},
		},
	}
	f.Doc, _ = json.Marshal(doc)
	via := &struct {
		EntryID string `json:"entryId"`
		Title   string `json:"title"`
		Kind    string `json:"kind"`
	}{EntryID: "0199c2a1-7d1e-7c1a-9b2e-3f4a5b6c7d8e", Title: "全量测试在宿主上跑", Kind: "convention"}
	f.Records = map[string][]wikiDocsBuildFixtureRecord{"s3": {
		{Kind: "turn", Ref: "0199c2a1-0000-7000-8000-000000000001", Weight: "decision", OwnerWords: true, Text: docsOwnerWords},
		{Kind: "turn", Ref: "0199c2a1-0000-7000-8000-000000000002", Weight: "decision", OwnerWords: true, Text: docsTemplateTurn},
		{Kind: "task_comment", Ref: "comment-1", Weight: "merge", Text: docsDelivery},
		{Kind: "task_comment", Ref: "comment-2", Weight: "merge", Text: docsDelivery},
		{Kind: "tool_call", Ref: "call-1", Weight: "output", Text: docsOutput, Via: via},
		{Kind: "turn", Ref: "turn-lunch", Weight: "decision", OwnerWords: true, Text: docsOffTopic},
	}}
	f.Answers.Merge = map[string]string{
		"s2": "D1 | 采用 | 设计文档讲投递\nC1 | 采用 | 代码\n- [K1] ｜ 合并到 [D1] ｜ 契约与设计说的是一件事\n现状：\n- 先存后投 [D1]\n1. 契约写成至少一次 [K1]\n",
		"s3": "S1 | 采用 | owner 原话\nS3 | 采用 | 交付评论\nS5 | 合并到 S1 | 同一件事\nS6 | 舍弃 | 与本节无关\nS2 | 采用 | 不该出现\n现状：\n- 全量测试在宿主上跑 [S1]\n",
		"s4": "D1 | 采用 | 契约文档\nC1 | 舍弃 | 方法太短\nC2 | 合并到 C9 | 目标不在本节\nC3 |   采用\n现状：\n- 调度 [C2]\n",
		"s5": "",
		"s6": "D1 | 采用 | 通配符读到的文件\n现状：\n- 来源读成一个空文件 [D1]\n",
	}
	f.Answers.Write = map[string][]string{
		"s2": {docsWriteS2},
		"s3": {docsWriteS3First, docsWriteS3Second},
		"s4": {"### 调度接口 Scheduler\n`Scheduler.claim` 领取下一轮[C2]，`dispatchTurn` 只投递一次[C4]【D1, C3】。租约 60 秒[C5]。\n\n**引文：**\n" +
			"[C2]: 「Claim the next turn for a runner」\n【C4】「hands a claimed turn to its runner exactly once」\n[D1] “The run reads its dossiers”\n- [C5] 『LEASE_SECONDS = 60』\n"},
		"s5": {"本篇讲设计[D1]。\n\n引文：\n[D1] 「# Design」\n"},
		"s6": {"带通配符的来源读成一个空文件[D1]。\n\n引文：\n[D1] 「docs/*.md」\n"},
	}
	f.Answers.Repair = map[string]string{"s2": "[K1] 「\"delivery\": \"at least once, idempotent on the turn id\"」\n", "s3": docsRepairS3}
	f.Answers.Overview = "### 总览\n一轮先存后投，至少投递一次[F1]。运行约定是全量测试在 runner 宿主上跑[F4]。调度只投递一次[F6][F99]。\n"
	f.Locate = append(f.Locate,
		struct {
			Path   string        `json:"path"`
			Quote  string        `json:"quote"`
			Within *wikiDocRange `json:"within"`
			Found  *wikiDocRange `json:"found"`
		}{Path: "docs/design.md", Quote: "A turn is stored before it is delivered", Within: &wikiDocRange{Start: 7, End: 14}},
	)
	for _, c := range []struct {
		path, quote string
		within      *wikiDocRange
	}{
		{"docs/design.md", "Delivery is idempotent on the turn's id.", &wikiDocRange{Start: 7, End: 14}},
		{"docs/design.md", "Seq stays monotonic across respawn", &wikiDocRange{Start: 7, End: 14}},
		{"docs/design.md", "A turn is stored before it is delivered. Seq stays monotonic", nil},
		{"docs/design.md", "A turn", nil},
		{"docs/design.md", "Ab", nil},
		{"docs/design.md", "“A turn is stored”，before it", nil},
		{"src/runloop.go", "keeps the heartbeat going. It never opens an inbound port.", &wikiDocRange{Start: 3, End: 9}},
		{"src/scheduler.ts", "/** Claim the next turn for a runner, or null", nil},
		{"src/scheduler.ts", "export\\_const LEASE\\_SECONDS", nil},
		{"docs/contract.md", "## 19. 维护作业：由事实建任务", &wikiDocRange{Start: 40, End: 50}},
	} {
		f.Locate = append(f.Locate, struct {
			Path   string        `json:"path"`
			Quote  string        `json:"quote"`
			Within *wikiDocRange `json:"within"`
			Found  *wikiDocRange `json:"found"`
		}{Path: c.path, Quote: c.quote, Within: c.within})
	}
	for _, line := range []string{
		"一轮 turn 先落库再投递，至少投递一次[1]。runner 不开端口[2]？对！",
		"A sentence. Another one!Not here? `a ?? b` stays. 「引号。」[3] next",
		"version 1.2 is out. e.g. this?? and that",
	} {
		f.Sentences = append(f.Sentences, struct {
			Line      string   `json:"line"`
			Sentences []string `json:"sentences"`
		}{Line: line})
	}
	for _, sentence := range []string{
		"全量测试在 `runner 宿主` 上跑，要 412.7s 和 3 次[S1]。",
		"The and for via api_v2/foo-bar 12 个 5ms [D1, C2]",
		"_x ab abc the THE Foo",
	} {
		f.FactTokens = append(f.FactTokens, struct {
			Sentence string   `json:"sentence"`
			Tokens   []string `json:"tokens"`
		}{Sentence: sentence})
	}
	return f
}

// wikiDocsBuildFixtureRun is the fixture's outputs as this code makes them, from its inputs, on a checkout of its
// files — the commit's sha written as the fixture's.
func wikiDocsBuildFixtureRun(t *testing.T, f wikiDocsBuildFixture) wikiDocsBuildFixture {
	t.Helper()
	checkout := newDocsFixture(t, f.Files)
	repo := newWikiDocRepo(checkout.checkout, checkout.first)
	run := &wikiDocsBuildRun{repo: repo}
	var doc wikiDocsPlanDoc
	if err := json.Unmarshal(f.Doc, &doc); err != nil {
		t.Fatal(err)
	}
	out := f
	out.Sections = nil
	written := make([]*wikiDocWrittenSection, len(doc.Sections))
	fingerprints := make([]string, len(doc.Sections))
	for i, planSection := range doc.Sections {
		if planSection.Kind == "overview" {
			continue
		}
		section := wikiDocsBuildFixtureSection{Key: planSection.Key}
		pieces, missing := wikiDocRepoPieces(repo, planSection)
		n := 0
		for _, rec := range f.Records[planSection.Key] {
			n++
			length := len([]rune(rec.Text))
			record := wikiDocMaterialRecord{Kind: rec.Kind, Ref: rec.Ref, Weight: rec.Weight, OwnerWords: rec.OwnerWords, Text: rec.Text,
				Chars: wikiDocRange{Start: 0, End: length}, Length: length}
			if rec.Via != nil {
				record.Via = &struct {
					EntryID string `json:"entryId"`
					Title   string `json:"title"`
					Kind    string `json:"kind"`
				}{EntryID: rec.Via.EntryID, Title: rec.Via.Title, Kind: rec.Via.Kind}
			}
			pieces = append(pieces, &wikiDocPiece{id: "S" + strconv.Itoa(n), kind: rec.Kind, ref: rec.Ref, chars: record.Chars, text: rec.Text, record: &record})
		}
		section.Pieces = wikiDocsFixturePieces(pieces)
		section.Missing = append([]string{}, missing...)
		wikiDocFilter(pieces)
		wikiDocSelect(planSection.Kind, pieces)
		section.Selected = wikiDocsFixturePieces(pieces)
		section.Fingerprint = wikiDocFingerprint(planSection, pieces)
		handed := wikiDocHanded(pieces)
		state := []string{}
		if len(handed) > 0 {
			section.MergePrompt = wikiDocMergePrompt(doc, i, handed)
			state = append(state, wikiDocApplyMerge(f.Answers.Merge[planSection.Key], pieces)...)
		}
		section.State = state
		section.Merged = wikiDocsFixturePieces(pieces)
		used := []*wikiDocPiece{}
		for _, piece := range pieces {
			if piece.action == "adopt" || piece.action == "merge" {
				used = append(used, piece)
			}
		}
		section.WritePrompt = wikiDocWritePrompt(doc, i, state, used)
		answers := f.Answers.Write[planSection.Key]
		draft := wikiDocParseWritten(answers[0], used)
		lonely := wikiDocEndOnlyParagraphs(draft.body)
		section.Lonely = append([]string{}, lonely...)
		if len(lonely) > 0 {
			section.AgainPrompt = section.WritePrompt + wikiDocEndOnlyNote(lonely)
			again := ""
			if len(answers) > 1 {
				again = answers[1]
			}
			retry := wikiDocParseWritten(again, used)
			if strings.TrimSpace(retry.body) != "" && len(wikiDocEndOnlyParagraphs(retry.body)) < len(lonely) {
				draft = retry
			}
		}
		var sectionRun wikiDocsBuildSectionRun
		written[i] = &wikiDocWrittenSection{}
		*written[i] = run.footnotes(&sectionRun, draft, used)
		section.Unfound = append([]string{}, wikiDocUnfoundCitations(draft, *written[i], used)...)
		if len(section.Unfound) > 0 {
			section.RepairPrompt = wikiDocQuoteRepairPrompt(draft, section.Unfound, used)
			for id, quotes := range wikiDocParseQuotes(f.Answers.Repair[planSection.Key]) {
				draft.quotes[id] = append(quotes, draft.quotes[id]...)
			}
			*written[i] = run.footnotes(&sectionRun, draft, used)
		}
		section.Body = draft.body
		section.Quotes = draft.quotes
		section.Markdown = written[i].markdown
		section.Footnotes = written[i].footnotes
		section.Counts = map[string]int{"total": sectionRun.Footnote.Total, "found": sectionRun.Footnote.Found, "noQuote": sectionRun.Footnote.NoQuote}
		section.Dispositions = wikiDocDispositions(pieces)
		fingerprints[i] = section.Fingerprint
		out.Sections = append(out.Sections, section)
	}
	out.Overview.Key = doc.Sections[0].Key
	out.Overview.Fingerprint = wikiDocOverviewFingerprint(doc.Sections[0], doc, 0, fingerprints)
	sections, notes := wikiDocOverviewMaterial(doc, 0, written, nil)
	out.Overview.Sections = sections
	out.Overview.Notes = []wikiDocsFixtureNote{}
	for _, note := range notes {
		out.Overview.Notes = append(out.Overview.Notes, wikiDocsFixtureNote{ID: note.id, Footnote: note.footnote})
	}
	out.Overview.Prompt = wikiDocOverviewPrompt(doc, 0, sections, notes)
	body := wikiDocStripHeading(wikiDocBodyOf(f.Answers.Overview))
	out.Overview.Markdown, out.Overview.Footnotes = run.overviewFootnotes(body, notes)
	for i, c := range out.Locate {
		content, _ := repo.show(c.Path)
		if found, ok := wikiDocLocate(content, c.Quote, c.Within); ok {
			out.Locate[i].Found = &found
		} else {
			out.Locate[i].Found = nil
		}
	}
	for i, c := range out.Sentences {
		out.Sentences[i].Sentences = wikiArticleSentences(c.Line)
	}
	for i, c := range out.FactTokens {
		out.FactTokens[i].Tokens = wikiDocFactTokens(c.Sentence)
	}
	// The checkout's commit is written as the fixture's: it differs from run to run, and nothing hashes it.
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var shaless wikiDocsBuildFixture
	if err := json.Unmarshal(bytes.ReplaceAll(raw, []byte(checkout.first), []byte(wikiDocsBuildFixtureSha)), &shaless); err != nil {
		t.Fatal(err)
	}
	return shaless
}

func TestWikiDocsBuildFixtureIsTheServersToo(t *testing.T) {
	if os.Getenv("ORBIT_WIKI_DOCS_BUILD_FIXTURE") == "write" {
		out := wikiDocsBuildFixtureRun(t, wikiDocsBuildFixtureInputs())
		var buf bytes.Buffer
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(out); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(wikiDocsBuildFixturePath, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(wikiDocsBuildFixturePath)
	if err != nil {
		t.Fatalf("%v — write it with ORBIT_WIKI_DOCS_BUILD_FIXTURE=write", err)
	}
	var fixture wikiDocsBuildFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	// The inputs are this file's: a fixture whose inputs drifted from them is written again, not read.
	inputs := wikiDocsBuildFixtureInputs()
	if !reflect.DeepEqual(fixture.Files, inputs.Files) || !reflect.DeepEqual(fixture.Answers, inputs.Answers) || !jsonEqual(fixture.Doc, inputs.Doc) {
		t.Fatal("the fixture's inputs are not this test's: write it again with ORBIT_WIKI_DOCS_BUILD_FIXTURE=write")
	}
	got := wikiDocsBuildFixtureRun(t, fixture)
	want, _ := json.Marshal(fixture)
	have, _ := json.Marshal(got)
	if !bytes.Equal(want, have) {
		for i := range fixture.Sections {
			if i < len(got.Sections) && !reflect.DeepEqual(fixture.Sections[i], got.Sections[i]) {
				w, _ := json.MarshalIndent(fixture.Sections[i], "", " ")
				g, _ := json.MarshalIndent(got.Sections[i], "", " ")
				t.Errorf("section %s:\nfixture %s\nthis code %s", fixture.Sections[i].Key, w, g)
			}
		}
		t.Fatal("this code no longer answers what the fixture holds: the server's port is held to the fixture, so change both " +
			"(ORBIT_WIKI_DOCS_BUILD_FIXTURE=write, then the TypeScript)")
	}
}

func jsonEqual(a, b json.RawMessage) bool {
	var x, y interface{}
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}
