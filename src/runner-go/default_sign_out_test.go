package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// signOutRequest is the request the control plane sends to sign engine's Default out.
func signOutRequest(engine string, force bool) AccountRemoveCommand {
	return AccountRemoveCommand{Engine: engine, Account: accountSlotDefaultID, Action: accountRemoveActionSignOut, Force: force, Attempt: "a1"}
}

// fileDigests is every regular file under root by relative path, with its mode and a digest of its bytes:
// what "left as it was" means for the files beside a credential. Directories are left out — removing a
// file changes its directory's modification time, which is not a change to anything kept there.
func fileDigests(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		digest := info.Mode().String()
		if info.Mode().IsRegular() {
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			digest += fmt.Sprintf(" %x", sha256.Sum256(b))
		}
		rel, _ := filepath.Rel(root, path)
		out[rel] = digest
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// writeSiblings writes each file (relative to root) the engine keeps beside its login.
func writeSiblings(t *testing.T, root string, rels ...string) {
	t.Helper()
	for _, rel := range rels {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("kept: "+rel+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// assertOnlyRemoved checks that after is before with exactly the files in removed gone, and that every
// named sibling is still there.
func assertOnlyRemoved(t *testing.T, before, after map[string]string, removed []string, siblings []string) {
	t.Helper()
	want := map[string]string{}
	for k, v := range before {
		want[k] = v
	}
	for _, rel := range removed {
		if _, ok := want[rel]; !ok {
			t.Fatalf("the credential %s was not there before the sign-out: %v", rel, digestPaths(before))
		}
		delete(want, rel)
	}
	if !reflect.DeepEqual(after, want) {
		t.Fatalf("the sign-out changed more than the credential:\nbefore %v\nafter  %v\nwant   %v", before, after, want)
	}
	for _, rel := range siblings {
		if _, ok := after[rel]; !ok {
			t.Fatalf("sibling %s did not survive the sign-out", rel)
		}
	}
}

func digestPaths(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// defaultAuthOf is what an engine report says of the Default account, and of the engine itself.
func defaultAuthOf(t *testing.T, reports []EngineHealthReport) (engine, account string) {
	t.Helper()
	if len(reports) != 1 || !reports[0].Installed {
		t.Fatalf("engine reports = %+v, want one installed engine", reports)
	}
	for _, a := range reports[0].Accounts {
		if a.ID == accountSlotDefaultID {
			return reports[0].Auth, a.Auth
		}
	}
	t.Fatalf("no Default account in %+v", reports[0].Accounts)
	return "", ""
}

func assertDefaultSignedIn(t *testing.T, reports []EngineHealthReport) {
	t.Helper()
	if engine, account := defaultAuthOf(t, reports); engine != "yes" || account != "yes" {
		t.Fatalf("before the sign-out: engine auth %q, Default %q, want both signed in", engine, account)
	}
}

func assertDefaultSignedOut(t *testing.T, reports []EngineHealthReport) {
	t.Helper()
	if engine, account := defaultAuthOf(t, reports); engine != "no" || account != "no" {
		t.Fatalf("after the sign-out: engine auth %q, Default %q, want both signed out", engine, account)
	}
}

// signOutDone carries out a sign-out request with no sessions running and checks it reports done — twice,
// since the request is redelivered until the runner reports and an account already signed out is done.
func signOutDone(t *testing.T, engine string) {
	t.Helper()
	for i := 0; i < 2; i++ {
		res := defaultSignOutResult(signOutRequest(engine, false), nil)
		want := AccountRemoveResultRequest{Engine: engine, Account: accountSlotDefaultID, Attempt: "a1", Status: "done"}
		if !reflect.DeepEqual(res, want) {
			t.Fatalf("sign-out #%d = %+v, want %+v", i+1, res, want)
		}
	}
}

// Claude Code on Linux: the sign-out deletes ~/.claude/.credentials.json and nothing else — ~/.claude.json,
// history, settings and transcripts stay — and the engine then reports Default signed out.
func TestDefaultSignOutClaudeDeletesOnlyTheCredentialsFile(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	// A Keychain no item is in: where claudeCredentialStoreForOS is the Keychain one (a Mac running this
	// test), the sign-out asks a fake, never the machine's own.
	newFakeSecurity(t)
	signInClaudeDir(t, filepath.Join(home, ".claude"))
	siblings := []string{".claude.json", ".claude/history.jsonl", ".claude/settings.json", ".claude/projects/-work/0001.jsonl"}
	writeSiblings(t, home, siblings...)
	binDir, _ := fakeClaudeForAccountHealth(t)
	assertDefaultSignedIn(t, probeEngines([]engineSpec{claudeSpecForTest(t)}, binDir))

	before := fileDigests(t, home)
	signOutDone(t, providerClaude)
	assertOnlyRemoved(t, before, fileDigests(t, home), []string{".claude/.credentials.json"}, siblings)
	assertDefaultSignedOut(t, probeEngines([]engineSpec{claudeSpecForTest(t)}, binDir))
}

// Claude Code on a Mac: the Keychain item Default's login is in is deleted with `security
// delete-generic-password -s <service>`, and so is a plaintext fallback file; nothing else is touched. With
// CLAUDE_CONFIG_DIR set, the item is the one named after that directory, and another folder's stays.
func TestDefaultSignOutClaudeDeletesTheKeychainItemAndTheFile(t *testing.T) {
	for _, configured := range []bool{false, true} {
		t.Run(fmt.Sprintf("CLAUDE_CONFIG_DIR=%v", configured), func(t *testing.T) {
			home, _ := claudeAccountSlotTestHomes(t)
			dir, envDir := filepath.Join(home, ".claude"), ""
			if configured {
				dir = filepath.Join(home, "claude-config")
				envDir = dir
				t.Setenv("CLAUDE_CONFIG_DIR", dir)
			}
			k := newFakeSecurity(t)
			service := claudeKeychainService(envDir)
			other := claudeKeychainService(filepath.Join(home, "elsewhere"))
			k.put(t, service, "me", []byte(`{"claudeAiOauth":{"accessToken":"t"}}`))
			k.put(t, other, "me", []byte(`{"claudeAiOauth":{"accessToken":"other"}}`))
			signInClaudeDir(t, dir)
			siblings := []string{".claude.json", filepath.Join(filepath.Base(dir), "history.jsonl"), filepath.Join(filepath.Base(dir), "settings.json")}
			writeSiblings(t, home, siblings...)
			before := fileDigests(t, home)

			for i := 0; i < 2; i++ {
				if err := signOutClaudeDefault(context.Background(), claudeKeychainCredentials{}); err != nil {
					t.Fatalf("sign-out #%d: %v", i+1, err)
				}
			}
			assertOnlyRemoved(t, before, fileDigests(t, home), []string{filepath.Join(filepath.Base(dir), ".credentials.json")}, siblings)
			items := k.items(t)
			if _, ok := items[service]; ok {
				t.Fatalf("Default's Keychain item %q survived: %v", service, items)
			}
			if _, ok := items[other]; !ok {
				t.Fatalf("another folder's Keychain item %q was deleted: %v", other, items)
			}
			b, _ := os.ReadFile(filepath.Join(k.dir, "calls.log"))
			if !strings.Contains(string(b), `["delete-generic-password","-s",`+mustJSON(t, service)+`]`) {
				t.Fatalf("security calls = %s, want delete-generic-password -s %q", b, service)
			}
		})
	}
}

// fakeCodexWithLogout is fakeCodexForAccountHealth's codex that also logs out, as the real one does:
// `codex logout` deletes auth.json from the CODEX_HOME it runs in, and says so even when there was none.
func fakeCodexWithLogout(t *testing.T) (binDir, calls string) {
	t.Helper()
	binDir = t.TempDir()
	t.Setenv("PATH", binDir)
	calls = filepath.Join(t.TempDir(), "calls.log")
	bin := writeFakeBin(t, binDir, "codex", `home="${CODEX_HOME:-$HOME/.codex}"
printf '%s\t%s\n' "$*" "${CODEX_HOME:-<own>}" >> '`+calls+`'
case "$1 $2" in
"--version "*) echo "codex-cli 0.156.0" ;;
"login status")
	if [ -f "$home/auth.json" ]; then echo "Logged in using ChatGPT"; exit 0; fi
	echo "Not logged in" >&2; exit 1 ;;
"logout "*)
	if [ -f "$home/auth.json" ]; then command -p rm -f "$home/auth.json"; echo "Successfully logged out"; exit 0; fi
	echo "Not logged in"; exit 1 ;;
*) exit 2 ;;
esac`)
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return bin, engine == providerCodex }
	t.Cleanup(func() { lookLoginEngine = previous })
	return binDir, calls
}

// Codex: the sign-out is `codex logout` in the runner's own environment, which deletes auth.json; config,
// history and sessions stay, and the engine then reports Default signed out. A second request, with Codex
// already signed out and its logout exiting non-zero, is done too.
func TestDefaultSignOutCodexRunsCodexLogout(t *testing.T) {
	home, _ := codexAccountSlotTestHomes(t)
	signInCodexHome(t, filepath.Join(home, ".codex"))
	siblings := []string{".codex/config.toml", ".codex/history.jsonl", ".codex/sessions/2026/11/23/rollout-1.jsonl"}
	writeSiblings(t, home, siblings...)
	binDir, calls := fakeCodexWithLogout(t)
	assertDefaultSignedIn(t, probeEngines([]engineSpec{codexSpecForTest(t)}, binDir))

	before := fileDigests(t, home)
	signOutDone(t, providerCodex)
	assertOnlyRemoved(t, before, fileDigests(t, home), []string{".codex/auth.json"}, siblings)
	b, _ := os.ReadFile(calls)
	if got := strings.Count(string(b), "logout\t<own>\n"); got != 2 {
		t.Fatalf("codex calls = %q, want `codex logout` twice in the runner's own environment", b)
	}
	assertDefaultSignedOut(t, probeEngines([]engineSpec{codexSpecForTest(t)}, binDir))
}

// A logout that leaves Codex signed in is a failure, however it exited.
func TestDefaultSignOutCodexStillSignedInFails(t *testing.T) {
	home, _ := codexAccountSlotTestHomes(t)
	signInCodexHome(t, filepath.Join(home, ".codex"))
	bin := writeFakeBin(t, t.TempDir(), "codex", `case "$1 $2" in
"login status") exit 0 ;;
*) exit 0 ;;
esac`)
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return bin, engine == providerCodex }
	t.Cleanup(func() { lookLoginEngine = previous })
	res := defaultSignOutResult(signOutRequest(providerCodex, false), nil)
	if res.Status != "failed" || !strings.Contains(res.Message, "still reports Default signed in") {
		t.Fatalf("result = %+v, want failed: still signed in", res)
	}
}

// fakeKimiWithLogout is fakeKimiForAccounts with Kimi Code's logout: the credentials file goes, and so does
// the managed provider the sign-in added to config.toml.
const fakeKimiWithLogout = `home="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
if [ "$1" = logout ]; then
	printf '%s\t%s\n' "$*" "$home" >> "$FAKE_KIMI_SEEN"
	rm -f "$home/credentials/kimi-code.json"
	if [ -f "$home/config.toml" ]; then
		sed '/^\[providers\."managed:kimi-code"\]/,/^type = /d' "$home/config.toml" > "$home/config.toml.new" && mv "$home/config.toml.new" "$home/config.toml"
	fi
	exit 0
fi
`

// Kimi Code: the sign-out is `kimi logout` in Default's KIMI_CODE_HOME; sessions and history stay, and the
// engine then reports Default signed out.
func TestDefaultSignOutKimiRunsKimiLogout(t *testing.T) {
	defaultHome, _ := kimiAccountTestHomes(t)
	dir := t.TempDir()
	bin := writeFakeBin(t, dir, providerKimi, fakeKimiWithLogout+fakeKimiForAccounts)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	seen := filepath.Join(t.TempDir(), "seen")
	t.Setenv("FAKE_KIMI_SEEN", seen)
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return bin, engine == providerKimi }
	t.Cleanup(func() { lookLoginEngine = previous })
	signInKimiHome(t, defaultHome, kimiRegionMainland)
	siblings := []string{"sessions/abc/context.jsonl", "user-history/0001.jsonl", "kimi.json"}
	writeSiblings(t, defaultHome, siblings...)
	spec, _ := specFor(providerKimi)
	assertDefaultSignedIn(t, probeEngines([]engineSpec{spec}, dir))

	before := fileDigests(t, defaultHome)
	signOutDone(t, providerKimi)
	after := fileDigests(t, defaultHome)
	// config.toml is Kimi Code's own to rewrite as it logs out (it drops the managed provider); every
	// other file stays exactly as it was.
	delete(before, "config.toml")
	delete(after, "config.toml")
	assertOnlyRemoved(t, before, after, []string{filepath.Join("credentials", "kimi-code.json")}, siblings)
	config, _ := os.ReadFile(filepath.Join(defaultHome, "config.toml"))
	if strings.Contains(string(config), "managed:kimi-code") || !strings.Contains(string(config), "default_model") {
		t.Fatalf("config.toml after logout = %q", config)
	}
	b, _ := os.ReadFile(seen)
	if !strings.Contains(string(b), "logout\t"+defaultHome+"\n") {
		t.Fatalf("kimi calls = %q, want `kimi logout` in %s", b, defaultHome)
	}
	assertDefaultSignedOut(t, probeEngines([]engineSpec{spec}, dir))
}

// Cursor CLI: the sign-out deletes the Default account's saved login and nothing beside it, and the engine
// then reports Default signed out.
func TestDefaultSignOutCursorDeletesOnlyTheSavedLogin(t *testing.T) {
	useCursorRealHome(t)
	newFakeCursorRelease(t)
	installFakeCursor(t)
	saved := signInCursorDefault(t, cursorTestToken(t, time.Now().Add(time.Hour)))
	root := cursorDefaultAccountDir()
	siblings := []string{"xdg-config/cursor/cli-config.json", "home/.cursor/cli-config.json", "config/chats/abc/store.db"}
	writeSiblings(t, root, siblings...)
	if _, report := cursorHealth(t); report.Auth != "yes" || len(report.Accounts) == 0 || report.Accounts[0].Auth != "yes" {
		t.Fatalf("before the sign-out: %+v", report)
	}

	before := fileDigests(t, root)
	signOutDone(t, providerCursor)
	rel, _ := filepath.Rel(root, saved)
	assertOnlyRemoved(t, before, fileDigests(t, root), []string{rel}, siblings)
	_, report := cursorHealth(t)
	assertDefaultSignedOut(t, []EngineHealthReport{report})
}

// The relay's half: a sign-out runs once per engine however often it is redelivered while under way,
// reports its result, and only a done one re-probes the engine and beats.
func TestDefaultSignOutsHandleReportsThenRefreshes(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	token := antigravityGoogleTokenPath()
	writeSiblings(t, filepath.Dir(token), filepath.Base(token))

	var s defaultSignOuts
	var ops countedOps
	var mu sync.Mutex
	var reports []AccountRemoveResultRequest
	var refreshed []string
	beats := 0
	report := func(r AccountRemoveResultRequest) error {
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
		return nil
	}
	refresh := func(engine string) { mu.Lock(); refreshed = append(refreshed, engine); mu.Unlock() }
	beat := func() { mu.Lock(); beats++; mu.Unlock() }

	// Held as under way: a redelivery while it runs starts nothing.
	if !s.begin(providerAntigravity) {
		t.Fatal("could not claim the sign-out")
	}
	s.handle(signOutRequest(providerAntigravity, false), &ops, func() []string { return nil }, report, refresh, beat)
	ops.wg.Wait()
	if len(reports) != 0 {
		t.Fatalf("a redelivery beside a sign-out under way ran: %+v", reports)
	}
	s.end(providerAntigravity)

	s.handle(signOutRequest(providerAntigravity, false), &ops, func() []string { return nil }, report, refresh, beat)
	ops.wg.Wait()
	want := []AccountRemoveResultRequest{{Engine: providerAntigravity, Account: accountSlotDefaultID, Attempt: "a1", Status: "done"}}
	if !reflect.DeepEqual(reports, want) || !reflect.DeepEqual(refreshed, []string{providerAntigravity}) || beats != 1 {
		t.Fatalf("reports %+v, refreshed %v, beats %d", reports, refreshed, beats)
	}
	if _, err := os.Stat(token); !os.IsNotExist(err) {
		t.Fatalf("the token survived (err %v)", err)
	}

	// A refused one is reported and re-probes nothing.
	reports, refreshed, beats = nil, nil, 0
	s.handle(AccountRemoveCommand{Engine: providerAntigravity, Account: "0a1b2c3d", Action: accountRemoveActionSignOut}, &ops, func() []string { return nil }, report, refresh, beat)
	ops.wg.Wait()
	if len(reports) != 1 || reports[0].Status != "failed" || len(refreshed) != 0 || beats != 0 {
		t.Fatalf("an added account's sign-out: reports %+v, refreshed %v, beats %d", reports, refreshed, beats)
	}
}

// writeTestSessionMeta records session id as running with meta, where the pool's sessions keep theirs.
func writeTestSessionMeta(t *testing.T, id string, meta sessionMeta) {
	t.Helper()
	if err := os.MkdirAll(runDir(id), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeSessionMetaFile(runDir(id), &meta); err != nil {
		t.Fatal(err)
	}
}

// A sign-out while a session runs on Default is refused naming that session — and only it, not one on an
// added account — and leaves the login; sent again with force, it signs out.
func TestDefaultSignOutWithASessionOnDefaultIsRefusedUnlessForced(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	newFakeSecurity(t)
	credentials := filepath.Join(home, ".claude", ".credentials.json")
	signInClaudeDir(t, filepath.Dir(credentials))
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeTestSessionMeta(t, "on-default", sessionMeta{Provider: providerClaude, WorkDir: "/w"})
	writeTestSessionMeta(t, "on-work", sessionMeta{Provider: providerClaude, ClaudeConfigDir: work.Dir, WorkDir: "/w"})
	writeTestSessionMeta(t, "on-codex", sessionMeta{Provider: providerCodex, WorkDir: "/w"})
	live := []string{"on-default", "on-work", "on-codex"}

	res := defaultSignOutResult(signOutRequest(providerClaude, false), live)
	if res.Status != "failed" || !reflect.DeepEqual(res.SessionIDs, []string{"on-default"}) ||
		!strings.Contains(res.Message, "in use by a session") || !strings.Contains(res.Message, "sign out anyway") {
		t.Fatalf("unforced sign-out = %+v, want refused naming on-default", res)
	}
	if _, err := os.Stat(credentials); err != nil {
		t.Fatalf("a refused sign-out removed the login: %v", err)
	}

	res = defaultSignOutResult(signOutRequest(providerClaude, true), live)
	if res.Status != "done" || len(res.SessionIDs) != 0 {
		t.Fatalf("forced sign-out = %+v, want done", res)
	}
	if _, err := os.Stat(credentials); !os.IsNotExist(err) {
		t.Fatalf("a forced sign-out left the login (err %v)", err)
	}
}

// Which sessions run on Default, engine by engine: each engine's record of an added account (or Codex's
// CODEX_HOME, Default's included) decides, and a Cursor CLI session on a key of its own is on no account.
func TestDefaultAccountSessionsPerEngine(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	t.Setenv("CODEX_HOME", "")
	t.Setenv("KIMI_CODE_HOME", "")
	defaultCodex := filepath.Join(home, ".codex")
	metas := map[string]sessionMeta{
		"claude-default":      {WorkDir: "/w"}, // a record older than the provider field is Claude's
		"claude-added":        {Provider: providerClaude, ClaudeConfigDir: "/orbit/claude-accounts/0a1b2c3d"},
		"codex-default":       {Provider: providerCodex, CodexStateLayout: codexStateLayoutShared, CodexStateHome: defaultCodex},
		"codex-added":         {Provider: providerCodex, CodexStateLayout: codexStateLayoutShared, CodexStateHome: "/orbit/codex-accounts/0a1b2c3d"},
		"codex-isolated":      {Provider: providerCodex},
		"kimi-default":        {Provider: providerKimi},
		"kimi-added":          {Provider: providerKimi, KimiCodeHome: "/orbit/kimi-accounts/0a1b2c3d"},
		"cursor-default":      {Provider: providerCursor},
		"cursor-added":        {Provider: providerCursor, CursorAccountDir: "/orbit/cursor-accounts/0a1b2c3d"},
		"cursor-key":          {Provider: providerCursor, CursorIdentity: "key:abc"},
		"antigravity-default": {Provider: providerAntigravity},
		"antigravity-added":   {Provider: providerAntigravity, AntigravityGoogleDir: "/orbit/antigravity-accounts/0a1b2c3d"},
	}
	var ids []string
	for id, meta := range metas {
		writeTestSessionMeta(t, id, meta)
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, kind := range []accountSlotKind{claudeAccountKind, codexAccountKind, kimiAccountKind, cursorAccountKind, antigravityAccountKind} {
		got := defaultAccountSessions(kind, ids)
		if want := []string{kind.engine + "-default"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("%s sessions on Default = %v, want %v", kind.engine, got, want)
		}
	}
}

// The protocol: the command carries action and force, and a command without them — an older control
// plane's — is a removal.
func TestAccountRemoveCommandCarriesActionAndForce(t *testing.T) {
	var cmd AccountRemoveCommand
	if err := json.Unmarshal([]byte(`{"engine":"codex","account":"default","action":"sign-out","force":true,"attempt":"x"}`), &cmd); err != nil {
		t.Fatal(err)
	}
	if cmd.Action != accountRemoveActionSignOut || !cmd.Force || cmd.Account != accountSlotDefaultID {
		t.Fatalf("decoded %+v", cmd)
	}
	b, _ := json.Marshal(AccountRemoveCommand{Account: "0a1b2c3d"})
	if strings.Contains(string(b), "action") || strings.Contains(string(b), "force") {
		t.Fatalf("a removal encodes as %s", b)
	}
}

// Every engine's Default sign-out is declared; Cursor CLI's only where its accounts are.
func TestDefaultSignOutCapabilitiesAreDeclared(t *testing.T) {
	declared := map[string]bool{}
	for _, c := range strings.Split(runnerCapabilitiesV1, ",") {
		declared[c] = true
	}
	for _, c := range []string{claudeDefaultSignOutCapabilityV1, codexDefaultSignOutCapabilityV1, kimiDefaultSignOutCapabilityV1, antigravityDefaultSignOutCapabilityV1} {
		if !declared[c] {
			t.Fatalf("%s not declared in %s", c, runnerCapabilitiesV1)
		}
	}
	if declared[cursorDefaultSignOutCapabilityV1] != cursorAccountsSupported() {
		t.Fatalf("%s declared = %v on %s", cursorDefaultSignOutCapabilityV1, declared[cursorDefaultSignOutCapabilityV1], cursorOS)
	}
}
