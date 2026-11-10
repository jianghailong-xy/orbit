//go:build linux || darwin

package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSecretAPI is the control plane's three secret-grant routes.
type fakeSecretAPI struct {
	mu      sync.Mutex
	grants  map[string]*SecretGrantFetch
	fetched []string
	acks    map[string][]SecretGrantAck
	removed map[string][]string // id -> notes
	ackErr  func(id string) error
}

func newFakeSecretAPI() *fakeSecretAPI {
	return &fakeSecretAPI{grants: map[string]*SecretGrantFetch{}, acks: map[string][]SecretGrantAck{}, removed: map[string][]string{}}
}

var errFake404 = &transportHTTPError{method: "POST", path: "/x", statusCode: http.StatusNotFound, body: `{}`}
var errFake500 = &transportHTTPError{method: "POST", path: "/x", statusCode: http.StatusInternalServerError, body: `{}`}

func (f *fakeSecretAPI) fetchSecretGrant(id string) (*SecretGrantFetch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fetched = append(f.fetched, id)
	g, ok := f.grants[id]
	if !ok {
		return nil, errFake404
	}
	copied := *g
	return &copied, nil
}

func (f *fakeSecretAPI) ackSecretGrant(id string, ack SecretGrantAck) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acks[id] = append(f.acks[id], ack)
	if f.ackErr != nil {
		return f.ackErr(id)
	}
	return nil
}

func (f *fakeSecretAPI) removedSecretGrant(id, note string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed[id] = append(f.removed[id], note)
	return nil
}

func (f *fakeSecretAPI) calls() (fetched int, acks int, removed int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, a := range f.acks {
		acks += len(a)
	}
	for _, r := range f.removed {
		removed += len(r)
	}
	return len(f.fetched), acks, removed
}

const testSecretValue = "sk-canary-0123456789abcdef"

func envGrant(id, name, session, task string, expires time.Time) *SecretGrantFetch {
	return &SecretGrantFetch{ID: id, RequestID: "req-" + id, Exposure: secretExposureEnv, Name: name,
		Value: secretValue(testSecretValue), ExpiresAt: expires.UTC().Format(time.RFC3339Nano), SessionID: session, TaskID: task}
}

func fileGrant(id, path string, expires time.Time) *SecretGrantFetch {
	return &SecretGrantFetch{ID: id, RequestID: "req-" + id, Exposure: secretExposureFile, FilePath: path,
		Value: secretValue(testSecretValue + "-file"), ExpiresAt: expires.UTC().Format(time.RFC3339Nano), SessionID: "s1"}
}

func refs(grants ...*SecretGrantFetch) *[]SecretGrantRef {
	list := []SecretGrantRef{}
	for _, g := range grants {
		list = append(list, SecretGrantRef{ID: g.ID, ExpiresAt: g.ExpiresAt})
	}
	return &list
}

func readLedgerForTest(t *testing.T, path string) []secretLedgerEntry {
	t.Helper()
	entries, err := readSecretLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func TestHeartbeatResponseTellsAbsentSecretGrantsFromEmpty(t *testing.T) {
	var absent, empty, listed HeartbeatResponse
	_ = json.Unmarshal([]byte(`{"cancelSessionIds":[]}`), &absent)
	_ = json.Unmarshal([]byte(`{"secretGrants":[]}`), &empty)
	_ = json.Unmarshal([]byte(`{"secretGrants":[{"id":"g1","expiresAt":"2030-01-01T00:00:00Z"}],"secretGrantsRemoving":["g2"]}`), &listed)
	if absent.SecretGrants != nil {
		t.Fatal("an answer without the field reads as a list")
	}
	if empty.SecretGrants == nil || len(*empty.SecretGrants) != 0 {
		t.Fatal("[] does not read as an empty list")
	}
	if len(*listed.SecretGrants) != 1 || listed.SecretGrantsRemoving[0] != "g2" {
		t.Fatalf("listed = %#v", listed)
	}
}

func TestSecretReconcileDeliversAndAnAbsentListRemovesNothing(t *testing.T) {
	home := secretTestHome(t)
	api := newFakeSecretAPI()
	expires := time.Now().Add(time.Hour)
	env := envGrant("g-env", "DEEPSEEK_API_KEY", "s1", "", expires)
	file := fileGrant("g-file", "~/keys/api.key", expires)
	api.grants[env.ID], api.grants[file.ID] = env, file
	ledger := filepath.Join(home, ".orbit", "secret-grants", "ledger.json")
	store := newSecretStore(api, ledger)

	store.reconcile(refs(env, file), nil)
	if api.acks["g-env"][0].Outcome != secretAckDelivered || api.acks["g-file"][0].Outcome != secretAckDelivered {
		t.Fatalf("acks = %#v", api.acks)
	}
	path := filepath.Join(home, "keys", "api.key")
	if data, err := os.ReadFile(path); err != nil || string(data) != testSecretValue+"-file" {
		t.Fatalf("file = %q, %v", data, err)
	}
	entries := readLedgerForTest(t, ledger)
	if len(entries) != 1 || !entries[0].Written || !entries[0].Acked || entries[0].Ino == 0 {
		t.Fatalf("ledger = %#v", entries)
	}
	raw, _ := os.ReadFile(ledger)
	if strings.Contains(string(raw), testSecretValue) {
		t.Fatal("the ledger holds the value")
	}
	if info, _ := os.Stat(ledger); info.Mode().Perm() != 0o600 {
		t.Fatalf("ledger mode %v", info.Mode())
	}
	if info, _ := os.Stat(filepath.Dir(ledger)); info.Mode().Perm() != 0o700 {
		t.Fatalf("ledger dir mode %v", info.Mode())
	}

	// A heartbeat that states nothing removes nothing, and asks for nothing.
	f0, a0, r0 := api.calls()
	store.reconcile(nil, nil)
	if f, a, r := api.calls(); f != f0 || a != a0 || r != r0 {
		t.Fatal("an absent list made calls")
	}
	if _, err := store.lease("DEEPSEEK_API_KEY", "s1", ""); err != nil {
		t.Fatalf("an absent list dropped the ENV grant: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("an absent list removed the file")
	}

	// A listed grant already held is neither fetched again nor rewritten.
	store.reconcile(refs(env, file), nil)
	if f, _, _ := api.calls(); f != f0 {
		t.Fatal("a held grant was fetched again")
	}

	// [] means hold nothing: both go, and both are reported removed.
	store.reconcile(refs(), nil)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("[] left the file")
	}
	if _, err := os.Stat(filepath.Join(home, "keys")); !os.IsNotExist(err) {
		t.Fatal("[] left the directory the runner created")
	}
	if _, err := store.lease("DEEPSEEK_API_KEY", "s1", ""); err == nil {
		t.Fatal("[] left the ENV grant")
	}
	if len(api.removed["g-env"]) != 1 || len(api.removed["g-file"]) != 1 {
		t.Fatalf("removed = %#v", api.removed)
	}
	if store.scrubber() != nil {
		t.Fatal("the scrubber still holds values")
	}
}

// secretGrantsRemoving: removed if held, and reported removed either way (an ENV grant lost to a restart).
func TestSecretReconcileReportsRemovingGrantsHeldOrNot(t *testing.T) {
	home := secretTestHome(t)
	api := newFakeSecretAPI()
	env := envGrant("g-env", "TOKEN_A", "s1", "", time.Now().Add(time.Hour))
	api.grants[env.ID] = env
	store := newSecretStore(api, filepath.Join(home, "ledger.json"))
	store.reconcile(refs(env), nil)
	store.reconcile(nil, []string{"g-env", "g-lost"})
	if _, err := store.lease("TOKEN_A", "s1", ""); err == nil {
		t.Fatal("a removing grant was kept")
	}
	if len(api.removed["g-env"]) != 1 || len(api.removed["g-lost"]) != 1 {
		t.Fatalf("removed = %#v", api.removed)
	}
}

func TestSecretFileReplacedIsLeftAndNoted(t *testing.T) {
	home := secretTestHome(t)
	api := newFakeSecretAPI()
	file := fileGrant("g-file", "~/keys/api.key", time.Now().Add(time.Hour))
	api.grants[file.ID] = file
	store := newSecretStore(api, filepath.Join(home, "ledger.json"))
	store.reconcile(refs(file), nil)
	path := filepath.Join(home, "keys", "api.key")
	// Replaced by rename, so the old inode is still in use and cannot be handed to the new file.
	other := filepath.Join(home, "other")
	if err := os.WriteFile(other, []byte("someone else's"), 0o600); err != nil {
		t.Fatal(err)
	}
	keep, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer keep.Close()
	if err := os.Rename(other, path); err != nil {
		t.Fatal(err)
	}
	store.reconcile(refs(), nil)
	if data, _ := os.ReadFile(path); string(data) != "someone else's" {
		t.Fatal("a different file was removed")
	}
	if notes := api.removed["g-file"]; len(notes) != 1 || !strings.Contains(notes[0], "different file") || strings.Contains(notes[0], testSecretValue) {
		t.Fatalf("notes = %#v", notes)
	}
}

// Crash between the ledger write and the file write: the entry says the value never reached the disk.
func TestSecretLedgerEntryWithoutFileIsCleanedAndDeliveredAgain(t *testing.T) {
	home := secretTestHome(t)
	ledger := filepath.Join(home, ".orbit", "secret-grants", "ledger.json")
	parent := filepath.Join(home, "keys")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "api.key")
	// The crash also left the empty file it had just created.
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	crashed := newSecretStore(newFakeSecretAPI(), ledger)
	if err := crashed.updateLedger("g-file", func(e *secretLedgerEntry) {
		*e = secretLedgerEntry{GrantID: "g-file", Path: path, Parents: []string{parent}, ExpiresAt: expires}
	}); err != nil {
		t.Fatal(err)
	}

	api := newFakeSecretAPI()
	file := fileGrant("g-file", "~/keys/api.key", expires)
	api.grants[file.ID] = file
	store := newSecretStore(api, ledger)
	store.startup()
	if _, err := os.Stat(parent); !os.IsNotExist(err) {
		t.Fatal("the partial write's file and directory were left")
	}
	if len(readLedgerForTest(t, ledger)) != 0 {
		t.Fatal("the partial entry was kept")
	}
	store.reconcile(refs(file), nil)
	if data, _ := os.ReadFile(path); string(data) != testSecretValue+"-file" {
		t.Fatal("the grant was not written again")
	}
	if api.acks["g-file"][0].Outcome != secretAckDelivered {
		t.Fatalf("acks = %#v", api.acks)
	}
}

// A non-empty file at an entry that never recorded its inode is not the runner's: it is left alone.
func TestSecretLedgerUnwrittenEntryLeavesAForeignFile(t *testing.T) {
	home := secretTestHome(t)
	ledger := filepath.Join(home, "ledger.json")
	path := filepath.Join(home, "api.key")
	if err := os.WriteFile(path, []byte("owner's"), 0o600); err != nil {
		t.Fatal(err)
	}
	crashed := newSecretStore(newFakeSecretAPI(), ledger)
	_ = crashed.updateLedger("g", func(e *secretLedgerEntry) {
		*e = secretLedgerEntry{GrantID: "g", Path: path, ExpiresAt: time.Now().Add(time.Hour)}
	})
	newSecretStore(newFakeSecretAPI(), ledger).startup()
	if data, _ := os.ReadFile(path); string(data) != "owner's" {
		t.Fatal("a file the runner did not write was removed")
	}
}

// Crash between the file write and the ack: after the restart the file is held (never rewritten), its value is back
// in the scrubber, and the ack is sent.
func TestSecretFileWithoutAckIsAckedAfterRestart(t *testing.T) {
	home := secretTestHome(t)
	ledger := filepath.Join(home, ".orbit", "secret-grants", "ledger.json")
	api := newFakeSecretAPI()
	file := fileGrant("g-file", "~/keys/api.key", time.Now().Add(time.Hour))
	api.grants[file.ID] = file
	api.ackErr = func(string) error { return errFake500 }
	newSecretStore(api, ledger).reconcile(refs(file), nil)
	if entries := readLedgerForTest(t, ledger); len(entries) != 1 || entries[0].Acked {
		t.Fatalf("ledger = %#v", entries)
	}

	api.ackErr = nil
	restarted := newSecretStore(api, ledger)
	restarted.startup()
	if r := restarted.scrubber(); r == nil || r.redact(testSecretValue+"-file") != integrationOutputRedacted {
		t.Fatal("the file's value is not back in the scrubber")
	}
	fetchedBefore, _, _ := api.calls()
	restarted.reconcile(refs(file), nil)
	if f, _, _ := api.calls(); f != fetchedBefore {
		t.Fatal("a file in the ledger was fetched again")
	}
	if acks := api.acks["g-file"]; len(acks) != 2 || acks[1].Outcome != secretAckDelivered {
		t.Fatalf("acks = %#v", acks)
	}
	if entries := readLedgerForTest(t, ledger); len(entries) != 1 || !entries[0].Acked {
		t.Fatalf("ledger = %#v", entries)
	}
}

// 404 on ack: what was materialised goes.
func TestSecretAckNotFoundDropsWhatWasMaterialised(t *testing.T) {
	home := secretTestHome(t)
	api := newFakeSecretAPI()
	expires := time.Now().Add(time.Hour)
	env := envGrant("g-env", "TOKEN_A", "s1", "", expires)
	file := fileGrant("g-file", "~/keys/api.key", expires)
	api.grants[env.ID], api.grants[file.ID] = env, file
	api.ackErr = func(string) error { return errFake404 }
	ledger := filepath.Join(home, "ledger.json")
	store := newSecretStore(api, ledger)
	store.reconcile(refs(env, file), nil)
	if _, err := os.Stat(filepath.Join(home, "keys", "api.key")); !os.IsNotExist(err) {
		t.Fatal("the file was kept after a 404 ack")
	}
	if _, err := store.lease("TOKEN_A", "s1", ""); err == nil {
		t.Fatal("the ENV value was kept after a 404 ack")
	}
	if len(readLedgerForTest(t, ledger)) != 0 {
		t.Fatal("the ledger kept the entry")
	}
}

func TestSecretDeliveryFailureIsAckedFailed(t *testing.T) {
	home := secretTestHome(t)
	if err := os.WriteFile(filepath.Join(home, "taken"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	api := newFakeSecretAPI()
	file := fileGrant("g-file", "~/taken", time.Now().Add(time.Hour))
	api.grants[file.ID] = file
	store := newSecretStore(api, filepath.Join(home, "ledger.json"))
	store.reconcile(refs(file), nil)
	acks := api.acks["g-file"]
	if len(acks) != 1 || acks[0].Outcome != secretAckFailed || acks[0].Code != secretPathCodeExists {
		t.Fatalf("acks = %#v", acks)
	}
	if strings.Contains(acks[0].Message, testSecretValue) {
		t.Fatal("the failure message carries the value")
	}
}

// Expiry is local: at startup with no control plane, and every minute while running.
func TestSecretExpiryRemovesFilesWithoutTheControlPlane(t *testing.T) {
	home := secretTestHome(t)
	ledger := filepath.Join(home, ".orbit", "secret-grants", "ledger.json")
	api := newFakeSecretAPI()
	file := fileGrant("g-file", "~/keys/api.key", time.Now().Add(time.Hour))
	api.grants[file.ID] = file
	newSecretStore(api, ledger).reconcile(refs(file), nil)
	path := filepath.Join(home, "keys", "api.key")

	down := &erroringSecretAPI{}
	later := newSecretStore(down, ledger)
	later.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	later.startup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("an expired file survived startup")
	}
	if len(readLedgerForTest(t, ledger)) != 0 {
		t.Fatal("the expired entry was kept")
	}

	// Running: expire() sweeps what has passed.
	env := envGrant("g-env", "TOKEN_A", "s1", "", time.Now().Add(time.Hour))
	api.grants[env.ID] = env
	running := newSecretStore(api, ledger)
	running.reconcile(refs(env), nil)
	running.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	running.expire()
	if _, err := running.lease("TOKEN_A", "s1", ""); err == nil {
		t.Fatal("an expired ENV grant was kept")
	}
	if len(api.removed["g-env"]) != 1 {
		t.Fatalf("removed = %#v", api.removed)
	}
}

type erroringSecretAPI struct{}

func (erroringSecretAPI) fetchSecretGrant(string) (*SecretGrantFetch, error) {
	return nil, errors.New("unreachable")
}
func (erroringSecretAPI) ackSecretGrant(string, SecretGrantAck) error { return errors.New("unreachable") }
func (erroringSecretAPI) removedSecretGrant(string, string) error   { return errors.New("unreachable") }

func TestSecretRemovedIsRetriedUntilAcknowledged(t *testing.T) {
	home := secretTestHome(t)
	store := newSecretStore(&erroringSecretAPI{}, filepath.Join(home, "ledger.json"))
	store.reconcile(nil, []string{"g1"})
	if _, owed := store.owedRem["g1"]; !owed {
		t.Fatal("a removal that did not get through is not owed")
	}
	api := newFakeSecretAPI()
	store.api = api
	store.flushRemoved()
	if len(api.removed["g1"]) != 1 || len(store.owedRem) != 0 {
		t.Fatalf("removed = %#v, owed = %#v", api.removed, store.owedRem)
	}
}

func TestSecretLeaseAuthorisesSameSessionOrSameTask(t *testing.T) {
	home := secretTestHome(t)
	api := newFakeSecretAPI()
	expires := time.Now().Add(time.Hour)
	bySession := envGrant("g1", "SESSION_KEY", "343dlzsYWKo5z8l2M8tsB", "", expires)
	byTask := envGrant("g2", "TASK_KEY", "343dlzsYWKo5z8l2M8tsB", "task-1", expires)
	api.grants[bySession.ID], api.grants[byTask.ID] = bySession, byTask
	store := newSecretStore(api, filepath.Join(home, "ledger.json"))
	store.reconcile(refs(bySession, byTask), nil)

	sessionUUID := decodeSessionID("343dlzsYWKo5z8l2M8tsB")
	if _, err := store.lease("SESSION_KEY", sessionUUID, ""); err != nil {
		t.Fatalf("the asking session (other spelling) was refused: %v", err)
	}
	if _, err := store.lease("SESSION_KEY", "other-session", "task-1"); err == nil {
		t.Fatal("a session-scoped grant was leased to another session")
	}
	if _, err := store.lease("TASK_KEY", "other-session", "task-1"); err != nil {
		t.Fatalf("a session of the same task was refused: %v", err)
	}
	if _, err := store.lease("TASK_KEY", "other-session", "task-2"); err == nil {
		t.Fatal("a session of another task was given the grant")
	}
	if _, err := store.lease("MISSING_KEY", sessionUUID, ""); err == nil {
		t.Fatal("an unknown name was leased")
	}

	// Not yet acknowledged: not leased.
	pending := envGrant("g3", "PENDING_KEY", "s9", "", expires)
	api.grants[pending.ID] = pending
	api.ackErr = func(string) error { return errFake500 }
	store.reconcile(refs(bySession, byTask, pending), nil)
	if _, err := store.lease("PENDING_KEY", "s9", ""); err == nil || !strings.Contains(err.Error(), "still being delivered") {
		t.Fatalf("an unacknowledged grant: %v", err)
	}
}

func TestSecretValueNeverFormats(t *testing.T) {
	g := envGrant("g", "N_KEY", "s", "", time.Now())
	for _, out := range []string{
		strings.Join([]string{(&struct{ V secretValue }{g.Value}).V.String()}, ""),
	} {
		if strings.Contains(out, testSecretValue) {
			t.Fatal("a secretValue formatted its value")
		}
	}
	if s := sprintAll(g); strings.Contains(s, testSecretValue) {
		t.Fatalf("a fetched grant formats its value: %s", s)
	}
}
