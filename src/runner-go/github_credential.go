package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

// Orbit's GitHub credential (docs/github-workspace-design.md §6 step 4, §7). A checkout Orbit cloned from GitHub
// (clone_workdir.go) is marked as that workspace's; when the machine's own credential cannot authenticate one of
// the runner's network git commands there, the runner asks POST /runner/git-credential for the GitHub App's token
// for that one repository and runs the command once more with it.
//
// The token reaches only that command: it travels in the command's environment (orbitGitCredentialEnv) to the
// read-only helper networkGit names, which answers it for that workspace's repository on github.com alone. It is
// never written to .git/config or a remote URL, never put in an engine's environment, and the command runs no hook.

// gitCredentialWorkspaceFlag names, on the helper's command line, the workspace whose credential it may answer.
const gitCredentialWorkspaceFlag = "--workspace"

// gitCredentialOnlyFlag, after --workspace, tells the helper to answer that workspace's credential and nothing else:
// no question falls through to the machine's own helpers (Push as me, push_as_me.go).
const gitCredentialOnlyFlag = "--only"

// orbitGitCredentialEnv carries Orbit's credential, JSON-encoded, from one network git command to its helper.
const orbitGitCredentialEnv = "ORBIT_GIT_CREDENTIAL"

// githubGitHost is the one host Orbit answers git credentials for.
const githubGitHost = "github.com"

// githubGitOrigin is where that host's repositories are cloned from. A variable so a test can stand a local git
// server in for it.
var githubGitOrigin = "https://" + githubGitHost

// githubWorkspaceMarker is the file, in a checkout's git directory, naming the Orbit workspace it was cloned for.
const githubWorkspaceMarker = "orbit-github-workspace"

// orbitGitCredentialTimeout bounds one POST /runner/git-credential.
const orbitGitCredentialTimeout = 30 * time.Second

// orbitGitCredential is Orbit's credential for one workspace's repository, as a helper is handed it.
type orbitGitCredential struct {
	WorkspaceID string `json:"workspaceId"`
	Protocol    string `json:"protocol"`
	Host        string `json:"host"`
	// The repository as githubRepoPath spells it: owner/name, lowercase, without .git.
	Path     string `json:"path"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// RunnerGitCredentialRequest mirrors @orbit/shared RunnerGitCredentialRequest.
type RunnerGitCredentialRequest struct {
	WorkspaceID string `json:"workspaceId"`
	Host        string `json:"host"`
	Path        string `json:"path"`
	// Purpose PUSH_AS_ME asks for the owner's own GitHub token for one landing's target push (push_as_me.go), naming
	// the attempt: an integration job's claim (JobID, ClaimGeneration, LeaseOwner) or a session's Merge (SessionID,
	// MergeOperationID, LeaseOwner). Empty: the App's installation token, as always.
	Purpose          string `json:"purpose,omitempty"`
	JobID            string `json:"jobId,omitempty"`
	ClaimGeneration  string `json:"claimGeneration,omitempty"`
	LeaseOwner       string `json:"leaseOwner,omitempty"`
	SessionID        string `json:"sessionId,omitempty"`
	MergeOperationID string `json:"mergeOperationId,omitempty"`
}

// RunnerGitCredentialAnswer mirrors @orbit/shared RunnerGitCredentialAnswer.
type RunnerGitCredentialAnswer struct {
	Username  string `json:"username"`
	Password  string `json:"password"`
	ExpiresAt string `json:"expiresAt"`
}

// gitCredentialAsker asks the control plane for a workspace's credential.
type gitCredentialAsker func(ctx context.Context, request RunnerGitCredentialRequest) (*RunnerGitCredentialAnswer, error)

// orbitGitCredentialSource is the runner loop's transport (runLoop); nil in any other process, which asks for none.
var orbitGitCredentialSource atomic.Pointer[gitCredentialAsker]

func setOrbitGitCredentialSource(ask gitCredentialAsker) {
	if ask == nil {
		orbitGitCredentialSource.Store(nil)
		return
	}
	orbitGitCredentialSource.Store(&ask)
}

// orbitGitCredentialFor is Orbit's credential for the repository dir belongs to, when it is a checkout Orbit cloned
// from GitHub whose origin is that repository; nil with no error for any other checkout.
func orbitGitCredentialFor(dir string) (*orbitGitCredential, error) {
	workspace := githubWorkspaceOf(dir)
	if workspace == "" {
		return nil, nil
	}
	origin, err := git(dir, "remote", "get-url", "origin")
	if err != nil {
		return nil, nil
	}
	path, ok := githubRepoPath(origin)
	if !ok {
		return nil, nil
	}
	return askOrbitGitCredential(workspace, path)
}

// askOrbitGitCredential asks the control plane for workspace's credential for the GitHub repository path.
func askOrbitGitCredential(workspace, path string) (*orbitGitCredential, error) {
	return askOrbitGitCredentialWith(RunnerGitCredentialRequest{WorkspaceID: workspace, Host: githubGitHost, Path: path})
}

// askOrbitGitCredentialWith is askOrbitGitCredential for a request that may name more than the repository: Push as
// me's, which names the attempt the owner's token is for (askOwnerGitCredential).
func askOrbitGitCredentialWith(request RunnerGitCredentialRequest) (*orbitGitCredential, error) {
	workspace, path := request.WorkspaceID, request.Path
	ask := orbitGitCredentialSource.Load()
	if ask == nil {
		return nil, errors.New("this process cannot ask Orbit for a GitHub credential")
	}
	ctx, cancel := context.WithTimeout(context.Background(), orbitGitCredentialTimeout)
	defer cancel()
	answer, err := (*ask)(ctx, request)
	if err != nil {
		return nil, errors.New(transportRefusalMessage(err))
	}
	if answer == nil || answer.Password == "" {
		return nil, errors.New("Orbit answered without a credential")
	}
	origin, _ := url.Parse(githubGitOrigin)
	return &orbitGitCredential{
		WorkspaceID: workspace, Protocol: origin.Scheme, Host: origin.Host, Path: path,
		Username: answer.Username, Password: answer.Password,
	}, nil
}

// transportRefusalMessage is the control plane's own sentence for a refused call when it gave one, and the error
// otherwise.
func transportRefusalMessage(err error) string {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) {
		var body struct {
			Message any `json:"message"`
		}
		if json.Unmarshal([]byte(httpErr.body), &body) == nil {
			if message, ok := body.Message.(string); ok && message != "" {
				return message
			}
		}
	}
	return err.Error()
}

// githubRepoPath is an https://github.com/<owner>/<name>[.git] URL's repository, owner/name in lowercase, and
// whether raw is one. A URL carrying a user, another host or another scheme is not.
func githubRepoPath(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	origin, originErr := url.Parse(githubGitOrigin)
	if err != nil || originErr != nil || u.Scheme != origin.Scheme || u.User != nil || !strings.EqualFold(u.Host, origin.Host) {
		return "", false
	}
	path := normalizeGithubPath(u.Path)
	if strings.Count(path, "/") != 1 || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return "", false
	}
	return path, true
}

func normalizeGithubPath(path string) string {
	return strings.ToLower(strings.TrimSuffix(strings.Trim(path, "/"), ".git"))
}

var workspaceIDPattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

// githubWorkspaceOf is the workspace the checkout dir belongs to was cloned for, from the marker in its git
// directory (shared by its worktrees); "" for a checkout Orbit did not clone.
func githubWorkspaceOf(dir string) string {
	common, err := git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil || common == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(common, githubWorkspaceMarker))
	if err != nil {
		return ""
	}
	id := strings.TrimSpace(string(raw))
	if !workspaceIDPattern.MatchString(id) {
		return ""
	}
	return id
}

// markGithubWorkspace writes the marker into a clone's git directory.
func markGithubWorkspace(repo, workspace string) error {
	return os.WriteFile(filepath.Join(repo, ".git", githubWorkspaceMarker), []byte(workspace+"\n"), 0o644)
}

// githubWorkspaceInstructions is what a session running in a checkout Orbit cloned from GitHub is told: the
// credential its pushes would need is the runner's, not the shell's (§7). "" for any other checkout.
func githubWorkspaceInstructions(dir string) string {
	if dir == "" || githubWorkspaceOf(dir) == "" {
		return ""
	}
	return githubWorkspaceNote
}

const githubWorkspaceNote = "This checkout's GitHub credential is Orbit's: land your work to push it."

// orbitGitCredentialAnswer is the helper's answer to git's question (key=value lines) from Orbit's credential raw,
// and whether it answers: only for the workspace the helper was named for, over the protocol, and for the host and the
// repository the credential was issued for.
func orbitGitCredentialAnswer(workspace, question, raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	var credential orbitGitCredential
	if json.Unmarshal([]byte(raw), &credential) != nil || credential.Password == "" || credential.WorkspaceID != workspace {
		return "", false
	}
	asked := map[string]string{}
	for _, line := range strings.Split(question, "\n") {
		if key, value, ok := strings.Cut(strings.TrimRight(line, "\r"), "="); ok {
			asked[key] = value
		}
	}
	if credential.Protocol == "" || asked["protocol"] != credential.Protocol || !strings.EqualFold(asked["host"], credential.Host) ||
		normalizeGithubPath(asked["path"]) != credential.Path {
		return "", false
	}
	return "username=" + credential.Username + "\npassword=" + credential.Password + "\n", true
}

// withoutOrbitGitCredential is env without Orbit's credential: what the machine's own helpers, and any process
// that does not need it, are started with.
func withoutOrbitGitCredential(env []string) []string {
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, orbitGitCredentialEnv+"=") {
			kept = append(kept, entry)
		}
	}
	return kept
}
