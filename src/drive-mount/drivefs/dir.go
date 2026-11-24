package drivefs

import (
	"context"
	"errors"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/door"
)

// dirHandle is one open folder: its listing as far as it has been read, page by page (§5.4).
type dirHandle struct {
	node *node

	mu      sync.Mutex
	entries []door.Entry
	cursor  string
	done    bool
	started bool
	// cache is the folder's listing this handle began; it becomes complete when the handle read every page, unless
	// the feed dropped it meanwhile.
	cache *dirCache
}

// fill reads pages until the listing holds at least want entries, or all of them.
func (fs *FS) fill(ctx context.Context, h *dirHandle, want int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	for !h.done && len(h.entries) < want {
		if !h.started {
			// A listing the daemon already holds whole answers without the door.
			fs.mu.Lock()
			id := h.node.id
			if h.node.ino == rootIno {
				id = fs.rootID
			}
			if d := fs.dirs[id]; d != nil && id != "" && d.complete && fs.fresh(d.fetched) {
				for _, e := range d.children {
					h.entries = append(h.entries, e)
				}
				sortEntries(h.entries)
				h.done, h.started = true, true
				fs.mu.Unlock()
				return nil
			}
			fs.mu.Unlock()
		}
		if fs.door.Health().Offline() {
			return door.ErrOffline
		}
		id, err := fs.folderID(ctx, h.node)
		if err != nil {
			return err
		}
		page, err := fs.door.List(ctx, id, h.cursor, pageSize)
		if err != nil {
			return err
		}
		first := !h.started
		h.started = true
		h.entries = append(h.entries, page.Entries...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			h.done = true
		} else {
			h.cursor = *page.NextCursor
		}
		fs.mu.Lock()
		fs.upsertLocked(page.Folder)
		if first {
			h.cache = &dirCache{children: map[string]door.Entry{}, fetched: time.Now()}
			fs.dirs[id] = h.cache
		}
		if h.cache != nil && fs.dirs[id] == h.cache {
			for _, e := range page.Entries {
				h.cache.children[e.Name] = e
			}
			h.cache.complete = h.done
		}
		fs.mu.Unlock()
	}
	return nil
}

// sortEntries puts a listing rebuilt from the cache in the door's order, by name.
func sortEntries(entries []door.Entry) {
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
}

func (fs *FS) OpenDir(cancel <-chan struct{}, input *fuse.OpenIn, out *fuse.OpenOut) fuse.Status {
	n := fs.node(input.NodeId)
	if n == nil {
		return fuse.ENOENT
	}
	if !n.dir {
		return fuse.ENOTDIR
	}
	fs.mu.Lock()
	fh := fs.nextFh
	fs.nextFh++
	fs.handles[fh] = &handle{node: n, dir: &dirHandle{node: n}}
	n.handles++
	fs.mu.Unlock()
	out.Fh = fh
	return fuse.OK
}

func (fs *FS) dirHandle(fh uint64) *dirHandle {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if h := fs.handles[fh]; h != nil {
		return h.dir
	}
	return nil
}

func (fs *FS) ReadDir(cancel <-chan struct{}, input *fuse.ReadIn, out *fuse.DirEntryList) fuse.Status {
	return fs.readDir(cancel, input, out, false)
}

func (fs *FS) ReadDirPlus(cancel <-chan struct{}, input *fuse.ReadIn, out *fuse.DirEntryList) fuse.Status {
	return fs.readDir(cancel, input, out, true)
}

// readDir answers a folder's listing from offset: "." and ".." first, then the children in the door's order, each
// with its attributes for READDIRPLUS, which fills the kernel's entries and attributes so `ls -l` asks no more.
func (fs *FS) readDir(cancel <-chan struct{}, input *fuse.ReadIn, out *fuse.DirEntryList, plus bool) fuse.Status {
	h := fs.dirHandle(input.Fh)
	if h == nil {
		return fuse.EBADF
	}
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	for off := input.Offset; ; off++ {
		if off < 2 {
			name := "."
			ino := h.node.ino
			if off == 1 {
				name = ".."
			}
			e := fuse.DirEntry{Name: name, Mode: syscall.S_IFDIR, Ino: ino, Off: off + 1}
			if plus {
				if out.AddDirLookupEntry(e) == nil {
					return fuse.OK
				}
			} else if !out.AddDirEntry(e) {
				return fuse.OK
			}
			continue
		}
		i := int(off - 2)
		if err := fs.fill(ctx, h, i+1); err != nil {
			if off == input.Offset {
				return fs.failed("readdir", fs.pathForLog(h.node.ino, ""), err)
			}
			// What fits is answered; the kernel asks again from where it stopped.
			return fuse.OK
		}
		h.mu.Lock()
		if i >= len(h.entries) {
			h.mu.Unlock()
			return fuse.OK
		}
		e := h.entries[i]
		h.mu.Unlock()
		mode := uint32(syscall.S_IFREG)
		if e.IsFolder() {
			mode = syscall.S_IFDIR
		}
		fs.mu.Lock()
		n := fs.upsertLocked(e)
		de := fuse.DirEntry{Name: e.Name, Mode: mode, Ino: n.ino, Off: off + 1}
		if plus {
			eo := out.AddDirLookupEntry(de)
			if eo == nil {
				fs.mu.Unlock()
				return fuse.OK
			}
			fs.entryOutLocked(n, eo)
		} else if !out.AddDirEntry(de) {
			fs.mu.Unlock()
			return fuse.OK
		}
		fs.mu.Unlock()
	}
}

func (fs *FS) ReleaseDir(input *fuse.ReleaseIn) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if h := fs.handles[input.Fh]; h != nil {
		delete(fs.handles, input.Fh)
		h.node.handles--
		fs.dropIfUnusedLocked(h.node)
	}
}

func (fs *FS) FsyncDir(cancel <-chan struct{}, input *fuse.FsyncIn) fuse.Status { return fuse.OK }

// ── structure ────────────────────────────────────────────────────────────────────────────────────

// parentPath is the drive path of folder node ino, and the node.
func (fs *FS) parentPath(ctx context.Context, ino uint64) (*node, string, fuse.Status) {
	parent := fs.node(ino)
	if parent == nil {
		return nil, "", fuse.ENOENT
	}
	if !parent.dir {
		return nil, "", fuse.ENOTDIR
	}
	p, err := fs.pathOf(ctx, parent)
	if err != nil {
		return nil, "", errno(err)
	}
	return parent, p, fuse.OK
}

func (fs *FS) Mkdir(cancel <-chan struct{}, input *fuse.MkdirIn, name string, out *fuse.EntryOut) fuse.Status {
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	_, dir, st := fs.parentPath(ctx, input.NodeId)
	if st != fuse.OK {
		return st
	}
	if st := checkName(name); st != fuse.OK {
		return fs.badName(st, "mkdir", dir, name)
	}
	if fs.door.Health().Offline() {
		return fs.offline("mkdir", joinPath(dir, name))
	}
	e, err := fs.door.Mkdir(ctx, joinPath(dir, name), fs.writer(input.Caller.Pid, ""))
	if err != nil {
		return fs.failed("mkdir", joinPath(dir, name), err)
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	n := fs.upsertLocked(e)
	fs.rememberChildLocked(e)
	fs.dirs[e.ID] = &dirCache{children: map[string]door.Entry{}, complete: true, fetched: time.Now()}
	fs.entryOutLocked(n, out)
	return fuse.OK
}

func (fs *FS) Mknod(cancel <-chan struct{}, input *fuse.MknodIn, name string, out *fuse.EntryOut) fuse.Status {
	if input.Mode&syscall.S_IFMT == syscall.S_IFREG {
		// mknod(2) of a plain file is a create that is closed at once.
		var created fuse.CreateOut
		st := fs.Create(cancel, &fuse.CreateIn{InHeader: input.InHeader, Flags: syscall.O_WRONLY | syscall.O_EXCL, Mode: input.Mode}, name, &created)
		if st != fuse.OK {
			return st
		}
		fs.Release(cancel, &fuse.ReleaseIn{InHeader: input.InHeader, Fh: created.Fh})
		*out = created.EntryOut
		return fuse.OK
	}
	return fs.refuse(fuse.EPERM, "mknod", fs.pathForLog(input.NodeId, name), "",
		"the drive keeps only files and folders: no FIFOs, sockets or device nodes")
}

func (fs *FS) Unlink(cancel <-chan struct{}, header *fuse.InHeader, name string) fuse.Status {
	return fs.remove(cancel, header, name, false)
}

func (fs *FS) Rmdir(cancel <-chan struct{}, header *fuse.InHeader, name string) fuse.Status {
	return fs.remove(cancel, header, name, true)
}

// remove moves an entry to the owner's Trash (§3.3); rmdir only an empty folder, as rmdir(2) does.
func (fs *FS) remove(cancel <-chan struct{}, header *fuse.InHeader, name string, folder bool) fuse.Status {
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	op := "unlink"
	if folder {
		op = "rmdir"
	}
	parent, dir, st := fs.parentPath(ctx, header.NodeId)
	if st != fuse.OK {
		return st
	}
	if fs.door.Health().Offline() {
		return fs.offline(op, joinPath(dir, name))
	}
	n, err := fs.child(ctx, parent, name)
	if err != nil {
		return fs.failed(op, joinPath(dir, name), err)
	}
	if folder && !n.dir {
		return fuse.ENOTDIR
	}
	if !folder && n.dir {
		return fuse.Status(syscall.EISDIR)
	}
	if folder {
		page, err := fs.door.List(ctx, n.id, "", 1)
		if err != nil {
			return fs.failed(op, joinPath(dir, name), err)
		}
		if len(page.Entries) > 0 {
			return fuse.Status(syscall.ENOTEMPTY)
		}
	}
	if err := fs.door.Delete(ctx, n.id, fs.writer(header.Caller.Pid, "delete")); err != nil {
		return fs.failed(op, joinPath(dir, name), err)
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.forgetChildLocked(n.parentID, n.name)
	fs.forgetEntryLocked(n)
	return fuse.OK
}

func (fs *FS) Rename(cancel <-chan struct{}, input *fuse.RenameIn, oldName string, newName string) fuse.Status {
	const renameNoReplace, renameExchange, renameWhiteout = 1, 2, 4
	ctx, stop := fs.ctxOf(cancel)
	defer stop()
	oldParent, oldDir, st := fs.parentPath(ctx, input.NodeId)
	if st != fuse.OK {
		return st
	}
	newParent, newDir, st := fs.parentPath(ctx, input.Newdir)
	if st != fuse.OK {
		return st
	}
	from, to := joinPath(oldDir, oldName), joinPath(newDir, newName)
	if input.Flags&(renameExchange|renameWhiteout) != 0 {
		return fs.refuse(fuse.EINVAL, "rename", from, "to "+fs.display(to),
			"the drive cannot swap two entries (RENAME_EXCHANGE) or leave a whiteout")
	}
	if st := checkName(newName); st != fuse.OK {
		return fs.badName(st, "rename", newDir, newName)
	}
	if fs.door.Health().Offline() {
		return fs.offline("rename", from)
	}
	source, err := fs.child(ctx, oldParent, oldName)
	if err != nil {
		return fs.failed("rename", from, err)
	}
	target, err := fs.child(ctx, newParent, newName)
	if err != nil && errno(err) != fuse.ENOENT {
		return fs.failed("rename", to, err)
	}
	if target != nil && target.id == source.id {
		return fuse.OK
	}
	if target != nil {
		if input.Flags&renameNoReplace != 0 {
			return fuse.Status(syscall.EEXIST)
		}
		switch {
		case source.dir && !target.dir:
			return fuse.ENOTDIR
		case !source.dir && target.dir:
			return fuse.Status(syscall.EISDIR)
		case source.dir && target.dir:
			// rename(2) replaces an empty folder; the door moves only onto a free name, so the empty one goes first.
			page, err := fs.door.List(ctx, target.id, "", 1)
			if err != nil {
				return fs.failed("rename", to, err)
			}
			if len(page.Entries) > 0 {
				return fuse.Status(syscall.ENOTEMPTY)
			}
			if err := fs.door.Delete(ctx, target.id, fs.writer(input.Caller.Pid, "delete")); err != nil {
				return fs.failed("rename", to, err)
			}
			fs.mu.Lock()
			fs.forgetChildLocked(target.parentID, target.name)
			fs.forgetEntryLocked(target)
			fs.mu.Unlock()
			target = nil
		}
	}
	e, err := fs.door.Rename(ctx, source.id, to, input.Flags&renameNoReplace != 0, fs.writer(input.Caller.Pid, ""))
	if err != nil {
		if door.CodeOf(err) == door.CodeNameTaken && input.Flags&renameNoReplace == 0 {
			// Another writer took the name between the look and the move.
			return fs.failed("rename", to, fail(fuse.Status(syscall.ENOTEMPTY), "%s is taken", to))
		}
		return fs.failed("rename", from, err)
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.forgetChildLocked(source.parentID, source.name)
	if e.ID == source.id {
		fs.upsertLocked(e)
		fs.rememberChildLocked(e)
		return fuse.OK
	}
	// Onto a file (§3.2): the target keeps its id and takes the source's content as a version, and the source entry is
	// gone. The kernel holds the source's inode at the target's name now, so that inode is the target's from here, as
	// rename(2) leaves it. A handle still writing the source stays bound to the source's id, whose commit the door lands
	// in Trash: then the source's node stays the source's, and the kernel is told to forget the name, after this answer.
	if target != nil {
		fs.forgetChildLocked(target.parentID, target.name)
	}
	if source.wf == nil {
		if old := fs.byID[e.ID]; old != nil {
			// The target's old inode: the kernel dropped it from the name, and no path reaches it again.
			old.gone = true
			delete(fs.byID, e.ID)
			fs.dropIfUnusedLocked(old)
		}
		delete(fs.byID, source.id)
		source.id = e.ID
		fs.inoByID[e.ID] = source.ino
		fs.byID[e.ID] = source
	} else {
		source.gone = true
		if fs.byID[source.id] == source {
			delete(fs.byID, source.id)
		}
		name := kernelName{newParent.ino, newName}
		fs.go_(func() { fs.notify(nil, []kernelName{name}) })
	}
	fs.upsertLocked(e)
	fs.rememberChildLocked(e)
	return fuse.OK
}

// offline answers EIO at once for what needs the server while it cannot be reached (§5.7).
func (fs *FS) offline(op, drivePath string) fuse.Status {
	return fs.refuse(fuse.EIO, op, drivePath, "",
		"the drive's server cannot be reached; reads of cached files and folders still work, and /run/orbit-drive/status.json says since when")
}

// failed answers a door error, logging what an agent could not otherwise tell apart.
func (fs *FS) failed(op, drivePath string, err error) fuse.Status {
	st := errno(err)
	switch {
	case err == door.ErrOffline:
		return fs.offline(op, drivePath)
	case st == fuse.EIO:
		var fenced *door.FencedError
		if errors.As(err, &fenced) {
			return fuse.EIO
		}
		fs.rep.Log(fuse.EIO, op, fs.display(drivePath), "", "the drive's server did not answer: "+err.Error())
	case st == fuse.Status(syscall.ENOSPC):
		fs.rep.Log(st, op, fs.display(drivePath), "", "the drive's storage is full")
	}
	return st
}
