//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// holdTestSecret makes this process a runner holding value as an ENV grant, until the test ends.
func holdTestSecret(t *testing.T, value string) {
	t.Helper()
	// Whatever a held value makes the runner write (secret_taint.go) goes to this test's own Orbit directory.
	t.Setenv("ORBIT_HOME", t.TempDir())
	store := newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
	store.held["g"] = &heldSecret{id: "g", exposure: secretExposureEnv, name: "K_KEY", value: secretValue(value), fetched: true, acked: true, revoked: make(chan struct{})}
	store.rebuildScrubLocked()
	runnerSecretStore.Store(store)
	t.Cleanup(func() { runnerSecretStore.Store(nil) })
	secretWarned.Range(func(key, _ interface{}) bool { secretWarned.Delete(key); return true })
}

// OPEN 1: a completion's and a finalize's text, and their patches, carry no held value on the wire.
func TestTurnCompleteAndFinalizeCarryNoSecretOnTheWire(t *testing.T) {
	holdTestSecret(t, testSecretValue)
	var mu sync.Mutex
	bodies := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies[r.URL.Path] = string(data)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true,"status":"AWAITING_INPUT","keepCheckout":true}`))
	}))
	defer srv.Close()
	tr := NewTransport(srv.URL, "tok")
	shell := "printed " + testSecretValue
	patches := []FilePatch{{Path: "leak.env", Patch: "+KEY=" + testSecretValue}, {Path: "ok.txt", Patch: "+fine"}}
	if _, err := tr.turnComplete(context.Background(), "s1", TurnCompleteRequest{
		TurnID: "t1", Status: stFailed, Result: "said " + testSecretValue, Error: "failed with " + testSecretValue,
		ShellOutput: &shell, ChangedDiff: patches,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.finalizeRun(context.Background(), "s1", RunFinalizeRequest{
		Status: stFailed, Error: "boom " + testSecretValue, CaptureError: testSecretValue, ChangedDiff: patches,
	}); err != nil {
		t.Fatal(err)
	}
	for path, body := range bodies {
		if strings.Contains(body, testSecretValue) {
			t.Fatalf("%s carried the value: %s", path, body)
		}
		if strings.Contains(body, "leak.env") || !strings.Contains(body, "ok.txt") {
			t.Fatalf("%s patches: %s", path, body)
		}
	}
	if !strings.Contains(bodies["/api/runner/sessions/s1/turn-complete"], "failed with [redacted]") {
		t.Fatalf("turn-complete = %s", bodies["/api/runner/sessions/s1/turn-complete"])
	}
	// What is journaled is what completeTurn hands the journal: the scrubbed request.
	kept, _ := json.Marshal(scrubTurnComplete(TurnCompleteRequest{TurnID: "t2", Result: testSecretValue, ShellOutput: &shell}, "s1"))
	if strings.Contains(string(kept), testSecretValue) {
		t.Fatalf("the journaled completion carries the value: %s", kept)
	}
}

// OPEN 2: a value the agent committed itself is left out of the live diff's and the finalize's patches.
func TestCommittedSecretIsLeftOutOfLiveDiffAndFinalizePatches(t *testing.T) {
	wt := sessionWorktree(t, "sSecretPatch")
	holdTestSecret(t, testSecretValue)
	var events []map[string]interface{}
	defer registerSecretWarnings(wt.Session, func(_ string, payload map[string]interface{}) { events = append(events, payload) })()
	commitFile(t, wt.Path, "leak.env", "KEY="+testSecretValue+"\n", "add key")
	commitFile(t, wt.Path, "ok.txt", "fine\n", "add ok")

	_, patches := liveDiff(wt)
	paths := func(ps []FilePatch) string {
		var out []string
		for _, p := range ps {
			out = append(out, p.Path)
			if strings.Contains(p.Patch, testSecretValue) {
				t.Fatalf("a patch carries the value: %q", p.Patch)
			}
		}
		return strings.Join(out, ",")
	}
	if got := paths(patches); strings.Contains(got, "leak.env") || !strings.Contains(got, "ok.txt") {
		t.Fatalf("live diff patches = %s", got)
	}
	_, finalPatches, err := finalizeWorktree(wt, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(finalPatches); strings.Contains(got, "leak.env") || !strings.Contains(got, "ok.txt") {
		t.Fatalf("finalize patches = %s", got)
	}
	if len(events) != 1 || events[0]["subtype"] != "secret_patch_withheld" || events[0]["path"] != "leak.env" {
		t.Fatalf("events = %#v", events)
	}
}

// OPEN 2: a branch whose commits added a value is not merged, even after a later commit removed it.
func TestMergeRefusesABranchWhoseHistoryHoldsASecret(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	mainBefore := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/leak")
	commitFile(t, repo, "config.env", "KEY="+testSecretValue+"\n", "add key")
	commitFile(t, repo, "config.env", "KEY=\n", "remove key")
	mustGit(t, repo, "checkout", "main")
	holdTestSecret(t, testSecretValue)

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/leak", BaseSha: mainBefore})
	if out.Status != "error" || !strings.Contains(out.Message, "config.env") || !strings.Contains(out.Message, "history") ||
		strings.Contains(out.Message, testSecretValue) {
		t.Fatalf("merge = %+v", out)
	}
	if mustGit(t, repo, "rev-parse", "main") != mainBefore {
		t.Fatal("main moved")
	}

	// A branch without the value merges as before.
	mustGit(t, repo, "checkout", "-b", "orbit/clean", mainBefore)
	commitFile(t, repo, "ok.txt", "fine\n", "ok")
	mustGit(t, repo, "checkout", "main")
	r := runnerSecrets().scrubber()
	if paths, err := secretHistoryScan(repo, "refs/heads/orbit/clean", r, "refs/heads/main"); err != nil || len(paths) != 0 {
		t.Fatalf("a clean branch reads as holding a value: %v %v", paths, err)
	}
	if paths, err := secretHistoryScan(repo, "refs/heads/orbit/leak", r, "refs/heads/main"); err != nil || strings.Join(paths, ",") != "config.env" {
		t.Fatalf("paths = %v %v", paths, err)
	}
}

// Review 2, OPEN 1: the blob scan sees what `git log -p` does not print — a value only in a merge commit's own
// content, in a binary file, with diff.noprefix set — and refuses when it cannot run.
func TestSecretHistoryScanSeesMergesBinariesAndNoprefix(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	mustGit(t, repo, "config", "diff.noprefix", "true")
	main := mustGit(t, repo, "rev-parse", "main")
	holdTestSecret(t, testSecretValue)
	r := runnerSecrets().scrubber()

	// A value introduced only by a merge commit's resolution.
	mustGit(t, repo, "checkout", "-q", "-b", "side")
	commitFile(t, repo, "side.txt", "side\n", "side")
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/merge", main)
	commitFile(t, repo, "own.txt", "own\n", "own")
	mustGit(t, repo, "merge", "--no-ff", "--no-commit", "side")
	if err := os.WriteFile(filepath.Join(repo, "side.txt"), []byte("side "+testSecretValue+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "merge side")
	if paths, err := secretHistoryScan(repo, "refs/heads/orbit/merge", r, "refs/heads/main"); err != nil || strings.Join(paths, ",") != "side.txt" {
		t.Fatalf("merge commit: %v %v", paths, err)
	}

	// A binary file.
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/binary", main)
	if err := os.WriteFile(filepath.Join(repo, "blob.bin"), append([]byte{0, 1, 2, 0}, []byte(testSecretValue)...), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "binary")
	if refusal := secretPushRefusal(repo, "refs/heads/orbit/binary", "refs/heads/main"); !strings.Contains(refusal, "blob.bin") {
		t.Fatalf("binary: %q", refusal)
	}

	// A scan that cannot run refuses.
	if refusal := secretPushRefusal(repo, "0123456789012345678901234567890123456789", "refs/heads/main"); !strings.Contains(refusal, "could not check") {
		t.Fatalf("failed scan: %q", refusal)
	}
	mustGit(t, repo, "checkout", "-q", "main")
}

// Review 2, OPEN 2: a commit recorded while the value was known is refused after the grant is gone, and a branch
// whose history was rewritten without it is not.
func TestTaintedCommitIsRefusedAfterTheGrantEnds(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	main := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/leak")
	commitFile(t, repo, "config.env", "KEY="+testSecretValue+"\n", "add key")
	commitFile(t, repo, "more.txt", "more\n", "more")
	mustGit(t, repo, "checkout", "-q", "main")

	// While the value is known: the store removing the grant records the commit first.
	store := newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
	store.held["g"] = &heldSecret{id: "g", exposure: secretExposureEnv, name: "K_KEY", value: secretValue(testSecretValue), revoked: make(chan struct{})}
	store.rebuildScrubLocked()
	old := secretBeforeForget
	secretBeforeForget = func(r *integrationOutputRedactor) { recordSecretTaint(repo, "refs/heads/orbit/leak", r, main) }
	defer func() { secretBeforeForget = old }()
	store.remove("g")

	raw, _ := os.ReadFile(secretTaintPath())
	if strings.Contains(string(raw), testSecretValue) || !strings.Contains(string(raw), "config.env") {
		t.Fatalf("taint record: %s", raw)
	}
	if info, _ := os.Stat(secretTaintPath()); info.Mode().Perm() != 0o600 {
		t.Fatalf("taint mode %v", info.Mode())
	}

	// No grant held any more.
	if runnerSecrets() != nil {
		t.Fatal("fixture: a store is installed")
	}
	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/leak", BaseSha: main})
	if out.Status != "error" || !strings.Contains(out.Message, "config.env") {
		t.Fatalf("merge after the grant ended = %+v", out)
	}
	if mustGit(t, repo, "rev-parse", "main") != main {
		t.Fatal("main moved")
	}
	// A descendant is refused too; the history rewritten without the commit is not.
	mustGit(t, repo, "checkout", "-q", "orbit/leak")
	commitFile(t, repo, "later.txt", "later\n", "later")
	if refusal := secretPushRefusal(repo, "refs/heads/orbit/leak", "refs/heads/main"); refusal == "" {
		t.Fatal("a descendant of the recorded commit was allowed")
	}
	mustGit(t, repo, "checkout", "-q", "-B", "orbit/leak", main)
	commitFile(t, repo, "clean.txt", "clean\n", "clean")
	mustGit(t, repo, "checkout", "-q", "main")
	if refusal := secretPushRefusal(repo, "refs/heads/orbit/leak", "refs/heads/main"); refusal != "" {
		t.Fatalf("rewritten branch refused: %q", refusal)
	}
}

// Review 2, OPEN 2: the end of a turn records the session's own commits while the grant is live.
func TestTurnEndRecordsACommittedSecret(t *testing.T) {
	wt := sessionWorktree(t, "sSecretTaint")
	holdTestSecret(t, testSecretValue)
	commitFile(t, wt.Path, "leak.env", "KEY="+testSecretValue+"\n", "add key")
	liveDiff(wt)
	runnerSecretStore.Store(nil)
	if paths := taintedPaths(wt.Path, "HEAD", wt.baseSha()); strings.Join(paths, ",") != "leak.env" {
		t.Fatalf("tainted = %v", paths)
	}
}

// Review 2, OPEN 3: no upload door sends a file holding a value, the worktree artifact door included.
func TestUploadDoorsRefuseAFileHoldingASecret(t *testing.T) {
	holdTestSecret(t, testSecretValue)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a file holding a value was uploaded to %s", r.URL.Path)
	}))
	defer srv.Close()
	tr := NewTransport(srv.URL, "tok")
	path := filepath.Join(t.TempDir(), "leak.log")
	if err := os.WriteFile(path, []byte("log "+testSecretValue), 0o644); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := tr.uploadSessionAttachmentFile(context.Background(), "s1", file, "text/plain", "leak.log"); !errors.Is(err, errFileHoldsOwnerSecret) {
		t.Fatalf("attachment upload: %v", err)
	}
	if _, err := tr.uploadFile(context.Background(), "s1", file, "leak.log", "text/plain", nil); !errors.Is(err, errFileHoldsOwnerSecret) {
		t.Fatalf("file upload: %v", err)
	}
}

func TestIntegrationOutputRedactorIncludesHeldSecrets(t *testing.T) {
	holdTestSecret(t, testSecretValue)
	r := newIntegrationOutputRedactor()
	if out := r.redact("check printed " + testSecretValue); strings.Contains(out, testSecretValue) {
		t.Fatalf("integration output kept the value: %q", out)
	}
}

func TestMergeRecoveryPreviewRefusesACandidateHoldingASecret(t *testing.T) {
	repo, _, req := recoveryFixture(t)
	mustGit(t, repo, "checkout", "-q", req.Branch)
	commitFile(t, repo, "leak.env", "KEY="+testSecretValue+"\n", "add key")
	mustGit(t, repo, "checkout", "-q", "main")
	holdTestSecret(t, testSecretValue)
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Patch != "" || strings.Contains(sprintAll(out), testSecretValue) ||
		!strings.Contains(sprintAll(out), "leak.env") {
		t.Fatalf("preview = %+v", out)
	}
}
