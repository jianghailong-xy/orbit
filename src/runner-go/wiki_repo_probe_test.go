package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The probe (contract `repoOps.kinds.probe`, docs/wiki-repo-tiers-design.md §7.3) answers the tier a working directory
// would be read on, and nothing else: the four answers the settings form draws, from what the machine already has.
func TestWikiRepoProbeAnswersTheFourTiers(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	plain := filepath.Join(f.home, "plain")
	if err := os.MkdirAll(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plain, "notes.md"), []byte("# notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(f.home, "other.git")
	mustGit(t, f.home, "init", "-q", "--bare", "-b", "main", other)
	otherClone := filepath.Join(f.home, "other")
	mustGit(t, f.home, "clone", "-q", other, otherClone)

	t.Run("a git checkout of the space's repository", func(t *testing.T) {
		outcome := runWikiRepoOp(f.command(t, "probe", nil), nil)
		if outcome.state != "succeeded" || outcome.result["tier"] != "git" || outcome.result["origin"] != normalizeWikiRepoURL(f.bare) {
			t.Fatalf("outcome = %s %v %q, want git of %s", outcome.state, outcome.result, outcome.err, normalizeWikiRepoURL(f.bare))
		}
	})
	t.Run("a folder that is not git", func(t *testing.T) {
		cmd := f.command(t, "probe", nil)
		cmd.WorkDir = plain
		outcome := runWikiRepoOp(cmd, nil)
		if outcome.state != "succeeded" || outcome.result["tier"] != "folder" {
			t.Fatalf("outcome = %s %v %q, want folder", outcome.state, outcome.result, outcome.err)
		}
	})
	t.Run("a directory that is not there", func(t *testing.T) {
		cmd := f.command(t, "probe", nil)
		cmd.WorkDir = filepath.Join(f.home, "missing")
		outcome := runWikiRepoOp(cmd, nil)
		if outcome.state != "failed" || outcome.reason != wikiRepoReasonNotFound || !strings.Contains(outcome.err, "was not found on this machine") {
			t.Fatalf("outcome = %s reason %q %q, want not_found", outcome.state, outcome.reason, outcome.err)
		}
	})
	t.Run("no working directory", func(t *testing.T) {
		cmd := f.command(t, "probe", nil)
		cmd.WorkDir = " "
		if outcome := runWikiRepoOp(cmd, nil); outcome.state != "failed" || outcome.reason != wikiRepoReasonNoWorkDir {
			t.Fatalf("outcome = %s reason %q, want no_work_dir", outcome.state, outcome.reason)
		}
	})
	t.Run("another repository's clone", func(t *testing.T) {
		cmd := f.command(t, "probe", nil)
		cmd.WorkDir = otherClone
		outcome := runWikiRepoOp(cmd, nil)
		// The words name the other origin, which is what the server's sentence quotes (`wikiRepoDetail`).
		want := "is a clone of " + normalizeWikiRepoURL(other) + ", not of the space's repository"
		if outcome.state != "failed" || outcome.reason != wikiRepoReasonWrongRepository || !strings.Contains(outcome.err, want) {
			t.Fatalf("outcome = %s reason %q %q, want wrong_repository saying %q", outcome.state, outcome.reason, outcome.err, want)
		}
	})
	t.Run("another first commit behind the same URL", func(t *testing.T) {
		cmd := f.command(t, "probe", nil)
		cmd.RootCommitSha = strings.Repeat("e", 40)
		if outcome := runWikiRepoOp(cmd, nil); outcome.state != "failed" || outcome.reason != wikiRepoReasonRootMismatch {
			t.Fatalf("outcome = %s reason %q %q, want root_mismatch", outcome.state, outcome.reason, outcome.err)
		}
	})
	t.Run("a local checkout for a space with no address", func(t *testing.T) {
		local := filepath.Join(f.home, "local")
		mustGit(t, f.home, "init", "-q", "-b", "main", local)
		cmd := f.command(t, "probe", nil)
		cmd.WorkDir, cmd.RepoURLNorm, cmd.RootCommitSha = local, "", ""
		// No origin to hold it to and nothing to fetch: it is read as a folder (design §2.1).
		if outcome := runWikiRepoOp(cmd, nil); outcome.state != "succeeded" || outcome.result["tier"] != "folder" {
			t.Fatalf("outcome = %s %v %q, want folder", outcome.state, outcome.result, outcome.err)
		}
	})
}

// The probe fetches nothing: an origin that is gone does not change its answer, where every other operation's checkout
// would fail fetch_failed. It reads no file either — the answer has no snapshot in it.
func TestWikiRepoProbeFetchesNothing(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	before := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/HEAD")
	moved := f.bare + ".moved"
	if err := os.Rename(f.bare, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(moved, f.bare) })
	outcome := runWikiRepoOp(f.command(t, "probe", map[string]interface{}{"allowFolder": true}), nil)
	if outcome.state != "succeeded" || outcome.result["tier"] != "git" {
		t.Fatalf("outcome = %s %v %q, want git without a fetch", outcome.state, outcome.result, outcome.err)
	}
	if outcome.payload != "" || outcome.result["index"] != nil || outcome.result["sha"] != nil {
		t.Fatalf("the probe answered with a snapshot: %v", outcome.result)
	}
	if after := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/HEAD"); after != before {
		t.Fatalf("origin/HEAD moved from %s to %s: the probe fetched", before, after)
	}
}

// The runner says it answers the probe, under the name the server asks for it by.
func TestWikiRepoProbeCapabilityIsDeclared(t *testing.T) {
	if wikiRepoOpProbeCapabilityV1 != "wiki-repo-op-probe/v1" || !contains(strings.Split(runnerCapabilitiesV1, ","), wikiRepoOpProbeCapabilityV1) {
		t.Fatalf("capabilities %q do not declare %q", runnerCapabilitiesV1, wikiRepoOpProbeCapabilityV1)
	}
}
