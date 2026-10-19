package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The snapshot index the server's plan code is held to (src/apiserver/src/wiki-worker/wiki-plan-golden.spec.ts
// reads src/shared/src/wiki-plan.fixture.json): the fixture's `index` is what the runner's snapshot operation
// (wikiRepoOpSnapshot, wiki-repo-op/v1) builds of a checkout of the fixture's `files`, and this test holds the
// runner to it. The rest of the fixture — the materials, the prompts, the drafts and the gate's conclusions — is
// the server's alone now, written by the Go drafting job before it was removed and frozen since: this test reads
// the fixture and never writes it.

const wikiPlanFixturePath = "../shared/src/wiki-plan.fixture.json"

// wikiPlanFixtureGit runs git with the identity and the clock fixed, so the fixture's commit is the same
// commit every time the checkout is made.
func wikiPlanFixtureGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@orbit", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@orbit",
		"GIT_AUTHOR_DATE=2026-10-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-10-01T00:00:00Z", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func wikiPlanFixtureCheckout(t *testing.T, files map[string]string) (string, string) {
	t.Helper()
	root := t.TempDir()
	wikiPlanFixtureGit(t, root, "init", "-q", "-b", "main")
	for name, content := range files {
		file := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	wikiPlanFixtureGit(t, root, "add", ".")
	wikiPlanFixtureGit(t, root, "commit", "-q", "-m", "first")
	return root, wikiPlanFixtureGit(t, root, "rev-parse", "HEAD")
}

func TestWikiPlanFixtureIndexIsTheRunnersSnapshot(t *testing.T) {
	raw, err := os.ReadFile(wikiPlanFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Files map[string]string `json:"files"`
		Index json.RawMessage   `json:"index"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Files) == 0 || len(fixture.Index) == 0 {
		t.Fatalf("%s has no files or no index to hold the snapshot to", wikiPlanFixturePath)
	}
	root, head := wikiPlanFixtureCheckout(t, fixture.Files)
	outcome := wikiRepoOpSnapshot(WikiRepoOpCommand{}, root, head, wikiRepoOpInput{})
	index, ok := outcome.result["index"].(string)
	if outcome.state != "succeeded" || !ok {
		t.Fatalf("the snapshot of the fixture's files: %+v", outcome)
	}
	var want bytes.Buffer
	if err := json.Compact(&want, fixture.Index); err != nil {
		t.Fatal(err)
	}
	if got := []byte(index); !bytes.Equal(got, want.Bytes()) {
		at := 0
		for at < len(got) && at < want.Len() && got[at] == want.Bytes()[at] {
			at++
		}
		from := max(at-80, 0)
		t.Fatalf("the snapshot of the fixture's files is not the fixture's index, from byte %d:\n got …%s\nwant …%s",
			at, got[from:min(at+80, len(got))], want.Bytes()[from:min(at+80, want.Len())])
	}
}
