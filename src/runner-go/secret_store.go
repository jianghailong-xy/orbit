package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The runner's half of owner-request secrets (docs/design/owner-request-secrets.md §4–§6): the values this machine
// was given, kept in memory for an ENV grant and as a 0600 file for a FILE grant, and the heartbeat reconcile that is
// the only thing deciding what may stay. Nothing here formats a value: errors and logs name grant ids and paths.

const ownerSecretCapabilityV1 = "owner-secret/v1"

// secretValue holds a value in memory. It prints as "[redacted]" in every fmt verb, so a struct holding one that
// reaches a log line by mistake still does not carry it.
type secretValue string

func (secretValue) String() string   { return integrationOutputRedacted }
func (secretValue) GoString() string { return integrationOutputRedacted }

// SecretGrantFetch is POST /runner/secret-grants/:id/fetch's answer.
type SecretGrantFetch struct {
	ID        string      `json:"id"`
	RequestID string      `json:"requestId"`
	Exposure  string      `json:"exposure"`
	Name      string      `json:"name"`
	FilePath  string      `json:"filePath"`
	Value     secretValue `json:"value"`
	ExpiresAt string      `json:"expiresAt"`
	SessionID string      `json:"sessionId"`
	TaskID    string      `json:"taskId"`
}

// SecretGrantAck is POST /runner/secret-grants/:id/ack's body.
type SecretGrantAck struct {
	Outcome string `json:"outcome"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

const (
	secretExposureEnv  = "ENV"
	secretExposureFile = "FILE"

	secretAckDelivered = "DELIVERED"
	secretAckFailed    = "FAILED"
)

// secretGrantAPI is the three control-plane calls the store makes; *Transport is the real one.
type secretGrantAPI interface {
	fetchSecretGrant(id string) (*SecretGrantFetch, error)
	ackSecretGrant(id string, ack SecretGrantAck) error
	removedSecretGrant(id, note string) error
}

// heldSecret is one grant this runner holds.
type heldSecret struct {
	id        string
	exposure  string
	name      string // the env var, for ENV
	path      string // the file, for FILE
	sessionID string
	taskID    string
	expiresAt time.Time
	// Known for every ENV grant; for a FILE grant held across a restart, read back from the file when it is still ours.
	value secretValue
	// Whether value came from the control plane in this process. A FILE grant held across a restart starts with
	// the value read back from its file, a fallback the first reconcile replaces (refetchForScrub).
	fetched bool
	acked   bool
	// Closed when the grant is removed: every open lease on it ends (secret_exec.go).
	revoked chan struct{}
}

// secretStore is the runner's set of held grants. One per runner process (runnerSecrets).
type secretStore struct {
	api        secretGrantAPI
	ledgerPath string
	workDirs   func() []string
	now        func() time.Time

	// reconcileMu serialises reconciles, expiry sweeps and removals that touch the ledger.
	reconcileMu sync.Mutex

	mu      sync.Mutex
	held    map[string]*heldSecret
	ledger  []secretLedgerEntry
	scrub   *integrationOutputRedactor
	owedRem map[string]string // grant id -> removal note, until the control plane acknowledges it

	ready     chan struct{}
	readyOnce sync.Once
}

// runnerSecretStore is this runner process's store: set by runLoop, nil in every other process (`orbit mcp`, the CLI).
var runnerSecretStore atomic.Pointer[secretStore]

func runnerSecrets() *secretStore { return runnerSecretStore.Load() }

func secretLedgerPath() string { return filepath.Join(machineHome(), "secret-grants", "ledger.json") }

func newSecretStore(api secretGrantAPI, ledgerPath string) *secretStore {
	return &secretStore{
		api:        api,
		ledgerPath: ledgerPath,
		workDirs:   knownSecretWorkspaceDirs,
		now:        time.Now,
		held:       map[string]*heldSecret{},
		owedRem:    map[string]string{},
		ready:      make(chan struct{}),
	}
}

// markReady opens the startup gate: the first full reconcile has run, or there will be none to wait for.
func (s *secretStore) markReady() {
	if s == nil {
		return
	}
	s.readyOnce.Do(func() { close(s.ready) })
}

// waitReady waits for the startup gate, at most max. Sessions start behind it, so that the scrubber already knows
// every live value when the first event is emitted (§6.4).
func (s *secretStore) waitReady(ctx context.Context, max time.Duration) {
	if s == nil {
		return
	}
	timer := time.NewTimer(max)
	defer timer.Stop()
	select {
	case <-s.ready:
	case <-ctx.Done():
	case <-timer.C:
	}
}

// --- the ledger ---------------------------------------------------------------------------------------------------

// secretLedgerEntry is one FILE grant on disk. It holds no value and no hash of one. Written before the file is
// created, and updated with the file's device and inode before the value is written into it (writeSecretFile), so
// Written=false means the value never reached the disk.
type secretLedgerEntry struct {
	GrantID   string    `json:"grantId"`
	Path      string    `json:"path"`
	Dev       uint64    `json:"dev,omitempty"`
	Ino       uint64    `json:"ino,omitempty"`
	Written   bool      `json:"written"`
	Parents   []string  `json:"parents,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
	Acked     bool      `json:"acked"`
	SessionID string    `json:"sessionId,omitempty"`
	TaskID    string    `json:"taskId,omitempty"`
}

type secretLedgerFile struct {
	Version int                 `json:"version"`
	Entries []secretLedgerEntry `json:"entries"`
}

func readSecretLedger(path string) ([]secretLedgerEntry, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var file secretLedgerFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("secret ledger %s is unreadable: %w", path, err)
	}
	return file.Entries, nil
}

// writeLedgerLocked writes s.ledger whole, through a temporary file renamed over the ledger. Caller holds s.mu.
func (s *secretStore) writeLedgerLocked() error {
	dir := filepath.Dir(s.ledgerPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(secretLedgerFile{Version: 1, Entries: s.ledger}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "ledger-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.ledgerPath)
}

func (s *secretStore) ledgerIndexLocked(id string) int {
	for i := range s.ledger {
		if s.ledger[i].GrantID == id {
			return i
		}
	}
	return -1
}

// updateLedger changes one entry (adding it when absent) and writes the ledger.
func (s *secretStore) updateLedger(id string, change func(*secretLedgerEntry)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.ledgerIndexLocked(id)
	if i < 0 {
		s.ledger = append(s.ledger, secretLedgerEntry{GrantID: id})
		i = len(s.ledger) - 1
	}
	change(&s.ledger[i])
	return s.writeLedgerLocked()
}

func (s *secretStore) dropLedger(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.ledgerIndexLocked(id)
	if i < 0 {
		return nil
	}
	s.ledger = append(s.ledger[:i], s.ledger[i+1:]...)
	return s.writeLedgerLocked()
}

// --- startup, expiry, unregister ------------------------------------------------------------------------------

// startup reads the ledger and deletes every file past its expiry, whether or not the control plane can be reached,
// and the leftovers of a write a crash interrupted. What is left is held again: its value is read back from the file
// for the scrubber when the file is still the one the runner wrote. Runs before any session is reclaimed.
func (s *secretStore) startup() {
	s.reconcileMu.Lock()
	defer s.reconcileMu.Unlock()
	entries, err := readSecretLedger(s.ledgerPath)
	if err != nil {
		// Kept aside rather than written over: it may be the only record of a file somewhere.
		aside := s.ledgerPath + ".unreadable-" + s.now().UTC().Format("20060102T150405Z")
		_ = os.Rename(s.ledgerPath, aside)
		logln("secret grants: the ledger could not be read; it was moved to", aside+":", err)
		entries = nil
	}
	now := s.now()
	kept := make([]secretLedgerEntry, 0, len(entries))
	for _, entry := range entries {
		switch {
		case !entry.Written:
			// The value never reached the disk. An empty file there is the one this runner created; anything
			// else is not, and is left alone.
			if state, size := inspectSecretFileUnrecorded(entry.Path); state == secretFileOurs && size == 0 {
				_ = os.Remove(entry.Path)
			}
			removeEmptySecretParents(entry.Parents)
			logln("secret grants: grant", entry.GrantID, "was being written when the runner stopped; the partial write was cleaned up")
		case !entry.Acked && !secretFileComplete(entry):
			// Stopped after the file was recorded and before its value was written and acknowledged: it is no
			// delivery, and is cleaned up like an unwritten one. The grant is delivered again if still live.
			s.removeFileEntry(entry)
			logln("secret grants: grant", entry.GrantID, "was not completely written when the runner stopped; the partial write was cleaned up")
		case !entry.ExpiresAt.After(now):
			// The value is still on disk here, and nowhere else once this deletes it: what a checkout copied of it is
			// recorded first, as remove() does before it forgets a value (secretBeforeForget).
			if state, size := inspectSecretFile(entry.Path, entry.Dev, entry.Ino); state == secretFileOurs && size <= secretValueMax {
				if data, err := os.ReadFile(entry.Path); err == nil && len(data) > 0 {
					recordBeforeForget(newSecretRedactor([]string{string(data)}))
				}
			}
			s.owe(entry.GrantID, s.removeFileEntry(entry))
			logln("secret grants: grant", entry.GrantID, "expired while the runner was stopped; its file was removed")
		default:
			kept = append(kept, entry)
			held := &heldSecret{
				id: entry.GrantID, exposure: secretExposureFile, path: entry.Path, expiresAt: entry.ExpiresAt,
				sessionID: entry.SessionID, taskID: entry.TaskID, acked: entry.Acked, revoked: make(chan struct{}),
			}
			if state, size := inspectSecretFile(entry.Path, entry.Dev, entry.Ino); state == secretFileOurs && size <= secretValueMax {
				if data, err := os.ReadFile(entry.Path); err == nil {
					held.value = secretValue(data)
				}
			}
			s.held[entry.GrantID] = held
		}
	}
	s.mu.Lock()
	s.ledger = kept
	s.rebuildScrubLocked()
	if len(entries) > 0 {
		if err := s.writeLedgerLocked(); err != nil {
			logln("secret grants: cannot write the ledger:", err)
		}
	}
	s.mu.Unlock()
}

// secretValueMax is the largest value the control plane accepts (16 KiB).
const secretValueMax = 16 * 1024

// inspectSecretFileUnrecorded is what stands at a path whose device and inode were never recorded: an empty regular
// file reads as ours, since the runner records them before it writes a byte.
func inspectSecretFileUnrecorded(path string) (secretFileState, int64) {
	info, err := os.Lstat(path)
	if err != nil {
		return secretFileGone, 0
	}
	if !info.Mode().IsRegular() {
		return secretFileReplaced, 0
	}
	return secretFileOurs, info.Size()
}

// expire removes every grant past its expiry. A running runner calls it every minute, so a file outlives its grant
// by at most that much even with the control plane out of reach.
func (s *secretStore) expire() {
	if s == nil {
		return
	}
	// Every minute: what a removal could not record yet is tried again.
	retryPendingTaint()
	s.reconcileMu.Lock()
	now := s.now()
	s.mu.Lock()
	var due []string
	for id, held := range s.held {
		if !held.expiresAt.After(now) {
			due = append(due, id)
		}
	}
	s.mu.Unlock()
	for _, id := range due {
		s.owe(id, s.remove(id))
	}
	s.reconcileMu.Unlock()
	s.flushRemoved()
}

// removeLedgerSecrets is `orbit unregister`'s part: every file in the ledger is removed, and reported removed where
// the control plane still answers. It returns how many grants were held.
func removeLedgerSecrets(api secretGrantAPI) int {
	store := newSecretStore(api, secretLedgerPath())
	store.startup()
	return store.removeAll()
}

// removeAll removes every grant this runner holds, in memory and in the ledger, and returns how many there were.
func (s *secretStore) removeAll() int {
	s.reconcileMu.Lock()
	s.mu.Lock()
	ids := make([]string, 0, len(s.held))
	for id := range s.held {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.owe(id, s.remove(id))
	}
	s.reconcileMu.Unlock()
	s.flushRemoved()
	return len(ids)
}

// --- reconcile ------------------------------------------------------------------------------------------------

// reconcile applies one heartbeat answer. listed is the full set of grants this runner may hold, or nil when the
// answer stated none: nil removes nothing, an empty list removes everything. removing names grants to report removed.
func (s *secretStore) reconcile(listed *[]SecretGrantRef, removing []string) {
	if s == nil {
		return
	}
	defer s.markReady()
	s.reconcileMu.Lock()
	for _, id := range removing {
		if id != "" {
			s.owe(id, s.remove(id))
		}
	}
	if listed != nil {
		want := map[string]time.Time{}
		order := make([]string, 0, len(*listed))
		for _, ref := range *listed {
			if ref.ID == "" {
				continue
			}
			expires, err := time.Parse(time.RFC3339Nano, ref.ExpiresAt)
			if err != nil {
				logln("secret grants: grant", ref.ID, "has an unreadable expiry; skipped")
				continue
			}
			if _, dup := want[ref.ID]; !dup {
				order = append(order, ref.ID)
			}
			want[ref.ID] = expires
		}
		s.mu.Lock()
		var gone []string
		for id := range s.held {
			if _, ok := want[id]; !ok {
				gone = append(gone, id)
			}
		}
		s.mu.Unlock()
		sort.Strings(gone)
		for _, id := range gone {
			s.owe(id, s.remove(id))
		}
		now := s.now()
		for _, id := range order {
			expires := want[id]
			if !expires.After(now) {
				continue
			}
			s.mu.Lock()
			held := s.held[id]
			if held != nil {
				held.expiresAt = expires
			}
			s.mu.Unlock()
			if held == nil {
				s.deliver(id)
				continue
			}
			if held.exposure == secretExposureFile && !held.fetched {
				s.refetchForScrub(held)
			}
			if !held.acked {
				s.ack(held)
			}
		}
	}
	s.reconcileMu.Unlock()
	s.flushRemoved()
}

// refetchForScrub fetches a FILE grant held across a restart again, for the scrubber only: the file is never written
// again. When the control plane cannot be reached the value read back from the file stays in its place.
func (s *secretStore) refetchForScrub(held *heldSecret) {
	grant, err := s.api.fetchSecretGrant(held.id)
	if err != nil || grant.ID != held.id || grant.Value == "" {
		if err != nil && !isHTTPNotFound(err) {
			logln("secret grants: fetching grant", held.id, "again failed; its file's own content is scrubbed until it can be:", secretErrorLine(err))
		}
		return
	}
	s.mu.Lock()
	held.value, held.fetched = grant.Value, true
	s.rebuildScrubLocked()
	s.mu.Unlock()
}

// secretFileComplete reports whether a ledger entry's file is the one written, with something in it.
func secretFileComplete(entry secretLedgerEntry) bool {
	if !entry.Written {
		return false
	}
	state, size := inspectSecretFile(entry.Path, entry.Dev, entry.Ino)
	return state == secretFileOurs && size > 0
}

// deliver fetches one grant, materialises it and acks it. Caller holds reconcileMu.
func (s *secretStore) deliver(id string) {
	grant, err := s.api.fetchSecretGrant(id)
	if err != nil {
		if !isHTTPNotFound(err) {
			logln("secret grants: fetching grant", id, "failed; it is asked for again on the next heartbeat:", secretErrorLine(err))
		}
		return
	}
	expires, err := time.Parse(time.RFC3339Nano, grant.ExpiresAt)
	if err != nil || grant.ID != id || grant.Value == "" {
		s.ackFailed(id, "SECRET_GRANT_UNREADABLE", "The runner could not read the grant it was sent.")
		return
	}
	held := &heldSecret{
		id: id, exposure: grant.Exposure, sessionID: grant.SessionID, taskID: grant.TaskID,
		expiresAt: expires, value: grant.Value, fetched: true, revoked: make(chan struct{}),
	}
	switch grant.Exposure {
	case secretExposureEnv:
		if err := checkSecretEnvVar(grant.Name); err != nil {
			s.ackFailed(id, "SECRET_ENV_INVALID", err.Error())
			return
		}
		held.name = grant.Name
	case secretExposureFile:
		target, err := checkSecretFilePath(grant.FilePath, s.workDirs())
		if err == nil {
			held.path = target.path
			err = s.writeFile(held, target)
		}
		if err != nil {
			code := "SECRET_WRITE_FAILED"
			var refused *secretPathError
			if errors.As(err, &refused) {
				code = refused.code
			}
			logln("secret grants: grant", id, "could not be written to", grant.FilePath+":", err)
			s.ackFailed(id, code, err.Error())
			return
		}
	default:
		s.ackFailed(id, "SECRET_EXPOSURE_UNKNOWN", "The runner does not know this exposure.")
		return
	}
	s.mu.Lock()
	s.held[id] = held
	s.rebuildScrubLocked()
	s.mu.Unlock()
	s.ack(held)
}

// writeFile writes a FILE grant, its ledger entry first. A failure leaves neither the file nor the entry.
func (s *secretStore) writeFile(held *heldSecret, target *secretFileTarget) error {
	if err := s.updateLedger(held.id, func(e *secretLedgerEntry) {
		*e = secretLedgerEntry{GrantID: held.id, Path: target.path, ExpiresAt: held.expiresAt,
			SessionID: held.sessionID, TaskID: held.taskID}
	}); err != nil {
		return fmt.Errorf("cannot record the file in the ledger: %w", err)
	}
	var created []string
	_, _, err := writeSecretFile(target, []byte(held.value), func(dir string) error {
		created = append(created, dir)
		return s.updateLedger(held.id, func(e *secretLedgerEntry) { e.Parents = append([]string(nil), created...) })
	}, func(dev, ino uint64) error {
		return s.updateLedger(held.id, func(e *secretLedgerEntry) { e.Dev, e.Ino, e.Written = dev, ino, true })
	})
	if err != nil {
		removeEmptySecretParents(created)
		if dropErr := s.dropLedger(held.id); dropErr != nil {
			logln("secret grants: cannot write the ledger:", dropErr)
		}
		return err
	}
	return nil
}

// ack reports a held grant delivered. 404 means the grant this runner materialised is no longer the one the control
// plane is delivering (the owner submitted again, or it ended), so what was materialised goes. Any other failure
// leaves it unacknowledged, to be acked on the next heartbeat. Caller holds reconcileMu.
func (s *secretStore) ack(held *heldSecret) {
	err := s.api.ackSecretGrant(held.id, SecretGrantAck{Outcome: secretAckDelivered})
	if isHTTPNotFound(err) {
		s.remove(held.id)
		return
	}
	if err != nil {
		logln("secret grants: acknowledging grant", held.id, "failed; it is acknowledged on the next heartbeat:", secretErrorLine(err))
		return
	}
	s.mu.Lock()
	held.acked = true
	s.mu.Unlock()
	if held.exposure == secretExposureFile {
		if err := s.updateLedger(held.id, func(e *secretLedgerEntry) { e.Acked = true }); err != nil {
			logln("secret grants: cannot write the ledger:", err)
		}
	}
}

func (s *secretStore) ackFailed(id, code, message string) {
	if err := s.api.ackSecretGrant(id, SecretGrantAck{Outcome: secretAckFailed, Code: code, Message: clip(message, 500)}); err != nil && !isHTTPNotFound(err) {
		logln("secret grants: reporting grant", id, "undeliverable failed:", secretErrorLine(err))
	}
}

// remove drops one grant from this machine and returns the removal note, "" when there is nothing to say. An ENV
// grant leaves memory and its leases are revoked; a FILE grant's file goes when it is still the one written.
func (s *secretStore) remove(id string) string {
	// While the value is still known: a commit holding it is recorded before it can no longer be recognised.
	s.mu.Lock()
	value := secretValue("")
	if held := s.held[id]; held != nil {
		value = held.value
	}
	s.mu.Unlock()
	if value != "" {
		recordBeforeForget(newSecretRedactor([]string{string(value)}))
	}
	s.mu.Lock()
	held := s.held[id]
	delete(s.held, id)
	var entry *secretLedgerEntry
	if i := s.ledgerIndexLocked(id); i >= 0 {
		copied := s.ledger[i]
		entry = &copied
	}
	s.rebuildScrubLocked()
	s.mu.Unlock()
	if held != nil {
		close(held.revoked)
	}
	note := ""
	if entry != nil {
		note = s.removeFileEntry(*entry)
		if err := s.dropLedger(id); err != nil {
			logln("secret grants: cannot write the ledger:", err)
		}
	}
	if held != nil || entry != nil {
		logln("secret grants: grant", id, "removed from this runner")
	}
	return note
}

// removeFileEntry unlinks a ledger entry's file if it is still the one the runner wrote, and the empty directories it
// created. What it finds otherwise is the note the owner's card shows.
func (s *secretStore) removeFileEntry(entry secretLedgerEntry) string {
	if !entry.Written {
		if state, size := inspectSecretFileUnrecorded(entry.Path); state == secretFileOurs && size == 0 {
			_ = os.Remove(entry.Path)
		}
		removeEmptySecretParents(entry.Parents)
		return ""
	}
	state, err := unlinkSecretFile(entry.Path, entry.Dev, entry.Ino)
	removeEmptySecretParents(entry.Parents)
	switch {
	case err != nil:
		return fmt.Sprintf("The file at %s could not be deleted: %s", entry.Path, firstLine(err.Error()))
	case state == secretFileReplaced:
		return fmt.Sprintf("A different file now stands at %s, so Orbit left it in place.", entry.Path)
	}
	return ""
}

// owe records that a grant must be reported removed.
func (s *secretStore) owe(id, note string) {
	s.mu.Lock()
	s.owedRem[id] = note
	s.mu.Unlock()
}

// flushRemoved reports every owed removal, keeping the ones that did not get through for the next try. A 404 ends
// the retries: the control plane has nothing left to mark.
func (s *secretStore) flushRemoved() {
	if s == nil {
		return
	}
	s.mu.Lock()
	owed := make(map[string]string, len(s.owedRem))
	for id, note := range s.owedRem {
		owed[id] = note
	}
	s.mu.Unlock()
	for id, note := range owed {
		err := s.api.removedSecretGrant(id, clip(note, 500))
		if err != nil && !isHTTPNotFound(err) {
			continue
		}
		s.mu.Lock()
		if s.owedRem[id] == note {
			delete(s.owedRem, id)
		}
		s.mu.Unlock()
	}
}

// --- what sessions see ------------------------------------------------------------------------------------------

// rebuildScrubLocked rebuilds the scrubber over every value held. Caller holds s.mu.
func (s *secretStore) rebuildScrubLocked() {
	values := make([]string, 0, len(s.held))
	for _, held := range s.held {
		if held.value != "" {
			values = append(values, string(held.value))
		}
	}
	if len(values) == 0 {
		s.scrub = nil
		return
	}
	s.scrub = newSecretRedactor(values)
}

// scrubber is the redactor over every value held now, nil when none is.
func (s *secretStore) scrubber() *integrationOutputRedactor {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.scrub
}

// scrubPayload is an event's payload with every held value scrubbed out of every string in it (session.go's emit).
func (s *secretStore) scrubPayload(payload map[string]interface{}) map[string]interface{} {
	r := s.scrubber()
	if r == nil || payload == nil {
		return payload
	}
	scrubbed, _ := scrubSecretMap(payload, r)
	return scrubbed
}

// readerHolds reports whether what r reads holds a value this runner holds.
func (s *secretStore) readerHolds(r io.Reader) (bool, error) {
	red := s.scrubber()
	if red == nil {
		return false, nil
	}
	return readerHoldsSecret(r, red)
}

// errSecretLeaseRefused is a lease the store will not give, worded for the command that asked.
type errSecretLeaseRefused struct{ msg string }

func (e *errSecretLeaseRefused) Error() string { return e.msg }

// lease finds the ENV grant named name that this session may use: one delivered for this session, or for its task.
func (s *secretStore) lease(name, sessionID, taskID string) (*heldSecret, error) {
	if s == nil {
		return nil, &errSecretLeaseRefused{"this runner holds no secrets"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var named, pending bool
	for _, held := range s.held {
		if held.exposure != secretExposureEnv || held.name != name {
			continue
		}
		named = true
		sameSession := held.sessionID != "" && sessionID != "" && decodeSessionID(held.sessionID) == decodeSessionID(sessionID)
		sameTask := held.taskID != "" && taskID != "" && decodeSessionID(held.taskID) == decodeSessionID(taskID)
		if !sameSession && !sameTask {
			continue
		}
		if !held.acked {
			pending = true
			continue
		}
		return held, nil
	}
	switch {
	case pending:
		return nil, &errSecretLeaseRefused{fmt.Sprintf("the secret %s is still being delivered; try again in a moment", name)}
	case named:
		return nil, &errSecretLeaseRefused{fmt.Sprintf("the secret %s was delivered for another session or task, not this one", name)}
	}
	return nil, &errSecretLeaseRefused{fmt.Sprintf("this runner holds no secret %s for this session. Ask the owner for it with request_owner_action (kind SECRET, envVar %s)", name, name)}
}

// isHTTPNotFound reports a 404 from the control plane.
func isHTTPNotFound(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound
}

// secretErrorLine is an error as one log line. A control-plane refusal's body never carries a value; the line is
// still cut to its first line, so a body is not dumped whole.
func secretErrorLine(err error) string {
	return clip(strings.TrimSpace(firstLine(err.Error())), 300)
}

// secretStartupWait bounds how long a session waits, after the runner starts, for the first reconcile.
const secretStartupWait = 30 * time.Second

// secretExpiryInterval is how often a running runner checks its grants' expiries.
const secretExpiryInterval = time.Minute

// secretReconciler applies heartbeat answers to a store off the heartbeat's goroutine, one at a time. Answers that
// arrive while one is applied are merged: the latest list stands for the earlier ones, since each is the whole set,
// and the removals add up.
type secretReconciler struct {
	store    *secretStore
	mu       sync.Mutex
	pending  bool
	grants   *[]SecretGrantRef
	removing []string
	kick     chan struct{}
}

func newSecretReconciler(store *secretStore) *secretReconciler {
	return &secretReconciler{store: store, kick: make(chan struct{}, 1)}
}

// post hands over one heartbeat answer's two fields.
func (r *secretReconciler) post(grants *[]SecretGrantRef, removing []string) {
	r.mu.Lock()
	r.pending = true
	if grants != nil {
		r.grants = grants
	}
	r.removing = append(r.removing, removing...)
	r.mu.Unlock()
	select {
	case r.kick <- struct{}{}:
	default:
	}
}

// run applies what is posted, and sweeps expiries every `every`, until ctx ends.
func (r *secretReconciler) run(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.kick:
			r.mu.Lock()
			pending, grants, removing := r.pending, r.grants, r.removing
			r.pending, r.grants, r.removing = false, nil, nil
			r.mu.Unlock()
			if pending {
				r.store.reconcile(grants, removing)
			}
		case <-ticker.C:
			r.store.expire()
		}
	}
}
