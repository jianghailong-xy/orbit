package main

// Codex account slots: the Codex accounts one runner can sign in and run sessions on.
//
// Codex keeps an account's login, config and history in its CODEX_HOME, so a second account on
// the same machine is a second CODEX_HOME, and a slot is the runner's name for one. Default is the
// CODEX_HOME the runner's own environment already selects (effectiveCodexHome: CODEX_HOME, else
// ~/.codex). It is only ever resolved — never created, moved, copied or renamed here — so `codex`
// typed in a terminal keeps sharing its login with Orbit. Every other slot is a private directory
// the runner makes under $ORBIT_HOME/codex-accounts. What the runner knows about one (the name the
// user gave the account, when it was added) is kept beside it in <slot>.json, never inside a
// CODEX_HOME: that directory belongs to Codex.

import (
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

// codexAccountDefaultSlot is the id of the slot every runner has.
const codexAccountDefaultSlot = "default"

// An added slot's id is 4 random bytes in lowercase hex: short, one spelling even on a
// case-insensitive disk, never derived from the account's name (which the user may change), and
// never equal to the default slot's id.
var codexAccountSlotIDPattern = regexp.MustCompile(`^[0-9a-f]{8}$`)

type codexAccountSlot struct {
	ID string
	// Name is what the user called the account; empty for Default, and for an added slot whose
	// record is missing or unreadable.
	Name string
	// CodexHome is absolute: app-servers are spawned from directories other than the runner's.
	CodexHome string
	// CreatedAt is zero for Default, which the runner did not create.
	CreatedAt time.Time
}

// codexAccountSlotMeta is the record kept beside an added slot.
type codexAccountSlotMeta struct {
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

func codexAccountsDir() (string, error) {
	return filepath.Abs(filepath.Join(machineHome(), "codex-accounts"))
}

func codexAccountSlotMetaPath(root, id string) string {
	return filepath.Join(root, id+".json")
}

func defaultCodexAccountSlot() (codexAccountSlot, error) {
	cwd, _ := os.Getwd()
	home, err := effectiveCodexHome(os.Environ(), cwd)
	if err != nil {
		return codexAccountSlot{}, err
	}
	return codexAccountSlot{ID: codexAccountDefaultSlot, CodexHome: home}, nil
}

// existingCodexAccountDir refuses what ensurePrivateCodexDir refuses — a symbolic link, or
// anything that is not a directory — without creating or chmodding anything: resolving and
// listing slots only read.
func existingCodexAccountDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s is not a private directory", dir)
	}
	return nil
}

// codexAccountSlotHome resolves a slot id to the CODEX_HOME a Codex process on that account runs
// with. An added slot must already exist: an unknown id is an error wrapping fs.ErrNotExist,
// never a new, empty account.
func codexAccountSlotHome(id string) (string, error) {
	if id == codexAccountDefaultSlot {
		slot, err := defaultCodexAccountSlot()
		return slot.CodexHome, err
	}
	if !codexAccountSlotIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid codex account slot %q", id)
	}
	root, err := codexAccountsDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, id)
	for _, d := range []string{root, dir} {
		if err := existingCodexAccountDir(d); err != nil {
			return "", fmt.Errorf("codex account slot %q: %w", id, err)
		}
	}
	return dir, nil
}

// listCodexAccountSlots returns every slot on this machine: Default first, then the added ones in
// the order they were added. A machine that never added an account has no codex-accounts
// directory, and listing does not create one.
func listCodexAccountSlots() ([]codexAccountSlot, error) {
	def, err := defaultCodexAccountSlot()
	if err != nil {
		return nil, err
	}
	slots := []codexAccountSlot{def}
	root, err := codexAccountsDir()
	if err != nil {
		return nil, err
	}
	if err := existingCodexAccountDir(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return slots, nil
		}
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var added []codexAccountSlot
	for _, entry := range entries {
		// Entries are typed without following links, so a link named like a slot is not one.
		if !entry.IsDir() || !codexAccountSlotIDPattern.MatchString(entry.Name()) {
			continue
		}
		slot := codexAccountSlot{ID: entry.Name(), CodexHome: filepath.Join(root, entry.Name())}
		// The directory is the account; a slot whose record is lost still lists, unnamed.
		if meta, err := readCodexAccountSlotMeta(root, slot.ID); err == nil {
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

func readCodexAccountSlotMeta(root, id string) (codexAccountSlotMeta, error) {
	var meta codexAccountSlotMeta
	b, err := os.ReadFile(codexAccountSlotMetaPath(root, id))
	if err != nil {
		return meta, err
	}
	err = json.Unmarshal(b, &meta)
	return meta, err
}

// createCodexAccountSlot adds a slot for an account the user named: a new, empty directory under
// $ORBIT_HOME/codex-accounts, made private the way ensurePrivateCodexDir makes one, with its record
// beside it. Signing in is what fills the directory.
func createCodexAccountSlot(name string) (codexAccountSlot, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return codexAccountSlot{}, fmt.Errorf("a codex account needs a name")
	}
	root, err := codexAccountsDir()
	if err != nil {
		return codexAccountSlot{}, err
	}
	if err := ensurePrivateCodexDir(root); err != nil {
		return codexAccountSlot{}, err
	}
	var id [4]byte
	if _, err := rand.Read(id[:]); err != nil {
		return codexAccountSlot{}, err
	}
	slot := codexAccountSlot{ID: hex.EncodeToString(id[:]), Name: name, CreatedAt: time.Now().UTC()}
	slot.CodexHome = filepath.Join(root, slot.ID)
	// Mkdir, not MkdirAll: whatever is already at this path — a slot, a file, a link — is refused
	// rather than adopted.
	if err := os.Mkdir(slot.CodexHome, machineHomePerm); err != nil {
		return codexAccountSlot{}, err
	}
	ok := false
	defer func() {
		if !ok {
			// Still empty: nothing has signed in to it yet.
			_ = os.Remove(slot.CodexHome)
		}
	}()
	// The umask may have narrowed Mkdir's mode; this sets it to exactly 0700.
	if err := ensurePrivateCodexDir(slot.CodexHome); err != nil {
		return codexAccountSlot{}, err
	}
	meta, err := json.Marshal(codexAccountSlotMeta{Name: slot.Name, CreatedAt: slot.CreatedAt})
	if err != nil {
		return codexAccountSlot{}, err
	}
	if err := writeFileAtomically(codexAccountSlotMetaPath(root, slot.ID), meta, 0o600); err != nil {
		return codexAccountSlot{}, err
	}
	ok = true
	return slot, nil
}
