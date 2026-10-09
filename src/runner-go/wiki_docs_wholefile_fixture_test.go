package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The whole-file half of the documents build's fixture (owner 2026-10-08): this repository's own
// docs/wiki-contract.md — 144,000 characters, far past the 22,000-character window a runner without
// `wiki-repo-op-read/v1` answers in — read whole, with a section and a footnote quote taken from PAST that
// window. What this code cuts out of the whole file, how it fingerprints it and where it locates the quote
// is what the server's port must produce from the same whole file:
// src/apiserver/src/wiki-worker/wiki-docs-wholefile.spec.ts holds it to this fixture.
//
// THE DOCUMENT IS FROZEN, NOT THE LIVE ONE (coordinator, 2026-10-08). The copy under test is
// src/shared/src/wiki-docs-wholefile.source.md, taken from docs/wiki-contract.md at 04b5101e and frozen
// there: the project edits the contract first, by rule, and other tasks edit it for their own reasons — a
// consistency test that reads the live document would go red for a change that has nothing to do with
// reading whole files. Both sides read the frozen copy, and the plan's own path (`docs/wiki-contract.md`)
// is what the fixture records, so what is held to account is the two implementations, not the document.
//
// The fixture's outputs are this code's. To write them again after a deliberate change to it:
//
//	ORBIT_WIKI_DOCS_WHOLEFILE_FIXTURE=write go test -run TestWikiDocsWholeFileFixtureIsTheServersToo .
//
// and then make the TypeScript port answer the same.

const wikiDocsWholeFileFixturePath = "../shared/src/wiki-docs-wholefile.fixture.json"

// The frozen copy both sides read, on disk relative to this package.
const wikiDocsWholeFileFrozen = "../shared/src/wiki-docs-wholefile.source.md"

// The path the plan section names and the fixture records: the live document's path, which is what a plan
// cites. The bytes behind it here are the frozen copy's, not the live file's — see the note above.
const wikiDocsWholeFileInRepo = "docs/wiki-contract.md"

type wikiDocsWholeFileFixture struct {
	Why   string `json:"why"`
	Write string `json:"write"`
	// The live document's path (what a plan cites) and the frozen copy's path (what both sides read).
	Source string `json:"source"`
	Frozen string `json:"frozen"`
	// The plan section the material is gathered for, exactly as both sides build it: the fingerprint is the
	// section's definition and its material, so the definition travels with the answer.
	Plan    wikiDocsWholeFilePlan `json:"plan"`
	Section string                `json:"section"`
	// The rune offset of the heading that names the section and of the quote: both past the old window, which
	// is the whole point — a path that reads only the first 22,000 characters finds neither.
	SectionOffset int    `json:"sectionOffset"`
	QuoteOffset   int    `json:"quoteOffset"`
	Quote         string `json:"quote"`
	Missing       []string `json:"missing"`
	Piece         *wikiDocsBuildFixturePiece  `json:"piece"`
	Selected      []wikiDocsBuildFixturePiece `json:"selected"`
	Fingerprint   string                      `json:"fingerprint"`
	Located       *wikiDocRange               `json:"located"`
	LocatedWithin *wikiDocRange               `json:"locatedWithin"`
}

/** The plan section both implementations gather the material for. */
type wikiDocsWholeFilePlan struct {
	Key    string `json:"key"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`
	Covers string `json:"covers"`
	Length int    `json:"length"`
}

// wikiDocsWholeFileRun is the fixture's outputs as this code makes them, from the document's whole text.
func wikiDocsWholeFileRun(t *testing.T, content string) wikiDocsWholeFileFixture {
	t.Helper()
	out := wikiDocsWholeFileFixture{
		Why: "Owner 2026-10-08: a read answers with the whole file at the sha, not its first 22,000 characters. " +
			"This fixture is one section and one footnote quote taken from PAST that window of this repository's own " +
			"docs/wiki-contract.md, held to the answers src/runner-go/wiki_docs_build.go makes of the whole file — the " +
			"section's text and lines, what survives the filter and the cap, the section's fingerprint and where the quote " +
			"is found — so the server's port (wiki-docs-writer.ts) is held to the same bytes on a real document, not only " +
			"on the small files of wiki-docs-build.fixture.json. The bytes are the FROZEN copy " +
			"(src/shared/src/wiki-docs-wholefile.source.md, taken from the live document at 04b5101e): the contract is " +
			"edited first, by rule, and a test that read the live file would go red for another task's edit.",
		Write:         "ORBIT_WIKI_DOCS_WHOLEFILE_FIXTURE=write go test -run TestWikiDocsWholeFileFixtureIsTheServersToo .",
		Source:        wikiDocsWholeFileInRepo,
		Frozen:        "src/shared/src/wiki-docs-wholefile.source.md",
		Plan:          wikiDocsWholeFilePlan{Key: "s1", Title: "仓库操作", Kind: "ops", Covers: "", Length: 400},
		SectionOffset: -1,
	}
	// The first heading whose line starts past the old window: the section a 22,000-character read would
	// never have seen, and one that is there whatever the document says above it.
	offset := 0
	for _, line := range strings.Split(content, "\n") {
		if offset > wikiRepoOpBoundedChars {
			if m := wikiDocHeadingLine.FindStringSubmatch(line); m != nil && strings.TrimSpace(m[2]) != "" {
				out.Section = strings.TrimSpace(m[2])
				out.SectionOffset = offset
				break
			}
		}
		offset += len([]rune(line)) + 1
	}
	if out.Section == "" || out.SectionOffset <= wikiRepoOpBoundedChars {
		t.Fatalf("no heading of %s stands past the first %d characters", wikiDocsWholeFileInRepo, wikiRepoOpBoundedChars)
	}

	// The commit the fixture reads: a checkout of the document's whole text, so the code cuts the section out
	// of the same bytes the server's port is handed.
	checkout := newDocsFixture(t, map[string]string{wikiDocsWholeFileInRepo: content})
	repo := newWikiDocRepo(checkout.checkout, checkout.first)
	section := wikiDocsPlanSection{Key: out.Plan.Key, Title: out.Plan.Title, Kind: out.Plan.Kind, Covers: out.Plan.Covers, Length: out.Plan.Length}
	section.Sources.Docs = []wikiPlanDocSource{{Path: wikiDocsWholeFileInRepo, Section: &out.Section}}
	pieces, missing := wikiDocRepoPieces(repo, section)
	out.Missing = append([]string{}, missing...)
	if len(pieces) != 1 {
		t.Fatalf("the section %q gave %d pieces, want one", out.Section, len(pieces))
	}
	piece := pieces[0]
	raw := wikiDocsFixturePieces(pieces)[0]
	out.Piece = &raw
	wikiDocFilter(pieces)
	wikiDocSelect(section.Kind, pieces)
	out.Selected = wikiDocsFixturePieces(pieces)
	out.Fingerprint = wikiDocFingerprint(section, pieces)

	// A quote from the section's own text: its last lines, joined until the whole document folds them to a
	// place past the old window — the section stands past it, so a run of its closing lines does too, and a run
	// is what a footnote quotes when one line is not enough to be found. `wikiDocLocate` answers a LINE range;
	// the rune offset of its first line is what says where in the document the footnote was found.
	sectionLines := strings.Split(piece.text, "\n")
	for take := 3; take >= 1 && out.Quote == ""; take -= 1 {
		tail := make([]string, 0, take)
		for i := len(sectionLines) - 1; i >= 0 && len(tail) < take; i -= 1 {
			if trimmed := strings.TrimSpace(sectionLines[i]); trimmed != "" {
				tail = append([]string{trimmed}, tail...)
			}
		}
		if len(tail) < take {
			continue
		}
		candidate := strings.Join(tail, "\n")
		located, found := wikiDocLocate(content, candidate, nil)
		if !found {
			continue
		}
		at := wikiDocsWholeFileLineOffset(content, located.Start)
		if at <= wikiRepoOpBoundedChars {
			continue
		}
		out.Quote = candidate
		out.Located = &located
		out.QuoteOffset = at
	}
	if out.Quote == "" || out.Located == nil {
		t.Fatalf("the section %q has no line that is found past the first %d characters", out.Section, wikiRepoOpBoundedChars)
	}
	within, found := wikiDocLocate(content, out.Quote, &piece.lines)
	if !found {
		t.Fatalf("the quote %q was not found within the section's own lines", out.Quote)
	}
	out.LocatedWithin = &within
	return out
}

// wikiDocsWholeFileLineOffset is the rune offset of a 1-based line of the document, as wikiDocLocate numbers
// its lines: what says whether a section — or the line a footnote was found at — stands past the old window.
func wikiDocsWholeFileLineOffset(content string, line int) int {
	if line < 1 {
		return 0
	}
	offset := 0
	for i, text := range strings.Split(content, "\n") {
		if i+1 == line {
			return offset
		}
		offset += len([]rune(text)) + 1
	}
	return offset
}

func TestWikiDocsWholeFileFixtureIsTheServersToo(t *testing.T) {
	raw, err := os.ReadFile(wikiDocsWholeFileFrozen)
	if err != nil {
		t.Fatalf("%s: %v", wikiDocsWholeFileFrozen, err)
	}
	content := string(raw)
	if len([]rune(content)) <= wikiRepoOpBoundedChars {
		t.Fatalf("%s is only %d characters: it no longer reaches past the old window", wikiDocsWholeFileFrozen, len([]rune(content)))
	}
	got := wikiDocsWholeFileRun(t, content)

	if os.Getenv("ORBIT_WIKI_DOCS_WHOLEFILE_FIXTURE") == "write" {
		buf, err := json.MarshalIndent(got, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(wikiDocsWholeFileFixturePath, append(buf, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}

	fixtureRaw, err := os.ReadFile(wikiDocsWholeFileFixturePath)
	if err != nil {
		t.Fatalf("%s: %v (write it with ORBIT_WIKI_DOCS_WHOLEFILE_FIXTURE=write)", wikiDocsWholeFileFixturePath, err)
	}
	var fixture wikiDocsWholeFileFixture
	if err := json.Unmarshal(fixtureRaw, &fixture); err != nil {
		t.Fatalf("%s did not read back: %v", wikiDocsWholeFileFixturePath, err)
	}
	// The source is read from the checkout rather than written into the fixture, so a fixture whose file no
	// longer computes to what it holds is written again, not read.
	if !reflect.DeepEqual(fixture, got) {
		want, _ := json.MarshalIndent(fixture, "", " ")
		have, _ := json.MarshalIndent(got, "", " ")
		t.Fatalf("this code no longer answers what the fixture holds: the server's port is held to it, so change "+
			"both and write it again with ORBIT_WIKI_DOCS_WHOLEFILE_FIXTURE=write\nfixture %s\nthis code %s", want, have)
	}
}
