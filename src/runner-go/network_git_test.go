//go:build linux || darwin

package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Every network git path the runner has, against a remote that answers every request the way GitLab
// answers a credential it refuses (network_git.go): the user's saved credential stays saved, nothing
// prompts, and the call answers errGitAuthFailed within its budget.
//
// Each path runs twice, with a credential saved for the remote (which the remote refuses) and with none.
// The user's git configuration is the test's own: a credential helper that logs every request git makes
// of it and carries it out — git's own credential-store, so an erase really erases — and an askpass
// program, set as core.askPass and SSH_ASKPASS, that logs that it ran. GIT_TERMINAL_PROMPT is 1 and
// GIT_ASKPASS is unset, so whatever turns prompting off is the runner's own command.
//
// git prompts on its controlling terminal, so each path runs in a process of its own whose controlling
// terminal is a pseudo-terminal this test holds (runInTestTerminal), as a runner started from a Terminal
// window has one; anything written to it fails the path. The test needs no terminal of its own.
func TestRunnerNetworkGitLeavesSavedCredential(t *testing.T) {
	paths := []struct {
		name    string
		timeout time.Duration // the path's own budget
		run     func(fx *credentialFixture) error
	}{
		{"integration_fetch", networkGitTimeout, func(fx *credentialFixture) error {
			return integrationFetch(fx.work, "origin", "refs/heads/main")
		}},
		{"integration_push", networkGitTimeout, func(fx *credentialFixture) error {
			return integrationPush(fx.work, fx.work, "origin", "refs/heads/main", fx.head, "", false)
		}},
		{"observe_ls_remote", networkGitTimeout, func(fx *credentialFixture) error {
			return lsRemoteRef(fx.work, "origin", "refs/heads/main")
		}},
		{"source_pin_fetch", networkGitTimeout, func(fx *credentialFixture) error {
			return fetchSourcePin(fx.work, "origin", "refs/heads/main", sourcePinRefName("11111111-1111-4111-8111-111111111111"))
		}},
		{"merge_recovery_fetch", networkGitTimeout, func(fx *credentialFixture) error {
			_, err := recoveryRemoteTip(fx.work, "main")
			return err
		}},
		{"merge_recovery_push", networkGitTimeout, func(fx *credentialFixture) error {
			return pushRecoveryCandidate(fx.work, fx.head, "main")
		}},
		{"merge_push", networkGitTimeout, func(fx *credentialFixture) error {
			_, err := pushMergeResult(fx.work, "main")
			return err
		}},
		{"merge_fetch", networkGitTimeout, func(fx *credentialFixture) error {
			return fetchOriginBranch(fx.work, "main")
		}},
		{"wiki_fetch", wikiAnchorFetchTimeout, func(fx *credentialFixture) error {
			_, err := fetchWikiOriginRef(fx.work)
			return err
		}},
	}
	for _, path := range paths {
		t.Run(path.name, func(t *testing.T) {
			if os.Getenv(networkGitTerminalEnv) == "" {
				runInTestTerminal(t, path.name)
				return
			}
			for _, saved := range []bool{true, false} {
				name := "credential_saved"
				if !saved {
					name = "none_saved"
				}
				t.Run(name, func(t *testing.T) {
					fx := newCredentialFixture(t, saved)
					before := fx.savedCredentials(t)
					start := time.Now()
					err := path.run(fx)
					fx.check(t, saved, err, time.Since(start), path.timeout, before)
				})
			}
		})
	}
}

// networkGitTerminalEnv marks the process runInTestTerminal starts, which runs the path itself.
const networkGitTerminalEnv = "ORBIT_TEST_NETWORK_GIT_IN_TERMINAL"

// networkGitTerminalWait is how long runInTestTerminal waits for its process. A path that answers takes a
// second or two; one waiting for an answer on the terminal would wait for good, and is stopped here.
const networkGitTerminalWait = 2 * time.Minute

// The credential the user saved for the remote, in the cases where they saved one.
const (
	savedGitUsername = "orbit"
	savedGitPassword = "s3cret"
)

// credentialFixture is one path's remote and the user around it: a checkout whose origin answers every
// request 401, and the user's git configuration, saved credentials, credential helper and askpass program.
type credentialFixture struct {
	dir   string
	work  string // a checkout with one commit on main, whose origin is the server
	head  string // that commit
	store string // the user's saved credentials (git credential-store's file)

	mu   sync.Mutex
	auth []string // the Authorization header of every request the server was sent, "" for none
}

func newCredentialFixture(t *testing.T, saved bool) *credentialFixture {
	t.Helper()
	fx := &credentialFixture{dir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fx.mu.Lock()
		fx.auth = append(fx.auth, r.Header.Get("Authorization"))
		fx.mu.Unlock()
		w.Header().Set("WWW-Authenticate", `Basic realm="GitLab"`)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("HTTP Basic: Access denied"))
	}))
	t.Cleanup(server.Close)

	fx.store = filepath.Join(fx.dir, "git-credentials")
	if saved {
		entry := strings.Replace(server.URL, "://", "://"+savedGitUsername+":"+savedGitPassword+"@", 1)
		fx.write(t, fx.store, entry+"\n")
	}
	helper := fx.script(t, "credential-helper",
		`printf '%s\n' "$1" >> `+shellQuote(fx.logPath("helper"))+"\n"+
			`exec git credential-store --file=`+shellQuote(fx.store)+` "$@"`)
	askpass := fx.script(t, "askpass",
		`printf '%s\n' "$*" >> `+shellQuote(fx.logPath("askpass"))+"\n"+
			`exit 1`)
	config := filepath.Join(fx.dir, "gitconfig")
	for _, entry := range [][2]string{
		// The helper for every remote and, as a helper is as often configured, for this one by its URL:
		// the runner's command has to put both out of its reach.
		{"credential.helper", "!" + shellQuote(helper)},
		{"credential." + server.URL + ".helper", "!" + shellQuote(helper)},
		{"core.askPass", askpass},
	} {
		mustRun(t, fx.dir, "git", "config", "--file", config, entry[0], entry[1])
	}
	t.Setenv("HOME", fx.dir)
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("SSH_ASKPASS", askpass)
	t.Setenv("GIT_TERMINAL_PROMPT", "1")
	// What the environment the test was started from may carry, and would decide the outcome in place of
	// the code under test.
	for _, name := range []string{"GIT_ASKPASS", "GCM_INTERACTIVE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}

	fx.work = filepath.Join(fx.dir, "work")
	mustRun(t, fx.dir, "git", "init", "--quiet", "--initial-branch=main", fx.work)
	fx.write(t, filepath.Join(fx.work, "README.md"), "base\n")
	mustRun(t, fx.work, "git", "add", "README.md")
	mustRun(t, fx.work, "git", "commit", "--quiet", "-m", "base")
	mustRun(t, fx.work, "git", "remote", "add", "origin", server.URL+"/group/repo.git")
	fx.head = mustGit(t, fx.work, "rev-parse", "HEAD")
	return fx
}

// check is what every path must have done, given the error it answered and how long it took.
func (fx *credentialFixture) check(t *testing.T, saved bool, err error, took, budget time.Duration, before string) {
	t.Helper()
	// 1. The user's credential helper was asked for the credential and for nothing else, and what the
	// user saved is still saved — and nothing new was.
	ops := fx.logLines(t, "helper")
	if slices.Contains(ops, "erase") || slices.Contains(ops, "store") {
		t.Errorf("the user's credential helper was asked to %q", ops)
	}
	if after := fx.savedCredentials(t); after != before {
		t.Errorf("the saved credentials were %q and are now %q", before, after)
	}
	sent := fx.authorizations()
	if saved {
		// Read-only, not none: the saved credential is what the remote was sent.
		want := "Basic " + base64.StdEncoding.EncodeToString([]byte(savedGitUsername+":"+savedGitPassword))
		if !slices.Contains(sent, want) {
			t.Errorf("the remote was never sent the saved credential: it was sent Authorization %q, and the user's helper was asked %q", sent, ops)
		}
	} else if slices.ContainsFunc(sent, func(header string) bool { return header != "" }) {
		t.Errorf("the remote was sent a credential nobody saved: Authorization %q", sent)
	}

	// 2. No askpass program ran. (The terminal is runInTestTerminal's to check.)
	if ran := fx.logLines(t, "askpass"); len(ran) > 0 {
		t.Errorf("an askpass program ran, asked %q", ran)
	}

	// 3. An authentication failure, within the path's budget, in words that say what happened.
	if !errors.Is(err, errGitAuthFailed) {
		t.Errorf("the call answered %v, want an authentication failure (errGitAuthFailed)", err)
	} else {
		want := "no Git credential is saved for the remote"
		if saved {
			want = "the remote refused the saved Git credential"
		}
		// gitStderr is what each path's report of a failed git command carries.
		if reported := gitStderr(err); !strings.Contains(reported, want) || !strings.Contains(reported, "Orbit did not prompt") {
			t.Errorf("the failure is reported as %q, want it to say %q and that Orbit did not prompt", reported, want)
		}
	}
	if took >= budget {
		t.Errorf("the call took %s, and its budget is %s", took, budget)
	}
}

func (fx *credentialFixture) authorizations() []string {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return slices.Clone(fx.auth)
}

// savedCredentials is the user's credential store as it stands, "" when it holds nothing.
func (fx *credentialFixture) savedCredentials(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(fx.store)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return string(raw)
}

func (fx *credentialFixture) logPath(name string) string {
	return filepath.Join(fx.dir, name+".log")
}

// logLines is what a logging script recorded, one line per run; none when it never ran.
func (fx *credentialFixture) logLines(t *testing.T, name string) []string {
	t.Helper()
	raw, err := os.ReadFile(fx.logPath(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func (fx *credentialFixture) script(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(fx.dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func (fx *credentialFixture) write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// runInTestTerminal runs one path's subtest again, in a process whose controlling terminal is a
// pseudo-terminal this test holds, and fails when anything was written to that terminal or when the
// process does not answer.
func runInTestTerminal(t *testing.T, name string) {
	t.Helper()
	master, terminal := openTestTerminal(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestRunnerNetworkGitLeavesSavedCredential$/^"+name+"$", "-test.count=1", "-test.v")
	cmd.Env = append(os.Environ(), networkGitTerminalEnv+"=1")
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.ExtraFiles = []*os.File{terminal} // fd 3 in the process
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 3}
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		t.Fatalf("start the path's process: %v", err)
	}
	_ = terminal.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	// Read as it is written, not only once the process is gone: a terminal's last close may flush what
	// nobody read yet (macOS), or wait for it to be read.
	var written strings.Builder
	poll := time.NewTicker(50 * time.Millisecond)
	defer poll.Stop()
	deadline := time.After(networkGitTerminalWait)
	var err error
wait:
	for {
		select {
		case err = <-done:
			break wait
		case <-poll.C:
			written.WriteString(readTestTerminal(master))
		case <-deadline:
			written.WriteString(readTestTerminal(master))
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-done
			t.Fatalf("the path was still running after %s, waiting for an answer; written to its terminal: %q\n%s",
				networkGitTerminalWait, written.String(), out.String())
		}
	}
	written.WriteString(readTestTerminal(master))
	if written.Len() > 0 {
		t.Errorf("written to the terminal: %q", written.String())
	}
	if err != nil || !strings.Contains(out.String(), "--- PASS: TestRunnerNetworkGitLeavesSavedCredential/"+name+" ") {
		t.Fatalf("the path, run with a terminal this test holds: %v\n%s", err, out.String())
	}
}

// readTestTerminal is what was written to the terminal whose master end is master and not read yet. The
// master is non-blocking, so a terminal nothing was written to answers at once.
func readTestTerminal(master int) string {
	var written []byte
	buf := make([]byte, 4096)
	for {
		n, err := syscall.Read(master, buf)
		if n > 0 {
			written = append(written, buf[:n]...)
		}
		if err != nil || n <= 0 {
			return string(written)
		}
	}
}
