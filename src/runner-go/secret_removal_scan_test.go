//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// blockedRemovalScan removes grant "g", holding value, from a store whose removal scan records with record but does
// not start recording until release is called: the scan is in flight in between. release is idempotent and also runs
// when the test ends.
func blockedRemovalScan(t *testing.T, value string, record func(r *integrationOutputRedactor) error) (store *secretStore, release func()) {
	t.Helper()
	store = newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
	store.held["g"] = &heldSecret{id: "g", exposure: secretExposureEnv, name: "K_KEY", value: secretValue(value), revoked: make(chan struct{})}
	store.rebuildScrubLocked()
	gate := make(chan struct{})
	started := make(chan struct{})
	old := secretBeforeForget
	secretBeforeForget = func(r *integrationOutputRedactor) error {
		close(started)
		<-gate
		return record(r)
	}
	var once sync.Once
	release = func() { once.Do(func() { close(gate) }) }
	t.Cleanup(func() {
		release()
		store.waitScans()
		secretBeforeForget = old
		secretTaintPending.Lock()
		secretTaintPending.list = nil
		secretTaintPending.running = nil
		secretTaintPending.Unlock()
	})
	store.remove("g", true)
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the removal scan never started")
	}
	if !secretTaintIsPending() {
		t.Fatal("fixture: the removal is not pending while its scan runs")
	}
	return store, release
}

// A merge requested while a grant's removal scan is still running is decided at once from the removed value itself:
// a branch without it merges, a branch holding it is refused for holding it — not refused for a record "that could not
// be written yet" — and it stays refused once the scan has recorded it, with no value known any more.
func TestMergeDuringARemovalScanIsDecidedAndAValueStaysRefusedAfterIt(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	secretWarned.Range(func(key, _ interface{}) bool { secretWarned.Delete(key); return true })
	repo := initRepo(t)
	main := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/leak")
	commitFile(t, repo, "config.env", "KEY="+testSecretValue+"\n", "add key")
	mustGit(t, repo, "checkout", "-q", "-b", "orbit/clean", main)
	commitFile(t, repo, "clean.txt", "clean\n", "clean")
	mustGit(t, repo, "checkout", "-q", "main")

	store, release := blockedRemovalScan(t, testSecretValue, func(r *integrationOutputRedactor) error {
		return recordSecretTaint(repo, "refs/heads/orbit/leak", r, main)
	})

	// In flight: the clean branch merges; the branch holding the removed value is refused for holding it.
	refusal := secretPushRefusal(repo, "refs/heads/orbit/leak", "refs/heads/main")
	if !strings.Contains(refusal, "config.env") || strings.Contains(refusal, "could not be written yet") || strings.Contains(refusal, "could not be read") {
		t.Fatalf("the branch holding the removed value during the scan: %q", refusal)
	}
	if refusal := secretPushRefusal(repo, "refs/heads/orbit/clean", "refs/heads/main"); refusal != "" {
		t.Fatalf("a clean branch was refused during the scan: %q", refusal)
	}
	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/clean", BaseSha: main})
	if out.Status == "error" {
		t.Fatalf("merging a clean branch during the removal scan = %+v", out)
	}
	if mustGit(t, repo, "rev-parse", "main") == main {
		t.Fatal("main did not move for the clean branch")
	}

	// The scan ends and records the commit: the removed value is known to nothing now but the record.
	release()
	store.waitScans()
	if secretTaintIsPending() {
		t.Fatal("the scan left its matcher pending")
	}
	if raw, _ := os.ReadFile(secretTaintPath()); !strings.Contains(string(raw), "config.env") || strings.Contains(string(raw), testSecretValue) {
		t.Fatalf("taint record: %s", raw)
	}
	out = mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/leak", BaseSha: main})
	if out.Status != "error" || !strings.Contains(out.Message, "config.env") {
		t.Fatalf("merging the branch holding the removed value after the scan = %+v", out)
	}
	if refusal := secretPushRefusal(repo, "refs/heads/orbit/leak", "refs/heads/main"); !strings.Contains(refusal, "config.env") {
		t.Fatalf("the branch holding the removed value after the scan: %q", refusal)
	}
}

// A turn ending while a removal scan runs waits a bounded time for it: a scan that ends in time leaves the turn's
// patches in. One that does not is withheld with the pending reason — in the log and in the session's notice, neither
// saying the file holds a value — and the next report, once the scan has ended, carries the patch again.
func TestTurnPatchesDuringARemovalScan(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	secretWarned.Range(func(key, _ interface{}) bool { secretWarned.Delete(key); return true })
	oldWait := secretPatchScanWait
	t.Cleanup(func() { secretPatchScanWait = oldWait })
	clean := []FilePatch{{Path: "clean.txt", Patch: "+clean\n"}}

	t.Run("the scan ends within the wait", func(t *testing.T) {
		store, release := blockedRemovalScan(t, testSecretValue, func(*integrationOutputRedactor) error { return nil })
		secretPatchScanWait = 20 * time.Second
		go func() { time.Sleep(200 * time.Millisecond); release() }()
		if got := withoutSecretPatches(clean, "sScanEnds"); len(got) != 1 {
			t.Fatalf("a turn ending during a scan that then ended lost its patch: %+v", got)
		}
		store.waitScans()
	})

	t.Run("the scan outlasts the wait", func(t *testing.T) {
		store, release := blockedRemovalScan(t, testSecretValue, func(*integrationOutputRedactor) error { return nil })
		secretPatchScanWait = 50 * time.Millisecond
		var mu sync.Mutex
		var notices []map[string]interface{}
		defer registerSecretWarnings("sScanOutlasts", func(_ string, payload map[string]interface{}) {
			mu.Lock()
			notices = append(notices, payload)
			mu.Unlock()
		})()
		var got []FilePatch
		logs := captureLogs(t, func() { got = withoutSecretPatches(clean, "sScanOutlasts") })
		if len(got) != 0 {
			t.Fatalf("a patch was sent while the removal scan ran: %+v", got)
		}
		if strings.Contains(logs, "holds a secret's value") || !strings.Contains(logs, "had its diff withheld: the secret record is pending (a removal scan is running)") {
			t.Fatalf("log for a withhold during the scan: %q", logs)
		}
		mu.Lock()
		if len(notices) != 1 {
			t.Fatalf("notices = %#v", notices)
		}
		notice, _ := notices[0]["notice"].(string)
		mu.Unlock()
		if strings.Contains(notice, "holds the value") || !strings.Contains(notice, "still checking") {
			t.Fatalf("notice for a withhold during the scan: %q", notice)
		}

		release()
		store.waitScans()
		if got := withoutSecretPatches(clean, "sScanOutlasts"); len(got) != 1 {
			t.Fatalf("the next report after the scan lost the patch: %+v", got)
		}
	})
}

// The log line and the notice name the reason a diff was withheld: "holds a secret's value" only when it does, the
// unreadable record otherwise.
func TestSecretFileWarningSaysWhyADiffWasWithheld(t *testing.T) {
	notices := map[string]string{}
	var mu sync.Mutex
	collect := func(session string) func() {
		return registerSecretWarnings(session, func(_ string, payload map[string]interface{}) {
			mu.Lock()
			notices[session], _ = payload["notice"].(string)
			mu.Unlock()
		})
	}

	holdTestSecret(t, testSecretValue)
	defer collect("sRealHit")()
	logs := captureLogs(t, func() {
		withoutSecretPatches([]FilePatch{{Path: "leak.env", Patch: "+KEY=" + testSecretValue + "\n"}}, "sRealHit")
	})
	if !strings.Contains(logs, "holds a secret's value (secret_patch_withheld)") {
		t.Fatalf("log for a real hit: %q", logs)
	}
	if !strings.Contains(notices["sRealHit"], "leak.env holds the value of a secret") {
		t.Fatalf("notice for a real hit: %q", notices["sRealHit"])
	}

	runnerSecretStore.Store(nil)
	if err := os.MkdirAll(filepath.Dir(secretTaintPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secretTaintPath(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer collect("sUnreadable")()
	logs = captureLogs(t, func() {
		withoutSecretPatches([]FilePatch{{Path: "clean.txt", Patch: "+clean\n"}}, "sUnreadable")
	})
	if strings.Contains(logs, "holds a secret's value") || !strings.Contains(logs, "had its diff withheld: the runner's secret record is unreadable") {
		t.Fatalf("log for an unreadable record: %q", logs)
	}
	if n := notices["sUnreadable"]; strings.Contains(n, "holds the value") || !strings.Contains(n, "could not read its record") {
		t.Fatalf("notice for an unreadable record: %q", n)
	}
}

// One line of a multi-line value is matched on its own only when it could not be ordinary text: indentation,
// brackets and short JSON keys of a pretty-printed secret are not patterns; a key's long line still is.
func TestMultiLineSecretIndentationLinesAreNotPatterns(t *testing.T) {
	value := "{\n" +
		"    \"type\": \"x\",\n" +
		"    \"key\": \"Zq8vN3kLp0Wm7Rt2Yx5BcHd4\",\n" +
		"    \"nested\": {\n" +
		"        \"a\": 1\n" +
		"        },\n" +
		"        \t   \r\n" +
		"    ]\n" +
		"}\n"
	r := newSecretRedactor([]string{value})
	for _, form := range r.secrets {
		if strings.TrimSpace(form) != form && !strings.Contains(form, "\n") {
			t.Errorf("an untrimmed line became a pattern: %q", form)
		}
	}
	for _, ordinary := range []string{
		"        },\n",
		"    ]\n",
		"    \"type\": \"x\",\n",
		"        \t   \n",
		"    \"nested\": {\n",
		"{\n",
	} {
		if r.holds([]byte("func f() {\n" + ordinary + "}\n")) {
			t.Errorf("ordinary code matched the secret: %q", ordinary)
		}
	}
	if !r.holds([]byte("leaked: \"key\": \"Zq8vN3kLp0Wm7Rt2Yx5BcHd4\",\n")) {
		t.Fatal("the secret's distinctive line is no longer matched on its own")
	}
	if !r.holds([]byte("x" + value + "y")) {
		t.Fatal("the whole value is no longer matched")
	}
}
