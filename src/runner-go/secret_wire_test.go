//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// holdTestSecret makes this process a runner holding value as an ENV grant, until the test ends.
func holdTestSecret(t *testing.T, value string) {
	t.Helper()
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
	if paths := secretHistoryPaths(repo, "refs/heads/orbit/clean", "refs/heads/main"); len(paths) != 0 {
		t.Fatalf("a clean branch reads as holding a value: %v", paths)
	}
	if paths := secretHistoryPaths(repo, "refs/heads/orbit/leak", "refs/heads/main"); strings.Join(paths, ",") != "config.env" {
		t.Fatalf("paths = %v", paths)
	}
}
