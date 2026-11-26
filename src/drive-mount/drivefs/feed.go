package drivefs

import (
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"

	"orbit/drive-mount/door"
)

// The change feed (§5.4). The door re-reads, besides every row after the cursor, every row of the 60 s before the
// previous poll began, so a row whose transaction committed late is never skipped; the daemon drops the rows it has
// applied already. Each change drops what the daemon and the kernel cached of the entry and of its folder's listing.
// Kernel notifications go from this goroutine only, never from inside a FUSE request: the kernel may hold the very
// folder a notification needs while it waits for the request's answer.

// lookBackKeep is how long applied seqs are remembered: past the door's 60 s look-back, with room.
const lookBackKeep = 3 * time.Minute

type kernelName struct {
	parent uint64
	name   string
}

func (fs *FS) runFeed() {
	cursor := ""
	applied := map[int64]time.Time{}
	pause := func(d time.Duration) bool {
		select {
		case <-fs.ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}
	for fs.ctx.Err() == nil {
		if fs.door.Fenced() != nil {
			return
		}
		if fs.door.Health().Offline() {
			if !pause(time.Second) {
				return
			}
			continue
		}
		if cursor == "" {
			ch, err := fs.door.Changes(fs.ctx, "", 0)
			if err != nil {
				if !pause(2 * time.Second) {
					return
				}
				continue
			}
			cursor = ch.Cursor
			continue
		}
		ch, err := fs.door.Changes(fs.ctx, cursor, fs.opts.FeedWait)
		if err != nil {
			if door.StatusOf(err) == 400 {
				// A cursor the door does not take: start over, dropping what it might have missed.
				cursor = ""
				fs.dropMetadata("the change feed started over")
			}
			if !pause(time.Second) {
				return
			}
			continue
		}
		if ch.Resync {
			// The feed was pruned past the cursor, or the database was restored to an earlier point (§10.3).
			fs.dropMetadata("the change feed asked for a resync")
			applied = map[int64]time.Time{}
			cursor = ch.Cursor
			continue
		}
		fresh := make([]door.Change, 0, len(ch.Changes))
		for _, c := range ch.Changes {
			if _, seen := applied[c.Seq]; seen {
				continue
			}
			applied[c.Seq] = c.At
			fresh = append(fresh, c)
		}
		if len(fresh) > 0 {
			fs.applyChanges(fresh)
		}
		cursor = ch.Cursor
		for seq, at := range applied {
			if time.Since(at) > lookBackKeep {
				delete(applied, seq)
			}
		}
		fs.rep.FeedSeen()
	}
}

// applyChanges drops what the daemon and the kernel hold of the changed entries and their folders.
func (fs *FS) applyChanges(changes []door.Change) {
	var inodes []uint64
	var names []kernelName
	var refetch []*node
	type unknown struct{ id, parent string }
	var strangers []unknown
	fs.mu.Lock()
	for _, c := range changes {
		parentID := ""
		if c.ParentID != nil {
			parentID = *c.ParentID
		}
		n := fs.byID[c.EntryID]
		if n != nil && (n.seq >= c.Seq || (n.gone && c.Op == "REMOVE")) {
			// This mount's own change, applied when the door answered it.
			continue
		}
		delete(fs.dirs, parentID)
		if n == nil {
			if p := fs.byID[parentID]; p != nil && p.lookups > 0 && len(strangers) < 256 {
				strangers = append(strangers, unknown{c.EntryID, parentID})
			}
			continue
		}
		n.stale, n.manifest, n.sha = true, nil, ""
		if n.dir {
			delete(fs.dirs, n.id)
		}
		if n.ino != rootIno {
			inodes = append(inodes, n.ino)
		}
		if c.Op == "REMOVE" {
			if p := fs.byID[n.parentID]; p != nil {
				names = append(names, kernelName{p.ino, n.name})
			}
		}
		if len(refetch) < 256 {
			refetch = append(refetch, n)
		}
	}
	fs.mu.Unlock()
	fs.notify(inodes, names)

	// Where did they go? A move elsewhere drops the kernel's names at both places; an entry gone is forgotten.
	var moved []kernelName
	for _, n := range refetch {
		fs.mu.Lock()
		oldParent, oldName := fs.byID[n.parentID], n.name
		fs.mu.Unlock()
		e, err := fs.door.StatID(fs.ctx, n.id)
		fs.mu.Lock()
		if err != nil {
			if errno(err) == fuse.ENOENT {
				if oldParent != nil {
					moved = append(moved, kernelName{oldParent.ino, oldName})
				}
				fs.forgetEntryLocked(n)
			}
			fs.mu.Unlock()
			continue
		}
		if e.Parent() != n.parentID || e.Name != n.name {
			if oldParent != nil {
				moved = append(moved, kernelName{oldParent.ino, oldName})
			}
			if p := fs.byID[e.Parent()]; p != nil {
				moved = append(moved, kernelName{p.ino, e.Name})
			}
		}
		n.stale = true
		fs.upsertLocked(e)
		fs.mu.Unlock()
	}
	for _, s := range strangers {
		e, err := fs.door.StatID(fs.ctx, s.id)
		if err != nil {
			continue
		}
		fs.mu.Lock()
		if p := fs.byID[e.Parent()]; p != nil {
			// A name the kernel may hold as missing for 10 s is there now.
			moved = append(moved, kernelName{p.ino, e.Name})
		}
		fs.mu.Unlock()
	}
	fs.notify(nil, moved)
}

// notify tells the kernel to forget attributes and pages of inodes, and the entries at names.
func (fs *FS) notify(inodes []uint64, names []kernelName) {
	if fs.server == nil {
		return
	}
	for _, ino := range inodes {
		fs.server.InodeNotify(ino, 0, 0)
	}
	for _, kn := range names {
		fs.server.EntryNotify(kn.parent, kn.name)
	}
}

// dropMetadata drops every listing, attribute and chunk list the daemon holds, and has the kernel forget its own:
// what every reconnect does (§5.4). The chunk cache is kept: it is content-addressed and cannot be wrong.
func (fs *FS) dropMetadata(why string) {
	fs.mu.Lock()
	var inodes []uint64
	var names []kernelName
	for _, n := range fs.byIno {
		if n.ino == rootIno {
			continue
		}
		n.stale, n.manifest, n.sha = true, nil, ""
		if n.lookups > 0 {
			inodes = append(inodes, n.ino)
			if p := fs.byID[n.parentID]; p != nil {
				names = append(names, kernelName{p.ino, n.name})
			}
		}
	}
	fs.dirs = map[string]*dirCache{}
	fs.mu.Unlock()
	fs.debugf("metadata dropped: %s", why)
	go fs.notify(inodes, names)
}
