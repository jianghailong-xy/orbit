package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Every git command the runner starts that talks to a remote — a fetch, a push, an ls-remote — runs
// through networkGit, and none of them prompts for a credential or changes a saved one.
//
// THE FAILURE THIS EXISTS FOR (2026-10-29). A user running the runner in a macOS Terminal found the HTTP
// credential they had saved for their company's GitLab gone from the Keychain again and again, and
// `Username for 'http://…':` prompts in that terminal. The runner ran its fetches and pushes as plain
// `git` with the user's own environment and configuration, so each one used the user's own credential
// helper — osxkeychain, shared with their terminal and their IDE. Git asks a helper to `erase` a
// credential the remote answered with a 401, and to `store` one it accepted: every refused fetch deleted
// the user's entry. With none saved, git prompted on the terminal the runner was started from and waited
// there for good, because nothing bounded the command (git()). GIT_TERMINAL_PROMPT=0, which the wiki's
// fetch already set, stopped the prompt but not the erase, nor git running an askpass program.
//
// So a network git command:
//   - never prompts (networkGitEnv);
//   - reads the user's credentials and writes none: `-c credential.helper=` empties the list of helpers
//     configured so far, URL-scoped ones included, and the one helper left is this binary's
//     `git-credential-readonly` (runGitCredentialReadOnly);
//   - is bounded: networkGitTimeout, or the budget its path already had;
//   - says so when what failed was the credential (errGitAuthFailed).

// networkGitTimeout bounds every network git command except the wiki's fetch, which keeps its own budget
// (wikiAnchorFetchTimeout). Generous on purpose: it is there to end a command that would never finish,
// not to hurry a slow transfer.
const networkGitTimeout = 15 * time.Minute

// networkGitWaitDelay is how long a network git command's output may stay open after git exited, or after
// it was told to stop: a process git started can hold it (wikiAnchorGit, whose fetch always had this).
const networkGitWaitDelay = 2 * time.Second

// networkGitEnv is what a network git command runs with on top of the runner's own environment. The read-only
// helper's `git credential fill` runs with it too.
var networkGitEnv = []string{
	// No prompt on the terminal the runner was started from.
	"GIT_TERMINAL_PROMPT=0",
	// No askpass program either. GIT_TERMINAL_PROMPT=0 alone still runs SSH_ASKPASS, core.askPass or
	// GIT_ASKPASS; one set to the empty string turns off all three.
	"GIT_ASKPASS=",
	// Nor Git Credential Manager's own sign-in window.
	"GCM_INTERACTIVE=never",
	// A command run in the background of somebody's checkout takes no lock it can do without.
	"GIT_OPTIONAL_LOCKS=0",
	// git's own words, untranslated: what gitAuthFailure reads.
	"LC_ALL=C",
}

// errGitAuthFailed is what a network git command answers when the remote refused the credential it was
// given, or no credential is saved for the remote. errors.Is tells it from every other failure.
var errGitAuthFailed = errors.New("git authentication failed")

// networkGit is git() for a command that talks to a remote: it answers git's trimmed stdout, and on a
// failure an error whose text carries git's stderr (gitError, and gitStderr reads it) — or, when what
// failed was the credential, one that is errGitAuthFailed and unwraps to no *exec.ExitError, so that
// gitStderr, which every path's report of a failed git command is made of, reads its whole text: what
// happened, then git's own words.
//
// In a checkout Orbit cloned from GitHub (clone_workdir.go), a command the machine's own credential could not
// authenticate is run once more with Orbit's (orbitGitCredentialFor): the GitHub App's token for that one
// repository, handed to this command's helper alone.
func networkGit(dir string, timeout time.Duration, args ...string) (string, error) {
	out, err := networkGitWith(dir, timeout, nil, args)
	if !errors.Is(err, errGitAuthFailed) {
		return out, err
	}
	credential, why := orbitGitCredentialFor(dir)
	if credential == nil {
		if why != nil {
			return out, fmt.Errorf("%w; Orbit's GitHub credential was not available either: %v", err, why)
		}
		return out, err
	}
	return networkGitWith(dir, timeout, credential, args)
}

// networkGitWith is one network git command, with Orbit's credential for its helper to answer when there is one.
func networkGitWith(dir string, timeout time.Duration, credential *orbitGitCredential, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", networkGitArgsWith(dir, credential, args)...)
	cmd.Env = networkGitCommandEnv(credential)
	// Stopped the way git cleans up after — a fetch holds ref locks — and not waited on past WaitDelay.
	cmd.Cancel = func() error { return interruptGit(cmd.Process) }
	cmd.WaitDelay = networkGitWaitDelay
	raw, err := cmd.Output()
	out := strings.TrimSpace(string(raw))
	if errors.Is(err, exec.ErrWaitDelay) {
		// git exited 0, and a process it started still held its output when WaitDelay ran out.
		err = nil
	}
	if err == nil {
		return out, nil
	}
	stderr := gitStderr(err)
	if failure := gitAuthFailure(stderr); failure != nil {
		return out, failure
	}
	if ctx.Err() != nil {
		// Not wrapped: gitStderr would read only what git wrote before it was stopped, which is not why.
		return out, fmt.Errorf("git %s did not finish within %s: %s", args[0], timeout, firstNonEmpty(stderr, err.Error()))
	}
	return out, gitFailure(err)
}

// networkGitArgs is `-C dir`, then the credential helpers a network git command uses, then args. An empty
// credential.helper empties the list of helpers configured so far; the helper after it is this binary,
// named by its absolute path because it need not be on PATH, and through the shell, which is how git runs
// a helper: quoted, and with forward slashes, which the sh of Git for Windows reads as readily as `\`.
func networkGitArgs(dir string, args []string) []string {
	return networkGitArgsWith(dir, nil, args)
}

// networkGitArgsWith is networkGitArgs for a command that carries Orbit's credential: its helper is told which
// workspace's (--workspace), git hands it the repository path so the helper can check it is that repository's, and
// no hook runs, since a hook would inherit the environment the credential travels in.
func networkGitArgsWith(dir string, credential *orbitGitCredential, args []string) []string {
	return networkGitArgsFor(dir, credential, false, args)
}

// networkGitArgsFor is networkGitArgsWith, and with only set the helper is told to answer Orbit's credential and
// nothing else (gitCredentialOnlyFlag): Push as me's target push, which no machine credential may make.
func networkGitArgsFor(dir string, credential *orbitGitCredential, only bool, args []string) []string {
	out := []string{"-C", dir, "-c", "credential.helper="}
	if exe := orbitCLIExecutable(); exe != "" {
		helper := "!" + shellQuote(filepath.ToSlash(exe)) + " " + gitCredentialReadOnlyCommand
		if credential != nil {
			helper += " " + gitCredentialWorkspaceFlag + " " + shellQuote(credential.WorkspaceID)
			if only {
				helper += " " + gitCredentialOnlyFlag
			}
		}
		out = append(out, "-c", "credential.helper="+helper)
	}
	if credential != nil {
		out = append(out, "-c", "credential.useHttpPath=true", "-c", "core.hooksPath="+filepath.ToSlash(os.DevNull))
	}
	return append(out, args...)
}

// networkGitOwnerOnly is one network git command whose only credential is credential: the machine's helpers are
// emptied and Orbit's helper answers nothing else (networkGitArgsFor with only), so a question the credential does
// not match is answered with none and the command fails as an authentication failure (errGitAuthFailed). It answers
// git's stderr whether or not the command succeeded — an accepted push's `remote:` lines are what says GitHub let it
// past the branch's rules (bypassedRulesOf) — and on a failure an error that gitStderr reads that same stderr from.
func networkGitOwnerOnly(dir string, timeout time.Duration, credential *orbitGitCredential, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", networkGitArgsFor(dir, credential, true, args)...)
	cmd.Env = networkGitCommandEnv(credential)
	cmd.Cancel = func() error { return interruptGit(cmd.Process) }
	cmd.WaitDelay = networkGitWaitDelay
	var said strings.Builder
	cmd.Stdout, cmd.Stderr = io.Discard, &said
	err := cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil
	}
	stderr := strings.TrimSpace(said.String())
	if err == nil {
		return stderr, nil
	}
	if failure := gitAuthFailure(stderr); failure != nil {
		return stderr, failure
	}
	if ctx.Err() != nil {
		return stderr, fmt.Errorf("git %s did not finish within %s: %s", args[0], timeout, firstNonEmpty(stderr, err.Error()))
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		// What gitStderr, and so every reader of a failed push, reads.
		exit.Stderr = []byte(stderr)
	}
	return stderr, gitFailure(err)
}

// networkGitCommandEnv is the environment of a network git command: the runner's own, networkGitEnv, and Orbit's
// credential when the command carries one. Never an engine's environment: only this command and the helper it runs
// see it.
func networkGitCommandEnv(credential *orbitGitCredential) []string {
	env := append(withoutOrbitGitCredential(os.Environ()), networkGitEnv...)
	if credential != nil {
		raw, _ := json.Marshal(credential)
		env = append(env, orbitGitCredentialEnv+"="+string(raw))
	}
	return env
}

// gitAuthFailure reads git's stderr for what git says about a credential: that the remote refused the one
// git sent, or that git had none to send and could not ask for one. It answers the error that says so in a
// reader's terms, and nil for every other failure.
func gitAuthFailure(stderr string) error {
	switch {
	case strings.Contains(stderr, "Authentication failed"):
		return fmt.Errorf("%w: the remote refused the saved Git credential; Orbit did not prompt for another one and did not change the saved one: %s",
			errGitAuthFailed, clip(stderr, 1000))
	case strings.Contains(stderr, "could not read Username"), strings.Contains(stderr, "could not read Password"):
		return fmt.Errorf("%w: no Git credential is saved for the remote; Orbit did not prompt for one and saved none: %s",
			errGitAuthFailed, clip(stderr, 1000))
	}
	return nil
}

// gitCredentialReadOnlyCommand is the credential helper networkGit names: this binary again, which git runs
// as `orbit git-credential-readonly get|store|erase` with the credential on stdin. Nobody types it, so no
// help text lists it.
const gitCredentialReadOnlyCommand = "git-credential-readonly"

// runGitCredentialReadOnly answers git's `get` with what the user's own credential helpers answer, and
// does nothing for `store` and `erase`: a credential the remote refused stays saved, and nothing is saved
// on the runner's behalf. The question goes to `git credential fill`, which asks the helpers the user
// configured. It runs without the configuration networkGit put on git's command line — that names this
// helper alone, so the fill would only ask this helper again — and with every prompt off, so a credential
// nobody saved is answered with none rather than asked for.
//
// With --workspace (a command networkGit runs again with Orbit's credential), it answers that credential instead,
// but only for the workspace it names and for the host and repository Orbit issued it for: git asking about any
// other remote is answered by the machine's helpers as before. With --only as well (Push as me's target push,
// networkGitOwnerOnly), any other question is answered with nothing: the machine's helpers are never asked.
func runGitCredentialReadOnly(args []string) int {
	workspace, only := "", false
	if len(args) >= 2 && args[0] == gitCredentialWorkspaceFlag {
		workspace, args = args[1], args[2:]
		if len(args) > 0 && args[0] == gitCredentialOnlyFlag {
			only, args = true, args[1:]
		}
	}
	if len(args) == 0 || args[0] != "get" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		return 0
	}
	question, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 1
	}
	if workspace != "" {
		if answer, ok := orbitGitCredentialAnswer(workspace, string(question), os.Getenv(orbitGitCredentialEnv)); ok {
			_, _ = io.WriteString(os.Stdout, answer)
			return 0
		}
		if only {
			return 0
		}
	}
	fill := exec.Command("git", "credential", "fill")
	fill.Env = append(withoutOrbitGitCredential(withoutGitCommandLineConfig(os.Environ())), networkGitEnv...)
	fill.Stdin, fill.Stdout, fill.Stderr = strings.NewReader(string(question)), os.Stdout, os.Stderr
	if fill.Run() != nil {
		// The fill said why on stderr, which git shows with its own failure.
		return 1
	}
	return 0
}

// withoutGitCommandLineConfig is env without the configuration a git command line hands down to the
// processes it starts: `-c` (GIT_CONFIG_PARAMETERS) and the GIT_CONFIG_COUNT spelling of it.
func withoutGitCommandLineConfig(env []string) []string {
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if name == "GIT_CONFIG_PARAMETERS" || name == "GIT_CONFIG_COUNT" ||
			strings.HasPrefix(name, "GIT_CONFIG_KEY_") || strings.HasPrefix(name, "GIT_CONFIG_VALUE_") {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}
