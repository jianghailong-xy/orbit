//go:build linux

package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// parkedProcess is a leftover of the shape the host actually accumulated: a shell parked in a
// session's checkout with a child of its own that nothing will ever make exit. The child is
// tracked separately because only a process-GROUP kill reaches it — signalling the shell alone
// would leave the child behind as a fresh orphan.
type parkedProcess struct {
	dir      string
	shell    *exec.Cmd
	childPID int
	exited   chan *os.ProcessState
}

// parkProcess starts one such leftover with its cwd in dir. sharesRunnerGroup mirrors the two
// cases teardown has to tell apart: a session's runtime is put in a process group of its own
// (configureSessionProcessTree), while anything the runner itself forked stays in the runner's.
func parkProcess(t *testing.T, dir string, sharesRunnerGroup bool) *parkedProcess {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	cmd := exec.Command("sh", "-c", "sleep 600 & echo $!; wait")
	cmd.Dir = dir
	if !sharesRunnerGroup {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe for %s: %v", dir, err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start parked process in %s: %v", dir, err)
	}
	// Read the child's pid before the reaper goroutine can Wait and close the pipe.
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("read child pid of parked process in %s: %v", dir, err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("parse child pid %q of parked process in %s: %v", line, dir, err)
	}
	p := &parkedProcess{dir: dir, shell: cmd, childPID: childPID, exited: make(chan *os.ProcessState, 1)}
	go func() {
		_ = cmd.Wait()
		p.exited <- cmd.ProcessState
	}()
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = syscall.Kill(cmd.Process.Pid, syscall.SIGKILL)
		_ = syscall.Kill(childPID, syscall.SIGKILL)
	})
	return p
}

// requireGone asserts the whole parked group was terminated, not just its leader.
func (p *parkedProcess) requireGone(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case st := <-p.exited:
		if ws, ok := st.Sys().(syscall.WaitStatus); !ok || !ws.Signaled() {
			t.Fatalf("shell parked in %s exited on its own (%v); teardown should have signalled it", p.dir, st)
		}
	case <-time.After(within):
		t.Fatalf("shell %d parked in %s survived worktree removal", p.shell.Process.Pid, p.dir)
	}
	deadline := time.Now().Add(within)
	for !processGone(p.childPID) {
		if !time.Now().Before(deadline) {
			t.Fatalf("child %d of the shell parked in %s survived worktree removal; a process-group kill should have reached it", p.childPID, p.dir)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func (p *parkedProcess) requireAlive(t *testing.T, what string) {
	t.Helper()
	select {
	case st := <-p.exited:
		t.Errorf("%s: shell parked in %s must survive teardown, but it exited: %v", what, p.dir, st)
	default:
	}
	if processGone(p.childPID) {
		t.Errorf("%s: child %d of the shell parked in %s must survive teardown, but it is gone", what, p.childPID, p.dir)
	}
}

// processGone reports a pid as gone once it can no longer be signalled, or once it is a zombie
// waiting on a reaper: /proc drops a dead process's cwd link, so an unreaped corpse still owns
// its pid but no longer has a working directory anywhere.
func processGone(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return true
	}
	_, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "cwd"))
	return err != nil
}

func newTeardownRepo(t *testing.T, dir string) string {
	t.Helper()
	repo := filepath.Join(dir, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", repo, err)
	}
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "teardown@test.invalid"},
		{"config", "user.name", "teardown"},
		{"commit", "-q", "--allow-empty", "-m", "root"},
	} {
		if out, err := git(repo, args...); err != nil {
			t.Fatalf("git %v in %s: %v (%s)", args, repo, err, out)
		}
	}
	return repo
}

func addTeardownWorktree(t *testing.T, repo, path string) *Worktree {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	session := filepath.Base(path)
	branch := "orbit/" + session
	if out, err := git(repo, "worktree", "add", "-q", "-b", branch, path); err != nil {
		t.Fatalf("git worktree add %s: %v (%s)", path, err, out)
	}
	return &Worktree{Path: path, Branch: branch, RepoDir: repo, Session: session}
}

// removeWorktree runs `git worktree remove --force`, which deletes the checkout out from under
// anything still living in it. Whatever was parked there has to be terminated first, or it
// survives forever with a "(deleted)" cwd — which is how the host ended up holding 20 orphans.
func TestWorktreeTeardownKillsProcessesRootedInTheRemovedWorktree(t *testing.T) {
	base := t.TempDir()
	repo := newTeardownRepo(t, base)
	wt := addTeardownWorktree(t, repo, filepath.Join(base, "worktrees", "wt"))
	// The observed orphans all sat in <worktree>/src/runner-go, not at the checkout root.
	leftover := parkProcess(t, filepath.Join(wt.Path, "src", "runner-go"), false)

	removeWorktree(wt)

	leftover.requireGone(t, 10*time.Second)
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatalf("worktree dir %s should be gone after removeWorktree, stat err = %v", wt.Path, err)
	}
}

// The host is shared: a teardown that reached one step too far would kill a concurrent
// session's engine, or the runner itself. Only "cwd is at or below THIS worktree" may match.
func TestWorktreeTeardownSparesEverythingOutsideTheWorktree(t *testing.T) {
	base := t.TempDir()
	repo := newTeardownRepo(t, base)
	root := filepath.Join(base, "worktrees")
	wt := addTeardownWorktree(t, repo, filepath.Join(root, "wt"))
	other := addTeardownWorktree(t, repo, filepath.Join(root, "other"))

	// Keeps this test from passing by doing nothing at all: teardown must actually fire.
	leftover := parkProcess(t, filepath.Join(wt.Path, "src"), false)
	survivors := map[string]*parkedProcess{
		"another session's worktree":          parkProcess(t, filepath.Join(other.Path, "src"), false),
		"outside every worktree":              parkProcess(t, filepath.Join(base, "elsewhere"), false),
		"a sibling that only shares a prefix": parkProcess(t, filepath.Join(root, "wt-2", "src"), false),
		"the runner's own process group":      parkProcess(t, filepath.Join(wt.Path, "runner"), true),
	}

	removeWorktree(wt)

	leftover.requireGone(t, 10*time.Second)
	// A signal sent by mistake still needs a moment to land before survival can be claimed.
	time.Sleep(300 * time.Millisecond)
	for what, p := range survivors {
		p.requireAlive(t, what)
	}
}

// The orphan sweep is the path that actually deleted the host's worktrees, so it has to tear
// down the same way removeWorktree does.
func TestWorktreeTeardownRunsOnTheOrphanSweep(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	repo := newTeardownRepo(t, home)
	wt := addTeardownWorktree(t, repo, filepath.Join(worktreesDir(), "sess-a"))
	leftover := parkProcess(t, filepath.Join(wt.Path, "src", "runner-go"), false)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/sessions/worktrees-removable" {
			t.Errorf("unexpected gc request path %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WorktreesRemovableResponse{Removable: []string{wt.Session}})
	}))
	defer srv.Close()

	gcWorktrees(NewTransport(srv.URL, "teardown-token"), map[string]bool{})

	leftover.requireGone(t, 10*time.Second)
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatalf("gc should have removed %s, stat err = %v", wt.Path, err)
	}
}

// The sweep can reach a checkout a previous pass already half-removed. Linux then reports the
// leftover's working directory as "<path> (deleted)", which is the same directory under a name
// that no longer resolves — still a target, and still no excuse to widen the match.
func TestWorktreeTeardownMatchesADeletedWorktreeCwd(t *testing.T) {
	base := t.TempDir()
	repo := newTeardownRepo(t, base)
	root := filepath.Join(base, "worktrees")
	wt := addTeardownWorktree(t, repo, filepath.Join(root, "wt"))

	leftover := parkProcess(t, filepath.Join(wt.Path, "src"), false)
	bystander := parkProcess(t, filepath.Join(root, "wt-2", "src"), false)

	// Stand in for the previous pass: the directory is gone, the processes are not.
	if err := os.RemoveAll(wt.Path); err != nil {
		t.Fatalf("remove %s: %v", wt.Path, err)
	}
	cwd, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(leftover.childPID), "cwd"))
	if err != nil || !strings.HasSuffix(cwd, " (deleted)") {
		t.Fatalf("expected pid %d to report a deleted cwd, got %q (err %v)", leftover.childPID, cwd, err)
	}

	removeWorktree(wt)

	leftover.requireGone(t, 10*time.Second)
	// A signal sent by mistake still needs a moment to land before survival can be claimed.
	time.Sleep(300 * time.Millisecond)
	bystander.requireAlive(t, "a sibling that only shares a prefix")
}
