package drivefs

import (
	"context"
	"fmt"
	"sort"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/door"
)

// handle is one open file or folder.
type handle struct {
	node    *node
	dir     *dirHandle
	write   bool
	append  bool
	wf      *wfile
	rewrite bool // created or truncated to zero by this handle; guarded by wf.wmu
}

func (fs *FS) handle(fh uint64) *handle {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.handles[fh]
}

func (fs *FS) addHandle(h *handle) uint64 {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fh := fs.nextFh
	fs.nextFh++
	fs.handles[fh] = h
	h.node.handles++
	return fh
}

// writer is who a write comes from (§5.8): the session the caller's process belongs to, when the privileged parent
// could tell, and for a delete the burst it belongs to (one per process, else the door's per-mount window).
func (fs *FS) writer(pid uint32, op string) *door.Writer {
	session, burst := fs.opts.Attributor.Session(pid)
	if session == "" && (op != "delete" || burst == "") {
		return nil
	}
	w := &door.Writer{SessionID: session}
	if op == "delete" {
		w.BurstKey = burst
	}
	return w
}

// ── content ──────────────────────────────────────────────────────────────────────────────────────

// manifest is n's current chunk list: from what the daemon knows when it is for n's seq, else from the door. A file
// of one chunk whose listing named it needs no call at all.
func (fs *FS) manifest(ctx context.Context, n *node, fetch bool) (door.Manifest, error) {
	fs.mu.Lock()
	switch {
	case n.manifest != nil && n.manifest.Seq == n.seq && !n.stale:
		m := *n.manifest
		fs.mu.Unlock()
		return m, nil
	case !n.stale && n.size == 0 && n.version != "":
		m := door.Manifest{EntryID: n.id, VersionID: n.version, SizeBytes: 0, Seq: n.seq}
		fs.mu.Unlock()
		return m, nil
	case !n.stale && n.sha != "" && n.version != "":
		m := door.Manifest{EntryID: n.id, VersionID: n.version, SizeBytes: n.size, Seq: n.seq,
			Chunks: []door.Chunk{{Idx: 0, Offset: 0, Size: n.size, SHA256: n.sha}}}
		fs.mu.Unlock()
		return m, nil
	}
	id := n.id
	fs.mu.Unlock()
	if !fetch {
		return door.Manifest{}, fail(fuse.EIO, "no chunk list")
	}
	m, err := fs.door.Manifest(ctx, id)
	if err != nil {
		return door.Manifest{}, err
	}
	fs.mu.Lock()
	if m.Seq >= n.seq {
		n.seq, n.size, n.version = m.Seq, m.SizeBytes, m.VersionID
		mm := m
		n.manifest = &mm
		n.stale = false
		n.fetched = time.Now()
	}
	fs.mu.Unlock()
	return m, nil
}

// readChunks fills buf with the file's bytes from off, by its chunk list: from the chunk cache, or once from the store.
func (fs *FS) readChunks(ctx context.Context, chunks []door.Chunk, off int64, buf []byte) error {
	end := off + int64(len(buf))
	i := sort.Search(len(chunks), func(i int) bool { return chunks[i].Offset+chunks[i].Size > off })
	for ; i < len(chunks) && chunks[i].Offset < end; i++ {
		c := chunks[i]
		lo, hi := maxI(off, c.Offset), minI(end, c.Offset+c.Size)
		if lo >= hi {
			continue
		}
		if err := fs.cache.readAt(ctx, c.SHA256, c.Size, buf[lo-off:hi-off], lo-c.Offset); err != nil {
			return err
		}
	}
	return nil
}

// ── open, create ─────────────────────────────────────────────────────────────────────────────────

func (fs *FS) Open(cancel <-chan struct{}, input *fuse.OpenIn, out *fuse.OpenOut) fuse.Status {
	n := fs.node(input.NodeId)
	if n == nil {
		return fuse.ENOENT
	}
	if n.dir {
		return fuse.Status(syscall.EISDIR)
	}
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	st := fs.open(ctx, n, input.Flags, input.Caller.Pid, "", out)
	return st
}

// open opens n with flags; handleID is the creating handle's for a file just made.
func (fs *FS) open(ctx context.Context, n *node, flags uint32, pid uint32, handleID string, out *fuse.OpenOut) fuse.Status {
	acc := flags & syscall.O_ACCMODE
	if acc == syscall.O_RDONLY {
		fs.mu.Lock()
		writing := n.wf != nil
		fs.mu.Unlock()
		if !writing {
			// The chunk list is had now, so a file unlinked while open still reads, and an uncached one offline fails
			// here at once (§5.7).
			if _, err := fs.manifest(ctx, n, !fs.door.Health().Offline()); err != nil {
				drivePath := fs.pathForLog(n.ino, "")
				if err == door.ErrOffline || (fs.door.Health().Offline() && errno(err) == fuse.EIO) {
					return fs.offline("open", drivePath)
				}
				return fs.failed("open", drivePath, err)
			}
		}
		// Not direct I/O, so a read-only mmap works (§5.6); a reader beside a writer on this mount still reads what
		// is being written, as the kernel drops the cached pages a direct write covers.
		out.Fh = fs.addHandle(&handle{node: n})
		return fuse.OK
	}
	if fs.door.Fenced() != nil {
		return fuse.EIO
	}
	// Offline, an existing file still opens for writing: the open needs nothing of the server, and write() is what
	// fails, so that a caller ignoring close() still sees it (§5.7). An append learns its base at its first write.
	mode := modeExisting
	switch {
	case handleID != "":
		mode = modeNew
	case flags&syscall.O_TRUNC != 0:
		mode = modeTrunc
	}
	wf, err := fs.writeState(ctx, n, mode, handleID)
	if err != nil {
		return fs.failed("open", fs.pathForLog(n.ino, ""), err)
	}
	if mode == modeNew || mode == modeTrunc {
		// Bytes are coming: the staging they go into is opened meanwhile.
		wf.openStagingSoon()
	}
	session, _ := fs.opts.Attributor.Session(pid)
	if session != "" {
		wf.mu.Lock()
		wf.session = session
		wf.mu.Unlock()
	}
	fh := fs.addHandle(&handle{
		node: n, write: true, append: flags&syscall.O_APPEND != 0, wf: wf,
		rewrite: mode == modeNew || mode == modeTrunc,
	})
	out.Fh = fh
	// A handle open for writing is direct I/O: every close maps to one FLUSH that commits, and a shared mmap of it is
	// refused by the kernel with ENODEV (§5.6).
	out.OpenFlags |= fuse.FOPEN_DIRECT_IO
	return fuse.OK
}

func (fs *FS) Create(cancel <-chan struct{}, input *fuse.CreateIn, name string, out *fuse.CreateOut) fuse.Status {
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	parent, dir, st := fs.parentPath(ctx, input.NodeId)
	if st != fuse.OK {
		return st
	}
	drivePath := joinPath(dir, name)
	if st := checkName(name); st != fuse.OK {
		return fs.badName(st, "create", dir, name)
	}
	if fs.door.Fenced() != nil {
		return fuse.EIO
	}
	if fs.door.Health().Offline() {
		// It must make the entry on the server first (§5.7).
		return fs.offline("create", drivePath)
	}
	handleID := newUUID()
	e, err := fs.door.Create(ctx, drivePath, handleID, fs.writer(input.Caller.Pid, ""))
	if err != nil {
		if door.CodeOf(err) != door.CodeNameTaken {
			return fs.failed("create", drivePath, err)
		}
		// The kernel thought the name free (a negative entry another mount has since filled): open what is there.
		if input.Flags&syscall.O_EXCL != 0 {
			return fuse.Status(syscall.EEXIST)
		}
		n, err := fs.child(ctx, parent, name)
		if err != nil {
			return fs.failed("create", drivePath, err)
		}
		if n.dir {
			return fuse.Status(syscall.EISDIR)
		}
		if st := fs.open(ctx, n, input.Flags, input.Caller.Pid, "", &out.OpenOut); st != fuse.OK {
			return st
		}
		fs.mu.Lock()
		fs.entryOutLocked(n, &out.EntryOut)
		fs.mu.Unlock()
		return fuse.OK
	}
	fs.mu.Lock()
	n := fs.upsertLocked(e)
	fs.rememberChildLocked(e)
	fs.entryOutLocked(n, &out.EntryOut)
	fs.mu.Unlock()
	if input.Mode&0o111 != 0 {
		// tar x creates a file with the mode it is to have and never checks it (as a user it chmods nothing), so the
		// executable bit the drive cannot keep would go without a word: errors.log says so (rule 2).
		fs.rep.Log(fuse.OK, "create", fs.display(drivePath), fmt.Sprintf("with mode %04o", input.Mode&0o7777),
			"the drive keeps no modes: the file is 0644 and cannot be executed; run it with bash")
	}
	if input.Flags&syscall.O_ACCMODE == syscall.O_RDONLY {
		fh := fs.addHandle(&handle{node: n})
		out.OpenOut.Fh = fh
		return fuse.OK
	}
	return fs.open(ctx, n, input.Flags, input.Caller.Pid, handleID, &out.OpenOut)
}

// ── read, write ──────────────────────────────────────────────────────────────────────────────────

func (fs *FS) Read(cancel <-chan struct{}, input *fuse.ReadIn, buf []byte) (fuse.ReadResult, fuse.Status) {
	h := fs.handle(input.Fh)
	if h == nil {
		return nil, fuse.EBADF
	}
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	n := h.node
	fs.mu.Lock()
	wf := n.wf
	fs.mu.Unlock()
	off := int64(input.Offset)
	if wf != nil {
		data, err := wf.readAt(ctx, off, int(input.Size))
		if err != nil {
			return nil, fs.readFailed(n, err)
		}
		return fuse.ReadResultData(data), fuse.OK
	}
	m, err := fs.manifest(ctx, n, !fs.door.Health().Offline())
	if err != nil {
		return nil, fs.readFailed(n, err)
	}
	if off >= m.SizeBytes {
		return fuse.ReadResultData(nil), fuse.OK
	}
	want := minI(int64(input.Size), m.SizeBytes-off)
	data := buf[:want]
	if int64(len(buf)) < want {
		data = make([]byte, want)
	}
	if err := fs.readChunks(ctx, m.Chunks, off, data); err != nil {
		return nil, fs.readFailed(n, err)
	}
	return fuse.ReadResultData(data), fuse.OK
}

func (fs *FS) readFailed(n *node, err error) fuse.Status {
	drivePath := fs.pathForLog(n.ino, "")
	if fs.door.Health().Offline() || err == door.ErrOffline {
		return fs.offline("read", drivePath)
	}
	return fs.failed("read", drivePath, err)
}

func (fs *FS) Write(cancel <-chan struct{}, input *fuse.WriteIn, data []byte) (uint32, fuse.Status) {
	h := fs.handle(input.Fh)
	if h == nil || h.wf == nil {
		return 0, fuse.EBADF
	}
	if f := fs.door.Fenced(); f != nil {
		return 0, fuse.EIO
	}
	drivePath := ""
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	if !fs.awaitOnline(ctx) {
		// write() itself fails, so a caller that ignores close() (a shell redirection) still sees it (§5.7).
		return 0, fs.refuse(fuse.EIO, "write", fs.pathForLog(h.node.ino, ""), "",
			fmt.Sprintf("the drive's server cannot be reached (for %s now); the bytes written before this one are in the "+
				"spool, where close() commits them or keeps them in unsent/; /run/orbit-drive/status.json says since when", fs.opts.CloseWait))
	}
	off := int64(input.Offset)
	if h.append {
		off = -1
	}
	if err := h.wf.write(ctx, h, off, data); err != nil {
		drivePath = fs.pathForLog(h.node.ino, "")
		st := statusOfWrite(err)
		if st == fuse.Status(syscall.EOPNOTSUPP) {
			return 0, fs.refuse(st, "write", drivePath, fmt.Sprintf("at offset %d", input.Offset),
				"the drive does not change a file in place; write a new file and rename it over the old one")
		}
		if fs.door.Health().Offline() {
			return 0, fs.offline("write", drivePath)
		}
		return 0, fs.failed("write", drivePath, err)
	}
	return uint32(len(data)), fuse.OK
}

// awaitOnline answers whether the server can be reached, waiting while an outage is younger than CloseWait. A write
// needs only the spool, so a stall of the server (a loaded host, a long Postgres transaction that answers nothing for
// 20 s) makes a write slow rather than failing it and ending the writer; a write past that is an outage's and fails
// at once (§5.7). The probe, every 5 s while offline, is what ends the wait.
func (fs *FS) awaitOnline(ctx context.Context) bool {
	health := fs.door.Health()
	for health.Offline() {
		since := health.Since()
		if since.IsZero() {
			continue
		}
		if time.Since(since) >= fs.opts.CloseWait || fs.door.Fenced() != nil {
			return false
		}
		select {
		case <-ctx.Done():
			return !health.Offline()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return true
}

// ── flush, fsync, release ────────────────────────────────────────────────────────────────────────

// Flush is a close() of a descriptor: what is left is uploaded and committed, and only then does close return (§5.2).
// It is not cut short when the closing process is interrupted.
func (fs *FS) Flush(cancel <-chan struct{}, input *fuse.FlushIn) fuse.Status {
	h := fs.handle(input.Fh)
	if h == nil || !h.write || h.wf == nil {
		return fuse.OK
	}
	if err := h.wf.commit(fs.ctx, fs.opts.CloseWait); err != nil {
		return fs.closeFailed(h.wf, fs.pathForLog(h.node.ino, ""), err)
	}
	return fuse.OK
}

func (fs *FS) Fsync(cancel <-chan struct{}, input *fuse.FsyncIn) fuse.Status {
	h := fs.handle(input.Fh)
	if h == nil || !h.write || h.wf == nil {
		return fuse.OK
	}
	if err := h.wf.commit(fs.ctx, fs.opts.CloseWait); err != nil {
		st := statusOfWrite(err)
		fs.rep.Log(st, "fsync", fs.display(fs.pathForLog(h.node.ino, "")), "", "the bytes could not be committed: "+err.Error())
		return st
	}
	return fuse.OK
}

func (fs *FS) Release(cancel <-chan struct{}, input *fuse.ReleaseIn) {
	fs.mu.Lock()
	h := fs.handles[input.Fh]
	if h != nil {
		delete(fs.handles, input.Fh)
		h.node.handles--
	}
	fs.mu.Unlock()
	if h == nil {
		return
	}
	if h.write && h.wf != nil {
		fs.releaseWriteState(h.wf, fs.pathForLog(h.node.ino, ""))
	}
	fs.mu.Lock()
	fs.dropIfUnusedLocked(h.node)
	fs.mu.Unlock()
}

// ── setattr ──────────────────────────────────────────────────────────────────────────────────────

func (fs *FS) SetAttr(cancel <-chan struct{}, input *fuse.SetAttrIn, out *fuse.AttrOut) fuse.Status {
	n := fs.node(input.NodeId)
	if n == nil {
		return fuse.ENOENT
	}
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	drivePath := fs.pathForLog(n.ino, "")
	valid := input.Valid
	if valid&fuse.FATTR_MODE != 0 {
		// Nothing is stored. The owner's own bits are free, since no other user is on the runner, and group and
		// others may read: so the mode shown (0644, folders 0755) and 0600 or 0700 are no-ops. rsync -a sets 0600, or
		// 0700 for an executable, on each temporary file before writing it, and refusing that would copy nothing. What
		// a file cannot be in the drive, executable by group or others (chmod +x, 0755), writable by them, setuid, is
		// refused visibly (§5.6, §12.5): cp -p, rsync -a and tar x of an executable copy its bytes and then fail.
		allowed := uint32(0o744)
		if n.dir {
			allowed = 0o755
		}
		if want := input.Mode & 0o7777; want&^allowed != 0 {
			return fs.refuse(fuse.EPERM, "chmod", drivePath, fmt.Sprintf("to %04o", want),
				fmt.Sprintf("the drive keeps no modes: files are 0644 and folders 0755; to run a script, use bash %s", fs.display(drivePath)))
		}
	}
	if valid&fuse.FATTR_UID != 0 && input.Uid != fs.opts.UID || valid&fuse.FATTR_GID != 0 && input.Gid != fs.opts.GID {
		return fs.refuse(fuse.EPERM, "chown", drivePath, fmt.Sprintf("to %d:%d", input.Uid, input.Gid),
			fmt.Sprintf("the drive keeps no owners: everything in it belongs to %d:%d", fs.opts.UID, fs.opts.GID))
	}
	if valid&fuse.FATTR_SIZE != 0 {
		if n.dir {
			return fuse.Status(syscall.EISDIR)
		}
		if st := fs.setSize(ctx, n, input, drivePath); st != fuse.OK {
			return st
		}
	}
	if valid&(fuse.FATTR_MTIME|fuse.FATTR_MTIME_NOW) != 0 {
		var t *time.Time
		if valid&fuse.FATTR_MTIME_NOW == 0 {
			v := time.Unix(int64(input.Mtime), int64(input.Mtimensec))
			t = &v
		}
		if st := fs.setMtime(ctx, n, t, input.Caller.Pid, drivePath); st != fuse.OK {
			return st
		}
	}
	return fs.GetAttr(cancel, &fuse.GetAttrIn{InHeader: input.InHeader}, out)
}

// setSize is truncate(2) or ftruncate(2) (§5.2, §5.6).
func (fs *FS) setSize(ctx context.Context, n *node, input *fuse.SetAttrIn, drivePath string) fuse.Status {
	size := int64(input.Size)
	var h *handle
	var wf *wfile
	if input.Valid&fuse.FATTR_FH != 0 {
		if opened := fs.handle(input.Fh); opened != nil && opened.wf != nil {
			h = opened
			wf = h.wf
		}
	}
	if wf == nil {
		fs.mu.Lock()
		wf = n.wf
		current := n.size
		fs.mu.Unlock()
		if wf == nil {
			// truncate(2) of a path no handle here is writing.
			if size == current {
				return fuse.OK
			}
			if size != 0 {
				return fs.refuse(fuse.Status(syscall.EOPNOTSUPP), "truncate", drivePath, fmt.Sprintf("to %d bytes", size),
					"the drive does not change a file in place: it can empty a file (truncate to 0) or replace it with a new one")
			}
			return fs.emptyFile(ctx, n, drivePath)
		}
	}
	if fs.door.Fenced() != nil {
		return fuse.EIO
	}
	if fs.door.Health().Offline() {
		return fs.offline("truncate", drivePath)
	}
	if err := wf.truncate(ctx, h, size); err != nil {
		st := statusOfWrite(err)
		if st == fuse.Status(syscall.EOPNOTSUPP) {
			return fs.refuse(st, "truncate", drivePath, fmt.Sprintf("to %d bytes", size),
				"the drive does not change a file in place: it can empty a file (truncate to 0) or replace it with a new one")
		}
		return fs.failed("truncate", drivePath, err)
	}
	if h == nil && size == 0 {
		// A pathname truncate has no writable descriptor whose FLUSH can commit it.
		if err := wf.commit(fs.ctx, fs.opts.CloseWait); err != nil {
			return fs.closeFailed(wf, drivePath, err)
		}
	}
	return fuse.OK
}

// emptyFile is truncate(2) to 0 of a file nobody here is writing: an overwrite to empty, the previous version to Trash.
func (fs *FS) emptyFile(ctx context.Context, n *node, drivePath string) fuse.Status {
	if fs.door.Health().Offline() {
		return fs.offline("truncate", drivePath)
	}
	commit := door.Commit{CommitID: newUUID(), EntryID: n.id, HandleID: newUUID(), Mode: "OVERWRITE", Chunks: []door.CommitChunk{}}
	var result door.CommitResult
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		result, _, err = fs.door.Commit(ctx, commit)
		if err == nil || !door.Transient(err) || fs.door.Health().Offline() {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return fs.failed("truncate", drivePath, err)
	}
	fs.committed(n, result, &door.Manifest{EntryID: n.id, VersionID: result.VersionID, Seq: result.Seq})
	return fuse.OK
}

// setMtime is utimens (§5.6): stored, and kept until after the commit while the file is being written here.
func (fs *FS) setMtime(ctx context.Context, n *node, t *time.Time, pid uint32, drivePath string) fuse.Status {
	fs.mu.Lock()
	wf := n.wf
	fs.mu.Unlock()
	if wf != nil && wf.setMtime(t) {
		return fuse.OK
	}
	if t == nil {
		v := time.Now()
		t = &v
	}
	if fs.door.Health().Offline() {
		return fs.offline("utimens", drivePath)
	}
	e, err := fs.door.Utimens(ctx, n.id, *t, fs.writer(pid, ""))
	if err != nil {
		return fs.failed("utimens", drivePath, err)
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if e.Seq >= n.seq {
		n.mtime, n.seq = e.Mtime, e.Seq
	}
	return fuse.OK
}

// ── background ───────────────────────────────────────────────────────────────────────────────────

// runCommitter commits dirty writes nobody closes (§5.2): after 30 s without a write, and at least every 5 minutes
// while writing continues, so a long-open log is on the server within 30 s of its last line.
func (fs *FS) runCommitter() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-fs.ctx.Done():
			return
		case <-ticker.C:
		}
		if fs.door.Health().Offline() || fs.door.Fenced() != nil {
			continue
		}
		for _, wf := range fs.writeStates() {
			wf.mu.Lock()
			now := time.Now()
			due := wf.dirty && wf.failed == nil && now.After(wf.nextTry) &&
				(now.Sub(wf.lastWrite) >= fs.opts.IdleCommit || now.Sub(wf.dirtySince) >= fs.opts.MaxCommitInterval)
			if due {
				wf.nextTry = now.Add(5 * time.Second)
			}
			wf.mu.Unlock()
			if !due || !wf.periodic.CompareAndSwap(false, true) {
				continue
			}
			go func(wf *wfile) {
				defer wf.periodic.Store(false)
				if err := wf.commit(fs.ctx, 0); err != nil {
					fs.debugf("periodic commit of %s: %v", wf.entryID, err)
				}
			}(wf)
		}
	}
}

func (fs *FS) writeStates() []*wfile {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	out := make([]*wfile, 0, len(fs.wfiles))
	for wf := range fs.wfiles {
		out = append(out, wf)
	}
	return out
}

// runKeepalive tells the door, every 30 s, which writes hold bytes no commit has taken: what holds a managed runner
// awake (§8.1). A dirty write that has sent nothing yet opens its staging for it.
func (fs *FS) runKeepalive() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-fs.ctx.Done():
			return
		case <-ticker.C:
		}
		if fs.door.Health().Offline() || fs.door.Fenced() != nil {
			continue
		}
		for _, wf := range fs.writeStates() {
			wf.mu.Lock()
			dirty := wf.dirty && wf.failed == nil
			var staging string
			var err error
			if dirty {
				staging, err = wf.ensureStagingLocked(fs.ctx)
			}
			wf.mu.Unlock()
			if dirty && err == nil {
				_ = fs.door.Keepalive(fs.ctx, staging, true)
			}
		}
	}
}

// Shutdown commits what open writes hold, within wait, and keeps in unsent/ what it could not.
func (fs *FS) Shutdown(wait time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	for _, wf := range fs.writeStates() {
		if !wf.isDirty() {
			continue
		}
		if err := wf.commit(ctx, wait); err != nil {
			fs.closeFailed(wf, fs.pathForLog(wf.n.ino, ""), err)
		}
	}
	// Every open write is committed now, or kept in unsent/: nothing the spool holds is left for the parent to salvage
	// into unsent/ again when the next daemon starts (§6.1). Only a daemon that dies without stopping leaves it.
	fs.spool.clear()
}

// Fail fails every open write from now on: the daemon is going away.
func (fs *FS) failWrites(err error) {
	for _, wf := range fs.writeStates() {
		wf.fail(err)
	}
}
