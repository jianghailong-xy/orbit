package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The repository operations (contracts/wiki.contract.json `repoOps`, design §7), against a throwaway
// git repository: the four answers — a snapshot's index, a bounded read, a diff, the anchor checks — and
// the two checks every operation makes before it reads anything (the space's repository URL and the
// checkout's first commit).

// wikiRepoOpFixture is a bare origin, a seed repository that pushes to it, and a checkout of it whose
// origin/main stays where the clone left it until something fetches.
type wikiRepoOpFixture struct {
	home, bare, seed, checkout string
	first                      string
}

func newWikiRepoOpFixture(t *testing.T) *wikiRepoOpFixture {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	f := &wikiRepoOpFixture{
		home: home, bare: filepath.Join(home, "origin.git"), seed: filepath.Join(home, "seed"),
		checkout: filepath.Join(home, "orbit"),
	}
	mustGit(t, home, "init", "-q", "--bare", "-b", "main", f.bare)
	if err := os.MkdirAll(f.seed, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.seed, "init", "-q", "-b", "main")
	mustGit(t, f.seed, "config", "user.email", "test@orbit")
	mustGit(t, f.seed, "config", "user.name", "Test")
	f.write(t, "README.md", "# orbit\n\nA repository the wiki reads, and one that is read every day.\n\nSecond paragraph.\n")
	f.write(t, "docs/design.md", "# The design\n\n## §4.3 Snapshots\n\nThe runner builds one per commit.\n\n"+
		"## §7 Repository operations\n\nFour questions.\n\n```\n## not a heading\n```\n\n## After the fence\n\nstill here.\n")
	f.write(t, "docs/other.md", "# The other half\n\nNothing to see.\n")
	f.write(t, "contracts/thing.contract.json", "{\n  \"table\": \"thing\",\n  \"states\": [\"a\"]\n}\n")
	f.write(t, "src/a.ts", "// a file\nexport function alphaOne() {\n  return 1;\n}\n\nexport class BetaBox {\n  open() {}\n}\n")
	mustGit(t, f.seed, "add", ".")
	mustGit(t, f.seed, "commit", "-q", "-m", "first")
	f.first = mustGit(t, f.seed, "rev-parse", "HEAD")
	mustGit(t, f.seed, "remote", "add", "origin", f.bare)
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	mustGit(t, home, "clone", "-q", f.bare, f.checkout)
	mustGit(t, f.checkout, "config", "user.email", "test@orbit")
	mustGit(t, f.checkout, "config", "user.name", "Test")
	return f
}

func (f *wikiRepoOpFixture) write(t *testing.T, name, content string) {
	t.Helper()
	path := filepath.Join(f.seed, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// push lands a commit on origin's main from the seed; the checkout does not see it until it fetches.
func (f *wikiRepoOpFixture) push(t *testing.T, message string, change func()) string {
	t.Helper()
	change()
	mustGit(t, f.seed, "add", "-A")
	mustGit(t, f.seed, "commit", "-q", "-m", message)
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	return mustGit(t, f.seed, "rev-parse", "HEAD")
}

// command is the operation as the control plane hands it over: this checkout, and the space's repository.
func (f *wikiRepoOpFixture) command(t *testing.T, kind string, input map[string]interface{}) WikiRepoOpCommand {
	t.Helper()
	return WikiRepoOpCommand{
		ID:              "op-1",
		Kind:            kind,
		ClaimGeneration: 1,
		LeaseOwner:      "00000000-0000-0000-0000-0000000000aa",
		WorkDir:         f.checkout,
		RepoURLNorm:     normalizeWikiRepoURL(f.bare),
		RootCommitSha:   f.first,
		Input:           input,
	}
}

func decodeResult[T any](t *testing.T, outcome wikiRepoOpOutcome, key string) T {
	t.Helper()
	if outcome.state != "succeeded" {
		t.Fatalf("operation failed: %s", outcome.err)
	}
	raw, err := json.Marshal(outcome.result[key])
	if err != nil {
		t.Fatalf("result %q: %v", key, err)
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("result %q did not read back: %v", key, err)
	}
	return out
}

func TestWikiRepoOpSnapshotBuildsTheIndexThePipelinesQuery(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	head := f.push(t, "second", func() {
		f.write(t, "docs/design.md", "# The design\n\n## §4.3 Snapshots\n\nThe runner builds one per commit.\n\n"+
			"## §7 Repository operations\n\nFour questions.\n\n```\n## not a heading\n```\n\n## After the fence\n\nstill here.\n"+
			"\n## Added later\n\nnew.\n")
	})

	outcome := runWikiRepoOp(f.command(t, "snapshot", map[string]interface{}{}), nil)
	if outcome.state != "succeeded" {
		t.Fatalf("snapshot failed: %s", outcome.err)
	}
	result := outcome.result
	if result["sha"] != head {
		t.Fatalf("snapshot sha = %v, want %v", result["sha"], head)
	}
	if _, ok := result["index"].(string); !ok {
		t.Fatalf("a snapshot that fits travels inside the result as one fragment")
	}
	var index wikiRepoOpIndex
	payload, ok := result["index"].(string)
	if !ok {
		t.Fatalf("the snapshot's payload is not text: %T", result["index"])
	}
	if err := json.Unmarshal([]byte(payload), &index); err != nil {
		t.Fatalf("the snapshot's payload is not the index: %v", err)
	}

	// Every path of the tree with its size: the walk of `hasPath` is a lookup in this.
	if path := findFile(index, "src/a.ts"); path == nil || path.Size == 0 {
		t.Fatalf("the snapshot has no src/a.ts with a size: %+v", index.Files)
	}
	if findFile(index, "docs/design.md") == nil || findFile(index, "contracts/thing.contract.json") == nil {
		t.Fatalf("the snapshot's file list is missing a file: %+v", index.Files)
	}
	if path := findFile(index, "no/such/file.ts"); path != nil {
		t.Fatalf("the snapshot invented a path: %+v", path)
	}

	// Documents: the title and the headings, which is what a gate's `hasDocSection` reads.
	doc := findDoc(index, "docs/design.md")
	if doc == nil || doc.Title != "The design" {
		t.Fatalf("the snapshot's document is not the one the tree has: %+v", doc)
	}
	headings := map[string]bool{}
	for _, heading := range doc.Headings {
		headings[heading.Text] = true
	}
	if !headings["§7 Repository operations"] || !headings["After the fence"] || !headings["Added later"] {
		t.Fatalf("headings missing: %+v", doc.Headings)
	}
	if headings["not a heading"] {
		t.Fatalf("a heading inside a code fence was read as a heading: %+v", doc.Headings)
	}

	// Symbols: what a source file declares, which is what `hasSymbol` reads first.
	symbols := index.Symbols["src/a.ts"]
	if !contains(symbols, "alphaOne()") || !contains(symbols, "BetaBox") {
		t.Fatalf("the snapshot's symbols for src/a.ts are wrong: %+v", symbols)
	}

	// The contracts' inventory: path, size and top-level keys.
	if len(index.Contracts) != 1 || index.Contracts[0].Path != "contracts/thing.contract.json" {
		t.Fatalf("the contracts inventory is wrong: %+v", index.Contracts)
	}
	if !contains(index.Contracts[0].Keys, "table") || !contains(index.Contracts[0].Keys, "states") {
		t.Fatalf("the contract's keys are wrong: %+v", index.Contracts[0].Keys)
	}

	// The commits origin/main reaches — what a commit anchor's reachability is answered from.
	if !contains(index.Commits, head) || !contains(index.Commits, f.first) {
		t.Fatalf("the commit set is missing one of this repository's commits: %+v", index.Commits)
	}
	if len(index.Commits) != 2 {
		t.Fatalf("the commit set has %d entries, want the two on main", len(index.Commits))
	}

	// The README's first paragraph, markup taken out.
	if !strings.Contains(index.Readme, "A repository the wiki reads, and one that is read every day.") ||
		strings.Contains(index.Readme, "Second paragraph") {
		t.Fatalf("the readme's first paragraph is wrong: %q", index.Readme)
	}
}

func TestWikiRepoOpSnapshotSkipsACommitTheServerAlreadyHolds(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	head := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main")

	outcome := runWikiRepoOp(f.command(t, "snapshot", map[string]interface{}{"skipSha": head}), nil)
	if outcome.state != "succeeded" {
		t.Fatalf("the skip failed: %s", outcome.err)
	}
	if outcome.result["sha"] != head || outcome.result["skipped"] != true {
		t.Fatalf("a skipped snapshot answers with the sha and the skip: %+v", outcome.result)
	}
	if _, ok := outcome.result["index"]; ok {
		t.Fatalf("a skipped snapshot sent an index: %+v", outcome.result)
	}
	// A commit the server does not hold is built, not skipped.
	next := f.push(t, "second", func() { f.write(t, "docs/other.md", "# The other half\n\nChanged.\n") })
	built := runWikiRepoOp(f.command(t, "snapshot", map[string]interface{}{"skipSha": head}), nil)
	if built.result["sha"] != next || built.result["skipped"] != nil {
		t.Fatalf("the snapshot did not build the new commit: %+v", built.result)
	}
}

func TestWikiRepoOpReadAnswersWithTheWholeFile(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	// A document far past the old window (22,000 characters): the whole file comes back, byte for byte.
	body := strings.Repeat("文", 30000)
	content := "# Long\n\n## Wall\n\n" + body + "\n"
	head := f.push(t, "long", func() { f.write(t, "docs/long.md", content) })

	outcome := runWikiRepoOp(f.command(t, "read", map[string]interface{}{
		"sha": head,
		"items": []map[string]interface{}{
			{"path": "docs/long.md"},
			{"path": "docs/design.md", "section": "§4.3 Snapshots"},
			{"path": "contracts/thing.contract.json"},
		},
	}), nil)
	if outcome.state != "succeeded" {
		t.Fatalf("read failed: %s", outcome.err)
	}
	if outcome.payload != "" {
		t.Fatalf("a read of %d bytes should travel inside the result, not in fragments", len(content))
	}
	answer := decodeResult[wikiRepoOpReadAnswer](t, outcome, "read")
	if len(answer.Items) != 3 {
		t.Fatalf("the read answered %d items, want 3", len(answer.Items))
	}
	whole := answer.Items[0]
	if !whole.Found || whole.Truncated {
		t.Fatalf("the whole file was not answered whole: %+v", whole)
	}
	if whole.Text != content {
		t.Fatalf("the whole file is not byte for byte what the commit has: %d runes, want %d", len([]rune(whole.Text)), len([]rune(content)))
	}
	if whole.Chars != len([]rune(content)) || whole.Size != int64(len(content)) {
		t.Fatalf("the answer's sizes are wrong: chars=%d size=%d", whole.Chars, whole.Size)
	}
	// One section still reads as its own section when a caller asks for one.
	section := answer.Items[1]
	if !strings.Contains(section.Text, "§4.3 Snapshots") || !strings.Contains(section.Text, "The runner builds one per commit.") {
		t.Fatalf("the section read is wrong: %q", section.Text)
	}
	if strings.Contains(section.Text, "Four questions") || strings.Contains(section.Text, "The design") {
		t.Fatalf("the section read took more than its own section: %q", section.Text)
	}
	if answer.Items[2].Chars == 0 || !strings.Contains(answer.Items[2].Text, "\"table\"") {
		t.Fatalf("the contract was not read: %+v", answer.Items[2])
	}
	if answer.Chars != whole.Chars+section.Chars+answer.Items[2].Chars {
		t.Fatalf("the answer's total is not its items': %d", answer.Chars)
	}

	// A path the commit does not have is an answer, not a failure: found=false, and no reason.
	missing := runWikiRepoOp(f.command(t, "read", map[string]interface{}{
		"sha": head, "items": []map[string]interface{}{{"path": "docs/nope.md"}},
	}), nil)
	absent := decodeResult[wikiRepoOpReadAnswer](t, missing, "read")
	if absent.Items[0].Found || absent.Items[0].Reason != "" || absent.Items[0].Size != 0 {
		t.Fatalf("a read of a path the tree has not found something: %+v", absent.Items[0])
	}

	// A request that names a limit is answered within it: what an older control plane asks by.
	bounded := runWikiRepoOp(f.command(t, "read", map[string]interface{}{
		"sha": head,
		"items": []map[string]interface{}{
			{"path": "docs/long.md", "maxChars": 1000},
		},
	}), nil)
	cut := decodeResult[wikiRepoOpReadAnswer](t, bounded, "read")
	if !cut.Items[0].Found || !cut.Items[0].Truncated || cut.Items[0].Chars != 1000 {
		t.Fatalf("a bounded read was not cut at exactly its limit: %+v", cut.Items[0])
	}
}

func TestWikiRepoOpReadRefusesAFileOverTheLimit(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	// Just over the file cap: missing with the reason, and the size it would have been.
	big := strings.Repeat("y", wikiRepoOpWholeFileBytes+1)
	head := f.push(t, "big", func() { f.write(t, "docs/big.md", big) })

	outcome := runWikiRepoOp(f.command(t, "read", map[string]interface{}{
		"sha": head, "items": []map[string]interface{}{{"path": "docs/big.md"}, {"path": "docs/design.md"}},
	}), nil)
	answer := decodeResult[wikiRepoOpReadAnswer](t, outcome, "read")
	over := answer.Items[0]
	if over.Found || over.Reason != "too_large" || over.Size != int64(len(big)) || over.Text != "" {
		t.Fatalf("a file over the limit was not refused with its reason: %+v", over)
	}
	// The rest of the request is answered: one file over the limit is one missing item, not a failed read.
	if !answer.Items[1].Found || !strings.Contains(answer.Items[1].Text, "The design") {
		t.Fatalf("the item after the refused one was not read: %+v", answer.Items[1])
	}
}

func TestWikiRepoOpReadUploadsALargeAnswerInFragments(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	// Three files that fit the file cap but not one request body: the answer travels in fragments.
	piece := strings.Repeat("z", 1500*1024)
	head := f.push(t, "huge", func() {
		for _, name := range []string{"docs/one.md", "docs/two.md", "docs/three.md"} {
			f.write(t, name, "# "+name+"\n\n"+piece+"\n")
		}
	})
	outcome := runWikiRepoOp(f.command(t, "read", map[string]interface{}{
		"sha": head,
		"items": []map[string]interface{}{
			{"path": "docs/one.md"}, {"path": "docs/two.md"}, {"path": "docs/three.md"},
		},
	}), nil)
	if outcome.state != "succeeded" {
		t.Fatalf("read failed: %s", outcome.err)
	}
	if outcome.payload == "" {
		t.Fatalf("an answer of more than %d bytes should travel in fragments", wikiRepoOpInlineBytes)
	}
	if outcome.payloadKey != "read" || outcome.sha != head {
		t.Fatalf("the fragmented answer is not the read's: key=%q sha=%q", outcome.payloadKey, outcome.sha)
	}
	fragments := wikiRepoOpFragments(outcome.payload)
	if len(fragments) < 2 {
		t.Fatalf("the answer was not split: %d fragments", len(fragments))
	}
	for _, fragment := range fragments {
		if len(fragment) > wikiRepoOpFragmentBytes {
			t.Fatalf("a fragment of %d bytes is over the contract's %d", len(fragment), wikiRepoOpFragmentBytes)
		}
	}
	// Reassembled by ordinal, the answer is byte for byte what the runner read.
	if got := strings.Join(fragments, ""); got != outcome.payload {
		t.Fatalf("the fragments do not reassemble to the answer: %d bytes, want %d", len(got), len(outcome.payload))
	}
	var answer wikiRepoOpReadAnswer
	if err := json.Unmarshal([]byte(outcome.payload), &answer); err != nil {
		t.Fatalf("the reassembled answer does not read back: %v", err)
	}
	if len(answer.Items) != 3 || answer.Items[0].Text != "# docs/one.md\n\n"+piece+"\n" {
		t.Fatalf("the reassembled answer is not the three files")
	}
}

func TestWikiRepoOpDiffNamesChangesAndAddedDocs(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	from := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main")
	to := f.push(t, "second", func() {
		f.write(t, "docs/added.md", "# Added\n\nA new design document.\n")
		f.write(t, "docs/design.md", "# The design\n\n## §4.3 Snapshots\n\nchanged.\n\n## §7 Repository operations\n\nFour questions.\n")
		f.write(t, "src/a.ts", "// a file\nexport function alphaOne() {\n  return 2;\n}\n\nexport class BetaBox {\n  open() {}\n}\n")
	})

	outcome := runWikiRepoOp(f.command(t, "diff", map[string]interface{}{"from": from, "to": to}), nil)
	answer := decodeResult[wikiRepoOpDiffAnswer](t, outcome, "diff")
	statuses := map[string]string{}
	for _, entry := range answer.Files {
		statuses[entry.Path] = entry.Status
	}
	if statuses["docs/added.md"] != "A" || statuses["docs/design.md"] != "M" || statuses["src/a.ts"] != "M" {
		t.Fatalf("the diff's statuses are wrong: %+v", answer.Files)
	}
	if len(answer.Files) != 3 {
		t.Fatalf("the diff names %d files, want the three that changed: %+v", len(answer.Files), answer.Files)
	}
	// The design documents the range added or copied: what a maintenance run looks for.
	if len(answer.Docs) != 1 || answer.Docs[0] != "docs/added.md" {
		t.Fatalf("the added design documents are wrong: %+v", answer.Docs)
	}
	// A rename is one entry, with where it came from.
	renamed := f.push(t, "rename", func() { mustGit(t, f.seed, "mv", "docs/other.md", "docs/renamed.md") })
	again := runWikiRepoOp(f.command(t, "diff", map[string]interface{}{"from": to, "to": renamed}), nil)
	moved := decodeResult[wikiRepoOpDiffAnswer](t, again, "diff")
	if len(moved.Files) != 1 || moved.Files[0].From != "docs/other.md" || moved.Files[0].Path != "docs/renamed.md" {
		t.Fatalf("the rename was not reported as one: %+v", moved.Files)
	}
	if !strings.HasPrefix(moved.Files[0].Status, "R") {
		t.Fatalf("the rename's status is %q", moved.Files[0].Status)
	}
}

func TestWikiRepoOpAnchorsReuseTheMaintenanceChecks(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	head := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main")
	content := "// a file\nexport function alphaOne() {\n  return 1;\n}\n\nexport class BetaBox {\n  open() {}\n}\n"
	region := regionOf(content, 2)

	outcome := runWikiRepoOp(f.command(t, "anchors", map[string]interface{}{
		"sha": head,
		"anchors": []map[string]interface{}{
			{"index": 0, "type": "path", "path": "docs/design.md"},
			{"index": 1, "type": "path", "path": "docs/gone.md"},
			{"index": 2, "type": "symbol", "path": "src/a.ts", "symbol": "alphaOne", "regionSha256": region},
			{"index": 3, "type": "symbol", "path": "src/a.ts", "symbol": "alphaOne", "regionSha256": strings.Repeat("0", 64)},
			{"index": 4, "type": "commit", "sha": f.first},
			{"index": 5, "type": "commit", "sha": strings.Repeat("c", 40)},
		},
	}), nil)
	answer := decodeResult[wikiRepoOpAnchorsAnswer](t, outcome, "anchors")
	if answer.Sha != head {
		t.Fatalf("the anchors were checked at %s, want %s", answer.Sha, head)
	}
	states := map[int]string{}
	regions := map[int]string{}
	for _, check := range answer.Anchors {
		states[check.Index] = check.State
		regions[check.Index] = check.RegionSha256
	}
	want := map[int]string{0: "verified", 1: "missing", 2: "verified", 3: "changed", 4: "verified", 5: "missing"}
	for index, state := range want {
		if states[index] != state {
			t.Fatalf("anchor %d is %q, want %q (all: %+v)", index, states[index], state, states)
		}
	}
	if regions[2] != region {
		t.Fatalf("the symbol's region hash is %q, want %q", regions[2], region)
	}
	// A commit that is only on a branch of the checkout's own is not reachable from origin/main.
	mustGit(t, f.checkout, "checkout", "-q", "-b", "side")
	if err := os.WriteFile(filepath.Join(f.checkout, "side.txt"), []byte("never merged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.checkout, "add", "side.txt")
	mustGit(t, f.checkout, "commit", "-q", "-m", "side")
	side := mustGit(t, f.checkout, "rev-parse", "HEAD")
	mustGit(t, f.checkout, "checkout", "-q", "main")

	aside := runWikiRepoOp(f.command(t, "anchors", map[string]interface{}{
		"sha": head, "anchors": []map[string]interface{}{{"index": 0, "type": "commit", "sha": side}},
	}), nil)
	if state := decodeResult[wikiRepoOpAnchorsAnswer](t, aside, "anchors").Anchors[0].State; state != "missing" {
		t.Fatalf("a side-branch commit reads %q, want missing", state)
	}
}

func TestWikiRepoOpRefusesACheckoutThatIsNotTheSpacesRepository(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	other := filepath.Join(f.home, "other.git")
	mustGit(t, f.home, "init", "-q", "--bare", "-b", "main", other)

	// The origin URL is not the space's: nothing is read.
	cmd := f.command(t, "snapshot", map[string]interface{}{})
	cmd.RepoURLNorm = normalizeWikiRepoURL(other)
	outcome := runWikiRepoOp(cmd, nil)
	if outcome.state != "failed" || !strings.Contains(outcome.err, "not of the space's repository") {
		t.Fatalf("a checkout of another repository was read anyway: %+v", outcome)
	}
	for _, kind := range []string{"read", "diff", "anchors"} {
		each := f.command(t, kind, map[string]interface{}{})
		each.RepoURLNorm = normalizeWikiRepoURL(other)
		refused := runWikiRepoOp(each, nil)
		if refused.state != "failed" || !strings.Contains(refused.err, "not of the space's repository") {
			t.Fatalf("%s read a checkout of another repository: %+v", kind, refused)
		}
	}

	// Another repository behind the SAME URL: the first commit is what tells them apart.
	second := filepath.Join(f.home, "second")
	if err := os.MkdirAll(second, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, second, "init", "-q", "-b", "main")
	mustGit(t, second, "config", "user.email", "test@orbit")
	mustGit(t, second, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(second, "README.md"), []byte("# another\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, second, "add", ".")
	mustGit(t, second, "commit", "-q", "-m", "another first")
	mustGit(t, second, "remote", "add", "origin", f.bare)
	mustGit(t, second, "push", "-q", "--force", "origin", "main")

	cmd = f.command(t, "snapshot", map[string]interface{}{})
	outcome = runWikiRepoOp(cmd, nil)
	if outcome.state != "failed" || !strings.Contains(outcome.err, "does not start from the space's first commit") {
		t.Fatalf("a forced-pushed origin was read anyway: %+v", outcome)
	}
	// And the URL check still passes for that checkout: it is the root commit that refused it.
	if normalizeWikiRepoURL(f.bare) != cmd.RepoURLNorm {
		t.Fatalf("the fixture's url norm moved: %q", cmd.RepoURLNorm)
	}
}

// A read or a diff of commits the checkout already has runs no fetch: a commit is the same text whichever
// fetch brought it, so origin/main stays where it was. The first commit is still held — asked of the
// commits named rather than of origin/main. A commit the checkout lacks is fetched, and a snapshot always is.
func TestWikiRepoOpReadAndDiffOfCommitsTheCheckoutHasRunNoFetch(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	second := f.push(t, "second", func() { f.write(t, "docs/other.md", "# The other half\n\nSecond.\n") })
	mustGit(t, f.checkout, "fetch", "-q", "origin")
	third := f.push(t, "third", func() { f.write(t, "docs/other.md", "# The other half\n\nThird.\n") })
	originMain := func() string { return mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main") }

	read := runWikiRepoOp(f.command(t, "read", map[string]interface{}{
		"sha": second, "items": []map[string]interface{}{{"path": "docs/other.md"}},
	}), nil)
	if answer := decodeResult[wikiRepoOpReadAnswer](t, read, "read"); !strings.Contains(answer.Items[0].Text, "Second.") {
		t.Fatalf("the read at %s answered %+v", second, answer.Items)
	}
	diff := runWikiRepoOp(f.command(t, "diff", map[string]interface{}{"from": f.first, "to": second}), nil)
	if answer := decodeResult[wikiRepoOpDiffAnswer](t, diff, "diff"); len(answer.Files) != 1 || answer.Files[0].Path != "docs/other.md" {
		t.Fatalf("the diff answered %+v", answer.Files)
	}
	if got := originMain(); got != second {
		t.Fatalf("origin/main is %s after a read and a diff of commits the checkout has, want %s where it was: they fetched", got, second)
	}

	// A commit of another history in the checkout — it does not start from the space's first commit — is
	// another repository's, and is refused although nothing was fetched.
	mustGit(t, f.checkout, "checkout", "-q", "--orphan", "stranger")
	if err := os.WriteFile(filepath.Join(f.checkout, "stranger.md"), []byte("# not the space's\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.checkout, "add", "stranger.md")
	mustGit(t, f.checkout, "commit", "-q", "-m", "a history of its own")
	stranger := mustGit(t, f.checkout, "rev-parse", "HEAD")
	mustGit(t, f.checkout, "checkout", "-q", "main")
	for _, cmd := range []WikiRepoOpCommand{
		f.command(t, "read", map[string]interface{}{"sha": stranger, "items": []map[string]interface{}{{"path": "stranger.md"}}}),
		f.command(t, "diff", map[string]interface{}{"from": f.first, "to": stranger}),
	} {
		refused := runWikiRepoOp(cmd, nil)
		if refused.state != "failed" || !strings.Contains(refused.err, "does not start from the space's first commit") {
			t.Fatalf("a %s of a commit from another history was answered: %+v", cmd.Kind, refused)
		}
	}
	if got := originMain(); got != second {
		t.Fatalf("origin/main is %s after the refusals, want %s: they fetched", got, second)
	}

	// A commit the checkout does not have is fetched first.
	fetched := runWikiRepoOp(f.command(t, "read", map[string]interface{}{
		"sha": third, "items": []map[string]interface{}{{"path": "docs/other.md"}},
	}), nil)
	if answer := decodeResult[wikiRepoOpReadAnswer](t, fetched, "read"); !strings.Contains(answer.Items[0].Text, "Third.") {
		t.Fatalf("the read at %s answered %+v", third, answer.Items)
	}
	if got := originMain(); got != third {
		t.Fatalf("origin/main is %s after a read of a commit the checkout lacked, want %s: it did not fetch", got, third)
	}
	// A snapshot asks about origin/main as it is now, and always fetches.
	fourth := f.push(t, "fourth", func() { f.write(t, "docs/other.md", "# The other half\n\nFourth.\n") })
	snapshot := runWikiRepoOp(f.command(t, "snapshot", map[string]interface{}{"skipSha": third}), nil)
	if snapshot.state != "succeeded" || snapshot.sha != fourth {
		t.Fatalf("the snapshot = %s at %q (%s), want one built at %s", snapshot.state, snapshot.sha, snapshot.err, fourth)
	}
}

// holdOriginMainRefLock takes the lock git itself takes on refs/remotes/origin/main, the way a fetch the
// wiki's own lock does not cover — a session starting in the checkout, an integration job — holds it for
// the moment it writes the ref.
func holdOriginMainRefLock(t *testing.T, checkout string) string {
	t.Helper()
	lock := filepath.Join(checkout, ".git", "refs", "remotes", "origin", "main.lock")
	if err := os.MkdirAll(filepath.Dir(lock), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(lock) })
	return lock
}

// pauseBetweenRefLockAttempts replaces the wait between two fetches of a ref another process held with
// `pause`, for this test.
func pauseBetweenRefLockAttempts(t *testing.T, pause func(time.Duration)) {
	t.Helper()
	restore := integrationFetchLockPause
	integrationFetchLockPause = pause
	t.Cleanup(func() { integrationFetchLockPause = restore })
}

// Another fetch holding the ref's lock is waited out: the operation's fetch is refused it, and the same
// fetch, tried again once that fetch is done, answers (integrationFetch's answer to the same race).
func TestWikiRepoOpFetchWaitsOutARefLockAnotherFetchHolds(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	moved := f.push(t, "main moves", func() { f.write(t, "docs/moved.md", "# Moved\n") })
	lock := holdOriginMainRefLock(t, f.checkout)
	released := false
	pauseBetweenRefLockAttempts(t, func(time.Duration) {
		if !released {
			released = true
			_ = os.Remove(lock)
		}
	})

	outcome := runWikiRepoOp(f.command(t, "snapshot", map[string]interface{}{}), nil)
	if outcome.state != "succeeded" || outcome.result["sha"] != moved {
		t.Fatalf("the snapshot = %s %v (%s), want one at %s once the other fetch let go", outcome.state, outcome.result["sha"], outcome.err, moved)
	}
	if !released {
		t.Fatal("the fetch never met the held ref lock, so this tested nothing")
	}
}

// A fetch that fails says which operation it was, in which checkout, and what git said — in the
// operation's own words, not those of `orbit wiki anchors verify`, which a reader of a failed read would
// otherwise go and look for.
func TestWikiRepoOpFetchFailureSaysWhichOperationInWhichCheckout(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	moved := f.push(t, "main moves", func() { f.write(t, "docs/moved.md", "# Moved\n") })
	root := mustGit(t, f.checkout, "rev-parse", "--show-toplevel")
	// Held for every attempt: a lock that outlives the retries is a failure, and is reported as one.
	holdOriginMainRefLock(t, f.checkout)
	pauseBetweenRefLockAttempts(t, func(time.Duration) {})

	// The read first: a fetch refused the ref still stores what it brought, and a read of a commit the
	// checkout then has would rightly run no fetch at all.
	for _, cmd := range []WikiRepoOpCommand{
		f.command(t, "read", map[string]interface{}{"sha": moved, "items": []map[string]interface{}{{"path": "docs/moved.md"}}}),
		f.command(t, "snapshot", map[string]interface{}{}),
		f.command(t, "anchors", map[string]interface{}{"anchors": []map[string]interface{}{{"index": 0, "type": "path", "path": "docs/moved.md"}}}),
	} {
		outcome := runWikiRepoOp(cmd, nil)
		want := "the " + cmd.Kind + " operation could not fetch origin main into the checkout " + root + ", so nothing was read: "
		if outcome.state != "failed" || !strings.Contains(outcome.err, want) || !strings.Contains(outcome.err, "cannot lock ref 'refs/remotes/origin/main'") {
			t.Fatalf("the %s's failed fetch = %s %q, want %q with git's own words", cmd.Kind, outcome.state, outcome.err, want)
		}
		if strings.Contains(outcome.err, "anchors verify") || strings.Contains(outcome.err, "nothing was checked") {
			t.Fatalf("the %s's failed fetch borrows anchors verify's words: %q", cmd.Kind, outcome.err)
		}
	}
}

func TestWikiRepoOpFragmentsCutOnCharactersAndRebuildThePayload(t *testing.T) {
	// A payload cut at the fragment size: the pieces are the payload, and a payload of one piece is one
	// piece — never zero, because the server counts them.
	if pieces := wikiRepoOpFragments("small"); len(pieces) != 1 || pieces[0] != "small" {
		t.Fatalf("a small payload is one fragment: %+v", pieces)
	}
	payload := strings.Repeat("文a", (wikiRepoOpFragmentBytes/3)+10)
	pieces := wikiRepoOpFragments(payload)
	if len(pieces) < 2 {
		t.Fatalf("a payload over the fragment size was not split: %d pieces", len(pieces))
	}
	for index, piece := range pieces {
		if len(piece) > wikiRepoOpFragmentBytes {
			t.Fatalf("fragment %d is %d bytes", index, len(piece))
		}
	}
	if rebuilt := strings.Join(pieces, ""); rebuilt != payload {
		t.Fatalf("the fragments do not rebuild the payload (%d vs %d bytes)", len(rebuilt), len(payload))
	}
}

func findFile(index wikiRepoOpIndex, path string) *wikiRepoOpIndexFile {
	for i := range index.Files {
		if index.Files[i].Path == path {
			return &index.Files[i]
		}
	}
	return nil
}

func findDoc(index wikiRepoOpIndex, path string) *wikiRepoOpIndexDoc {
	for i := range index.Docs {
		if index.Docs[i].Path == path {
			return &index.Docs[i]
		}
	}
	return nil
}
