package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A reply's links when the session's working directory is named inside Orbit's directory. A workspace's workDir can name
// any path, so there only the session's own checkout and uploads count. Each case goes through the real setupWorktree and
// the real flush, to a control plane that records what reaches it. Everything read is a fixture in a temporary home.

const (
	replyOwnSession         = "11111111-2222-4333-8444-000000000001"
	replyOtherSession       = "11111111-2222-4333-8444-000000000002"
	replyOtherSessionPinned = "11111111-2222-4333-8444-000000000004"
)

// replyWorkDirHome is a home holding what Orbit keeps in its directory, each file with its own text.
func replyWorkDirHome(t *testing.T) (home, orbit string) {
	t.Helper()
	home = realPath(t.TempDir())
	orbit = filepath.Join(home, ".orbit")
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", orbit)
	for name, text := range map[string]string{
		"config.json": "the-runner-credential",
		filepath.Join("claude-accounts", "slot", ".credentials.json"): "an-engine-login",
		filepath.Join("session-credentials", replyOtherSession):       "a-session-credential",
		filepath.Join("worktrees", replyOtherSession, "notes.txt"):    "another-sessions-checkout",
		filepath.Join("uploads", replyOtherSession, "notes.txt"):      "another-sessions-uploads",
		filepath.Join("runs", replyOtherSession, "job.txt"):           "another-sessions-scratch",
	} {
		writeTestFile(t, filepath.Join(orbit, name), text)
	}
	return home, orbit
}

// replyThroughTheFlush sends a reply the way a session's flush does, with the roots session.go gives it, and returns what
// the reply became and the bodies that reached the control plane.
func replyThroughTheFlush(t *testing.T, sessionID, execDir, text string) (string, []string) {
	t.Helper()
	var mu sync.Mutex
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(data))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"att-1"}`)
	}))
	defer server.Close()
	events := []RunEvent{{Seq: 1, Type: evAssistant, Payload: map[string]interface{}{"text": text}}}
	attachLocalReplyFiles(context.Background(), NewTransport(server.URL, "token"), sessionID, events,
		[]string{execDir, uploadsDir(sessionID)}, newReplyAttachmentIDs())
	mu.Lock()
	defer mu.Unlock()
	return asString(events[0].Payload["text"]), bodies
}

func assertReplyStaysHome(t *testing.T, sessionID, execDir, text string) {
	t.Helper()
	got, bodies := replyThroughTheFlush(t, sessionID, execDir, text)
	if got != text || len(bodies) != 0 {
		t.Errorf("%q from %s became %q, and the control plane received %q", text, execDir, got, bodies)
	}
}

func assertReplyTravels(t *testing.T, sessionID, execDir, text, want string) {
	t.Helper()
	got, bodies := replyThroughTheFlush(t, sessionID, execDir, text)
	if !strings.Contains(got, "orbit-attachment:att-1") {
		t.Errorf("%q from %s stayed %q", text, execDir, got)
	}
	if len(bodies) != 1 || !strings.Contains(bodies[0], want) {
		t.Errorf("%q from %s sent %q, want %q", text, execDir, bodies, want)
	}
}

func TestAWorkingDirectoryElsewhereInOrbitsDirectoryIsNoRoot(t *testing.T) {
	for _, branch := range []string{"", "orbit/not-a-repository"} {
		for _, c := range []struct{ name, workDir, link string }{
			{"engine logins", "claude-accounts", filepath.Join("slot", ".credentials.json")},
			{"one engine login", filepath.Join("claude-accounts", "slot"), ".credentials.json"},
			{"session credentials", "session-credentials", replyOtherSession},
			{"every checkout", "worktrees", filepath.Join(replyOtherSession, "notes.txt")},
			{"another checkout", filepath.Join("worktrees", replyOtherSession), "notes.txt"},
			{"a directory of another checkout", filepath.Join("worktrees", replyOtherSession, "src"), filepath.Join("..", "notes.txt")},
			{"another checkout by its other id", filepath.Join("worktrees", publicID(replyOtherSession)), "notes.txt"},
			{"every uploads directory", "uploads", filepath.Join(replyOtherSession, "notes.txt")},
			{"another uploads directory", filepath.Join("uploads", replyOtherSession), "notes.txt"},
			{"another session's scratch", filepath.Join("runs", replyOtherSession), "job.txt"},
			{"Orbit's directory", ".", "config.json"},
			{"Orbit's directory, below it", ".", filepath.Join("claude-accounts", "slot", ".credentials.json")},
		} {
			t.Run(branch+"/"+c.name, func(t *testing.T) {
				_, orbit := replyWorkDirHome(t)
				workDir := filepath.Join(orbit, c.workDir)
				if c.name == "another checkout by its other id" {
					writeTestFile(t, filepath.Join(workDir, c.link), "another-sessions-checkout")
				}
				mkdirForTest(t, workDir)
				job := &ClaimedSession{SessionID: replyOwnSession, Branch: branch}
				execDir := setupWorktree(job, workDir)
				if execDir != workDir || job.WT != nil {
					t.Fatalf("fixture: execDir = %q, want the shared %q", execDir, workDir)
				}
				mkdirForTest(t, uploadsDir(replyOwnSession))

				assertReplyStaysHome(t, replyOwnSession, execDir, "see [x]("+c.link+")")
				assertReplyStaysHome(t, replyOwnSession, execDir, "see ![x]("+c.link+")")
				assertReplyStaysHome(t, replyOwnSession, execDir, "see [x]("+filepath.Join(workDir, c.link)+")")
			})
		}
	}
}

// With the directory it is held to named through a link, either spelling of it reaches the same answer.
func TestAWorkingDirectoryElsewhereInOrbitsDirectoryIsNoRootUnderEitherSpelling(t *testing.T) {
	real, link := realPath(t.TempDir()), filepath.Join(realPath(t.TempDir()), "orbit")
	linkForTest(t, real, link)
	t.Setenv("HOME", realPath(t.TempDir()))
	t.Setenv("ORBIT_HOME", link)
	writeTestFile(t, filepath.Join(real, "claude-accounts", "slot", ".credentials.json"), "an-engine-login")
	mkdirForTest(t, uploadsDir(replyOwnSession))
	for _, orbit := range []string{link, real} {
		workDir := filepath.Join(orbit, "claude-accounts")
		execDir := setupWorktree(&ClaimedSession{SessionID: replyOwnSession}, workDir)
		assertReplyStaysHome(t, replyOwnSession, execDir, "see [x]("+filepath.Join("slot", ".credentials.json")+")")
	}
}

// Roots asked for with no uploads directory name no session, and so no checkout counts as its own.
func TestAWorkingDirectoryInACheckoutWithNoSessionNamedIsNoRoot(t *testing.T) {
	_, orbit := replyWorkDirHome(t)
	workDir := filepath.Join(orbit, "worktrees", replyOtherSession)
	assertReplyLeftAlone(t, "see [x](notes.txt)", workDir)
	assertReplyLeftAlone(t, "see [x](notes.txt)", workDir, filepath.Join(orbit, "generated_images"))
}

func replyFixtureRepo(t *testing.T, dir string) string {
	t.Helper()
	mkdirForTest(t, dir)
	gitInit(t, dir)
	writeTestFile(t, filepath.Join(dir, "top.txt"), "at the top of the repository")
	writeTestFile(t, filepath.Join(dir, "sub", "in-sub.txt"), "in a directory of the repository")
	mustGit(t, dir, "add", "-A")
	mustGit(t, dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "fixture")
	return dir
}

func TestRepliesFromTheSessionsOwnDirectoriesStillTravel(t *testing.T) {
	t.Run("its checkout", func(t *testing.T) {
		home, orbit := replyWorkDirHome(t)
		repo := replyFixtureRepo(t, filepath.Join(home, "orbit-repos", "project"))
		job := &ClaimedSession{SessionID: replyOwnSession, Branch: "orbit/own"}
		execDir := setupWorktree(job, repo)
		if job.WT == nil || execDir != filepath.Join(orbit, "worktrees", replyOwnSession) {
			t.Fatalf("fixture: execDir = %q (isolation %q)", execDir, job.IsolationStatus)
		}
		writeTestFile(t, filepath.Join(execDir, "docs", "plan.txt"), "the plan")
		assertReplyTravels(t, replyOwnSession, execDir, "see [plan](docs/plan.txt)", "the plan")
		assertReplyTravels(t, replyOwnSession, execDir, "see [plan]("+filepath.Join(execDir, "docs", "plan.txt")+")", "the plan")
		assertReplyTravels(t, replyOwnSession, execDir, "see [top](top.txt)", "at the top of the repository")
		// What is beside it stays where it is.
		assertReplyStaysHome(t, replyOwnSession, execDir, "see [x]("+filepath.Join("..", replyOtherSession, "notes.txt")+")")
		assertReplyStaysHome(t, replyOwnSession, execDir, "see [x]("+filepath.Join(orbit, "config.json")+")")
	})
	t.Run("a directory of its checkout", func(t *testing.T) {
		home, _ := replyWorkDirHome(t)
		repo := replyFixtureRepo(t, filepath.Join(home, "orbit-repos", "project"))
		job := &ClaimedSession{SessionID: replyOwnSession, Branch: "orbit/own"}
		execDir := setupWorktree(job, filepath.Join(repo, "sub"))
		if job.WT == nil || filepath.Base(execDir) != "sub" {
			t.Fatalf("fixture: execDir = %q (isolation %q)", execDir, job.IsolationStatus)
		}
		assertReplyTravels(t, replyOwnSession, execDir, "see [x](in-sub.txt)", "in a directory of the repository")
		assertReplyTravels(t, replyOwnSession, execDir, "see [x](../top.txt)", "at the top of the repository")
	})
	t.Run("its checkout when the claim spells its id the short way", func(t *testing.T) {
		home, orbit := replyWorkDirHome(t)
		repo := replyFixtureRepo(t, filepath.Join(home, "orbit-repos", "project"))
		spelled := publicID(replyOwnSession)
		job := &ClaimedSession{SessionID: spelled, Branch: "orbit/own"}
		execDir := setupWorktree(job, repo)
		if job.WT == nil || execDir != filepath.Join(orbit, "worktrees", spelled) {
			t.Fatalf("fixture: execDir = %q (isolation %q)", execDir, job.IsolationStatus)
		}
		assertReplyTravels(t, spelled, execDir, "see [top](top.txt)", "at the top of the repository")
	})
	t.Run("its uploads", func(t *testing.T) {
		home, _ := replyWorkDirHome(t)
		repo := replyFixtureRepo(t, filepath.Join(home, "orbit-repos", "project"))
		job := &ClaimedSession{SessionID: replyOwnSession, Branch: "orbit/own"}
		execDir := setupWorktree(job, repo)
		log := writeTestFile(t, filepath.Join(uploadsDir(replyOwnSession), "log.txt"), "the log")
		assertReplyTravels(t, replyOwnSession, execDir, "see [log]("+log+")", "the log")
	})
	t.Run("its uploads as the working directory", func(t *testing.T) {
		replyWorkDirHome(t)
		uploads := uploadsDir(replyOwnSession)
		writeTestFile(t, filepath.Join(uploads, "log.txt"), "the log")
		execDir := setupWorktree(&ClaimedSession{SessionID: replyOwnSession}, uploads)
		assertReplyTravels(t, replyOwnSession, execDir, "see [log](log.txt)", "the log")
	})
	t.Run("a project directory outside Orbit's", func(t *testing.T) {
		home, orbit := replyWorkDirHome(t)
		project := filepath.Join(home, "orbit-repos", "project")
		writeTestFile(t, filepath.Join(project, "notes.txt"), "the owner's notes")
		execDir := setupWorktree(&ClaimedSession{SessionID: replyOwnSession}, project)
		if execDir != project {
			t.Fatalf("fixture: execDir = %q", execDir)
		}
		assertReplyTravels(t, replyOwnSession, execDir, "see [notes](notes.txt)", "the owner's notes")
		assertReplyStaysHome(t, replyOwnSession, execDir, "see [x]("+filepath.Join(orbit, "worktrees", replyOtherSession, "notes.txt")+")")
	})
	// A run taking over the branch of a run before it still works in a checkout named for itself, pinned or not. While the
	// other checkout still holds the branch it runs in the workspace, or not at all, and never in that checkout.
	t.Run("a rerun on the branch of the run before it", func(t *testing.T) {
		const earlier = "11111111-2222-4333-8444-000000000003"
		home, orbit := replyWorkDirHome(t)
		repo := replyFixtureRepo(t, filepath.Join(home, "orbit-repos", "project"))
		first := &ClaimedSession{SessionID: earlier, Branch: "orbit/task"}
		setupWorktree(first, repo)
		if first.WT == nil {
			t.Fatalf("fixture: no checkout (isolation %q)", first.IsolationStatus)
		}
		writeTestFile(t, filepath.Join(first.WT.Path, "work.txt"), "the first run's work")
		mustGit(t, first.WT.Path, "add", "-A")
		mustGit(t, first.WT.Path, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "work")
		pin := strings.TrimSpace(mustGit(t, first.WT.Path, "rev-parse", "HEAD"))

		held := setupWorktree(&ClaimedSession{SessionID: replyOwnSession, Branch: "orbit/task"}, repo)
		if held != repo {
			t.Fatalf("with the branch held by another checkout: execDir = %q, want the workspace", held)
		}
		assertReplyTravels(t, replyOwnSession, held, "see [top](top.txt)", "at the top of the repository")
		assertReplyStaysHome(t, replyOwnSession, held, "see [w]("+filepath.Join(first.WT.Path, "work.txt")+")")
		pinned := &ClaimedSession{SessionID: replyOwnSession, Branch: "orbit/task",
			Source: &SessionSource{State: sourceStatePinned, BaseSha: pin}}
		if dir := setupWorktree(pinned, repo); dir != "" {
			t.Fatalf("pinned, with the branch held by another checkout: execDir = %q, want it refused", dir)
		}

		mustGit(t, repo, "worktree", "remove", "--force", first.WT.Path)
		job := &ClaimedSession{SessionID: replyOwnSession, Branch: "orbit/task"}
		execDir := setupWorktree(job, repo)
		if job.WT == nil || execDir != filepath.Join(orbit, "worktrees", replyOwnSession) {
			t.Fatalf("fixture: execDir = %q (isolation %q)", execDir, job.IsolationStatus)
		}
		assertReplyTravels(t, replyOwnSession, execDir, "see [w](work.txt)", "the first run's work")

		mustGit(t, repo, "worktree", "remove", "--force", job.WT.Path)
		pinned = &ClaimedSession{SessionID: replyOtherSessionPinned, Branch: "orbit/task",
			Source: &SessionSource{State: sourceStatePinned, BaseSha: pin}}
		execDir = setupWorktree(pinned, repo)
		if pinned.WT == nil || execDir != filepath.Join(orbit, "worktrees", replyOtherSessionPinned) {
			t.Fatalf("fixture: execDir = %q (refusal %+v)", execDir, pinned.SourceRefusal)
		}
		assertReplyTravels(t, replyOtherSessionPinned, execDir, "see [w](work.txt)", "the first run's work")
	})
	t.Run("a managed runner's layout", func(t *testing.T) {
		// HOME holds Orbit's directory and the workspace side by side (deploy/managed-runner/README.md).
		home := realPath(t.TempDir())
		t.Setenv("HOME", home)
		t.Setenv("ORBIT_HOME", filepath.Join(home, ".orbit"))
		repo := replyFixtureRepo(t, filepath.Join(home, "orbit-repos", "default"))
		shared := setupWorktree(&ClaimedSession{SessionID: replyOwnSession}, repo)
		assertReplyTravels(t, replyOwnSession, shared, "see [top](top.txt)", "at the top of the repository")
		execDir := setupWorktree(&ClaimedSession{SessionID: replyOtherSession, Branch: "orbit/other"}, repo)
		assertReplyTravels(t, replyOtherSession, execDir, "see [top](top.txt)", "at the top of the repository")
	})
	t.Run("a linked Orbit directory", func(t *testing.T) {
		disk := realPath(t.TempDir())
		home := realPath(t.TempDir())
		t.Setenv("HOME", home)
		linkForTest(t, disk, filepath.Join(home, ".orbit"))
		t.Setenv("ORBIT_HOME", filepath.Join(home, ".orbit"))
		repo := replyFixtureRepo(t, filepath.Join(home, "orbit-repos", "project"))
		execDir := setupWorktree(&ClaimedSession{SessionID: replyOwnSession, Branch: "orbit/own"}, repo)
		assertReplyTravels(t, replyOwnSession, execDir, "see [top](top.txt)", "at the top of the repository")
		assertReplyTravels(t, replyOwnSession, filepath.Join(disk, "worktrees", replyOwnSession), "see [top](top.txt)", "at the top of the repository")
	})
}

// Codex's generated images are a root of the reply too, named by its home. A home named in a session's directory is no
// place for them: the root would stand for the whole of that directory.
func TestACodexHomeInASessionsDirectoryMakesNoRoot(t *testing.T) {
	_, orbit := replyWorkDirHome(t)
	uploads := mkdirForTest(t, uploadsDir(replyOwnSession))
	own := mkdirForTest(t, filepath.Join(orbit, "worktrees", replyOwnSession))
	for _, dir := range []string{"worktrees", "uploads"} {
		codexHome := filepath.Join(orbit, dir, replyOtherSession)
		image := writeTestFile(t, filepath.Join(codexHome, "generated_images", "image.png"), "\x89PNG\r\n\x1a\n theirs")
		generated := codexGeneratedImagesDir([]string{"CODEX_HOME=" + codexHome}, own)
		assertReplyLeftAlone(t, "see [x]("+filepath.Join(codexHome, "notes.txt")+")", own, uploads, generated)
		assertReplyLeftAlone(t, "![x]("+image+")", own, uploads, generated)
		if staged := stageCodexGeneratedImage(image, generated, uploads); staged != "" {
			t.Errorf("staged %s", staged)
		}
	}
	// A home of its own under Orbit's directory stays where its images are.
	codexHome := filepath.Join(orbit, "codex-accounts", "slot")
	image := writeTestFile(t, filepath.Join(codexHome, "generated_images", "image.png"), "\x89PNG\r\n\x1a\n generated")
	generated := codexGeneratedImagesDir([]string{"CODEX_HOME=" + codexHome}, own)
	assertReplySent(t, "![x]("+image+")", "\x89PNG\r\n\x1a\n generated", own, uploads, generated)
}

// Where the filesystem folds case, another spelling of Orbit's directory reaches no further. It skips where the filesystem
// tells case apart.
func TestAWorkingDirectoryInOrbitsDirectoryInAnotherCaseIsNoRoot(t *testing.T) {
	home, orbit := replyWorkDirHome(t)
	folded := filepath.Join(home, ".ORBIT")
	if _, err := os.Stat(filepath.Join(folded, "config.json")); err != nil {
		t.Skip("this filesystem tells case apart")
	}
	mkdirForTest(t, uploadsDir(replyOwnSession))
	for _, c := range []struct{ workDir, link string }{
		{filepath.Join(folded, "claude-accounts"), filepath.Join("slot", ".credentials.json")},
		{filepath.Join(folded, "worktrees", replyOtherSession), "notes.txt"},
		{filepath.Join(orbit, "WORKTREES", replyOtherSession), "notes.txt"},
		{filepath.Join(orbit, "Uploads", replyOtherSession), "notes.txt"},
		{filepath.Join(orbit, "SESSION-CREDENTIALS"), replyOtherSession},
	} {
		assertReplyStaysHome(t, replyOwnSession, c.workDir, "see [x]("+c.link+")")
	}
}
