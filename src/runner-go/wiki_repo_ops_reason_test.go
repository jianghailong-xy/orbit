package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Every failure of the checkout names its reason (contract `repoOps.reasons`, docs/wiki-repo-tiers-design.md §6), so the
// server classifies it by the reason and not by the words: a working directory that is not there, not git, another
// repository's, or a fetch that failed — each with git's own words still in the error beside it.
func TestWikiRepoOpCheckoutFailuresNameTheirReason(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	other := filepath.Join(f.home, "other.git")
	mustGit(t, f.home, "init", "-q", "--bare", "-b", "main", other)
	plain := filepath.Join(f.home, "plain")
	if err := os.MkdirAll(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plain, "notes.md"), []byte("# notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A checkout of the space's repository whose origin is gone: the fetch fails, and nothing refused a credential.
	gone := filepath.Join(f.home, "gone")
	mustGit(t, f.home, "clone", "-q", f.bare, gone)
	moved := f.bare + ".moved"
	if err := os.Rename(f.bare, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(moved, f.bare) })

	for _, c := range []struct {
		name, reason, words string
		change              func(*WikiRepoOpCommand)
	}{
		{"no working directory", wikiRepoReasonNoWorkDir, "names no working directory", func(cmd *WikiRepoOpCommand) { cmd.WorkDir = "  " }},
		{"a directory that is not there", wikiRepoReasonNotFound, "was not found on this machine", func(cmd *WikiRepoOpCommand) { cmd.WorkDir = filepath.Join(f.home, "missing") }},
		{"a folder that is not git", wikiRepoReasonNotGit, "is not a git checkout", func(cmd *WikiRepoOpCommand) { cmd.WorkDir = plain }},
		{"another repository's clone", wikiRepoReasonWrongRepository, "not of the space's repository", func(cmd *WikiRepoOpCommand) { cmd.RepoURLNorm = normalizeWikiRepoURL(other) }},
		{"another first commit", wikiRepoReasonRootMismatch, "does not start from the space's first commit", func(cmd *WikiRepoOpCommand) {
			cmd.RootCommitSha = strings.Repeat("e", 40)
			// The fixture's own origin is moved away below; a read of a commit the checkout has runs no fetch.
			cmd.Kind = "read"
			cmd.Input = map[string]interface{}{"sha": f.first, "items": []map[string]interface{}{{"path": "README.md"}}}
		}},
		{"a fetch that fails", wikiRepoReasonFetchFailed, "could not fetch origin's default branch", func(cmd *WikiRepoOpCommand) { cmd.WorkDir = gone }},
	} {
		t.Run(c.name, func(t *testing.T) {
			cmd := f.command(t, "snapshot", map[string]interface{}{})
			c.change(&cmd)
			outcome := runWikiRepoOp(cmd, nil)
			if outcome.state != "failed" || outcome.reason != c.reason || !strings.Contains(outcome.err, c.words) {
				t.Fatalf("outcome = %s reason %q %q, want failed with reason %q saying %q", outcome.state, outcome.reason, outcome.err, c.reason, c.words)
			}
		})
	}
}

// A fetch the remote refuses the credential for is fetch_refused — the owner's to fix, never tried again — and not the
// network's fetch_failed.
func TestWikiRepoOpFetchTheRemoteRefusesIsFetchRefused(t *testing.T) {
	fx := newCredentialFixture(t, true)
	origin := mustGit(t, fx.work, "remote", "get-url", "origin")
	cmd := WikiRepoOpCommand{
		ID: "op-1", Kind: "snapshot", ClaimGeneration: 1, LeaseOwner: "00000000-0000-0000-0000-0000000000aa",
		WorkDir: fx.work, RepoURLNorm: normalizeWikiRepoURL(origin), RootCommitSha: fx.head, Input: map[string]interface{}{},
	}
	started := time.Now()
	outcome := runWikiRepoOp(cmd, nil)
	if outcome.state != "failed" || outcome.reason != wikiRepoReasonFetchRefused || !strings.Contains(outcome.err, "git authentication failed") {
		t.Fatalf("outcome = %s reason %q %q, want failed with reason fetch_refused", outcome.state, outcome.reason, outcome.err)
	}
	if took := time.Since(started); took > wikiAnchorFetchTimeout {
		t.Fatalf("the refused fetch took %s", took)
	}
}

// The reason travels in the result the control plane is sent, beside the words; a success carries none.
func TestWikiRepoOpResultCarriesTheReason(t *testing.T) {
	fastWikiRepoOpRetry(t)
	var raw map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			t.Errorf("decode result: %v", err)
		}
		_, _ = w.Write([]byte(`{"accepted":true,"state":"failed"}`))
	}))
	t.Cleanup(srv.Close)
	cmd := wikiRepoOpTestCommand()
	cmd.WorkDir = t.TempDir() // a folder that is not git
	runWikiRepoOpAndReport(context.Background(), NewTransport(srv.URL, "tok"), cmd)
	if raw["state"] != "failed" || raw["reason"] != wikiRepoReasonNotGit || !strings.Contains(raw["error"].(string), "is not a git checkout") {
		t.Fatalf("the result sent was %#v, want failed with reason not_git and the words", raw)
	}

	// A body with no reason leaves the key out, as every runner before it sent.
	encoded, err := json.Marshal(WikiRepoOpResultRequest{State: "succeeded"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "reason") {
		t.Fatalf("a result with no reason says %s", encoded)
	}
}
