package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The one plan change a maintenance run proposes, as the run checks it on origin/main before the server's gate
// sees it (parseWikiProposal, assembleWikiProposal, wikiProposalSection), held to one fixture that the server's
// TypeScript port is held to as well (src/apiserver/src/wiki-worker/wiki-maintain-proposal-golden.spec.ts): the
// model's answers, and what this code makes of each on a checkout of the fixture's files — the problems handed back
// to the model, and the session conditions of the sections it would send. A design document's section is found as
// wikiDocRepo.docSection finds it (by its words or its number, then by words that contain the name or that it
// contains), a code source's symbols as codePieces finds them, and a contract as contract shows it. The project's
// criterion asks that the same input give the same deterministic answer on both paths, and the server once checked
// these against its snapshot's index instead: production's run 28ea4f5c (2026-10-09) had its proposal refused three
// rounds for two sections the document has, named as the proposal prompt lists them — the first case here.
//
// The fixture's inputs (files, plan, items, answers) are its own; its outputs are this code's. To write the outputs
// again after a deliberate change to it:
//
//	ORBIT_WIKI_MAINTAIN_PROPOSAL_FIXTURE=write go test -run TestWikiMaintainProposalFixtureIsTheServersToo .
//
// and then make the TypeScript port answer the same.

const wikiMaintainProposalFixturePath = "../shared/src/wiki-maintain-proposal.fixture.json"

type wikiMaintainProposalFixture struct {
	Why   string                            `json:"why"`
	Write string                            `json:"write"`
	Files map[string]string                 `json:"files"`
	Plan  json.RawMessage                   `json:"plan"`
	Items []wikiMaintainProposalFixtureItem `json:"items"`
	Cases []wikiMaintainProposalFixtureCase `json:"cases"`
}

type wikiMaintainProposalFixtureItem struct {
	ID     string `json:"id"`
	Design *struct {
		Path        string   `json:"path"`
		RenamedFrom string   `json:"renamedFrom"`
		Commit      string   `json:"commit"`
		Title       string   `json:"title"`
		Headings    []string `json:"headings"`
		Opening     string   `json:"opening"`
	} `json:"design,omitempty"`
	Entry *wikiUnplacedEntry `json:"entry,omitempty"`
}

type wikiMaintainProposalFixtureCase struct {
	Name     string   `json:"name"`
	Answer   string   `json:"answer"`
	Problems []string `json:"problems"`
	// Each new section's session condition as it would be sent: its kinds and topics, or null with none.
	Sessions []*wikiMaintainProposalFixtureSessions `json:"sessions"`
}

type wikiMaintainProposalFixtureSessions struct {
	EntryKinds []string `json:"entryKinds"`
	Topics     []string `json:"topics"`
}

// wikiMaintainProposalFixtureRun is the fixture's outputs as this code makes them, from its inputs, on a checkout
// of its files.
func wikiMaintainProposalFixtureRun(t *testing.T, f wikiMaintainProposalFixture) wikiMaintainProposalFixture {
	t.Helper()
	checkout := newDocsFixture(t, f.Files)
	repo := newWikiDocRepo(checkout.checkout, checkout.first)
	var plan wikiPlanVersionRead
	if err := json.Unmarshal(f.Plan, &plan); err != nil {
		t.Fatal(err)
	}
	var items []wikiProposalItem
	for _, item := range f.Items {
		one := wikiProposalItem{ID: item.ID, entry: item.Entry}
		if d := item.Design; d != nil {
			one.design = &wikiNewDesignDoc{Path: d.Path, RenamedFrom: d.RenamedFrom, Commit: d.Commit, Title: d.Title, Headings: d.Headings, Opening: d.Opening}
		}
		items = append(items, one)
	}
	out := f
	out.Cases = nil
	for _, c := range f.Cases {
		answer := parseWikiProposal(c.Answer)
		request, problems := assembleWikiProposal(plan, answer, items, repo)
		got := wikiMaintainProposalFixtureCase{Name: c.Name, Answer: c.Answer, Problems: append([]string{}, problems...)}
		sections := request.Change.Doc.Sections
		if len(sections) >= len(answer.Sections) {
			for _, section := range sections[len(sections)-len(answer.Sections):] {
				if s := section.Sources.Sessions; s != nil {
					got.Sessions = append(got.Sessions, &wikiMaintainProposalFixtureSessions{
						EntryKinds: append([]string{}, s.EntryKinds...), Topics: append([]string{}, s.Topics...)})
				} else {
					got.Sessions = append(got.Sessions, nil)
				}
			}
		}
		if got.Sessions == nil {
			got.Sessions = []*wikiMaintainProposalFixtureSessions{}
		}
		out.Cases = append(out.Cases, got)
	}
	return out
}

func TestWikiMaintainProposalFixtureIsTheServersToo(t *testing.T) {
	raw, err := os.ReadFile(wikiMaintainProposalFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture wikiMaintainProposalFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	got := wikiMaintainProposalFixtureRun(t, fixture)
	// What production's run was refused for passes here: both sections are the document's, «##» and all.
	if production := got.Cases[0]; !strings.HasPrefix(production.Name, "production") || len(production.Problems) != 0 {
		t.Fatalf("production's proposal is refused on the runner too: %q", production.Problems)
	}
	if os.Getenv("ORBIT_WIKI_MAINTAIN_PROPOSAL_FIXTURE") == "write" {
		var buf bytes.Buffer
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(got); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(wikiMaintainProposalFixturePath, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	for i := range fixture.Cases {
		if !reflect.DeepEqual(fixture.Cases[i], got.Cases[i]) {
			w, _ := json.MarshalIndent(fixture.Cases[i], "", " ")
			g, _ := json.MarshalIndent(got.Cases[i], "", " ")
			t.Errorf("case %q:\nfixture %s\nthis code %s", fixture.Cases[i].Name, w, g)
		}
	}
	if t.Failed() {
		t.Fatal("this code no longer answers what the fixture holds: the server's port is held to the fixture, so change both " +
			"(ORBIT_WIKI_MAINTAIN_PROPOSAL_FIXTURE=write, then the TypeScript)")
	}
}
