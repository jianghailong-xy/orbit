package main

// Set as default for Claude Code (docs/claude-default-swap-contract.md): the runner swaps the login of
// one added account with the one in Default's folder, so Orbit and a `claude` typed in a terminal both
// use it. A login is two pieces of state (§1): the claudeAiOauth entry of the folder's credentials
// (.credentials.json, or on macOS the folder's Keychain item) and the oauthAccount entry of its
// .claude.json (for Default, $HOME's). Exactly those two entries are exchanged, byte for byte, and
// nothing else in either file moves.
//
// This file is the swap itself — back up, exchange, verify, roll back — and nothing about when it may
// run: the relay that quiets both folders first is claude_account_swap_relay.go.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// claudeAccountSwapCapabilityV1 declares that this runner carries out claude-account-swap/v1: it quiets
// both folders, swaps the two logins, verifies them and rolls back on any failure (contract §5).
const claudeAccountSwapCapabilityV1 = "claude-account-swap/v1"

// claudeSwapExpiryMargin is how far from expiry both access tokens must be before a swap (§2.2): the
// CLI refreshes once a token is within five minutes, so with this margin the verify step can never
// start a refresh.
const claudeSwapExpiryMargin = 30 * time.Minute

// claudeLoginFolder is one of the two folders a swap exchanges logins between.
type claudeLoginFolder struct {
	// label is how a message names it: "Default", or the added account's id.
	label string
	// dir is the config directory, absolute.
	dir string
	// envDir is the CLAUDE_CONFIG_DIR a CLI on this folder runs with: "" for Default when the runner's
	// own environment sets none. It names the Keychain item (claudeKeychainService) and decides where
	// .claude.json is.
	envDir string
	// configJSON is the .claude.json the CLI keeps the identity in: $HOME/.claude.json for a CLI run with
	// no CLAUDE_CONFIG_DIR, <dir>/.claude.json otherwise.
	configJSON string
}

// claudeDefaultLoginFolder is Default's folder as a CLI with the runner's own environment resolves it.
func claudeDefaultLoginFolder() (claudeLoginFolder, error) {
	slot, err := defaultAccountSlot(claudeAccountKind)
	if err != nil {
		return claudeLoginFolder{}, err
	}
	envDir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	configJSON := filepath.Join(slot.Dir, ".claude.json")
	if envDir == "" {
		configJSON = filepath.Join(userHome(), ".claude.json")
	}
	return claudeLoginFolder{label: "Default", dir: slot.Dir, envDir: envDir, configJSON: configJSON}, nil
}

// claudeAddedLoginFolder is added account id's folder.
func claudeAddedLoginFolder(id string) (claudeLoginFolder, error) {
	if id == accountSlotDefaultID {
		return claudeLoginFolder{}, errors.New("Default is already the default")
	}
	dir, err := claudeAccountKind.home(id)
	if err != nil {
		return claudeLoginFolder{}, err
	}
	return claudeLoginFolder{label: id, dir: dir, envDir: dir, configJSON: filepath.Join(dir, ".claude.json")}, nil
}

// claudeCredentialStore reads and writes the whole credentials blob of a folder: the JSON whose
// claudeAiOauth key is the login. remove deletes it, wherever the folder keeps it — a sign-out
// (signOutDefault); a folder that holds none is already what was asked for.
type claudeCredentialStore interface {
	read(ctx context.Context, f claudeLoginFolder) ([]byte, error)
	write(ctx context.Context, f claudeLoginFolder, blob []byte) error
	remove(ctx context.Context, f claudeLoginFolder) error
}

// claudeFileCredentials keeps a folder's credentials in <dir>/.credentials.json (Linux, and macOS
// where the Keychain was unusable).
type claudeFileCredentials struct{}

func (claudeFileCredentials) read(_ context.Context, f claudeLoginFolder) ([]byte, error) {
	return os.ReadFile(filepath.Join(f.dir, ".credentials.json"))
}

func (claudeFileCredentials) write(_ context.Context, f claudeLoginFolder, blob []byte) error {
	path := filepath.Join(f.dir, ".credentials.json")
	perm := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	return writeFileAtomically(path, blob, perm)
}

// remove deletes <dir>/.credentials.json and nothing beside it.
func (claudeFileCredentials) remove(_ context.Context, f claudeLoginFolder) error {
	if err := os.Remove(filepath.Join(f.dir, ".credentials.json")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// claudeKeychainCredentials is the macOS store. Storage is per folder (contract, "macOS: measured"):
// a folder whose login-Keychain item (claudeKeychainService) exists keeps its login there, and one
// without keeps it in <dir>/.credentials.json, Claude Code's plaintext fallback. One Mac can hold both
// at once, so each read and write looks the folder's storage up again, and a swap moves claudeAiOauth
// between whatever the two are while each folder keeps its own. A swap only ever updates an item, never
// creates or removes one, so a folder's storage cannot change under a swap; only a sign-out removes one.
type claudeKeychainCredentials struct{}

// claudeSecurityBin is the macOS `security` tool; tests point it at a fake.
var claudeSecurityBin = "security"

// claudeKeychainTimeout bounds every `security` call: one that blocks is a Keychain dialog waiting
// for a person, and fails the swap (rolled back) rather than holding it.
var claudeKeychainTimeout = 30 * time.Second

// claudeKeychainNotFound is `security`'s exit status for "the specified item could not be found".
const claudeKeychainNotFound = 44

var claudeKeychainAccountAttr = regexp.MustCompile(`"acct"<blob>="([^"]*)"`)

// security runs one `security` command with its argv, under claudeKeychainTimeout.
func (claudeKeychainCredentials) security(ctx context.Context, f claudeLoginFolder, args ...string) ([]byte, int, error) {
	cctx, cancel := context.WithTimeout(ctx, claudeKeychainTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, claudeSecurityBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if cctx.Err() != nil && ctx.Err() == nil {
		return nil, -1, fmt.Errorf("the Keychain did not answer for %s within %s (a Keychain dialog?)", f.label, claudeKeychainTimeout)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return out, exit.ExitCode(), fmt.Errorf("%v %s", err, strings.TrimSpace(stderr.String()))
	}
	if err != nil {
		return nil, -1, err
	}
	return out, 0, nil
}

// item says whether f has a Keychain item and, if so, the account it is filed under: the item a
// write must update, since `-U` matches on service and account both.
func (k claudeKeychainCredentials) item(ctx context.Context, f claudeLoginFolder) (account string, found bool, err error) {
	out, code, err := k.security(ctx, f, "find-generic-password", "-s", claudeKeychainService(f.envDir))
	if code == claudeKeychainNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("could not look up %s's Keychain item: %w", f.label, err)
	}
	m := claudeKeychainAccountAttr.FindSubmatch(out)
	if m == nil {
		return "", false, fmt.Errorf("%s's Keychain item names no account", f.label)
	}
	return string(m[1]), true, nil
}

func (k claudeKeychainCredentials) read(ctx context.Context, f claudeLoginFolder) ([]byte, error) {
	account, found, err := k.item(ctx, f)
	if err != nil {
		return nil, err
	}
	if !found {
		return claudeFileCredentials{}.read(ctx, f)
	}
	out, _, err := k.security(ctx, f, "find-generic-password", "-s", claudeKeychainService(f.envDir), "-a", account, "-w")
	if err != nil {
		return nil, fmt.Errorf("could not read %s's login from the Keychain: %w", f.label, err)
	}
	return bytes.TrimSuffix(out, []byte("\n")), nil
}

// write updates the folder's item in place, or its .credentials.json when it has no item. The blob
// goes in as hex on the argv (`-X`), not through `security -i`: interactive mode reads lines of at
// most LINE_MAX bytes and silently cuts a longer one, and a blob carrying mcpOAuth is longer. -U keeps
// the item and its access list, as Claude Code's own writes do.
func (k claudeKeychainCredentials) write(ctx context.Context, f claudeLoginFolder, blob []byte) error {
	account, found, err := k.item(ctx, f)
	if err != nil {
		return err
	}
	if !found {
		return claudeFileCredentials{}.write(ctx, f, blob)
	}
	if _, _, err := k.security(ctx, f, "add-generic-password", "-U", "-s", claudeKeychainService(f.envDir), "-a", account, "-X", hex.EncodeToString(blob)); err != nil {
		return fmt.Errorf("the Keychain refused %s's login: %w", f.label, err)
	}
	return nil
}

// claudeKeychainDeleteLimit bounds how many items one service may hold that a sign-out deletes: each
// `delete-generic-password` takes the first match, and a loop that never saw "not found" must end.
const claudeKeychainDeleteLimit = 8

// remove deletes every Keychain item of the folder's service, then the plaintext fallback file too:
// a folder whose Keychain was once unusable can hold both, and a sign-out leaves neither.
func (k claudeKeychainCredentials) remove(ctx context.Context, f claudeLoginFolder) error {
	service := claudeKeychainService(f.envDir)
	for i := 0; ; i++ {
		_, code, err := k.security(ctx, f, "delete-generic-password", "-s", service)
		if code == claudeKeychainNotFound {
			break
		}
		if err != nil {
			return fmt.Errorf("the Keychain kept %s's login: %w", f.label, err)
		}
		if i+1 >= claudeKeychainDeleteLimit {
			return fmt.Errorf("the Keychain still holds %s's login after %d deletions", f.label, claudeKeychainDeleteLimit)
		}
	}
	return claudeFileCredentials{}.remove(ctx, f)
}

// claudeCredentialStoreForOS is the store the CLI on this machine uses.
func claudeCredentialStoreForOS() claudeCredentialStore {
	if runtime.GOOS == "darwin" {
		return claudeKeychainCredentials{}
	}
	return claudeFileCredentials{}
}

// jsonTopLevelValue finds key in the top-level object of doc and returns its value's raw bytes and
// their span, so a value can be replaced without touching one other byte of the document.
func jsonTopLevelValue(doc []byte, key string) (raw []byte, start, end int, err error) {
	dec := json.NewDecoder(bytes.NewReader(doc))
	tok, err := dec.Token()
	if err != nil {
		return nil, 0, 0, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, 0, 0, errors.New("not a JSON object")
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, 0, 0, err
		}
		name, _ := tok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, 0, 0, err
		}
		if name == key {
			end := int(dec.InputOffset())
			return []byte(value), end - len(value), end, nil
		}
	}
	return nil, 0, 0, fmt.Errorf("no %s entry", key)
}

// jsonReplaceTopLevelValue is doc with key's value replaced by raw, every other byte as it was.
func jsonReplaceTopLevelValue(doc []byte, key string, raw []byte) ([]byte, error) {
	_, start, end, err := jsonTopLevelValue(doc, key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(doc)-(end-start)+len(raw))
	out = append(out, doc[:start]...)
	out = append(out, raw...)
	return append(out, doc[end:]...), nil
}

// claudeOAuthEntry is what a swap reads of one claudeAiOauth value.
type claudeOAuthEntry struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"refreshToken"`
	ExpiresAt    interface{} `json:"expiresAt"`
}

func (e claudeOAuthEntry) refreshHash() string {
	if e.RefreshToken == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(e.RefreshToken))
	return hex.EncodeToString(sum[:])
}

// claudeOAuthAccount is what a swap reads of one oauthAccount value.
type claudeOAuthAccount struct {
	AccountUUID      string `json:"accountUuid"`
	EmailAddress     string `json:"emailAddress"`
	OrganizationUUID string `json:"organizationUuid"`
}

// claudeLoginState is one folder's login as read: the two whole documents and the two entries.
type claudeLoginState struct {
	credentials []byte // the whole credentials blob
	configJSON  []byte // the whole .claude.json
	oauthRaw    []byte // claudeAiOauth, raw
	accountRaw  []byte // oauthAccount, raw
	oauth       claudeOAuthEntry
	account     claudeOAuthAccount
}

func readClaudeLoginState(ctx context.Context, store claudeCredentialStore, f claudeLoginFolder) (claudeLoginState, error) {
	var st claudeLoginState
	var err error
	if st.credentials, err = store.read(ctx, f); err != nil {
		return st, fmt.Errorf("%s has no Claude login to swap: %w", f.label, err)
	}
	if st.oauthRaw, _, _, err = jsonTopLevelValue(st.credentials, "claudeAiOauth"); err != nil {
		return st, fmt.Errorf("%s's credentials have no Claude login (%v)", f.label, err)
	}
	if err := json.Unmarshal(st.oauthRaw, &st.oauth); err != nil {
		return st, fmt.Errorf("%s's Claude login cannot be read: %w", f.label, err)
	}
	if st.configJSON, err = os.ReadFile(f.configJSON); err != nil {
		return st, fmt.Errorf("%s's account record cannot be read: %w", f.label, err)
	}
	if st.accountRaw, _, _, err = jsonTopLevelValue(st.configJSON, "oauthAccount"); err != nil {
		return st, fmt.Errorf("%s's %s has no account (%v)", f.label, f.configJSON, err)
	}
	if err := json.Unmarshal(st.accountRaw, &st.account); err != nil {
		return st, fmt.Errorf("%s's account cannot be read: %w", f.label, err)
	}
	return st, nil
}

// readClaudeOAuthAccountUUID is the accountUuid a folder's .claude.json names, read without any CLI:
// what tells a redelivered swap that already happened from a new one.
func readClaudeOAuthAccountUUID(f claudeLoginFolder) string {
	return readClaudeOAuthAccount(f).AccountUUID
}

// readClaudeOAuthAccount is the oauthAccount a folder's .claude.json names, read without any CLI;
// empty when there is none to read.
func readClaudeOAuthAccount(f claudeLoginFolder) claudeOAuthAccount {
	var account claudeOAuthAccount
	doc, err := os.ReadFile(f.configJSON)
	if err != nil {
		return account
	}
	raw, _, _, err := jsonTopLevelValue(doc, "oauthAccount")
	if err != nil {
		return account
	}
	if json.Unmarshal(raw, &account) != nil {
		return claudeOAuthAccount{}
	}
	return account
}

// claudeAuthStatus is what `claude auth status` says of a folder.
type claudeAuthStatus struct {
	LoggedIn   bool   `json:"loggedIn"`
	AuthMethod string `json:"authMethod"`
	Email      string `json:"email"`
	OrgID      string `json:"orgId"`
}

// Swap steps, in order: each is a point a test can fail the swap after.
const (
	claudeSwapStepBackup       = "backup"
	claudeSwapStepCredentials  = "credentials"
	claudeSwapStepOAuthAccount = "oauthAccount"
	claudeSwapStepVerify       = "verify"
)

// claudeLoginSwap is one swap of the logins of two folders. Its function fields are the outside world
// — the CLI, Anthropic, a refresh — so tests can stand in for each.
type claudeLoginSwap struct {
	def, acct claudeLoginFolder
	store     claudeCredentialStore
	// backupDir is the private directory the backup is written to (contract §3.1): outside every
	// config folder, read by the rollback only.
	backupDir string
	// status runs `claude auth status` in a folder's environment.
	status func(ctx context.Context, f claudeLoginFolder) (claudeAuthStatus, error)
	// tokenOwner asks Anthropic whose access token this is (§4.2): account and organization uuid.
	tokenOwner func(ctx context.Context, accessToken string) (account, org string, err error)
	// refresh has the CLI refresh a folder's token (§2.2).
	refresh func(ctx context.Context, f claudeLoginFolder) error
	// after is called once each step has completed; an error it returns fails the swap there.
	after func(step string) error
	now   func() time.Time
}

func newClaudeLoginSwap(def, acct claudeLoginFolder, backupDir string) *claudeLoginSwap {
	return &claudeLoginSwap{
		def: def, acct: acct, store: claudeCredentialStoreForOS(), backupDir: backupDir,
		status: claudeAuthStatusIn, tokenOwner: claudeTokenOwner,
		refresh: func(ctx context.Context, f claudeLoginFolder) error { return runClaudeTokenRefresh(ctx, f.envDir) },
		after:   func(string) error { return nil },
		now:     time.Now,
	}
}

// claudeAuthStatusIn runs `claude auth status` with folder f's environment. Default's runs with the
// runner's own, so with no CLAUDE_CONFIG_DIR unless the runner has one.
func claudeAuthStatusIn(ctx context.Context, f claudeLoginFolder) (claudeAuthStatus, error) {
	env := os.Environ()
	if f.envDir != "" {
		env = envWithValue(env, "CLAUDE_CONFIG_DIR", f.envDir)
	}
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, "claude", "auth", "status")
	cmd.Env = claudeQuietEnv(env, envAsAgent(env))
	out, err := cmd.Output()
	var st claudeAuthStatus
	if jerr := json.Unmarshal(out, &st); jerr != nil {
		if err == nil {
			err = jerr
		}
		return st, fmt.Errorf("`claude auth status` for %s: %v", f.label, err)
	}
	return st, nil
}

// claudeProfileURL is the read-only endpoint that names an access token's owner (§4.2).
var claudeProfileURL = "https://api.anthropic.com/api/oauth/profile"

func claudeTokenOwner(ctx context.Context, accessToken string) (string, string, error) {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, claudeProfileURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("authorization", "Bearer "+accessToken)
	req.Header.Set("anthropic-beta", planUsageBeta)
	req.Header.Set("accept", "application/json")
	req.Header.Set("user-agent", "orbit-runner/"+version)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("profile endpoint -> %d", resp.StatusCode)
	}
	var p struct {
		Account      struct{ UUID string } `json:"account"`
		Organization struct{ UUID string } `json:"organization"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return "", "", err
	}
	return p.Account.UUID, p.Organization.UUID, nil
}

// claudeSwapOutcome is how a swap ended: ok, or failed with the one line the page shows.
type claudeSwapOutcome struct {
	ok      bool
	message string
	// now is the accountUuid each folder holds afterwards (done only).
	defaultAccountUUID, accountAccountUUID string
	// accountEmail is the emailAddress the added folder holds afterwards: the former Default's (done only).
	accountEmail string
}

// run carries out the swap on two folders nothing runs on (the relay sees to that): preconditions,
// backup, credentials, oauthAccount, verify — and on any failure after the backup, the rollback.
func (s *claudeLoginSwap) run(ctx context.Context) claudeSwapOutcome {
	fail := func(format string, args ...interface{}) claudeSwapOutcome {
		return claudeSwapOutcome{message: fmt.Sprintf(format, args...)}
	}
	if _, region, blocked := claudeConnectionBlocked(ctx); blocked {
		return fail("Not swapped: this machine's connection to Anthropic is in %s, where Anthropic doesn't offer Claude.", region)
	}
	def, acct, err := s.preconditions(ctx)
	if err != nil {
		return fail("Not swapped: %v", err)
	}
	if err := s.backup(def, acct); err != nil {
		return fail("Not swapped: the backup could not be written: %v", err)
	}
	if err := s.after(claudeSwapStepBackup); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	// Credentials: each folder's claudeAiOauth becomes the other's, every other key as it was.
	newDefCreds, err := jsonReplaceTopLevelValue(def.credentials, "claudeAiOauth", acct.oauthRaw)
	if err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	newAcctCreds, err := jsonReplaceTopLevelValue(acct.credentials, "claudeAiOauth", def.oauthRaw)
	if err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.store.write(ctx, s.def, newDefCreds); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.store.write(ctx, s.acct, newAcctCreds); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.after(claudeSwapStepCredentials); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	// Identity: only the oauthAccount entry of each .claude.json.
	if err := s.writeAccount(s.def, acct.accountRaw); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.writeAccount(s.acct, def.accountRaw); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.after(claudeSwapStepOAuthAccount); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.verify(ctx, s.def, acct, def.oauth.refreshHash() != "" && acct.oauth.refreshHash() != ""); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.verify(ctx, s.acct, def, def.oauth.refreshHash() != "" && acct.oauth.refreshHash() != ""); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	if err := s.after(claudeSwapStepVerify); err != nil {
		return s.rollBack(ctx, def, acct, err)
	}
	_ = os.RemoveAll(s.backupDir)
	return claudeSwapOutcome{
		ok: true, defaultAccountUUID: acct.account.AccountUUID, accountAccountUUID: def.account.AccountUUID,
		accountEmail: def.account.EmailAddress,
	}
}

// preconditions reads both logins and holds them to §2: both claude.ai logins of different accounts,
// neither token within claudeSwapExpiryMargin of expiry (refreshed first through the CLI if one is).
func (s *claudeLoginSwap) preconditions(ctx context.Context) (def, acct claudeLoginState, err error) {
	for _, f := range []claudeLoginFolder{s.def, s.acct} {
		st, err := readClaudeLoginState(ctx, s.store, f)
		if err != nil {
			return def, acct, err
		}
		login, _ := parseClaudeOAuthLogin(st.credentials)
		if login.expiresWithin(claudeSwapExpiryMargin, s.now()) {
			if err := s.refresh(ctx, f); err != nil {
				return def, acct, fmt.Errorf("%s's login expires within %s and Claude Code did not refresh it: %v", f.label, claudeSwapExpiryMargin, err)
			}
			if st, err = readClaudeLoginState(ctx, s.store, f); err != nil {
				return def, acct, err
			}
			if login, _ = parseClaudeOAuthLogin(st.credentials); login.expiresWithin(claudeSwapExpiryMargin, s.now()) {
				return def, acct, fmt.Errorf("%s's login expires within %s and Claude Code did not refresh it", f.label, claudeSwapExpiryMargin)
			}
		}
		status, err := s.status(ctx, f)
		if err != nil {
			return def, acct, err
		}
		if !status.LoggedIn || status.AuthMethod != "claude.ai" {
			return def, acct, fmt.Errorf("%s is not signed in with a Claude account (auth method %q)", f.label, status.AuthMethod)
		}
		if f == s.def {
			def = st
		} else {
			acct = st
		}
	}
	if def.account.AccountUUID == "" || def.account.AccountUUID == acct.account.AccountUUID {
		return def, acct, errors.New("both folders are signed in to the same account")
	}
	return def, acct, nil
}

// backup writes both folders' credentials and .claude.json, as read, to a private directory.
func (s *claudeLoginSwap) backup(def, acct claudeLoginState) error {
	if err := ensurePrivateDir(s.backupDir); err != nil {
		return err
	}
	for name, b := range map[string][]byte{
		"default.credentials.json": def.credentials, "default.claude.json": def.configJSON,
		"account.credentials.json": acct.credentials, "account.claude.json": acct.configJSON,
	} {
		if err := writeFileAtomically(filepath.Join(s.backupDir, name), b, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// writeAccount puts raw as f's oauthAccount entry, leaving every other byte of its .claude.json — read
// again now, not as it was at the backup — as it is.
func (s *claudeLoginSwap) writeAccount(f claudeLoginFolder, raw []byte) error {
	doc, err := os.ReadFile(f.configJSON)
	if err != nil {
		return err
	}
	out, err := jsonReplaceTopLevelValue(doc, "oauthAccount", raw)
	if err != nil {
		return err
	}
	if bytes.Equal(out, doc) {
		return nil
	}
	perm := os.FileMode(0o600)
	if info, err := os.Stat(f.configJSON); err == nil {
		perm = info.Mode().Perm()
	}
	return writeFileAtomically(f.configJSON, out, perm)
}

// verify holds folder f to the login want (§4): the CLI reports want's account, Anthropic says the
// token there is want's, and — when checkHash — its refresh token is want's, so nothing rotated.
func (s *claudeLoginSwap) verify(ctx context.Context, f claudeLoginFolder, want claudeLoginState, checkHash bool) error {
	st, err := readClaudeLoginState(ctx, s.store, f)
	if err != nil {
		return err
	}
	status, err := s.status(ctx, f)
	if err != nil {
		return err
	}
	if !status.LoggedIn || status.AuthMethod != "claude.ai" {
		return fmt.Errorf("%s does not report a signed-in Claude account", f.label)
	}
	if status.Email != want.account.EmailAddress || (want.account.OrganizationUUID != "" && status.OrgID != want.account.OrganizationUUID) {
		return fmt.Errorf("%s reports %s, not %s", f.label, status.Email, want.account.EmailAddress)
	}
	account, org, err := s.tokenOwner(ctx, st.oauth.AccessToken)
	if err != nil {
		return fmt.Errorf("Anthropic could not say whose login %s holds: %v", f.label, err)
	}
	if account != want.account.AccountUUID || (want.account.OrganizationUUID != "" && org != want.account.OrganizationUUID) {
		return fmt.Errorf("the login in %s belongs to another account than its record says", f.label)
	}
	if checkHash && st.oauth.refreshHash() != want.oauth.refreshHash() {
		return fmt.Errorf("%s's login was refreshed during the swap", f.label)
	}
	return nil
}

// rollBack puts both logins back as they were before the swap (contract §3, Rollback) and says so.
// When no refresh happened it writes the backed-up entries back, which gives back the original bytes of
// both credentials and both .claude.json. When one did, a backed-up refresh token is spent, so each live
// login goes to the folder whose account Anthropic says owns it instead. Either way both folders are
// verified against their original accounts; if that fails too the backup is kept and named.
func (s *claudeLoginSwap) rollBack(ctx context.Context, def, acct claudeLoginState, cause error) claudeSwapOutcome {
	reason := firstLine(cause.Error())
	restored, err := s.restore(ctx, def, acct)
	if err == nil {
		err = s.verify(ctx, s.def, def, !restored)
		if err == nil {
			err = s.verify(ctx, s.acct, acct, !restored)
		}
	}
	if err != nil {
		return claudeSwapOutcome{message: fmt.Sprintf("Swap failed (%s) and the logins could not be put back (%s) — the backup is kept at %s.",
			reason, firstLine(err.Error()), s.backupDir)}
	}
	_ = os.RemoveAll(s.backupDir)
	return claudeSwapOutcome{message: fmt.Sprintf("Rolled back: %s — both logins are as they were.", reason)}
}

// restore writes the original entries back; rebuilt reports that a refresh had happened and the
// logins were put back by their owners instead.
func (s *claudeLoginSwap) restore(ctx context.Context, def, acct claudeLoginState) (rebuilt bool, err error) {
	origHashes := map[string]bool{def.oauth.refreshHash(): true, acct.oauth.refreshHash(): true}
	live := map[claudeLoginFolder]claudeLoginState{}
	rotated := false
	for _, f := range []claudeLoginFolder{s.def, s.acct} {
		blob, rerr := s.store.read(ctx, f)
		if rerr != nil {
			continue // nothing live to keep: the backed-up one goes back
		}
		raw, _, _, rerr := jsonTopLevelValue(blob, "claudeAiOauth")
		var entry claudeOAuthEntry
		if rerr != nil || json.Unmarshal(raw, &entry) != nil {
			continue
		}
		live[f] = claudeLoginState{credentials: blob, oauthRaw: raw, oauth: entry}
		if !origHashes[entry.refreshHash()] {
			rotated = true
		}
	}
	creds := map[claudeLoginFolder][]byte{s.def: def.credentials, s.acct: acct.credentials}
	if rotated {
		// Each live login goes where its owner's account record was: putting a backed-up refresh token
		// back would sign that account out.
		owners := map[string]claudeLoginFolder{def.account.AccountUUID: s.def, acct.account.AccountUUID: s.acct}
		for _, st := range live {
			owner, _, oerr := s.tokenOwner(ctx, st.oauth.AccessToken)
			if oerr != nil {
				return true, fmt.Errorf("a login was refreshed during the swap and Anthropic could not say whose it is: %v", oerr)
			}
			f, ok := owners[owner]
			if !ok {
				return true, errors.New("a login was refreshed during the swap and belongs to neither account")
			}
			base := def.credentials
			if f == s.acct {
				base = acct.credentials
			}
			blob, jerr := jsonReplaceTopLevelValue(base, "claudeAiOauth", st.oauthRaw)
			if jerr != nil {
				return true, jerr
			}
			creds[f] = blob
		}
	}
	for _, f := range []claudeLoginFolder{s.def, s.acct} {
		if st, ok := live[f]; ok && bytes.Equal(st.credentials, creds[f]) {
			continue
		}
		if werr := s.store.write(ctx, f, creds[f]); werr != nil {
			return rotated, werr
		}
	}
	if err := s.writeAccount(s.def, def.accountRaw); err != nil {
		return rotated, err
	}
	if err := s.writeAccount(s.acct, acct.accountRaw); err != nil {
		return rotated, err
	}
	return rotated, nil
}

// claudeSwapBackupDir is where one attempt's backup goes: under the runner's own home, never inside a
// config folder.
func claudeSwapBackupDir(attempt string) string {
	name := regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(attempt, "_")
	if name == "" {
		name = "attempt"
	}
	return filepath.Join(machineHome(), "claude-swap", name)
}
