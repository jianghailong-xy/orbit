package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The compact line format the model drafts a plan in, and how the drafting job reads it back
// (the sample's draft_plan.py and p1_revise.py): the model writes Markdown lines with a few fixed labels,
// never JSON — a forty-document catalogue in JSON is what ran into the sample's hour-long timeout — and
// this file turns them into the plan's schema. It never rewrites a word the model wrote: a line it cannot
// place is kept as stray and handed back by the gate as a field the plan does not have.

// ── What the model's answers are read into ──────────────────────────────────────────────────────

// wikiPlanCat is one category of the catalogue being drafted.
type wikiPlanCat struct {
	Key, Title, Question string
	ForAgents            bool
}

// wikiPlanSectionDraft is one section as the model wrote it.
type wikiPlanSectionDraft struct {
	Title, Kind, Length, Covers string
	Docs                        []wikiPlanDocSource
	Code                        []wikiPlanCodeSource
	Contracts                   []string
	Sessions                    *wikiPlanSessionsDraft
	Stray                       []string
}

// wikiPlanSessionsDraft is a section's session condition as the model wrote it.
type wikiPlanSessionsDraft struct {
	Projects, Keywords, AnchorPaths, EntryKinds, Topics []string
	Since, Until, Evidence                              string
	Stray                                               []string
}

// wikiPlanUnit is one document of the draft: its card in the catalogue, what the model wrote of it, and
// — in a revision — the document of the version revised it is carried from.
type wikiPlanUnit struct {
	// Its number in the catalogue this attempt assembles ("3.2"), and its category (an index of the run's).
	ID  string
	Cat int
	// The card, from the catalogue.
	Slug, Title, Question string
	CardScope             []string
	// The body: its header and its outline, from the details and outline steps, a revision's rewrite, or a redo.
	Header   wikiPlanHeader
	Sections []wikiPlanSectionDraft
	Stray    []string
	HasBody  bool
	// The catalogue its body was written against, id → slug: what "见 3.3" in it meant then.
	Refs map[string]string
	// Carried from the version revised: a protected document, as it is; or one a revision keeps whole,
	// less the sections it moved out.
	Protected *wikiPlanDoc
	Kept      *wikiPlanDocRead
	KeptDrop  map[int]bool
	// A revision's: the documents of the version revised it is made from, by their numbers there.
	Sources []string
}

// wikiPlanHeader is a document's header as the model wrote it.
type wikiPlanHeader struct {
	Title, Question                                  string
	Audience, ScopeIn, ScopeOut                      []string
	Length                                           string
	KeyDocs, KeyCode, KeyContracts, Topics, Projects []string
}

// ── The catalogue ───────────────────────────────────────────────────────────────────────────────

var (
	wikiPlanCatLine  = regexp.MustCompile(`^#{1,3}\s*(\d+)[.、]\s*(.+?)\s*(?:——|—|--)\s*(.+)$`)
	wikiPlanDocLine  = regexp.MustCompile("^[-*]\\s*(\\d+\\.\\d+)\\s+(.+?)\\s*`([^`]+)`\\s*[|｜]\\s*(.+?)\\s*[|｜]\\s*(.+)$")
	wikiPlanBacktick = regexp.MustCompile("`([^`]*)`")
	wikiPlanAgents   = regexp.MustCompile(`\[agents\]|［agents］|（给 ?agent）|\(给 ?agent\)`)
	wikiPlanMoveLine = regexp.MustCompile(`^[-*]\s*(\d+\.\d+)\s*§\s*(\d+)\s*(?:→|->|=>)\s*(\d+\.\d+)`)
	wikiPlanIDs      = regexp.MustCompile(`\d+\.\d+`)
)

// wikiPlanMove is a section a revision moves out of a document of the version revised.
type wikiPlanMove struct {
	From    string // the document's number in the version revised
	Section int    // the section's number there, from 1
	To      string // the document's number in the new catalogue, as the model wrote it
	// The document of the new catalogue it moves into; nil when the model's number names none.
	Target *wikiPlanUnit
}

// wikiPlanCatalogue is a catalogue as read from the model: its categories, each document's card, and —
// a revision's — each document's sources and the sections it moves.
type wikiPlanCatalogue struct {
	Cats  []wikiPlanCat
	Units []*wikiPlanUnit
	Moves []wikiPlanMove
	Stray []string
}

// parseWikiPlanCatalogue reads a catalogue: `## n. title `key` —— question [agents]` and
// `- n.m title `slug`｜question｜含：…` (a revision's also carries `来源：…` and a list of moved sections).
// Documents are numbered again in order, whatever the model numbered them; its own numbers name them only
// in its list of moves. Answers nil for an answer with no category and no document.
func parseWikiPlanCatalogue(text string) *wikiPlanCatalogue {
	out := &wikiPlanCatalogue{}
	modelIDs := map[string]*wikiPlanUnit{}
	inMoves := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || line == "---" {
			continue
		}
		if strings.HasPrefix(line, "#") && strings.Contains(line, "移到") {
			inMoves = true
			continue
		}
		if inMoves {
			if m := wikiPlanMoveLine.FindStringSubmatch(line); m != nil {
				n, _ := strconv.Atoi(m[2])
				out.Moves = append(out.Moves, wikiPlanMove{From: m[1], Section: n, To: m[3]})
			} else if none := strings.TrimSpace(strings.TrimLeft(line, "-*")); none != "无" && none != "（无）" && !strings.HasPrefix(line, "（") {
				out.Stray = append(out.Stray, line)
			}
			continue
		}
		if m := wikiPlanCatLine.FindStringSubmatch(line); m != nil {
			title := m[2]
			key := ""
			if k := wikiPlanBacktick.FindStringSubmatch(title); k != nil {
				key = strings.TrimSpace(k[1])
				title = strings.TrimSpace(wikiPlanBacktick.ReplaceAllString(title, ""))
			}
			question := m[3]
			agents := wikiPlanAgents.MatchString(line)
			question = strings.TrimSpace(wikiPlanAgents.ReplaceAllString(question, ""))
			title = strings.TrimSpace(wikiPlanAgents.ReplaceAllString(title, ""))
			out.Cats = append(out.Cats, wikiPlanCat{Key: key, Title: strings.Trim(title, "* "), Question: question, ForAgents: agents})
			continue
		}
		if m := wikiPlanDocLine.FindStringSubmatch(line); m != nil && len(out.Cats) > 0 {
			unit := &wikiPlanUnit{Cat: len(out.Cats) - 1, Title: strings.Trim(m[2], "* "), Slug: strings.TrimSpace(m[3]), Question: strings.TrimSpace(m[4])}
			for _, part := range wikiPlanSplitBar(m[5]) {
				label, value := wikiPlanLabel(part)
				switch label {
				case "含":
					unit.CardScope = wikiPlanSplitList(value)
				case "来源":
					unit.Sources = wikiPlanIDs.FindAllString(value, -1)
				default:
					unit.Stray = append(unit.Stray, part)
				}
			}
			modelIDs[m[1]] = unit
			out.Units = append(out.Units, unit)
			continue
		}
		out.Stray = append(out.Stray, line)
	}
	if len(out.Cats) == 0 || len(out.Units) == 0 {
		return nil
	}
	// The model's numbers of the new catalogue, in its list of moves, name the documents they move into.
	for i := range out.Moves {
		out.Moves[i].Target = modelIDs[out.Moves[i].To]
	}
	return out
}

func wikiPlanSplitBar(text string) []string {
	var out []string
	for _, part := range strings.FieldsFunc(text, func(r rune) bool { return r == '|' || r == '｜' }) {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// wikiPlanLabel splits `标签：值`; a line with no label answers "" and itself.
func wikiPlanLabel(text string) (string, string) {
	text = strings.TrimSpace(text)
	for i, r := range text {
		if r == '：' || r == ':' {
			label := strings.TrimSpace(text[:i])
			if label != "" && len([]rune(label)) <= 12 && !strings.ContainsAny(label, " /`") {
				return label, strings.TrimSpace(text[i+len(string(r)):])
			}
			break
		}
		if i > 40 {
			break
		}
	}
	return "", text
}

// wikiPlanSplitList splits a list the model wrote with ；/; between its items.
func wikiPlanSplitList(text string) []string {
	var out []string
	for _, part := range strings.FieldsFunc(text, func(r rune) bool { return r == '；' || r == ';' }) {
		if p := strings.TrimSpace(part); p != "" && p != "无" && p != "—" && p != "-" {
			out = append(out, p)
		}
	}
	return out
}

// wikiPlanSplitNames splits names the model wrote with 、,， between them.
func wikiPlanSplitNames(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" || text == "无" || text == "—" || text == "-" || text == "（无）" {
		return nil
	}
	var out []string
	for _, part := range strings.FieldsFunc(text, func(r rune) bool { return r == '、' || r == ',' || r == '，' }) {
		if p := strings.Trim(strings.TrimSpace(part), "`「」"); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ── One document's header and outline ───────────────────────────────────────────────────────────

var (
	wikiPlanSectionLine = regexp.MustCompile(`^#{2,5}\s*(\d+)[.、]\s*(.+?)\s*[|｜]\s*([A-Za-z]+)\s*[|｜]\s*(.+?)\s*$`)
	wikiPlanDocHeading  = regexp.MustCompile(`^#{2,4}\s*(\d+\.\d+)\s*(.*)$`)
	wikiPlanDate        = regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)
)

// wikiPlanHeaderLabels are the labels a document's header has, and the key materials a details answer
// adds, which are read for the next step and not stored.
var wikiPlanHeaderLabels = map[string]bool{"标题": true, "问题": true, "读者": true, "含": true, "不含": true, "篇幅": true,
	"文档": true, "代码": true, "契约": true, "主题": true, "项目": true}

// parseWikiPlanDocBody reads one document's header lines and its outline: what a revision's rewrite and
// a redo answer, and what the details and outline steps answer between them.
func parseWikiPlanDocBody(text string) (wikiPlanHeader, []wikiPlanSectionDraft, []string) {
	var header wikiPlanHeader
	var sections []wikiPlanSectionDraft
	var stray []string
	var current *wikiPlanSectionDraft
	lastCovers := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || line == "---" || line == "```" {
			continue
		}
		if m := wikiPlanSectionLine.FindStringSubmatch(line); m != nil {
			sections = append(sections, wikiPlanSectionDraft{Title: strings.Trim(m[2], "* "), Kind: strings.ToLower(m[3]), Length: m[4]})
			current = &sections[len(sections)-1]
			lastCovers = false
			continue
		}
		if wikiPlanDocHeading.MatchString(line) && current == nil {
			continue // `### 3.2 title`: the document's own heading
		}
		body := strings.TrimSpace(strings.TrimLeft(line, "-*•"))
		label, value := wikiPlanLabel(body)
		if current == nil {
			switch label {
			case "标题":
				header.Title = value
			case "问题":
				header.Question = value
			case "读者":
				header.Audience = wikiPlanSplitList(value)
			case "含":
				header.ScopeIn = wikiPlanSplitList(value)
			case "不含":
				header.ScopeOut = wikiPlanSplitList(value)
			case "篇幅":
				header.Length = value
			case "文档":
				header.KeyDocs = wikiPlanPaths(value)
			case "代码":
				header.KeyCode = wikiPlanPaths(value)
			case "契约":
				header.KeyContracts = wikiPlanPaths(value)
			case "主题":
				header.Topics = wikiPlanSplitNames(value)
			case "项目":
				header.Projects = wikiPlanProjectsOf(value)
			default:
				stray = append(stray, body)
			}
			continue
		}
		switch label {
		case "讲什么", "covers":
			current.Covers = value
			lastCovers = true
			continue
		case "文档":
			current.Docs = append(current.Docs, wikiPlanDocSourcesOf(value)...)
		case "代码":
			current.Code = append(current.Code, wikiPlanCodeSourcesOf(value)...)
		case "契约":
			current.Contracts = append(current.Contracts, wikiPlanPaths(value)...)
		case "会话", "会话与条目":
			current.Sessions = wikiPlanSessionsOf(value)
		case "":
			if lastCovers && !strings.HasPrefix(line, "-") {
				current.Covers = strings.TrimSpace(current.Covers + " " + body)
				continue
			}
			current.Stray = append(current.Stray, body)
		default:
			current.Stray = append(current.Stray, body)
		}
		lastCovers = false
	}
	return header, sections, stray
}

// parseWikiPlanDetails reads a details answer: one `### n.m title` block a document, with its header lines.
func parseWikiPlanDetails(text string) map[string]wikiPlanHeader {
	out := map[string]wikiPlanHeader{}
	var id string
	var block []string
	flush := func() {
		if id != "" {
			header, _, _ := parseWikiPlanDocBody(strings.Join(block, "\n"))
			out[id] = header
		}
	}
	for _, raw := range strings.Split(text, "\n") {
		if m := wikiPlanDocHeading.FindStringSubmatch(strings.TrimSpace(raw)); m != nil {
			flush()
			id, block = m[1], nil
			continue
		}
		block = append(block, raw)
	}
	flush()
	return out
}

// wikiPlanPaths reads paths as the model writes them: `a、b`, `dir/（x.ts、y.ts）` (files inside dir),
// `path（note）` (a note, not part of the path).
func wikiPlanPaths(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" || text == "无" || text == "（无）" || text == "—" {
		return nil
	}
	expand := regexp.MustCompile(`([\w./\-]+/)\s*[（(]([^）)]*)[）)]`)
	text = expand.ReplaceAllStringFunc(text, func(m string) string {
		sub := expand.FindStringSubmatch(m)
		names := wikiPlanSplitNames(sub[2])
		if len(names) == 0 || !regexp.MustCompile(`\.[a-z]{1,5}\b|/$|\*`).MatchString(sub[2]) {
			return m
		}
		for i := range names {
			names[i] = sub[1] + names[i]
		}
		return strings.Join(names, "、")
	})
	var out []string
	depth, cur := 0, strings.Builder{}
	flush := func() {
		part := strings.Trim(strings.TrimSpace(cur.String()), "`「」")
		cur.Reset()
		if part == "" {
			return
		}
		if i := strings.IndexAny(part, "（("); i > 0 {
			part = strings.TrimSpace(part[:i])
		}
		out = append(out, strings.Trim(part, "`"))
	}
	for _, r := range text {
		switch {
		case r == '（' || r == '(':
			depth++
		case r == '）' || r == ')':
			if depth > 0 {
				depth--
			}
		}
		if depth == 0 && (r == '、' || r == ',' || r == '，' || r == ';' || r == '；') {
			flush()
			continue
		}
		cur.WriteRune(r)
	}
	flush()
	return out
}

// wikiPlanDocSourcesOf reads `docs/x.md § heading` (or several `§` of one document).
func wikiPlanDocSourcesOf(text string) []wikiPlanDocSource {
	file, sections, has := strings.Cut(text, "§")
	paths := wikiPlanPaths(file)
	if len(paths) == 0 {
		return nil
	}
	if !has {
		return []wikiPlanDocSource{{Path: paths[0]}}
	}
	var out []wikiPlanDocSource
	for _, section := range wikiPlanSectionNames(sections) {
		s := wikiPlanUnwrap(section)
		if wikiPlanWholeDoc[s] {
			out = append(out, wikiPlanDocSource{Path: paths[0]})
			continue
		}
		out = append(out, wikiPlanDocSource{Path: paths[0], Section: &s})
	}
	return out
}

// wikiPlanSectionNames splits `a、§ b` into its sections: at a separator followed by `§`, and never inside
// parentheses, where a heading's own text may name other sections — «2. 加固后的恢复策略（契约 §6.4、§6.5）» is one.
func wikiPlanSectionNames(text string) []string {
	runes := []rune(text)
	var out []string
	var name strings.Builder
	depth := 0
	for i := 0; i < len(runes); i++ {
		switch r := runes[i]; {
		case r == '（' || r == '(':
			depth++
		case (r == '）' || r == ')') && depth > 0:
			depth--
		case depth == 0 && strings.ContainsRune("、,，;；", r):
			next := i + 1
			for next < len(runes) && (runes[next] == ' ' || runes[next] == '\u3000' || runes[next] == '\t') {
				next++
			}
			if next < len(runes) && runes[next] == '§' {
				out = append(out, name.String())
				name.Reset()
				i = next
				continue
			}
		}
		name.WriteRune(runes[i])
	}
	return append(out, name.String())
}

// wikiPlanWholeDoc are the names a model gives the whole of a document after `§`: no section.
var wikiPlanWholeDoc = map[string]bool{"正文": true, "全文": true, "全篇": true, "整篇": true}

// wikiPlanUnwrap takes off parentheses a model put around a whole name, and one left unmatched at either
// end — never the closing one of a name that ends in its own, as «4. 数据模型（新表 `share_link`）» does.
func wikiPlanUnwrap(text string) string {
	opening := func(r rune) bool { return r == '（' || r == '(' }
	closing := func(r rune) bool { return r == '）' || r == ')' }
	for {
		runes := []rune(strings.TrimSpace(text))
		if len(runes) == 0 {
			return ""
		}
		depth, opens, closes, wraps := 0, 0, 0, opening(runes[0])
		for i, r := range runes {
			switch {
			case opening(r):
				depth++
				opens++
			case closing(r):
				depth--
				closes++
				if depth == 0 && i < len(runes)-1 {
					wraps = false
				}
			}
		}
		first, last := runes[0], runes[len(runes)-1]
		switch {
		case closing(last) && closes > opens:
			text = string(runes[:len(runes)-1])
		case opening(first) && opens > closes:
			text = string(runes[1:])
		case wraps && closing(last) && depth == 0:
			text = string(runes[1 : len(runes)-1])
		default:
			return string(runes)
		}
	}
}

// wikiPlanCodeGroup is where another `path: symbols` begins on the same line, after a `；`: a path, then
// a colon. What follows a `；` without one is more symbols of the path before it.
var wikiPlanCodeGroup = regexp.MustCompile(`^[^\s:：,，、]+(?:/|\.[A-Za-z0-9]+)[^\s:：,，、]*\s*[:：]`)

// wikiPlanCodeSourcesOf reads `src/x.go: a(), B.c`, and several of them on one line, `；` between them.
func wikiPlanCodeSourcesOf(text string) []wikiPlanCodeSource {
	var groups []string
	for _, part := range strings.FieldsFunc(text, func(r rune) bool { return r == ';' || r == '；' }) {
		part = strings.TrimSpace(part)
		switch {
		case part == "":
		case len(groups) == 0 || wikiPlanCodeGroup.MatchString(part):
			groups = append(groups, part)
		default:
			groups[len(groups)-1] += "、" + part
		}
	}
	var out []wikiPlanCodeSource
	for _, group := range groups {
		out = append(out, wikiPlanCodeGroupOf(group)...)
	}
	return out
}

// wikiPlanCodeGroupOf reads one `src/x.go: a(), B.c`.
func wikiPlanCodeGroupOf(text string) []wikiPlanCodeSource {
	head, rest := text, ""
	if m := regexp.MustCompile(`^(.*?\S)\s*[:：]\s+(.*)$`).FindStringSubmatch(text); m != nil {
		head, rest = m[1], m[2]
	} else if m := regexp.MustCompile(`^(.*?\S)[:：](.*)$`).FindStringSubmatch(text); m != nil {
		head, rest = m[1], m[2]
	}
	var symbols []string
	for _, part := range strings.FieldsFunc(rest, func(r rune) bool { return r == ',' || r == '，' || r == '、' }) {
		if p := strings.Trim(strings.TrimSpace(part), "`"); p != "" {
			symbols = append(symbols, p)
		}
	}
	var out []wikiPlanCodeSource
	for _, p := range wikiPlanPaths(head) {
		out = append(out, wikiPlanCodeSource{Path: p, Symbols: symbols})
	}
	return out
}

// wikiPlanProjectsOf reads project titles, each in 「」 — a 「」 inside one is part of its title, as in
// 「把「什么算完成」从项目末尾搬到开工前」 — or, without them, between 、,，.
func wikiPlanProjectsOf(text string) []string {
	var out []string
	var title strings.Builder
	depth := 0
	for _, r := range text {
		switch {
		case r == '「':
			if depth > 0 {
				title.WriteRune(r)
			}
			depth++
		case r == '」' && depth > 0:
			depth--
			if depth > 0 {
				title.WriteRune(r)
			} else if t := strings.TrimSpace(title.String()); t != "" {
				out = append(out, t)
				title.Reset()
			}
		case depth > 0:
			title.WriteRune(r)
		}
	}
	if len(out) > 0 {
		return out
	}
	return wikiPlanSplitNames(text)
}

// wikiPlanSessionsOf reads `项目「…」；时间 A 至 B；关键词 …；锚点 …；kind …；主题 …；要找：…`.
func wikiPlanSessionsOf(text string) *wikiPlanSessionsDraft {
	out := &wikiPlanSessionsDraft{}
	body := text
	for _, mark := range []string{"要找：", "要找:"} {
		if before, after, ok := strings.Cut(body, mark); ok {
			body, out.Evidence = before, strings.TrimSpace(after)
			break
		}
	}
	for _, part := range strings.FieldsFunc(body, func(r rune) bool { return r == '；' || r == ';' }) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		switch {
		case strings.HasPrefix(part, "项目"):
			out.Projects = wikiPlanProjectsOf(strings.TrimSpace(strings.TrimPrefix(part, "项目")))
		case strings.HasPrefix(part, "时间"):
			dates := wikiPlanDate.FindAllString(part, -1)
			if len(dates) > 0 {
				out.Since = dates[0]
			}
			if len(dates) > 1 {
				out.Until = dates[1]
			}
			if len(dates) == 0 {
				out.Stray = append(out.Stray, part)
			}
		case strings.HasPrefix(part, "关键词"):
			out.Keywords = wikiPlanSplitNames(strings.TrimPrefix(part, "关键词"))
		case strings.HasPrefix(part, "锚点路径"):
			out.AnchorPaths = wikiPlanSplitNames(strings.TrimPrefix(part, "锚点路径"))
		case strings.HasPrefix(part, "锚点"):
			out.AnchorPaths = wikiPlanSplitNames(strings.TrimPrefix(part, "锚点"))
		case strings.HasPrefix(strings.ToLower(part), "kind"):
			for _, k := range strings.FieldsFunc(part[4:], func(r rune) bool { return r == '/' || r == '、' || r == ',' || r == '，' || r == ' ' }) {
				if k = strings.TrimSpace(k); k != "" {
					out.EntryKinds = append(out.EntryKinds, k)
				}
			}
		case strings.HasPrefix(part, "条目 kind"):
			for _, k := range strings.FieldsFunc(strings.TrimPrefix(part, "条目 kind"), func(r rune) bool { return r == '/' || r == '、' || r == ',' || r == '，' || r == ' ' }) {
				out.EntryKinds = append(out.EntryKinds, k)
			}
		case strings.HasPrefix(part, "现有主题"):
			out.Topics = wikiPlanSplitNames(strings.TrimPrefix(part, "现有主题"))
		case strings.HasPrefix(part, "主题"):
			out.Topics = wikiPlanSplitNames(strings.TrimPrefix(part, "主题"))
		default:
			out.Stray = append(out.Stray, part)
		}
	}
	return out
}

// ── Numbers of documents in the text ────────────────────────────────────────────────────────────

// wikiPlanCrossRef is a pointer to another document written in words: `→ 3.2`, `见 3.2、3.3`, `see 3.2`.
var wikiPlanCrossRef = regexp.MustCompile(`(→|->|参见|见|[Ss]ee)\s*((?:\d+\.\d+)(?:\s*(?:[、,，]|和|及|与|and)\s*\d+\.\d+)*)`)

// wikiPlanScopeOutRef is the `（见 3.2）` a scope-out item ends with.
var wikiPlanScopeOutRef = regexp.MustCompile(`\s*[（(]\s*(?:见|参见|→|see)\s*((?:\d+\.\d+)(?:\s*(?:[、,，]|和|及|与)\s*\d+\.\d+)*)\s*[）)]\s*$`)

// wikiPlanRenumber rewrites every document number in text through rename (its number in the catalogue
// the text was written against → its number now), and names each one rename does not know.
func wikiPlanRenumber(text string, rename func(id string) (string, bool)) (string, []string) {
	var unknown []string
	out := wikiPlanCrossRef.ReplaceAllStringFunc(text, func(m string) string {
		sub := wikiPlanCrossRef.FindStringSubmatch(m)
		ids := wikiPlanIDs.ReplaceAllStringFunc(sub[2], func(id string) string {
			now, ok := rename(id)
			if !ok {
				unknown = append(unknown, id)
				return id
			}
			return now
		})
		return strings.Replace(m, sub[2], ids, 1)
	})
	return out, unknown
}

// ── Lengths ─────────────────────────────────────────────────────────────────────────────────────

var wikiPlanNumber = regexp.MustCompile(`\d[\d,]*`)

// wikiPlanRange reads `1200–2000 字`, `约 1500 字` or `2,000`: the range a document is written to.
func wikiPlanRange(text string) (int, int, bool) {
	var nums []int
	for _, m := range wikiPlanNumber.FindAllString(text, 2) {
		n, err := strconv.Atoi(strings.ReplaceAll(m, ",", ""))
		if err == nil {
			nums = append(nums, n)
		}
	}
	switch len(nums) {
	case 1:
		return nums[0], nums[0], nums[0] > 0
	case 2:
		return nums[0], nums[1], nums[0] > 0 && nums[1] >= nums[0]
	}
	return 0, 0, false
}

// ── Writing a document back in the format ───────────────────────────────────────────────────────

// wikiPlanDocLines is a document of a version in the line format: what a revision hands the model of the
// documents a new one is made from, and a redo of what it wrote.
func wikiPlanDocLines(doc wikiPlanDoc, withHeader bool, drop map[int]bool) string {
	var b strings.Builder
	if withHeader {
		fmt.Fprintf(&b, "标题：%s\n问题：%s\n读者：%s\n含：%s\n", doc.Title, doc.Question, strings.Join(doc.Audience, "；"), strings.Join(doc.ScopeIn, "；"))
		var outs []string
		for _, out := range doc.ScopeOut {
			outs = append(outs, out.Text)
		}
		if len(outs) > 0 {
			fmt.Fprintf(&b, "不含：%s\n", strings.Join(outs, "；"))
		}
		fmt.Fprintf(&b, "篇幅：%d–%d 字\n", doc.Length.Min, doc.Length.Max)
	}
	n := 0
	for i, section := range doc.Sections {
		if drop[i+1] {
			continue
		}
		n++
		b.WriteString(wikiPlanSectionLines(n, section))
	}
	return b.String()
}

// wikiPlanSectionLines is one section in the line format.
func wikiPlanSectionLines(n int, s wikiPlanSection) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n### %d. %s | %s | %d\n讲什么：%s\n", n, s.Title, s.Kind, s.Length, s.Covers)
	for _, d := range s.Sources.Docs {
		if d.Section != nil && *d.Section != "" {
			fmt.Fprintf(&b, "- 文档：%s § %s\n", d.Path, *d.Section)
		} else {
			fmt.Fprintf(&b, "- 文档：%s\n", d.Path)
		}
	}
	for _, c := range s.Sources.Code {
		if len(c.Symbols) > 0 {
			fmt.Fprintf(&b, "- 代码：%s: %s\n", c.Path, strings.Join(c.Symbols, ", "))
		} else {
			fmt.Fprintf(&b, "- 代码：%s\n", c.Path)
		}
	}
	for _, c := range s.Sources.Contracts {
		fmt.Fprintf(&b, "- 契约：%s\n", c.Path)
	}
	if s.Sources.Sessions != nil {
		b.WriteString("- 会话：" + wikiPlanSessionsLine(*s.Sources.Sessions) + "\n")
	}
	return b.String()
}

func wikiPlanSessionsLine(s wikiPlanSessions) string {
	var parts []string
	if len(s.Projects) > 0 {
		var quoted []string
		for _, p := range s.Projects {
			quoted = append(quoted, "「"+p+"」")
		}
		parts = append(parts, "项目"+strings.Join(quoted, ""))
	}
	if s.Since != nil || s.Until != nil {
		since, until := "", "今"
		if s.Since != nil {
			since = *s.Since
		}
		if s.Until != nil {
			until = *s.Until
		}
		parts = append(parts, "时间 "+since+" 至 "+until)
	}
	if len(s.Keywords) > 0 {
		parts = append(parts, "关键词 "+strings.Join(s.Keywords, "、"))
	}
	if len(s.AnchorPaths) > 0 {
		parts = append(parts, "锚点 "+strings.Join(s.AnchorPaths, "、"))
	}
	if len(s.EntryKinds) > 0 {
		parts = append(parts, "kind "+strings.Join(s.EntryKinds, "/"))
	}
	if len(s.Topics) > 0 {
		parts = append(parts, "主题 "+strings.Join(s.Topics, "、"))
	}
	line := strings.Join(parts, "；")
	if s.Evidence != "" {
		line += "；要找：" + s.Evidence
	}
	return line
}
