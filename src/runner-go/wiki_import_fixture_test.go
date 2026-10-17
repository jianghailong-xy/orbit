package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The import's deterministic half, held to one fixture that the server's TypeScript port is held to as
// well (src/apiserver/src/wiki-worker/wiki-import-golden.spec.ts): the prompt, a note's language, the
// reading of an answer, the quote, the verify command, the checks that make ops of entries, the retry's
// words and a path anchor's reading. Both paths run side by side until P10 (contract `import.server`),
// and the project's criterion asks that the same input give the same deterministic answer on both.
//
// The fixture's outputs are this code's. To write them again after a deliberate change to it:
//
//	ORBIT_WIKI_IMPORT_FIXTURE=write go test -run TestWikiImportFixtureIsTheServersToo .
//
// and then make the TypeScript port answer the same.

const wikiImportFixturePath = "../shared/src/wiki-import.fixture.json"

type wikiImportFixtureNote struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	Date string `json:"date"`
	Text string `json:"text"`
}

type wikiImportFixture struct {
	Why     string                  `json:"why"`
	Write   string                  `json:"write"`
	Notes   []wikiImportFixtureNote `json:"notes"`
	Prompts []struct {
		Note   int    `json:"note"`
		Prompt string `json:"prompt"`
	} `json:"prompts"`
	Languages []struct {
		Text string `json:"text"`
		Lang string `json:"lang"`
	} `json:"languages"`
	Answers []struct {
		Answer  string      `json:"answer"`
		Entries interface{} `json:"entries"`
	} `json:"answers"`
	Quotes []struct {
		Note  string      `json:"note"`
		Quote string      `json:"quote"`
		Cited interface{} `json:"cited"`
	} `json:"quotes"`
	Commands []struct {
		Note    string `json:"note"`
		Command string `json:"command"`
		Gives   bool   `json:"gives"`
	} `json:"commands"`
	Builds []struct {
		Note   int         `json:"note"`
		Answer string      `json:"answer"`
		Built  interface{} `json:"built"`
		Suffix string      `json:"suffix"`
	} `json:"builds"`
	Paths struct {
		Root  string   `json:"root"`
		Name  string   `json:"name"`
		Files []string `json:"files"`
		Cases []struct {
			Path   string      `json:"path"`
			Anchor interface{} `json:"anchor"`
		} `json:"cases"`
	} `json:"paths"`
}

func (f wikiImportFixtureNote) note() wikiImportNote {
	note := wikiImportNote{id: f.ID, path: f.Path, date: f.Date, text: f.Text}
	note.lang = wikiImportNoteLanguage(note.text)
	return note
}

// wikiImportFixtureBuilt is what this code makes of one answer for one note: the entries it read, the
// ops that held up, the problems and rejected entries a retry would name, and the counts.
func wikiImportFixtureBuilt(note wikiImportNote, answer string) (interface{}, string) {
	entries, parsed := parseWikiImportAnswer(answer)
	im := &wikiImporter{}
	built := im.build(entries, note)
	ops := []interface{}{}
	for _, op := range built.ops {
		ops = append(ops, op.Body)
	}
	problems := append([]string{}, built.problems...)
	out := map[string]interface{}{
		"parsed": parsed, "ops": ops, "problems": problems, "principles": built.principles, "dropped": built.dropped,
	}
	suffix := ""
	if !parsed || len(built.problems) > 0 {
		suffix = wikiImportRetrySuffix(answer, parsed, built)
	}
	return wikiImportFixtureJSON(out), suffix
}

// wikiImportFixtureJSON is a value as it reads back from the fixture: through JSON and back.
func wikiImportFixtureJSON(value interface{}) interface{} {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(err)
	}
	return out
}

func TestWikiImportFixtureIsTheServersToo(t *testing.T) {
	raw, err := os.ReadFile(wikiImportFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture wikiImportFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	write := os.Getenv("ORBIT_WIKI_IMPORT_FIXTURE") == "write"
	check := func(what string, got, want interface{}) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got %#v\nwant %#v", what, got, want)
		}
	}
	for i := range fixture.Prompts {
		c := &fixture.Prompts[i]
		got := wikiImportPrompt(fixture.Notes[c.Note].note())
		if write {
			c.Prompt = got
		}
		check("prompt for note "+fixture.Notes[c.Note].Path, got, c.Prompt)
	}
	for i := range fixture.Languages {
		c := &fixture.Languages[i]
		got := wikiImportNoteLanguage(c.Text)
		if write {
			c.Lang = got
		}
		check("language of "+c.Text, got, c.Lang)
	}
	for i := range fixture.Answers {
		c := &fixture.Answers[i]
		entries, ok := parseWikiImportAnswer(c.Answer)
		var got interface{}
		if ok {
			got = wikiImportFixtureJSON(entries)
			if got == nil {
				got = []interface{}{}
			}
		}
		if write {
			c.Entries = got
		}
		check("entries of "+c.Answer, got, c.Entries)
	}
	for i := range fixture.Quotes {
		c := &fixture.Quotes[i]
		var got interface{}
		if quote, ok := wikiImportQuote(c.Note, c.Quote); ok {
			got = quote
		}
		if write {
			c.Cited = got
		}
		check("quote "+c.Quote, got, c.Cited)
	}
	for i := range fixture.Commands {
		c := &fixture.Commands[i]
		got := wikiImportNoteGives(c.Note, c.Command)
		if write {
			c.Gives = got
		}
		check("verify command "+c.Command, got, c.Gives)
	}
	for i := range fixture.Builds {
		c := &fixture.Builds[i]
		built, suffix := wikiImportFixtureBuilt(fixture.Notes[c.Note].note(), c.Answer)
		if write {
			c.Built, c.Suffix = built, suffix
		}
		check("ops of "+c.Answer, built, c.Built)
		check("retry of "+c.Answer, suffix, c.Suffix)
	}
	repo := &wikiImportRepo{root: fixture.Paths.Root, name: fixture.Paths.Name, files: map[string]bool{}, dirs: map[string]bool{}, shas: map[string]string{}}
	for _, file := range fixture.Paths.Files {
		repo.files[file] = true
		for dir := filepath.Dir(file); dir != "." && dir != "/"; dir = filepath.Dir(dir) {
			repo.dirs[dir] = true
		}
	}
	for i := range fixture.Paths.Cases {
		c := &fixture.Paths.Cases[i]
		var got interface{}
		if path, ok := repo.path(c.Path); ok {
			got = path
		}
		if write {
			c.Anchor = got
		}
		check("path "+c.Path, got, c.Anchor)
	}
	if !write {
		return
	}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(fixture); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wikiImportFixturePath, out.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s (%d bytes)", wikiImportFixturePath, out.Len())
}

// The fixture names the command that writes it, and says why it is there.
func TestWikiImportFixtureSaysHowItIsWritten(t *testing.T) {
	raw, err := os.ReadFile(wikiImportFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture wikiImportFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fixture.Write, "ORBIT_WIKI_IMPORT_FIXTURE=write") || !strings.Contains(fixture.Why, "wiki_import.go") {
		t.Errorf("the fixture's why and write are %q, %q", fixture.Why, fixture.Write)
	}
}
