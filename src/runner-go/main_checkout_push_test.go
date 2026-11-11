//go:build linux || darwin

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Real-Git tests for Push in the main checkout (docs/main-checkout-git-contract.md §5 "push"),
// against a local bare remote, an HTTP remote that refuses every credential, an SSH remote whose
// key is refused and a remote nobody answers at.

// pushArgv is every argv push sent to a remote while recordPushArgv was on.
var (
	pushArgvMu sync.Mutex
	pushArgv   [][]string
)

// recordPushArgv appends every remote git command push runs to pushArgv for the test's duration.
func recordPushArgv(t *testing.T) {
	old := mainCheckoutPushGit
	mainCheckoutPushGit = func(ctx context.Context, root string, args ...string) (string, string, error) {
		pushArgvMu.Lock()
		pushArgv = append(pushArgv, append([]string(nil), args...))
		pushArgvMu.Unlock()
		return old(ctx, root, args...)
	}
	t.Cleanup(func() { mainCheckoutPushGit = old })
}

// pushRepo is a checkout on main whose origin is a fresh bare repository; with tracking, main is
// pushed there and set as main's upstream.
func pushRepo(t *testing.T, tracking bool) (repo, bare string) {
	t.Helper()
	recordPushArgv(t)
	repo = realRepo(t)
	bare = filepath.Join(t.TempDir(), "origin.git")
	mustGit(t, repo, "init", "--bare", "-b", "main", bare)
	mustGit(t, repo, "remote", "add", "origin", bare)
	if tracking {
		mustGit(t, repo, "push", "-u", "origin", "main")
	}
	return repo, bare
}

func pushCmd(t *testing.T, repo string) MainCheckoutActionCommand {
	t.Helper()
	scan := mustScan(t, repo)
	return MainCheckoutActionCommand{MainCheckoutActionRequest: MainCheckoutActionRequest{
		Kind: mainCheckoutPush, Root: scan.Snapshot.Root, Fingerprint: scan.Snapshot.Fingerprint,
		RequestID: "req-push",
	}}
}

func runPush(t *testing.T, repo string) MainCheckoutActionResult {
	t.Helper()
	res, err := pushMainCheckout(context.Background(), pushCmd(t, repo))
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	if res.FinishedAt == "" || res.Kind != mainCheckoutPush || res.RequestID != "req-push" {
		t.Fatalf("result envelope incomplete: %+v", res)
	}
	return res
}

func remoteRef(t *testing.T, bare, ref string) string {
	t.Helper()
	out, _ := git(bare, "rev-parse", "--verify", "--quiet", ref)
	return out
}

func TestMainCheckoutPushUpdatesUpstream(t *testing.T) {
	repo, bare := pushRepo(t, true)
	before := mustGit(t, repo, "rev-parse", "HEAD")
	commitFile(t, repo, "a.txt", "a\n", "a")
	commitFile(t, repo, "b.txt", "b\n", "b")
	head := mustGit(t, repo, "rev-parse", "HEAD")
	mcWrite(t, repo, "dirty.txt", "not part of a push\n") // the working tree doesn't matter to Push

	res := runPush(t, repo)
	if res.Status != mainCheckoutDone || res.Code != "" {
		t.Fatalf("want done, got %+v", res)
	}
	if got := remoteRef(t, bare, "refs/heads/main"); got != head {
		t.Fatalf("remote main = %s, want %s", got, head)
	}
	if res.Branch != "main" || res.Upstream != "origin/main" || res.RemoteBefore != before || res.RemoteAfter != head || res.Head != head {
		t.Fatalf("result fields: %+v", res)
	}
	if got := mustGit(t, repo, "rev-parse", "HEAD"); got != head {
		t.Fatalf("local HEAD moved: %s", got)
	}

	// Again: nothing left to push.
	if res := runPush(t, repo); res.Status != mainCheckoutRefused || res.Code != mainCheckoutNothingToPush {
		t.Fatalf("want NOTHING_TO_PUSH, got %+v", res)
	}
}

// An upstream with another name is pushed to as it is, not to a same-named branch.
func TestMainCheckoutPushToDifferentlyNamedUpstream(t *testing.T) {
	repo, bare := pushRepo(t, false)
	mustGit(t, repo, "push", "origin", "main:trunk")
	mustGit(t, repo, "fetch", "origin")
	mustGit(t, repo, "branch", "--set-upstream-to=origin/trunk", "main")
	commitFile(t, repo, "c.txt", "c\n", "c")
	head := mustGit(t, repo, "rev-parse", "HEAD")

	res := runPush(t, repo)
	if res.Status != mainCheckoutDone || res.Upstream != "origin/trunk" {
		t.Fatalf("want done to origin/trunk, got %+v", res)
	}
	if got := remoteRef(t, bare, "refs/heads/trunk"); got != head {
		t.Fatalf("remote trunk = %s, want %s", got, head)
	}
	if got := remoteRef(t, bare, "refs/heads/main"); got != "" {
		t.Fatalf("remote main should not exist, is %s", got)
	}
}

func TestMainCheckoutPushNoUpstreamSetsOriginBranch(t *testing.T) {
	repo, bare := pushRepo(t, true)
	mustGit(t, repo, "checkout", "-q", "-b", "feature/x")
	commitFile(t, repo, "f.txt", "f\n", "f")
	head := mustGit(t, repo, "rev-parse", "HEAD")

	res := runPush(t, repo)
	if res.Status != mainCheckoutDone || res.Branch != "feature/x" || res.Upstream != "origin/feature/x" || res.RemoteBefore != "" || res.RemoteAfter != head {
		t.Fatalf("want a new-branch push, got %+v", res)
	}
	if got := remoteRef(t, bare, "refs/heads/feature/x"); got != head {
		t.Fatalf("remote feature/x = %s, want %s", got, head)
	}
	if got := mustGit(t, repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); got != "origin/feature/x" {
		t.Fatalf("upstream = %q, want origin/feature/x", got)
	}
}

func TestMainCheckoutPushDivergedIsRejected(t *testing.T) {
	repo, bare := pushRepo(t, true)
	// Somebody else lands two commits on origin/main.
	other := filepath.Join(t.TempDir(), "other")
	mustGit(t, t.TempDir(), "clone", "-q", bare, other)
	mustGit(t, other, "config", "user.email", "o@orbit")
	mustGit(t, other, "config", "user.name", "o")
	commitFile(t, other, "o1.txt", "1\n", "o1")
	commitFile(t, other, "o2.txt", "2\n", "o2")
	mustGit(t, other, "push", "-q", "origin", "main")
	remoteTip := remoteRef(t, bare, "refs/heads/main")

	commitFile(t, repo, "mine.txt", "mine\n", "mine")
	head := mustGit(t, repo, "rev-parse", "HEAD")
	branches := mustGit(t, repo, "for-each-ref", "refs/heads")

	res := runPush(t, repo)
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutPushRejected {
		t.Fatalf("want PUSH_REJECTED, got %+v", res)
	}
	if res.Ahead == nil || *res.Ahead != 1 || res.Behind == nil || *res.Behind != 2 {
		t.Fatalf("ahead/behind = %v/%v, want 1/2", res.Ahead, res.Behind)
	}
	if res.RemoteBefore != remoteTip || res.RemoteAfter != "" {
		t.Fatalf("remote fields: %+v", res)
	}
	if got := mustGit(t, repo, "rev-parse", "HEAD"); got != head {
		t.Fatalf("local HEAD moved: %s, want %s", got, head)
	}
	if got := mustGit(t, repo, "for-each-ref", "refs/heads"); got != branches {
		t.Fatalf("local branches changed:\n%s\nwas\n%s", got, branches)
	}
	if got := remoteRef(t, bare, "refs/heads/main"); got != remoteTip {
		t.Fatalf("remote main moved: %s", got)
	}
}

func TestMainCheckoutPushRefusals(t *testing.T) {
	t.Run("no remote", func(t *testing.T) {
		recordPushArgv(t)
		repo := realRepo(t)
		if res := runPush(t, repo); res.Code != mainCheckoutNoRemote || res.Status != mainCheckoutRefused {
			t.Fatalf("want NO_REMOTE, got %+v", res)
		}
	})
	t.Run("head moved", func(t *testing.T) {
		repo, bare := pushRepo(t, true)
		cmd := pushCmd(t, repo)
		commitFile(t, repo, "late.txt", "late\n", "late")
		res, err := pushMainCheckout(context.Background(), cmd)
		if err != nil || res.Code != mainCheckoutHeadMoved || res.Head != mustGit(t, repo, "rev-parse", "HEAD") {
			t.Fatalf("want HEAD_MOVED, got %+v %v", res, err)
		}
		if got := remoteRef(t, bare, "refs/heads/main"); got == res.Head {
			t.Fatal("a refused push pushed")
		}
	})
	t.Run("detached", func(t *testing.T) {
		repo, _ := pushRepo(t, true)
		mustGit(t, repo, "checkout", "-q", "--detach")
		if res := runPush(t, repo); res.Code != mainCheckoutDetached {
			t.Fatalf("want DETACHED, got %+v", res)
		}
	})
}

// The credential in the remote's URL, and a token-shaped one, never reach the result.
const (
	pushTestUser  = "alice-orbit"
	pushTestToken = "ghp_0123456789abcdefABCDEF0123456789abcd"
)

func assertNoCredential(t *testing.T, res MainCheckoutActionResult) {
	t.Helper()
	t.Logf("%s: gitMessage %q", res.Code, res.GitMessage)
	for _, field := range []string{res.GitMessage, res.Upstream, res.Branch} {
		for _, secret := range []string{pushTestUser, pushTestToken, "s3cret-pass"} {
			if strings.Contains(field, secret) {
				t.Fatalf("result carries a credential %q: %+v", secret, res)
			}
		}
	}
}

// isolatePushGitConfig keeps the machine's own git configuration and credential helpers out.
func isolatePushGitConfig(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(dir, "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_TERMINAL_PROMPT", "1") // the push turns prompting off itself
	for _, name := range []string{"GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "GIT_SSH"} {
		t.Setenv(name, "")
		os.Unsetenv(name)
	}
}

func TestMainCheckoutPushAuthFailedHTTP(t *testing.T) {
	isolatePushGitConfig(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="Git"`)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("HTTP Basic: Access denied"))
	}))
	t.Cleanup(server.Close)

	for _, url := range []string{
		strings.Replace(server.URL, "://", "://"+pushTestUser+":"+pushTestToken+"@", 1) + "/group/repo.git",
		server.URL + "/group/repo.git", // no credential at all: git can't ask for one
	} {
		recordPushArgv(t)
		repo := realRepo(t)
		mustGit(t, repo, "remote", "add", "origin", url)
		head := mustGit(t, repo, "rev-parse", "HEAD")
		res := runPush(t, repo)
		if res.Status != mainCheckoutRefused || res.Code != mainCheckoutPushAuthFailed || res.GitMessage == "" {
			t.Fatalf("%s: want PUSH_AUTH_FAILED with git's reason, got %+v", url, res)
		}
		if strings.Contains(res.GitMessage, "\n") {
			t.Fatalf("gitMessage is not one line: %q", res.GitMessage)
		}
		assertNoCredential(t, res)
		if got := mustGit(t, repo, "rev-parse", "HEAD"); got != head {
			t.Fatalf("local HEAD moved: %s", got)
		}
	}
}

func TestMainCheckoutPushAuthFailedSSH(t *testing.T) {
	isolatePushGitConfig(t)
	// ssh as a server refusing the key answers, echoing the destination it was given.
	fake := filepath.Join(t.TempDir(), "fake-ssh")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho \"$* : Permission denied (publickey).\" >&2\nexit 255\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_SSH_COMMAND", fake)
	recordPushArgv(t)
	repo := realRepo(t)
	mustGit(t, repo, "remote", "add", "origin", "ssh://"+pushTestUser+":s3cret-pass@git.example.invalid/group/repo.git")
	res := runPush(t, repo)
	if res.Code != mainCheckoutPushAuthFailed || !strings.Contains(res.GitMessage, "Permission denied (publickey)") {
		t.Fatalf("want PUSH_AUTH_FAILED with git's reason, got %+v", res)
	}
	assertNoCredential(t, res)
}

func TestMainCheckoutPushUnreachableRemote(t *testing.T) {
	isolatePushGitConfig(t)
	recordPushArgv(t)
	repo := realRepo(t)
	// Port 1 on loopback: nobody answers.
	mustGit(t, repo, "remote", "add", "origin", "http://"+pushTestUser+":"+pushTestToken+"@127.0.0.1:1/group/repo.git")
	head := mustGit(t, repo, "rev-parse", "HEAD")
	res := runPush(t, repo)
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutPushFailed || res.GitMessage == "" {
		t.Fatalf("want PUSH_FAILED with git's reason, got %+v", res)
	}
	assertNoCredential(t, res)
	if got := mustGit(t, repo, "rev-parse", "HEAD"); got != head {
		t.Fatalf("local HEAD moved: %s", got)
	}
}

func TestRedactGitMessage(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"unable to access 'https://bob:hunter22@github.com/o/r.git/': 403", "unable to access 'https://github.com/o/r.git/': 403"},
		{"Authentication failed for 'https://x-access-token:" + pushTestToken + "@github.com/o/r.git/'", "Authentication failed for 'https://github.com/o/r.git/'"},
		{"token " + pushTestToken + " was refused", "token [redacted] was refused"},
		{"bad glpat-abcdefghijklmnopqrstu", "bad [redacted]"},
		{"Authorization: Bearer abc.def.ghi-jkl", "Authorization: Bearer [redacted]"},
		{"GET /r.git?access_token=abcd1234&x=1", "GET /r.git?access_token=[redacted]&x=1"},
		{"git@github.com: Permission denied (publickey).", "git@github.com: Permission denied (publickey)."},
	} {
		if got := redactGitMessage(tc.in, nil); got != tc.want {
			t.Errorf("redact(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := redactGitMessage("user hunter22 refused", []string{"hunter22"}); got != "user [redacted] refused" {
		t.Errorf("remote URL secret kept: %q", got)
	}
}

// Every command push sends to a remote, across every scenario above, is a plain push or a read:
// never --force (or its spellings) and never a +refspec.
func TestMainCheckoutPushNeverForces(t *testing.T) {
	pushArgvMu.Lock()
	pushArgv = nil
	pushArgvMu.Unlock()
	for name, fn := range map[string]func(*testing.T){
		"updates upstream": TestMainCheckoutPushUpdatesUpstream,
		"other name":       TestMainCheckoutPushToDifferentlyNamedUpstream,
		"no upstream":      TestMainCheckoutPushNoUpstreamSetsOriginBranch,
		"diverged":         TestMainCheckoutPushDivergedIsRejected,
		"refusals":         TestMainCheckoutPushRefusals,
		"auth failed http": TestMainCheckoutPushAuthFailedHTTP,
		"auth failed ssh":  TestMainCheckoutPushAuthFailedSSH,
		"unreachable":      TestMainCheckoutPushUnreachableRemote,
	} {
		t.Run(name, fn)
	}
	pushArgvMu.Lock()
	seen := pushArgv
	pushArgvMu.Unlock()
	pushes := 0
	for _, argv := range seen {
		if len(argv) > 0 && argv[0] == "push" {
			pushes++
		}
		for _, arg := range argv {
			if arg == "-f" || strings.HasPrefix(arg, "--force") || strings.HasPrefix(arg, "+") ||
				(strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && strings.Contains(arg, "f")) {
				t.Errorf("forcing argument %q in %q", arg, argv)
			}
			if strings.Contains(arg, ":+") {
				t.Errorf("forcing refspec %q in %q", arg, argv)
			}
		}
	}
	if pushes < 4 {
		t.Fatalf("only %d push commands recorded (%d in all): the recorder missed them", pushes, len(seen))
	}
}
