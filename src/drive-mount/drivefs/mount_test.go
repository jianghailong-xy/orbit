package drivefs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"

	"orbit/drive-mount/door"
)

// These tests mount the file system for real, over go-fuse, in front of fakeDoor: they need /dev/fuse and root (they
// mount it directly, as the privileged parent would). The e2e (src/apiserver/src/drive/drive-mount.pg.e2e.ts) runs the
// shell-operation list against the real door.

func mountFake(t *testing.T, opts Options) (*fakeDoor, string, *Reporter) {
	t.Helper()
	return mountFakeDoor(t, opts, door.Config{})
}

// mountFakeDoor is mountFake with the door client's deadlines of cfg.
func mountFakeDoor(t *testing.T, opts Options, cfg door.Config) (*fakeDoor, string, *Reporter) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("mounting needs root")
	}
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("no /dev/fuse")
	}
	f := newFakeDoor()
	t.Cleanup(f.srv.Close)
	dir := t.TempDir()
	mnt := filepath.Join(dir, "mnt")
	state := filepath.Join(dir, "state")
	for _, d := range []string{mnt, state} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	rep := NewReporter(ReporterOptions{Dir: state, ShownDir: "/run/orbit-drive"})
	opts.SpoolDir = filepath.Join(dir, "spool")
	opts.Reporter = rep
	cfg.BaseURL, cfg.Token = f.srv.URL, "t"
	fsys, err := New(door.New(cfg), opts)
	if err != nil {
		t.Fatal(err)
	}
	mo := MountOptions(false)
	mo.DirectMount = true
	server, err := fuse.NewServer(fsys, mnt, mo)
	if err != nil {
		t.Skipf("cannot mount: %v", err)
	}
	go server.Serve()
	if err := server.WaitMount(); err != nil {
		t.Fatal(err)
	}
	fsys.Start()
	t.Cleanup(func() {
		_ = server.Unmount()
		fsys.Stop()
	})
	return f, mnt, rep
}

func appendTo(t *testing.T, path, text string) {
	t.Helper()
	fh, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.WriteString(text); err != nil {
		t.Fatal(err)
	}
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOverwritesMakeVersionsAndAppendsDoNot(t *testing.T) {
	f, mnt, _ := mountFake(t, Options{})
	p := filepath.Join(mnt, "a.txt")
	if err := os.WriteFile(p, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if data, versions := f.content("/a.txt"); string(data) != "hi\n" || versions != 1 {
		t.Fatalf("after the create: %q, %d versions (the first close fills the empty first version)", data, versions)
	}
	if err := os.WriteFile(p, []byte("bye\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		appendTo(t, p, "more\n")
	}
	data, versions := f.content("/a.txt")
	if string(data) != "bye\nmore\nmore\nmore\n" || versions != 2 {
		t.Fatalf("%q, %d versions", data, versions)
	}
	// Each append under 64 KiB was merged into the last chunk and sent in its place (§3.2): one chunk still.
	if chunks := f.chunks("/a.txt"); len(chunks) != 1 {
		t.Fatalf("chunks %+v", chunks)
	}
	if got, err := os.ReadFile(p); err != nil || string(got) != string(data) {
		t.Fatalf("read back %q %v", got, err)
	}
}

func TestVimSavesKeepTheCommitMtime(t *testing.T) {
	vim, err := exec.LookPath("vim")
	if err != nil {
		t.Skip("vim is required")
	}
	// Vim's default backupskip matches /tmp/*, so mount outside /tmp for the first save.
	t.Setenv("TMPDIR", "/var/tmp")
	f, mnt, rep := mountFake(t, Options{})
	p := filepath.Join(mnt, "v.txt")
	if err := os.WriteFile(p, []byte("line x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stat := func() unix.Statx_t {
		t.Helper()
		var st unix.Statx_t
		if err := unix.Statx(unix.AT_FDCWD, p, unix.AT_STATX_FORCE_SYNC, unix.STATX_MTIME|unix.STATX_INO, &st); err != nil {
			t.Fatal(err)
		}
		return st
	}
	save := func(commands ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		args := append([]string{"--not-a-term", "-u", "DEFAULTS", "-i", "NONE"}, commands...)
		cmd := exec.CommandContext(ctx, vim, append(args, "-c", "wq", p)...)
		cmd.Env = append(cmd.Environ(), "TMPDIR=/tmp")
		// Vim can fall back to reading from stderr on a prompt. Give it a file so it sees EOF.
		output, err := os.Create(filepath.Join(t.TempDir(), "vim.log"))
		if err != nil {
			t.Fatal(err)
		}
		defer output.Close()
		cmd.Stdout, cmd.Stderr = output, output
		if err := cmd.Run(); err != nil {
			out, _ := os.ReadFile(output.Name())
			t.Fatalf("vim %v: %v\n%s", commands, err, out)
		}
	}
	original := stat()
	save("-c", "s/x/y/")
	first := stat()
	save("-c", "set backupcopy=yes", "-c", "s/y/z/")
	before := stat()
	if first.Ino == original.Ino || before.Ino != first.Ino {
		t.Fatalf("default save should replace the inode and backupcopy=yes should keep it: %d, %d, %d", original.Ino, first.Ino, before.Ino)
	}
	if got, err := os.ReadFile(p); err != nil || string(got) != "line z\n" {
		t.Fatalf("after both saves: %q, %v", got, err)
	}
	f.mu.Lock()
	committed := f.at("/v.txt").mtime
	f.mu.Unlock()
	polledAfter := time.Now()
	for {
		feed := rep.CurrentStatus().ChangeFeedAt
		if feed != nil && feed.After(polledAfter) {
			break
		}
		if time.Since(polledAfter) > 5*time.Second {
			t.Fatal("no change feed poll after the save")
		}
		time.Sleep(10 * time.Millisecond)
	}
	after := stat()
	if before.Mtime != after.Mtime || !time.Unix(before.Mtime.Sec, int64(before.Mtime.Nsec)).Equal(committed) {
		t.Fatalf("mtime before feed: %+v, after feed: %+v, door: %v", before.Mtime, after.Mtime, committed)
	}
}

func TestAnAllZeroChunkIsOneBlob(t *testing.T) {
	f, mnt, _ := mountFake(t, Options{})
	fh, err := os.Create(filepath.Join(mnt, "sparse"))
	if err != nil {
		t.Fatal(err)
	}
	if err := fh.Truncate(5 * ChunkMax); err != nil {
		t.Fatal(err)
	}
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	chunks := f.chunks("/sparse")
	shas := map[string]bool{}
	for _, c := range chunks {
		shas[c.SHA256] = true
	}
	if len(chunks) != 5 || len(shas) != 1 || f.puts != 1 {
		t.Fatalf("%d chunks naming %d blobs, %d sent", len(chunks), len(shas), f.puts)
	}
	// A write past the end of a new file: zeros, then the byte.
	fh, err = os.Create(filepath.Join(mnt, "holes"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.WriteAt([]byte("Z"), 2*ChunkMax+5); err != nil {
		t.Fatal(err)
	}
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	data, _ := f.content("/holes")
	if len(data) != 2*ChunkMax+6 || data[len(data)-1] != 'Z' || bytes.Count(data, []byte{0}) != len(data)-1 {
		t.Fatalf("holes: %d bytes", len(data))
	}
}

func TestAWriteInsideAnExistingFileIsRefused(t *testing.T) {
	f, mnt, rep := mountFake(t, Options{})
	// Go's SIGURG preemption signal can interrupt the caller's FUSE request and cancel its door call.
	// Block it on the syscall caller for this stress test. The FUSE server still runs normally.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var blocked, previous unix.Sigset_t
	blocked.Val[0] = 1 << (unix.SIGURG - 1)
	if err := unix.PthreadSigmask(unix.SIG_BLOCK, &blocked, &previous); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := unix.PthreadSigmask(unix.SIG_SETMASK, &previous, nil); err != nil {
			t.Error(err)
		}
	}()
	p := filepath.Join(mnt, "h.txt")
	if err := os.WriteFile(p, []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("create and write: %v, errors.log: %v", err, rep.Lines())
	}
	fh, err := os.OpenFile(p, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fh.Close() })
	if _, err := fh.WriteAt([]byte("X"), 2); !errors.Is(err, syscall.EOPNOTSUPP) {
		t.Fatalf("a write inside: %v", err)
	}
	if err := fh.Truncate(3); !errors.Is(err, syscall.EOPNOTSUPP) {
		t.Fatalf("ftruncate to 3: %v", err)
	}
	// At exactly the end it is an append.
	if _, err := fh.WriteAt([]byte("end\n"), 6); err != nil {
		t.Fatalf("a write at the end: %v", err)
	}
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	if data, versions := f.content("/h.txt"); string(data) != "hello\nend\n" || versions != 1 {
		t.Fatalf("%q, %d versions", data, versions)
	}
	if !strings.Contains(strings.Join(rep.Lines(), "\n"), "EOPNOTSUPP write /home/orbit/Drive/h.txt at offset 2: the drive does not change a file in place") {
		t.Fatalf("errors.log %v", rep.Lines())
	}
	// ftruncate to 0 is an overwrite to empty: a version.
	if err := os.Truncate(p, 0); err != nil {
		t.Fatalf("truncate to zero: %v, errors.log: %v", err, rep.Lines())
	}
	if data, versions := f.content("/h.txt"); len(data) != 0 || versions != 2 {
		t.Fatalf("%q, %d versions", data, versions)
	}
}

func TestAnOpenFileFollowsItsEntry(t *testing.T) {
	f, mnt, _ := mountFake(t, Options{})
	fh, err := os.Create(filepath.Join(mnt, "a.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fh.WriteString("x\n")
	if err := os.Rename(filepath.Join(mnt, "a.tmp"), filepath.Join(mnt, "a.out")); err != nil {
		t.Fatal(err)
	}
	_, _ = fh.WriteString("y\n")
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	if data, _ := f.content("/a.out"); string(data) != "x\ny\n" {
		t.Fatalf("a.out %q", data)
	}
	fh, err = os.Create(filepath.Join(mnt, "gone"))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fh.WriteString("x\n")
	if err := os.Remove(filepath.Join(mnt, "gone")); err != nil {
		t.Fatal(err)
	}
	_, _ = fh.WriteString("y\n")
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	var trashed *fakeEntry
	for _, e := range f.entries {
		if e.name == "gone" {
			trashed = e
		}
	}
	var got []byte
	for _, c := range f.versions[trashed.version].chunks {
		got = append(got, f.blobs[c.SHA256]...)
	}
	f.mu.Unlock()
	if !trashed.trashed || string(got) != "x\ny\n" {
		t.Fatalf("the unlinked file: trashed %v, %q", trashed.trashed, got)
	}
}

// A rename onto a file (§3.2): the target keeps its entry id and gets the source's content as a version; the source is
// gone, and the name answers the new content at once, through the inode the kernel moved there.
func TestARenameOntoAFileKeepsTheTarget(t *testing.T) {
	f, mnt, _ := mountFake(t, Options{})
	b := filepath.Join(mnt, "b.txt")
	if err := os.WriteFile(b, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	idOf := func(p string) string {
		f.mu.Lock()
		defer f.mu.Unlock()
		if e := f.at(p); e != nil {
			return e.id
		}
		return ""
	}
	before := idOf("/b.txt")
	for i, save := range []string{"new\n", "newer\n"} {
		tmp := filepath.Join(mnt, "new.txt")
		if err := os.WriteFile(tmp, []byte(save), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, b); err != nil {
			t.Fatal(err)
		}
		if got, err := os.ReadFile(b); err != nil || string(got) != save {
			t.Fatalf("save %d: b.txt reads %q, %v", i, got, err)
		}
		if _, err := os.Stat(tmp); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("save %d: new.txt %v", i, err)
		}
		if id := idOf("/b.txt"); id != before {
			t.Fatalf("save %d: b.txt is %s, was %s", i, id, before)
		}
		if data, versions := f.content("/b.txt"); string(data) != save || versions != i+2 {
			t.Fatalf("save %d: %q, %d versions", i, data, versions)
		}
	}
	// A source still open for writing: b.txt gets what it held at the rename, and its close lands in Trash under its name.
	fh, err := os.Create(filepath.Join(mnt, "a.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fh.WriteString("x\n")
	if err := os.Rename(filepath.Join(mnt, "a.tmp"), b); err != nil {
		t.Fatal(err)
	}
	_, _ = fh.WriteString("y\n")
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	if data, _ := f.content("/b.txt"); len(data) != 0 || idOf("/b.txt") != before {
		t.Fatalf("b.txt %q, %s", data, idOf("/b.txt"))
	}
	f.mu.Lock()
	var landed *fakeEntry
	for _, e := range f.entries {
		if e.name == "a.tmp" {
			landed = e
		}
	}
	var got []byte
	if landed != nil {
		for _, c := range f.versions[landed.version].chunks {
			got = append(got, f.blobs[c.SHA256]...)
		}
	}
	f.mu.Unlock()
	if landed == nil || !landed.trashed || string(got) != "x\ny\n" {
		t.Fatalf("a.tmp in Trash: %+v, %q", landed, got)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := os.ReadFile(b)
		if err == nil && len(got) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("b.txt reads %q, %v", got, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestAnAppendIsBuiltAgainAfterAnotherRunners(t *testing.T) {
	f, mnt, _ := mountFake(t, Options{})
	p := filepath.Join(mnt, "log")
	if err := os.WriteFile(p, []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fh, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.WriteString("mine\n"); err != nil {
		t.Fatal(err)
	}
	// Another runner's append lands first: this one's tail moved, and it is built again on top (§3.2).
	f.appendAsAnotherRunner("/log", []byte("theirs\n"))
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	if data, versions := f.content("/log"); string(data) != "base\ntheirs\nmine\n" || versions != 1 {
		t.Fatalf("%q, %d versions", data, versions)
	}
}

func TestChunksGoWhileTheFileIsWritten(t *testing.T) {
	f, mnt, _ := mountFake(t, Options{})
	data := make([]byte, 3*ChunkMax+1234)
	rand.New(rand.NewSource(1)).Read(data)
	fh, err := os.Create(filepath.Join(mnt, "big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	for off := 0; off < len(data); off += 1 << 20 {
		end := off + 1<<20
		if end > len(data) {
			end = len(data)
		}
		if _, err := fh.Write(data[off:end]); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		puts := f.puts
		f.mu.Unlock()
		if puts >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d chunks sent before the close", puts)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := fh.Close(); err != nil {
		t.Fatal(err)
	}
	got, _ := f.content("/big.bin")
	if sha256.Sum256(got) != sha256.Sum256(data) {
		t.Fatal("content differs")
	}
	if back, err := os.ReadFile(filepath.Join(mnt, "big.bin")); err != nil || !bytes.Equal(back, data) {
		t.Fatalf("read back: %v", err)
	}
}

func TestALostCommitAnswerIsAppliedOnce(t *testing.T) {
	f, mnt, _ := mountFake(t, Options{})
	f.mu.Lock()
	f.loseCommitAnswers = 1
	f.mu.Unlock()
	if err := os.WriteFile(filepath.Join(mnt, "once.txt"), []byte("once\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if data, versions := f.content("/once.txt"); string(data) != "once\n" || versions != 1 {
		t.Fatalf("%q, %d versions", data, versions)
	}
	if err := os.WriteFile(filepath.Join(mnt, "app.log"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.loseCommitAnswers = 1
	f.mu.Unlock()
	appendTo(t, filepath.Join(mnt, "app.log"), "line\n")
	if data, _ := f.content("/app.log"); string(data) != "base\nline\n" {
		t.Fatalf("the line once: %q", data)
	}
}

func TestACloseThatCannotReachTheServerKeepsTheBytes(t *testing.T) {
	f, mnt, rep := mountFake(t, Options{CloseWait: 2 * time.Second})
	fh, err := os.Create(filepath.Join(mnt, "w.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.WriteString("kept bytes\n"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.fail = func(r *http.Request) int { return http.StatusBadGateway }
	f.mu.Unlock()
	start := time.Now()
	if err := fh.Close(); !errors.Is(err, syscall.EIO) {
		t.Fatalf("close: %v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("the close waited %s", time.Since(start))
	}
	st := rep.CurrentStatus()
	if st.Connected || st.UnsentFiles != 1 {
		t.Fatalf("status %+v", st)
	}
	files, _ := filepath.Glob(filepath.Join(rep.unsentDir(), "*-w.txt"))
	if len(files) != 1 {
		t.Fatalf("unsent %v", files)
	}
	if data, _ := os.ReadFile(files[0]); string(data) != "kept bytes\n" {
		t.Fatalf("unsent bytes %q", data)
	}
	if !strings.Contains(strings.Join(rep.Lines(), "\n"), "EIO close /home/orbit/Drive/w.txt") {
		t.Fatalf("errors.log %v", rep.Lines())
	}
	// Offline, a write fails at write() itself, so a shell redirection sees it (§5.7).
	fh, err = os.OpenFile(filepath.Join(mnt, "w.txt"), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatalf("an existing file opens offline: %v", err)
	}
	if _, err := fh.WriteString("x"); !errors.Is(err, syscall.EIO) {
		t.Fatalf("write offline: %v", err)
	}
	fh.Close()
}

func TestOneSlowAnswerDoesNotFailTheRestOfAnRmRf(t *testing.T) {
	// The 5 GiB walk, §5.9 row 30 on S3: rm -rf of a big tree, one metadata answer slower than its deadline while
	// nothing else was answered, and every folder after it failed EIO on a server that was up. Here the first stat or
	// listing rm -rf needs answers after 12/9 of its deadline (12 s of 9 s), while the feed's long poll has nothing to say.
	const meta = time.Second
	f, mnt, rep := mountFakeDoor(t, Options{FeedWait: 5 * time.Second}, door.Config{MetaTimeout: meta})
	f.mu.Lock()
	huge := f.add("root", "FOLDER", "huge")
	for i := 0; i < 10; i++ {
		d := f.add(huge.id, "FOLDER", fmt.Sprintf("d%d", i))
		for j := 0; j < 10; j++ {
			f.add(d.id, "FILE", fmt.Sprintf("f%d", j))
		}
	}
	f.mu.Unlock()
	time.Sleep(500 * time.Millisecond) // the feed takes the tree in
	var slowed atomic.Bool
	var after atomic.Int32
	f.mu.Lock()
	f.delay = func(r *http.Request) time.Duration {
		if r.URL.Query().Get("wait") != "" {
			return 4 * time.Second // a long poll with nothing to say
		}
		route := strings.TrimPrefix(r.URL.Path, "/api/runner/drive")
		if r.Method == http.MethodGet && (route == "/stat" || route == "/list") && slowed.CompareAndSwap(false, true) {
			return meta * 12 / 9
		}
		if slowed.Load() {
			after.Add(1)
		}
		return 0
	}
	f.mu.Unlock()
	time.Sleep(200 * time.Millisecond) // the long poll answered before the delay is gone; the next one is held
	if err := os.RemoveAll(filepath.Join(mnt, "huge")); err != nil {
		t.Fatalf("rm -rf: %v; errors.log %v", err, rep.Lines())
	}
	if !slowed.Load() || after.Load() < 100 {
		t.Fatalf("slowed %v, requests after it %d: rm -rf met no slow answer, or sent too little after it", slowed.Load(), after.Load())
	}
	if !rep.CurrentStatus().Connected {
		t.Fatal("a slow answer is not an unreachable server")
	}
	if lines := strings.Join(rep.Lines(), "\n"); strings.Contains(lines, "EIO") {
		t.Fatalf("errors.log %s", lines)
	}
	f.mu.Lock()
	left := 0
	for _, e := range f.entries {
		if e.id != "root" && !e.trashed {
			left++
		}
	}
	f.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d entries left after rm -rf", left)
	}
	if _, err := os.ReadDir(mnt); err != nil {
		t.Fatalf("ls after rm -rf: %v", err)
	}
}

func TestADoorThatRefusesConnectionsIsStillOffline(t *testing.T) {
	// Nothing listens: three failures within 10 s are offline, and what needs the server fails EIO at once (§5.7).
	f, mnt, rep := mountFake(t, Options{})
	f.srv.Close()
	start := time.Now()
	for i := 0; i < 4; i++ {
		if err := os.Mkdir(filepath.Join(mnt, fmt.Sprintf("d%d", i)), 0o755); !errors.Is(err, syscall.EIO) {
			t.Fatalf("mkdir %d with nothing listening: %v", i, err)
		}
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("a refused connection is not waited for: %s", time.Since(start))
	}
	if rep.CurrentStatus().Connected {
		t.Fatal("refused connections: offline")
	}
	if lines := strings.Join(rep.Lines(), "\n"); !strings.Contains(lines, "cannot be reached") {
		t.Fatalf("errors.log %s", lines)
	}
}

func TestALongOpenWriteRidesOutAServerStall(t *testing.T) {
	// The sleep/wake walk: one handle open for minutes, appending 4 MiB every 3 s, while the walk apiserver's database
	// stalled for about 20 s, answering nothing. Every request then passed its deadline unanswered, the mount went
	// offline, and the next write() failed EIO, ending the writer. The bytes only go to the spool: a write in the first
	// CloseWait of an outage waits for the server rather than failing. Deadlines here are 1 s and the stall 3 s; the
	// handle is committed while open (fsync, as the periodic commit does) before and after it.
	const meta = time.Second
	const step = 1 << 20
	f, mnt, rep := mountFakeDoor(t, Options{FeedWait: time.Second},
		door.Config{MetaTimeout: meta, ChunkHeaderTimeout: meta, ProbeInterval: 200 * time.Millisecond})
	fh, err := os.OpenFile(filepath.Join(mnt, "held.bin"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	// Closed before the mount goes, even when the test fails: a process exiting with a handle on its own dead mount
	// never exits.
	t.Cleanup(func() { _ = fh.Close() })
	src := rand.New(rand.NewSource(7))
	sum := sha256.New()
	written := 0
	put := func(what string) {
		t.Helper()
		b := make([]byte, step)
		src.Read(b)
		if _, err := fh.Write(b); err != nil {
			t.Fatalf("%s write at %d MiB: %v; errors.log %v", what, written/step, err, rep.Lines())
		}
		sum.Write(b)
		written += step
	}
	for i := 0; i < 20; i++ {
		put("before the stall")
	}
	if err := fh.Sync(); err != nil {
		t.Fatalf("fsync before the stall: %v", err)
	}
	var until atomic.Int64
	f.mu.Lock()
	f.delay = func(r *http.Request) time.Duration {
		return time.Until(time.Unix(0, until.Load()))
	}
	f.mu.Unlock()
	until.Store(time.Now().Add(3 * time.Second).UnixNano())
	// Writes go on through the stall until the mount is offline: nothing is answered, not even the probe.
	for deadline := time.Now().Add(5 * time.Second); rep.CurrentStatus().Connected; {
		if time.Now().After(deadline) {
			t.Fatal("the stall never put the mount offline")
		}
		put("during the stall")
		time.Sleep(100 * time.Millisecond)
	}
	put("offline")
	for i := 0; i < 10; i++ {
		put("after the stall")
	}
	if err := fh.Sync(); err != nil {
		t.Fatalf("fsync after the stall: %v; errors.log %v", err, rep.Lines())
	}
	for i := 0; i < 10; i++ {
		put("after the commit")
	}
	if err := fh.Close(); err != nil {
		t.Fatalf("close: %v; errors.log %v", err, rep.Lines())
	}
	got, _ := f.content("/held.bin")
	if len(got) != written || sha256.Sum256(got) != [32]byte(sum.Sum(nil)) {
		t.Fatalf("the drive holds %d bytes of %d, or other bytes", len(got), written)
	}
	if lines := strings.Join(rep.Lines(), "\n"); strings.Contains(lines, "EIO") {
		t.Fatalf("errors.log %s", lines)
	}
}

func TestAWriteLongAfterTheServerWentAwayStillFails(t *testing.T) {
	// The wait is for a stall, not an outage: past CloseWait offline, a write fails at once, and errors.log says why.
	f, mnt, rep := mountFakeDoor(t, Options{CloseWait: time.Second}, door.Config{MetaTimeout: time.Second, ProbeInterval: 200 * time.Millisecond})
	fh, err := os.Create(filepath.Join(mnt, "w.txt"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fh.Close() })
	if _, err := fh.WriteString("first\n"); err != nil {
		t.Fatal(err)
	}
	f.srv.Close()
	for deadline := time.Now().Add(5 * time.Second); rep.CurrentStatus().Connected; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("never offline")
		}
		_, _ = os.ReadDir(filepath.Join(mnt, "nowhere"))
	}
	start := time.Now()
	if _, err := fh.WriteString("waited\n"); !errors.Is(err, syscall.EIO) {
		t.Fatalf("write in the outage's first second: %v", err)
	}
	if waited := time.Since(start); waited < 500*time.Millisecond || waited > 3*time.Second {
		t.Fatalf("the first write offline waited %s, not up to CloseWait", waited)
	}
	start = time.Now()
	if _, err := fh.WriteString("at once\n"); !errors.Is(err, syscall.EIO) {
		t.Fatalf("write long after the outage began: %v", err)
	}
	if waited := time.Since(start); waited > 500*time.Millisecond {
		t.Fatalf("a write past CloseWait offline waited %s", waited)
	}
	if lines := strings.Join(rep.Lines(), "\n"); !strings.Contains(lines, "EIO write /home/orbit/Drive/w.txt: the drive's server cannot be reached") {
		t.Fatalf("errors.log %s", lines)
	}
}

func TestRefusalsSayWhy(t *testing.T) {
	_, mnt, rep := mountFake(t, Options{})
	p := filepath.Join(mnt, "a")
	if err := os.WriteFile(p, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(p, filepath.Join(mnt, "b")); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("link: %v", err)
	}
	if err := os.Symlink("a", filepath.Join(mnt, "l")); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("symlink: %v", err)
	}
	if err := syscall.Mkfifo(filepath.Join(mnt, "p"), 0o644); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("mkfifo: %v", err)
	}
	if err := os.Chmod(p, 0o755); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("chmod +x: %v", err)
	}
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatalf("chmod to the mode shown: %v", err)
	}
	// The owner's own bits are free (rsync -a's 0600 and 0700 on its temporary files); group and others' are not.
	for _, mode := range []os.FileMode{0o600, 0o700, 0o444} {
		if err := os.Chmod(p, mode); err != nil {
			t.Fatalf("chmod %o: %v", mode, err)
		}
	}
	for _, mode := range []os.FileMode{0o666, 0o711, 0o755 | os.ModeSetuid} {
		if err := os.Chmod(p, mode); !errors.Is(err, syscall.EPERM) {
			t.Fatalf("chmod %o: %v", mode, err)
		}
	}
	fh, _ := os.Open(p)
	if err := syscall.Flock(int(fh.Fd()), syscall.LOCK_EX); !errors.Is(err, syscall.ENOLCK) {
		t.Fatalf("flock: %v", err)
	}
	fh.Close()
	if err := os.WriteFile(filepath.Join(mnt, strings.Repeat("n", 256)), nil, 0o644); !errors.Is(err, syscall.ENAMETOOLONG) {
		t.Fatalf("a 256-byte name: %v", err)
	}
	if err := os.WriteFile(filepath.Join(mnt, "bad\xff"), nil, 0o644); !errors.Is(err, syscall.EINVAL) {
		t.Fatalf("a name not UTF-8: %v", err)
	}
	log := strings.Join(rep.Lines(), "\n")
	for _, want := range []string{"EPERM link", "EPERM symlink", "EPERM mknod", "EPERM chmod /home/orbit/Drive/a to 0755", "ENOLCK flock", "ENAMETOOLONG", "EINVAL create"} {
		if !strings.Contains(log, want) {
			t.Fatalf("errors.log lacks %q:\n%s", want, log)
		}
	}
	var st syscall.Stat_t
	if err := syscall.Stat(p, &st); err != nil || st.Uid != 10001 || st.Gid != 10001 || st.Mode&0o7777 != 0o644 {
		t.Fatalf("stat %+v %v", st, err)
	}
	entries, _ := os.ReadDir(mnt)
	for _, e := range entries {
		if strings.EqualFold(e.Name(), "trash") {
			t.Fatal("no Trash folder")
		}
	}
}
