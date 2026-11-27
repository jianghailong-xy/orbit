package drivefs

import (
	"container/list"
	"os"
	"path/filepath"
	"sync"
)

// spool accounts for the bytes of open writes on the node's disk (§5.3): dirty chunks, written and not uploaded, and,
// as cache, clean ones, which are evicted first when the spool is full. There is no window behind which writes are
// refused: a writer that finds the spool full uploads its own oldest dirty chunk, which always makes room.
type spool struct {
	dir   string
	limit int64

	mu    sync.Mutex
	used  int64
	peak  int64
	clean *list.List // of *cleanRef, least recently used first
}

type cleanRef struct {
	wf *wfile
	c  *wchunk
}

func newSpool(dir string, limit int64) (*spool, error) {
	if dir == "" {
		d, err := os.MkdirTemp("", "orbit-drive-spool-")
		if err != nil {
			return nil, err
		}
		dir = d
	}
	// What a dead daemon left is not this one's to resume: its writers were told (§6.1 salvages it first).
	_ = os.RemoveAll(filepath.Join(dir, "w"))
	if err := os.MkdirAll(filepath.Join(dir, "w"), 0o700); err != nil {
		return nil, err
	}
	return &spool{dir: dir, limit: limit, clean: list.New()}, nil
}

// clear removes every write's spool file: the daemon is stopping, and what they held is committed or in unsent/.
func (s *spool) clear() {
	_ = os.RemoveAll(filepath.Join(s.dir, "w"))
}

// tryTake accounts for need more bytes if they fit under the limit: checked and taken at once, so two writers never
// both take the last room.
func (s *spool) tryTake(need int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if need > 0 && s.used+need > s.limit {
		return false
	}
	s.used += need
	if s.used > s.peak {
		s.peak = s.used
	}
	return true
}

// take accounts for need more bytes. It never refuses: the caller made room first, as far as room could be made.
func (s *spool) take(need int64) {
	if need <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.used += need
	if s.used > s.peak {
		s.peak = s.used
	}
}

func (s *spool) release(n int64) {
	if n <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.used -= n
	if s.used < 0 {
		s.used = 0
	}
}

// usage is the spool's bytes now and at most since the daemon started.
func (s *spool) usage() (used, peak int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.used, s.peak
}

// addClean lists a chunk whose bytes are uploaded or committed, so it can be evicted. self's lock is held.
func (s *spool) addClean(wf *wfile, c *wchunk) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.clean != nil {
		s.clean.MoveToBack(c.clean)
		return
	}
	c.clean = s.clean.PushBack(&cleanRef{wf: wf, c: c})
}

// forgetClean takes a chunk off the evictable list: it is dirty again, or gone. Its write's lock is held.
func (s *spool) forgetClean(c *wchunk) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.clean != nil {
		s.clean.Remove(c.clean)
		c.clean = nil
	}
}

// evict frees clean chunks, least recently used first, until need fits; self's lock is held by the caller, and
// another write's chunk is evicted only if its lock is free at once, so no writer waits on another. It answers
// whether it freed anything.
func (s *spool) evict(need int64, self *wfile) bool {
	freed := false
	for {
		s.mu.Lock()
		if s.used+need <= s.limit {
			s.mu.Unlock()
			return freed
		}
		var pick *cleanRef
		for e := s.clean.Front(); e != nil; e = e.Next() {
			ref := e.Value.(*cleanRef)
			if ref.wf == self || ref.wf.mu.TryLock() {
				pick = ref
				s.clean.Remove(e)
				ref.c.clean = nil
				break
			}
		}
		s.mu.Unlock()
		if pick == nil {
			return freed
		}
		pick.wf.evictLocked(pick.c)
		if pick.wf != self {
			pick.wf.mu.Unlock()
		}
		freed = true
	}
}
