package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// reposDirName is the directory this machine clones into, under the user's home. A convention
// rather than a setting: the point of creating a workspace from a repository is that the user
// pastes a URL and never types an absolute path, and a configurable root would put the path back.
const reposDirName = "orbit-repos"

const (
	cloneDone   = "done"
	cloneFailed = "failed"
)

// reposRoot is where a clone of <owner>/<repo> lands: <reposRoot>/<owner>-<repo>. Empty when this
// account has no resolvable home directory, which is reported as "no root" rather than guessed at:
// a machine that cannot say where it clones is simply not offered as a clone target.
func reposRoot() string {
	home := userHome()
	if home == "" {
		return ""
	}
	return filepath.Join(home, reposDirName)
}

// cloneOutcome is what a clone request reports back.
//
// Stderr is git's own output, byte for byte. It is never parsed, summarized or turned into a
// sentence of ours: this runner is the only thing that can see the machine's credentials and
// network, and a translation layer over git's message is the part that eventually lies (a
// "check your SSH key" for what was actually a repository that no longer exists). Message is
// Orbit's own words for the failures git never got to see — an unparseable URL, a repos root
// that cannot be created — plus, when the target directory is occupied, what is in it, which
// git's refusal does not say.
type cloneOutcome struct {
	Status        string // "done" | "failed"
	Path          string
	DefaultBranch string
	// Reused: the directory already held a checkout of this same remote, so nothing was cloned.
	Reused  bool
	Stderr  string
	Message string
}

// cloneRepo clones repoURL into root/<owner>-<repo>, using whatever git credentials this machine
// already has (ssh key, credential helper, gh auth). Orbit stores no token and takes none here.
func cloneRepo(root, repoURL string) cloneOutcome {
	name, err := cloneDirName(repoURL)
	if err != nil {
		return cloneOutcome{Status: cloneFailed, Message: err.Error()}
	}
	if root == "" {
		return cloneOutcome{Status: cloneFailed, Message: "this machine has no repos root to clone into"}
	}
	target := filepath.Join(root, name)

	// Already a checkout of this same remote: report it as reusable instead of cloning a second
	// copy — and never by silently picking a different directory. Whether to share one checkout
	// between workspaces is the user's call (a wedged checkout blocks every merge in it), so the
	// runner only says what is on the disk.
	existing := existingRemote(target)
	if existing != "" && sameRemote(existing, repoURL) {
		return cloneOutcome{
			Status: cloneDone, Path: target, DefaultBranch: defaultBranch(target), Reused: true,
		}
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return cloneOutcome{Status: cloneFailed, Path: target, Message: err.Error()}
	}

	// No --depth. Worktree isolation forks every session from this checkout and merges back into
	// it, and both need the full history; the disk a shallow clone saves buys a class of failure
	// that only shows up later, in a merge.
	cmd := exec.Command("git", "clone", repoURL, target)
	// The machine's own credentials, minus any interactive prompt: with no terminal git would
	// otherwise sit waiting for a username that nobody can type, and this runs on the heartbeat's
	// work group, which shutdown joins. Failing is what we want — the message says so verbatim.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		out := cloneOutcome{Status: cloneFailed, Path: target, Stderr: stderr.String()}
		// git refuses an occupied directory with "already exists and is not an empty directory",
		// which is true but does not say what is in the way. Naming the other remote is the one
		// thing the user needs to decide, and it cannot be seen from the control plane.
		if existing != "" {
			out.Message = fmt.Sprintf("%s is a checkout of %s", target, existing)
		}
		return out
	}
	return cloneOutcome{Status: cloneDone, Path: target, DefaultBranch: defaultBranch(target)}
}

// cloneDirName derives the directory a repo URL lands in: <owner>-<repo>, from the last two path
// segments of any clone URL git accepts (https, ssh, scp-like, file, a plain local path).
func cloneDirName(repoURL string) (string, error) {
	path := strings.TrimSuffix(strings.TrimSpace(repoURL), "/")
	if i := strings.Index(path, "://"); i >= 0 {
		path = path[i+3:]
		if j := strings.Index(path, "/"); j >= 0 {
			path = path[j+1:] // drop host[:port]
		} else {
			path = ""
		}
	} else if i := strings.Index(path, ":"); i >= 0 {
		path = path[i+1:] // scp-like git@host:owner/repo
	}
	var parts []string
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("cannot tell which repository %q names", repoURL)
	}
	name := strings.TrimSuffix(parts[len(parts)-1], ".git")
	if len(parts) > 1 {
		name = parts[len(parts)-2] + "-" + name
	}
	// A name that is a path of its own, or that starts a dotted one, would put the checkout
	// somewhere other than under the repos root.
	if name == "" || strings.HasPrefix(name, ".") || strings.ContainsAny(name, `/\`) {
		return "", fmt.Errorf("cannot tell which repository %q names", repoURL)
	}
	return name, nil
}

// existingRemote returns the origin URL of the checkout at dir, or "" when dir is not the root of
// one. The `.git` test is what keeps a missing directory from answering: `git -C` walks upward, so
// a repos root that itself sits inside a checkout would otherwise report that checkout's remote
// for every path under it.
func existingRemote(dir string) string {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return ""
	}
	url, err := git(dir, "config", "--get", "remote.origin.url")
	if err != nil {
		return ""
	}
	return url
}

// sameRemote reports whether two clone URLs name the same repository. The ssh and https spellings
// of one repo are the same checkout to git, and cloning a second copy of what is already on the
// disk because of a `git@` or a `.git` would be a claim about the machine that isn't true.
func sameRemote(a, b string) bool {
	key := remoteKey(a)
	return key != "" && key == remoteKey(b)
}

func remoteKey(url string) string {
	s := strings.TrimSuffix(strings.TrimSpace(url), "/")
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.Index(s, "@"); i >= 0 {
		s = s[i+1:] // userinfo, or the scp-like user
	}
	s = strings.Replace(s, ":", "/", 1) // scp-like host:owner/repo -> host/owner/repo
	return strings.ToLower(strings.TrimSuffix(s, ".git"))
}

// defaultBranch is the remote's default branch, read from what the clone recorded for it. Local,
// so it costs no second network round trip: origin/HEAD is written by the clone itself and keeps
// the answer even for a checkout that has since moved to another branch. Empty for a repository
// with no commits yet, which has no default branch to report.
func defaultBranch(dir string) string {
	if head, err := git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		return strings.TrimPrefix(head, "origin/")
	}
	head, _ := git(dir, "symbolic-ref", "--short", "HEAD")
	return head
}
