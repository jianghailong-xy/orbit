package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Who the `orbit` CLI acts as (docs/personal-access-token-design.md §7.2). Up to four credentials can
// be within reach of one command, and the first of these that is present decides, whatever the
// others hold:
//
//  1. ORBIT_SESSION_ID — the Orbit session this process runs in, which acts as itself. A personal
//     access token on hand is ignored, and stderr says so once: an agent does not become its user
//     because somebody ran `orbit login` on the machine it runs on.
//  2. ORBIT_SERVICE_TOKEN — a credential minted for a headless process (`orbit token mint`).
//  3. ORBIT_USER_TOKEN, else the login `orbit login` saved in $ORBIT_HOME/user.json — the person.
//     Passed over in a process the runner started (ORBIT_RUNNER_CHILD): the shell an EXECUTABLE
//     acceptance command or a `!` command runs in has no session to act as, and is the machine's,
//     not the person's who logged in on it.
//  4. The runner credential in $ORBIT_HOME/config.json — the machine.
//
// A rule that is present decides even when its credential cannot be used: a user.json that cannot be
// read is reported as the problem it is, and never passed over for the runner's credential.

const (
	envUserToken = "ORBIT_USER_TOKEN"
	// The control plane ORBIT_USER_TOKEN is sent to. Read only beside it: a login saved by `orbit
	// login` is sent to the server it was saved with and to no other.
	envUserServerURL = "ORBIT_SERVER_URL"
	// What every personal access token starts with (the apiserver's PAT_PREFIX).
	userTokenPrefix = "orbit_pat_"
	// Put on wherever the runner builds a process's environment (runnerChildEnv, and the environments
	// it builds from nothing), so that rule 3 is passed over there. Like rule 1 it keeps the normal
	// path from crossing identities and is no boundary: a process running as the same OS user can
	// unset it.
	envRunnerChild = "ORBIT_RUNNER_CHILD"
)

// The kinds of identity, in the order they are chosen.
const (
	identitySession = "session"
	identityService = "service"
	identityUser    = "user"
	identityRunner  = "runner"
	identityNone    = "none"
)

// userLogin is $ORBIT_HOME/user.json, what `orbit login` saved (§7.1): the token, the server it
// belongs to, and what the server said about it then. Kept apart from config.json, which is the
// runner's: the runner service reads config.json and never this file.
type userLogin struct {
	ServerURL string `json:"serverUrl"`
	Token     string `json:"token"`
	TokenID   string `json:"tokenId"`
	// The token's name, as it was issued under Settings → Access tokens.
	Name  string `json:"name"`
	Email string `json:"email"`
}

func userLoginFile() string { return filepath.Join(machineHome(), "user.json") }

// loadUserLogin reads the saved login, nil when there is none. Like the runner credential it is used
// only from private storage — a 0700 directory and a 0600 regular file — because a file someone else
// could write may name a server of theirs to send the token to. Nothing here repairs it: ORBIT_HOME
// comes from the environment, so reading must not chmod whatever path that names.
func loadUserLogin() (*userLogin, error) {
	path := userLoginFile()
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if err := validatePrivateDirectory(machineHome()); err != nil {
		return nil, fmt.Errorf("the saved login is not private: %w", err)
	}
	if _, err := validatePrivateCredentialFile(path); err != nil {
		return nil, fmt.Errorf("the saved login is not private: %w", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var login userLogin
	if err := json.Unmarshal(b, &login); err != nil {
		return nil, fmt.Errorf("%s is not a saved login: %w", path, err)
	}
	if strings.TrimSpace(login.Token) == "" || strings.TrimSpace(login.ServerURL) == "" {
		return nil, fmt.Errorf("%s has no token or no serverUrl", path)
	}
	return &login, nil
}

// saveUserLogin writes user.json as a 0600 file renamed into place in the 0700 machine home, so no
// reader ever sees half of one and the token never sits where anyone else could read it.
func saveUserLogin(login userLogin) error {
	home := machineHome()
	if err := os.MkdirAll(home, machineHomePerm); err != nil {
		return err
	}
	// MkdirAll leaves an existing directory's mode as it is. Logging in is the person's own act, so it
	// makes the directory private the way saveConfig does, rather than refusing an older one.
	if err := hardenMachineHomeDir(); err != nil {
		return err
	}
	if err := validatePrivateDirectory(home); err != nil {
		return err
	}
	path := userLoginFile()
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file; remove it and log in again", path)
	}
	b, err := json.MarshalIndent(login, "", "  ")
	if err != nil {
		return err
	}
	// CreateTemp makes the file 0600.
	tmp, err := os.CreateTemp(home, ".user-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// removeUserLogin deletes the saved login; there being none is not an error.
func removeUserLogin() error {
	if err := os.Remove(userLoginFile()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// cliIdentity is who a command acts as and which rule of the order chose it: what `orbit whoami`
// prints and `orbit capabilities --json` carries as `identity`. Every field but the kind and the
// reason is what this process knows of that identity, and is left out when it knows nothing.
type cliIdentity struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
	// Set when the chosen credential cannot be used: what is wrong, and what to do about it.
	Problem string `json:"problem,omitempty"`
	// A session's: the session. And whether a personal access token is on hand and being ignored —
	// inside a session, or in a process the runner started.
	SessionID        string `json:"sessionId,omitempty"`
	UserTokenIgnored bool   `json:"userTokenIgnored,omitempty"`
	// The control plane a user's or the runner's credential is for.
	ServerURL string `json:"serverUrl,omitempty"`
	// A user's: where the token came from — ORBIT_USER_TOKEN or the path of user.json — and who it is.
	Source    string `json:"source,omitempty"`
	UserID    string `json:"userId,omitempty"`
	Email     string `json:"email,omitempty"`
	TokenID   string `json:"tokenId,omitempty"`
	TokenName string `json:"tokenName,omitempty"`
	// A user's or a service token's grant, as far as this process knows it.
	Scopes       []string `json:"scopes,omitempty"`
	WorkspaceIDs []string `json:"workspaceIds,omitempty"`
	ExpiresAt    string   `json:"expiresAt,omitempty"`
	NeverExpires bool     `json:"neverExpires,omitempty"`
	// The runner's.
	RunnerID   string `json:"runnerId,omitempty"`
	RunnerName string `json:"runnerName,omitempty"`

	// The credential itself, for the commands that act with it. Never printed.
	token string
	// Whether the server has confirmed a user's token and filled in its grant (`orbit whoami`).
	verified bool
	// Whether the runner started this process, which passed the person over (envRunnerChild).
	runnerChild bool
}

// runnerChildReason ends the reason of an identity chosen in a process the runner started.
const runnerChildReason = ": the Orbit runner started this process (ORBIT_RUNNER_CHILD is set), and the CLI there acts as the machine, never as a login saved on it"

// resolveCLIIdentity applies the order. It reads the environment and $ORBIT_HOME only: whether a
// token still works is the server's to say, which `orbit whoami` asks and `capabilities` does not.
func resolveCLIIdentity() cliIdentity {
	if sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")); sessionID != "" {
		return cliIdentity{
			Kind:             identitySession,
			Reason:           "ORBIT_SESSION_ID is set: inside an Orbit session the CLI acts as that session",
			SessionID:        sessionID,
			UserTokenIgnored: userTokenOnHand(),
		}
	}
	if token := currentServiceToken(); token != "" {
		identity := cliIdentity{Kind: identityService, Reason: "ORBIT_SERVICE_TOKEN is set", token: token}
		if claims := decodeServiceTokenClaims(token); claims != nil {
			identity.Scopes = claims.Scopes
			if claims.WorkspaceID != "" {
				identity.WorkspaceIDs = []string{claims.WorkspaceID}
			}
			if claims.Exp > 0 {
				identity.ExpiresAt = time.Unix(claims.Exp, 0).UTC().Format(time.RFC3339)
			}
		}
		return identity
	}
	// A process the runner started passes the person over for the machine.
	runnerChild := strings.TrimSpace(os.Getenv(envRunnerChild)) != ""
	if token := strings.TrimSpace(os.Getenv(envUserToken)); token != "" && !runnerChild {
		return cliIdentity{
			Kind: identityUser, Reason: "ORBIT_USER_TOKEN is set", Source: envUserToken,
			ServerURL: userTokenServer(), token: token,
		}
	}
	if path := userLoginFile(); exists(path) && !runnerChild {
		identity := cliIdentity{Kind: identityUser, Reason: "the login `orbit login` saved in " + path, Source: path}
		login, err := loadUserLogin()
		if err != nil {
			identity.Problem = fmt.Sprintf("%v: run `orbit login --with-token` to save it again, or `orbit logout --keep-token` to remove it", err)
			return identity
		}
		identity.ServerURL = login.ServerURL
		identity.Email = login.Email
		identity.TokenID = login.TokenID
		identity.TokenName = login.Name
		identity.token = login.Token
		return identity
	}
	if path := configPath(); exists(path) {
		identity := cliIdentity{Kind: identityRunner, Reason: "the runner credential in " + path}
		if runnerChild {
			identity.Reason += runnerChildReason
			identity.UserTokenIgnored, identity.runnerChild = userTokenOnHand(), true
		}
		if err := configStoragePrivate(); err != nil {
			identity.Problem = fmt.Sprintf("runner credential storage is not private (%v); restart the Orbit runner once to migrate it", err)
			return identity
		}
		cfg := loadConfig()
		if cfg == nil || cfg.RunnerToken == "" {
			identity.Problem = path + " holds no runner credential: run `orbit register`"
			return identity
		}
		identity.ServerURL = cfg.ServerURL
		identity.RunnerID = cfg.RunnerID
		identity.RunnerName = cfg.Name
		identity.token = cfg.RunnerToken
		return identity
	}
	if runnerChild {
		return cliIdentity{
			Kind:             identityNone,
			Reason:           "no ORBIT_SESSION_ID or ORBIT_SERVICE_TOKEN and no runner credential" + runnerChildReason,
			Problem:          "no runner credential at " + configPath() + ": a process the Orbit runner started acts with nothing else",
			UserTokenIgnored: userTokenOnHand(),
			runnerChild:      true,
		}
	}
	return cliIdentity{
		Kind:    identityNone,
		Reason:  "no ORBIT_SESSION_ID, ORBIT_SERVICE_TOKEN or ORBIT_USER_TOKEN, no saved login and no runner credential",
		Problem: "not logged in: run `orbit login --with-token` to act as yourself, or `orbit register` to make this machine a runner",
	}
}

// exists reports whether something is at path. Anything Lstat cannot rule out counts: a credential
// that may be there decides the order, and its problem is reported, rather than the next one used.
func exists(path string) bool {
	_, err := os.Lstat(path)
	return !os.IsNotExist(err)
}

// userTokenOnHand reports whether this process could act as its user: ORBIT_USER_TOKEN is set or a
// login is saved.
func userTokenOnHand() bool {
	return strings.TrimSpace(os.Getenv(envUserToken)) != "" || exists(userLoginFile())
}

// userTokenServer is where ORBIT_USER_TOKEN is sent: ORBIT_SERVER_URL, else the control plane this
// machine's runner is registered with, else the one this binary was built for.
func userTokenServer() string {
	return strings.TrimRight(firstNonEmpty(strings.TrimSpace(os.Getenv(envUserServerURL)), runnerServerURL(), defaultServer), "/")
}

// runnerServerURL is the control plane in config.json, or "" without one. Only the URL is read.
func runnerServerURL() string {
	if cfg := loadConfig(); cfg != nil {
		return cfg.ServerURL
	}
	return ""
}

// userTokenIgnoredOnce keeps the notice below to one line per process, however many times a command
// works out who it acts as.
var userTokenIgnoredOnce sync.Once

// noteUserTokenIgnored says on stderr, once, that a personal access token is on hand and is not used
// because this process runs inside an Orbit session, or was started by the runner (§7.2).
func noteUserTokenIgnored(identity cliIdentity, errOut io.Writer) {
	if !identity.UserTokenIgnored {
		return
	}
	userTokenIgnoredOnce.Do(func() {
		if identity.Kind == identitySession {
			fmt.Fprintln(errOut, "orbit: ignoring the personal access token on this machine: inside an Orbit session (ORBIT_SESSION_ID is set) the CLI acts as the session")
			return
		}
		fmt.Fprintln(errOut, "orbit: ignoring the personal access token on this machine: the Orbit runner started this process (ORBIT_RUNNER_CHILD is set), and the CLI there acts as the machine")
	})
}
