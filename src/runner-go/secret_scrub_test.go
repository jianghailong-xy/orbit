//go:build linux || darwin

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func sprintAll(v interface{}) string {
	return fmt.Sprintf("%v|%+v|%#v|%s", v, v, v, v)
}

func TestSecretScrubberReplacesEveryForm(t *testing.T) {
	value := "sk-live/abc+def?ghi=jkl&mno"
	r := newSecretRedactor([]string{value})
	for _, form := range []string{
		value,
		base64.StdEncoding.EncodeToString([]byte(value)),
		base64.RawURLEncoding.EncodeToString([]byte(value)),
		base64.URLEncoding.EncodeToString([]byte(value)),
		hex.EncodeToString([]byte(value)),
		strings.ToUpper(hex.EncodeToString([]byte(value))),
		url.QueryEscape(value),
		url.PathEscape(value),
	} {
		out := r.redact("before " + form + " after")
		if out != "before [redacted] after" {
			t.Errorf("form %q came out as %q", form, out)
		}
	}
	multi := "-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG\nw0BAQEFAASCBKcwggSj\n-----END KEY-----\n"
	r = newSecretRedactor([]string{multi})
	out := r.redact("line: w0BAQEFAASCBKcwggSj\n")
	if strings.Contains(out, "w0BAQEFAASCBKcwggSj") {
		t.Fatalf("one line of a multi-line value survived: %q", out)
	}
	if r.redact("ordinary text") != "ordinary text" {
		t.Fatal("text without a value was changed")
	}
}

// A value split across two writes is still caught; text that cannot begin a value is not held back.
func TestSecretScrubWriterCatchesAValueSplitAcrossChunks(t *testing.T) {
	r := newSecretRedactor([]string{testSecretValue})
	b64 := base64.StdEncoding.EncodeToString([]byte(testSecretValue))
	stream := "start " + testSecretValue + " mid " + b64 + " end\n"
	for cut := 1; cut < len(stream); cut++ {
		var out bytes.Buffer
		w := newSecretScrubWriter(&out, r)
		_, _ = w.Write([]byte(stream[:cut]))
		_, _ = w.Write([]byte(stream[cut:]))
		_ = w.Close()
		if out.String() != "start [redacted] mid [redacted] end\n" {
			t.Fatalf("cut at %d: %q", cut, out.String())
		}
	}
	var out bytes.Buffer
	w := newSecretScrubWriter(&out, r)
	_, _ = w.Write([]byte("progress 10%\n"))
	if out.String() != "progress 10%\n" {
		t.Fatalf("plain output was held back: %q", out.String())
	}
}

func TestReaderHoldsSecretAcrossReadBoundaries(t *testing.T) {
	r := newSecretRedactor([]string{testSecretValue})
	pad := strings.Repeat("x", 64*1024-5)
	holds, err := readerHoldsSecret(strings.NewReader(pad+testSecretValue+"tail"), r)
	if err != nil || !holds {
		t.Fatalf("a value across a read boundary: %v %v", holds, err)
	}
	holds, _ = readerHoldsSecret(strings.NewReader(pad+"nothing here"), r)
	if holds {
		t.Fatal("a file without the value holds it")
	}
}

type scrubTestPayload struct {
	Text string `json:"text"`
}

func TestSecretPayloadScrubWalksEveryString(t *testing.T) {
	store := newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
	store.held["g"] = &heldSecret{id: "g", exposure: secretExposureEnv, name: "K_KEY", value: secretValue(testSecretValue), revoked: make(chan struct{})}
	store.rebuildScrubLocked()
	payload := map[string]interface{}{
		"text":    "the key is " + testSecretValue,
		"nested":  map[string]interface{}{"list": []interface{}{"ok", "x" + testSecretValue, 3.0}},
		"strings": []string{testSecretValue},
		"env":     map[string]string{"K": testSecretValue},
		"typed":   scrubTestPayload{Text: testSecretValue},
		"raw":     json.RawMessage(`{"a":"` + testSecretValue + `"}`),
		"plain":   "nothing",
	}
	before := sprintAll(payload)
	scrubbed := store.scrubPayload(payload)
	encoded, _ := json.Marshal(scrubbed)
	if strings.Contains(string(encoded), testSecretValue) {
		t.Fatalf("a value survived: %s", encoded)
	}
	if scrubbed["plain"] != "nothing" {
		t.Fatal("a clean string changed")
	}
	if sprintAll(payload) != before {
		t.Fatal("the caller's payload was changed in place")
	}
	clean := map[string]interface{}{"text": "hello"}
	if out := store.scrubPayload(clean); fmt.Sprint(out) != fmt.Sprint(clean) {
		t.Fatal("a clean payload changed")
	}
}

// After `git add`, a staged file holding a value is unstaged and the session is told; the value is not in the warning.
func TestUnstageHeldSecretsKeepsAValueOutOfTheCommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	store := newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
	store.held["g"] = &heldSecret{id: "g", exposure: secretExposureEnv, name: "K_KEY", value: secretValue(testSecretValue), revoked: make(chan struct{})}
	store.rebuildScrubLocked()
	runnerSecretStore.Store(store)
	defer runnerSecretStore.Store(nil)

	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return string(out)
	}
	run("init", "-q")
	_ = os.WriteFile(filepath.Join(dir, "README"), []byte("hi"), 0o644)
	run("add", "-A")
	run("commit", "-q", "-m", "base")
	_ = os.WriteFile(filepath.Join(dir, "config.env"), []byte("KEY="+testSecretValue+"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "README"), []byte("changed"), 0o644)
	run("add", "-A")

	secretWarned.Range(func(key, _ interface{}) bool { secretWarned.Delete(key); return true })
	var events []map[string]interface{}
	session := "343dlzsYWKo5z8l2M8tsB"
	defer registerSecretWarnings(session, func(eventType string, payload map[string]interface{}) {
		events = append(events, payload)
	})()
	unstageHeldSecrets(dir, nil, session)
	staged := run("diff", "--cached", "--name-only")
	if strings.Contains(staged, "config.env") || !strings.Contains(staged, "README") {
		t.Fatalf("staged = %q", staged)
	}
	if len(events) != 1 || events[0]["path"] != "config.env" || events[0]["subtype"] != "secret_unstaged" {
		t.Fatalf("events = %#v", events)
	}
	if strings.Contains(sprintAll(events), testSecretValue) {
		t.Fatal("the warning carries the value")
	}
}

// A file inside the roots that holds a value is not opened for upload.
func TestLocalFileScopeRefusesAFileHoldingASecret(t *testing.T) {
	secretTestHome(t)
	store := newSecretStore(newFakeSecretAPI(), filepath.Join(t.TempDir(), "ledger.json"))
	store.held["g"] = &heldSecret{id: "g", exposure: secretExposureEnv, name: "K_KEY", value: secretValue(testSecretValue), revoked: make(chan struct{})}
	store.rebuildScrubLocked()
	runnerSecretStore.Store(store)
	defer runnerSecretStore.Store(nil)

	root, _ := filepath.EvalSymlinks(t.TempDir())
	leaky := filepath.Join(root, "leak.log")
	clean := filepath.Join(root, "clean.log")
	_ = os.WriteFile(leaky, []byte("output "+testSecretValue), 0o644)
	_ = os.WriteFile(clean, []byte("output"), 0o644)
	scope := newLocalFileScope(nil, root)
	if _, _, err := scope.open(leaky); err != errFileHoldsOwnerSecret {
		t.Fatalf("a file holding a value: %v", err)
	}
	file, _, err := scope.open(clean)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data := make([]byte, 6)
	if _, err := file.Read(data); err != nil || string(data) != "output" {
		t.Fatalf("the scanned file was not left at its start: %q %v", data, err)
	}
}
