package drivefs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"orbit/drive-mount/door"
)

// fakeDoor is the runner drive door's rules as far as these tests need them, in memory: create with an empty first
// version, stagings, CONTINUE / OVERWRITE / APPEND (replaceTail, baseSize, DRIVE_TAIL_MOVED), rename onto a file,
// delete, utimens, a change feed. The real door is held to the same rules by the apiserver's specs and the e2e.
type fakeDoor struct {
	mu       sync.Mutex
	srv      *httptest.Server
	next     int
	seq      int64
	entries  map[string]*fakeEntry
	versions map[string]*fakeVersion
	blobs    map[string][]byte
	stagings map[string]map[int]string
	commits  map[string]door.CommitResult
	changes  []door.Change
	// removed is what a rename onto a file removed outright (§3.2): its folder and name, and the file in Trash a later
	// commit of a handle still bound to it made.
	removed  map[string]*fakeRemoved
	puts     int
	fail     func(r *http.Request) int // a status to answer instead, or 0
	// refuseWrite answers a POST with a refusal of the door's (status, code, message) instead of making it, or status 0.
	refuseWrite func(route string, body map[string]interface{}) (int, string, string)
	// delay is how long to keep a request waiting before serving it, holding nothing else up.
	delay func(r *http.Request) time.Duration
	// loseCommitAnswers commits are applied and then answered 502, as when the answer is lost on the way.
	loseCommitAnswers int
}

type fakeEntry struct {
	id, parent, kind, name, version string
	mtime                           time.Time
	seq                             int64
	trashed                         bool
}

type fakeRemoved struct {
	parent, name, successor string
}

type fakeVersion struct {
	id, entry, handle string
	chunks            []door.Chunk
	replaced          bool
}

func newFakeDoor() *fakeDoor {
	f := &fakeDoor{entries: map[string]*fakeEntry{}, versions: map[string]*fakeVersion{}, blobs: map[string][]byte{},
		stagings: map[string]map[int]string{}, commits: map[string]door.CommitResult{}, removed: map[string]*fakeRemoved{}}
	f.entries["root"] = &fakeEntry{id: "root", kind: "FOLDER", mtime: time.Now()}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func (f *fakeDoor) id(prefix string) string {
	f.next++
	return fmt.Sprintf("%s%d", prefix, f.next)
}

func (f *fakeDoor) size(v *fakeVersion) int64 {
	var n int64
	for _, c := range v.chunks {
		n += c.Size
	}
	return n
}

func (f *fakeDoor) view(e *fakeEntry) map[string]interface{} {
	out := map[string]interface{}{"id": e.id, "kind": e.kind, "name": e.name, "mtime": e.mtime, "seq": e.seq, "path": f.path(e)}
	if e.parent != "" {
		out["parentId"] = e.parent
	}
	if e.kind == "FILE" {
		v := f.versions[e.version]
		out["currentVersionId"], out["sizeBytes"] = e.version, f.size(v)
		if len(v.chunks) == 1 {
			out["sha256"] = v.chunks[0].SHA256
		}
	}
	return out
}

func (f *fakeDoor) path(e *fakeEntry) string {
	if e.parent == "" {
		return "/"
	}
	parent := f.path(f.entries[e.parent])
	if parent == "/" {
		return "/" + e.name
	}
	return parent + "/" + e.name
}

func (f *fakeDoor) at(p string) *fakeEntry {
	cur := f.entries["root"]
	for _, seg := range strings.Split(p, "/") {
		if seg == "" {
			continue
		}
		var next *fakeEntry
		for _, e := range f.entries {
			if e.parent == cur.id && e.name == seg && !e.trashed {
				next = e
			}
		}
		if next == nil {
			return nil
		}
		cur = next
	}
	return cur
}

// add makes a folder, or an empty file, named name in the folder parent, as another runner would.
func (f *fakeDoor) add(parent, kind, name string) *fakeEntry {
	e := &fakeEntry{id: f.id("e"), parent: parent, kind: kind, name: name, mtime: time.Now()}
	if kind == "FILE" {
		v := &fakeVersion{id: f.id("v"), entry: e.id}
		f.versions[v.id] = v
		e.version = v.id
	}
	f.entries[e.id] = e
	f.change(e, "UPSERT")
	return e
}

func (f *fakeDoor) change(e *fakeEntry, op string) {
	f.seq++
	e.seq = f.seq
	parent := e.parent
	f.changes = append(f.changes, door.Change{Seq: f.seq, EntryID: e.id, ParentID: &parent, Op: op, At: time.Now()})
}

func refuse(w http.ResponseWriter, status int, code string, extra map[string]interface{}) {
	body := map[string]interface{}{"code": code, "message": code}
	for k, v := range extra {
		body[k] = v
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (f *fakeDoor) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	if f.delay != nil {
		d := f.delay(r)
		f.mu.Unlock()
		time.Sleep(d)
		f.mu.Lock()
	}
	defer f.mu.Unlock()
	if f.fail != nil {
		if st := f.fail(r); st != 0 {
			w.WriteHeader(st)
			return
		}
	}
	route := strings.TrimPrefix(r.URL.Path, "/api/runner/drive")
	var body map[string]interface{}
	if r.Method == http.MethodPost {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	if f.refuseWrite != nil && r.Method == http.MethodPost {
		if st, code, message := f.refuseWrite(route, body); st != 0 {
			refuse(w, st, code, map[string]interface{}{"message": message})
			return
		}
	}
	str := func(k string) string { s, _ := body[k].(string); return s }
	reply := func(v interface{}) { _ = json.NewEncoder(w).Encode(v) }
	named := func() *fakeEntry {
		if id := r.URL.Query().Get("id"); id != "" {
			if e := f.entries[id]; e != nil && !e.trashed {
				return e
			}
			return nil
		}
		if id := str("id"); id != "" {
			if e := f.entries[id]; e != nil && !e.trashed {
				return e
			}
			return nil
		}
		return f.at(r.URL.Query().Get("path"))
	}
	switch {
	case route == "/stat" || route == "/manifest":
		e := named()
		if e == nil {
			refuse(w, 404, door.CodeEntryNotFound, nil)
			return
		}
		if route == "/stat" {
			reply(f.view(e))
			return
		}
		v := f.versions[e.version]
		reply(door.Manifest{EntryID: e.id, VersionID: v.id, SizeBytes: f.size(v), Seq: e.seq, Chunks: v.chunks})
	case route == "/list":
		e := named()
		if e == nil {
			refuse(w, 404, door.CodeEntryNotFound, nil)
			return
		}
		var kids []map[string]interface{}
		for _, c := range f.entries {
			if c.parent == e.id && !c.trashed {
				kids = append(kids, f.view(c))
			}
		}
		sort.Slice(kids, func(i, j int) bool { return kids[i]["name"].(string) < kids[j]["name"].(string) })
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit > 0 && len(kids) > limit {
			kids = kids[:limit]
		}
		reply(map[string]interface{}{"folder": f.view(e), "entries": kids, "nextCursor": nil})
	case strings.HasPrefix(route, "/chunks/"):
		data, ok := f.blobs[strings.TrimPrefix(route, "/chunks/")]
		if !ok {
			refuse(w, 404, door.CodeChunkNotFound, nil)
			return
		}
		_, _ = w.Write(data)
	case route == "/create" || route == "/mkdir":
		p := str("path")
		dir, name := p[:strings.LastIndex(p, "/")], p[strings.LastIndex(p, "/")+1:]
		parent := f.at(dir)
		if parent == nil {
			refuse(w, 404, door.CodeParentGone, nil)
			return
		}
		if f.at(p) != nil {
			refuse(w, 409, door.CodeNameTaken, nil)
			return
		}
		e := &fakeEntry{id: f.id("e"), parent: parent.id, kind: "FOLDER", name: name, mtime: time.Now()}
		if route == "/create" {
			v := &fakeVersion{id: f.id("v"), entry: e.id, handle: str("handleId")}
			f.versions[v.id] = v
			e.kind, e.version = "FILE", v.id
		}
		f.entries[e.id] = e
		f.change(e, "UPSERT")
		w.WriteHeader(201)
		reply(f.view(e))
	case route == "/stagings":
		id := f.id("s")
		f.stagings[id] = map[int]string{}
		w.WriteHeader(201)
		reply(map[string]string{"id": id})
	case strings.HasPrefix(route, "/stagings/") && strings.HasSuffix(route, "/keepalive"):
		reply(map[string]bool{"ok": true})
	case strings.HasPrefix(route, "/stagings/"):
		parts := strings.Split(route, "/") // "", stagings, id, chunks, idx
		rows := f.stagings[parts[2]]
		idx, _ := strconv.Atoi(parts[4])
		if rows == nil {
			refuse(w, 404, door.CodeStagingNotFound, nil)
			return
		}
		if r.Method == http.MethodGet {
			_, _ = w.Write(f.blobs[rows[idx]])
			return
		}
		data, _ := io.ReadAll(r.Body)
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != r.Header.Get("X-Orbit-Chunk-Sha256") {
			refuse(w, 400, "DRIVE_CHUNK_SHA256_MISMATCH", nil)
			return
		}
		f.blobs[hex.EncodeToString(sum[:])] = data
		rows[idx] = hex.EncodeToString(sum[:])
		f.puts++
		reply(map[string]interface{}{"sha256": rows[idx], "sizeBytes": len(data)})
	case route == "/commit":
		f.commit(w, body)
	case strings.HasPrefix(route, "/commits/"):
		res, ok := f.commits[strings.TrimPrefix(route, "/commits/")]
		reply(map[string]interface{}{"applied": ok, "result": res})
	case route == "/rename":
		e := named()
		to := str("to")
		dir, name := to[:strings.LastIndex(to, "/")], to[strings.LastIndex(to, "/")+1:]
		parent := f.at(dir)
		if target := f.at(to); target != nil {
			if body["noReplace"] == true || target.kind != "FILE" {
				refuse(w, 409, door.CodeNameTaken, nil)
				return
			}
			// §3.2: the target keeps its id and takes the source's current version; its previous one is replaced; the
			// source entry is removed outright.
			f.versions[target.version].replaced = true
			for _, v := range f.versions {
				if v.entry == e.id {
					v.entry = target.id
				}
			}
			f.versions[e.version].handle = ""
			target.version, target.mtime = e.version, e.mtime
			f.removed[e.id] = &fakeRemoved{parent: e.parent, name: e.name}
			delete(f.entries, e.id)
			f.change(e, "REMOVE")
			f.change(target, "UPSERT")
			reply(f.view(target))
			return
		}
		e.parent, e.name = parent.id, name
		f.change(e, "UPSERT")
		reply(f.view(e))
	case route == "/delete":
		e := named()
		e.trashed = true
		f.change(e, "REMOVE")
		reply(map[string]interface{}{"deleted": true, "id": e.id})
	case route == "/utimens":
		e := named()
		e.mtime, _ = time.Parse(time.RFC3339Nano, str("mtime"))
		f.change(e, "UPSERT")
		reply(f.view(e))
	case route == "/changes":
		since, _ := strconv.ParseInt(strings.Split(r.URL.Query().Get("since"), ":")[0], 10, 64)
		var out []door.Change
		for _, c := range f.changes {
			if c.Seq > since {
				out = append(out, c)
			}
		}
		reply(door.Changes{Changes: out, Cursor: fmt.Sprintf("%d:0", f.seq)})
	case route == "/usage":
		reply(map[string]int64{"driveBytes": 0})
	default:
		refuse(w, 404, "NO_ROUTE", nil)
	}
}

func (f *fakeDoor) commit(w http.ResponseWriter, body map[string]interface{}) {
	raw, _ := json.Marshal(body)
	var c door.Commit
	_ = json.Unmarshal(raw, &c)
	if res, ok := f.commits[c.CommitID]; ok {
		res.Replayed = true
		_ = json.NewEncoder(w).Encode(res)
		return
	}
	e := f.entries[c.EntryID]
	fresh := false
	if e == nil {
		gone := f.removed[c.EntryID]
		if gone == nil {
			refuse(w, 404, "DRIVE_ENTRY_NOT_FOUND", nil)
			return
		}
		if gone.successor == "" {
			// A handle still writing a removed source: a new file in Trash named after it.
			v := &fakeVersion{id: f.id("v"), handle: c.HandleID}
			n := &fakeEntry{id: f.id("e"), parent: gone.parent, kind: "FILE", name: gone.name, version: v.id, mtime: time.Now(), trashed: true}
			v.entry = n.id
			f.entries[n.id], f.versions[v.id] = n, v
			gone.successor = n.id
			fresh = true
		}
		e = f.entries[gone.successor]
	}
	for _, ch := range c.Chunks {
		if data, ok := f.blobs[ch.SHA256]; !ok || int64(len(data)) != ch.Size {
			refuse(w, 409, door.CodeChunkNotHeld, nil)
			return
		}
	}
	cur := f.versions[e.version]
	res := door.CommitResult{EntryID: e.id}
	list := func(from int64, chunks []door.CommitChunk) []door.Chunk {
		out := []door.Chunk{}
		off := from
		for _, ch := range chunks {
			out = append(out, door.Chunk{Idx: ch.Idx, Offset: off, Size: ch.Size, SHA256: ch.SHA256})
			off += ch.Size
		}
		return out
	}
	mode := c.Mode
	if mode == "CONTINUE" && !(c.BaseVersionID == cur.id && cur.handle != "" && cur.handle == c.HandleID) {
		mode = "OVERWRITE"
	}
	if fresh && mode != "APPEND" {
		mode = "CONTINUE"
	}
	switch mode {
	case "CONTINUE":
		cur.chunks = list(0, c.Chunks)
	case "APPEND":
		if c.BaseVersionID != cur.id {
			refuse(w, 409, door.CodeBaseGone, nil)
			return
		}
		var tail *door.Chunk
		if n := len(cur.chunks); n > 0 {
			tail = &cur.chunks[n-1]
		}
		moved := func() {
			extra := map[string]interface{}{"versionId": cur.id, "sizeBytes": f.size(cur), "tail": nil}
			if tail != nil {
				extra["tail"] = tail
			}
			refuse(w, 409, door.CodeTailMoved, extra)
		}
		keep := len(cur.chunks)
		from := f.size(cur)
		if c.ReplaceTail != nil {
			if tail == nil || tail.Idx != c.ReplaceTail.Idx || tail.SHA256 != c.ReplaceTail.OldSHA256 {
				moved()
				return
			}
			keep, from = tail.Idx, tail.Offset
		} else if c.BaseSize != nil && *c.BaseSize != from {
			moved()
			return
		}
		cur.chunks = append(cur.chunks[:keep:keep], list(from, c.Chunks)...)
	default:
		v := &fakeVersion{id: f.id("v"), entry: e.id, handle: c.HandleID, chunks: list(0, c.Chunks)}
		f.versions[v.id] = v
		cur.replaced = true
		e.version = v.id
		res.NewVersion = true
		cur = v
	}
	e.mtime = time.Now()
	f.change(e, "UPSERT")
	res.VersionID, res.SizeBytes, res.Seq, res.Mtime = cur.id, f.size(cur), e.seq, e.mtime
	f.commits[c.CommitID] = res
	if f.loseCommitAnswers > 0 {
		f.loseCommitAnswers--
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	_ = json.NewEncoder(w).Encode(res)
}

// appendAsAnotherRunner appends bytes to a file's current version, as a second mount would.
func (f *fakeDoor) appendAsAnotherRunner(p string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.at(p)
	v := f.versions[e.version]
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	f.blobs[sha] = data
	v.chunks = append(v.chunks, door.Chunk{Idx: len(v.chunks), Offset: f.size(v), Size: int64(len(data)), SHA256: sha})
	f.change(e, "UPSERT")
}

// content is a file's current bytes, and how many versions it has had.
func (f *fakeDoor) content(p string) ([]byte, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.at(p)
	if e == nil {
		return nil, 0
	}
	var out []byte
	for _, c := range f.versions[e.version].chunks {
		out = append(out, f.blobs[c.SHA256]...)
	}
	n := 0
	for _, v := range f.versions {
		if v.entry == e.id {
			n++
		}
	}
	return out, n
}

func (f *fakeDoor) chunks(p string) []door.Chunk {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]door.Chunk{}, f.versions[f.at(p).version].chunks...)
}
