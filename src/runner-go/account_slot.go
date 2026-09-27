package main

// Account slots: one CLI account on this machine is one directory the CLI keeps its login state in
// — Codex's CODEX_HOME, Claude Code's CLAUDE_CONFIG_DIR — and the slot id is this runner's own name
// for it. Everything else follows from that one fact: what the page lists, which directory a
// session runs in, what a removal deletes, whose quota a read belongs to.
//
// This file is the store every engine's accounts share, and it is the part that has to be right
// rather than the part that is convenient: a slot is a private directory (0700) never adopted
// through a link, `default` — the directory the runner's own environment already selects, the one
// a CLI typed in a terminal shares — is never created, renamed or removed here, and a removal is
// idempotent because the control plane redelivers it until this runner reports an outcome.
//
// What is deliberately NOT here is anything an engine does with its accounts: Codex's state
// partitions, rate-limit reset blocks and account fingerprints; Claude's per-account credentials
// file; what a session on an account is allowed to do. Those live with their engine. A kind is the
// whole of what a second — or third — engine has to add.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// accountSlotDefaultID is the id of the slot every machine has: the directory its own environment
// selects, which no listing creates and no removal takes away.
const accountSlotDefaultID = "default"

// An added slot's id is 4 random bytes in lowercase hex: short, one spelling even on a
// case-insensitive disk, never derived from the account's name (which the user may change), and
// never equal to the default slot's id.
var accountSlotIDPattern = regexp.MustCompile(`^[0-9a-f]{8}$`)

// accountSlot is one account directory on this machine.
type accountSlot struct {
	ID string
	// Name is what the user called the account; empty for Default, and for an added slot whose
	// record is missing or unreadable.
	Name string
	// Dir is the directory the CLI keeps this account's login in, absolute: engines are spawned
	// from directories other than the runner's, so a relative one would resolve elsewhere.
	Dir string
	// CreatedAt is zero for Default, which the runner did not create.
	CreatedAt time.Time
}

// accountSlotMeta is the record kept beside an added slot.
type accountSlotMeta struct {
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// accountSlotKind is what one engine brings to the account store: where its slots live, which
// variable hands a directory to the CLI, and the two questions only the engine can answer — is
// this directory signed in, and is one of them a session this runner is currently running.
type accountSlotKind struct {
	// engine is the provider name a login/removal request names (providerClaude, providerCodex).
	engine string
	// varName is the environment variable that selects a directory for this CLI.
	varName string
	// dirName is the slots root's name under $ORBIT_HOME.
	dirName string
	// resolveDefault is the directory the runner's own environment resolves: Default's, and the
	// only one the runner did not create.
	resolveDefault func(env []string, cwd string) (string, error)
	// loginStatus asks the CLI, in that directory's environment, whether it is signed in.
	loginStatus func(ctx context.Context, binPath, dir string) authState
	// liveDirs is every directory in sessionIDs that a running session is stuck to, as removal
	// reads it: the ground under a turn in flight must not be pulled away.
	liveDirs func(sessionIDs []string) map[string]bool
}

// accountSlotKinds is every engine whose CLI keeps a login per directory, in the order a report
// lists them. Registered from each engine's own file so that adding an engine is adding a file.
var accountSlotKinds []accountSlotKind

// accountSlotKindFor finds the kind an engine name belongs to, or false: an engine whose CLI has
// one login for the whole machine (Kimi, OpenCode today) simply has no accounts.
func accountSlotKindFor(engine string) (accountSlotKind, bool) {
	for _, kind := range accountSlotKinds {
		if kind.engine == engine {
			return kind, true
		}
	}
	return accountSlotKind{}, false
}

// accountSlotsDir is where this engine's added slots live: <orbit home>/<engine>-accounts. The
// directory itself is created by the first slot, not by listing.
func accountSlotsDir(kind accountSlotKind) (string, error) {
	return filepath.Abs(filepath.Join(machineHome(), kind.dirName))
}

func accountSlotMetaPath(root, id string) string {
	return filepath.Join(root, id+".json")
}

// defaultAccountSlot is the slot the runner's own environment selects — never created here, and
// the only one that survives every removal.
func defaultAccountSlot(kind accountSlotKind) (accountSlot, error) {
	cwd, _ := os.Getwd()
	dir, err := kind.resolveDefault(os.Environ(), cwd)
	if err != nil {
		return accountSlot{}, err
	}
	return accountSlot{ID: accountSlotDefaultID, Dir: dir}, nil
}

// existingPrivateAccountDir refuses what ensurePrivateDir refuses — a symbolic link, or anything
// that is not a directory — without creating or chmodding anything: resolving and listing slots
// only read.
func existingPrivateAccountDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s is not a private directory", dir)
	}
	return nil
}

// home resolves a slot id to the directory a CLI on that account runs with. An added slot must
// already exist: an unknown id is an error wrapping fs.ErrNotExist, never a new, empty account.
func (kind accountSlotKind) home(id string) (string, error) {
	if id == accountSlotDefaultID {
		slot, err := defaultAccountSlot(kind)
		return slot.Dir, err
	}
	if !accountSlotIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid %s account slot %q", kind.engine, id)
	}
	root, err := accountSlotsDir(kind)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, id)
	// The root as well as the slot: a linked slots directory would make every path under it
	// somebody else's, whatever the entries themselves look like.
	for _, d := range []string{root, dir} {
		if err := existingPrivateAccountDir(d); err != nil {
			return "", fmt.Errorf("%s account %s: %w", kind.engine, id, err)
		}
	}
	return dir, nil
}

// list returns every slot on this machine: Default first, then the added ones in the order they
// were added. A machine that never added an account has no slots directory, and listing does not
// create one.
func (kind accountSlotKind) list() ([]accountSlot, error) {
	def, err := defaultAccountSlot(kind)
	if err != nil {
		return nil, err
	}
	slots := []accountSlot{def}
	root, err := accountSlotsDir(kind)
	if err != nil {
		return nil, err
	}
	if err := existingPrivateAccountDir(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return slots, nil
		}
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var added []accountSlot
	for _, entry := range entries {
		// Entries are typed without following links, so a link named like a slot is not one.
		if !entry.IsDir() || !accountSlotIDPattern.MatchString(entry.Name()) {
			continue
		}
		slot := accountSlot{ID: entry.Name(), Dir: filepath.Join(root, entry.Name())}
		// The directory is the account; a slot whose record is lost still lists, unnamed.
		if meta, err := readAccountSlotMeta(root, slot.ID); err == nil {
			slot.Name, slot.CreatedAt = meta.Name, meta.CreatedAt
		}
		added = append(added, slot)
	}
	sort.Slice(added, func(i, j int) bool {
		if !added[i].CreatedAt.Equal(added[j].CreatedAt) {
			return added[i].CreatedAt.Before(added[j].CreatedAt)
		}
		return added[i].ID < added[j].ID
	})
	return append(slots, added...), nil
}

func readAccountSlotMeta(root, id string) (accountSlotMeta, error) {
	var meta accountSlotMeta
	b, err := os.ReadFile(accountSlotMetaPath(root, id))
	if err != nil {
		return meta, err
	}
	err = json.Unmarshal(b, &meta)
	return meta, err
}

// createAccountSlot adds a slot for an account the user named: a new, empty directory under
// $ORBIT_HOME/<engine>-accounts, made private the way ensurePrivateDir makes one, with its record
// beside it. Signing in is what fills the directory.
func (kind accountSlotKind) create(name string) (accountSlot, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return accountSlot{}, fmt.Errorf("a %s account needs a name", kind.engine)
	}
	root, err := accountSlotsDir(kind)
	if err != nil {
		return accountSlot{}, err
	}
	if err := ensurePrivateDir(root); err != nil {
		return accountSlot{}, err
	}
	var id [4]byte
	if _, err := rand.Read(id[:]); err != nil {
		return accountSlot{}, err
	}
	slot := accountSlot{ID: hex.EncodeToString(id[:]), Name: name, CreatedAt: time.Now().UTC()}
	slot.Dir = filepath.Join(root, slot.ID)
	// Mkdir, not MkdirAll: whatever is already at this path — a slot, a file, a link — is refused
	// rather than adopted.
	if err := os.Mkdir(slot.Dir, machineHomePerm); err != nil {
		return accountSlot{}, err
	}
	ok := false
	defer func() {
		if !ok {
			// Still empty: nothing has signed in to it yet.
			_ = os.Remove(slot.Dir)
		}
	}()
	// The umask may have narrowed Mkdir's mode; this sets it to exactly 0700.
	if err := ensurePrivateDir(slot.Dir); err != nil {
		return accountSlot{}, err
	}
	meta, err := json.Marshal(accountSlotMeta{Name: slot.Name, CreatedAt: slot.CreatedAt})
	if err != nil {
		return accountSlot{}, err
	}
	if err := writeFileAtomically(accountSlotMetaPath(root, slot.ID), meta, 0o600); err != nil {
		return accountSlot{}, err
	}
	ok = true
	return slot, nil
}

// removeAccount carries out one removal for whichever engine asked: the slot's directory and record
// go, and so does everything this runner reads for that account — its usage probe is stopped with
// the directory it reads, which is the one part of a removal that has to know the engine.
func removeAccount(kind accountSlotKind, claudeUsage *claudeAccountUsage, codexUsage *codexAccountUsage, id string, liveDirs map[string]bool) error {
	switch kind.engine {
	case providerClaude:
		return removeClaudeAccount(claudeUsage, id, liveDirs)
	case providerCodex:
		return removeCodexAccount(codexUsage, id, liveDirs)
	}
	return kind.remove(id, liveDirs)
}

// removeAccountSlot removes added slot id from this machine: its own directory with everything the
// CLI keeps in it, and the record beside it. Nothing else is touched — Default least of all, which
// is the directory the runner's own environment selects.
//
// liveDirs is every directory a session this runner is running is stuck to (kind.liveDirs). A slot
// one of them has is refused: the session's thread lives in that directory and its engine is
// running out of it, so removing it would pull the ground out from under a turn in flight. The
// caller stops the slot's usage probe with it (the engine's forget): a read that outlived the
// directory would report an account the runner no longer has.
func (kind accountSlotKind) remove(id string, liveDirs map[string]bool) error {
	if id == accountSlotDefaultID {
		return fmt.Errorf("Default is this machine's own %s and cannot be removed", kind.varName)
	}
	if !accountSlotIDPattern.MatchString(id) {
		return fmt.Errorf("invalid %s account slot %q", kind.engine, id)
	}
	root, err := accountSlotsDir(kind)
	if err != nil {
		return err
	}
	dir := filepath.Join(root, id)
	if err := existingPrivateAccountDir(dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%s account slot %q: %w", kind.engine, id, err)
	}
	if liveDirs[dir] {
		return fmt.Errorf("%s account %s is in use by a session running on this machine — end that session, then remove it", kind.engine, id)
	}
	// Idempotent on purpose: the removal is redelivered until this runner reports an outcome, so a
	// slot already gone is the state that was asked for, not an error.
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("could not remove %s account %s: %w", kind.engine, id, err)
	}
	// The record is the runner's own, kept beside the account's directory: gone with it, or a later
	// slot drawing the same id would inherit a name it was never given.
	if err := os.Remove(accountSlotMetaPath(root, id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("could not remove %s account %s: %w", kind.engine, id, err)
	}
	return nil
}
