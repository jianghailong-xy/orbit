package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// recordGit puts a `git` on PATH that records every argv this process runs before handing off to
// the real one, so a test can assert what was actually executed rather than what a helper claims
// it would execute. Returns the path of the log and the real git binary.
func recordGit(t *testing.T) (log string, realGit string) {
	t.Helper()
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	log = filepath.Join(dir, "argv.log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + log + "\nexec " + realGit + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log, realGit
}

// gitRuns returns the recorded argv lines matching a subcommand.
func gitRuns(t *testing.T, log, subcommand string) []string {
	t.Helper()
	body, err := os.ReadFile(log)
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		if strings.HasPrefix(line, subcommand+" ") {
			out = append(out, line)
		}
	}
	return out
}

// sourceRepo makes a repository at <tmp>/acme/widget whose default branch is deliberately not
// `main`: the default branch is probed from the remote and reported, never assumed.
func sourceRepo(t *testing.T) string {
	t.Helper()
	repo := filepath.Join(t.TempDir(), "acme", "widget")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, filepath.Dir(repo), "init", "-q", "-b", "trunk", "widget")
	mustGit(t, repo, "config", "user.email", "test@orbit")
	mustGit(t, repo, "config", "user.name", "Test")
	commitFile(t, repo, "a.txt", "one\n", "one")
	commitFile(t, repo, "a.txt", "two\n", "two")
	return repo
}

// A clone lands at <repos root>/<owner>-<repo>, carries the whole history, and reports the
// remote's own default branch back — the three things the workspace is then configured from.
func TestCloneRepoLandsUnderReposRootWithFullHistory(t *testing.T) {
	log, _ := recordGit(t)
	src := sourceRepo(t)
	root := filepath.Join(t.TempDir(), "orbit-repos") // not created yet: the clone makes it

	out := cloneRepo(root, src)

	if out.Status != cloneDone || out.Message != "" || out.Stderr != "" {
		t.Fatalf("clone = %+v, want a clean success", out)
	}
	if want := filepath.Join(root, "acme-widget"); out.Path != want {
		t.Errorf("path = %q, want %q", out.Path, want)
	}
	if out.DefaultBranch != "trunk" {
		t.Errorf("default branch = %q, want the remote's own default %q", out.DefaultBranch, "trunk")
	}
	if out.Reused {
		t.Errorf("a fresh clone reported itself reused: %+v", out)
	}
	// No --depth: worktree isolation forks from this checkout and merges back into it, and both
	// need the full history. Asserted on the argv that actually ran, and on the result on disk.
	clones := gitRuns(t, log, "clone")
	if len(clones) != 1 {
		t.Fatalf("git clone ran %d times, want once: %v", len(clones), clones)
	}
	if strings.Contains(clones[0], "--depth") {
		t.Errorf("clone was shallow: %q", clones[0])
	}
	if n := mustGit(t, out.Path, "rev-list", "--count", "HEAD"); n != "2" {
		t.Errorf("cloned history = %s commits, want 2", n)
	}
	if _, err := os.Stat(filepath.Join(out.Path, ".git", "shallow")); err == nil {
		t.Error("the checkout is shallow")
	}
}

// A failure reports git's stderr byte for byte. Nothing between git and the user's screen parses,
// summarizes or rewrites it: this runner is the only thing that can see the machine's credentials,
// and a translation of "Permission denied (publickey)" into our own words is the layer that
// eventually explains the wrong problem.
func TestCloneRepoReportsGitStderrVerbatim(t *testing.T) {
	_, realGit := recordGit(t)
	// An ssh key the server rejects, which is what a missing credential looks like on a real
	// machine — reproduced here without a network by failing the ssh command itself.
	ssh := filepath.Join(t.TempDir(), "ssh")
	body := "#!/bin/sh\necho \"git@github.invalid: Permission denied (publickey).\" >&2\nexit 255\n"
	if err := os.WriteFile(ssh, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_SSH_COMMAND", ssh)
	root := t.TempDir()
	url := "ssh://git@github.invalid/acme/widget.git"

	// What git itself says, from a plain clone into the very same path. It fails and removes the
	// directory it made, so the run under test starts from the same state.
	control := exec.Command(realGit, "clone", url, filepath.Join(root, "acme-widget"))
	var want strings.Builder
	control.Stderr = &want
	if err := control.Run(); err == nil {
		t.Fatal("the control clone was expected to fail")
	}

	out := cloneRepo(root, url)

	if out.Status != cloneFailed {
		t.Fatalf("status = %q, want %q; %+v", out.Status, cloneFailed, out)
	}
	if out.Stderr != want.String() {
		t.Errorf("reported stderr is not git's own output.\n got: %q\nwant: %q", out.Stderr, want.String())
	}
	// The verbatim requirement is worth pinning against a passing-but-empty report.
	if !strings.Contains(out.Stderr, "Permission denied (publickey).") ||
		!strings.Contains(out.Stderr, "Could not read from remote repository.") {
		t.Errorf("stderr lost git's message: %q", out.Stderr)
	}
	if _, err := os.Stat(filepath.Join(root, "acme-widget")); !os.IsNotExist(err) {
		t.Errorf("a failed clone left something at %s", filepath.Join(root, "acme-widget"))
	}
}

// The target already holds a checkout of the same remote: reusable, and nothing is cloned. The two
// URLs here are the same repository spelled two ways, which is the case that matters — a `file://`
// and a plain path, like the ssh and https spellings of one GitHub repo.
func TestCloneRepoReusesACheckoutOfTheSameRemote(t *testing.T) {
	log, _ := recordGit(t)
	src := sourceRepo(t)
	root := t.TempDir()
	if first := cloneRepo(root, "file://"+src); first.Status != cloneDone {
		t.Fatalf("first clone = %+v", first)
	}
	// The checkout has since moved off the default branch, which must not change the answer.
	mustGit(t, filepath.Join(root, "acme-widget"), "checkout", "-q", "-b", "feature")

	out := cloneRepo(root, src)

	if out.Status != cloneDone || !out.Reused {
		t.Fatalf("clone = %+v, want a reusable checkout", out)
	}
	if want := filepath.Join(root, "acme-widget"); out.Path != want {
		t.Errorf("path = %q, want %q", out.Path, want)
	}
	if out.DefaultBranch != "trunk" {
		t.Errorf("default branch = %q, want the remote's default %q, not the checked-out branch",
			out.DefaultBranch, "trunk")
	}
	if clones := gitRuns(t, log, "clone"); len(clones) != 1 {
		t.Errorf("git clone ran %d times, want only the first: %v", len(clones), clones)
	}
}

// The target is occupied by something else: report it, do not clone next to it under a suffixed
// name. A directory that quietly became `acme-widget-2` is a machine the user can no longer reason
// about — and the failure still carries git's own refusal, verbatim.
func TestCloneRepoRefusesADirectoryHoldingSomethingElse(t *testing.T) {
	t.Run("unrelated content", func(t *testing.T) {
		_, realGit := recordGit(t)
		src := sourceRepo(t)
		root := t.TempDir()
		target := filepath.Join(root, "acme-widget")
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, "notes.txt"), []byte("mine\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		control := exec.Command(realGit, "clone", src, target)
		var want strings.Builder
		control.Stderr = &want
		if err := control.Run(); err == nil {
			t.Fatal("the control clone was expected to fail")
		}

		out := cloneRepo(root, src)

		if out.Status != cloneFailed {
			t.Fatalf("clone = %+v, want a failure", out)
		}
		if out.Stderr != want.String() {
			t.Errorf("reported stderr is not git's own output.\n got: %q\nwant: %q", out.Stderr, want.String())
		}
		if body, _ := os.ReadFile(filepath.Join(target, "notes.txt")); string(body) != "mine\n" {
			t.Errorf("what was in the way was disturbed: %q", body)
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Name() != "acme-widget" {
			t.Errorf("the repos root gained a second directory: %v", entries)
		}
	})

	t.Run("a checkout of a different repository", func(t *testing.T) {
		recordGit(t)
		wanted := sourceRepo(t)
		other := sourceRepo(t)
		root := t.TempDir()
		if first := cloneRepo(root, other); first.Status != cloneDone {
			t.Fatalf("seed clone = %+v", first)
		}
		before := mustGit(t, filepath.Join(root, "acme-widget"), "rev-parse", "HEAD")

		out := cloneRepo(root, wanted)

		if out.Status != cloneFailed || out.Reused {
			t.Fatalf("clone = %+v, want a failure that is not a reuse", out)
		}
		if !strings.Contains(out.Stderr, "already exists") {
			t.Errorf("stderr lost git's refusal: %q", out.Stderr)
		}
		// git's refusal is true but does not say what is in the way, and the control plane cannot
		// see this disk. Naming the other remote is what lets the user decide, and it is added
		// beside git's message, never in place of it.
		if !strings.Contains(out.Message, other) {
			t.Errorf("message = %q, want it to name the checkout that is there (%s)", out.Message, other)
		}
		if after := mustGit(t, filepath.Join(root, "acme-widget"), "rev-parse", "HEAD"); after != before {
			t.Errorf("the existing checkout was rewritten: %s -> %s", before, after)
		}
	})
}

// The directory a URL lands in, for the spellings git accepts. Two segments, so two repos named
// `docs` from different owners do not collide.
func TestCloneDirName(t *testing.T) {
	ok := map[string]string{
		"https://github.com/acme/widget.git":    "acme-widget",
		"https://github.com/acme/widget":        "acme-widget",
		"https://github.com/acme/widget/":       "acme-widget",
		"git@github.com:acme/widget.git":        "acme-widget",
		"ssh://git@github.com/acme/widget.git":  "acme-widget",
		"https://gitlab.com/group/sub/repo.git": "sub-repo",
		"file:///srv/git/acme/widget.git":       "acme-widget",
		"/srv/git/acme/widget":                  "acme-widget",
		"https://git.example.com/widget.git":    "widget",
	}
	for url, want := range ok {
		got, err := cloneDirName(url)
		if err != nil || got != want {
			t.Errorf("cloneDirName(%q) = (%q, %v), want %q", url, got, err, want)
		}
	}
	// A URL that names no repository at all is refused rather than turned into some directory.
	for _, url := range []string{"", "   ", "https://github.com/", "https://example.com/.."} {
		if got, err := cloneDirName(url); err == nil {
			t.Errorf("cloneDirName(%q) = %q, want an error", url, got)
		}
	}
	// The invariant behind that: whatever a URL says, the checkout lands under the repos root.
	// Nothing here is a plausible repository — but a URL is user input, and the failure mode of
	// getting this wrong is a clone written somewhere nobody agreed to.
	for _, url := range []string{
		"https://github.com/acme/..", "https://github.com/../../etc", "https://github.com/acme/.git",
		"git@github.com:../../etc/passwd", "/srv/git/../../../tmp/x",
	} {
		name, err := cloneDirName(url)
		if err != nil {
			continue // refused outright, which is also an answer that cannot escape
		}
		root := "/repos"
		if got := filepath.Join(root, name); !strings.HasPrefix(got, root+"/") || strings.Contains(name, "/") {
			t.Errorf("cloneDirName(%q) = %q, which lands at %q — outside %q", url, name, got, root)
		}
	}
}

func TestSameRemote(t *testing.T) {
	same := [][2]string{
		{"git@github.com:acme/widget.git", "https://github.com/acme/widget"},
		{"ssh://git@github.com/acme/widget.git", "git@github.com:acme/widget"},
		{"https://github.com/acme/widget/", "https://github.com/ACME/Widget.git"},
	}
	for _, pair := range same {
		if !sameRemote(pair[0], pair[1]) {
			t.Errorf("sameRemote(%q, %q) = false, want true", pair[0], pair[1])
		}
	}
	different := [][2]string{
		{"git@github.com:acme/widget.git", "git@github.com:acme/gadget.git"},
		{"git@github.com:acme/widget.git", "git@gitlab.com:acme/widget.git"},
		{"", ""},
	}
	for _, pair := range different {
		if sameRemote(pair[0], pair[1]) {
			t.Errorf("sameRemote(%q, %q) = true, want false", pair[0], pair[1])
		}
	}
}

// The clone root is a convention under the user's home, not a setting: the whole point of creating
// a workspace from a URL is that nobody types a path.
func TestReposRootIsUnderTheUsersHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got, want := reposRoot(), filepath.Join(home, "orbit-repos"); got != want {
		t.Errorf("reposRoot() = %q, want %q", got, want)
	}
}

// The wire contract with the control plane: the root rides every heartbeat, and a runner that has
// none sends no field at all — the control plane's "never told us", which withdraws this machine
// from the clone targets rather than having a path invented for it.
func TestHeartbeatReposRootWireField(t *testing.T) {
	encoded, err := json.Marshal(HeartbeatRequest{Status: "ONLINE", ReposRoot: "/home/u/orbit-repos"})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if got["reposRoot"] != "/home/u/orbit-repos" {
		t.Fatalf("reposRoot = %#v, payload = %s", got["reposRoot"], encoded)
	}
	encoded, err = json.Marshal(HeartbeatRequest{Status: "ONLINE"})
	if err != nil {
		t.Fatal(err)
	}
	bare := map[string]interface{}{}
	if err := json.Unmarshal(encoded, &bare); err != nil {
		t.Fatal(err)
	}
	if _, present := bare["reposRoot"]; present {
		t.Fatalf("a runner with no repos root still sent the field: %s", encoded)
	}
}

// The other direction: the job arrives on the heartbeat response, alongside the other work the
// control plane hands this machine, and carries no token — the clone uses the machine's own
// credentials — and no path, which is this machine's to decide.
func TestHeartbeatResponseCarriesCloneRequests(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{
		"cancelSessionIds": [], "maxConcurrent": 2,
		"cloneRequests": [{"workspaceId":"w-1","repoUrl":"git@github.com:acme/widget.git","requestedAt":"2026-08-24T00:00:00Z"}]
	}`), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.CloneRequests) != 1 {
		t.Fatalf("clone requests = %+v, want one", resp.CloneRequests)
	}
	if got := resp.CloneRequests[0]; got.WorkspaceID != "w-1" || got.RepoURL != "git@github.com:acme/widget.git" {
		t.Fatalf("clone request = %+v", got)
	}
	// An older control plane sends nothing, which must decode as no work rather than as a job.
	resp = HeartbeatResponse{}
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"maxConcurrent":2}`), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.CloneRequests) != 0 {
		t.Fatalf("clone requests = %+v, want none", resp.CloneRequests)
	}
}

func TestCloneResultWireFields(t *testing.T) {
	encoded, err := json.Marshal(CloneResultRequest{
		WorkspaceID: "w-1", Status: cloneDone, Path: "/home/u/orbit-repos/acme-widget",
		DefaultBranch: "trunk", Reused: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	for field, want := range map[string]interface{}{
		"workspaceId": "w-1", "status": "done",
		"path": "/home/u/orbit-repos/acme-widget", "defaultBranch": "trunk", "reused": true,
	} {
		if got[field] != want {
			t.Errorf("%s = %#v, want %#v; payload = %s", field, got[field], want, encoded)
		}
	}
	// A failure carries git's own bytes, newlines and all, in a field of their own.
	stderr := "Cloning into '/home/u/orbit-repos/acme-widget'...\nfatal: Could not read from remote repository.\n"
	encoded, err = json.Marshal(CloneResultRequest{WorkspaceID: "w-1", Status: cloneFailed, Stderr: stderr})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if got["stderr"] != stderr {
		t.Fatalf("stderr = %#v, want it verbatim", got["stderr"])
	}
}

// The result travels on the runner's own authenticated channel, to the one route the control
// plane serves for it. Pinned here because the two halves ship separately: a runner that POSTs
// somewhere else reports nothing at all, and the workspace waits on a clone that already landed.
func TestCloneResultPostsToTheControlPlane(t *testing.T) {
	var gotPath, gotAuth string
	var body CloneResultRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("authorization")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	err := NewTransport(server.URL, "runner-token").cloneResult(CloneResultRequest{
		WorkspaceID: "w-1", Status: cloneDone,
		Path: "/home/u/orbit-repos/acme-widget", DefaultBranch: "trunk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/runner/clone-result" {
		t.Errorf("posted to %q", gotPath)
	}
	if gotAuth != "Bearer runner-token" {
		t.Errorf("authorization = %q", gotAuth)
	}
	if body.WorkspaceID != "w-1" || body.Path != "/home/u/orbit-repos/acme-widget" || body.DefaultBranch != "trunk" {
		t.Errorf("body = %+v", body)
	}
}
