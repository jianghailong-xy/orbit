package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// What counts as a root of a session: the name a session's directory stands at, and not where that leads, and the same
// directories when the home above them is a link. Everything read here is a fixture in a temporary home
// (newFileScopeHost).

func ownWorktree() string {
	return filepath.Join(machineHome(), "worktrees", decodeSessionID(fileTestSession))
}

func mkdirForTest(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func linkForTest(t *testing.T, target, link string) {
	t.Helper()
	mkdirForTest(t, filepath.Dir(link))
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

// replyRead is what a reply's text becomes, and what the uploader was handed.
func replyRead(t *testing.T, text string, roots ...string) (string, string) {
	t.Helper()
	read := ""
	got := rewriteLocalMarkdownImagesWithUploader(context.Background(), text, roots,
		func(ctx context.Context, file *os.File, path, mimeType string) (string, error) {
			data, err := io.ReadAll(file)
			if err != nil {
				t.Fatal(err)
			}
			read = string(data)
			return "att", nil
		})
	return got, read
}

func assertReplyLeftAlone(t *testing.T, text string, roots ...string) {
	t.Helper()
	if got, read := replyRead(t, text, roots...); got != text || read != "" {
		t.Errorf("%q with roots %v became %q, having read %q", text, roots, got, read)
	}
}

func assertReplySent(t *testing.T, text, want string, roots ...string) {
	t.Helper()
	if got, read := replyRead(t, text, roots...); !strings.Contains(got, "orbit-attachment:att") || read != want {
		t.Errorf("%q with roots %v became %q, having read %q", text, roots, got, read)
	}
}

// legacyArtifactStatus asks for a file the way a client that met its path does, from a server that keeps anything.
func legacyArtifactStatus(t *testing.T, path string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":"att-1"}`)
	}))
	defer server.Close()
	return uploadLegacyArtifact(context.Background(), NewTransport(server.URL, "token"), ArtifactCommand{
		RequestID: "r-1", SessionID: fileTestSession, Path: path,
	}).Status
}

func sessionDirectories() map[string]func() string {
	return map[string]func() string{
		"uploads":  func() string { return uploadsDir(fileTestSession) },
		"worktree": ownWorktree,
	}
}

func TestALinkAtASessionsDirectoryIsNoRoot(t *testing.T) {
	for name, directory := range sessionDirectories() {
		t.Run(name, func(t *testing.T) {
			api := newFakeFileServer(t)
			host := newFileScopeHost(t)
			s := api.inHost(t)
			dir := directory()
			linkForTest(t, filepath.Dir(host.key), dir)
			key := filepath.Join(dir, filepath.Base(host.key))

			assertRefused(t, api, s, key, "outside this session's checkout")
			assertRefused(t, api, s, dir, "outside this session's checkout")
			assertReplyLeftAlone(t, "see [key]("+key+")", host.checkout, dir)
			assertReplyLeftAlone(t, "see [key](id_rsa)", dir)
			if status := legacyArtifactStatus(t, key); status != "missing" {
				t.Errorf("a legacy request answered %q", status)
			}
		})
	}
}

// Under Orbit's own directory a link at a session's directory reaches nothing: not a file of the machine's, not a
// directory of it, not another session's.
func TestALinkAtASessionsDirectoryReadsNothingOfOrbits(t *testing.T) {
	for name, directory := range sessionDirectories() {
		t.Run(name, func(t *testing.T) {
			api := newFakeFileServer(t)
			host := newFileScopeHost(t)
			s := api.inHost(t)
			dir := directory()

			linkForTest(t, host.config, dir)
			assertRefused(t, api, s, dir, "Orbit's own directory")
			assertReplyLeftAlone(t, "see [config]("+dir+")", host.checkout, dir)
			if err := os.Remove(dir); err != nil {
				t.Fatal(err)
			}

			private := writeTestFile(t, filepath.Join(host.orbit, "secrets", "key"), "the-runner-credential")
			linkForTest(t, filepath.Dir(private), dir)
			assertRefused(t, api, s, filepath.Join(dir, "key"), "Orbit's own directory")
			assertReplyLeftAlone(t, "see [key]("+filepath.Join(dir, "key")+")", host.checkout, dir)
			if err := os.Remove(dir); err != nil {
				t.Fatal(err)
			}

			other := writeTestFile(t, filepath.Join(host.orbit, "worktrees", "another-session", "a.txt"), "theirs")
			linkForTest(t, filepath.Dir(other), dir)
			assertRefused(t, api, s, filepath.Join(dir, "a.txt"), "Orbit's own directory")
			assertNothingSecretKept(t, api)
		})
	}
}

// Only a directory counts: a file at that name is no root either, so it reads as a path outside the session.
func TestAFileAtASessionsDirectoryIsNoRoot(t *testing.T) {
	api := newFakeFileServer(t)
	newFileScopeHost(t)
	s := api.inHost(t)
	mkdirForTest(t, uploadsRootDir())
	path := writeTestFile(t, uploadsDir(fileTestSession), "not a directory")
	if text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": path}, true); !strings.Contains(text, "Orbit's own directory") {
		t.Errorf("a file at the uploads directory's name: %s", text)
	}
	if len(api.calls) != 0 {
		t.Errorf("sent %v", api.calls)
	}
}

// What a scope judged when it was made is judged again when it opens a file.
func TestASessionDirectoryReplacedAfterItsScopeWasMadeIsRefused(t *testing.T) {
	host := newFileScopeHost(t)
	uploads := uploadsDir(fileTestSession)
	notes := writeTestFile(t, filepath.Join(uploads, "notes.txt"), "mine")
	writeTestFile(t, filepath.Join(host.home, "elsewhere", "notes.txt"), "not this session's")

	scope := newLocalFileScope(artifactRequestRoots(fileTestSession))
	if err := os.Rename(uploads, uploads+"-moved"); err != nil {
		t.Fatal(err)
	}
	linkForTest(t, filepath.Join(host.home, "elsewhere"), uploads)
	if file, _, err := scope.open(notes); err == nil {
		defer file.Close()
		data, _ := io.ReadAll(file)
		t.Errorf("read %q through a replaced directory", data)
	}
}

// A path can be the root itself. What is opened then is that directory, and not what stands at its name by the time it is
// opened: the directory above it holds the other sessions'.
func TestASessionDirectoryReplacedAfterItWasJudgedReadsNothingBesideIt(t *testing.T) {
	newFileScopeHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	writeTestFile(t, filepath.Join(uploadsRootDir(), "another-session", "private.txt"), "theirs")
	before, err := os.Lstat(uploads)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(uploads, uploads+"-moved"); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{filepath.Join("another-session", "private.txt"), "another-session"} {
		linkForTest(t, target, uploads)
		for _, path := range []string{".", "private.txt"} {
			if file, err := openWorktreeArtifactFile(uploads, path, before); err == nil {
				data, _ := io.ReadAll(file)
				file.Close()
				t.Errorf("%s through a link to %s read %q", path, target, data)
			}
		}
		if err := os.Remove(uploads); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAPathThatIsARootIsNoFile(t *testing.T) {
	newFileScopeHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	if file, _, err := newLocalFileScope(artifactRequestRoots(fileTestSession)).open(uploads); err == nil {
		file.Close()
		t.Error("opened a session's directory as a file")
	}
}

// os.Root follows a link that stays inside it, so a link at the last level is caught by what stood at the name. It
// matters most where a root holds Orbit's own directory, in a session running in a home directory.
func TestALinkAtTheLastLevelIsRefusedEvenInsideARoot(t *testing.T) {
	host := newFileScopeHost(t)
	linkForTest(t, filepath.Join(".orbit", "config.json"), filepath.Join(host.home, "alias.txt"))
	before, err := os.Lstat(host.home)
	if err != nil {
		t.Fatal(err)
	}
	if file, err := openWorktreeArtifactFile(host.home, "alias.txt", before); err == nil {
		data, _ := io.ReadAll(file)
		file.Close()
		t.Errorf("read %q through a link at the last level", data)
	}
}

// The same below the root: a directory that has become a link is refused even though the link stays inside the root.
func TestALinkBelowTheRootIsRefusedEvenInsideARoot(t *testing.T) {
	host := newFileScopeHost(t)
	linkForTest(t, ".orbit", filepath.Join(host.home, "notes"))
	before, err := os.Lstat(host.home)
	if err != nil {
		t.Fatal(err)
	}
	if file, err := openWorktreeArtifactFile(host.home, filepath.Join("notes", "config.json"), before); err == nil {
		data, _ := io.ReadAll(file)
		file.Close()
		t.Errorf("read %q through a link below the root", data)
	}
}

// A directory replaced by a named pipe fails at once, at the root and below it: this runs under a session's flush, and
// nothing would ever write to that pipe.
func TestANamedPipeInPlaceOfADirectoryDoesNotHang(t *testing.T) {
	opensAtOnce := func(t *testing.T, root, path string, before os.FileInfo) {
		t.Helper()
		done := make(chan error, 1)
		go func() {
			file, err := openWorktreeArtifactFile(root, path, before)
			if err == nil {
				file.Close()
			}
			done <- err
		}()
		select {
		case err := <-done:
			if err == nil {
				t.Error("opened a file through a named pipe")
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the open hung on a named pipe")
		}
	}
	t.Run("root", func(t *testing.T) {
		newFileScopeHost(t)
		uploads := mkdirForTest(t, uploadsDir(fileTestSession))
		before, err := os.Lstat(uploads)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(uploads, uploads+"-moved"); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(uploads, 0o644); err != nil {
			t.Fatal(err)
		}
		opensAtOnce(t, uploads, "notes.txt", before)
	})
	t.Run("below it", func(t *testing.T) {
		newFileScopeHost(t)
		uploads := mkdirForTest(t, uploadsDir(fileTestSession))
		before, err := os.Lstat(uploads)
		if err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(filepath.Join(uploads, "shots"), 0o644); err != nil {
			t.Fatal(err)
		}
		opensAtOnce(t, uploads, filepath.Join("shots", "notes.txt"), before)
	})
}

func TestRepliesFromASessionRunningAtTheRootDirectoryStillTravel(t *testing.T) {
	host := newFileScopeHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	shot := writeTestFile(t, filepath.Join(host.checkout, "shot.txt"), "a shot")
	root := string(filepath.Separator)

	assertReplySent(t, "see [shot]("+shot+")", "a shot", root, uploads)
	assertReplySent(t, "see [shot]("+strings.TrimPrefix(shot, root)+")", "a shot", root, uploads)
	assertReplyLeftAlone(t, "see [config]("+host.config+")", root, uploads)

	image := "\x89PNG\r\n\x1a\n a picture"
	picture := writeTestFile(t, filepath.Join(host.checkout, "shot.png"), image)
	assertReplySent(t, "![shot]("+picture+")", image, root, uploads)
}

func TestRepliesFromASessionRunningInAHomeDirectoryStillTravel(t *testing.T) {
	host := newFileScopeHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	image := "\x89PNG\r\n\x1a\n a picture"
	picture := writeTestFile(t, filepath.Join(host.home, "shots", "home.png"), image)

	assertReplySent(t, "![home](shots/home.png)", image, host.home, uploads)
	assertReplySent(t, "![home]("+picture+")", image, host.home, uploads)
	assertReplyLeftAlone(t, "see [config](.orbit/config.json)", host.home, uploads)
}

// Only the first root asked for is the working directory. With it gone the next that exists is where relative links
// start and nothing more: it is still held to its name, as a session's own directory is.
func TestAReplyTakesNoLaterRootForTheWorkingDirectory(t *testing.T) {
	host := newFileScopeHost(t)
	workDir := filepath.Join(host.home, "gone")
	uploads := filepath.Join(uploadsRootDir(), "nothing-yet")
	generated := filepath.Join(host.home, ".codex", "generated_images")
	linkForTest(t, filepath.Dir(host.key), generated)

	assertReplyLeftAlone(t, "see [key](id_rsa)", workDir, uploads, generated)
	assertReplyLeftAlone(t, "see [key]("+filepath.Join(generated, "id_rsa")+")", workDir, uploads, generated)

	if err := os.Remove(generated); err != nil {
		t.Fatal(err)
	}
	image := "\x89PNG\r\n\x1a\n generated"
	writeTestFile(t, filepath.Join(generated, "image.png"), image)
	assertReplySent(t, "![generated image](image.png)", image, workDir, uploads, generated)
}

// Orbit's directory is known by what it is, so it is refused under a name no list of spellings would hold. /proc gives one
// on Linux, where nothing folds case: this is what pins the rule wherever the next test skips.
func TestOrbitsDirectoryIsRefusedUnderAnotherName(t *testing.T) {
	host := newFileScopeHost(t)
	neighbour := writeTestFile(t, filepath.Join(host.orbit, "uploads", "another-session", "deep", "a.txt"), "theirs")
	scope := newLocalFileScope(nil, string(filepath.Separator))
	for _, path := range []string{host.orbit, host.config, neighbour} {
		name := "/proc/self/root" + path
		if _, err := os.Stat(name); err != nil {
			t.Skip("this system gives no second name for a path")
		}
		if reason := scope.refuses(name); reason != localFileInOrbitsDirectory {
			t.Errorf("%s: refused for %q", name, reason)
		}
	}
	if reason := scope.refuses("/proc/self/root" + filepath.Dir(host.checkout)); reason != "" {
		t.Errorf("a directory that is not Orbit's: refused for %q", reason)
	}
}

// Where the directory could not be looked at when the scope was made, its name still counts.
func TestOrbitsDirectoryIsRefusedByNameWhenItCouldNotBeLookedAt(t *testing.T) {
	host := newFileScopeHost(t)
	if err := os.Rename(host.orbit, host.orbit+"-moved"); err != nil {
		t.Fatal(err)
	}
	scope := newLocalFileScope(nil, host.home)
	if err := os.Rename(host.orbit+"-moved", host.orbit); err != nil {
		t.Fatal(err)
	}
	if reason := scope.refuses(host.config); reason != localFileInOrbitsDirectory {
		t.Errorf("refused for %q", reason)
	}
}

// Every door, where the filesystem folds case, as a Mac's does by default. It skips where the filesystem tells case
// apart, which is everywhere CI runs: TestOrbitsDirectoryIsRefusedUnderAnotherName pins the rule there.
func TestOrbitsDirectoryInAnotherCaseIsRefusedAtEveryDoor(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	folded := filepath.Join(host.home, ".ORBIT")
	if _, err := os.Stat(filepath.Join(folded, "config.json")); err != nil {
		t.Skip("this filesystem tells case apart")
	}
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	writeTestFile(t, filepath.Join(host.orbit, "uploads", "another-session", "a.txt"), "the-runner-credential")
	writeTestFile(t, filepath.Join(host.orbit, "worktrees", "another-session", "a.txt"), "the-runner-credential")
	root := string(filepath.Separator)

	for _, text := range []string{
		"see [config](.ORBIT/config.json)",
		"see [config](" + filepath.Join(folded, "config.json") + ")",
		"see [neighbour](.ORBIT/uploads/another-session/a.txt)",
		"see [neighbour](.Orbit/worktrees/another-session/a.txt)",
	} {
		assertReplyLeftAlone(t, text, host.home, uploads)
		assertReplyLeftAlone(t, text, root, uploads)
	}
	if status := legacyArtifactStatus(t, filepath.Join(folded, "config.json")); status != "missing" {
		t.Errorf("a legacy request answered %q", status)
	}

	project := mkdirForTest(t, filepath.Join(host.home, "project"))
	chdirForTest(t, project)
	assertRefused(t, api, s, filepath.Join(folded, "config.json"), "Orbit's own directory")
	chdirForTest(t, folded)
	assertRefused(t, api, s, "config.json", "Orbit's own directory")
	assertNothingSecretKept(t, api)

	// A working directory that holds a home is no root in another case either.
	parent := filepath.Dir(host.home)
	shouted := filepath.Join(filepath.Dir(parent), strings.ToUpper(filepath.Base(parent)), filepath.Base(host.home))
	if _, err := os.Stat(shouted); err != nil {
		t.Fatal(err)
	}
	if usableAsARoot(shouted) {
		t.Errorf("%s counts as a root", shouted)
	}
}

// A working directory inside the worktree is covered by the worktree: it is where a reply's relative links start and no
// root of its own, or a directory of the checkout could be swapped for a link that widens the rule.
func TestADirectoryOfAWorktreeIsNoRootOfItsOwn(t *testing.T) {
	host := newFileScopeHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	mkdirForTest(t, ownWorktree())
	workDir := filepath.Join(ownWorktree(), "src")
	linkForTest(t, filepath.Dir(host.key), workDir)
	writeTestFile(t, filepath.Join(filepath.Dir(host.key), "nested", "id_rsa"), "the-ssh-key")

	for _, text := range []string{
		"see [key](id_rsa)",
		"see ![key](id_rsa)",
		"see [key](" + filepath.Join(workDir, "id_rsa") + ")",
		"see [key](" + host.key + ")",
	} {
		assertReplyLeftAlone(t, text, workDir, uploads)
	}
	// Further down, so that what was replaced is a directory above the working one.
	assertReplyLeftAlone(t, "see [key](id_rsa)", filepath.Join(workDir, "nested"), uploads)
}

func TestRepliesFromADirectoryOfAWorktreeStillTravel(t *testing.T) {
	newFileScopeHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	workDir := filepath.Join(ownWorktree(), "src")
	shot := "\x89PNG\r\n\x1a\n shot"
	writeTestFile(t, filepath.Join(workDir, "shots", "home.png"), shot)
	writeTestFile(t, filepath.Join(ownWorktree(), "docs", "plan.txt"), "the plan")
	inUploads := writeTestFile(t, filepath.Join(uploads, "log.txt"), "the log")
	inside := filepath.Join(workDir, "plan-link.txt")
	linkForTest(t, filepath.Join(ownWorktree(), "docs", "plan.txt"), inside)

	assertReplySent(t, "![home](shots/home.png)", shot, workDir, uploads)
	assertReplySent(t, "![home]("+filepath.Join(workDir, "shots", "home.png")+")", shot, workDir, uploads)
	assertReplySent(t, "see [plan](../docs/plan.txt)", "the plan", workDir, uploads)
	assertReplySent(t, "see [plan](plan-link.txt)", "the plan", workDir, uploads)
	assertReplySent(t, "see [log]("+inUploads+")", "the log", workDir, uploads)
}

// A process started in a directory of the checkout that has become a link is where that leads, and may not be told so
// by name: with PWD unset the system answers the far end.
func TestFileUploadFromADirectoryOfTheWorktreeThatIsALink(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	mkdirForTest(t, ownWorktree())
	workDir := filepath.Join(ownWorktree(), "src")
	linkForTest(t, filepath.Dir(host.key), workDir)
	chdirForTest(t, workDir)

	t.Setenv("PWD", "")
	assertRefused(t, api, s, "id_rsa", "outside this session's checkout")
	t.Setenv("PWD", workDir)
	assertRefused(t, api, s, "id_rsa", "outside this session's checkout")
}

// The working directory is a session's checkout only when it has no worktree. Anything at the worktree's name makes it
// one that has, even a link that leads nowhere.
func TestAWorkingDirectoryIsARootOnlyInASessionWithNoWorktree(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	report := writeTestFile(t, filepath.Join(host.checkout, "report.json"), "{}")
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": report}); got.Name != "report.json" {
		t.Fatalf("a file in the working directory of a session with no worktree: %+v", got)
	}

	refused := func() {
		t.Helper()
		before := len(api.calls)
		text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": report}, true)
		if !strings.Contains(text, "outside this session's checkout") || !strings.Contains(text, uploadsDir(fileTestSession)) {
			t.Errorf("the refusal says %s", text)
		}
		if len(api.calls) != before {
			t.Errorf("sent %v", api.calls[before:])
		}
	}
	linkForTest(t, filepath.Join(host.home, "nothing-here"), ownWorktree())
	refused()
	if err := os.Remove(ownWorktree()); err != nil {
		t.Fatal(err)
	}
	mkdirForTest(t, ownWorktree())
	refused()
}

// Outside any worktree the working directory is the owner's project directory, which is theirs to link.
func TestAProjectDirectoryOutsideAnyWorktreeStaysARootEvenAsALink(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	writeTestFile(t, filepath.Join(host.home, "disks", "project", "notes.txt"), "notes")
	link := filepath.Join(host.home, "project")
	linkForTest(t, filepath.Join(host.home, "disks", "project"), link)

	assertReplySent(t, "see [notes](notes.txt)", "notes", link, uploads)
	chdirForTest(t, link)
	t.Setenv("PWD", link)
	if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": "notes.txt"}); got.Name != "notes.txt" {
		t.Errorf("a file in a linked project directory: %+v", got)
	}
}

// Wherever it leads, it never makes Orbit's own directory readable: only a directory named there is a session's own.
func TestAProjectDirectoryLeadingIntoOrbitsDirectoryReadsNothingThere(t *testing.T) {
	api := newFakeFileServer(t)
	host := newFileScopeHost(t)
	s := api.inHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	private := writeTestFile(t, filepath.Join(host.orbit, "secrets", "key"), "the-runner-credential")
	link := filepath.Join(host.home, "project")
	linkForTest(t, filepath.Dir(private), link)

	assertReplyLeftAlone(t, "see [key](key)", link, uploads)
	assertReplyLeftAlone(t, "see [key]("+private+")", link, uploads)
	chdirForTest(t, link)
	t.Setenv("PWD", link)
	assertRefused(t, api, s, "key", "Orbit's own directory")
	assertNothingSecretKept(t, api)
}

// Codex's images are a session's own directory too, wherever its home is: a link at that name is no root, and a home that
// is itself a link is the owner's.
func TestALinkAtCodexsGeneratedImagesIsNoRoot(t *testing.T) {
	for name, codexHome := range map[string]func(fileScopeHost) string{
		"under Orbit's directory": func(host fileScopeHost) string { return filepath.Join(host.orbit, "codex-home") },
		"its own":                 func(host fileScopeHost) string { return filepath.Join(host.home, ".codex") },
	} {
		t.Run(name, func(t *testing.T) {
			host := newFileScopeHost(t)
			uploads := mkdirForTest(t, uploadsDir(fileTestSession))
			generated := filepath.Join(codexHome(host), "generated_images")
			writeTestFile(t, filepath.Join(host.home, "elsewhere", "image.png"), "\x89PNG\r\n\x1a\n not generated")
			linkForTest(t, filepath.Join(host.home, "elsewhere"), generated)
			image := filepath.Join(generated, "image.png")

			assertReplyLeftAlone(t, "![generated image]("+image+")", host.checkout, uploads, generated)
			if staged := stageCodexGeneratedImage(image, generated, uploads); staged != "" {
				t.Errorf("staged %s through a link", staged)
			}
		})
	}
}

func TestCodexGeneratedImagesStillTravelUnderALinkedHome(t *testing.T) {
	host := newFileScopeHost(t)
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	image := "\x89PNG\r\n\x1a\n generated"
	linkForTest(t, filepath.Join(host.home, "disks", "codex"), filepath.Join(host.home, ".codex"))
	generated := filepath.Join(host.home, ".codex", "generated_images")
	saved := writeTestFile(t, filepath.Join(host.home, "disks", "codex", "generated_images", "thread", "image.png"), image)
	named := filepath.Join(generated, "thread", "image.png")

	assertReplySent(t, "![generated image]("+named+")", image, host.checkout, uploads, generated)
	staged := stageCodexGeneratedImage(named, generated, uploads)
	if staged == "" {
		t.Fatalf("%s was not staged", saved)
	}
	if data, _ := os.ReadFile(staged); string(data) != image {
		t.Errorf("staged %q", data)
	}
}

// Links above a session's directories are the runner's own, not the session's: a home can be one, as /tmp is on macOS,
// and so can the directories the sessions live in. Everything that goes by those directories keeps working.
func TestSessionDirectoriesKeepWorkingUnderALinkAboveThem(t *testing.T) {
	base := func(t *testing.T) string { return realPath(t.TempDir()) }
	for name, arrange := range map[string]func(t *testing.T){
		"ORBIT_HOME": func(t *testing.T) {
			link := filepath.Join(base(t), "orbit")
			linkForTest(t, base(t), link)
			t.Setenv("ORBIT_HOME", link)
		},
		"HOME": func(t *testing.T) {
			link := filepath.Join(base(t), "home")
			linkForTest(t, base(t), link)
			t.Setenv("HOME", link)
			t.Setenv("ORBIT_HOME", "")
		},
		"a parent of ORBIT_HOME": func(t *testing.T) {
			link := filepath.Join(base(t), "tmp")
			linkForTest(t, base(t), link)
			t.Setenv("ORBIT_HOME", filepath.Join(link, "h", ".orbit"))
			mkdirForTest(t, machineHome())
		},
		"another disk": func(t *testing.T) {
			t.Setenv("ORBIT_HOME", base(t))
			linkForTest(t, base(t), filepath.Join(machineHome(), "worktrees"))
			linkForTest(t, base(t), filepath.Join(machineHome(), "uploads"))
		},
	} {
		t.Run(name, func(t *testing.T) {
			api := newFakeFileServer(t)
			t.Setenv("HOME", base(t))
			arrange(t)
			s := api.inHost(t)
			mkdirForTest(t, filepath.Join(machineHome(), "uploads"))
			mkdirForTest(t, filepath.Join(machineHome(), "worktrees"))
			config := writeTestFile(t, configPath(), `{"runnerToken":"the-runner-credential"}`)

			uploads := uploadsDir(fileTestSession)
			workDir := filepath.Join(ownWorktree(), "src")
			shot := writeTestFile(t, filepath.Join(uploads, "shot.png"), "\x89PNG\r\n\x1a\n shot")
			report := writeTestFile(t, filepath.Join(workDir, "report.json"), `{"ok":true}`)
			chdirForTest(t, workDir)

			for _, path := range []string{shot, "report.json", report} {
				if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": path}); got.ID == "" {
					t.Errorf("%s: %+v", path, got)
				}
			}
			fetched := fileResult(t, s, "file_fetch", map[string]interface{}{"id": "file1"})
			if got := fileResult(t, s, "file_upload", map[string]interface{}{"path": fetched.Path}); got.SHA256 != fetched.SHA256 {
				t.Errorf("a fetched file sent back: %+v", got)
			}
			assertReplySent(t, "see [report](report.json)", `{"ok":true}`, workDir, uploads)
			assertReplySent(t, "see [report]("+report+")", `{"ok":true}`, workDir, uploads)
			if status := legacyArtifactStatus(t, shot); status != "uploaded" {
				t.Errorf("a legacy request answered %q", status)
			}

			before := len(api.calls)
			text := fileToolText(t, s, "file_upload", map[string]interface{}{"path": config}, true)
			if !strings.Contains(text, "Orbit's own directory") {
				t.Errorf("the machine's credentials: %s", text)
			}
			if len(api.calls) != before {
				t.Errorf("sent %v", api.calls[before:])
			}
			assertReplyLeftAlone(t, "see [config]("+config+")", workDir, uploads)
		})
	}
}

// The runner names these directories through whatever ORBIT_HOME says, and a process may name them by where they really
// are. Both are the same worktree.
func TestADirectoryOfAWorktreeIsNamedThroughEitherSpellingOfOrbitsDirectory(t *testing.T) {
	real, link := realPath(t.TempDir()), filepath.Join(realPath(t.TempDir()), "orbit")
	linkForTest(t, real, link)
	t.Setenv("HOME", realPath(t.TempDir()))
	t.Setenv("ORBIT_HOME", link)
	key := writeTestFile(t, filepath.Join(os.Getenv("HOME"), ".ssh", "id_rsa"), "the-ssh-key")
	uploads := mkdirForTest(t, uploadsDir(fileTestSession))
	writeTestFile(t, filepath.Join(ownWorktree(), "docs", "plan.txt"), "the plan")
	linkForTest(t, filepath.Dir(key), filepath.Join(ownWorktree(), "src"))

	for _, orbit := range []string{link, real} {
		workDir := filepath.Join(orbit, "worktrees", decodeSessionID(fileTestSession), "src")
		assertReplyLeftAlone(t, "see [key](id_rsa)", workDir, uploads)
		assertReplySent(t, "see [plan]("+filepath.Join(orbit, "worktrees", decodeSessionID(fileTestSession), "docs", "plan.txt")+")",
			"the plan", workDir, uploads)
	}
}
