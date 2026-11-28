package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestWriteMainCheckoutWebFixtures writes the two answers the web's Main checkout bar is drawn from, read by the real
// runner code from a real repository: develop, 21 commits ahead of its upstream and 3 files uncommitted. Set
// ORBIT_MAIN_CHECKOUT_FIXTURES_DIR to write them (plain.json: the snapshot read; commit.json: a read of the newest
// commit's first file); they are the runner's side of src/web/src/components/fixtures/main-checkout-*.json.
func TestWriteMainCheckoutWebFixtures(t *testing.T) {
	dir := os.Getenv("ORBIT_MAIN_CHECKOUT_FIXTURES_DIR")
	if dir == "" {
		t.Skip("ORBIT_MAIN_CHECKOUT_FIXTURES_DIR not set")
	}
	repo := trackingRepo(t)
	mustGit(t, repo, "branch", "-m", "develop")
	mustGit(t, repo, "push", "-q", "-u", "origin", "develop")
	for i := 21; i >= 1; i-- {
		mcWrite(t, repo, "src/web/src/index.css", strings.Repeat("a { color: red; }\n", i)+"/* v"+fmt.Sprint(22-i)+" */\n")
		mcWrite(t, repo, "src/web/src/pages/SettingsLayout.tsx", fmt.Sprintf("export const rev = %d;\n", 22-i))
		mustGit(t, repo, "add", "-A")
		// Each commit a few minutes older than the next, as a working day's are.
		when := time.Now().Add(-time.Duration(i*7+11) * time.Minute).UTC().Format(time.RFC3339)
		t.Setenv("GIT_COMMITTER_DATE", when)
		t.Setenv("GIT_AUTHOR_DATE", when)
		subject := fmt.Sprintf("fix(web): change %d of 21", 22-i)
		if i == 1 {
			subject = "fix(web): Settings and Admin nav take the sidebar's width, so the page panel doesn't jump"
			mustGit(t, repo, "commit", "-q", "-m", subject, "-m", "Opening Settings swapped the sidebar for a narrower nav, so the page panel moved 24 px left and back. Both navs now use the sidebar's stored width.")
		} else {
			mustGit(t, repo, "commit", "-q", "-m", subject)
		}
	}
	mcWrite(t, repo, "src/web/src/index.css", "uncommitted\n")
	mcWrite(t, repo, "src/web/src/pages/SettingsLayout.tsx", "uncommitted\n")
	mcWrite(t, repo, "notes.md", "new file\n")

	plain := readCommit(repo, "")
	if plain.Snapshot == nil || len(plain.Snapshot.Commits) != 20 || !plain.Snapshot.CommitsTruncated || plain.Snapshot.Ahead == nil || *plain.Snapshot.Ahead != 21 {
		t.Fatalf("plain read: %+v", plain.Snapshot)
	}
	head := plain.Snapshot.Commits[0]
	commit := readCommit(repo, head.Sha, head.Files[0].Path)
	if commit.Error != "" || len(commit.Diffs) != 1 {
		t.Fatalf("commit read: %+v", commit)
	}
	for name, v := range map[string]any{"plain.json": plain, "commit.json": commit} {
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
