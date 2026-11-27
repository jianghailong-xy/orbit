package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// fakeSecurityEnv names the directory the fake `security` keeps its Keychain and call log in. The test
// binary is the fake: claudeSecurityBin points at a script that sets this and execs the binary.
const fakeSecurityEnv = "ORBIT_TEST_FAKE_SECURITY_DIR"

func init() {
	if dir := os.Getenv(fakeSecurityEnv); dir != "" {
		os.Exit(runFakeSecurity(dir, os.Args[1:]))
	}
}

// fakeKeychainItem is one generic-password item of the fake login Keychain.
type fakeKeychainItem struct {
	Service  string `json:"service"`
	Account  string `json:"account"`
	Password []byte `json:"password"`
}

func fakeKeychainItemPath(dir, service string) string {
	return filepath.Join(dir, "items", hex.EncodeToString([]byte(service))+".json")
}

// runFakeSecurity answers the `security` subcommands the swap uses, with real `security`'s exit codes
// (44 for an item not found, 45 for a duplicate), logs every argv, and refuses interactive mode
// outright: `security -i` cuts input lines at LINE_MAX, so no write may go through it.
func runFakeSecurity(dir string, args []string) int {
	logLine, _ := json.Marshal(args)
	if f, err := os.OpenFile(filepath.Join(dir, "calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		f.Write(append(logLine, '\n'))
		f.Close()
	}
	if _, err := os.Stat(filepath.Join(dir, "block")); err == nil {
		time.Sleep(time.Minute) // a Keychain dialog nobody answers
	}
	if len(args) == 0 || args[0] == "-i" || strings.HasPrefix(args[0], "-") {
		fmt.Fprintln(os.Stderr, "fake security: interactive mode and global options are not allowed")
		return 2
	}
	flags := map[string]string{}
	bools := map[string]bool{}
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "-w":
			if args[0] == "find-generic-password" {
				bools["-w"] = true
				continue
			}
			fallthrough
		case "-s", "-a", "-X":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "fake security: missing value for", args[i])
				return 2
			}
			flags[args[i]] = args[i+1]
			i++
		case "-U":
			bools["-U"] = true
		default:
			fmt.Fprintln(os.Stderr, "fake security: unexpected argument", args[i])
			return 2
		}
	}
	path := fakeKeychainItemPath(dir, flags["-s"])
	var item fakeKeychainItem
	b, err := os.ReadFile(path)
	found := err == nil && json.Unmarshal(b, &item) == nil
	if a, ok := flags["-a"]; ok && found && item.Account != a {
		found = false
	}
	switch args[0] {
	case "find-generic-password":
		if !found {
			fmt.Fprintln(os.Stderr, "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.")
			return 44
		}
		if bools["-w"] {
			os.Stdout.Write(append(item.Password, '\n'))
			return 0
		}
		fmt.Printf("keychain: \"/Users/me/Library/Keychains/login.keychain-db\"\nversion: 512\nclass: \"genp\"\nattributes:\n    \"acct\"<blob>=%q\n    \"svce\"<blob>=%q\n", item.Account, item.Service)
		return 0
	case "add-generic-password":
		var pw []byte
		if x, ok := flags["-X"]; ok {
			if pw, err = hex.DecodeString(x); err != nil {
				fmt.Fprintln(os.Stderr, "fake security: bad hex")
				return 2
			}
		} else {
			pw = []byte(flags["-w"])
		}
		if found && !bools["-U"] {
			fmt.Fprintln(os.Stderr, "security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.")
			return 45
		}
		if _, err := os.Stat(filepath.Join(dir, "refuse-add")); err == nil {
			fmt.Fprintln(os.Stderr, "security: write refused")
			return 1
		}
		item = fakeKeychainItem{Service: flags["-s"], Account: flags["-a"], Password: pw}
		out, _ := json.Marshal(item)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil || os.WriteFile(path, out, 0o600) != nil {
			return 1
		}
		return 0
	case "delete-generic-password":
		if !found {
			fmt.Fprintln(os.Stderr, "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.")
			return 44
		}
		if err := os.Remove(path); err != nil {
			return 1
		}
		return 0
	}
	fmt.Fprintln(os.Stderr, "fake security: unknown command", args[0])
	return 2
}

// fakeSecurity is the fake Keychain one test runs against.
type fakeSecurity struct{ dir string }

func newFakeSecurity(t *testing.T) *fakeSecurity {
	t.Helper()
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "security")
	body := "#!/bin/sh\n" + fakeSecurityEnv + "=" + shellQuote(dir) + " exec " + shellQuote(exe) + " \"$@\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	old := claudeSecurityBin
	claudeSecurityBin = script
	t.Cleanup(func() { claudeSecurityBin = old })
	return &fakeSecurity{dir: dir}
}

func (k *fakeSecurity) put(t *testing.T, service, account string, password []byte) {
	t.Helper()
	b, _ := json.Marshal(fakeKeychainItem{Service: service, Account: account, Password: password})
	path := fakeKeychainItemPath(k.dir, service)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// items is every item of the fake Keychain, by service.
func (k *fakeSecurity) items(t *testing.T) map[string]fakeKeychainItem {
	t.Helper()
	out := map[string]fakeKeychainItem{}
	entries, _ := os.ReadDir(filepath.Join(k.dir, "items"))
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(k.dir, "items", e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var item fakeKeychainItem
		if err := json.Unmarshal(b, &item); err != nil {
			t.Fatal(err)
		}
		out[item.Service] = item
	}
	return out
}

// calls is every argv the fake was run with; assertNoInteractive fails the test on any `security -i`.
func (k *fakeSecurity) calls(t *testing.T) [][]string {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(k.dir, "calls.log"))
	var out [][]string
	for _, line := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var argv []string
		if err := json.Unmarshal(line, &argv); err != nil {
			t.Fatal(err)
		}
		out = append(out, argv)
	}
	return out
}

func (k *fakeSecurity) assertNoInteractive(t *testing.T) {
	t.Helper()
	writes := 0
	for _, argv := range k.calls(t) {
		for _, a := range argv {
			if a == "-i" {
				t.Errorf("security was run in interactive mode: %q", argv)
			}
		}
		if len(argv) > 0 && argv[0] == "add-generic-password" {
			writes++
		}
	}
	t.Logf("security: %d calls, %d argv writes, none interactive", len(k.calls(t)), writes)
}

// claudeSwapLargeMCP is an mcpOAuth entry well past LINE_MAX (2048 on macOS), doubled again by hex.
func claudeSwapLargeMCP() string {
	return `{"linear|1":{"accessToken":"mcp-default","refreshToken":"` + strings.Repeat("m", 6000) + `"},"github|2":{"accessToken":"mcp-gh"}}`
}

// claudeSwapStorage is where one folder of a fixture keeps its login.
type claudeSwapStorage string

const (
	inKeychain claudeSwapStorage = "keychain"
	inFile     claudeSwapStorage = "file"
)

// newClaudeSwapFixtureStored is the swap fixture with each folder's login in the given storage, the
// Keychain ones in a fake Keychain the swap reaches through the fake `security`. Default's blob
// carries an mcpOAuth past LINE_MAX. A Keychain folder also has a stale .credentials.json, which the
// CLI does not read and the swap must not touch.
func newClaudeSwapFixtureStored(t *testing.T, defStore, acctStore claudeSwapStorage) (*claudeSwapFixture, *fakeSecurity) {
	t.Helper()
	f := newClaudeSwapFixture(t)
	k := newFakeSecurity(t)
	f.store = claudeKeychainCredentials{}
	defCreds := filepath.Join(f.def.dir, ".credentials.json")
	big := []byte(strings.Replace(string(f.files[defCreds]), `{"linear|1":{"accessToken":"mcp-default"}}`, claudeSwapLargeMCP(), 1))
	if len(big) < 4096 {
		t.Fatalf("Default's blob is %d bytes, not past LINE_MAX twice over", len(big))
	}
	f.files[defCreds] = big
	if err := os.WriteFile(defCreds, big, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		folder claudeLoginFolder
		store  claudeSwapStorage
	}{{f.def, defStore}, {f.acct, acctStore}} {
		if c.store != inKeychain {
			continue
		}
		path := filepath.Join(c.folder.dir, ".credentials.json")
		k.put(t, claudeKeychainService(c.folder.envDir), "me", f.files[path])
		stale := []byte(`{"claudeAiOauth":{"accessToken":"stale","refreshToken":"stale"}}`)
		if err := os.WriteFile(path, stale, 0o600); err != nil {
			t.Fatal(err)
		}
		f.files[path] = stale
	}
	f.security = k
	f.before = k.items(t)
	return f, k
}

// claudeSwapCombinations are the storage pairs a Mac can have: both in the Keychain, one each way
// round (the measured Mac: Default in the Keychain, the added folder in its file), both in files.
var claudeSwapCombinations = []struct {
	name            string
	defStore, acctS claudeSwapStorage
}{
	{"keychain-keychain", inKeychain, inKeychain},
	{"keychain-file", inKeychain, inFile},
	{"file-keychain", inFile, inKeychain},
	{"file-file", inFile, inFile},
}

// login is folder's whole credentials blob where it really lives.
func (f *claudeSwapFixture) login(t *testing.T, folder claudeLoginFolder) []byte {
	t.Helper()
	b, err := f.store.read(context.Background(), folder)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// assertKeychainOriginal holds the fake Keychain to the items it had before: same services, accounts
// and password bytes, nothing added.
func (f *claudeSwapFixture) assertKeychainOriginal(t *testing.T, when string) {
	t.Helper()
	got := f.security.items(t)
	var names []string
	for s := range got {
		names = append(names, s)
	}
	sort.Strings(names)
	if len(got) != len(f.before) {
		t.Errorf("%s: Keychain holds %v, want %d items", when, names, len(f.before))
	}
	for s, want := range f.before {
		if g, ok := got[s]; !ok || g.Account != want.Account || !bytes.Equal(g.Password, want.Password) {
			t.Errorf("%s: Keychain item %s is not as it was:\n got %+v\nwant %+v", when, s, g, want)
		}
	}
}

// Each storage pair swaps and verifies: claudeAiOauth moves between whatever the two folders keep it
// in, each keeps its own storage, and mcpOAuth (past LINE_MAX in Default) and every other byte of each
// blob stay; swapping back gives every file and every Keychain item back byte for byte.
func TestClaudeLoginSwapAcrossEveryStoragePair(t *testing.T) {
	for _, c := range claudeSwapCombinations {
		t.Run(c.name, func(t *testing.T) {
			f, k := newClaudeSwapFixtureStored(t, c.defStore, c.acctS)
			defBlob, acctBlob := f.login(t, f.def), f.login(t, f.acct)
			out := f.swap(t).run(context.Background())
			if !out.ok || out.defaultAccountUUID != "uuid-work" || out.accountAccountUUID != "uuid-default" {
				t.Fatalf("swap = %+v", out)
			}
			newDef, newAcct := f.login(t, f.def), f.login(t, f.acct)
			for _, x := range []struct {
				name      string
				got, from []byte
				key       string
			}{
				{"Default claudeAiOauth", newDef, acctBlob, "claudeAiOauth"},
				{"added claudeAiOauth", newAcct, defBlob, "claudeAiOauth"},
				{"Default mcpOAuth", newDef, defBlob, "mcpOAuth"},
				{"added mcpOAuth", newAcct, acctBlob, "mcpOAuth"},
			} {
				if g, w := topValue(t, x.got, x.key), topValue(t, x.from, x.key); g != w {
					t.Errorf("%s = %.80s…, want %.80s…", x.name, g, w)
				}
			}
			for _, x := range []struct{ got, orig []byte }{{newDef, defBlob}, {newAcct, acctBlob}} {
				back, err := jsonReplaceTopLevelValue(x.got, "claudeAiOauth", []byte(topValue(t, x.orig, "claudeAiOauth")))
				if err != nil || !bytes.Equal(back, x.orig) {
					t.Errorf("a blob changed outside claudeAiOauth")
				}
			}
			// Each folder kept its storage: a Keychain folder's stale file and a file folder's absent
			// item are as they were, and the Keychain has exactly the items it had.
			items := k.items(t)
			for _, x := range []struct {
				folder claudeLoginFolder
				store  claudeSwapStorage
				blob   []byte
			}{{f.def, c.defStore, newDef}, {f.acct, c.acctS, newAcct}} {
				item, inKC := items[claudeKeychainService(x.folder.envDir)]
				file, _ := os.ReadFile(filepath.Join(x.folder.dir, ".credentials.json"))
				switch x.store {
				case inKeychain:
					if !inKC || !bytes.Equal(item.Password, x.blob) || !bytes.Equal(file, f.files[filepath.Join(x.folder.dir, ".credentials.json")]) {
						t.Errorf("%s left the Keychain or wrote its stale file", x.folder.label)
					}
				case inFile:
					if inKC || !bytes.Equal(file, x.blob) {
						t.Errorf("%s left its file or gained a Keychain item", x.folder.label)
					}
				}
			}
			if len(items) != len(f.before) {
				t.Errorf("Keychain items %d, want %d", len(items), len(f.before))
			}
			f.owners["at-work"], f.owners["at-default"] = [2]string{"uuid-work", "org-work"}, [2]string{"uuid-default", "org-default"}
			if out := f.swap(t).run(context.Background()); !out.ok {
				t.Fatalf("swap back = %+v", out)
			}
			f.assertOriginal(t, "after swapping back")
			f.assertKeychainOriginal(t, "after swapping back")
			k.assertNoInteractive(t)
		})
	}
}

// A failure after each step, and a refused second credentials write, in each storage pair: both
// folders' files and Keychain items come back byte for byte and the rollback says so.
func TestClaudeLoginSwapFailingInEveryStoragePairRestoresBothLogins(t *testing.T) {
	for _, c := range claudeSwapCombinations {
		for _, step := range []string{claudeSwapStepBackup, claudeSwapStepCredentials, claudeSwapStepOAuthAccount, claudeSwapStepVerify, "second write"} {
			t.Run(c.name+"/"+step, func(t *testing.T) {
				f, k := newClaudeSwapFixtureStored(t, c.defStore, c.acctS)
				s := f.swap(t)
				want := "Rolled back: injected failure after " + step + " — both logins are as they were."
				if step == "second write" {
					s.store = &failingStoreWrite{inner: s.store, failAt: 2}
					want = "Rolled back: disk full — both logins are as they were."
				} else {
					s.after = func(at string) error {
						if at == step {
							return errors.New("injected failure after " + step)
						}
						return nil
					}
				}
				out := s.run(context.Background())
				if out.ok || out.message != want {
					t.Fatalf("swap = %+v, want %q", out, want)
				}
				f.assertOriginal(t, "after a failure after "+step)
				f.assertKeychainOriginal(t, "after a failure after "+step)
				if _, err := os.Stat(s.backupDir); !os.IsNotExist(err) {
					t.Errorf("backup kept after a verified rollback: %v", err)
				}
				k.assertNoInteractive(t)
			})
		}
	}
}

// failingStoreWrite fails the n-th credentials write of any store.
type failingStoreWrite struct {
	inner          claudeCredentialStore
	writes, failAt int
}

func (w *failingStoreWrite) read(ctx context.Context, f claudeLoginFolder) ([]byte, error) {
	return w.inner.read(ctx, f)
}

func (w *failingStoreWrite) remove(ctx context.Context, f claudeLoginFolder) error {
	return w.inner.remove(ctx, f)
}

func (w *failingStoreWrite) write(ctx context.Context, f claudeLoginFolder, blob []byte) error {
	w.writes++
	if w.writes == w.failAt {
		return errors.New("disk full")
	}
	return w.inner.write(ctx, f, blob)
}

// A blob far past LINE_MAX goes into the Keychain and comes back out byte for byte, on the argv as
// hex, the item's own account kept and no second item added.
func TestClaudeKeychainWriteKeepsABlobPastLineMax(t *testing.T) {
	claudeAccountSlotTestHomes(t)
	k := newFakeSecurity(t)
	folder, err := claudeDefaultLoginFolder()
	if err != nil {
		t.Fatal(err)
	}
	service := claudeKeychainService(folder.envDir)
	k.put(t, service, "long", []byte(`{"claudeAiOauth":{"accessToken":"a"}}`))
	blob := []byte(`{"claudeAiOauth":{"accessToken":"at","refreshToken":"rt","expiresAt":1},"mcpOAuth":` + claudeSwapLargeMCP() + `}`)
	if len(blob) <= 2048*2 {
		t.Fatalf("blob is only %d bytes", len(blob))
	}
	store := claudeKeychainCredentials{}
	if err := store.write(context.Background(), folder, blob); err != nil {
		t.Fatal(err)
	}
	got, err := store.read(context.Background(), folder)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("read back %d bytes, wrote %d", len(got), len(blob))
	}
	items := k.items(t)
	if len(items) != 1 || items[service].Account != "long" || !bytes.Equal(items[service].Password, blob) {
		t.Fatalf("Keychain = %+v", items)
	}
	var wrote []string
	for _, argv := range k.calls(t) {
		if argv[0] == "add-generic-password" {
			wrote = argv
		}
	}
	if want := []string{"add-generic-password", "-U", "-s", service, "-a", "long", "-X", hex.EncodeToString(blob)}; strings.Join(wrote, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("write argv = %.120q", wrote)
	}
	if _, err := os.Stat(filepath.Join(folder.dir, ".credentials.json")); !os.IsNotExist(err) {
		t.Errorf("a Keychain folder's write made a .credentials.json: %v", err)
	}
	k.assertNoInteractive(t)
	t.Logf("%d-byte blob (%d hex chars on the argv) round-tripped intact", len(blob), 2*len(blob))
}

// A `security` call that blocks — a Keychain dialog — fails within the timeout with that said, and
// the swap touches nothing.
func TestClaudeLoginSwapWithABlockedKeychainTouchesNothing(t *testing.T) {
	f, k := newClaudeSwapFixtureStored(t, inKeychain, inFile)
	old := claudeKeychainTimeout
	claudeKeychainTimeout = 500 * time.Millisecond
	t.Cleanup(func() { claudeKeychainTimeout = old })
	if err := os.WriteFile(filepath.Join(k.dir, "block"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	out := f.swap(t).run(context.Background())
	if out.ok || !strings.Contains(out.message, "the Keychain did not answer for Default within 500ms (a Keychain dialog?)") {
		t.Fatalf("swap = %+v", out)
	}
	if d := time.Since(start); d > 20*time.Second {
		t.Fatalf("a blocked call held the swap for %s", d)
	}
	os.Remove(filepath.Join(k.dir, "block"))
	f.assertOriginal(t, "after a blocked Keychain")
	f.assertKeychainOriginal(t, "after a blocked Keychain")
}
