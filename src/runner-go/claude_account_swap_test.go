package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// claudeSwapFixture is a machine with two signed-in Claude logins: Default (~/.claude, identity in
// $HOME/.claude.json) and one added account, each with things beside its login that must not move.
type claudeSwapFixture struct {
	def, acct claudeLoginFolder
	// files are the four documents a swap touches, as they were before it.
	files map[string][]byte
	// owners is what Anthropic answers for each access token.
	mu     sync.Mutex
	owners map[string][2]string
	// store is where the CLI keeps each folder's login: the files, or (macOS) the Keychain store
	// reaching the fake Keychain security holds, whose items before the swap are before.
	store    claudeCredentialStore
	security *fakeSecurity
	before   map[string]fakeKeychainItem
}

const (
	claudeSwapDefCreds = `{"claudeAiOauth":{"accessToken":"at-default","refreshToken":"rt-default","expiresAt":%d,"scopes":["user:inference"],"subscriptionType":"max"},"mcpOAuth":{"linear|1":{"accessToken":"mcp-default"}}}`
	claudeSwapAccCreds = `{"claudeAiOauth":{"accessToken":"at-work","refreshToken":"rt-work","expiresAt":%d,"scopes":["user:inference"],"subscriptionType":"pro"},"mcpOAuth":{"github|2":{"accessToken":"mcp-work"}}}`
)

func claudeSwapConfigJSON(userID, uuid, email, org string) string {
	return `{
  "numStartups": 42,
  "userID": "` + userID + `",
  "oauthAccount": {
    "accountUuid": "` + uuid + `",
    "emailAddress": "` + email + `",
    "organizationUuid": "` + org + `",
    "organizationName": "` + email + `'s Organization",
    "billingType": "stripe_subscription"
  },
  "projects": {
    "/home/me/app": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true
    }
  },
  "groveConfigCache": {"` + uuid + `": {"grove_enabled": true}},
  "cachedFeatureFlags": {"x": 1}
}
`
}

func newClaudeSwapFixture(t *testing.T) *claudeSwapFixture {
	t.Helper()
	home, _ := claudeAccountSlotTestHomes(t)
	slot, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	def, err := claudeDefaultLoginFolder()
	if err != nil {
		t.Fatal(err)
	}
	acct, err := claudeAddedLoginFolder(slot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if def.dir != filepath.Join(home, ".claude") || def.configJSON != filepath.Join(home, ".claude.json") || def.envDir != "" {
		t.Fatalf("Default's folder = %+v", def)
	}
	if err := os.MkdirAll(def.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	exp := time.Now().Add(8 * time.Hour).UnixMilli()
	f := &claudeSwapFixture{def: def, acct: acct, files: map[string][]byte{
		filepath.Join(def.dir, ".credentials.json"):  []byte(strings.Replace(claudeSwapDefCreds, "%d", jsonInt(exp), 1)),
		filepath.Join(acct.dir, ".credentials.json"): []byte(strings.Replace(claudeSwapAccCreds, "%d", jsonInt(exp), 1)),
		def.configJSON:  []byte(claudeSwapConfigJSON("uid-default", "uuid-default", "me@home.example", "org-default")),
		acct.configJSON: []byte(claudeSwapConfigJSON("uid-work", "uuid-work", "me@work.example", "org-work")),
	}, owners: map[string][2]string{
		"at-default": {"uuid-default", "org-default"},
		"at-work":    {"uuid-work", "org-work"},
	}, store: claudeFileCredentials{}}
	for path, b := range f.files {
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

// status is `claude auth status` as the CLI answers it: from the folder's own oauthAccount.
func (f *claudeSwapFixture) status(_ context.Context, folder claudeLoginFolder) (claudeAuthStatus, error) {
	st, err := readClaudeLoginState(context.Background(), f.store, folder)
	if err != nil {
		return claudeAuthStatus{}, err
	}
	return claudeAuthStatus{LoggedIn: st.oauth.AccessToken != "", AuthMethod: "claude.ai", Email: st.account.EmailAddress, OrgID: st.account.OrganizationUUID}, nil
}

func (f *claudeSwapFixture) tokenOwner(_ context.Context, token string) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.owners[token]
	if !ok {
		return "", "", errors.New("profile endpoint -> 401")
	}
	return o[0], o[1], nil
}

func (f *claudeSwapFixture) swap(t *testing.T) *claudeLoginSwap {
	s := newClaudeLoginSwap(f.def, f.acct, filepath.Join(t.TempDir(), "backup"))
	s.store = f.store
	s.status, s.tokenOwner = f.status, f.tokenOwner
	s.refresh = func(context.Context, claudeLoginFolder) error {
		t.Fatal("refreshed a login far from expiry")
		return nil
	}
	return s
}

func (f *claudeSwapFixture) read(t *testing.T) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for path := range f.files {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		out[path] = b
	}
	return out
}

// assertOriginal holds all four documents to the bytes they had before the swap.
func (f *claudeSwapFixture) assertOriginal(t *testing.T, when string) {
	t.Helper()
	for path, b := range f.read(t) {
		if !bytes.Equal(b, f.files[path]) {
			t.Errorf("%s: %s is not as it was:\n got %s\nwant %s", when, path, b, f.files[path])
		}
	}
}

func topValue(t *testing.T, doc []byte, key string) string {
	t.Helper()
	raw, _, _, err := jsonTopLevelValue(doc, key)
	if err != nil {
		t.Fatalf("%s: %v", key, err)
	}
	return string(raw)
}

// A swap exchanges the claudeAiOauth entries and the oauthAccount entries and nothing else: the MCP
// sign-ins, userID, caches and projects of both files stay byte for byte, and swapping again gives the
// original files back.
func TestClaudeLoginSwapExchangesOnlyTheLoginAndTheAccount(t *testing.T) {
	f := newClaudeSwapFixture(t)
	s := f.swap(t)
	out := s.run(context.Background())
	if !out.ok || out.defaultAccountUUID != "uuid-work" || out.accountAccountUUID != "uuid-default" || out.accountEmail != "me@home.example" {
		t.Fatalf("swap = %+v, want done with work in Default", out)
	}
	defCreds, acctCreds := filepath.Join(f.def.dir, ".credentials.json"), filepath.Join(f.acct.dir, ".credentials.json")
	got := f.read(t)
	for _, c := range []struct{ path, key, want string }{
		{defCreds, "claudeAiOauth", topValue(t, f.files[acctCreds], "claudeAiOauth")},
		{acctCreds, "claudeAiOauth", topValue(t, f.files[defCreds], "claudeAiOauth")},
		{defCreds, "mcpOAuth", topValue(t, f.files[defCreds], "mcpOAuth")},
		{acctCreds, "mcpOAuth", topValue(t, f.files[acctCreds], "mcpOAuth")},
		{f.def.configJSON, "oauthAccount", topValue(t, f.files[f.acct.configJSON], "oauthAccount")},
		{f.acct.configJSON, "oauthAccount", topValue(t, f.files[f.def.configJSON], "oauthAccount")},
	} {
		if v := topValue(t, got[c.path], c.key); v != c.want {
			t.Errorf("%s %s = %s, want %s", c.path, c.key, v, c.want)
		}
	}
	// The rest of each .claude.json is untouched: with its own oauthAccount put back it is the original.
	for _, path := range []string{f.def.configJSON, f.acct.configJSON} {
		back, err := jsonReplaceTopLevelValue(got[path], "oauthAccount", []byte(topValue(t, f.files[path], "oauthAccount")))
		if err != nil || !bytes.Equal(back, f.files[path]) {
			t.Errorf("%s changed outside oauthAccount:\n%s", path, got[path])
		}
	}
	if _, err := os.Stat(s.backupDir); !os.IsNotExist(err) {
		t.Errorf("backup %s kept after a verified swap: %v", s.backupDir, err)
	}
	f.owners["at-work"], f.owners["at-default"] = [2]string{"uuid-work", "org-work"}, [2]string{"uuid-default", "org-default"}
	if out := f.swap(t).run(context.Background()); !out.ok {
		t.Fatalf("swap back = %+v", out)
	}
	f.assertOriginal(t, "after swapping back")
}

// A failure after any step — the backup, the credentials, the oauthAccount entries, the verification —
// leaves both folders' credentials and .claude.json byte-identical to before, and says so.
func TestClaudeLoginSwapFailingAfterEachStepRestoresBothLogins(t *testing.T) {
	for _, step := range []string{claudeSwapStepBackup, claudeSwapStepCredentials, claudeSwapStepOAuthAccount, claudeSwapStepVerify} {
		t.Run(step, func(t *testing.T) {
			f := newClaudeSwapFixture(t)
			s := f.swap(t)
			var reached []string
			s.after = func(at string) error {
				reached = append(reached, at)
				if at == step {
					return errors.New("injected failure after " + step)
				}
				return nil
			}
			out := s.run(context.Background())
			if out.ok {
				t.Fatalf("swap failing after %s reported done", step)
			}
			if want := "Rolled back: injected failure after " + step + " — both logins are as they were."; out.message != want {
				t.Fatalf("message = %q, want %q", out.message, want)
			}
			if reached[len(reached)-1] != step {
				t.Fatalf("steps reached = %v", reached)
			}
			f.assertOriginal(t, "after a failure after "+step)
			if _, err := os.Stat(s.backupDir); !os.IsNotExist(err) {
				t.Errorf("backup kept after a verified rollback: %v", err)
			}
			t.Logf("failure after %s: %q; both credentials files and both .claude.json byte-identical", step, out.message)
		})
	}
}

// The verification itself failing — Anthropic says the token in Default is not the account its record
// names — rolls back as well.
func TestClaudeLoginSwapThatDoesNotVerifyRollsBack(t *testing.T) {
	f := newClaudeSwapFixture(t)
	s := f.swap(t)
	s.tokenOwner = func(ctx context.Context, token string) (string, string, error) {
		if token == "at-work" && s.def.label == "Default" {
			if b, _ := os.ReadFile(filepath.Join(f.def.dir, ".credentials.json")); bytes.Contains(b, []byte("at-work")) {
				return "uuid-somebody-else", "org-work", nil
			}
		}
		return f.tokenOwner(ctx, token)
	}
	out := s.run(context.Background())
	if out.ok || !strings.HasPrefix(out.message, "Rolled back: the login in Default belongs to another account") {
		t.Fatalf("swap = %+v", out)
	}
	f.assertOriginal(t, "after a failed verification")
}

// failingSecondWrite fails the n-th credentials write: a failure between the two credential writes.
type failingSecondWrite struct {
	claudeFileCredentials
	writes, failAt int
}

func (w *failingSecondWrite) write(ctx context.Context, f claudeLoginFolder, blob []byte) error {
	w.writes++
	if w.writes == w.failAt {
		return errors.New("disk full")
	}
	return w.claudeFileCredentials.write(ctx, f, blob)
}

func TestClaudeLoginSwapFailingBetweenTheTwoCredentialWritesRestoresBoth(t *testing.T) {
	f := newClaudeSwapFixture(t)
	s := f.swap(t)
	s.store = &failingSecondWrite{failAt: 2}
	out := s.run(context.Background())
	if out.ok || out.message != "Rolled back: disk full — both logins are as they were." {
		t.Fatalf("swap = %+v", out)
	}
	f.assertOriginal(t, "after the second credentials write failed")
}

// A refresh during the swap rotates a token, so the backed-up one is spent: the rollback puts each live
// login in the folder of the account that owns it rather than restoring a spent refresh token.
func TestClaudeLoginSwapRollbackAfterARefreshPutsEachLiveLoginWithItsOwner(t *testing.T) {
	f := newClaudeSwapFixture(t)
	s := f.swap(t)
	s.after = func(step string) error {
		if step != claudeSwapStepCredentials {
			return nil
		}
		// Work's login, now in Default's folder, is refreshed there.
		path := filepath.Join(f.def.dir, ".credentials.json")
		b, _ := os.ReadFile(path)
		b = bytes.Replace(bytes.Replace(b, []byte("rt-work"), []byte("rt-work-2"), 1), []byte("at-work"), []byte("at-work-2"), 1)
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		f.owners["at-work-2"] = [2]string{"uuid-work", "org-work"}
		f.mu.Unlock()
		return errors.New("Claude Code refreshed a token mid-swap")
	}
	out := s.run(context.Background())
	if out.ok || !strings.HasPrefix(out.message, "Rolled back: Claude Code refreshed a token mid-swap") {
		t.Fatalf("swap = %+v", out)
	}
	got := f.read(t)
	acctCreds := filepath.Join(f.acct.dir, ".credentials.json")
	want := bytes.Replace(bytes.Replace(f.files[acctCreds], []byte("rt-work"), []byte("rt-work-2"), 1), []byte("at-work"), []byte("at-work-2"), 1)
	if !bytes.Equal(got[acctCreds], want) {
		t.Fatalf("Work's folder holds %s, want its refreshed login %s", got[acctCreds], want)
	}
	for _, path := range []string{filepath.Join(f.def.dir, ".credentials.json"), f.def.configJSON, f.acct.configJSON} {
		if !bytes.Equal(got[path], f.files[path]) {
			t.Errorf("%s is not as it was: %s", path, got[path])
		}
	}
}

// A rollback that cannot put the logins back keeps the backup and names it.
func TestClaudeLoginSwapThatCannotRollBackKeepsTheBackup(t *testing.T) {
	f := newClaudeSwapFixture(t)
	s := f.swap(t)
	s.after = func(step string) error {
		if step == claudeSwapStepOAuthAccount {
			s.tokenOwner = func(context.Context, string) (string, string, error) { return "", "", errors.New("network down") }
			return errors.New("injected")
		}
		return nil
	}
	out := s.run(context.Background())
	if out.ok || !strings.Contains(out.message, "the backup is kept at "+s.backupDir) {
		t.Fatalf("swap = %+v", out)
	}
	for _, name := range []string{"default.credentials.json", "default.claude.json", "account.credentials.json", "account.claude.json"} {
		if _, err := os.Stat(filepath.Join(s.backupDir, name)); err != nil {
			t.Errorf("backup %s: %v", name, err)
		}
	}
	// The files were still written back; only their verification could not be done.
	f.assertOriginal(t, "after an unverifiable rollback")
}

// A swap refuses two folders signed in to the same account, and touches nothing.
func TestClaudeLoginSwapRefusesTheSameAccountTwice(t *testing.T) {
	f := newClaudeSwapFixture(t)
	same := bytes.Replace(f.files[f.acct.configJSON], []byte("uuid-work"), []byte("uuid-default"), -1)
	if err := os.WriteFile(f.acct.configJSON, same, 0o600); err != nil {
		t.Fatal(err)
	}
	f.files[f.acct.configJSON] = same
	s := f.swap(t)
	out := s.run(context.Background())
	if out.ok || out.message != "Not swapped: both folders are signed in to the same account" {
		t.Fatalf("swap = %+v", out)
	}
	f.assertOriginal(t, "after a refused swap")
}

func TestJSONReplaceTopLevelValueKeepsEveryOtherByte(t *testing.T) {
	doc := []byte("{\n  \"a\": {\"oauthAccount\": 1},\n  \"oauthAccount\" :  {\"x\": [1, 2]} ,\n  \"z\": \"oauthAccount\"\n}\n")
	got, err := jsonReplaceTopLevelValue(doc, "oauthAccount", []byte(`{"y":true}`))
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"a\": {\"oauthAccount\": 1},\n  \"oauthAccount\" :  {\"y\":true} ,\n  \"z\": \"oauthAccount\"\n}\n"
	if string(got) != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}
