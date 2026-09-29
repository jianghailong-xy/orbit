package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// The drafting job's own gate (contracts/wiki.contract.json `plan.jobs.run`): what the server's gate checks
// that a draft can be held to here, and what only a runner can check — before anything is sent.
//
//   schema      every line of the answers is a field of the plan, every field within its limits, a
//               section's kind one of the closed set, a category for the agents' conventions there;
//   docCount    the documents are as many as the target;
//   protected   every document the version revised protects is there as it was, in its category, and
//               what it leaves to other documents is still there; a revision moves a section out only
//               if it is a convention, only into the agents' category, and never out of a protected one;
//   references  every file, docs section, symbol and contract is on origin/main at the sha, every project,
//               topic and entry kind is one there is, every document a scope leaves something to is one
//               of the plan's, and every `→ 3.2` or `见 3.2` in the text names a document of this plan.
//
// Its errors carry the server's paths (`plan.docs[3].sections[1].sources.code[0].symbols[2]`), so one list
// of errors — this gate's or the server's — is handed back to the model the same way.

// wikiPlanAssembled is one round's draft: the plan as it would be sent, which document each is, and what
// the gate found.
type wikiPlanAssembled struct {
	plan     wikiPlanDraft
	units    []*wikiPlanUnit
	errors   []wikiPlanGateError
	repo     wikiPlanRepoCheck
	sections int
	// Each document's number now, by its slug.
	slugIDs map[string]string
}

type wikiPlanGate struct {
	run *wikiPlanRun
	a   *wikiPlanAssembled
}

func (g *wikiPlanGate) fail(check, path, format string, args ...interface{}) {
	g.a.errors = append(g.a.errors, wikiPlanGateError{Check: check, Path: path, Message: fmt.Sprintf(format, args...)})
}

// The plan's limits (`plan.rules`), which wiki_plan_test.go holds to the contract.
const (
	wikiPlanTitleMaxChars    = 120
	wikiPlanQuestionMaxChars = 1000
	wikiPlanTextMaxChars     = 1000
	wikiPlanCoversMaxChars   = 2000
	wikiPlanListMaxItems     = 40
	wikiPlanSectionsMax      = 20
	wikiPlanCategoriesMax    = 30
	wikiPlanLengthMaxChars   = 100000
	wikiPlanRepoMissingMax   = 2000
)

var wikiPlanDateOnly = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// assemble builds the round's draft from the catalogue and what was written of each document, and gates it.
func (r *wikiPlanRun) assemble() wikiPlanAssembled {
	r.number()
	a := wikiPlanAssembled{slugIDs: map[string]string{}, repo: wikiPlanRepoCheck{Sha: r.repo.sha, Missing: []wikiPlanRepoMiss{}}}
	g := &wikiPlanGate{run: r, a: &a}
	for _, unit := range r.units {
		if _, dup := a.slugIDs[unit.Slug]; !dup {
			a.slugIDs[unit.Slug] = unit.ID
		}
	}
	keys := map[string]bool{}
	agents := false
	for i, cat := range r.cats {
		path := fmt.Sprintf("plan.categories[%d]", i)
		if !wikiSlugPattern.MatchString(cat.Key) || len(cat.Key) > 64 {
			g.fail("schema", path+".key", "%s is not a key: lowercase letters and digits joined by single hyphens", cat.Key)
		}
		if keys[cat.Key] {
			g.fail("schema", path+".key", "%s is the key of an earlier category", cat.Key)
		}
		keys[cat.Key] = true
		g.text(path+".title", cat.Title, wikiPlanTitleMaxChars, true)
		g.text(path+".question", cat.Question, wikiPlanQuestionMaxChars, false)
		agents = agents || cat.ForAgents
		a.plan.Categories = append(a.plan.Categories, wikiPlanCategory{Key: cat.Key, Title: cat.Title, Question: cat.Question, ForAgents: cat.ForAgents})
	}
	if len(r.cats) > wikiPlanCategoriesMax {
		g.fail("schema", "plan.categories", "a plan has at most %d categories", wikiPlanCategoriesMax)
	}
	if !agents {
		g.fail("schema", "plan.categories", "the plan has no category for the agents' development conventions (how to test, "+
			"commit, land and run commands here): add one, last, with [agents] at the end of its line")
	}
	slugs := map[string]bool{}
	extra := false
	for i, unit := range r.units {
		doc := g.doc(i, unit)
		if slugs[doc.Slug] {
			g.fail("schema", fmt.Sprintf("plan.docs[%d].slug", i), "%s is the slug of an earlier document", doc.Slug)
		}
		slugs[doc.Slug] = true
		if len(doc.Extra) > 0 {
			extra = true
		}
		for _, s := range doc.Sections {
			if len(s.Extra) > 0 {
				extra = true
			}
		}
		a.sections += len(doc.Sections)
		a.plan.Docs = append(a.plan.Docs, doc)
		a.units = append(a.units, unit)
	}
	if extra && r.base != nil {
		a.plan.NewFields = r.base.NewFields
	}
	g.whole(slugs, keys)
	if len(a.repo.Missing) > wikiPlanRepoMissingMax {
		a.repo.Missing = a.repo.Missing[:wikiPlanRepoMissingMax]
	}
	return a
}

// wikiPlanCountError is the gate's error for a plan of n documents, when n is outside the target.
func wikiPlanCountError(n int, target wikiPlanLength) (wikiPlanGateError, bool) {
	if n >= target.Min && n <= target.Max {
		return wikiPlanGateError{}, false
	}
	advice := "merge documents that answer the same reader's question"
	if n < target.Min {
		advice = "split the broadest documents, or add the ones the categories are missing"
	}
	return wikiPlanGateError{Check: "docCount", Path: "plan.docs", Message: fmt.Sprintf("the plan has %d documents; it must have %d to %d: %s",
		n, target.Min, target.Max, advice)}, true
}

// whole is what no one document can say: the count, and the protected documents and moves.
func (g *wikiPlanGate) whole(slugs, keys map[string]bool) {
	r := g.run
	if e, outside := wikiPlanCountError(len(g.a.plan.Docs), r.target); outside {
		g.a.errors = append(g.a.errors, e)
	}
	if r.base == nil {
		return
	}
	for id, slug := range r.baseIDs {
		base := r.baseDocs[slug]
		if !base.Protected {
			continue
		}
		i := -1
		for j, unit := range g.a.units {
			if unit.Slug == slug {
				i = j
			}
		}
		if i < 0 {
			g.fail("protected", "plan.docs", "%s «%s» (`%s`) is protected: it stays in every new version as it is, and this "+
				"catalogue leaves it out — list it, with its slug, in its category `%s`", id, base.Title, slug, base.Category)
			continue
		}
		if !keys[base.Category] {
			g.fail("protected", fmt.Sprintf("plan.docs[%d].category", i), "%s «%s» is protected and stays in its category "+
				"`%s`, which this catalogue no longer has: keep that category, with its key", g.a.units[i].ID, base.Title, base.Category)
		}
		for _, out := range base.ScopeOut {
			for _, target := range out.Docs {
				if !slugs[target] {
					g.fail("protected", "plan.docs", "%s «%s» is protected and leaves «%s» to `%s`, which this catalogue no "+
						"longer has: keep that document", g.a.units[i].ID, base.Title, out.Text, target)
				}
			}
		}
	}
	// A protected document is kept as it is, never merged into another as well.
	for i, unit := range g.a.units {
		for _, source := range unit.Sources {
			slug, ok := r.baseIDs[source]
			if ok && r.baseDocs[slug].Protected && slug != unit.Slug {
				g.fail("protected", fmt.Sprintf("plan.docs[%d].sources", i), "%s is made from %s, which is protected: a protected "+
					"document is kept as it is and not merged into another", unit.ID, source)
			}
		}
	}
	cats := r.cats
	for k, move := range r.moves {
		path := fmt.Sprintf("plan.moves[%d]", k)
		slug, ok := r.baseIDs[move.From]
		if !ok {
			g.fail("protected", path, "moves §%d of %s, which the version revised has no document numbered", move.Section, move.From)
			continue
		}
		base := r.baseDocs[slug]
		if base.Protected {
			g.fail("protected", path, "moves §%d out of %s «%s», which is protected: no section of it moves out", move.Section, move.From, base.Title)
			continue
		}
		if move.Section < 1 || move.Section > len(base.Sections) {
			g.fail("protected", path, "moves §%d of %s «%s», which has %d sections", move.Section, move.From, base.Title, len(base.Sections))
			continue
		}
		section := base.Sections[move.Section-1]
		if section.Kind != "conventions" {
			g.fail("protected", path, "moves §%d «%s» of %s, a %s section: only a conventions section moves into the agents' "+
				"category — keep it where it is", move.Section, section.Title, move.From, section.Kind)
		}
		if move.Target == nil {
			g.fail("protected", path, "moves §%d of %s to %s, which is no document of the new catalogue", move.Section, move.From, move.To)
			continue
		}
		if move.Target.Cat >= len(cats) || !cats[move.Target.Cat].ForAgents {
			g.fail("protected", path, "moves §%d of %s into %s, which is not in the agents' category", move.Section, move.From, move.Target.ID)
		}
	}
}

// renamer is the number a document has now, from its number in the catalogue refs was written against
// (the catalogue as it stands when refs is nil).
func (g *wikiPlanGate) renamer(refs map[string]string) func(string) (string, bool) {
	return func(id string) (string, bool) {
		slug, ok := refs[id]
		if refs == nil {
			for _, unit := range g.run.units {
				if unit.ID == id {
					slug, ok = unit.Slug, true
				}
			}
		}
		if !ok {
			return "", false
		}
		now, ok := g.a.slugIDs[slug]
		return now, ok
	}
}

// crossRefs renumbers the numbers in one text, and names each one that points at no document of this plan.
func (g *wikiPlanGate) crossRefs(path, text string, refs map[string]string) string {
	out, unknown := wikiPlanRenumber(text, g.renamer(refs))
	for _, id := range unknown {
		if slug, ok := refs[id]; ok {
			g.fail("references", path, "«%s» points at %s, which was `%s` and is no document of this plan any more: point at "+
				"the document that covers it now, or drop the pointer", cutRunes(text, 80), id, slug)
			continue
		}
		g.fail("references", path, "«%s» points at %s, which is no document of this plan: name a document by its number in "+
			"the catalogue, or drop the pointer", cutRunes(text, 80), id)
	}
	return out
}

// doc is one document of the draft: carried as it is, carried less its moved sections, or built from what
// the model wrote of it.
func (g *wikiPlanGate) doc(i int, unit *wikiPlanUnit) wikiPlanDoc {
	r := g.run
	path := fmt.Sprintf("plan.docs[%d]", i)
	if unit.Protected != nil {
		doc := *unit.Protected
		// The owner's: what it names that is gone is reported with the draft, and is not the model's to fix.
		for j, s := range doc.Sections {
			g.sources(fmt.Sprintf("%s.sections[%d]", path, j), s.Sources, false)
		}
		return doc
	}
	catKey := ""
	if unit.Cat < len(r.cats) {
		catKey = r.cats[unit.Cat].Key
	}
	if unit.Kept != nil {
		doc := wikiPlanDocInput(*unit.Kept)
		doc.Category, doc.Protected = catKey, false
		if unit.Title != "" {
			doc.Title = unit.Title
		}
		if unit.Question != "" {
			doc.Question = g.crossRefs(path+".question", unit.Question, nil)
		}
		if len(unit.CardScope) > 0 {
			doc.ScopeIn = nil
			for k, item := range unit.CardScope {
				doc.ScopeIn = append(doc.ScopeIn, g.crossRefs(fmt.Sprintf("%s.scopeIn[%d]", path, k), item, nil))
			}
		}
		for k, out := range doc.ScopeOut {
			doc.ScopeOut[k].Text = g.crossRefs(fmt.Sprintf("%s.scopeOut[%d].text", path, k), out.Text, unit.Refs)
			for m, target := range out.Docs {
				if _, ok := g.a.slugIDs[target]; !ok {
					g.fail("references", fmt.Sprintf("%s.scopeOut[%d].docs[%d]", path, k, m), "leaves «%s» to `%s`, which is no "+
						"document of this plan any more: leave it to the document that covers it now", out.Text, target)
				}
			}
		}
		var sections []wikiPlanSection
		for n, s := range doc.Sections {
			if unit.KeptDrop[n+1] {
				continue
			}
			sp := fmt.Sprintf("%s.sections[%d]", path, len(sections))
			s.Covers = g.crossRefs(sp+".covers", s.Covers, unit.Refs)
			g.sources(sp, s.Sources, true)
			sections = append(sections, s)
		}
		doc.Sections = sections
		g.limits(path, doc)
		return doc
	}
	h := unit.Header
	doc := wikiPlanDoc{Category: catKey, Slug: unit.Slug, Title: firstNonEmpty(h.Title, unit.Title)}
	doc.Question = g.crossRefs(path+".question", firstNonEmpty(h.Question, unit.Question), unit.Refs)
	if !unit.HasBody && len(h.Audience) == 0 {
		g.fail("schema", path, "%s «%s» has no body: its reader, scope and outline were not written (the call for it did "+
			"not answer) — write the whole document", unit.ID, doc.Title)
	}
	doc.Audience = h.Audience
	for k, item := range firstNonEmptyList(h.ScopeIn, unit.CardScope) {
		doc.ScopeIn = append(doc.ScopeIn, g.crossRefs(fmt.Sprintf("%s.scopeIn[%d]", path, k), item, unit.Refs))
	}
	for k, item := range h.ScopeOut {
		out := wikiPlanScopeOut{Text: item, Docs: []string{}}
		if m := wikiPlanScopeOutRef.FindStringSubmatch(item); m != nil {
			out.Text = strings.TrimSpace(item[:len(item)-len(m[0])])
			rename := g.renamer(unit.Refs)
			for _, id := range wikiPlanIDs.FindAllString(m[1], -1) {
				now, ok := rename(id)
				if !ok {
					g.fail("references", fmt.Sprintf("%s.scopeOut[%d]", path, k), "«%s» leaves it to %s, which is no document of "+
						"this plan: name the document it is left to by its number in the catalogue", cutRunes(item, 80), id)
					continue
				}
				for slug, sid := range g.a.slugIDs {
					if sid == now {
						out.Docs = append(out.Docs, slug)
					}
				}
			}
		}
		out.Text = g.crossRefs(fmt.Sprintf("%s.scopeOut[%d].text", path, k), out.Text, unit.Refs)
		doc.ScopeOut = append(doc.ScopeOut, out)
	}
	if doc.ScopeOut == nil {
		doc.ScopeOut = []wikiPlanScopeOut{}
	}
	if min, max, ok := wikiPlanRange(h.Length); ok {
		doc.Length = wikiPlanLength{Min: min, Max: max}
	} else if unit.HasBody || h.Length != "" {
		g.fail("schema", path+".length", "篇幅 «%s» is not a length: write it as <a–b 字>", h.Length)
	}
	for _, line := range unit.Stray {
		g.fail("schema", path, "«%s» is not a field of the plan: a document has 标题, 问题, 读者, 含, 不含 and 篇幅, then its "+
			"sections — drop it", cutRunes(line, 80))
	}
	for j, s := range unit.Sections {
		doc.Sections = append(doc.Sections, g.section(fmt.Sprintf("%s.sections[%d]", path, j), s, unit.Refs))
	}
	g.limits(path, doc)
	return doc
}

// section is one section of a document the model wrote, checked.
func (g *wikiPlanGate) section(path string, s wikiPlanSectionDraft, refs map[string]string) wikiPlanSection {
	out := wikiPlanSection{Title: s.Title, Kind: s.Kind}
	if !contains(wikiPlanSectionKinds, s.Kind) {
		g.fail("schema", path+".kind", "%s is not a section kind: one of %s", s.Kind, strings.Join(wikiPlanSectionKinds, ", "))
	}
	if min, _, ok := wikiPlanRange(s.Length); ok {
		out.Length = min
	} else {
		g.fail("schema", path+".length", "字数 «%s» is not a number of characters", s.Length)
	}
	out.Covers = g.crossRefs(path+".covers", s.Covers, refs)
	out.Sources.Docs = s.Docs
	out.Sources.Code = s.Code
	for _, c := range s.Contracts {
		out.Sources.Contracts = append(out.Sources.Contracts, wikiPlanContractSource{Path: c})
	}
	if c := s.Sessions; c != nil {
		sessions := &wikiPlanSessions{Projects: c.Projects, Keywords: c.Keywords, AnchorPaths: c.AnchorPaths, EntryKinds: c.EntryKinds, Topics: c.Topics, Evidence: c.Evidence}
		if c.Since != "" {
			since := c.Since
			sessions.Since = &since
		}
		if c.Until != "" {
			until := c.Until
			sessions.Until = &until
		}
		for _, part := range c.Stray {
			g.fail("schema", path+".sources.sessions", "«%s» is not a part of a session condition: it has 项目, 时间, 关键词, 锚点, "+
				"kind, 主题 and 要找 — drop it", cutRunes(part, 80))
		}
		out.Sources.Sessions = sessions
	}
	for _, line := range s.Stray {
		g.fail("schema", path, "«%s» is not a line of a section: a section has 讲什么, 文档, 代码, 契约 and 会话 lines and "+
			"nothing else — drop it", cutRunes(line, 80))
	}
	g.sources(path, out.Sources, true)
	return out
}

// limits is the server's schema check of one document's fields, run here first.
func (g *wikiPlanGate) limits(path string, doc wikiPlanDoc) {
	if !wikiSlugPattern.MatchString(doc.Slug) || len(doc.Slug) > 64 {
		g.fail("schema", path+".slug", "%s is not a slug: lowercase letters and digits joined by single hyphens", doc.Slug)
	}
	g.text(path+".title", doc.Title, wikiPlanTitleMaxChars, true)
	g.text(path+".question", doc.Question, wikiPlanQuestionMaxChars, true)
	g.texts(path+".audience", doc.Audience, 1)
	g.texts(path+".scopeIn", doc.ScopeIn, 1)
	for k, out := range doc.ScopeOut {
		g.text(fmt.Sprintf("%s.scopeOut[%d].text", path, k), out.Text, wikiPlanTextMaxChars, true)
	}
	if len(doc.ScopeOut) > wikiPlanListMaxItems {
		g.fail("schema", path+".scopeOut", "has at most %d items", wikiPlanListMaxItems)
	}
	if doc.Length.Min < 1 || doc.Length.Max > wikiPlanLengthMaxChars || doc.Length.Max < doc.Length.Min {
		if doc.Length.Min != 0 || doc.Length.Max != 0 {
			g.fail("schema", path+".length", "the length is from 1 to %d characters, its max not below its min", wikiPlanLengthMaxChars)
		}
	}
	switch {
	case len(doc.Sections) == 0:
		g.fail("schema", path+".sections", "is required: the document's outline, one section at least")
	case len(doc.Sections) > wikiPlanSectionsMax:
		g.fail("schema", path+".sections", "a document has at most %d sections", wikiPlanSectionsMax)
	}
	for j, s := range doc.Sections {
		sp := fmt.Sprintf("%s.sections[%d]", path, j)
		g.text(sp+".title", s.Title, wikiPlanTitleMaxChars, true)
		g.text(sp+".covers", s.Covers, wikiPlanCoversMaxChars, true)
		if s.Length < 1 || s.Length > wikiPlanLengthMaxChars {
			g.fail("schema", sp+".length", "must be from 1 to %d", wikiPlanLengthMaxChars)
		}
		if c := s.Sources.Sessions; c != nil {
			for _, date := range []*string{c.Since, c.Until} {
				if date != nil && !wikiPlanDateOnly.MatchString(*date) {
					g.fail("schema", sp+".sources.sessions", "%s is not a date written YYYY-MM-DD", *date)
				}
			}
			if c.Since != nil && c.Until != nil && *c.Until < *c.Since {
				g.fail("schema", sp+".sources.sessions.until", "must not be before since")
			}
		}
	}
}

func (g *wikiPlanGate) text(path, value string, max int, required bool) {
	if required && strings.TrimSpace(value) == "" {
		g.fail("schema", path, "is required")
	}
	if len([]rune(strings.TrimSpace(value))) > max {
		g.fail("schema", path, "is at most %d characters", max)
	}
}

func (g *wikiPlanGate) texts(path string, values []string, minItems int) {
	if len(values) < minItems {
		g.fail("schema", path, "is required: at least %d", minItems)
	}
	if len(values) > wikiPlanListMaxItems {
		g.fail("schema", path, "has at most %d items", wikiPlanListMaxItems)
	}
	for k, v := range values {
		g.text(fmt.Sprintf("%s[%d]", path, k), v, wikiPlanTextMaxChars, true)
	}
}

// miss records a repository reference not found at the sha; fail makes it an error of the gate as well.
func (g *wikiPlanGate) miss(kind, ref, at string, fail bool, format string, args ...interface{}) {
	where := at
	g.a.repo.Missing = append(g.a.repo.Missing, wikiPlanRepoMiss{Kind: kind, Ref: ref, At: &where})
	if fail {
		g.fail("references", at, format, args...)
	}
}

// sources checks what one section names: in the repository at the sha, and in Orbit.
func (g *wikiPlanGate) sources(path string, s wikiPlanSources, fail bool) {
	r := g.run
	sha := shortWikiHash(r.repo.sha)
	for k, d := range s.Docs {
		p := fmt.Sprintf("%s.sources.docs[%d]", path, k)
		g.a.repo.Checked++
		if !r.repo.hasPath(d.Path) {
			g.miss("file", d.Path, p+".path", fail, "%s is no file of the repository at %s: name a document of the documents' list", d.Path, sha)
			continue
		}
		if d.Section != nil && strings.TrimSpace(*d.Section) != "" {
			g.a.repo.Checked++
			if !r.repo.hasDocSection(d.Path, *d.Section) {
				g.miss("docSection", d.Path+" § "+*d.Section, p+".section", fail, "%s has no section «%s» at %s; its sections are: %s",
					d.Path, *d.Section, sha, wikiPlanOneOf(r.repo.headingsOf(d.Path, 30)))
			}
		}
	}
	for k, c := range s.Code {
		p := fmt.Sprintf("%s.sources.code[%d]", path, k)
		g.a.repo.Checked++
		if !r.repo.hasPath(c.Path) {
			g.miss("file", c.Path, p+".path", fail, "%s is no file or directory of the repository at %s: name one the "+
				"repository's structure lists", c.Path, sha)
			continue
		}
		for m, symbol := range c.Symbols {
			g.a.repo.Checked++
			if !r.repo.hasSymbol(c.Path, symbol) {
				g.miss("symbol", c.Path+": "+symbol, fmt.Sprintf("%s.symbols[%d]", p, m), fail, "%s is no symbol of %s at %s; it "+
					"declares: %s", symbol, c.Path, sha, wikiPlanOneOf(r.repo.symbolsOf(c.Path, 40)))
			}
		}
	}
	for k, c := range s.Contracts {
		g.a.repo.Checked++
		if !r.repo.hasPath(c.Path) {
			g.miss("contract", c.Path, fmt.Sprintf("%s.sources.contracts[%d].path", path, k), fail, "%s is no file of the "+
				"repository at %s: name one the contracts list has", c.Path, sha)
		}
	}
	if s.Sessions == nil || !fail {
		return
	}
	sp := path + ".sources.sessions"
	if len(r.online.Projects) < wikiPlanMaterialsProjectsMax {
		titles := map[string]int{}
		ids := map[string]bool{}
		for _, p := range r.online.Projects {
			titles[p.Title]++
			ids[p.ID] = true
		}
		for m, project := range s.Sessions.Projects {
			switch n := titles[project]; {
			case ids[project]:
			case n == 0:
				g.fail("references", fmt.Sprintf("%s.projects[%d]", sp, m), "no project is titled «%s»: name a project exactly "+
					"as the projects' list writes it, or leave it out", project)
			case n > 1:
				g.fail("references", fmt.Sprintf("%s.projects[%d]", sp, m), "%d projects are titled «%s»: leave it out", n, project)
			}
		}
	}
	topics := map[string]bool{}
	for _, t := range r.online.Topics {
		topics[t.Slug] = true
	}
	for m, topic := range s.Sessions.Topics {
		if !topics[topic] {
			g.fail("references", fmt.Sprintf("%s.topics[%d]", sp, m), "%s is not a topic of this space: %s", topic, r.online.topicsBrief())
		}
	}
	for m, kind := range s.Sessions.EntryKinds {
		if !contains(wikiEntryKinds, kind) {
			g.fail("references", fmt.Sprintf("%s.entryKinds[%d]", sp, m), "%s is no kind of entry: one of %s", kind, strings.Join(wikiEntryKinds, ", "))
		}
	}
}

// wikiPlanMaterialsProjectsMax is `plan.jobs.rules.materialsProjectsMax`: a list that long may leave some
// out, so its titles are not held against the draft here — the server's gate checks every one.
const wikiPlanMaterialsProjectsMax = 500

func wikiPlanOneOf(options []string) string {
	if len(options) == 0 {
		return "(none)"
	}
	return strings.Join(options, "; ")
}

// wikiPlanCatalogueLevel reports whether an error is the catalogue's to fix rather than one document's:
// the count, the categories, the moves, a protected document left out, and a document's slug, category or
// sources — what the catalogue says of it.
func wikiPlanCatalogueLevel(path string) bool {
	if !wikiPlanDocPath.MatchString(path) {
		return true
	}
	for _, suffix := range []string{".slug", ".category", ".sources", ".protected"} {
		if m := wikiPlanDocPath.FindString(path); m != "" && path == m+suffix {
			return true
		}
	}
	return false
}

// ── Sending it ──────────────────────────────────────────────────────────────────────────────────

// submit sends a draft this runner's gate let through to the server's: the version it became, or the
// server's errors.
func (r *wikiPlanRun) submit(a wikiPlanAssembled) (int, []wikiPlanGateError, error) {
	var baseVersion *int
	if r.base != nil {
		v := r.base.Version
		baseVersion = &v
	}
	target := r.target
	request := wikiPlanDraftRequest{BaseVersion: baseVersion, Target: &target, Plan: a.plan, RepoCheck: a.repo, Model: r.cfg.model}
	raw, err := r.t.submitWikiPlanDraft(r.sessionID, r.spaceID, request)
	if err != nil {
		if refusal, ok := wikiPlanGateRefused(err); ok {
			errs := refusal.Errors
			if len(errs) == 0 {
				errs = []wikiPlanGateError{{Check: "schema", Path: "plan", Message: refusal.Message}}
			}
			return 0, errs, nil
		}
		return 0, nil, wikiPlanCallError("orbit wiki plan "+r.opts.kind, r.spaceID, err)
	}
	var stored struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil || stored.Version < 1 {
		return 0, nil, fmt.Errorf("the server stored the draft and answered no version: %s", cutRunes(string(raw), 200))
	}
	return stored.Version, nil, nil
}

func sortStrings(list []string) { sort.Strings(list) }
