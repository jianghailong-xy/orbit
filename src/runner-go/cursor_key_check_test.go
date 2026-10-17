package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The runner's half of a Cursor key check somebody is waiting on (project P2 follow-up;
// docs/cursor-runtime-contract.md §9): a key handed over on a heartbeat is asked of the pinned CLI's
// `agent models` the way a session's start asks it — a throwaway home, the key in memory, never the ACP
// handshake — and answered by POST /runner/cursor-key-check-result with what Cursor said and the key's
// fingerprint, never the key, within cursorKeyCheckTimeout. scripts/test-cursor-key-check.mjs runs every
// test here by name.

// cursorKeyAnswers stands in for the control plane's door and keeps what reached it.
type cursorKeyAnswers struct {
	mu      sync.Mutex
	results []CursorKeyCheckResult
}

func (a *cursorKeyAnswers) report(result CursorKeyCheckResult) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.results = append(a.results, result)
	return nil
}

func (a *cursorKeyAnswers) all() []CursorKeyCheckResult {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]CursorKeyCheckResult(nil), a.results...)
}

// cursorProbeRootsLeft lists the throwaway roots `agent models` runs in that are still on disk.
func cursorProbeRootsLeft(t *testing.T) []string {
	t.Helper()
	left, err := filepath.Glob(filepath.Join(os.TempDir(), "orbit-cursor-models-*"))
	if err != nil {
		t.Fatal(err)
	}
	return left
}

// assertNoCredentialStore fails when anything under root holds a Cursor credential store.
func assertNoCredentialStore(t *testing.T, root string) {
	t.Helper()
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.Name() == "auth.json" {
			t.Errorf("a credential store was written: %s", path)
		}
		return nil
	})
}

// Cursor's answer, as the runner reads it from `agent models`: exit 0 is a key Cursor accepts, "The
// provided API key is invalid." one it refuses, "Failed to reach the Cursor API" one it could not ask
// about — and words §9 never measured are no verdict, which is UNREACHABLE: the key could not be checked.
// Each is asked once, in a throwaway home gone again afterwards, with the key in the CLI's environment and
// its credentials held in memory; never on a command line, never by the ACP handshake, never written down.
func TestCursorKeyCheckAnswersWhatCursorSaid(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	installFakeCursor(t)
	var logs strings.Builder
	for i, c := range []struct{ mode, want string }{
		{"", "VALID"},
		{"invalid-key", "INVALID"},
		{"offline", "UNREACHABLE"},
		{"garbled", "UNREACHABLE"},
	} {
		r.behave(t, "models-mode", c.mode)
		check := CursorKeyCheckCommand{CheckID: fmt.Sprintf("%032d", i), APIKey: "  " + cursorTestKey + "\n"}
		var answers cursorKeyAnswers
		logs.WriteString(captureLogs(t, func() { answerCursorKeyCheck(context.Background(), check, answers.report) }))
		want := CursorKeyCheckResult{CheckID: check.CheckID, State: c.want, KeyFingerprint: cursorKeyFingerprint(cursorTestKey)}
		if got := answers.all(); len(got) != 1 || got[0] != want {
			t.Fatalf("%q: answered %+v, want %+v", c.mode, got, want)
		}
	}
	models := callsWith(r.calls(t), "models")
	if len(models) != 4 {
		t.Fatalf("`agent models` ran %d times for 4 checks", len(models))
	}
	for _, call := range models {
		if key, _ := call.env("CURSOR_API_KEY"); key != cursorTestKey {
			t.Fatalf("%v did not ask with the key as it was handed over, trimmed", call.Args)
		}
		assertProbeHome(t, call, home)
	}
	for _, call := range r.calls(t) {
		if len(call.Args) > 0 && call.Args[0] == "acp" {
			t.Fatalf("a key check started the ACP server: %v", call.Args)
		}
		for _, arg := range call.Args {
			if strings.Contains(arg, cursorTestKey) {
				t.Fatalf("%v carries the key on its command line", call.Args)
			}
		}
	}
	if left := cursorProbeRootsLeft(t); len(left) != 0 {
		t.Fatalf("throwaway homes left behind: %v", left)
	}
	assertKeyNowhere(t, logs.String(), home)
	assertNoCredentialStore(t, home)
	assertNoCursorStateIn(t, home)
}

// Somebody is waiting: a Cursor API that never answers, or a build slow to say even its version, is
// answered UNREACHABLE by the deadline, the CLI stopped, its throwaway homes removed, the key left nowhere.
func TestCursorKeyCheckAnswersByTheDeadline(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	installFakeCursor(t)
	previous := cursorKeyCheckTimeout
	cursorKeyCheckTimeout = 500 * time.Millisecond
	t.Cleanup(func() { cursorKeyCheckTimeout = previous })
	var logs strings.Builder
	for _, c := range []struct{ name, file, mode string }{
		{"a Cursor API that never answers", "models-mode", "hang"},
		{"a build slow to say its version", "version-mode", "slow"},
	} {
		r.behave(t, c.file, c.mode)
		var answers cursorKeyAnswers
		started := time.Now()
		logs.WriteString(captureLogs(t, func() {
			answerCursorKeyCheck(context.Background(), CursorKeyCheckCommand{CheckID: strings.Repeat("a", 32), APIKey: cursorTestKey}, answers.report)
		}))
		if took := time.Since(started); took > 1500*time.Millisecond {
			t.Fatalf("%s: answered after %s, past its %s deadline", c.name, took, cursorKeyCheckTimeout)
		}
		if got := answers.all(); len(got) != 1 || got[0].State != "UNREACHABLE" {
			t.Fatalf("%s: answered %+v, want UNREACHABLE", c.name, got)
		}
		deadline := time.Now().Add(15 * time.Second)
		for {
			left, err := filepath.Glob(filepath.Join(os.TempDir(), "orbit-cursor-*"))
			if err != nil {
				t.Fatal(err)
			}
			if len(left) == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: throwaway homes still there: %v", c.name, left)
			}
			time.Sleep(50 * time.Millisecond)
		}
		r.behave(t, c.file, "")
	}
	// Asked once while Cursor hung; never past the deadline once the version came too late.
	if models := callsWith(r.calls(t), "models"); len(models) != 1 {
		t.Fatalf("`agent models` ran %d times, want once", len(models))
	}
	assertKeyNowhere(t, logs.String(), home)
	assertNoCredentialStore(t, home)
}

// A runner with no pinned Cursor CLI to ask — the control plane's view of it gone stale — answers at once
// that the key could not be checked, and starts nothing.
func TestCursorKeyCheckWithoutThePinnedCLIIsUnreachable(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	var answers cursorKeyAnswers
	logs := captureLogs(t, func() {
		answerCursorKeyCheck(context.Background(), CursorKeyCheckCommand{CheckID: strings.Repeat("b", 32), APIKey: cursorTestKey}, answers.report)
	})
	if got := answers.all(); len(got) != 1 || got[0].State != "UNREACHABLE" {
		t.Fatalf("answered %+v, want UNREACHABLE", got)
	}
	if calls := r.calls(t); len(calls) != 0 {
		t.Fatalf("a CLI ran with no pinned build installed: %v", calls)
	}
	if !strings.Contains(logs, "CURSOR_NOT_INSTALLED") {
		t.Fatalf("the runner did not say why it could not check: %s", logs)
	}
	assertKeyNowhere(t, logs, home)
}

// The answer reaches the control plane's door for it: the check it answers, what Cursor said, and the key
// by its fingerprint — the first 16 hex digits of the SHA-256 of the trimmed key, as the control plane
// computes it — with no key in the path, the headers or the body.
func TestCursorKeyCheckReportsByFingerprintNeverTheKey(t *testing.T) {
	useCursorRealHome(t)
	newFakeCursorRelease(t)
	installFakeCursor(t)
	type request struct {
		method, path, body string
		header             http.Header
	}
	var mu sync.Mutex
	var requests []request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests = append(requests, request{r.Method, r.URL.Path, string(body), r.Header.Clone()})
		mu.Unlock()
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	t.Cleanup(srv.Close)
	transport := NewTransport(srv.URL, "runner-token")

	checkID := strings.Repeat("c", 32)
	logs := captureLogs(t, func() {
		answerCursorKeyCheck(context.Background(), CursorKeyCheckCommand{CheckID: checkID, APIKey: cursorTestKey}, transport.cursorKeyCheckResult)
	})
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 1 || requests[0].method != http.MethodPost || requests[0].path != "/api/runner/cursor-key-check-result" {
		t.Fatalf("requests = %+v", requests)
	}
	var body map[string]interface{}
	if err := json.Unmarshal([]byte(requests[0].body), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{"checkId": checkID, "state": "VALID", "keyFingerprint": cursorKeyFingerprint(cursorTestKey)}
	if fmt.Sprint(body) != fmt.Sprint(want) {
		t.Fatalf("body = %v, want %v", body, want)
	}
	if strings.Contains(fmt.Sprint(requests[0]), cursorTestKey) {
		t.Fatal("the answer carries the key")
	}
	if strings.Contains(logs, cursorTestKey) {
		t.Fatal("the runner printed the key")
	}
}

// This binary declares cursor-key-check/v1, reads the checks a heartbeat hands over, answers each of them
// off the heartbeat — waited for by a runner that stops — and never prints or serializes a key it holds.
func TestCursorKeyCheckIsDeclaredAndHandedOverOnTheHeartbeat(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+cursorKeyCheckCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", cursorKeyCheckCapabilityV1, runnerCapabilitiesV1)
	}
	var resp HeartbeatResponse
	raw := `{"cancelSessionIds":[],"maxConcurrent":2,"cursorKeyChecks":[` +
		`{"checkId":"` + strings.Repeat("d", 32) + `","apiKey":"` + cursorTestKey + `"},` +
		`{"checkId":"` + strings.Repeat("e", 32) + `","apiKey":"` + cursorTestKey + `"}]}`
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.CursorKeyChecks) != 2 || resp.CursorKeyChecks[0].APIKey != cursorTestKey || resp.CursorKeyChecks[1].CheckID != strings.Repeat("e", 32) {
		t.Fatalf("checks read = %d", len(resp.CursorKeyChecks))
	}
	encoded, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	check := resp.CursorKeyChecks[0]
	for _, text := range []string{check.String(), fmt.Sprintf("%v", check), fmt.Sprintf("%+v", check), fmt.Sprintf("%#v", check),
		fmt.Sprintf("%v", resp.CursorKeyChecks), fmt.Sprintf("%+v", resp), string(encoded)} {
		if strings.Contains(text, cursorTestKey) {
			t.Fatalf("a check printed its key: %s", text)
		}
	}

	home := useCursorRealHome(t)
	newFakeCursorRelease(t)
	installFakeCursor(t)
	var answers cursorKeyAnswers
	var ops countedOps
	logs := captureLogs(t, func() {
		startCursorKeyChecks(resp.CursorKeyChecks, &ops, answers.report)
		ops.Wait()
	})
	got := map[string]string{}
	for _, answer := range answers.all() {
		got[answer.CheckID] = answer.State
	}
	if len(got) != 2 || got[strings.Repeat("d", 32)] != "VALID" || got[strings.Repeat("e", 32)] != "VALID" {
		t.Fatalf("answered %v, want both checks VALID", got)
	}
	if ops.inFlight() != 0 {
		t.Fatalf("%d checks still counted in flight", ops.inFlight())
	}
	assertKeyNowhere(t, logs, home)
}
