package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// userModeEnv isolates a test from the session it may be run in: an ORBIT_HOME of its own, none of
// the variables that choose an identity, and the once-per-process notice ready to be said again.
func userModeEnv(t *testing.T) string {
	t.Helper()
	home := filepath.Join(t.TempDir(), "orbit-home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	for _, key := range []string{"ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID", envServiceToken, envUserToken, envUserServerURL, envMCPOrchestration, envOrchestrationToken} {
		t.Setenv(key, "")
	}
	userTokenIgnoredOnce = sync.Once{}
	return home
}

// The order of docs/personal-access-token-design.md §7.2, one row per combination that matters: each
// credential wins over every one below it, and a session wins over all of them — including a
// personal access token in the environment or saved by `orbit login`, which it ignores.
func TestCLIIdentityFollowsTheOrderSessionServiceUserRunner(t *testing.T) {
	type setup struct {
		session, userToken, serverURL bool
		service                       bool
		savedLogin, runner            bool
	}
	cases := []struct {
		name       string
		have       setup
		kind       string
		reason     string
		source     string // "env", "file" or ""
		server     string // "env", "file", "runner", "default" or ""
		tokenFrom  string // the credential the identity would act with
		patIgnored bool
	}{
		{name: "everything: the session wins and ignores the personal access token",
			have: setup{session: true, service: true, userToken: true, serverURL: true, savedLogin: true, runner: true},
			kind: identitySession, reason: "ORBIT_SESSION_ID is set", patIgnored: true},
		{name: "a session and a saved login: the login is ignored",
			have: setup{session: true, savedLogin: true, runner: true},
			kind: identitySession, reason: "ORBIT_SESSION_ID is set", patIgnored: true},
		{name: "a session and ORBIT_USER_TOKEN: the token is ignored",
			have: setup{session: true, userToken: true},
			kind: identitySession, reason: "ORBIT_SESSION_ID is set", patIgnored: true},
		{name: "a session alone: nothing to ignore",
			have: setup{session: true, runner: true},
			kind: identitySession, reason: "ORBIT_SESSION_ID is set"},
		{name: "a service token wins over the person and the runner",
			have: setup{service: true, userToken: true, serverURL: true, savedLogin: true, runner: true},
			kind: identityService, reason: "ORBIT_SERVICE_TOKEN is set", tokenFrom: "service"},
		{name: "ORBIT_USER_TOKEN wins over the saved login and the runner, with ORBIT_SERVER_URL",
			have: setup{userToken: true, serverURL: true, savedLogin: true, runner: true},
			kind: identityUser, reason: "ORBIT_USER_TOKEN is set", source: "env", server: "env", tokenFrom: "env"},
		{name: "ORBIT_USER_TOKEN without ORBIT_SERVER_URL goes to the runner's server",
			have: setup{userToken: true, runner: true},
			kind: identityUser, reason: "ORBIT_USER_TOKEN is set", source: "env", server: "runner", tokenFrom: "env"},
		{name: "ORBIT_USER_TOKEN with neither goes to the built-in server",
			have: setup{userToken: true},
			kind: identityUser, reason: "ORBIT_USER_TOKEN is set", source: "env", server: "default", tokenFrom: "env"},
		{name: "the saved login wins over the runner",
			have: setup{savedLogin: true, runner: true, serverURL: true},
			kind: identityUser, reason: "the login `orbit login` saved in", source: "file", server: "file", tokenFrom: "file"},
		{name: "the runner credential when nothing else is there",
			have: setup{runner: true, serverURL: true},
			kind: identityRunner, reason: "the runner credential in", server: "runner", tokenFrom: "runner"},
		{name: "nothing at all",
			have: setup{serverURL: true},
			kind: identityNone, reason: "no ORBIT_SESSION_ID"},
	}
	const (
		envToken   = userTokenPrefix + "from-the-environment"
		savedToken = userTokenPrefix + "saved-by-login"
		envServer  = "https://env.orbit.test"
		fileServer = "https://saved.orbit.test"
		runnerURL  = "https://runner.orbit.test"
	)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := userModeEnv(t)
			service := fakeServiceToken(t, []string{"session:get"}, "ws-pinned", time.Hour)
			if tc.have.session {
				t.Setenv("ORBIT_SESSION_ID", "session-1")
			}
			if tc.have.service {
				t.Setenv(envServiceToken, service)
			}
			if tc.have.userToken {
				t.Setenv(envUserToken, envToken)
			}
			if tc.have.serverURL {
				t.Setenv(envUserServerURL, envServer+"/")
			}
			if tc.have.savedLogin {
				if err := saveUserLogin(userLogin{ServerURL: fileServer, Token: savedToken, TokenID: "pat-1", Name: "laptop", Email: "me@example.test"}); err != nil {
					t.Fatal(err)
				}
			}
			if tc.have.runner {
				if err := saveConfig(&RunnerConfig{ServerURL: runnerURL, RunnerID: "runner-1", RunnerToken: "runner-secret", Name: "build-box"}); err != nil {
					t.Fatal(err)
				}
			}

			identity := resolveCLIIdentity()
			if identity.Kind != tc.kind {
				t.Fatalf("kind = %q (%s), want %q", identity.Kind, identity.Reason, tc.kind)
			}
			if !strings.HasPrefix(identity.Reason, tc.reason) {
				t.Errorf("reason = %q, want it to start %q", identity.Reason, tc.reason)
			}
			if identity.UserTokenIgnored != tc.patIgnored {
				t.Errorf("userTokenIgnored = %v, want %v", identity.UserTokenIgnored, tc.patIgnored)
			}
			wantSource := map[string]string{"env": envUserToken, "file": filepath.Join(home, "user.json")}[tc.source]
			if identity.Source != wantSource {
				t.Errorf("source = %q, want %q", identity.Source, wantSource)
			}
			wantServer := map[string]string{"env": envServer, "file": fileServer, "runner": runnerURL, "default": defaultServer}[tc.server]
			if identity.ServerURL != wantServer {
				t.Errorf("server = %q, want %q", identity.ServerURL, wantServer)
			}
			wantToken := map[string]string{"service": service, "env": envToken, "file": savedToken, "runner": "runner-secret"}[tc.tokenFrom]
			if identity.token != wantToken {
				t.Errorf("acts with %q, want %q", identity.token, wantToken)
			}
			if (identity.Problem != "") != (tc.kind == identityNone) {
				t.Errorf("problem = %q", identity.Problem)
			}
			switch tc.kind {
			case identitySession:
				if identity.SessionID != "session-1" {
					t.Errorf("session = %q", identity.SessionID)
				}
			case identityService:
				if strings.Join(identity.Scopes, ",") != "session:get" || strings.Join(identity.WorkspaceIDs, ",") != "ws-pinned" || identity.ExpiresAt == "" {
					t.Errorf("service grant = %v %v %q", identity.Scopes, identity.WorkspaceIDs, identity.ExpiresAt)
				}
			case identityRunner:
				if identity.RunnerID != "runner-1" || identity.RunnerName != "build-box" {
					t.Errorf("runner = %q %q", identity.RunnerID, identity.RunnerName)
				}
			}
			if tc.source == "file" && (identity.Email != "me@example.test" || identity.TokenID != "pat-1" || identity.TokenName != "laptop") {
				t.Errorf("saved login read as %q %q %q", identity.Email, identity.TokenID, identity.TokenName)
			}
			// What `capabilities --json` and `whoami --json` print never carries a credential.
			printed, err := json.Marshal(identity)
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{envToken, savedToken, "runner-secret", service} {
				if strings.Contains(string(printed), secret) {
					t.Errorf("the identity's JSON carries a credential: %s", printed)
				}
			}
		})
	}
}

// A saved login that cannot be used is the problem it is: the CLI does not fall through to the
// runner's credential, which would quietly make a person's commands the machine's.
func TestCLIIdentityReportsAnUnusableSavedLoginRatherThanFallingBackToTheRunner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not enforced on Windows")
	}
	for name, spoil := range map[string]func(t *testing.T, path string){
		"readable by others": func(t *testing.T, path string) {
			if err := os.Chmod(path, 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"not JSON": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("orbit_pat_x"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"without a token": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte(`{"serverUrl":"https://orbit.test"}`), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"a symlink": func(t *testing.T, path string) {
			target := path + ".real"
			if err := os.Rename(path, target); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			userModeEnv(t)
			if err := saveConfig(&RunnerConfig{ServerURL: "https://orbit.test", RunnerToken: "runner-secret"}); err != nil {
				t.Fatal(err)
			}
			if err := saveUserLogin(userLogin{ServerURL: "https://orbit.test", Token: userTokenPrefix + "x", TokenID: "pat-1"}); err != nil {
				t.Fatal(err)
			}
			spoil(t, userLoginFile())
			identity := resolveCLIIdentity()
			if identity.Kind != identityUser || identity.Problem == "" || identity.token != "" {
				t.Fatalf("identity = %+v, want the person, unusable, acting with nothing", identity)
			}
			if !strings.Contains(identity.Problem, "orbit login") {
				t.Errorf("problem %q does not say how to fix it", identity.Problem)
			}
		})
	}
}

// Inside a session a personal access token on hand is not used, and the CLI says so on stderr —
// once per process, however many times it works out who it is.
func TestSessionIgnoresThePersonalAccessTokenAndSaysSoOnce(t *testing.T) {
	userModeEnv(t)
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	t.Setenv(envUserToken, userTokenPrefix+"on-hand")
	var errOut bytes.Buffer
	for i := 0; i < 3; i++ {
		noteUserTokenIgnored(resolveCLIIdentity(), &errOut)
	}
	if got := strings.Count(errOut.String(), "ignoring the personal access token"); got != 1 {
		t.Fatalf("the notice was said %d times:\n%s", got, errOut.String())
	}
	if strings.Contains(errOut.String(), "on-hand") {
		t.Errorf("the notice prints the token: %q", errOut.String())
	}

	// Nothing to ignore, nothing said.
	userTokenIgnoredOnce = sync.Once{}
	t.Setenv(envUserToken, "")
	errOut.Reset()
	noteUserTokenIgnored(resolveCLIIdentity(), &errOut)
	if errOut.Len() != 0 {
		t.Errorf("a session with no token on hand was told %q", errOut.String())
	}
}

func TestSavedLoginIsPrivateAndReplacedWhole(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not enforced on Windows")
	}
	home := userModeEnv(t)
	// An older machine home that is not private yet: logging in makes it so.
	if err := os.Chmod(home, 0o755); err != nil {
		t.Fatal(err)
	}
	first := userLogin{ServerURL: "https://orbit.test", Token: userTokenPrefix + "first", TokenID: "pat-1", Name: "first", Email: "me@example.test"}
	if err := saveUserLogin(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.Token, second.TokenID, second.Name = userTokenPrefix+"second", "pat-2", "second"
	if err := saveUserLogin(second); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{home: 0o700, userLoginFile(): 0o600} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Errorf("%s has mode %04o, want %04o", path, info.Mode().Perm(), want)
		}
	}
	loaded, err := loadUserLogin()
	if err != nil || loaded == nil || *loaded != second {
		t.Fatalf("loaded %+v, %v; want %+v", loaded, err, second)
	}
	raw, err := os.ReadFile(userLoginFile())
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]interface{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"serverUrl", "token", "tokenId", "name", "email"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("user.json lacks %s: %s", key, raw)
		}
	}
	if len(fields) != 5 {
		t.Errorf("user.json = %s, want exactly serverUrl, token, tokenId, name, email", raw)
	}
	// No temporary file is left beside it, and the runner's config.json is not touched.
	entries, _ := os.ReadDir(home)
	for _, entry := range entries {
		if entry.Name() != "user.json" {
			t.Errorf("left %s in the machine home", entry.Name())
		}
	}
	if err := removeUserLogin(); err != nil {
		t.Fatal(err)
	}
	if err := removeUserLogin(); err != nil {
		t.Fatalf("removing a login that is not there: %v", err)
	}
	if loaded, err := loadUserLogin(); loaded != nil || err != nil {
		t.Fatalf("after removal: %+v, %v", loaded, err)
	}
}
