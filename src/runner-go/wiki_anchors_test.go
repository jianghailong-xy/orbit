package main

import (
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// `orbit wiki anchors verify` against real git repositories and a fake runner door (contract
// `anchorRules.verify`): a bare origin, a checkout of it whose origin/main is behind until the command
// fetches, and the three anchor types checked on what the fetch brought — a sha that is not an
// ancestor of origin/main among them.

// anchorsRequest is one request the fake anchors door was sent.
type anchorsRequest struct {
	method, path, session string
	query                 url.Values
	body                  map[string]interface{}
}

// wikiAnchorsDoor is the runner door's two anchor routes: list answers GET .../anchors (by the after
// it was asked for) and report answers POST .../anchor-checks (by the body it was sent). The CLI is
// pointed at it from inside the maintenance session a run would be.
func wikiAnchorsDoor(t *testing.T, list func(after string) (int, string), report func(body map[string]interface{}) (int, string)) func() []anchorsRequest {
	t.Helper()
	var mu sync.Mutex
	var requests []anchorsRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := anchorsRequest{method: r.Method, path: r.URL.Path, query: r.URL.Query(), session: r.Header.Get("X-Orbit-Session-Id")}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &request.body); err != nil {
				t.Errorf("%s %s sent a body that is not JSON: %s", r.Method, r.URL.Path, raw)
			}
		}
		mu.Lock()
		requests = append(requests, request)
		mu.Unlock()
		status, body := http.StatusNotFound, `{"message":"no such route"}`
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/anchors"):
			status, body = list(r.URL.Query().Get("after"))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/anchor-checks"):
			status, body = report(request.body)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	orbitHome := t.TempDir()
	if err := os.Chmod(orbitHome, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"serverUrl":` + strconv.Quote(srv.URL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(filepath.Join(orbitHome, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", orbitHome)
	t.Setenv("ORBIT_SESSION_ID", "maintenance-session")
	t.Setenv(envWiki, "on")
	return func() []anchorsRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]anchorsRequest{}, requests...)
	}
}

// recordEveryEntry answers a report the way the server does when it records every entry: its state is
// the worst of its checks, and a broken one filed its challenge.
func recordEveryEntry(body map[string]interface{}) (int, string) {
	outcomes := []string{}
	for _, raw := range body["entries"].([]interface{}) {
		entry := raw.(map[string]interface{})
		state := "verified"
		for _, check := range entry["checks"].([]interface{}) {
			switch check.(map[string]interface{})["state"] {
			case "missing":
				state = "missing"
			case "changed":
				if state != "missing" {
					state = "changed"
				}
			}
		}
		op := "null"
		if state != "verified" {
			op = strconv.Quote("op-" + entry["entryId"].(string))
		}
		outcomes = append(outcomes, fmt.Sprintf(`{"entryId":%q,"status":"recorded","anchorState":%q,"trust":"owner","challenged":%t,"challengeOpId":%s}`,
			entry["entryId"], state, state != "verified", op))
	}
	return http.StatusOK, `{"spaceId":"space-1","ref":` + strconv.Quote(body["ref"].(string)) + `,"outcomes":[` + strings.Join(outcomes, ",") + `]}`
}

// ── the repositories ────────────────────────────────────────────────────────────────────────────

// symbolFile is src/a.ts as the first commit writes it: `foo` first occurs inside `fooBar` (not a
// whole word), and as a whole word on line 4, with more than a region's worth of lines after it.
func symbolFile(changedLine string) string {
	lines := []string{"// helpers", "export function fooBar() { return 0; }", "", "export function foo(x: number) {"}
	for i := 1; i <= 26; i++ {
		lines = append(lines, fmt.Sprintf("  const v%d = x + %d;", i, i))
	}
	if changedLine != "" {
		lines[5] = changedLine
	}
	return strings.Join(append(lines, "}"), "\n") + "\n"
}

// regionOf is the region hash, worked out here rather than by the code under test: the lines from the
// 1-based line `from`, twenty of them or to the end, each ended by a newline.
func regionOf(content string, from int) string {
	lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
	end := from - 1 + 20
	if end > len(lines) {
		end = len(lines)
	}
	sum := sha256.Sum256([]byte(strings.Join(lines[from-1:end], "\n") + "\n"))
	return hex.EncodeToString(sum[:])
}

// wikiAnchorsFixture is a bare origin, the seed repository that pushes to it, and a checkout of it under
// $HOME whose origin/main stays where the clone left it until something fetches.
type wikiAnchorsFixture struct {
	home, bare, seed, checkout string
	first                      string
}

func newWikiAnchorsFixture(t *testing.T) *wikiAnchorsFixture {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	f := &wikiAnchorsFixture{home: home, bare: filepath.Join(home, "origin.git"), seed: filepath.Join(home, "seed"), checkout: filepath.Join(home, "orbit")}
	mustGit(t, home, "init", "-q", "--bare", "-b", "main", f.bare)
	if err := os.MkdirAll(f.seed, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.seed, "init", "-q", "-b", "main")
	mustGit(t, f.seed, "config", "user.email", "test@orbit")
	mustGit(t, f.seed, "config", "user.name", "Test")
	f.write(t, "docs/a.md", "the design\n")
	f.write(t, "docs/b.md", "the other half\n")
	f.write(t, "src/a.ts", symbolFile(""))
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

func (f *wikiAnchorsFixture) write(t *testing.T, name, content string) {
	t.Helper()
	path := filepath.Join(f.seed, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// push lands a commit on origin's main from the seed: the checkout does not see it until it fetches.
func (f *wikiAnchorsFixture) push(t *testing.T, message string, change func()) string {
	t.Helper()
	change()
	mustGit(t, f.seed, "add", "-A")
	mustGit(t, f.seed, "commit", "-q", "-m", message)
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	return mustGit(t, f.seed, "rev-parse", "HEAD")
}

// sideCommit is a commit the checkout has on a branch of its own and main never got.
func (f *wikiAnchorsFixture) sideCommit(t *testing.T) string {
	t.Helper()
	mustGit(t, f.checkout, "checkout", "-q", "-b", "side")
	if err := os.WriteFile(filepath.Join(f.checkout, "side.txt"), []byte("never merged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.checkout, "add", "side.txt")
	mustGit(t, f.checkout, "commit", "-q", "-m", "side")
	sha := mustGit(t, f.checkout, "rev-parse", "HEAD")
	mustGit(t, f.checkout, "checkout", "-q", "main")
	return sha
}

func anchorsListReply(workDir string, next string, entries string) string {
	repo := "null"
	if workDir != "" {
		repo = `{"workspaceId":"ws-1","workDir":` + strconv.Quote(workDir) + `}`
	}
	after := "null"
	if next != "" {
		after = strconv.Quote(next)
	}
	return `{"spaceId":"space-1","repo":` + repo + `,"entries":[` + entries + `],"next":` + after + `}`
}

func reportsOf(requests []anchorsRequest) []map[string]interface{} {
	reports := []map[string]interface{}{}
	for _, request := range requests {
		if request.method == http.MethodPost {
			reports = append(reports, request.body)
		}
	}
	return reports
}

// checksOf is one reported entry's checks, as index → state (and → region for a symbol found).
func checksOf(t *testing.T, report map[string]interface{}, entryID string) map[int]map[string]interface{} {
	t.Helper()
	for _, raw := range report["entries"].([]interface{}) {
		entry := raw.(map[string]interface{})
		if entry["entryId"] != entryID {
			continue
		}
		checks := map[int]map[string]interface{}{}
		for _, check := range entry["checks"].([]interface{}) {
			c := check.(map[string]interface{})
			checks[int(c["index"].(float64))] = c
		}
		return checks
	}
	t.Fatalf("entry %s was not reported: %v", entryID, report)
	return nil
}

// ── the three anchor types, on what the fetch brought ───────────────────────────────────────────

func TestWikiAnchorsVerifyChecksPathSymbolAndCommitOnWhatTheFetchBrought(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	side := f.sideCommit(t)
	unknown := fmt.Sprintf("%x", sha1.Sum([]byte("a commit no repository here has")))
	baseline := regionOf(symbolFile(""), 4)
	// origin's main moves on after the checkout was cloned: docs/a.md is deleted and a line of foo's
	// region is rewritten. Only a fetch shows the checkout either.
	moved := f.push(t, "second", func() {
		if err := os.Remove(filepath.Join(f.seed, "docs/a.md")); err != nil {
			t.Fatal(err)
		}
		f.write(t, "src/a.ts", symbolFile("  const v2 = x * 2;"))
	})
	if got := mustGit(t, f.checkout, "rev-parse", "origin/main"); got != f.first {
		t.Fatalf("the fixture's checkout already knows origin/main at %s", got)
	}
	entries := strings.Join([]string{
		`{"entryId":"e-path","revision":1,"anchors":[{"index":0,"type":"path","path":"docs/a.md"},{"index":1,"type":"path","path":"./docs/b.md"}]}`,
		`{"entryId":"e-symbol","revision":2,"anchors":[{"index":0,"type":"symbol","path":"src/a.ts","symbol":"foo","regionSha256":"` + baseline + `"},` +
			`{"index":1,"type":"symbol","path":"src/a.ts","symbol":"fooBar","regionSha256":null},` +
			`{"index":2,"type":"symbol","path":"src/a.ts","symbol":"bar","regionSha256":null}]}`,
		`{"entryId":"e-commit","revision":1,"anchors":[{"index":0,"type":"commit","sha":"` + f.first + `"},` +
			`{"index":1,"type":"commit","sha":"` + side + `"},{"index":2,"type":"commit","sha":"` + unknown + `"}]}`,
	}, ",")
	requests := wikiAnchorsDoor(t, func(string) (int, string) {
		// The workspace stores its directory as the owner typed it: `~/orbit`, which only this runner can expand.
		return http.StatusOK, anchorsListReply("~/orbit", "", entries)
	}, recordEveryEntry)

	var out strings.Builder
	if err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("orbit wiki anchors verify: %v\n%s", err, out.String())
	}
	if got := mustGit(t, f.checkout, "rev-parse", "origin/main"); got != moved {
		t.Fatalf("origin/main is %s after the run, want %s: the command did not fetch", got, moved)
	}
	sent := requests()
	for _, request := range sent {
		if request.session != "maintenance-session" {
			t.Errorf("%s %s was sent as %q, not as the maintenance session", request.method, request.path, request.session)
		}
	}
	reports := reportsOf(sent)
	if len(reports) != 1 {
		t.Fatalf("reports = %d, want one for the one page: %+v", len(reports), sent)
	}
	report := reports[0]
	if report["ref"] != moved {
		t.Fatalf("the report names %v, want the commit origin/main named after the fetch (%s)", report["ref"], moved)
	}

	paths := checksOf(t, report, "e-path")
	if paths[0]["state"] != "missing" || paths[1]["state"] != "verified" {
		t.Errorf("path checks = %v: a deleted file is missing, one still there (spelled ./docs/b.md) verified", paths)
	}
	symbols := checksOf(t, report, "e-symbol")
	changed := regionOf(symbolFile("  const v2 = x * 2;"), 4)
	if symbols[0]["state"] != "changed" || symbols[0]["regionSha256"] != changed {
		t.Errorf("foo = %v, want changed with the region the fetch brought (%s): its baseline was %s", symbols[0], changed, baseline)
	}
	// fooBar has no baseline yet: found is verified, and the hash of ITS region (line 2) is reported for
	// the server to hold it to from now on.
	if symbols[1]["state"] != "verified" || symbols[1]["regionSha256"] != regionOf(symbolFile("  const v2 = x * 2;"), 2) {
		t.Errorf("fooBar = %v, want verified with the region from line 2", symbols[1])
	}
	if symbols[2]["state"] != "missing" || symbols[2]["regionSha256"] != nil {
		t.Errorf("bar = %v, want missing and no region: it occurs nowhere as a whole word", symbols[2])
	}
	commits := checksOf(t, report, "e-commit")
	if commits[0]["state"] != "verified" {
		t.Errorf("an ancestor of origin/main = %v, want verified", commits[0])
	}
	if commits[1]["state"] != "missing" {
		t.Errorf("a sha that is not an ancestor of origin/main = %v, want missing", commits[1])
	}
	if commits[2]["state"] != "missing" {
		t.Errorf("a sha the repository does not have = %v, want missing", commits[2])
	}
	for _, raw := range report["entries"].([]interface{}) {
		if revision := raw.(map[string]interface{})["revision"]; revision != float64(map[string]int{"e-path": 1, "e-symbol": 2, "e-commit": 1}[raw.(map[string]interface{})["entryId"].(string)]) {
			t.Errorf("an entry reported revision %v, not the one the list gave", revision)
		}
	}

	var summary wikiAnchorsSummary
	if err := json.Unmarshal([]byte(out.String()), &summary); err != nil {
		t.Fatalf("--json printed %q: %v", out.String(), err)
	}
	if summary.Repo != f.checkout || summary.Ref != moved {
		t.Errorf("summary names %s at %s, want the expanded checkout %s at %s", summary.Repo, summary.Ref, f.checkout, moved)
	}
	if summary.Entries != 3 || summary.Anchors != 8 || summary.Verified != 3 || summary.Changed != 1 || summary.Missing != 4 || summary.Failed != 0 {
		t.Errorf("summary = %+v, want 3 entries, 8 anchors: 3 verified, 1 changed, 4 missing, none failed", summary)
	}
	if summary.Recorded != 3 || summary.Challenges != 3 {
		t.Errorf("summary = %+v, want all three entries recorded and a challenge for each broken one", summary)
	}
}

// The criterion's own words: a sha that is not an ancestor of origin/main is missing — even one the
// checkout has, on a branch of its own, and even one origin has on another branch.
func TestWikiAnchorsNonAncestorShaIsMissing(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	side := f.sideCommit(t)
	// A branch origin has and main does not: fetched by nobody here, and pushed from the seed.
	mustGit(t, f.seed, "checkout", "-q", "-b", "feature")
	f.write(t, "feature.txt", "on a branch\n")
	mustGit(t, f.seed, "add", "feature.txt")
	mustGit(t, f.seed, "commit", "-q", "-m", "feature")
	feature := mustGit(t, f.seed, "rev-parse", "HEAD")
	mustGit(t, f.seed, "push", "-q", "origin", "feature")
	mustGit(t, f.checkout, "fetch", "-q", "origin", "feature")
	for _, sha := range []string{side, feature} {
		state, err := checkWikiCommitAnchor(f.checkout, f.first, sha)
		if err != nil || state != "missing" {
			t.Errorf("commit %s, not an ancestor of %s: %q, %v — want missing", sha, f.first, state, err)
		}
	}
	if state, err := checkWikiCommitAnchor(f.checkout, f.first, f.first); err != nil || state != "verified" {
		t.Errorf("origin/main's own commit: %q, %v — want verified", state, err)
	}
	if state, err := checkWikiCommitAnchor(f.checkout, f.first, strings.ToUpper(f.first)); err != nil || state != "verified" {
		t.Errorf("the same sha in capitals: %q, %v — want verified", state, err)
	}
	if state, err := checkWikiCommitAnchor(f.checkout, f.first, "41e75ba35"); err != nil || state != "missing" {
		t.Errorf("a short sha: %q, %v — want missing, never a guess at which commit it meant", state, err)
	}
}

// A symbol's region is the line git grep finds it on as a whole word and the nineteen after it, each
// ended by a newline; at the end of a file it is what is left, and a final newline is not a line.
func TestWikiAnchorsSymbolRegionIsTheLinesFromTheFirstWholeWordHit(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	state, region, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/a.ts", "foo", "")
	if err != nil || state != "verified" || region != regionOf(symbolFile(""), 4) {
		t.Fatalf("foo = %q, %q, %v: want verified with the region from line 4, not from fooBar on line 2", state, region, err)
	}
	if state, _, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/a.ts", "foo", region); err != nil || state != "verified" {
		t.Errorf("foo against its own baseline = %q, %v", state, err)
	}
	if state, _, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/a.ts", "foo", strings.Repeat("0", 64)); err != nil || state != "changed" {
		t.Errorf("foo against another baseline = %q, %v, want changed", state, err)
	}
	// A directory: the first file under it, in path order, that has the symbol.
	if state, dirRegion, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/", "foo", ""); err != nil || state != "verified" || dirRegion != region {
		t.Errorf("foo under src/ = %q, %q, %v", state, dirRegion, err)
	}
	for _, missing := range []struct{ path, symbol string }{{"src/a.ts", "bar"}, {"src/none.ts", "foo"}, {"../outside", "foo"}, {"src/a.ts", ""}} {
		if state, region, err := checkWikiSymbolAnchor(f.checkout, f.first, missing.path, missing.symbol, ""); err != nil || state != "missing" || region != "" {
			t.Errorf("symbol %q in %q = %q, %q, %v, want missing", missing.symbol, missing.path, state, region, err)
		}
	}

	// The hashing on its own: the end of a file, and a final newline.
	content := "a\nb\nc\n"
	want := sha256.Sum256([]byte("b\nc\n"))
	if got, ok := wikiSymbolRegionSha256([]byte(content), 2); !ok || got != hex.EncodeToString(want[:]) {
		t.Errorf("region from line 2 of %q = %s", content, got)
	}
	if got, _ := wikiSymbolRegionSha256([]byte("a\nb\nc"), 2); got != hex.EncodeToString(want[:]) {
		t.Errorf("a file with no final newline hashes its last line the same way: %s", got)
	}
	if _, ok := wikiSymbolRegionSha256([]byte(content), 4); ok {
		t.Error("a line past the end of the file has no region")
	}
	for in, want := range map[string]string{"./docs/a.md": "docs/a.md", "/docs//a.md": "docs/a.md", "src/": "src", " docs/a.md ": "docs/a.md"} {
		if got := wikiAnchorPath(in); got != want {
			t.Errorf("wikiAnchorPath(%q) = %q, want %q", in, got, want)
		}
	}
	for path, want := range map[string]string{"docs/a.md": "verified", "docs": "verified", "docs/none.md": "missing", "../x": "missing", "docs//a.md": "verified"} {
		if state, err := checkWikiPathAnchor(f.checkout, f.first, path); err != nil || state != want {
			t.Errorf("path %q = %q, %v, want %s", path, state, err, want)
		}
	}
}

// ── what the run refuses to do ──────────────────────────────────────────────────────────────────

// A fetch that fails checks nothing and reports nothing: an origin/main that was not just fetched says
// nothing about main.
func TestWikiAnchorsFetchFailureChecksNothing(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	mustGit(t, f.checkout, "remote", "set-url", "origin", filepath.Join(f.home, "gone.git"))
	requests := wikiAnchorsDoor(t, func(string) (int, string) {
		return http.StatusOK, anchorsListReply(f.checkout, "", `{"entryId":"e1","revision":1,"anchors":[{"index":0,"type":"path","path":"docs/a.md"}]}`)
	}, recordEveryEntry)
	err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "git fetch origin main failed") || !strings.Contains(err.Error(), "nothing was checked") {
		t.Fatalf("a failed fetch = %v, want the refusal that says nothing was checked", err)
	}
	if reports := reportsOf(requests()); len(reports) != 0 {
		t.Fatalf("a run whose fetch failed reported %v", reports)
	}
}

// --repo wins over the workspace's directory, has to be a checkout, and without either there is nothing
// to check in.
func TestWikiAnchorsRepoIsTheFlagOrTheWorkspacesDirectory(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	requests := wikiAnchorsDoor(t, func(string) (int, string) {
		return http.StatusOK, anchorsListReply("~/nowhere", "", `{"entryId":"e1","revision":1,"anchors":[{"index":0,"type":"path","path":"docs/a.md"}]}`)
	}, recordEveryEntry)
	var out strings.Builder
	if err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1", "--repo", f.checkout}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("--repo a checkout: %v", err)
	}
	if !strings.Contains(out.String(), "in "+f.checkout) || !strings.Contains(out.String(), "1 verified") {
		t.Errorf("the summary does not say where and what it checked: %q", out.String())
	}
	if len(reportsOf(requests())) != 1 {
		t.Fatalf("reports = %v", reportsOf(requests()))
	}
	err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), filepath.Join(f.home, "nowhere")) || !strings.Contains(err.Error(), "is not a git checkout") {
		t.Errorf("the workspace's ~/nowhere = %v, want it expanded and refused as no checkout", err)
	}

	wikiAnchorsDoor(t, func(string) (int, string) {
		return http.StatusOK, anchorsListReply("", "", `{"entryId":"e1","revision":1,"anchors":[{"index":0,"type":"path","path":"docs/a.md"}]}`)
	}, recordEveryEntry)
	err = cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "pass --repo") {
		t.Errorf("no workspace directory and no --repo = %v, want the sentence that asks for --repo", err)
	}
}

// Every page is read and reported; a stale entry is no failure, and a refused one is.
func TestWikiAnchorsReportsEveryPageAndExitsNonZeroOnARefusal(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	pages := map[string]string{
		"":   anchorsListReply(f.checkout, "e1", `{"entryId":"e1","revision":1,"anchors":[{"index":0,"type":"path","path":"docs/a.md"}]}`),
		"e1": anchorsListReply(f.checkout, "", `{"entryId":"e2","revision":1,"anchors":[{"index":0,"type":"path","path":"docs/none.md"}]}`),
	}
	stale := false
	requests := wikiAnchorsDoor(t, func(after string) (int, string) { return http.StatusOK, pages[after] }, func(body map[string]interface{}) (int, string) {
		entry := body["entries"].([]interface{})[0].(map[string]interface{})
		if stale && entry["entryId"] == "e2" {
			return http.StatusOK, `{"spaceId":"space-1","ref":"x","outcomes":[{"entryId":"e2","status":"stale","message":"the entry is at revision 2 now"}]}`
		}
		return recordEveryEntry(body)
	})
	if err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("two pages: %v", err)
	}
	sent := requests()
	var reported []string
	for _, report := range reportsOf(sent) {
		for _, entry := range report["entries"].([]interface{}) {
			reported = append(reported, entry.(map[string]interface{})["entryId"].(string))
		}
	}
	if !reflect.DeepEqual(reported, []string{"e1", "e2"}) {
		t.Fatalf("reported %v, want both pages' entries", reported)
	}
	if got := sent[len(sent)-2].query.Get("after"); got != "e1" {
		t.Errorf("the second page was asked for after %q, want the first page's next", got)
	}
	stale = true
	var out strings.Builder
	if err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("a stale entry is not a failure: %v", err)
	}
	if !strings.Contains(out.String(), "e2: stale") {
		t.Errorf("the summary does not say which entry was stale: %q", out.String())
	}

	wikiAnchorsDoor(t, func(after string) (int, string) { return http.StatusOK, pages[after] }, func(body map[string]interface{}) (int, string) {
		entry := body["entries"].([]interface{})[0].(map[string]interface{})
		if entry["entryId"] == "e2" {
			return recordEveryEntry(body)
		}
		return http.StatusBadRequest, `{"spaceId":"space-1","ref":"x","outcomes":[{"entryId":"e1","status":"refused","httpStatus":400,"code":"WIKI_SCHEMA","message":"entries[0].checks[0].state is wrong"}]}`
	})
	out.Reset()
	err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "refused 1 entry") {
		t.Fatalf("a refused entry = %v, want a non-zero exit that says so", err)
	}
	if !strings.Contains(out.String(), "refused WIKI_SCHEMA") || !strings.Contains(out.String(), "e2: missing") {
		t.Errorf("the summary does not show the refusal beside the entry that was recorded: %q", out.String())
	}

	// A list that does not move past the page it was asked past is read once more, and no further.
	lists := 0
	wikiAnchorsDoor(t, func(string) (int, string) {
		lists++
		return http.StatusOK, pages[""]
	}, recordEveryEntry)
	out.Reset()
	err = cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "did not move past entry e1") {
		t.Fatalf("a list that never advances = %v, want the run to stop and say so", err)
	}
	if lists != 2 || !strings.Contains(out.String(), "2 entries") {
		t.Errorf("the run read the list %d times and printed %q: want two reads, and what it checked reported", lists, out.String())
	}
}

// Each refusal of the door reads as a sentence that says nothing was checked.
func TestWikiAnchorsRefusalsReadAsSentences(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
		status           int
	}{
		{"not a maintenance run", `{"code":"WIKI_NOT_MAINTENANCE_SESSION","message":"only a maintenance run"}`, "only a Wiki maintenance run of space space-1 re-verifies its anchors", http.StatusForbidden},
		{"a server that predates the door", `{"message":"Cannot GET /api/runner/wiki/spaces/space-1/anchors","statusCode":404}`, "no anchor re-verification door yet", http.StatusNotFound},
		{"another account's space", `{"message":"no such wiki space","statusCode":404}`, "this account has no wiki space space-1", http.StatusNotFound},
		{"a session another runner hosts", `{"message":"X-Orbit-Session-Id names no session this runner hosts","statusCode":403}`, "does not know this session", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wikiAnchorsDoor(t, func(string) (int, string) { return tc.status, tc.body }, recordEveryEntry)
			err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), io.Discard)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("%s = %v, want %q", tc.name, err, tc.want)
			}
		})
	}
	var out strings.Builder
	if err := cmdWikiCLI([]string{"anchors", "--help"}, strings.NewReader(""), &out); err != nil || !strings.Contains(out.String(), "orbit wiki anchors verify --space") {
		t.Errorf("orbit wiki anchors --help = %v, %q", err, out.String())
	}
	if err := cmdWikiCLI([]string{"anchors", "check"}, strings.NewReader(""), io.Discard); err == nil || !strings.Contains(err.Error(), "its one command is verify") {
		t.Errorf("an anchors command this build does not have = %v", err)
	}
}

// The command is the contract's: its precondition word for word, its region, its page, and the two
// routes it calls, which are the runner door's maintenance routes.
func TestWikiAnchorsVerifyIsTheContracts(t *testing.T) {
	verify := wikiContract(t)["anchorRules"].(map[string]interface{})["verify"].(map[string]interface{})
	if verify["precondition"] != wikiAnchorsVerifyPrecondition {
		t.Errorf("the precondition drifted from the contract:\n  contract: %v\n  command:  %s", verify["precondition"], wikiAnchorsVerifyPrecondition)
	}
	if !strings.HasPrefix(wikiAnchorsVerifyDescription, wikiAnchorsVerifyPrecondition) {
		t.Error("the description does not lead with the precondition")
	}
	if !strings.Contains(wikiActionHelp["anchors"], wikiAnchorsVerifyPrecondition) {
		t.Error("the help does not carry the precondition")
	}
	rules := verify["rules"].(map[string]interface{})
	if rules["symbolRegionLines"] != float64(wikiAnchorSymbolRegionLines) || rules["reportEntriesMax"] != float64(wikiAnchorPageEntries) {
		t.Errorf("rules = %v, this build uses a region of %d lines and pages of %d", rules, wikiAnchorSymbolRegionLines, wikiAnchorPageEntries)
	}
	if verify["cli"] != "orbit wiki anchors verify --space <id> [--repo <path>] [--json]" {
		t.Errorf("the contract's usage is %v", verify["cli"])
	}
	for _, spec := range wikiCLICapabilities {
		if spec.Tool == "wiki_anchors_verify" && spec.Usage != verify["cli"] {
			t.Errorf("the capability's usage %q is not the contract's %v", spec.Usage, verify["cli"])
		}
	}

	f := newWikiAnchorsFixture(t)
	requests := wikiAnchorsDoor(t, func(string) (int, string) {
		return http.StatusOK, anchorsListReply(f.checkout, "", `{"entryId":"e1","revision":1,"anchors":[{"index":0,"type":"path","path":"docs/a.md"}]}`)
	}, recordEveryEntry)
	if err := cmdWikiCLI([]string{"anchors", "verify", "--space", "space-1"}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatalf("orbit wiki anchors verify: %v", err)
	}
	called := []string{}
	for _, sent := range requests() {
		called = append(called, sent.method+" "+strings.Replace(sent.path, "/spaces/space-1/", "/spaces/:id/", 1))
		if sent.method == http.MethodGet && sent.query.Get("limit") != strconv.Itoa(wikiAnchorPageEntries) {
			t.Errorf("the list was asked for pages of %q, want %d", sent.query.Get("limit"), wikiAnchorPageEntries)
		}
	}
	want := []string{
		verify["list"].(map[string]interface{})["route"].(string),
		verify["report"].(map[string]interface{})["route"].(string),
	}
	if !reflect.DeepEqual(called, want) {
		t.Fatalf("the command called %v, the contract's routes are %v", called, want)
	}
	listed := map[string]bool{}
	for _, route := range wikiSurface(t)["doors"].(map[string]interface{})["runner"].(map[string]interface{})["maintenanceRoutes"].([]interface{}) {
		listed[route.(string)] = true
	}
	for _, route := range called {
		if !listed[route] {
			t.Errorf("%s is not one of the runner door's maintenance routes", route)
		}
	}
}
