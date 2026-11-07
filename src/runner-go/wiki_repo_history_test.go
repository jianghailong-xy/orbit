package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The history repository operation (docs/wiki-claim-recheck-design.md §2.3 and §3.1), against a throwaway
// repository with a history like the one the design was written about: a sum that overflowed, the fix that
// dropped it and added a guard, a side line merged into main, a rename, a delete, a binary file, and enough
// commits and lines to reach the answer's limits.

// historyAt dates every commit git makes in this test from here on, as author and as committer.
func historyAt(t *testing.T, date string) {
	t.Helper()
	t.Setenv("GIT_AUTHOR_DATE", date)
	t.Setenv("GIT_COMMITTER_DATE", date)
}

// wikiRepoHistoryFixture is the repository and the commits its history is made of, oldest first.
type wikiRepoHistoryFixture struct {
	*wikiRepoOpFixture
	cache, fix, side, merge, moves string
	log                            []string
	head                           string
}

// The big file is rewritten whole: one hunk of about 30,000 bytes, far past the diff's limit on its own.
func historyBigFile(kind string) string {
	var b strings.Builder
	for i := 1; i <= 300; i++ {
		fmt.Fprintf(&b, "%s line %03d of the big file, long enough to count\n", kind, i)
	}
	return b.String()
}

// The order file changes three times, far apart: near its top a line that holds no term, then two that do.
func historyOrderFile(after bool) string {
	var lines []string
	for i := 1; i <= 40; i++ {
		lines = append(lines, fmt.Sprintf("line %d", i))
	}
	lines[16] = "keep order_term here"
	lines[34] = "order_term at the end"
	if after {
		lines[1] = "line two"
		lines[34] = "order_term at the end, changed"
		lines = append(lines[:16], lines[17:]...)
	}
	return strings.Join(lines, "\n") + "\n"
}

func newWikiRepoHistoryFixture(t *testing.T) *wikiRepoHistoryFixture {
	t.Helper()
	historyAt(t, "2026-09-30T12:00:00Z")
	f := newWikiRepoOpFixture(t)
	h := &wikiRepoHistoryFixture{wikiRepoOpFixture: f}

	historyAt(t, "2026-10-01T10:00:00Z")
	h.cache = f.push(t, "session: keep the cache read sum", func() {
		f.write(t, "src/session/sum.ts", "// session sums\nexport function sums(row: Row) {\n"+
			"  const sum_cache_read = row.cache_read;\n  const sumCacheRead = sum_cache_read * 2;\n"+
			"  total += sum_cache_read;\n  return sumCacheRead;\n}\n")
		f.write(t, "src/session/schema.prisma", "model Session {\n  sum_cache_read Int // IN_FLIGHT rows keep it\n}\n")
		f.write(t, "src/sessions/other.ts", "// a sibling directory, not under src/session\nconst sum_cache_read = 0;\n")
		f.write(t, "src/session/notes/old.md", "# Notes\n\nTo be renamed.\n")
		f.write(t, "src/session/legacy.ts", "export const legacy = true;\n")
		f.write(t, "src/session/order.ts", historyOrderFile(false))
		f.write(t, "src/session/pair.ts", "a\norder_term one\nb\n")
		f.write(t, "src/session/big.ts", historyBigFile("old"))
	})
	historyAt(t, "2026-10-02T04:15:00Z")
	h.fix = f.push(t, "fix: drop the overflowing cache read sum", func() {
		f.write(t, "src/session/sum.ts", "// session sums\nexport function sums(row: Row) {\n"+
			"  if (row.cache_read > MAX) throw new Error(\"integer out of range\");\n  return row.cache_read;\n}\n")
	})

	// A side line merged into main: its commit is dated between the fix and the merge but is not on main's
	// first-parent line, so a `since` between the two looks back to the fix and not to it.
	mustGit(t, f.seed, "checkout", "-q", "-b", "side")
	historyAt(t, "2026-10-02T12:00:00Z")
	f.write(t, "docs/side.md", "# Side\n")
	mustGit(t, f.seed, "add", "-A")
	mustGit(t, f.seed, "commit", "-q", "-m", "side work")
	h.side = mustGit(t, f.seed, "rev-parse", "HEAD")
	mustGit(t, f.seed, "checkout", "-q", "main")
	historyAt(t, "2026-10-03T08:00:00Z")
	mustGit(t, f.seed, "merge", "-q", "--no-ff", "-m", "Merge side", "side")
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	h.merge = mustGit(t, f.seed, "rev-parse", "HEAD")

	historyAt(t, "2026-10-04T09:00:00Z")
	h.moves = f.push(t, "session: rename the notes, drop legacy, rework order", func() {
		mustGit(t, f.seed, "mv", "src/session/notes/old.md", "src/session/notes/new.md")
		mustGit(t, f.seed, "rm", "-q", "src/session/legacy.ts")
		f.write(t, "src/session/blob.bin", "\x00\x01binary sum_cache_read\x00")
		f.write(t, "src/session/order.ts", historyOrderFile(true))
		f.write(t, "src/session/pair.ts", "a\norder_term two\nb\n")
		f.write(t, "src/session/big.ts", historyBigFile("new"))
	})

	// 23 commits to one file: the three oldest add a line that holds a term, the twenty after them lines that do not.
	log := ""
	for i := 1; i <= 23; i++ {
		historyAt(t, fmt.Sprintf("2026-10-05T%02d:00:00Z", i-1))
		if i <= 3 {
			log += fmt.Sprintf("cache_marker %d\n", i)
		} else {
			log += fmt.Sprintf("plain %d\n", i)
		}
		h.log = append(h.log, f.push(t, fmt.Sprintf("log %d", i), func() { f.write(t, "src/session/log.ts", log) }))
	}

	// 45 lines that hold a term, the first of them longer than a line's text is let be.
	many := "many_term " + strings.Repeat("文", 300) + "\n"
	for i := 2; i <= 45; i++ {
		many += fmt.Sprintf("many_term %d\n", i)
	}
	historyAt(t, "2026-10-06T00:00:00Z")
	h.head = f.push(t, strings.TrimSpace(strings.Repeat("a long subject ", 20)), func() { f.write(t, "src/session/many.ts", many) })
	return h
}

// wikiRepoHistoryRead is the history's answer as the control plane reads it, every key either shape of an
// entry has; a pointer is nil when its key is absent.
type wikiRepoHistoryRead struct {
	Sha     string                     `json:"sha"`
	Date    string                     `json:"date"`
	Entries []wikiRepoHistoryEntryRead `json:"entries"`
}

type wikiRepoHistoryEntryRead struct {
	ID            string                    `json:"id"`
	Error         string                    `json:"error"`
	Base          string                    `json:"base"`
	BaseDate      string                    `json:"baseDate"`
	Census        []wikiRepoOpHistoryCensus `json:"census"`
	Moved         []string                  `json:"moved"`
	Changed       *bool                     `json:"changed"`
	Commits       []wikiRepoOpHistoryCommit `json:"commits"`
	CommitsTotal  *int                      `json:"commitsTotal"`
	Lines         []wikiRepoOpHistoryLine   `json:"lines"`
	LinesTotal    *int                      `json:"linesTotal"`
	Diff          *string                   `json:"diff"`
	DiffTruncated *bool                     `json:"diffTruncated"`
	Changes       []wikiRepoOpHistoryChange `json:"changes"`
	ChangesTotal  *int                      `json:"changesTotal"`
}

func (h *wikiRepoHistoryFixture) history(t *testing.T, entries ...map[string]interface{}) (wikiRepoHistoryRead, wikiRepoOpOutcome) {
	t.Helper()
	outcome := runWikiRepoOp(h.command(t, "history", map[string]interface{}{"to": h.head, "entries": entries}), nil)
	return decodeResult[wikiRepoHistoryRead](t, outcome, "history"), outcome
}

// historyKeys is the keys of each entry of a history's answer, in the order the answer writes them.
func historyKeys(t *testing.T, outcome wikiRepoOpOutcome) [][]string {
	t.Helper()
	raw, err := json.Marshal(outcome.result["history"])
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		Entries []json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		t.Fatal(err)
	}
	var keys [][]string
	for _, entry := range answer.Entries {
		decoder := json.NewDecoder(strings.NewReader(string(entry)))
		if _, err := decoder.Token(); err != nil {
			t.Fatal(err)
		}
		var names []string
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				t.Fatal(err)
			}
			names = append(names, fmt.Sprint(key))
			var value json.RawMessage
			if err := decoder.Decode(&value); err != nil {
				t.Fatal(err)
			}
		}
		keys = append(keys, names)
	}
	return keys
}

func TestWikiRepoOpHistoryScreensTermsMovesAndChanges(t *testing.T) {
	h := newWikiRepoHistoryFixture(t)
	answer, outcome := h.history(t,
		// The incident's time: the base is the last commit on main before it, the one that kept the sum.
		map[string]interface{}{"id": "fix", "since": "2026-10-01T23:00:00Z",
			"paths": []string{"src/session/sum.ts", "./src/session/schema.prisma/", "src/session/sum.ts"},
			"terms": []string{"sum_cache_read", " sumCacheRead ", "IN_FLIGHT", "integer out of range", ""}},
		map[string]interface{}{"id": "moves", "from": h.fix,
			"paths": []string{"src/session/notes/old.md", "src/session/legacy.ts", "src/session", "src/session/notes/new.md", "src/session/sum.ts",
				"/src/session//legacy.ts"},
			"terms": []string{"sum_cache_read"}},
		// After the fix and after the side commit, before the merge: main's first-parent line has the fix there.
		map[string]interface{}{"id": "first-parent", "since": "2026-10-02T13:00:00Z", "paths": []string{"src/session/sum.ts"}},
		// Older than the whole history: its first commit.
		map[string]interface{}{"id": "before-history", "since": "2020-01-01T00:00:00Z", "paths": []string{"src/session/sum.ts"}},
		// A directory is the files under it, and not a sibling whose name starts with its own.
		map[string]interface{}{"id": "dir", "from": h.cache, "paths": []string{"src/session/"}, "terms": []string{"sum_cache_read"}},
	)
	if answer.Sha != h.head || answer.Date != "2026-10-06T00:00:00Z" {
		t.Fatalf("the history looked at %s (%s), want %s (2026-10-06T00:00:00Z)", answer.Sha, answer.Date, h.head)
	}
	if len(answer.Entries) != 5 {
		t.Fatalf("the history answered %d entries, want 5: %+v", len(answer.Entries), answer.Entries)
	}
	byID := map[string]wikiRepoHistoryEntryRead{}
	for _, entry := range answer.Entries {
		if entry.Error != "" {
			t.Fatalf("entry %s was refused: %s", entry.ID, entry.Error)
		}
		byID[entry.ID] = entry
	}

	fix := byID["fix"]
	if fix.Base != h.cache || fix.BaseDate != "2026-10-01T10:00:00Z" {
		t.Fatalf("the base before the incident is %s (%s), want the commit that kept the sum %s", fix.Base, fix.BaseDate, h.cache)
	}
	// The terms trimmed and the empty one left out, in their order; the sum gone from the file it overflowed in, its
	// camel-case twin gone everywhere — a vanished term — and the guard's message come in.
	census := []wikiRepoOpHistoryCensus{
		{Term: "sum_cache_read", Base: 4, Head: 1},
		{Term: "sumCacheRead", Base: 2, Head: 0},
		{Term: "IN_FLIGHT", Base: 1, Head: 1},
		{Term: "integer out of range", Base: 0, Head: 1},
	}
	if !reflect.DeepEqual(fix.Census, census) {
		t.Fatalf("the census is %+v, want %+v", fix.Census, census)
	}
	if len(fix.Moved) != 0 || fix.Changed == nil || !*fix.Changed {
		t.Fatalf("the fixed file moved %v and changed %v, want nothing moved and a change", fix.Moved, fix.Changed)
	}

	// A rename moves both its sides and a delete its path; the directory above them is not itself moved, and a
	// file that only changed is not either.
	moves := byID["moves"]
	if want := []string{"src/session/legacy.ts", "src/session/notes/new.md", "src/session/notes/old.md"}; !reflect.DeepEqual(moves.Moved, want) {
		t.Fatalf("moved = %v, want %v", moves.Moved, want)
	}
	// The binary file that holds the term is not counted: it is not a line of text.
	if want := []wikiRepoOpHistoryCensus{{Term: "sum_cache_read", Base: 1, Head: 1}}; !reflect.DeepEqual(moves.Census, want) {
		t.Fatalf("the census under the directory is %+v, want %+v", moves.Census, want)
	}

	if parent := byID["first-parent"]; parent.Base != h.fix || parent.BaseDate != "2026-10-02T04:15:00Z" {
		t.Fatalf("since 2026-10-02T13:00Z looked back to %s, want main's %s and not the side commit %s", parent.Base, h.fix, h.side)
	}
	// Nothing changed the file since the fix: an empty census for no terms, nothing moved, no change.
	if parent := byID["first-parent"]; parent.Census == nil || len(parent.Census) != 0 || parent.Changed == nil || *parent.Changed {
		t.Fatalf("an unchanged file since the fix answered census %v, changed %v", parent.Census, parent.Changed)
	}
	if before := byID["before-history"]; before.Base != h.first || before.Changed == nil || !*before.Changed {
		t.Fatalf("a since older than the history looked back to %s, want its first commit %s", before.Base, h.first)
	}
	if dir := byID["dir"]; !reflect.DeepEqual(dir.Census, []wikiRepoOpHistoryCensus{{Term: "sum_cache_read", Base: 4, Head: 1}}) || len(dir.Moved) != 0 {
		t.Fatalf("the directory counted %+v and moved %v, want 4 -> 1 and nothing moved", dir.Census, dir.Moved)
	}

	// A screened entry carries the screen and nothing of the detail, `changed` right after `moved`.
	for i, keys := range historyKeys(t, outcome) {
		if want := []string{"id", "base", "baseDate", "census", "moved", "changed"}; !reflect.DeepEqual(keys, want) {
			t.Fatalf("entry %d has keys %v, want %v", i, keys, want)
		}
	}
}

func TestWikiRepoOpHistoryDetailIsWhatTheModelReads(t *testing.T) {
	h := newWikiRepoHistoryFixture(t)
	entries := []map[string]interface{}{
		{"id": "log", "from": h.moves, "paths": []string{"src/session/log.ts"}, "terms": []string{"cache_marker"}, "detail": true},
		{"id": "many", "from": h.log[22], "paths": []string{"src/session/many.ts"}, "terms": []string{"many_term"}, "detail": true},
		{"id": "order", "from": h.fix, "paths": []string{"src/session/order.ts", "src/session/pair.ts"}, "terms": []string{"order_term"}, "detail": true},
		{"id": "big", "from": h.fix, "paths": []string{"src/session/big.ts"}, "terms": []string{"order_term"}, "detail": true},
		{"id": "stop", "from": h.fix, "paths": []string{"src/session/big.ts", "src/session/order.ts"}, "terms": []string{"order_term"}, "detail": true},
		{"id": "binary", "from": h.fix, "paths": []string{"src/session/blob.bin"}, "terms": []string{"sum_cache_read"}, "detail": true},
		{"id": "no-terms", "from": h.fix, "paths": []string{"src/session/pair.ts"}, "detail": true},
	}
	answer, outcome := h.history(t, entries...)
	byID := map[string]wikiRepoHistoryEntryRead{}
	for _, entry := range answer.Entries {
		if entry.Error != "" {
			t.Fatalf("entry %s was refused: %s", entry.ID, entry.Error)
		}
		byID[entry.ID] = entry
	}

	// Commits: the three that changed how often the term occurs are the oldest of 23, and are kept; the oldest
	// seventeen of the rest — the nearest the base — fill the twenty; all in git log's order, newest first.
	log := byID["log"]
	if log.CommitsTotal == nil || *log.CommitsTotal != 23 {
		t.Fatalf("commitsTotal = %v, want 23", log.CommitsTotal)
	}
	var want []string
	for i := 19; i >= 3; i-- {
		want = append(want, h.log[i])
	}
	want = append(want, h.log[2], h.log[1], h.log[0])
	var got []string
	for i, commit := range log.Commits {
		got = append(got, commit.Sha)
		if matched := i >= 17; commit.Matched != matched {
			t.Fatalf("commit %d (%s) matched = %v, want %v", i, commit.Subject, commit.Matched, matched)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the commits kept are %v, want %v", got, want)
	}
	if first := log.Commits[0]; first.Subject != "log 20" || first.Date != "2026-10-05T19:00:00Z" {
		t.Fatalf("the newest commit kept reads %+v", first)
	}
	// The file itself was added since the base, so it is moved; its three lines that hold the term now.
	if !reflect.DeepEqual(log.Moved, []string{"src/session/log.ts"}) || log.LinesTotal == nil || *log.LinesTotal != 3 || len(log.Lines) != 3 {
		t.Fatalf("moved %v, lines %+v (total %v)", log.Moved, log.Lines, log.LinesTotal)
	}
	if line := log.Lines[2]; line.Path != "src/session/log.ts" || line.Line != 3 || line.Text != "cache_marker 3" {
		t.Fatalf("the third line reads %+v", line)
	}
	// Changes: the three commits that added a line holding the term, newest first, each its own one-line patch.
	if log.ChangesTotal == nil || *log.ChangesTotal != 3 || len(log.Changes) != 3 {
		t.Fatalf("changes %+v (total %v), want the three that added the term", log.Changes, log.ChangesTotal)
	}
	for i, change := range log.Changes {
		if change.Sha != h.log[2-i] || !reflect.DeepEqual(change.Terms, []string{"cache_marker"}) || change.Body != "" ||
			!strings.Contains(change.Diff, fmt.Sprintf("+cache_marker %d\n", 3-i)) || change.DiffTruncated {
			t.Fatalf("change %d reads %+v", i, change)
		}
	}
	// No terms, no changes.
	if plain := byID["no-terms"]; plain.Changes == nil || len(plain.Changes) != 0 || *plain.ChangesTotal != 0 {
		t.Fatalf("an entry with no terms has changes %+v", plain.Changes)
	}

	// Lines: the first forty of 45, each text cut at 200 characters; the subject likewise; a path the base does
	// not have counts nothing there.
	many := byID["many"]
	if many.LinesTotal == nil || *many.LinesTotal != 45 || len(many.Lines) != 40 || many.Lines[39].Line != 40 {
		t.Fatalf("lines: %d kept of %v, the last at %d", len(many.Lines), many.LinesTotal, many.Lines[len(many.Lines)-1].Line)
	}
	if text := many.Lines[0].Text; text != "many_term "+strings.Repeat("文", 190) {
		t.Fatalf("a long line's text is %d characters: %q", len([]rune(text)), text)
	}
	if len(many.Commits) != 1 || !many.Commits[0].Matched || many.Commits[0].Subject != strings.Repeat("a long subject ", 20)[:200] {
		t.Fatalf("the commit that added the file reads %+v", many.Commits)
	}
	if !reflect.DeepEqual(many.Census, []wikiRepoOpHistoryCensus{{Term: "many_term", Base: 0, Head: 45}}) {
		t.Fatalf("the census of a file the base does not have is %+v", many.Census)
	}

	// The diff: the hunks that mention a term first, each after its file's heading whenever the hunk before it is
	// another file's — once before the order file's two relevant hunks, again before its last — then the rest.
	order := *byID["order"].Diff
	orderHeading := "--- a/src/session/order.ts\n+++ b/src/session/order.ts\n"
	pairHeading := "--- a/src/session/pair.ts\n+++ b/src/session/pair.ts\n"
	if !strings.HasPrefix(order, orderHeading+"@@") {
		t.Fatalf("the diff does not start with the order file's relevant hunk:\n%s", order)
	}
	positions := []int{
		strings.Index(order, "-keep order_term here"),
		strings.Index(order, "+order_term at the end, changed"),
		strings.Index(order, pairHeading),
		strings.Index(order, "+order_term two"),
		strings.LastIndex(order, orderHeading),
		strings.Index(order, "+line two"),
	}
	for i := 1; i < len(positions); i++ {
		if positions[i-1] < 0 || positions[i] <= positions[i-1] {
			t.Fatalf("the diff is not relevant hunks first, each after its file's heading (%v):\n%s", positions, order)
		}
	}
	if strings.Count(order, orderHeading) != 2 || *byID["order"].DiffTruncated {
		t.Fatalf("the order file's heading shows %d times, truncated %v:\n%s", strings.Count(order, orderHeading), *byID["order"].DiffTruncated, order)
	}

	// A hunk past the limit on its own is cut at a line's end within it.
	big := *byID["big"].Diff
	if !strings.HasPrefix(big, "--- a/src/session/big.ts\n+++ b/src/session/big.ts\n@@") || len(big) > wikiRepoOpHistoryDiffBytes ||
		len(big) < wikiRepoOpHistoryDiffBytes-60 || !strings.HasSuffix(big, "\n") || !*byID["big"].DiffTruncated {
		t.Fatalf("the big hunk was cut to %d bytes (truncated %v):\n%s", len(big), *byID["big"].DiffTruncated, big)
	}
	// The relevant hunk is shown, and the diff stops at the next one that would pass the limit — the order file's
	// small hunk after it is not shown.
	stop := *byID["stop"].Diff
	if !strings.HasPrefix(stop, orderHeading) || !strings.Contains(stop, "-keep order_term here") || strings.Contains(stop, "big.ts") ||
		strings.Contains(stop, "+line two") || !*byID["stop"].DiffTruncated {
		t.Fatalf("the diff did not stop at the hunk past the limit:\n%s", stop)
	}

	// A binary file shows git's line for it, holds no lines, and counts nothing.
	binary := byID["binary"]
	if *binary.Diff != "Binary files /dev/null and b/src/session/blob.bin differ\n" || *binary.DiffTruncated ||
		len(binary.Lines) != 0 || *binary.LinesTotal != 0 || !reflect.DeepEqual(binary.Census, []wikiRepoOpHistoryCensus{{Term: "sum_cache_read"}}) {
		t.Fatalf("the binary file answered %+v (diff %q)", binary, *binary.Diff)
	}
	// No terms: no lines and nothing matched, the commits and the diff all the same.
	plain := byID["no-terms"]
	if plain.Lines == nil || len(plain.Lines) != 0 || *plain.LinesTotal != 0 || len(plain.Commits) != 1 || plain.Commits[0].Matched ||
		plain.Commits[0].Sha != h.moves || !strings.Contains(*plain.Diff, "+order_term two") {
		t.Fatalf("an entry with no terms answered %+v", plain)
	}

	// Every detail key is there, zero or not, after the screen's.
	for i, keys := range historyKeys(t, outcome) {
		want := []string{"id", "base", "baseDate", "census", "moved", "changed", "commits", "commitsTotal", "lines", "linesTotal", "diff", "diffTruncated",
			"changes", "changesTotal"}
		if !reflect.DeepEqual(keys, want) {
			t.Fatalf("entry %d has keys %v, want %v", i, keys, want)
		}
	}

	// The same question is the same answer, byte for byte.
	first, err := json.Marshal(outcome.result)
	if err != nil {
		t.Fatal(err)
	}
	_, again := h.history(t, entries...)
	second, err := json.Marshal(again.result)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("the same history answered twice differently:\n%s\n%s", first, second)
	}
}

func TestWikiRepoOpHistoryRefusesAnEntryNotTheOperation(t *testing.T) {
	h := newWikiRepoHistoryFixture(t)
	paths := []string{"src/session/sum.ts"}
	answer, outcome := h.history(t,
		map[string]interface{}{"id": "", "from": h.cache, "paths": paths},
		map[string]interface{}{"id": "unknown-from", "from": strings.Repeat("c", 40), "paths": paths},
		map[string]interface{}{"id": "short-from", "from": "abc123", "paths": paths},
		map[string]interface{}{"id": "neither", "paths": paths},
		map[string]interface{}{"id": "bad-since", "since": "yesterday", "paths": paths},
		map[string]interface{}{"id": "no-path", "from": h.cache, "paths": []string{"", "./", "/", "src/../sum.ts", ".", "src/./a"}},
		map[string]interface{}{"id": "fine", "from": h.cache, "paths": paths, "terms": []string{"sum_cache_read"}},
	)
	want := map[int]string{
		0: "the entry names no id",
		1: "the checkout has no commit " + strings.Repeat("c", 40) + " to look back from",
		2: "the entry's from is not a commit's full sha",
		3: "the entry names neither a commit to look back from nor a time to look back to",
		4: "the entry's since is not an RFC 3339 time",
		5: `the entry names no path to look at: an empty path, or one with a "." or ".." part, names none`,
	}
	if len(answer.Entries) != 7 {
		t.Fatalf("the history answered %d entries, want 7", len(answer.Entries))
	}
	for i, reason := range want {
		if entry := answer.Entries[i]; entry.Error != reason {
			t.Fatalf("entry %d (%q) answered %q, want %q", i, entry.ID, entry.Error, reason)
		}
	}
	// The other entries are answered: one entry's problem is its own.
	if fine := answer.Entries[6]; fine.Error != "" || fine.Base != h.cache || len(fine.Census) != 1 || fine.Census[0] != (wikiRepoOpHistoryCensus{Term: "sum_cache_read", Base: 3, Head: 0}) {
		t.Fatalf("the entry after the refused ones answered %+v", fine)
	}
	keys := historyKeys(t, outcome)
	if !reflect.DeepEqual(keys[1], []string{"id", "error"}) || answer.Entries[1].ID != "unknown-from" {
		t.Fatalf("a refused entry carries %v, want its id and its error", keys[1])
	}
}

func TestWikiRepoOpHistoryRefusesMoreEntriesThanItsLimits(t *testing.T) {
	h := newWikiRepoHistoryFixture(t)
	entries := func(n, detailed int) []map[string]interface{} {
		// No id: each is refused without a git command, so the limits are what is measured.
		out := make([]map[string]interface{}, n)
		for i := range out {
			out[i] = map[string]interface{}{"id": "", "from": h.fix, "paths": []string{"src/session/sum.ts"}, "detail": i < detailed}
		}
		return out
	}
	for _, c := range []struct {
		n, detailed int
		want        string
	}{
		{501, 0, "a history asks about 501 entries, more than the 500 one operation answers"},
		{41, 41, "a history asks about 41 entries in detail, more than the 40 one operation answers in detail"},
	} {
		outcome := runWikiRepoOp(h.command(t, "history", map[string]interface{}{"to": h.head, "entries": entries(c.n, c.detailed)}), nil)
		if outcome.state != "failed" || outcome.err != c.want {
			t.Fatalf("%d entries (%d in detail) = %s %q, want failed %q", c.n, c.detailed, outcome.state, outcome.err, c.want)
		}
	}
	// At the limits, it answers.
	answer, _ := h.history(t, entries(500, 40)...)
	if len(answer.Entries) != 500 {
		t.Fatalf("500 entries, 40 in detail, answered %d", len(answer.Entries))
	}

	// The commit looked at is what every entry stands on: without it there is no answer.
	for _, c := range []struct{ to, want string }{
		{"main", "a history names the commit to look at"},
		{strings.Repeat("d", 40), "the checkout has no commit " + strings.Repeat("d", 40) + " to look at"},
	} {
		outcome := runWikiRepoOp(h.command(t, "history", map[string]interface{}{"to": c.to, "entries": entries(1, 0)}), nil)
		if outcome.state != "failed" || outcome.err != c.want {
			t.Fatalf("to %s = %s %q, want failed %q", c.to, outcome.state, outcome.err, c.want)
		}
	}
}

// A history of commits the checkout already has runs no fetch, like a read or a diff: origin/main stays where
// it was. One `from` the checkout lacks is fetched first.
func TestWikiRepoOpHistoryOfCommitsTheCheckoutHasRunsNoFetch(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	second := f.push(t, "second", func() { f.write(t, "docs/other.md", "# The other half\n\nSecond.\n") })
	mustGit(t, f.checkout, "fetch", "-q", "origin")
	third := f.push(t, "third", func() { f.write(t, "docs/other.md", "# The other half\n\nThird.\n") })
	originMain := func() string { return mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main") }

	ask := func(to string, froms ...string) wikiRepoHistoryRead {
		var entries []map[string]interface{}
		for i, from := range froms {
			entries = append(entries, map[string]interface{}{"id": fmt.Sprint(i), "from": from, "paths": []string{"docs/other.md"}, "terms": []string{"Second."}})
		}
		return decodeResult[wikiRepoHistoryRead](t, runWikiRepoOp(f.command(t, "history", map[string]interface{}{"to": to, "entries": entries}), nil), "history")
	}
	local := ask(second, f.first, f.first, strings.ToUpper(f.first))
	if got := originMain(); got != second {
		t.Fatalf("origin/main is %s after a history of commits the checkout has, want %s where it was: it fetched", got, second)
	}
	if entry := local.Entries[0]; entry.Error != "" || entry.Base != f.first || entry.Census[0].Head != 1 || entry.Changed == nil || !*entry.Changed {
		t.Fatalf("the local history answered %+v", entry)
	}

	// A commit of another history in the checkout is another repository's: refused although nothing was fetched.
	mustGit(t, f.checkout, "checkout", "-q", "--orphan", "stranger")
	if err := os.WriteFile(filepath.Join(f.checkout, "stranger.md"), []byte("# not the space's\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.checkout, "add", "stranger.md")
	mustGit(t, f.checkout, "commit", "-q", "-m", "a history of its own")
	stranger := mustGit(t, f.checkout, "rev-parse", "HEAD")
	mustGit(t, f.checkout, "checkout", "-q", "main")
	refused := runWikiRepoOp(f.command(t, "history", map[string]interface{}{"to": second,
		"entries": []map[string]interface{}{{"id": "x", "from": stranger, "paths": []string{"stranger.md"}}}}), nil)
	if refused.state != "failed" || !strings.Contains(refused.err, "does not start from the space's first commit") {
		t.Fatalf("a history from a commit of another history was answered: %+v", refused)
	}
	if got := originMain(); got != second {
		t.Fatalf("origin/main is %s after the refusal, want %s: it fetched", got, second)
	}

	// A `from` the checkout does not have is fetched first, and then read.
	fetched := ask(second, f.first, third)
	if got := originMain(); got != third {
		t.Fatalf("origin/main is %s after a history from a commit the checkout lacked, want %s: it did not fetch", got, third)
	}
	if entry := fetched.Entries[1]; entry.Error != "" || entry.Base != third {
		t.Fatalf("the entry from the fetched commit answered %+v", entry)
	}
}

// historyQueueFile is the queue's code: forty rows, the lock on row 20 until the fix puts the claim there, and on
// row 30 the probe while a probe is in.
func historyQueueFile(fixed, probe bool) string {
	var lines []string
	for i := 1; i <= 40; i++ {
		lines = append(lines, fmt.Sprintf("row %02d", i))
	}
	lines[19] = "const lock = queue_lock(run);"
	if fixed {
		lines[19] = "const claim = claimNext(run); // SKIP LOCKED"
	}
	if probe {
		lines[29] = "probe_term(run);"
	}
	return strings.Join(lines, "\n") + "\n"
}

func TestWikiRepoOpHistoryReadsPatternsAndTheChangesThatMovedATerm(t *testing.T) {
	historyAt(t, "2026-09-30T12:00:00Z")
	f := newWikiRepoOpFixture(t)
	historyAt(t, "2026-10-01T10:00:00Z")
	base := f.push(t, "queue: claim under a lock", func() {
		f.write(t, "src/queue/run.ts", historyQueueFile(false, false))
		f.write(t, "src/queue/deep/run.spec.ts", "test('queue_lock', () => {});\n")
	})
	historyAt(t, "2026-10-02T10:00:00Z")
	fix := f.push(t, "fix(queue): drop the queue lock\n\nThe lock deadlocked under load; the queue now claims with SKIP LOCKED.", func() {
		f.write(t, "src/queue/run.ts", historyQueueFile(true, false))
	})
	// A note far past a change's limit, with the claim's words once on its first line.
	historyAt(t, "2026-10-03T10:00:00Z")
	notes := f.push(t, "docs(queue): notes", func() { f.write(t, "src/queue/notes.md", "SKIP LOCKED\n"+historyBigFile("note")) })
	// Ten probes in and out: each changes how often the probe occurs, which is the same at the base and the head.
	var probes []string
	for i := 1; i <= 10; i++ {
		historyAt(t, fmt.Sprintf("2026-10-%02dT10:00:00Z", 3+i))
		message := fmt.Sprintf("probe %d", i)
		if i == 1 {
			message += "\n\n" + strings.Repeat("x", 700)
		}
		probes = append(probes, f.push(t, message, func() { f.write(t, "src/queue/run.ts", historyQueueFile(true, i%2 == 1)) }))
	}
	head := probes[9]
	outcome := runWikiRepoOp(f.command(t, "history", map[string]interface{}{"to": head, "entries": []map[string]interface{}{
		{"id": "changes", "from": base, "paths": []string{"src/queue/**"}, "terms": []string{"queue_lock", "probe_term", "SKIP LOCKED"}, "detail": true},
		// `*` stays within one directory and `**/` crosses any number of them; a pattern is never moved itself.
		{"id": "one-level", "from": base, "paths": []string{"src/*/run.ts"}, "terms": []string{"queue_lock"}},
		{"id": "any-depth", "from": base, "paths": []string{"src/**/run.spec.ts"}, "terms": []string{"queue_lock"}},
		{"id": "added", "from": base, "paths": []string{"src/queue/*.md"}, "terms": []string{"SKIP LOCKED"}},
		{"id": "nothing", "from": base, "paths": []string{"src/none/**"}, "terms": []string{"queue_lock"}},
	}}), nil)
	answer := decodeResult[wikiRepoHistoryRead](t, outcome, "history")
	byID := map[string]wikiRepoHistoryEntryRead{}
	for _, entry := range answer.Entries {
		if entry.Error != "" {
			t.Fatalf("entry %s was refused: %s", entry.ID, entry.Error)
		}
		byID[entry.ID] = entry
	}

	screens := map[string][]wikiRepoOpHistoryCensus{
		"one-level": {{Term: "queue_lock", Base: 1, Head: 0}},
		"any-depth": {{Term: "queue_lock", Base: 1, Head: 1}},
		"added":     {{Term: "SKIP LOCKED", Base: 0, Head: 1}},
		"nothing":   {{Term: "queue_lock", Base: 0, Head: 0}},
	}
	changed := map[string]bool{"one-level": true, "any-depth": false, "added": true, "nothing": false}
	for id, census := range screens {
		entry := byID[id]
		if !reflect.DeepEqual(entry.Census, census) || len(entry.Moved) != 0 || entry.Changed == nil || *entry.Changed != changed[id] {
			t.Fatalf("%s: census %+v, moved %v, changed %v; want %+v, nothing moved, changed %v", id, entry.Census, entry.Moved,
				entry.Changed, census, changed[id])
		}
	}

	entry := byID["changes"]
	if want := []wikiRepoOpHistoryCensus{{Term: "queue_lock", Base: 2, Head: 1}, {Term: "probe_term", Base: 0, Head: 0},
		{Term: "SKIP LOCKED", Base: 0, Head: 2}}; !reflect.DeepEqual(entry.Census, want) {
		t.Fatalf("the census under the pattern is %+v, want %+v", entry.Census, want)
	}
	if entry.CommitsTotal == nil || *entry.CommitsTotal != 12 || entry.ChangesTotal == nil || *entry.ChangesTotal != 12 {
		t.Fatalf("commitsTotal %v, changesTotal %v; want 12 and 12", entry.CommitsTotal, entry.ChangesTotal)
	}
	// The fix and the note changed terms whose count moved from the base to the head: both are taken first; the six
	// oldest probes — the nearest the base — fill the eight. In git log's order, newest first.
	want := []string{probes[5], probes[4], probes[3], probes[2], probes[1], probes[0], notes, fix}
	var got []string
	for _, change := range entry.Changes {
		got = append(got, change.Sha)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the changes are %v, want %v", got, want)
	}
	byChange := map[string]wikiRepoOpHistoryChange{}
	for _, change := range entry.Changes {
		byChange[change.Sha] = change
	}

	// The fix: the terms it changed in the entry's order, its body, and its own patch with eight rows of context on
	// each side of the line it changed — row 12 and row 28, not row 11 or row 29.
	fixed := byChange[fix]
	if fixed.Subject != "fix(queue): drop the queue lock" || fixed.Date != "2026-10-02T10:00:00Z" ||
		!reflect.DeepEqual(fixed.Terms, []string{"queue_lock", "SKIP LOCKED"}) ||
		fixed.Body != "The lock deadlocked under load; the queue now claims with SKIP LOCKED." || fixed.DiffTruncated {
		t.Fatalf("the fix reads %+v", fixed)
	}
	for _, line := range []string{"--- a/src/queue/run.ts\n", "-const lock = queue_lock(run);\n", "+const claim = claimNext(run); // SKIP LOCKED\n",
		" row 12\n", " row 28\n"} {
		if !strings.Contains(fixed.Diff, line) {
			t.Fatalf("the fix's patch lacks %q:\n%s", line, fixed.Diff)
		}
	}
	// (Git's hunk heading names the line above the hunk, "@@ … @@ row 11": that is not a line of context.)
	if strings.Contains(fixed.Diff, "\n row 11\n") || strings.Contains(fixed.Diff, "\n row 29\n") || strings.Contains(fixed.Diff, "run.spec.ts") {
		t.Fatalf("the fix's patch reaches past eight rows of context or into a file it did not change:\n%s", fixed.Diff)
	}
	// The note's one hunk passes a change's limit on its own: cut at a line's end within it.
	note := byChange[notes]
	if !reflect.DeepEqual(note.Terms, []string{"SKIP LOCKED"}) || !note.DiffTruncated || len(note.Diff) > wikiRepoOpHistoryChangeBytes ||
		len(note.Diff) < wikiRepoOpHistoryChangeBytes-80 || !strings.HasSuffix(note.Diff, "\n") || !strings.Contains(note.Diff, "+SKIP LOCKED\n") {
		t.Fatalf("the note's patch is %d bytes (truncated %v):\n%s", len(note.Diff), note.DiffTruncated, note.Diff)
	}
	// A probe: the one term it changed; a body past its limit is cut.
	first := byChange[probes[0]]
	if !reflect.DeepEqual(first.Terms, []string{"probe_term"}) || first.Body != strings.Repeat("x", wikiRepoOpHistoryBodyRunes) ||
		!strings.Contains(first.Diff, "+probe_term(run);\n") {
		t.Fatalf("the first probe reads %+v", first)
	}
	if second := byChange[probes[1]]; second.Body != "" || !strings.Contains(second.Diff, "-probe_term(run);\n") {
		t.Fatalf("the second probe, which takes the probe out, reads %+v", second)
	}
	if fifth := byChange[probes[4]]; fifth.Body != "" || !strings.Contains(fifth.Diff, "+probe_term(run);\n") {
		t.Fatalf("the fifth probe, which puts the probe in, reads %+v", fifth)
	}
}
