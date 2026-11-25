package drivefs

import (
	"syscall"
	"testing"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/door"
)

func TestAReopenBeforeReleaseCannotWriteInPlace(t *testing.T) {
	f := newFakeDoor()
	t.Cleanup(f.srv.Close)
	fs, err := New(door.New(door.Config{BaseURL: f.srv.URL, Token: "t"}), Options{SpoolDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fs.Stop)

	var created fuse.CreateOut
	if st := fs.Create(nil, &fuse.CreateIn{
		InHeader: fuse.InHeader{NodeId: rootIno},
		Flags:    syscall.O_CREAT | syscall.O_WRONLY,
		Mode:     0o644,
	}, "file", &created); st != fuse.OK {
		t.Fatalf("create: %v", st)
	}
	file := fuse.InHeader{NodeId: created.NodeId}
	write := func(fh, off uint64, data string) fuse.Status {
		t.Helper()
		_, st := fs.Write(nil, &fuse.WriteIn{InHeader: file, Fh: fh, Offset: off, Size: uint32(len(data))}, []byte(data))
		return st
	}
	flush := func(fh uint64) {
		t.Helper()
		if st := fs.Flush(nil, &fuse.FlushIn{InHeader: file, Fh: fh}); st != fuse.OK {
			t.Fatalf("flush: %v", st)
		}
	}
	defer fs.Release(nil, &fuse.ReleaseIn{InHeader: file, Fh: created.Fh})
	if st := write(created.Fh, 0, "hello"); st != fuse.OK {
		t.Fatalf("first write: %v", st)
	}
	flush(created.Fh)

	// close(2) has its FLUSH reply, but the kernel may deliver RELEASE after the next OPEN.
	var reopened fuse.OpenOut
	if st := fs.Open(nil, &fuse.OpenIn{InHeader: file, Flags: syscall.O_WRONLY}, &reopened); st != fuse.OK {
		t.Fatalf("reopen: %v", st)
	}
	defer fs.Release(nil, &fuse.ReleaseIn{InHeader: file, Fh: reopened.Fh})
	if st := write(reopened.Fh, 2, "X"); st != fuse.Status(syscall.EOPNOTSUPP) {
		t.Fatalf("in-place write on reopened handle: %v", st)
	}
	truncate := fuse.SetAttrIn{}
	truncate.InHeader = file
	truncate.Valid = fuse.FATTR_SIZE | fuse.FATTR_FH
	truncate.Fh, truncate.Size = reopened.Fh, 3
	if st := fs.SetAttr(nil, &truncate, &fuse.AttrOut{}); st != fuse.Status(syscall.EOPNOTSUPP) {
		t.Fatalf("in-place truncate on reopened handle: %v", st)
	}
	if st := write(reopened.Fh, 5, "!"); st != fuse.OK {
		t.Fatalf("write at EOF: %v", st)
	}
	flush(reopened.Fh)
	if data, versions := f.content("/file"); string(data) != "hello!" || versions != 1 {
		t.Fatalf("after append: %q, %d versions", data, versions)
	}
	// A pathname truncate before RELEASE still makes and commits a new version.
	truncate.Valid = fuse.FATTR_SIZE
	truncate.Fh, truncate.Size = 0, 0
	if st := fs.SetAttr(nil, &truncate, &fuse.AttrOut{}); st != fuse.OK {
		t.Fatalf("pathname truncate to zero: %v", st)
	}
	if data, versions := f.content("/file"); len(data) != 0 || versions != 2 {
		t.Fatalf("after pathname truncate: %q, %d versions", data, versions)
	}
}
