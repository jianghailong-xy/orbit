package drivefs

import (
	"container/list"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"orbit/drive-mount/door"
)

// chunkCache keeps chunks read from the store on the node's disk (§5.3): content-addressed by sha256, so it is never
// stale, least recently used out first. It survives reconnects and daemon restarts; the metadata cache does not.
type chunkCache struct {
	dir   string
	limit int64
	door  *door.Client

	mu       sync.Mutex
	size     int64
	entries  map[string]*list.Element // sha → *cacheEntry
	lru      *list.List
	fetching map[string]*fetch
}

type cacheEntry struct {
	sha  string
	size int64
}

type fetch struct {
	done chan struct{}
	err  error
}

func newChunkCache(dir string, limit int64, client *door.Client) (*chunkCache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	c := &chunkCache{dir: dir, limit: limit, door: client, entries: map[string]*list.Element{}, lru: list.New(), fetching: map[string]*fetch{}}
	// What an earlier daemon cached is still right: index it, oldest first.
	files, _ := os.ReadDir(dir)
	type found struct {
		sha  string
		size int64
		at   int64
	}
	var all []found
	for _, f := range files {
		if len(f.Name()) != 64 || f.IsDir() {
			_ = os.RemoveAll(filepath.Join(dir, f.Name()))
			continue
		}
		info, err := f.Info()
		if err != nil {
			continue
		}
		all = append(all, found{f.Name(), info.Size(), info.ModTime().UnixNano()})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].at < all[j].at })
	for _, f := range all {
		c.entries[f.sha] = c.lru.PushBack(&cacheEntry{sha: f.sha, size: f.size})
		c.size += f.size
	}
	c.mu.Lock()
	c.trimLocked()
	c.mu.Unlock()
	return c, nil
}

func (c *chunkCache) path(sha string) string { return filepath.Join(c.dir, sha) }

func (c *chunkCache) trimLocked() {
	for c.size > c.limit && c.lru.Len() > 1 {
		e := c.lru.Front()
		ent := e.Value.(*cacheEntry)
		c.lru.Remove(e)
		delete(c.entries, ent.sha)
		c.size -= ent.size
		_ = os.Remove(c.path(ent.sha))
	}
}

// has reports whether the chunk is on disk, and marks it used.
func (c *chunkCache) has(sha string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entries[sha]; ok {
		c.lru.MoveToBack(e)
		return true
	}
	return false
}

// adopt takes a committed chunk's spool file as the cache's copy. It answers false when the cache keeps it already
// (the caller removes its file).
func (c *chunkCache) adopt(sha string, size int64, file string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[sha]; ok {
		return false
	}
	if err := os.Truncate(file, size); err != nil {
		return false
	}
	if err := os.Rename(file, c.path(sha)); err != nil {
		return false
	}
	c.entries[sha] = c.lru.PushBack(&cacheEntry{sha: sha, size: size})
	c.size += size
	c.trimLocked()
	return true
}

// local is a cached chunk's bytes without asking the server, or false.
func (c *chunkCache) local(sha string) ([]byte, bool) {
	if !c.has(sha) {
		return nil, false
	}
	data, err := os.ReadFile(c.path(sha))
	if err != nil {
		return nil, false
	}
	return data, true
}

// ensure makes sure the chunk is on disk, fetching it from the door once however many readers ask (§4.2:
// `GET /runner/drive/chunks/:sha256`) and checking its sha256.
func (c *chunkCache) ensure(ctx context.Context, sha string, size int64) error {
	for {
		c.mu.Lock()
		if e, ok := c.entries[sha]; ok {
			c.lru.MoveToBack(e)
			c.mu.Unlock()
			return nil
		}
		if f, ok := c.fetching[sha]; ok {
			c.mu.Unlock()
			select {
			case <-f.done:
			case <-ctx.Done():
				return ctx.Err()
			}
			if f.err != nil {
				return f.err
			}
			continue
		}
		f := &fetch{done: make(chan struct{})}
		c.fetching[sha] = f
		c.mu.Unlock()
		// The fetch is everyone's: one reader giving up does not cancel it for the others. The door's deadlines bound it.
		f.err = c.fetch(context.WithoutCancel(ctx), sha, size)
		c.mu.Lock()
		delete(c.fetching, sha)
		c.mu.Unlock()
		close(f.done)
		return f.err
	}
}

func (c *chunkCache) fetch(ctx context.Context, sha string, size int64) error {
	data, err := c.door.Chunk(ctx, sha, size)
	if err != nil {
		return err
	}
	if hexSHA(data) != sha || (size > 0 && int64(len(data)) != size) {
		return fmt.Errorf("chunk %s arrived with other content (%d bytes)", sha, len(data))
	}
	tmp, err := os.CreateTemp(c.dir, ".fetch-")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	tmp.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[sha]; ok {
		os.Remove(tmp.Name())
		return nil
	}
	if err := os.Rename(tmp.Name(), c.path(sha)); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	c.entries[sha] = c.lru.PushBack(&cacheEntry{sha: sha, size: int64(len(data))})
	c.size += int64(len(data))
	c.trimLocked()
	return nil
}

// readAt reads part of a chunk, from the cache or, once, from the door.
func (c *chunkCache) readAt(ctx context.Context, sha string, size int64, buf []byte, off int64) error {
	for attempt := 0; attempt < 2; attempt++ {
		if err := c.ensure(ctx, sha, size); err != nil {
			return err
		}
		f, err := os.Open(c.path(sha))
		if err != nil {
			// Evicted between the check and the open: fetch it again.
			c.mu.Lock()
			if e, ok := c.entries[sha]; ok {
				c.lru.Remove(e)
				delete(c.entries, sha)
				c.size -= e.Value.(*cacheEntry).size
			}
			c.mu.Unlock()
			continue
		}
		n, err := f.ReadAt(buf, off)
		f.Close()
		if n == len(buf) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	return fmt.Errorf("chunk %s could not be read", sha)
}

// bytes is a whole chunk.
func (c *chunkCache) bytes(ctx context.Context, sha string, size int64) ([]byte, error) {
	buf := make([]byte, size)
	if size == 0 {
		return buf, nil
	}
	if err := c.readAt(ctx, sha, size, buf, 0); err != nil {
		return nil, err
	}
	return buf, nil
}
