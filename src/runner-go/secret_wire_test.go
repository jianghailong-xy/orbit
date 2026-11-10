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
	secretBeforeForget = func(r *integrationOutputRedactor) error {
		return recordSecretTaint(repo, "refs/heads/orbit/leak", r, main)
	}
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

// Review 3, OPEN 1: merge recovery publishes the local target's unpublished commits, so they are scanned too.
func TestMergeRecoveryScansTheLocalTargetItPublishes(t *testing.T) {
	repo, _, req := recoveryFixture(t)
	// An unpublished commit of the local target, which the candidate is built on.
	commitFile(t, repo, "local-leak.env", "KEY="+testSecretValue+"\n", "local key")
	holdTestSecret(t, testSecretValue)
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Patch != "" || !strings.Contains(sprintAll(out), "local-leak.env") {
		t.Fatalf("preview = %+v", out)
	}
}

// Review 3, OPEN 2: a rewritten copy of a recorded commit (here a cherry-pick, as a rebase or a squash makes) is
// refused after the grant has ended: it carries the same blob.
func TestRewrittenCopyOfATaintedCommitIsRefused(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	main := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/leak")
	commitFile(t, repo, "config.env", "KEY="+testSecretValue+"\n", "add key")
	leak := mustGit(t, repo, "rev-parse", "HEAD")
	recordSecretTaint(repo, "HEAD", newSecretRedactor([]string{testSecretValue}), main)

	raw, _ := os.ReadFile(secretTaintPath())
	if strings.Contains(string(raw), testSecretValue) || !strings.Contains(string(raw), `"objects"`) {
		t.Fatalf("taint record: %s", raw)
	}
	// The original branch is rewritten away; a copy lands elsewhere with a new commit id.
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/copy", main)
	commitFile(t, repo, "other.txt", "other\n", "other")
	mustGit(t, repo, "cherry-pick", leak)
	mustGit(t, repo, "branch", "-f", "orbit/leak", main)
	mustGit(t, repo, "checkout", "-q", "main")
	if gitIsAncestor(repo, leak, "refs/heads/orbit/copy") {
		t.Fatal("fixture: the copy contains the original commit")
	}
	if runnerSecrets() != nil {
		t.Fatal("fixture: a grant is held")
	}
	if refusal := secretPushRefusal(repo, "refs/heads/orbit/copy", "refs/heads/main"); !strings.Contains(refusal, "config.env") {
		t.Fatalf("rewritten copy: %q", refusal)
	}
	// Recording again in the same repository keeps the entry: its commit is off every branch, its blob is not.
	recordSecretTaint(repo, "refs/heads/main", newSecretRedactor([]string{testSecretValue}))
	if refusal := secretPushRefusal(repo, "refs/heads/orbit/copy", "refs/heads/main"); refusal == "" {
		t.Fatal("the entry was pruned while its blob is still on a branch")
	}
	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/copy", BaseSha: main})
	if out.Status != "error" || !strings.Contains(out.Message, "config.env") {
		t.Fatalf("merge of the copy = %+v", out)
	}
}

// fakeCommitMsgEngine is a claude that records its argv and stdin and writes a message.
func fakeCommitMsgEngine(t *testing.T) (argv, stdin func() string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "claude")
	body := "#!/bin/sh\nprintf '%s' \"$*\" > '" + dir + "/argv'\ncat > '" + dir + "/stdin'\necho 'feat: from the engine'\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	old := commitMsgEngine
	commitMsgEngine = script
	t.Cleanup(func() { commitMsgEngine = old })
	read := func(name string) func() string {
		return func() string { data, _ := os.ReadFile(filepath.Join(dir, name)); return string(data) }
	}
	return read("argv"), read("stdin")
}

// Review 3, OPEN 3: the diff goes to the model on stdin, never in argv; not at all when either side of it holds a value,
// or when the repository has a recorded commit holding one.
func TestCommitMessageNeverSendsASecretToTheModel(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	argv, stdin := fakeCommitMsgEngine(t)
	const fallback = "Update files"

	if err := os.WriteFile(filepath.Join(repo, "ok.txt"), []byte("ordinary change\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "-A")
	if got := generateCommitMessage(repo, fallback); got != "feat: from the engine" {
		t.Fatalf("clean diff: %q", got)
	}
	if strings.Contains(argv(), "ordinary change") || !strings.Contains(stdin(), "ordinary change") {
		t.Fatalf("argv %q, stdin %q", argv(), stdin())
	}
	mustGit(t, repo, "commit", "-q", "-m", "ok")

	// A value on the removed side only.
	commitFile(t, repo, "config.env", "KEY="+testSecretValue+"\n", "key")
	if err := os.WriteFile(filepath.Join(repo, "config.env"), []byte("KEY=\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "-A")
	holdTestSecret(t, testSecretValue)
	before := stdin()
	if got := generateCommitMessage(repo, fallback); got != fallback {
		t.Fatalf("a diff removing a value: %q", got)
	}
	if stdin() != before {
		t.Fatal("the engine was started for a diff holding a value")
	}

	// No grant held, but the repository has a recorded commit holding one.
	recordSecretTaint(repo, "HEAD", newSecretRedactor([]string{testSecretValue}), "HEAD~1")
	runnerSecretStore.Store(nil)
	if got := generateCommitMessage(repo, fallback); got != fallback {
		t.Fatalf("a tainted repository: %q", got)
	}
	if stdin() != before {
		t.Fatal("the engine was started for a tainted repository")
	}
}

// Review 4, OPEN A: a replay that rewrites the value-holding file (new blob, new commit) is refused once the grant has
// ended, at preview and at apply: the source it was replayed from is guarded too.
func TestMergeRecoveryGuardsTheSourceItReplays(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	commitFile(t, repo, "leak.env", "a\n1\n2\n3\n4\nb\n", "leak.env")
	bare := addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/feat")
	commitFile(t, repo, "leak.env", "a\n1\n2\n3\n4\nKEY="+testSecretValue+"\n", "key")
	mustGit(t, repo, "checkout", "-q", "main")
	// Upstream edits the same file, so the replayed blob differs from the source's.
	advanceOriginMain(t, repo, "leak.env", "A\n1\n2\n3\n4\nb\n")
	commitFile(t, repo, "local.txt", "local\n", "local work")
	req := MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "recovery", BaseSha: base, RecoveryAction: "preview"}

	ready := mergeToMain(req)
	if ready.Recovery == nil || ready.Recovery.Code != "READY" {
		t.Fatalf("fixture preview: %+v", ready)
	}
	if candidateBlob := mustGit(t, repo, "rev-parse", ready.Recovery.CandidateSha+":leak.env"); candidateBlob == mustGit(t, repo, "rev-parse", "orbit/feat:leak.env") {
		t.Fatal("fixture: the replay kept the source's blob")
	}
	// Recorded while the grant was held; the grant has ended since.
	recordSecretTaint(repo, "refs/heads/orbit/feat", newSecretRedactor([]string{testSecretValue}), base)
	if runnerSecrets() != nil {
		t.Fatal("fixture: a grant is held")
	}
	preview := mergeToMain(req)
	if preview.Recovery == nil || preview.Recovery.Patch != "" || !strings.Contains(sprintAll(preview), "leak.env") {
		t.Fatalf("preview = %+v", preview)
	}
	remote := mustGit(t, bare, "rev-parse", "main")
	req.RecoveryAction, req.Recovery = "apply", ready.Recovery
	applied := mergeToMain(req)
	if applied.Status == "merged" || !strings.Contains(sprintAll(applied), "leak.env") || mustGit(t, bare, "rev-parse", "main") != remote {
		t.Fatalf("apply = %+v", applied)
	}
}

// Review 4, OPEN B: a file held back from a commit while the grant was live stays held back after it has ended: it is
// unstaged again, left out of the diff and the commit message, and its blob refuses a merge or push.
func TestHeldBackFileStaysHeldBackAfterTheGrantEnds(t *testing.T) {
	wt := sessionWorktree(t, "sHeldBack")
	holdTestSecret(t, testSecretValue)
	argv, stdin := fakeCommitMsgEngine(t)
	var events []map[string]interface{}
	defer registerSecretWarnings(wt.Session, func(_ string, payload map[string]interface{}) { events = append(events, payload) })()
	if err := os.WriteFile(filepath.Join(wt.Path, "notes.env"), []byte("KEY="+testSecretValue+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	listed := func(files []ChangedFile) string {
		var out []string
		for _, f := range files {
			out = append(out, f.Path)
		}
		return strings.Join(out, ",")
	}
	// The turn end while the grant is held.
	if files, _ := liveDiff(wt); strings.Contains(listed(files), "notes.env") {
		t.Fatalf("held: %s", listed(files))
	}

	// The grant ends.
	runnerSecretStore.Store(nil)
	secretWarned.Range(func(key, _ interface{}) bool { secretWarned.Delete(key); return true })
	events = nil

	// The next turn end.
	files, patches := liveDiff(wt)
	if strings.Contains(listed(files), "notes.env") {
		t.Fatalf("after: %s", listed(files))
	}
	for _, p := range patches {
		if p.Path == "notes.env" || strings.Contains(p.Patch, testSecretValue) {
			t.Fatalf("a patch for the held-back file: %+v", p)
		}
	}
	mustGit(t, wt.Path, "add", "-A")
	unstageHeldSecrets(wt.Path, nil, wt.Session)
	if staged := mustGit(t, wt.Path, "diff", "--cached", "--name-only"); strings.Contains(staged, "notes.env") {
		t.Fatalf("staged after the grant ended: %q", staged)
	}
	if len(events) == 0 {
		t.Fatal("no warning after the grant ended")
	}
	if got := generateCommitMessage(wt.Path, "fallback"); got != "fallback" || argv() != "" || stdin() != "" {
		t.Fatalf("commit message %q, argv %q, stdin %q", got, argv(), stdin())
	}

	// The agent commits it itself, around Orbit: its diff is withheld and its branch is not merged or pushed.
	mustGit(t, wt.Path, "add", "-A")
	mustGit(t, wt.Path, "commit", "-q", "-m", "notes")
	_, patches = liveDiff(wt)
	for _, p := range patches {
		if p.Path == "notes.env" {
			t.Fatalf("a patch for the committed file: %+v", p)
		}
	}
	if refusal := secretPushRefusal(wt.Path, "HEAD", wt.baseSha()); !strings.Contains(refusal, "notes.env") {
		t.Fatalf("push guard: %q", refusal)
	}
	out := mergeToMain(MergeCommand{WorkDir: wt.RepoDir, Branch: wt.Branch, SessionID: wt.Session, BaseSha: wt.baseSha()})
	if out.Status != "error" || !strings.Contains(out.Message, "notes.env") {
		t.Fatalf("merge = %+v", out)
	}
}

// Review 4, OPEN B: removal records the blob ids of uncommitted files that hold the value, before it is forgotten.
func TestRemovalRecordsUncommittedFilesHoldingTheValue(t *testing.T) {
	home := secretTestHome(t)
	_ = home
	dir := filepath.Join(worktreesDir(), "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, dir, "init", "-q", "-b", "main")
	mustGit(t, dir, "config", "user.email", "t@orbit")
	mustGit(t, dir, "config", "user.name", "T")
	commitFile(t, dir, "base.txt", "base\n", "base")
	if err := os.WriteFile(filepath.Join(dir, "draft.env"), []byte("KEY="+testSecretValue+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := mustGit(t, dir, "hash-object", "draft.env")
	store := newSecretStore(newFakeSecretAPI(), filepath.Join(home, "ledger.json"))
	store.held["g"] = &heldSecret{id: "g", exposure: secretExposureEnv, name: "K_KEY", value: secretValue(testSecretValue), revoked: make(chan struct{})}
	store.rebuildScrubLocked()
	store.remove("g")
	if path, ok := taintObjectIDs(dir)[want]; !ok || path != "draft.env" {
		t.Fatalf("recorded = %v", taintObjectIDs(dir))
	}
	raw, _ := os.ReadFile(secretTaintPath())
	if strings.Contains(string(raw), testSecretValue) {
		t.Fatal("the record holds the value")
	}
}

// Review 5, OPEN 1: a commit recorded for one value stays recorded when it is scanned again while only another value
// is held. A commit never changes; finding nothing in it now means only that the first value is forgotten.
func TestTaintOfACommitSurvivesARescanUnderAnotherValue(t *testing.T) {
	wt := sessionWorktree(t, "sSecretRescan")
	holdTestSecret(t, testSecretValue)
	commitFile(t, wt.Path, "leak.env", "KEY="+testSecretValue+"\n", "add key")
	liveDiff(wt)

	// Grant A has ended; only grant B is held. A turn end scans the same commit with B's value alone.
	other := "sk-other-value-0123456789abcdef"
	storeB := newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
	storeB.held["b"] = &heldSecret{id: "b", exposure: secretExposureEnv, name: "B_KEY", value: secretValue(other), fetched: true, acked: true, revoked: make(chan struct{})}
	storeB.rebuildScrubLocked()
	runnerSecretStore.Store(storeB)
	liveDiff(wt)
	recordSecretTaint(wt.Path, "HEAD", runnerSecrets().scrubber(), wt.baseSha())

	// And then no grant at all.
	runnerSecretStore.Store(nil)
	if paths := taintedPaths(wt.Path, "HEAD", wt.baseSha()); strings.Join(paths, ",") != "leak.env" {
		t.Fatalf("the rescan under another value dropped the record: tainted = %v", paths)
	}
	if refusal := secretPushRefusal(wt.Path, "HEAD", wt.baseSha()); refusal == "" {
		t.Fatal("the branch holding the first value would be pushed")
	}
	raw, _ := os.ReadFile(secretTaintPath())
	if strings.Contains(string(raw), testSecretValue) || strings.Contains(string(raw), other) {
		t.Fatalf("the taint record holds a value: %s", raw)
	}
}

// Review 6, OPEN 1: when the record of what held a value cannot be read, no patch is sent, as no push is.
func TestUnreadableTaintRecordWithholdsEveryPatch(t *testing.T) {
	wt := sessionWorktree(t, "sSecretUnreadable")
	holdTestSecret(t, testSecretValue)
	commitFile(t, wt.Path, "leak.env", "KEY="+testSecretValue+"\n", "add key")
	liveDiff(wt)
	runnerSecretStore.Store(nil)
	if err := os.WriteFile(secretTaintPath(), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	patches := withoutSecretPatches([]FilePatch{{Path: "leak.env", Patch: "+KEY=" + testSecretValue + "\n"}, {Path: "clean.txt", Patch: "+clean\n"}}, "sSecretUnreadable")
	if len(patches) != 0 {
		t.Fatalf("an unreadable record sent patches: %+v", patches)
	}
	if refusal := secretPushRefusal(wt.Path, "HEAD", wt.baseSha()); refusal == "" {
		t.Fatal("an unreadable record allowed a push")
	}
}

// Review 6, note: only git's own "missing" answer prunes; a failure to ask keeps the entry.
func TestTaintEntryIsKeptWhenGitCannotAnswer(t *testing.T) {
	entry := secretTaintEntry{Commit: "1234567890123456789012345678901234567890"}
	if !taintEntryPresent(filepath.Join(t.TempDir(), "not-a-repo"), entry) {
		t.Fatal("an entry was pruned because git could not be asked")
	}
	repo := initRepo(t)
	if taintEntryPresent(repo, entry) {
		t.Fatal("an object git says is missing kept its entry")
	}
}

// Review 7, OPEN 1: a removal whose record cannot be written does not forget what the value was in. Until a retry
// records it, nothing is published from this runner: pushes, patches, uploads and commit-message calls all refuse.
func TestRemovalWhoseRecordFailsKeepsEverythingRefusedUntilItIsWritten(t *testing.T) {
	wt := sessionWorktree(t, "sSecretPending")
	holdTestSecret(t, testSecretValue)
	commitFile(t, wt.Path, "leak.env", "KEY="+testSecretValue+"\n", "add key")
	runnerSecretStore.Store(nil)

	failing := true
	old := secretBeforeForget
	secretBeforeForget = func(r *integrationOutputRedactor) error {
		if failing {
			return errors.New("disk quota exceeded")
		}
		return recordSecretTaint(wt.Path, "HEAD", r, wt.baseSha())
	}
	defer func() {
		secretBeforeForget = old
		secretTaintPending.Lock()
		secretTaintPending.list = nil
		secretTaintPending.Unlock()
	}()
	recordBeforeForget(newSecretRedactor([]string{testSecretValue}))

	if refusal := secretPushRefusal(wt.Path, "HEAD", wt.baseSha()); refusal == "" {
		t.Fatal("a push was allowed while a removal's record was unwritten")
	}
	if patches := withoutSecretPatches([]FilePatch{{Path: "clean.txt", Patch: "+clean\n"}}, "sSecretPending"); len(patches) != 0 {
		t.Fatalf("patches were sent while a removal's record was unwritten: %+v", patches)
	}
	if !taintAppliesTo(wt.Path) {
		t.Fatal("the commit message would go to the model while a removal's record was unwritten")
	}
	clean := filepath.Join(t.TempDir(), "clean.txt")
	if err := os.WriteFile(clean, []byte("nothing secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(clean)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := refuseFileHoldingSecret(f, clean); !errors.Is(err, errFileHoldsOwnerSecret) {
		t.Fatalf("an upload was allowed while a removal's record was unwritten: %v", err)
	}

	// The disk is free again: the retry records the commit, and only what held the value stays refused.
	failing = false
	retryPendingTaint()
	if refusal := secretPushRefusal(wt.Path, "HEAD", wt.baseSha()); refusal == "" {
		t.Fatal("the recorded commit was allowed after the retry")
	}
	if patches := withoutSecretPatches([]FilePatch{{Path: "clean.txt", Patch: "+clean\n"}}, "sSecretPending"); len(patches) != 1 {
		t.Fatalf("a clean patch was still withheld after the retry: %+v", patches)
	}
	if err := refuseFileHoldingSecret(f, clean); err != nil {
		t.Fatalf("a clean upload was refused after the retry: %v", err)
	}
}

// Review 7, OPEN 2: a file held back for holding a value is refused by the upload doors after its grant has gone,
// by its recorded blob id.
func TestUploadRefusesARecordedBlobAfterTheGrantEnds(t *testing.T) {
	wt := sessionWorktree(t, "sSecretUploadAfter")
	holdTestSecret(t, testSecretValue)
	path := filepath.Join(wt.Path, "run.env")
	if err := os.WriteFile(path, []byte("KEY="+testSecretValue+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	liveDiff(wt) // the turn end holds it back and records its blob id
	runnerSecretStore.Store(nil)

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := refuseFileHoldingSecret(f, path); !errors.Is(err, errFileHoldsOwnerSecret) {
		t.Fatalf("the held-back file was uploadable after its grant ended: %v", err)
	}
	if b, _ := io.ReadAll(f); !strings.Contains(string(b), "KEY=") {
		t.Fatal("the handle was not left at the start")
	}
}
