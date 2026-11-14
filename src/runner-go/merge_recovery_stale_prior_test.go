package main

import (
	"slices"
	"testing"
)

// The 2026-11-13 incident. A repair session committed the TARGET_SYNC merge; the check after its turn
// merged the moved origin in and replayed the session's three commits onto it. That same check was
// then run again, 9 seconds later, with the record the first one had been handed: a TARGET_SYNC
// conflict naming no rebase base. The repair was carried, nothing was left to merge, and the source
// was replayed onto its own replay — its first commit added a file the copies had already changed, an
// add/add conflict no resolution is owed for.
//
// The second check must answer what the first did: the same candidate, the same rebase base, no
// conflict.
func TestRecoveryCheckWithStalePriorKeepsTheFinishedReplay(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GIT_EDITOR", "true")
	f := &carryFixture{repo: initRepo(t)}
	commitFiles(t, f.repo, "shared files", map[string]string{"shared.txt": "base\n"})
	f.bare = addOriginBare(t, f.repo)
	f.base = mustGit(t, f.repo, "rev-parse", "main")
	// The session writes a file, then changes it twice: replayed onto a branch that already has its
	// last version, the first commit conflicts with it.
	mustGit(t, f.repo, "checkout", "-b", "orbit/feat")
	commitFile(t, f.repo, "design.md", "one\n", "design")
	commitFile(t, f.repo, "design.md", "one\ntwo\n", "record decisions")
	commitFile(t, f.repo, "design.md", "one\ntwo\nthree\n", "cross-workspace runs")
	mustGit(t, f.repo, "checkout", "main")
	f.landOnOrigin(t, "upstream edits", map[string]string{"shared.txt": "remote\n"})
	commitFiles(t, f.repo, "local edits", map[string]string{"shared.txt": "local\n"})
	f.req = MergeCommand{WorkDir: f.repo, Branch: "orbit/feat", SessionID: "stale", BaseSha: f.base, RecoveryAction: "preview"}

	conflict := mergeToMain(f.req).Recovery
	if conflict == nil || conflict.Code != "CONFLICT" || conflict.Phase != "TARGET_SYNC" || conflict.RebaseBaseSha != "" {
		t.Fatalf("want a TARGET_SYNC conflict with no rebase base, got %+v", conflict)
	}
	f.repair(t, conflict, map[string]string{"shared.txt": "resolved\n"})
	// Origin moves on before the check after the repair turn, as it did (f82c91522).
	f.landOnOrigin(t, "more upstream", map[string]string{"upstream.txt": "more\n"})

	first := f.check(t, conflict)
	if first.Code != "READY" || first.Phase != "SOURCE_REPLAY" || first.RebaseBaseSha == "" {
		t.Fatalf("the check after the repair: want READY after a SOURCE_REPLAY, got code=%s phase=%s conflicts=%v", first.Code, first.Phase, first.Conflicts)
	}

	// The same check again, handed the record from before the first one's answer was stored.
	second := f.check(t, conflict)
	if second.Code != "READY" || len(second.Conflicts) > 0 {
		t.Fatalf("the check with the stale record replayed the source onto its own replay: code=%s phase=%s conflicts=%v", second.Code, second.Phase, second.Conflicts)
	}
	if second.CandidateSha != first.CandidateSha || second.RebaseBaseSha != first.RebaseBaseSha || second.RepairBranch != first.RepairBranch {
		t.Fatalf("want the first check's candidate %s on base %s, got %s on base %s", first.CandidateSha, first.RebaseBaseSha, second.CandidateSha, second.RebaseBaseSha)
	}
	if !slices.Equal(second.PushCommits, first.PushCommits) {
		t.Fatalf("the push lists differ: %+v vs %+v", first.PushCommits, second.PushCommits)
	}
	// And the candidate is what an apply accepts: its rebase base is on it.
	if !targetContainsSource(f.repo, second.RebaseBaseSha, second.CandidateSha) {
		t.Fatalf("rebase base %s is not on candidate %s", second.RebaseBaseSha, second.CandidateSha)
	}
}
