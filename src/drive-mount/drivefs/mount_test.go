package drivefs

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/door"
)

// These tests mount the file system for real, over go-fuse, in front of fakeDoor: they need /dev/fuse and root (they
// mount it directly, as the privileged parent would). The e2e (src/apiserver/src/drive/drive-mount.pg.e2e.ts) runs the
// shell-operation list against the real door.

func mountFake(t *testing.T, opts Options) (*fakeDoor, string, *Reporter) {
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
	rep := NewReporter(ReporterOptions{Dir: state, ShownDir: "/run/orbit-files"})
	opts.SpoolDir = filepath.Join(dir, "spool")
	opts.Reporter = rep
	fsys, err := New(door.New(door.Config{BaseURL: f.srv.URL, Token: "t"}), opts)
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
	p := filepath.Join(mnt, "h.txt")
	if err := os.WriteFile(p, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fh, err := os.OpenFile(p, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
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
	if !strings.Contains(strings.Join(rep.Lines(), "\n"), "EOPNOTSUPP write /home/orbit/Files/h.txt at offset 2: the drive does not change a file in place") {
		t.Fatalf("errors.log %v", rep.Lines())
	}
	// ftruncate to 0 is an overwrite to empty: a version.
	if err := os.Truncate(p, 0); err != nil {
		t.Fatal(err)
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
	if !strings.Contains(strings.Join(rep.Lines(), "\n"), "EIO close /home/orbit/Files/w.txt") {
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
	for _, want := range []string{"EPERM link", "EPERM symlink", "EPERM mknod", "EPERM chmod /home/orbit/Files/a to 0755", "ENOLCK flock", "ENAMETOOLONG", "EINVAL create"} {
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
