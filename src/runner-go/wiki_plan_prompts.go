package main

import (
	"fmt"
	"strings"
	"time"
)

// What the drafting job asks the model, step by step (the sample's draft_plan.py and p1_revise.py, made
// general): the materials each step reads, and the line format each answer is written in. The prompts are
// English, as all of Orbit's copy is (AGENTS.md section 5); the paths, symbols and commands in them are the
// repository's own.

const wikiPlanBackground = `
## Background
The main view this wiki gives people to read is a set of "product and technical documents": a reader who opens one learns what the feature is, how it works, where its interfaces are, how it is operated, what its known pitfalls are and why it was designed this way.
First a plan is drafted for the owner to confirm; then, following the plan, the material of each section is gathered and the documents are written section by section: a section on a mechanism draws on the design documents, the code and the contracts; pitfalls, decisions and conventions draw on the words said in sessions.
The plan is held by a gate in code: every file, document section, symbol, project and topic must be found in the materials, the number of documents must be within the target, and any field outside the format is sent back.
`

// wrap is one material, numbered and labelled.
func wikiPlanMaterial(n int, label, body string) string {
	return fmt.Sprintf("<material %d: %s>\n%s\n</material %d>\n", n, label, strings.TrimSpace(body), n)
}

func (r *wikiPlanRun) materialsHead() string {
	return fmt.Sprintf("# Materials (read-only from origin/main %s and Orbit, %s; space «%s»)\n\n", shortWikiHash(r.repo.sha),
		time.Now().UTC().Format("2006-01-02"), r.job.Space.Title)
}

// fullMaterials is what the catalogue is drafted from: the repository's overview, structure, documents
// and contracts, and the owner's projects, the space's sessions and what the wiki already holds.
func (r *wikiPlanRun) fullMaterials() string {
	var b strings.Builder
	b.WriteString(r.materialsHead())
	n := 0
	add := func(label, body string) {
		if strings.TrimSpace(body) == "" {
			return
		}
		n++
		b.WriteString(wikiPlanMaterial(n, label, body) + "\n")
	}
	add("Repository overview (docs/README.md and docs/architecture.md, or README.md)", r.repo.overviewText(14000))
	add("Repository structure: packages, directories and source files, entry points, data model", r.repo.layoutText(32000))
	add("Document heading tree: the sections of the design, contract and operations documents", r.repo.docsTreeText(45000))
	add("contracts inventory", r.repo.contractsText())
	add("Project titles", r.online.projectsText())
	add("Recent sessions: counts and title clusters", r.online.sessionsText())
	add("This space's entries and topics", r.online.spaceText())
	return b.String()
}

// detailMaterials is what each category's documents are detailed from.
func (r *wikiPlanRun) detailMaterials() string {
	var b strings.Builder
	b.WriteString(r.materialsHead())
	b.WriteString(wikiPlanMaterial(1, "Repository overview", r.repo.overviewText(10000)) + "\n")
	b.WriteString(wikiPlanMaterial(2, "Documents and their second-level sections (use only the document paths that appear here)", r.repo.docsTreeText(30000)) + "\n")
	b.WriteString(wikiPlanMaterial(3, "Repository structure (use only the code paths that appear here)", r.repo.layoutText(26000)) + "\n")
	b.WriteString(wikiPlanMaterial(4, "contracts inventory", r.repo.contractsText()) + "\n")
	b.WriteString(wikiPlanMaterial(5, "Project titles (copy a title exactly)", r.online.projectsText()) + "\n")
	b.WriteString(wikiPlanMaterial(6, "This space's topics", r.online.topicsBrief()) + "\n")
	return b.String()
}

// docMaterials is what one document's outline is written from: its documents' whole heading trees, its
// code's symbols, and the topics it names — the targeted materials of the sample's doc_materials.
func (r *wikiPlanRun) docMaterials(unit *wikiPlanUnit) string {
	docs, code, topics := append([]string{}, unit.Header.KeyDocs...), append([]string{}, unit.Header.KeyCode...), append([]string{}, unit.Header.Topics...)
	sections := unit.Sections
	if unit.Kept != nil {
		kept := wikiPlanDocInput(*unit.Kept)
		for _, s := range kept.Sections {
			sections = append(sections, wikiPlanSectionDraft{Docs: s.Sources.Docs, Code: s.Sources.Code})
			if s.Sources.Sessions != nil {
				topics = append(topics, s.Sources.Sessions.Topics...)
			}
		}
	}
	for _, s := range sections {
		for _, d := range s.Docs {
			docs = append(docs, d.Path)
		}
		for _, c := range s.Code {
			code = append(code, c.Path)
		}
		if s.Sessions != nil {
			topics = append(topics, s.Sessions.Topics...)
		}
	}
	var trees strings.Builder
	seen := map[string]bool{}
	for _, file := range docs {
		file = strings.TrimPrefix(strings.TrimSpace(file), "./")
		if seen[file] || r.repo.headings[file] == nil {
			continue
		}
		seen[file] = true
		trees.WriteString(r.repo.docBlock(file, 6))
	}
	if trees.Len() == 0 {
		trees.WriteString("(this document has no main source documents yet, or they are not in the documents list)\n")
	}
	var b strings.Builder
	b.WriteString(r.materialsHead())
	b.WriteString(wikiPlanMaterial(1, "Repository overview", r.repo.overviewText(8000)) + "\n")
	b.WriteString(wikiPlanMaterial(2, "All documents (path [bytes] — title)", r.repo.docIndexText()) + "\n")
	b.WriteString(wikiPlanMaterial(3, "The section trees of this document's main source documents (after § on a Docs line, copy a section heading from here exactly)", trees.String()) + "\n")
	b.WriteString(wikiPlanMaterial(4, "The symbols of the code this document is about (written \"path: symbol, Class.method [HTTP route], function()\"; on a Code line, "+
		"copy the paths and symbols from here exactly)", r.repo.codeExcerpt(code, 16000)) + "\n")
	b.WriteString(wikiPlanMaterial(5, "contracts inventory", r.repo.contractsText()) + "\n")
	b.WriteString(wikiPlanMaterial(6, "Project titles (the projects on a Sessions line copy a title from here exactly)", r.online.projectsText()) + "\n")
	b.WriteString(wikiPlanMaterial(7, "This space's topics, and the newest entries of the topics this document is about (the topics on a Sessions line use only "+
		"the slugs here)", r.online.topicBlocks(topics)) + "\n")
	return b.String()
}

// catalogueText is the catalogue as it stands, in the line format, with the documents' numbers now.
func (r *wikiPlanRun) catalogueText() string {
	var b strings.Builder
	for c, cat := range r.cats {
		agents := ""
		if cat.ForAgents {
			agents = " [agents]"
		}
		fmt.Fprintf(&b, "## %d. %s `%s` — %s%s\n", c+1, cat.Title, cat.Key, cat.Question, agents)
		for _, unit := range r.units {
			if unit.Cat != c {
				continue
			}
			scope := unit.CardScope
			if len(unit.Header.ScopeIn) > 0 {
				scope = unit.Header.ScopeIn
			}
			mark := ""
			if unit.Protected != nil {
				mark = " [protected]"
			}
			fmt.Fprintf(&b, "- %s %s `%s`%s | %s | Includes: %s\n", unit.ID, unit.Title, unit.Slug, mark, unit.Question, strings.Join(scope, "; "))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// protectedBlock names the documents of the version revised the owner protected: a draft keeps them as they are.
func (r *wikiPlanRun) protectedBlock() string {
	if r.base == nil {
		return ""
	}
	var lines []string
	for id, slug := range r.baseIDs {
		doc := r.baseDocs[slug]
		if doc.Protected {
			lines = append(lines, fmt.Sprintf("- `%s` %s (now %s, category `%s`)", doc.Slug, doc.Title, id, doc.Category))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	sortStrings(lines)
	return "\n## Protected documents (set by the owner, kept as they are)\nThese documents must appear in the catalogue: with the same slug, in the " +
		"category with the same key (whose key must not change either); you do not write their content, and no section moves out of them.\n" +
		strings.Join(lines, "\n") + "\n"
}

func (r *wikiPlanRun) guidanceBlock() string {
	if r.instructions == "" {
		return ""
	}
	return "\n## What the owner asks (do it)\n" + r.instructions + "\n"
}

const wikiPlanCatalogueFormat = "## Output format\nOutput only the Markdown below, with no preamble and no summary:\n" +
	"## <category number>. <category title> `<category key: lowercase letters and hyphens>` — <what this category answers for the reader> " +
	"(end the line of the agents' category with [agents])\n" +
	"- <document id, such as 1.2> <title> `<slug: lowercase letters and hyphens>` | <the question the reader comes with, in one sentence> | " +
	"Includes: <point>; <point>; <point>\n"

// skeletonPrompt is step 1: the catalogue's skeleton.
func (r *wikiPlanRun) skeletonPrompt() string {
	return fmt.Sprintf(`
# Task: draft the plan of the wiki «%s» — step 1: the skeleton of the document catalogue
%s
## Requirements
- Organize by product feature, not by code directory. A category holds several documents; a document answers one set of related questions a reader has.
- Cover the main product features the materials show (see the repository structure, the document heading tree, the contracts, and the project and session clusters). A one-off data or experiment project gets no document of its own.
- Size: %d–%d documents in all (the gate holds the plan to this number and sends back too few or too many), in 5–12 categories. Neighbouring documents do not overlap.
- The development conventions for the agents that write code (how to run the tests, set up dependencies, commit and merge, run commands in a session) get a category of their own, last, with [agents] at the end of its line.
- No document's slug appears twice in the whole catalogue, and no category's key appears twice.
%s%s
%s`, r.job.Space.Title, wikiPlanBackground, r.target.Min, r.target.Max, r.protectedBlock(), r.guidanceBlock(), wikiPlanCatalogueFormat)
}

// catalogueRedoPrompt asks for the catalogue again, with what the gate found in it.
func (r *wikiPlanRun) catalogueRedoPrompt(errorLines string) string {
	return fmt.Sprintf(`
# Task: correct the catalogue of the plan of the wiki «%s»
This catalogue did not pass the gate; its errors are listed one by one below. Correct each of them and keep the rest as it is: keep every document that can be kept, with its slug.
## Errors
%s
## This round's catalogue
%s
## Requirements (as in step 1)
- %d–%d documents in all; the development conventions for the agents that write code get a category of their own, last, with [agents] at the end of its line; no document's slug and no category's key appears twice.
%s%s
%s`, r.job.Space.Title, errorLines, r.catalogueText(), r.target.Min, r.target.Max, r.protectedBlock(), r.guidanceBlock(), wikiPlanCatalogueFormat)
}

// detailPrompt is step 2: one category's documents, each with its reader, scope, length and key materials.
func (r *wikiPlanRun) detailPrompt(cat int, ids []string) string {
	return fmt.Sprintf(`
# Task: draft the plan — step 2: complete each document of the category «%s»
The whole catalogue is above. Handle only these documents of category %d: %s.
%s
## What to write for each document
- Audience: whom it is written for (such as "a developer new to the project", "the people who deploy and operate it", "the people who write agent prompts", "the owner"), each with what they can do once they have read it;
- Includes: what it covers, 3–6 points; Excludes: what it deliberately does not cover, each with the document it is left to (that document's id in the catalogue);
- Length: a range of characters;
- Docs: the design or contract documents it mainly draws on (only paths that appear in material 2);
- Code: where in the code it mainly draws on (directories or files, only paths that appear in material 3);
- Contracts: the contract files it concerns (material 4; write "none" if there are none);
- Topics: the topics its existing entries are mostly in (only slugs from material 6; write "none" if there are none);
- Projects: the titles of the projects it concerns (copied exactly from material 5, at most 5; write "none" if there are none).

## Output format
Output only the Markdown below, one block a document, with no preamble and no summary:
### <document id> <title>
Audience: <who>: <what they can do once they have read it>; <who>: <what they can do once they have read it>
Includes: <point>; <point>; <point>
Excludes: <content> (see <document id>); <content> (see <document id>)
Length: <a–b characters>
Docs: <docs/…>, <docs/…>
Code: <src/…>, <src/…>
Contracts: <contracts/… or none>
Topics: <slug>, <slug>
Projects: 「<project title>」「<project title>」
`, r.cats[cat].Title, cat+1, strings.Join(ids, ", "), wikiPlanBackground)
}

const wikiPlanOutlineRules = `
## Outline
- Order to start from: overview → concepts → flow/state machine → interface → data and configuration → operations → known pitfalls → decisions and reasons → conventions. Add, drop, merge or rename sections to fit what this document covers; not every document needs them all.
- 5–9 sections. For each, give: the section title, its type (one of overview / concepts / flow / interface / data / ops / pitfalls / decisions / conventions / other), its length in characters, and what it covers (what exactly this section says, in 1–2 sentences: the actual content, no filler).
- Write only what is within this document's scope; what the catalogue leaves to another document stays out. To mention another document, write "see <document id>", with the id the catalogue gives it.

## Where each section's material comes from
- A section on a mechanism (concepts / flow / interface / data / ops) draws on the code and the design documents: a document down to its section heading (copied exactly from the section headings in material 3), code down to its file and symbols (copied exactly from the paths and symbols in material 4).
- The known pitfalls, decisions and reasons, and conventions sections draw on first-hand words said in sessions, which the existing entries lead to. Say by what conditions to look for them: the projects concerned (titles copied exactly from material 6), a time window, keywords, anchor paths (code path prefixes), entry kinds (principle / convention / decision / pitfall / recipe / concept), existing topic slugs (only those in material 7), and what kind of original words to look for.
- An overview section may have no sources of its own, but its Covers line says which sections it sums up.
- Cite only files, section headings, symbols, project names and topics that really appear in the materials; when nothing fits, write less rather than invent.

## Each section's format (one item a line; leave out the lines you have no use for, and add no other line)
### <number>. <section title> | <type> | <length in characters>
Covers: <what exactly this section says, in 1–2 sentences>
- Docs: <docs/….md> § <section heading, copied exactly>
- Code: <src/… file path>: <symbol name, copied exactly>, <symbol name>
- Contracts: <contracts/…>
- Sessions: projects 「<project title>」「…」; dates <YYYY-MM-DD> to <YYYY-MM-DD or now>; keywords <word>, <word>; anchors <path prefix>, <…>; kind <pitfall/decision/convention/…>; topics <slug>; look for: <what kind of original words to look for>
Docs and Code may each take several lines, one place a line.
`

// outlinePrompt is step 3: one document's outline, and where each section's material comes from.
func (r *wikiPlanRun) outlinePrompt(unit *wikiPlanUnit) string {
	card := fmt.Sprintf("- %s %s `%s` | %s\nAudience: %s\nIncludes: %s\nExcludes: %s\nLength: %s\n", unit.ID, unit.Title, unit.Slug, unit.Question,
		strings.Join(unit.Header.Audience, "; "), strings.Join(firstNonEmptyList(unit.Header.ScopeIn, unit.CardScope), "; "),
		strings.Join(unit.Header.ScopeOut, "; "), unit.Header.Length)
	return fmt.Sprintf(`
# This document
%s
# Task: step 3 of drafting the plan — write the outline of «%s», and where each section's material comes from
%s
## Output format
Output only this document's outline, starting at the first "### 1.", with no preamble, no summary and no JSON.
`, card, unit.Title, wikiPlanOutlineRules)
}

func firstNonEmptyList(lists ...[]string) []string {
	for _, list := range lists {
		if len(list) > 0 {
			return list
		}
	}
	return nil
}

const wikiPlanDocFormat = `## Output format
Output only this document, with no preamble, no summary and no JSON. First write these six lines, then the outline:
Title: <title>
Question: <the question the reader comes with, in one sentence>
Audience: <who>: <what they can do once they have read it>; <who>: <what they can do once they have read it>
Includes: <point>; <point>; <point>
Excludes: <content> (see <document id>); <content> (see <document id>)
Length: <a–b characters>

### 1. <section title> | <type> | <length in characters>
Covers: …
- Docs: …
- Code: …
- Contracts: …
- Sessions: …
`

// rewritePrompt is a revision's rewrite of one document: the documents of the version revised it is made
// from, and the sections moved into it, as one coherent outline.
func (r *wikiPlanRun) rewritePrompt(unit *wikiPlanUnit, catalogue string) string {
	var sources strings.Builder
	names := r.projectNames()
	for _, id := range unit.Sources {
		slug, ok := r.baseIDs[id]
		if !ok {
			continue
		}
		doc := wikiPlanDocNamed(wikiPlanDocInput(r.baseDocs[slug]), names)
		drop := map[int]bool{}
		for _, move := range r.moves {
			if move.From == id {
				drop[move.Section] = true
			}
		}
		fmt.Fprintf(&sources, "[Now %s «%s»]\n%s\n", id, doc.Title, wikiPlanDocLines(doc, true, drop))
	}
	for _, move := range r.moves {
		if move.Target != unit {
			continue
		}
		slug, ok := r.baseIDs[move.From]
		if !ok {
			continue
		}
		doc := wikiPlanDocNamed(wikiPlanDocInput(r.baseDocs[slug]), names)
		if move.Section >= 1 && move.Section <= len(doc.Sections) {
			fmt.Fprintf(&sources, "[Now %s, section %d (moved into this document)]%s\n", move.From, move.Section, wikiPlanSectionLines(1, doc.Sections[move.Section-1]))
		}
	}
	if sources.Len() == 0 {
		sources.WriteString("(a new document: there is no current content; write it from the catalogue and what the owner asks)\n")
	}
	return r.docMaterials(unit) + fmt.Sprintf(`
# The new catalogue (document ids as given here)
%s
# Task: write the audience, scope and outline of «%s» in the new draft
## This document in the new catalogue
- %s %s `+"`%s`"+` | %s | Includes: %s
## What the owner asks
%s
## What it is made of now (the current outlines, with each section's sources)
%s
## Requirements
- Make the content above into one coherent document outline: drop what repeats, and order it as the reader's questions come; 5–10 sections; keep the existing sources exactly as they are under their sections, and invent no new source.
- On the Excludes line, say which document each item is left to, by its id in the new catalogue.
%s
%s`, catalogue, unit.Title, unit.ID, unit.Title, unit.Slug, unit.Question, strings.Join(unit.CardScope, "; "), r.instructions,
		sources.String(), wikiPlanOutlineRules, wikiPlanDocFormat)
}

// redoDocPrompt asks for one document again, with what the gate found in it.
func (r *wikiPlanRun) redoDocPrompt(unit *wikiPlanUnit, errs []wikiPlanGateError, last wikiPlanAssembled, catalogue string) string {
	current := ""
	for i, u := range last.units {
		if u == unit {
			current = wikiPlanDocLinesWithRefs(wikiPlanDocNamed(last.plan.Docs[i], r.projectNames()), last.slugIDs)
		}
	}
	return fmt.Sprintf(`
# The catalogue (document ids as given here)
%s
# Task: correct the document «%s» (%s) of the plan
This document did not pass the gate; its errors are listed one by one below. Correct each of them: use only files, sections, symbols, projects and topics that the materials have; where no fitting source can be found, delete that reference rather than invent one; keep the rest as it is.
## Errors
%s
## This document as it stands
%s
%s
%s`, catalogue, unit.Title, unit.ID, r.errorLines(errs, last), current, wikiPlanOutlineRules, wikiPlanDocFormat)
}

// projectNames is how a revision's prompts name the projects of the version it revises: by title, the way
// the drafting prompts name every project and the gate reads them back — never by id, which a local model
// copies wrong. A project keeps its id where its title is not one only it has in the owner's list (a title
// two projects share names neither), where the list may be cut short (materialsProjectsMax), or where the
// title would not read back whole from a session line.
func (r *wikiPlanRun) projectNames() map[string]string {
	names := map[string]string{}
	if len(r.online.Projects) >= wikiPlanMaterialsProjectsMax {
		return names
	}
	titled := map[string]int{}
	for _, p := range r.online.Projects {
		titled[p.Title]++
	}
	for _, doc := range r.baseDocs {
		for _, s := range doc.Sections {
			if c := s.Sources.Sessions; c != nil {
				for _, p := range c.Projects {
					if p.Title == nil || titled[*p.Title] != 1 {
						continue
					}
					if back := wikiPlanSessionsOf(wikiPlanSessionsLine(wikiPlanSessions{Projects: []string{*p.Title}})).Projects; len(back) == 1 && back[0] == *p.Title {
						names[p.ID] = *p.Title
					}
				}
			}
		}
	}
	return names
}

// wikiPlanDocNamed is a document as a prompt shows it: its session conditions' projects by the names given
// (projectNames), any other as it is.
func wikiPlanDocNamed(doc wikiPlanDoc, names map[string]string) wikiPlanDoc {
	shown := doc
	shown.Sections = make([]wikiPlanSection, len(doc.Sections))
	for i, s := range doc.Sections {
		if c := s.Sources.Sessions; c != nil {
			named := *c
			named.Projects = make([]string, len(c.Projects))
			for k, p := range c.Projects {
				named.Projects[k] = firstNonEmpty(names[p], p)
			}
			s.Sources.Sessions = &named
		}
		shown.Sections[i] = s
	}
	return shown
}

// wikiPlanDocLinesWithRefs is a document in the line format with its scope-out targets as numbers of the
// catalogue now: what the model is shown of what it wrote.
func wikiPlanDocLinesWithRefs(doc wikiPlanDoc, slugIDs map[string]string) string {
	shown := doc
	shown.ScopeOut = nil
	for _, out := range doc.ScopeOut {
		var ids []string
		for _, slug := range out.Docs {
			if id, ok := slugIDs[slug]; ok {
				ids = append(ids, id)
			} else {
				ids = append(ids, slug)
			}
		}
		text := out.Text
		if len(ids) > 0 {
			text += " (see " + strings.Join(ids, ", ") + ")"
		}
		shown.ScopeOut = append(shown.ScopeOut, wikiPlanScopeOut{Text: text})
	}
	return wikiPlanDocLines(shown, true, nil)
}

// revisionCataloguePrompt is a revision's catalogue (R1): the version revised, the owner's instructions,
// and — in a later round — what the gate found in the last one.
func (r *wikiPlanRun) revisionCataloguePrompt(errs []wikiPlanGateError, errorLines string) string {
	var brief strings.Builder
	for c, cat := range r.base.Categories {
		agents := ""
		if cat.ForAgents {
			agents = " [agents]"
		}
		fmt.Fprintf(&brief, "## %d. %s `%s` — %s%s\n", c+1, cat.Title, cat.Key, cat.Question, agents)
		n := 0
		for _, doc := range r.base.Docs {
			if doc.Category != cat.Key {
				continue
			}
			n++
			id := fmt.Sprintf("%d.%d", c+1, n)
			mark := ""
			if doc.Protected {
				mark = " [protected]"
			}
			fmt.Fprintf(&brief, "- %s %s `%s`%s (%d–%d characters): %s | Includes: %s\n", id, doc.Title, doc.Slug, mark, doc.Length.Min, doc.Length.Max,
				doc.Question, strings.Join(doc.ScopeIn, "; "))
			for i, s := range doc.Sections {
				fmt.Fprintf(&brief, "    §%d %s (%s): %s\n", i+1, s.Title, s.Kind, cutRunes(s.Covers, 120))
			}
		}
		brief.WriteString("\n")
	}
	again := ""
	if len(errs) > 0 {
		again = fmt.Sprintf("\n## The catalogue the last round of the revision made did not pass the gate; its errors are listed one by one below: correct each of them\n"+
			"%s\n## The catalogue the last round of the revision made\n%s\n", errorLines, r.catalogueText())
	}
	return fmt.Sprintf(`
# Task: revise the catalogue of the plan as the owner asks (v%d → a new draft)

## What the owner asks
%s

# The plan now (v%d, %s, %s; each document lists its sections and their types)
%s%s
## Requirements
- Target: %d–%d documents in all (the gate holds the plan to this number and sends back too few or too many). When documents merge, the content of each merged one becomes sections of the new one and nothing is lost; the new document's title and question cover what was merged into it.
- A document marked [protected] is kept as it is: its title, slug and category (key) do not change, and no section moves out of it.
- The development conventions for the agents that write code get a category of their own, with [agents] at the end of its line; only sections of type conventions may move into it, and sections of any other type stay where they are.
- Every document says its Sources: which documents of the plan now it is made of (their current ids); a new document writes "Sources: none".
- The new document ids are numbered in the order of the new categories; a document keeps the slug of its source (when documents merge, the main source's), and a new document gets a new slug; keep the category keys where you can.

## Output format
Output only the Markdown below, with no preamble:
## <category number>. <category title> `+"`<category key>`"+` — <what this category answers for the reader>
- <new id> <title> `+"`<slug>`"+` | <the question the reader comes with> | Sources: <current id>, <current id> | Includes: <point>; <point>; <point>
(one line a document)

Last, write:
### Sections moved into the agents' category
- <current id> §<section number> → <new id>
(one section a line; write "none" if there are none)
`, r.base.Version, r.instructions, r.base.Version, wikiCount(len(r.base.Categories), "category", "categories"), wikiCount(len(r.base.Docs), "document", "documents"),
		brief.String(), again, r.target.Min, r.target.Max)
}

// rulesPrompt is step 4: a draft of the rules the documents are written and maintained by.
func (r *wikiPlanRun) rulesPrompt() string {
	return r.repo.overviewText(8000) + "\n# Document catalogue\n" + r.catalogueText() + `
# Task: step 4 of drafting the plan — a draft of the three rules
The maintenance runs and the writing of the documents follow these three rules. Write them as rules that can be followed, and checked in code.

## Constraints that may not be broken
- A source can only be a first-hand record: turn / event / tool_call / task / task_comment / approval / evidence / owner_decision / merge_receipt / criterion / commit / note, and the code and documents on origin/main; a wiki entry or a document itself can never be a source.
- A session's text is redacted before it is handed to a model.
- Maintenance is triggered by facts (a new session settled, a task reaching a final state, an approval answered, a merge receipt, a criterion revised), never by a timer.
- A document is only a view: it is not pushed to agents, and cannot be cited as a source.
- A section on a mechanism draws on the code and the design documents; pitfalls, decisions and conventions draw on the words said in sessions, with an entry only as the layer between them (via entry).

## What each of the three rules answers
### 1. Citation rules: what counts as a statement of fact; how each kind of source is located; what a footnote shows and where it links; which original words stand up, and which to choose when an old and a new statement conflict; how summary and transition sentences are handled; what becomes of a sentence that fails its check.
### 2. Merge rules: how several entries and several original passages about one thing combine into "the current state"; where a statement that was overturned goes; how each material is recorded as adopted, merged or dropped.
### 3. Maintenance rules: how new knowledge finds the section of the plan it belongs in, with only the sections it affects written again; how the sentences that cite an entry are withdrawn when the entry is rejected or retired; how new knowledge that fits no section becomes a proposed change to the plan.

## Output format
Output only Markdown: three second-level headings, "## Citation rules", "## Merge rules" and "## Maintenance rules", each followed by numbered items. 2000–3500 characters in all.
`
}
