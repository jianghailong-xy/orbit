//go:build linux || darwin

package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// clone-workdir/v1 and Orbit's GitHub credential (clone_workdir.go, github_credential.go) against a real git
// server: `git http-backend` behind Basic auth, standing in for github.com (githubGitOrigin). The repository is
// private: the server answers only the GitHub App's token, or the machine's own credential when a test saves the
// one it takes.

const (
	testCloneWorkspace = "11111111-2222-4333-8444-555555555555"
	testCloneToken     = "ghs_testinstallationtoken"
	testCloneMachine   = "test-machine"
	machineGoodPass    = "machine-good"
)

type githubFixture struct {
	dir  string
	root string // the repos root
	srv  string // GIT_PROJECT_ROOT
	bare string // the repository on the server
	url  string // its clone URL, as GitHub's would be
	// The machine's credential store (git credential-store's file).
	store string

	mu    sync.Mutex
	auths []string // the Authorization header of every request, "" for none
	asks  []RunnerGitCredentialRequest
	// While set, the server answers nothing until it is closed.
	hang chan struct{}
	// The answer POST /runner/git-credential gives; empty refuses.
	token string
}

func newGithubFixture(t *testing.T) *githubFixture {
	t.Helper()
	fx := &githubFixture{dir: t.TempDir(), token: testCloneToken}
	home := filepath.Join(fx.dir, "home")
	fx.root = filepath.Join(home, reposDirName)
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(fx.dir, "gitconfig")
	if err := os.WriteFile(config, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	for _, name := range []string{"GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", orbitGitCredentialEnv} {
		t.Setenv(name, "")
		_ = os.Unsetenv(name)
	}
	fx.store = filepath.Join(fx.dir, "machine-credentials")
	mustRun(t, fx.dir, "git", "config", "--file", config, "credential.helper", "store --file="+fx.store)

	// The upstream: three commits on main, in a bare repository the server serves and takes pushes into.
	fx.srv = filepath.Join(fx.dir, "srv")
	fx.bare = filepath.Join(fx.srv, "owner", "repo.git")
	seed := filepath.Join(fx.dir, "seed")
	mustRun(t, fx.dir, "git", "init", "--quiet", "--bare", "--initial-branch=main", fx.bare)
	mustRun(t, fx.bare, "git", "config", "http.receivepack", "true")
	mustRun(t, fx.dir, "git", "init", "--quiet", "--initial-branch=main", seed)
	for i, name := range []string{"one", "two", "three"} {
		if err := os.WriteFile(filepath.Join(seed, name+".txt"), []byte(name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		mustRun(t, seed, "git", "add", ".")
		mustRun(t, seed, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", name)
		if i == 0 {
			mustRun(t, seed, "git", "branch", "feature")
		}
	}
	mustRun(t, seed, "git", "push", "--quiet", fx.bare, "main", "feature")

	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	backend := &cgi.Handler{Path: gitPath, Args: []string{"http-backend"}, Env: []string{"GIT_PROJECT_ROOT=" + fx.srv, "GIT_HTTP_EXPORT_ALL=1"}}
	accepted := map[string]bool{
		basicAuth("x-access-token", testCloneToken): true,
		basicAuth("orbit", machineGoodPass):         true,
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fx.mu.Lock()
		fx.auths = append(fx.auths, r.Header.Get("Authorization"))
		hang := fx.hang
		fx.mu.Unlock()
		if hang != nil {
			<-hang
		}
		if !accepted[r.Header.Get("Authorization")] {
			w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		r.Header.Set("Authorization", "") // http-backend has no use for it
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		fx.mu.Lock()
		if fx.hang != nil {
			close(fx.hang)
			fx.hang = nil
		}
		fx.mu.Unlock()
		server.Close()
	})
	fx.url = server.URL + "/owner/repo.git"

	previousOrigin := githubGitOrigin
	githubGitOrigin = server.URL
	t.Cleanup(func() { githubGitOrigin = previousOrigin })
	setOrbitGitCredentialSource(func(_ context.Context, request RunnerGitCredentialRequest) (*RunnerGitCredentialAnswer, error) {
		fx.mu.Lock()
		defer fx.mu.Unlock()
		fx.asks = append(fx.asks, request)
		if fx.token == "" {
			return nil, &transportHTTPError{method: "POST", path: "/runner/git-credential", statusCode: 409,
				body: `{"code":"GITHUB_APP_NOT_INSTALLED","message":"Orbit's GitHub App is no longer installed on owner/repo."}`}
		}
		return &RunnerGitCredentialAnswer{Username: "x-access-token", Password: fx.token, ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339)}, nil
	})
	t.Cleanup(func() { setOrbitGitCredentialSource(nil) })
	return fx
}

func basicAuth(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

// saveMachineCredential saves the machine's own credential for the server, as `git credential approve` would.
func (fx *githubFixture) saveMachineCredential(t *testing.T, pass string) {
	t.Helper()
	entry := strings.Replace(githubGitOrigin, "://", "://orbit:"+pass+"@", 1)
	if err := os.WriteFile(fx.store, []byte(entry+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (fx *githubFixture) request(folder string) CloneRequest {
	return CloneRequest{WorkspaceID: testCloneWorkspace, WorkDir: filepath.Join(fx.root, folder), URL: fx.url, State: cloneStatePending}
}

func (fx *githubFixture) sent() []string {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]string(nil), fx.auths...)
}

func (fx *githubFixture) asked() []RunnerGitCredentialRequest {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]RunnerGitCredentialRequest(nil), fx.asks...)
}

// checkNoTokenOnDisk: the token is in neither the clone's configuration nor anywhere else in its git directory.
func checkNoTokenOnDisk(t *testing.T, repo string) {
	t.Helper()
	_ = filepath.Walk(filepath.Join(repo, ".git"), func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || info.Size() > 1<<20 {
			return nil
		}
		if raw, err := os.ReadFile(path); err == nil && strings.Contains(string(raw), testCloneToken) {
			t.Errorf("%s holds the token", path)
		}
		return nil
	})
}

func TestCloneWorkDirPathChecks(t *testing.T) {
	fx := newGithubFixture(t)
	if err := os.MkdirAll(fx.root, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(fx.dir, "elsewhere")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(fx.root, "link")); err != nil {
		t.Fatal(err)
	}
	home := filepath.Dir(fx.root)
	for name, workDir := range map[string]string{
		"outside home":   filepath.Join(fx.dir, "repo"),
		"steps up":       fx.root + "/../repo", // as sent: filepath.Join would clean the .. away
		"through a link": filepath.Join(fx.root, "link", "repo"),
		"home itself":    home,
		"relative":       "repo",
	} {
		t.Run(name, func(t *testing.T) {
			request := fx.request("x")
			request.WorkDir = workDir
			report := cloneWorkDir(context.Background(), request, testCloneMachine, func(int) {})
			if report.State != cloneStateFailed || !strings.HasPrefix(report.Error, "Orbit cannot clone into ") {
				t.Fatalf("report = %+v, want FAILED for the path", report)
			}
		})
	}
	if sent := fx.sent(); len(sent) != 0 {
		t.Errorf("a refused path still reached the server: %q", sent)
	}
	if _, err := os.Stat(filepath.Join(outside, "repo")); err == nil {
		t.Error("a clone was made through the link")
	}
}

// clone-workdir/v2: a control plane names the clone in home itself, <home>/<name>; its temporary directory is made
// beside it there, and a restart sweeps one left in home as it does one left in the repos root.
func TestCloneWorkDirIntoHome(t *testing.T) {
	fx := newGithubFixture(t)
	fx.saveMachineCredential(t, machineGoodPass)
	home := filepath.Dir(fx.root)
	request := fx.request("repo")
	request.WorkDir = filepath.Join(home, "repo")
	temp := filepath.Join(home, cloneTempPrefix+testCloneWorkspace)
	sawTemp := false
	report := cloneWorkDir(context.Background(), request, testCloneMachine, func(int) {
		if _, err := os.Stat(temp); err == nil {
			sawTemp = true
		}
	})
	if report.State != cloneStateReady {
		t.Fatalf("report = %+v, want READY", report)
	}
	if !sawTemp {
		t.Error("the clone was not made in a temporary directory in home")
	}
	if got := mustGit(t, request.WorkDir, "rev-list", "--count", "origin/main"); got != "3" {
		t.Errorf("origin/main has %s commits, want 3", got)
	}
	if _, err := os.Stat(fx.root); err == nil {
		t.Error("a clone in home made the repos root")
	}

	leftovers := []string{filepath.Join(home, cloneTempPrefix+"left-in-home"), filepath.Join(fx.root, cloneTempPrefix+"left-in-root")}
	for _, dir := range leftovers {
		if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	sweepCloneTemps()
	for _, dir := range leftovers {
		if _, err := os.Stat(dir); err == nil {
			t.Errorf("%s was left", dir)
		}
	}
	if _, err := os.Stat(request.WorkDir); err != nil {
		t.Errorf("the sweep took the finished clone: %v", err)
	}
}

func TestCloneWorkDirFolderTaken(t *testing.T) {
	fx := newGithubFixture(t)
	fx.saveMachineCredential(t, machineGoodPass)

	taken := fx.request("taken")
	if err := os.MkdirAll(taken.WorkDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taken.WorkDir, "mine.txt"), []byte("the user's\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	report := cloneWorkDir(context.Background(), taken, testCloneMachine, func(int) {})
	if want := taken.WorkDir + " already exists on " + testCloneMachine; report.State != cloneStateFailed || report.Error != want {
		t.Fatalf("report = %+v, want FAILED %q", report, want)
	}
	if raw, _ := os.ReadFile(filepath.Join(taken.WorkDir, "mine.txt")); string(raw) != "the user's\n" {
		t.Error("the folder that was there was changed")
	}

	// Another repository's clone at the target is taken too.
	other := fx.request("other")
	mustRun(t, fx.dir, "git", "init", "--quiet", other.WorkDir)
	mustRun(t, other.WorkDir, "git", "remote", "add", "origin", githubGitOrigin+"/owner/another.git")
	if report := cloneWorkDir(context.Background(), other, testCloneMachine, func(int) {}); report.State != cloneStateFailed ||
		!strings.Contains(report.Error, "already exists on") {
		t.Fatalf("another repository's clone: %+v, want FAILED", report)
	}

	// The same repository's clone (a clone whose READY was never heard) is READY, and is marked as the workspace's.
	same := fx.request("same")
	mustRun(t, fx.dir, "git", "clone", "--quiet", fx.bare, same.WorkDir)
	mustRun(t, same.WorkDir, "git", "remote", "set-url", "origin", strings.TrimSuffix(fx.url, ".git"))
	if report := cloneWorkDir(context.Background(), same, testCloneMachine, func(int) {}); report.State != cloneStateReady {
		t.Fatalf("the same repository's clone: %+v, want READY", report)
	}
	if got := githubWorkspaceOf(same.WorkDir); got != testCloneWorkspace {
		t.Errorf("the existing clone is marked %q, want %q", got, testCloneWorkspace)
	}
}

// The clone happens in a temporary directory inside the repos root and is renamed into place whole: while it runs
// the target does not exist. The clone is full, on the ref asked for, and nothing Orbit-only is in its config.
func TestCloneWorkDirTempThenRename(t *testing.T) {
	fx := newGithubFixture(t)
	fx.saveMachineCredential(t, machineGoodPass)
	request := fx.request("repo")
	ref := "feature"
	request.Ref = &ref
	temp := filepath.Join(fx.root, cloneTempPrefix+testCloneWorkspace)

	var seen []int
	sawTemp, sawTarget := false, false
	report := cloneWorkDir(context.Background(), request, testCloneMachine, func(p int) {
		seen = append(seen, p)
		if _, err := os.Stat(temp); err == nil {
			sawTemp = true
		}
		if _, err := os.Stat(request.WorkDir); err == nil {
			sawTarget = true
		}
	})
	if report.State != cloneStateReady || report.Credential != cloneCredentialMachine {
		t.Fatalf("report = %+v, want READY with the machine's credential", report)
	}
	if len(seen) == 0 || !sawTemp || sawTarget {
		t.Errorf("progress %v; temporary directory seen %v; target seen before the rename %v", seen, sawTemp, sawTarget)
	}
	if _, err := os.Stat(temp); err == nil {
		t.Error("the temporary directory is still there")
	}
	if got := mustGit(t, request.WorkDir, "rev-parse", "--is-shallow-repository"); got != "false" {
		t.Errorf("the clone is shallow: %s", got)
	}
	if got := mustGit(t, request.WorkDir, "rev-parse", "--abbrev-ref", "HEAD"); got != "feature" {
		t.Errorf("checked out %q, want feature", got)
	}
	if got := mustGit(t, request.WorkDir, "rev-list", "--count", "origin/main"); got != "3" {
		t.Errorf("origin/main has %s commits, want the whole history of 3", got)
	}
	if got := mustGit(t, request.WorkDir, "remote", "get-url", "origin"); got != fx.url {
		t.Errorf("origin is %q, want %q", got, fx.url)
	}
	if got := githubWorkspaceOf(request.WorkDir); got != testCloneWorkspace {
		t.Errorf("the clone is marked %q", got)
	}
	if asks := fx.asked(); len(asks) != 0 {
		t.Errorf("Orbit was asked for a credential the machine had: %+v", asks)
	}
}

func TestCloneWorkDirMachineCredentialThenOrbitToken(t *testing.T) {
	for _, tc := range []struct {
		name  string
		saved string // the machine's own saved password, "" for none
	}{
		{"machine_refused", "machine-wrong"},
		{"machine_has_none", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := newGithubFixture(t)
			if tc.saved != "" {
				fx.saveMachineCredential(t, tc.saved)
			}
			before, _ := os.ReadFile(fx.store)
			request := fx.request("repo")
			report := cloneWorkDir(context.Background(), request, testCloneMachine, func(int) {})
			if report.State != cloneStateReady || report.Credential != cloneCredentialGithubApp {
				t.Fatalf("report = %+v, want READY with the GitHub App's credential", report)
			}
			sent := fx.sent()
			tokenAt := slices.Index(sent, basicAuth("x-access-token", testCloneToken))
			if tokenAt < 0 {
				t.Fatalf("the server never saw the token: %q", sent)
			}
			if tc.saved != "" {
				if machineAt := slices.Index(sent, basicAuth("orbit", tc.saved)); machineAt < 0 || machineAt > tokenAt {
					t.Errorf("the machine's credential was not tried first: %q", sent)
				}
			}
			asks := fx.asked()
			if len(asks) != 1 || asks[0] != (RunnerGitCredentialRequest{WorkspaceID: testCloneWorkspace, Host: githubGitHost, Path: "owner/repo"}) {
				t.Errorf("Orbit was asked %+v, want once for owner/repo", asks)
			}
			if after, _ := os.ReadFile(fx.store); string(after) != string(before) {
				t.Errorf("the machine's saved credentials changed from %q to %q", before, after)
			}
			checkNoTokenOnDisk(t, request.WorkDir)
		})
	}

	t.Run("orbit_refuses", func(t *testing.T) {
		fx := newGithubFixture(t)
		fx.token = ""
		request := fx.request("repo")
		report := cloneWorkDir(context.Background(), request, testCloneMachine, func(int) {})
		if report.State != cloneStateFailed || !strings.Contains(report.Error, "no longer installed on owner/repo") {
			t.Fatalf("report = %+v, want FAILED with the control plane's reason", report)
		}
		if _, err := os.Stat(request.WorkDir); err == nil {
			t.Error("a failed clone left its target")
		}
		if entries, _ := os.ReadDir(fx.root); len(entries) != 0 {
			t.Errorf("a failed clone left %v in the repos root", entries)
		}
	})
}

// A landing's fetch and push in a checkout Orbit cloned run with Orbit's token when the machine has none, and the
// commit reaches the server; in any other checkout Orbit is never asked.
func TestNetworkGitLandingPushUsesOrbitToken(t *testing.T) {
	fx := newGithubFixture(t)
	request := fx.request("repo")
	if report := cloneWorkDir(context.Background(), request, testCloneMachine, func(int) {}); report.State != cloneStateReady {
		t.Fatalf("clone: %+v", report)
	}
	work := request.WorkDir
	if err := os.WriteFile(filepath.Join(work, "landed.txt"), []byte("landed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, work, "git", "add", "landed.txt")
	mustRun(t, work, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "landed")
	head := mustGit(t, work, "rev-parse", "HEAD")

	// From a linked worktree, as a landing's scratch checkout is.
	scratch := filepath.Join(fx.dir, "scratch")
	mustRun(t, work, "git", "worktree", "add", "--quiet", "--detach", scratch, head)
	if err := fetchOriginBranch(scratch, "main"); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if _, err := pushMergeResult(scratch, "main"); err != nil {
		t.Fatalf("push: %v", err)
	}
	if got := mustGit(t, fx.bare, "rev-parse", "refs/heads/main"); got != head {
		t.Errorf("the server's main is %s, want the landed %s", got, head)
	}
	checkNoTokenOnDisk(t, work)

	// A checkout that is not marked: the auth failure is answered as before.
	plain := filepath.Join(fx.dir, "plain")
	mustRun(t, fx.dir, "git", "clone", "--quiet", fx.bare, plain)
	mustRun(t, plain, "git", "remote", "set-url", "origin", fx.url)
	asks := len(fx.asked())
	if err := fetchOriginBranch(plain, "main"); err == nil {
		t.Fatal("an unmarked checkout fetched without a credential")
	}
	if len(fx.asked()) != asks {
		t.Error("Orbit was asked for an unmarked checkout's credential")
	}
}

func TestCloneWorkDirStallFails(t *testing.T) {
	fx := newGithubFixture(t)
	previous := cloneStallTimeout
	cloneStallTimeout = time.Second
	t.Cleanup(func() { cloneStallTimeout = previous })
	fx.mu.Lock()
	fx.hang = make(chan struct{})
	fx.mu.Unlock()
	start := time.Now()
	report := cloneWorkDir(context.Background(), fx.request("repo"), testCloneMachine, func(int) {})
	if report.State != cloneStateFailed || !strings.Contains(report.Error, "made no progress") {
		t.Fatalf("report = %+v, want FAILED for no progress", report)
	}
	if took := time.Since(start); took > 20*time.Second {
		t.Errorf("a stalled clone took %s to fail", took)
	}
}

// After a restart: the temporary directories the last process left are removed, a clone the control plane holds
// CLONING starts again and ends READY, and the outcome is reported until the answer stops listing it.
func TestClonerRecoversAfterRestart(t *testing.T) {
	fx := newGithubFixture(t)
	fx.saveMachineCredential(t, machineGoodPass)
	leftovers := []string{filepath.Join(fx.root, cloneTempPrefix+testCloneWorkspace), filepath.Join(fx.root, cloneTempPrefix+"another")}
	for _, dir := range leftovers {
		if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	changed := make(chan struct{}, 8)
	c := newCloner(context.Background(), testCloneMachine, func() { changed <- struct{}{} })
	request := fx.request("repo")
	request.State = cloneStateCloning
	reports, seq := c.snapshot()
	if len(reports) != 0 {
		t.Fatalf("a new process reports %+v", reports)
	}
	c.reconcile(&[]CloneRequest{request}, seq, true)
	c.wait()
	for _, dir := range leftovers[1:] {
		if _, err := os.Stat(dir); err == nil {
			t.Errorf("%s was left", dir)
		}
	}
	reports, seq = c.snapshot()
	if len(reports) != 1 || reports[0].State != cloneStateReady || reports[0].Credential != cloneCredentialMachine {
		t.Fatalf("reports = %+v, want one READY", reports)
	}
	if len(changed) == 0 {
		t.Error("the end of the clone did not ask for a beat")
	}
	// The answer to a beat sent before the outcome was carried still lists it: it is kept.
	c.reconcile(&[]CloneRequest{request}, seq-1, true)
	if reports, _ := c.snapshot(); len(reports) != 1 || reports[0].State != cloneStateReady {
		t.Fatalf("after an older answer: %+v", reports)
	}
	// The answer that applied it no longer lists it: forgotten.
	_, seq = c.snapshot()
	c.reconcile(&[]CloneRequest{}, seq, true)
	if reports, _ := c.snapshot(); len(reports) != 0 {
		t.Fatalf("after the answer that applied it: %+v", reports)
	}
}

// A Retry lists a FAILED clone PENDING again after its outcome was carried: it starts afresh.
func TestClonerRetryStartsAfresh(t *testing.T) {
	fx := newGithubFixture(t)
	fx.token = ""
	c := newCloner(context.Background(), testCloneMachine, nil)
	request := fx.request("repo")
	_, seq := c.snapshot()
	c.reconcile(&[]CloneRequest{request}, seq, true)
	c.wait()
	reports, seq := c.snapshot()
	if len(reports) != 1 || reports[0].State != cloneStateFailed {
		t.Fatalf("reports = %+v, want FAILED", reports)
	}
	fx.mu.Lock()
	fx.token = testCloneToken
	fx.mu.Unlock()
	c.reconcile(&[]CloneRequest{request}, seq, true)
	c.wait()
	if reports, _ := c.snapshot(); len(reports) != 1 || reports[0].State != cloneStateReady || reports[0].Credential != cloneCredentialGithubApp {
		t.Fatalf("after the Retry: %+v, want READY", reports)
	}
	// A draining process starts nothing, and an absent list stops nothing.
	d := newCloner(context.Background(), testCloneMachine, nil)
	d.reconcile(&[]CloneRequest{fx.request("other")}, 1, false)
	d.reconcile(nil, 2, true)
	if reports, _ := d.snapshot(); len(reports) != 0 {
		t.Errorf("a draining process started %+v", reports)
	}
}

// The helper answers Orbit's credential only for the workspace, protocol, host and repository it was issued for.
func TestOrbitGitCredentialAnswerIsScoped(t *testing.T) {
	raw := `{"workspaceId":"` + testCloneWorkspace + `","protocol":"https","host":"github.com","path":"owner/repo","username":"x-access-token","password":"tok"}`
	question := "protocol=https\nhost=github.com\npath=owner/repo.git\n"
	if answer, ok := orbitGitCredentialAnswer(testCloneWorkspace, question, raw); !ok || answer != "username=x-access-token\npassword=tok\n" {
		t.Fatalf("answer = %q, %v", answer, ok)
	}
	for name, c := range map[string]struct{ workspace, question string }{
		"another workspace":  {"99999999-2222-4333-8444-555555555555", question},
		"another repository": {testCloneWorkspace, "protocol=https\nhost=github.com\npath=owner/other.git\n"},
		"another host":       {testCloneWorkspace, "protocol=https\nhost=gitlab.com\npath=owner/repo.git\n"},
		"plain http":         {testCloneWorkspace, "protocol=http\nhost=github.com\npath=owner/repo.git\n"},
		"no path":            {testCloneWorkspace, "protocol=https\nhost=github.com\n"},
	} {
		if _, ok := orbitGitCredentialAnswer(c.workspace, c.question, raw); ok {
			t.Errorf("%s: answered", name)
		}
	}
	if _, ok := orbitGitCredentialAnswer(testCloneWorkspace, question, ""); ok {
		t.Error("answered with no credential handed over")
	}
	for _, entry := range networkGitCommandEnv(nil) {
		if strings.HasPrefix(entry, orbitGitCredentialEnv+"=") {
			t.Error("a command without Orbit's credential carries one")
		}
	}
}

func TestGithubRepoPath(t *testing.T) {
	for raw, want := range map[string]string{
		"https://github.com/Owner/Repo.git": "owner/repo",
		"https://github.com/owner/repo":     "owner/repo",
		"https://github.com/owner/repo/":    "owner/repo",
	} {
		if got, ok := githubRepoPath(raw); !ok || got != want {
			t.Errorf("githubRepoPath(%q) = %q, %v", raw, got, ok)
		}
	}
	for _, raw := range []string{
		"http://github.com/owner/repo.git",
		"https://x-access-token:t@github.com/owner/repo.git",
		"https://gitlab.com/owner/repo.git",
		"git@github.com:owner/repo.git",
		"https://github.com/owner",
		"https://github.com/owner/repo/extra",
	} {
		if got, ok := githubRepoPath(raw); ok {
			t.Errorf("githubRepoPath(%q) = %q, want refused", raw, got)
		}
	}
}

// A session in a checkout Orbit cloned from GitHub is told whose credential it is; any other is not.
func TestGithubWorkspaceSystemPromptLine(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	mustRun(t, dir, "git", "init", "--quiet", repo)
	session := &ClaimedSession{WorkDir: repo, Agent: AgentExecConfig{AppendSystemPrompt: "Be brief."}}
	if got := session.appendSystemPrompt(); got != "Be brief." {
		t.Fatalf("an unmarked checkout: %q", got)
	}
	if err := markGithubWorkspace(repo, testCloneWorkspace); err != nil {
		t.Fatal(err)
	}
	if got, want := session.appendSystemPrompt(), "Be brief.\n\n"+githubWorkspaceNote; got != want {
		t.Fatalf("a GitHub workspace: %q, want %q", got, want)
	}
	if githubWorkspaceNote != "This checkout's GitHub credential is Orbit's: land your work to push it." {
		t.Errorf("the line is %q", githubWorkspaceNote)
	}
}

func TestTransportDeclaresCloneWorkDir(t *testing.T) {
	dto, err := os.ReadFile("../shared/src/dto.ts")
	if err != nil {
		t.Fatal(err)
	}
	if want := "export const CLONE_WORKDIR_CAPABILITY = '" + cloneWorkDirCapabilityV1 + "';"; !strings.Contains(string(dto), want) {
		t.Errorf("@orbit/shared does not say %s", want)
	}
	if want := "export const CLONE_WORKDIR_HOME_CAPABILITY = '" + cloneWorkDirCapabilityV2 + "';"; !strings.Contains(string(dto), want) {
		t.Errorf("@orbit/shared does not say %s", want)
	}
	for _, list := range []string{runnerCapabilitiesV1, strings.Join(linkHello("process-a").GetCapabilities(), ",")} {
		for _, capability := range []string{cloneWorkDirCapabilityV1, cloneWorkDirCapabilityV2} {
			if !strings.Contains(","+list+",", ","+capability+",") {
				t.Errorf("%q omits %s", list, capability)
			}
		}
	}
}
