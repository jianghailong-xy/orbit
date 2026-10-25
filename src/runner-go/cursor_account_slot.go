package main

// Cursor CLI's half of the account store (account_slot.go): an account IS a directory the runner keeps
// one Cursor CLI login in (docs/cursor-runtime-contract.md §16.2). `agent login` runs with the directory's
// home/, config/ and xdg-config/ as its HOME, CURSOR_CONFIG_DIR and XDG_CONFIG_HOME, and its credentials in
// a file, so a sign-in writes nowhere else. Where in the directory the login lands is the platform's
// (cursorStoredLoginPath): on Linux under XDG_CONFIG_HOME, xdg-config/cursor/auth.json (§8.2); on macOS
// always under HOME, home/.cursor/auth.json (§18.3). Default is the directory the runner has kept since P3,
// <orbit home>/cursor/default; an added account is <orbit home>/cursor-accounts/<id>.
//
// No session runs in an account's directory. A session keeps the CLI's state in a directory of its own
// (cursor_launch.go) and borrows its account's login: the access token saved there, handed to the CLI as
// CURSOR_AUTH_TOKEN and held in memory, so nothing a session does is written back into the account
// (§8.2, §16.3). The CLI never refreshes a login's token — only an API key is traded for a new one
// (§8.4, §9) — so the runner only ever reads a saved login: one past its token's expiry, or within the
// five minutes the CLI already counts as expired, is over, and a new sign-in is what replaces it.
//
// Which account a session runs on arrives as ORBIT_CURSOR_ACCOUNT_DIR (cursorAccountDirVar), injected by
// the control plane as CODEX_HOME is; the runner reads it and no Cursor CLI ever sees it.
//
// Accounts beside Default are kept on Linux and macOS, D4's approach A (§8.4, §18.7): that is where the CLI
// was measured running on a HOME of its own while its commands get the real one back. A runner on any other
// platform keeps Default alone (D4's approach D) and declares neither capability. Every Cursor CLI process
// names its credential store, a file for `agent login` and memory for everything else: macOS's default store
// is the Keychain, shared by every account and stuck behind a dialog under an account's HOME (§18.4).

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// cursorAccountLoginCapabilityV1 declares that this runner signs Cursor CLI in, into the account the
// control plane names — its own directory, with `agent login` and the link it prints. The control plane
// hands no Cursor CLI sign-in, Default's included, to a runner without it: an older one signs Claude Code
// in for an engine it does not know (loginFlowFor).
const cursorAccountLoginCapabilityV1 = "cursor-account-login/v1"

// cursorAccountRemoveCapabilityV1 declares that this runner removes a Cursor CLI account the control plane
// names — its directory and its record, and no other account's.
const cursorAccountRemoveCapabilityV1 = "cursor-account-remove/v1"

var cursorAccountKind = accountSlotKind{
	engine:         providerCursor,
	varName:        cursorAccountDirVar,
	dirName:        "cursor-accounts",
	resolveDefault: func([]string, string) (string, error) { return filepath.Abs(cursorDefaultAccountDir()) },
	loginStatus:    cursorSlotLoginStatus,
	liveDirs:       cursorSessionAccountDirs,
}

func init() { accountSlotKinds = append(accountSlotKinds, cursorAccountKind) }

// cursorAccountsSupported is whether this runner keeps Cursor CLI accounts beside Default: on Linux and
// macOS, where approach A of D4 was measured (§8.4, §18.7).
func cursorAccountsSupported() bool { return cursorOS == "linux" || cursorOS == "darwin" }

// cursorAccountCapabilities is what this runner declares of Cursor CLI accounts: signing them in and
// removing them, where it keeps them, and nothing elsewhere.
func cursorAccountCapabilities() []string {
	if !cursorAccountsSupported() {
		return nil
	}
	return []string{cursorAccountLoginCapabilityV1, cursorAccountRemoveCapabilityV1}
}

// cursorAccountsUnsupportedMessage is how a runner that keeps Default alone refuses another account.
func cursorAccountsUnsupportedMessage() string {
	return "this runner keeps only its Default Cursor CLI account: more accounts work on Linux and macOS runners for now"
}

// cursorSlotLoginStatus asks whether the account at dir is signed in: a login saved there, its token not
// expired, and Cursor accepting it when the CLI asks with it (`agent models`, §9). A directory with no
// login, or none at all, is signed out without asking anything; so is a login whose token has expired,
// which no CLI will refresh (§8.4) — it needs signing in again.
func cursorSlotLoginStatus(ctx context.Context, binPath, dir string) authState {
	token, err := cursorStoredLogin(dir)
	if err != nil {
		return authUnknown
	}
	if token == "" || cursorTokenExpired(token, time.Now()) {
		return authNo
	}
	if binPath == "" {
		return authUnknown
	}
	return cursorModelsAnswer(ctx, binPath, "CURSOR_AUTH_TOKEN="+token)
}

// cursorAccountLogin is the access token of the login saved for the account at dir, refused unless the
// CLI would still use it: a saved token that has expired, or is within the CLI's five minutes of
// expiring, is a sign-in that is over (§8.4, §9). A refusal says what is wrong with the account.
func cursorAccountLogin(dir string) (string, error) {
	token, err := cursorStoredLogin(dir)
	switch {
	case err != nil:
		return "", fmt.Errorf("has a sign-in this runner cannot read (%s)", firstLine(err.Error()))
	case token == "":
		return "", errors.New("is not signed in on this runner")
	case cursorTokenExpired(token, time.Now()):
		return "", errors.New("has a sign-in that expired, which Cursor CLI does not renew")
	}
	return token, nil
}

// cursorSessionAccountDir is the account directory a Cursor CLI session borrows its login from: the one
// its environment names, when that is one of this runner's added accounts, else Default's. A directory
// that is not one of them is refused, never read: a session borrows a login only from an account this
// runner keeps.
func cursorSessionAccountDir(agentEnv map[string]string) (string, error) {
	named := strings.TrimSpace(agentEnv[cursorAccountDirVar])
	def, err := filepath.Abs(cursorDefaultAccountDir())
	if err != nil {
		return "", err
	}
	if named == "" || filepath.Clean(named) == def {
		return def, nil
	}
	if !cursorAccountsSupported() {
		return "", errors.New(cursorAccountsUnsupportedMessage())
	}
	root, err := accountSlotsDir(cursorAccountKind)
	if err != nil {
		return "", err
	}
	dir := filepath.Clean(named)
	if filepath.Dir(dir) == root {
		if home, err := cursorAccountKind.home(filepath.Base(dir)); err == nil && home == dir {
			return dir, nil
		}
	}
	return "", fmt.Errorf("this runner has no Cursor CLI account at %s — sign it in again, or pick another account", named)
}

// cursorSessionAccountDirToRecord is the added account a session's record keeps (sessionMeta.CursorAccountDir):
// the one its login is borrowed from, or empty for a session on Default, on a key or on no account at all.
func cursorSessionAccountDirToRecord(job *ClaimedSession) string {
	if runtimeProvider(job) != providerCursor || cursorSessionKey(job) != "" {
		return ""
	}
	dir, err := cursorSessionAccountDir(job.Agent.Env)
	if err != nil {
		return ""
	}
	if def, err := filepath.Abs(cursorDefaultAccountDir()); err == nil && def == dir {
		return ""
	}
	return dir
}

// cursorSessionAccountDirs is every added account a session this runner is running borrows its login
// from — read from each session's own record, written when its run starts and before its CLI does. A
// session on Default contributes nothing: Default is not a slot, and no removal touches it.
func cursorSessionAccountDirs(sessionIDs []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range sessionIDs {
		meta := readSessionMeta(filepath.Join(runDir(id), "meta.json"))
		if meta == nil || meta.CursorAccountDir == "" {
			continue
		}
		out[filepath.Clean(meta.CursorAccountDir)] = true
	}
	return out
}

// The sign-in link `NO_OPEN_BROWSER=1 agent login` prints, measured (§9): cursor.com's loginDeepControl
// page with a PKCE challenge. Requiring the page and the challenge keeps another link from matching.
var cursorLoginURLRe = regexp.MustCompile(`https://cursor\.com/loginDeepControl\?[^\s"'<>\x1b\x07]*challenge=[^\s"'<>\x1b\x07]+`)

// cursorLoginGaveUp is what `agent login` prints when it stops waiting for the link to be used, and exits 1
// (§9; 3541.index.js): after its last poll, or after three failed polls in a row.
const cursorLoginGaveUp = "Login failed or timed out"

const (
	// cursorLoginRelayTimeout is how long the relay lets an `agent login` wait before it ends it: past the
	// CLI's own wait, the longest measured 1,636 s (§9), and within the 30 minutes the control plane sweeps
	// a Cursor CLI sign-in after (CURSOR_LOGIN_RELAY_TIMEOUT_MS).
	cursorLoginRelayTimeout = 29 * time.Minute
	// cursorLoginExpiredMessage is a link that ran out before anyone signed in with it (reason "expired").
	cursorLoginExpiredMessage = "The sign-in link expired before anyone signed in with it."
)

// cursorLoginLinkLifetime is how long a sign-in link is sure to stay good from when the CLI prints it,
// which the runner reports as when it expires. The CLI stops waiting on a link after 150 polls with a pause
// of 1 s growing by a fifth each time up to 10 s: 1,418 s of pauses before any poll's own round trip
// (3541.index.js; index.js waitForResult), measured at 1,543 s to 1,636 s on HPC (§9), so the measured
// 27 minutes depends on the network and is not the link's to promise. "Login failed or timed out" after
// this long is the link expiring; any sooner it is three failed polls in a row. A test sets it shorter.
var cursorLoginLinkLifetime = 23 * time.Minute

// cursorLoginProgress publishes the sign-in link once the CLI has printed it, with when it stops working.
// There is nothing to hand back: the CLI polls Cursor for the sign-in itself (§9).
func cursorLoginProgress(out string) *LoginResultRequest {
	links := cursorLoginURLRe.FindAllString(out, -1)
	if len(links) == 0 {
		return nil
	}
	return &LoginResultRequest{
		Status:    loginAwaitingApproval,
		URL:       links[len(links)-1],
		ExpiresAt: time.Now().Add(cursorLoginLinkLifetime).UTC().Format(time.RFC3339),
	}
}

// cursorLoginOutcome is how an `agent login` the relay drove ended, linkAge after its link appeared. Exit 0
// comes once the CLI has saved the login (3541.index.js), which is then read back from the account's
// directory, the way a session borrows it; the CLI giving up after its full wait, and the relay's own
// deadline, are the link expiring; anything else is a failure in the CLI's words.
func cursorLoginOutcome(run *loginRun, exitErr error, linkAge time.Duration) LoginResultRequest {
	if exitErr == nil {
		if _, err := cursorAccountLogin(run.cursorDir); err != nil {
			return LoginResultRequest{Status: loginFailed, Message: "Cursor CLI ended the sign-in, but the account " + err.Error() + " — get a new link and sign in again"}
		}
		return LoginResultRequest{Status: loginDone}
	}
	expired := LoginResultRequest{Status: loginFailed, Message: cursorLoginExpiredMessage, Reason: loginReasonExpired}
	if errors.Is(run.ctx.Err(), context.DeadlineExceeded) {
		return expired
	}
	out := run.out.String()
	if strings.Contains(out, cursorLoginGaveUp) {
		if linkAge >= cursorLoginLinkLifetime {
			return expired
		}
		return LoginResultRequest{Status: loginFailed, Message: "Cursor CLI stopped waiting for the sign-in before its link expired: " +
			"it could not check with Cursor whether anyone had signed in. Get a new link, and check this runner's network if it happens again."}
	}
	if line := cursorLoginErrorLine(out); line != "" {
		return LoginResultRequest{Status: loginFailed, Message: "Cursor CLI could not sign in: " + line}
	}
	return LoginResultRequest{Status: loginFailed, Message: "sign-in did not complete (" + firstLine(exitErr.Error()) + ")"}
}

// cursorLoginErrorLine is the last line the CLI printed that is not its own progress, "" when there is none.
func cursorLoginErrorLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line != "" && !cursorLoginURLRe.MatchString(line) && !strings.HasPrefix(line, "Starting login") &&
			!strings.HasPrefix(line, "Authenticating with") && !strings.HasPrefix(line, "Waiting for browser") {
			return line
		}
	}
	return ""
}

// prepareCursorLoginDir makes the directories a sign-in into the account at dir writes, private and not
// links: the HOME, CURSOR_CONFIG_DIR and XDG_CONFIG_HOME it runs with. An added account's own directory
// must already be there (accountSlotKind.home); Default's is made here the first time it signs in.
func prepareCursorLoginDir(dir string) error {
	for _, d := range []string{dir, filepath.Join(dir, "home"), filepath.Join(dir, "config"), filepath.Join(dir, "xdg-config")} {
		if err := ensurePrivateDir(d); err != nil {
			return err
		}
	}
	return nil
}

// cursorLoginEnv is the environment `agent login` signs the account at dir in with (§8.2, §16.2): the
// allowlist every Cursor CLI process starts from, the account's own HOME, CURSOR_CONFIG_DIR and
// XDG_CONFIG_HOME, and the login saved to a file there — the one thing a session borrows from it, found
// where the platform puts it (cursorStoredLoginPath). The store is named on every platform: left to its
// default, macOS's would be the Keychain (§18.4, §18.5). No browser: the relay hands the link over instead.
func cursorLoginEnv(dir string) []string {
	return cursorOverlay(cursorBaseEnv(), map[string]string{
		"HOME":                           filepath.Join(dir, "home"),
		"CURSOR_CONFIG_DIR":              filepath.Join(dir, "config"),
		"XDG_CONFIG_HOME":                filepath.Join(dir, "xdg-config"),
		"AGENT_CLI_CREDENTIAL_STORE":     "file",
		"NO_OPEN_BROWSER":                "1",
		"DIRENV_DISABLE":                 "1",
		"CURSOR_AGENT_DISABLE_DEBUG_LOG": "1",
	})
}

// cursorLoginHintFor is how to sign the account at dir in by hand: the pinned build's own `login`, saving
// into that account's directory in a file, as cursorLoginEnv does — never the user's ~/.config/cursor or
// ~/.cursor, nor the Keychain macOS saves into by default (§18.4).
func cursorLoginHintFor(dir string) string {
	return "NO_OPEN_BROWSER=1 AGENT_CLI_CREDENTIAL_STORE=file HOME=" + shellQuote(filepath.Join(dir, "home")) +
		" XDG_CONFIG_HOME=" + shellQuote(filepath.Join(dir, "xdg-config")) +
		" CURSOR_CONFIG_DIR=" + shellQuote(filepath.Join(dir, "config")) +
		" " + shellQuote(filepath.Join(cursorVersionDir(), cursorEntryPoint)) + " login"
}

// cursorLoginAccountDir is the directory a Cursor CLI sign-in into account writes: Default's for none, an
// added account's own otherwise, which must already be one of this runner's.
func cursorLoginAccountDir(account string) (string, error) {
	if account == "" || account == accountSlotDefaultID {
		return filepath.Abs(cursorDefaultAccountDir())
	}
	dir, err := cursorAccountKind.home(account)
	if err != nil && errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("this runner has no Cursor CLI account %s — add the account again", account)
	}
	return dir, err
}
