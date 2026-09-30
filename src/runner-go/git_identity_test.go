package main

import (
	"os"
	"path/filepath"
	"testing"
)

func isolatedGitIdentityConfig(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", path)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	for _, key := range []string{"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

// Exercise the actual git-writing paths: config and environment are the user's identity,
// including on automatic snapshots, and rebase must keep a different original author.
func TestGitWritesUseUserIdentity(t *testing.T) {
	const globalConfig = "[user]\n\tname = Global User\n\temail = global@example.invalid\n\tuseConfigOnly = true\n[commit]\n\tgpgSign = false\n"
	globalPath := isolatedGitIdentityConfig(t, globalConfig)
	bin := t.TempDir()
	writeFakeBin(t, bin, "claude", "exit 1")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	for _, scope := range []string{"repository", "global", "environment"} {
		for _, operation := range []string{"baseline", "commit", "finalize", "checkpoint", "rescue", "merge", "integration merge", "integration rebase"} {
			t.Run(scope+"/"+operation, func(t *testing.T) {
				t.Setenv("ORBIT_HOME", t.TempDir())
				repo := initRepo(t)
				identity := "Test <test@orbit>"
				if scope == "global" {
					mustGit(t, repo, "config", "--unset", "user.name")
					mustGit(t, repo, "config", "--unset", "user.email")
					identity = "Global User <global@example.invalid>"
				} else if scope == "environment" {
					t.Setenv("GIT_AUTHOR_NAME", "Environment User")
					t.Setenv("GIT_AUTHOR_EMAIL", "environment@example.invalid")
					t.Setenv("GIT_COMMITTER_NAME", "Environment User")
					t.Setenv("GIT_COMMITTER_EMAIL", "environment@example.invalid")
					identity = "Environment User <environment@example.invalid>"
				}
				configPath := filepath.Join(repo, ".git", "config")
				configBefore, err := os.ReadFile(configPath)
				if err != nil {
					t.Fatal(err)
				}
				base := mustGit(t, repo, "rev-parse", "HEAD")
				wt := &Worktree{
					Path: filepath.Join(worktreesDir(), "identity"), RepoDir: repo,
					Branch: "orbit/identity", Session: "identity", BaseSha: base,
				}
				mustGit(t, repo, "worktree", "add", "-b", wt.Branch, wt.Path)
				if err := os.WriteFile(filepath.Join(wt.Path, "work.txt"), []byte("the session's work\n"), 0o644); err != nil {
					t.Fatal(err)
				}

				commitDir, ref, author := wt.Path, "HEAD", identity
				switch operation {
				case "baseline":
					if err := initGitRepo(repo); err != nil {
						t.Fatal(err)
					}
					commitDir = repo
				case "commit":
					out := commitWorktree(CommitCommand{SessionID: wt.Session, Branch: wt.Branch})
					if out.Status != "committed" {
						t.Fatalf("commit = %+v", out)
					}
				case "finalize", "checkpoint":
					if _, _, err := finalizeWorktree(wt, operation == "checkpoint"); err != nil {
						t.Fatal(err)
					}
				case "rescue":
					ref, err = rescueWorkingTree(wt.Path, inspectRepoRoot(wt.Path))
					if err != nil || ref == "" {
						t.Fatalf("rescue = %q, %v", ref, err)
					}
				case "merge", "integration merge", "integration rebase":
					mustGit(t, wt.Path, "add", "-A")
					env := append(os.Environ(), "GIT_AUTHOR_NAME=Original Writer", "GIT_AUTHOR_EMAIL=original@example.invalid")
					if _, err := gitEnv(wt.Path, env, "commit", "-m", "original work"); err != nil {
						t.Fatal(err)
					}
					source := mustGit(t, wt.Path, "rev-parse", "HEAD")
					commitFile(t, repo, "other.txt", "main advanced\n", "advance main")
					commitDir, author = repo, "Original Writer <original@example.invalid>"
					switch operation {
					case "merge":
						out := mergeToMain(MergeCommand{WorkDir: repo, SessionID: wt.Session, Branch: wt.Branch, BaseSha: base})
						if out.Status != "merged" {
							t.Fatalf("merge = %+v", out)
						}
						ref = out.MergedSha
					case "integration merge":
						ref, _, err = integrationMerge(repo, source, "merge work")
						author = identity
					case "integration rebase":
						ref, _, err = integrationRebase(wt.Path, "main", base, source)
					}
					if err != nil {
						t.Fatal(err)
					}
					if got := mustGit(t, repo, "rev-parse", wt.Branch); got != source {
						t.Fatalf("source branch moved: %s -> %s", source, got)
					}
				}

				if got := mustGit(t, commitDir, "show", "-s", "--format=%an <%ae>|%cn <%ce>", ref); got != author+"|"+identity {
					t.Fatalf("commit identity = %q, want %q", got, author+"|"+identity)
				}
				configAfter, err := os.ReadFile(configPath)
				if err != nil {
					t.Fatal(err)
				}
				if string(configAfter) != string(configBefore) {
					t.Fatal("the user's repository config changed")
				}
				globalAfter, err := os.ReadFile(globalPath)
				if err != nil || string(globalAfter) != globalConfig {
					t.Fatalf("the user's global config changed: %v", err)
				}
			})
		}
	}
}

func TestInitGitRepoDoesNotInventMissingIdentity(t *testing.T) {
	isolatedGitIdentityConfig(t, "[user]\n\tuseConfigOnly = true\n")
	repo := t.TempDir()
	if err := initGitRepo(repo); err == nil {
		t.Fatal("baseline succeeded without the user's git identity")
	}
	if _, err := git(repo, "rev-parse", "--verify", "HEAD"); err == nil {
		t.Fatal("a baseline was created under a fabricated identity")
	}
	for _, key := range []string{"user.name", "user.email"} {
		if got, _ := git(repo, "config", "--local", "--get", key); got != "" {
			t.Fatalf("Orbit wrote %s = %q", key, got)
		}
	}
}
