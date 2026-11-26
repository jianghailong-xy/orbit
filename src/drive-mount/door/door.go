// Package door speaks the runner drive door, /api/runner/drive/* (docs/drive-technical-design.md §4.2,
// §4.3), for the mount daemon.
//
//   - Every request carries the mount credential and the managed-runner instance it was issued for (generation and
//     instance UID), so the door can tell a superseded instance from the current one (§8.2).
//   - Every request has a deadline: 9 s for metadata, 60 s for a chunk, whose headers must still come within 9 s, so a
//     read that needs an unreachable server fails within the 10 s §5.7 allows. The change feed's long poll is the one
//     request allowed to wait longer, by the wait it asks for.
//   - Health counts failures: three within 10 s and the client is offline, failing every request at once until a probe
//     answers (§5.7). A refusal the server answered (a 4xx) is not a failure of reachability.
//   - A slow answer is not no answer. A request still waiting halfway to its deadline, with nothing answered since it
//     was sent, probes the door meanwhile: past its deadline, it puts the client offline only if the probe did not
//     answer either. A read (stat, list) past its deadline on a server that answered is sent once more, given three
//     deadlines, rather than failing the call.
//   - A superseded, fenced or revoked instance is fenced for good: the daemon stops (§8.2).
package door

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The managed-runner instance headers (src/shared/src/managedRunner.ts).
const (
	instanceCapabilityHeader = "x-orbit-runner-capabilities"
	instanceCapability       = "managed-runner-instance-v1"
	generationHeader         = "x-orbit-cloud-runner-generation"
	podUIDHeader             = "x-orbit-cloud-runner-pod-uid"
	chunkSHA256Header        = "X-Orbit-Chunk-Sha256"
)

// Error codes the daemon acts on.
const (
	CodeEntryNotFound      = "DRIVE_ENTRY_NOT_FOUND"
	CodeParentGone         = "DRIVE_PARENT_GONE"
	CodeNotAFolder         = "DRIVE_NOT_A_FOLDER"
	CodeNotAFile           = "DRIVE_NOT_A_FILE"
	CodeNameInvalid        = "DRIVE_NAME_INVALID"
	CodeNameTaken          = "DRIVE_NAME_TAKEN"
	CodeMoveIntoItself     = "DRIVE_MOVE_INTO_ITSELF"
	CodeRoot               = "DRIVE_ROOT"
	CodeTailMoved          = "DRIVE_TAIL_MOVED"
	CodeBaseGone           = "DRIVE_BASE_GONE"
	CodeChunkNotHeld       = "DRIVE_CHUNK_NOT_HELD"
	CodeChunkNotFound      = "DRIVE_CHUNK_NOT_FOUND"
	CodeChunkGone          = "DRIVE_CHUNK_GONE"
	CodeStagingNotFound    = "DRIVE_STAGING_NOT_FOUND"
	CodeStorageFull        = "DRIVE_STORAGE_FULL"
	CodeInstanceSuperseded = "MANAGED_RUNNER_INSTANCE_SUPERSEDED"
	CodeInstanceFenced     = "MANAGED_RUNNER_INSTANCE_FENCED"
	CodeInstanceNotAuth    = "MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED"
	CodeInstanceRequired   = "MANAGED_RUNNER_INSTANCE_REQUIRED"
	CodeInstancePending    = "MANAGED_RUNNER_INSTANCE_PENDING"
	CodeCredentialRefused  = "DRIVE_MOUNT_CREDENTIAL_REFUSED"
)

// Entry is one entry as the door answers it: stat, list, create, mkdir and rename.
type Entry struct {
	ID               string    `json:"id"`
	ParentID         *string   `json:"parentId"`
	Kind             string    `json:"kind"`
	Name             string    `json:"name"`
	SizeBytes        int64     `json:"sizeBytes"`
	Mtime            time.Time `json:"mtime"`
	CurrentVersionID *string   `json:"currentVersionId"`
	Seq              int64     `json:"seq"`
	Path             string    `json:"path"`
	// SHA256 is a one-chunk file's chunk, which only a listing carries.
	SHA256 *string `json:"sha256"`
}

// IsFolder reports whether the entry is a folder.
func (e Entry) IsFolder() bool { return e.Kind == "FOLDER" }

// VersionID is the file's current version, or "".
func (e Entry) VersionID() string {
	if e.CurrentVersionID == nil {
		return ""
	}
	return *e.CurrentVersionID
}

// Parent is the folder the entry is in, or "" for the root.
func (e Entry) Parent() string {
	if e.ParentID == nil {
		return ""
	}
	return *e.ParentID
}

// Listing is one page of a folder's children.
type Listing struct {
	Folder     Entry   `json:"folder"`
	Entries    []Entry `json:"entries"`
	NextCursor *string `json:"nextCursor"`
}

// Chunk is one chunk of a version: its index, offset in the file, size and content.
type Chunk struct {
	Idx    int    `json:"idx"`
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is a file's current version as a chunk list.
type Manifest struct {
	EntryID   string  `json:"entryId"`
	VersionID string  `json:"versionId"`
	SizeBytes int64   `json:"sizeBytes"`
	Seq       int64   `json:"seq"`
	Chunks    []Chunk `json:"chunks"`
}

// Writer says who a write comes from (§5.8): the session, when the caller could be told apart, and the burst of
// deletes a delete belongs to. Both are hints the door checks.
type Writer struct {
	SessionID string `json:"sessionId,omitempty"`
	BurstKey  string `json:"burstKey,omitempty"`
}

// CommitChunk names one chunk of a commit.
type CommitChunk struct {
	Idx    int    `json:"idx"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// ReplaceTail names the last chunk an append replaces with itself merged with the appended bytes (§3.2).
type ReplaceTail struct {
	Idx       int    `json:"idx"`
	OldSHA256 string `json:"oldSha256"`
}

// Commit is one commit (§3.1).
type Commit struct {
	CommitID      string        `json:"commitId"`
	EntryID       string        `json:"entryId"`
	HandleID      string        `json:"handleId,omitempty"`
	Mode          string        `json:"mode"`
	BaseVersionID string        `json:"baseVersionId,omitempty"`
	BaseSize      *int64        `json:"baseSize,omitempty"`
	Chunks        []CommitChunk `json:"chunks"`
	ReplaceTail   *ReplaceTail  `json:"replaceTail,omitempty"`
	StagingID     string        `json:"stagingId,omitempty"`
	Writer        *Writer       `json:"writer,omitempty"`
}

// CommitResult is the door's answer to a commit.
type CommitResult struct {
	EntryID           string    `json:"entryId"`
	VersionID         string    `json:"versionId"`
	NewVersion        bool      `json:"newVersion"`
	ReplacedVersionID *string   `json:"replacedVersionId"`
	SizeBytes         int64     `json:"sizeBytes"`
	Seq               int64     `json:"seq"`
	Mtime             time.Time `json:"mtime"`
	Replayed          bool      `json:"replayed"`
}

// Tail is the last chunk of a version, as a 409 DRIVE_TAIL_MOVED answers it.
type Tail struct {
	Idx    int    `json:"idx"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Offset int64  `json:"offset"`
}

// TailMoved is the body of a 409 DRIVE_TAIL_MOVED: the version as it is now, for the append to be built again.
type TailMoved struct {
	VersionID string `json:"versionId"`
	SizeBytes int64  `json:"sizeBytes"`
	Tail      *Tail  `json:"tail"`
}

// Change is one row of the change feed (§5.4).
type Change struct {
	Seq      int64     `json:"seq"`
	EntryID  string    `json:"entryId"`
	ParentID *string   `json:"parentId"`
	Op       string    `json:"op"`
	At       time.Time `json:"at"`
}

// Changes is one answer of the change feed.
type Changes struct {
	Changes []Change `json:"changes"`
	Cursor  string   `json:"cursor"`
	More    bool     `json:"more"`
	Resync  bool     `json:"resync"`
}

// Usage is the account's drive bytes, what statfs reports as used (§5.6).
type Usage struct {
	DriveBytes int64 `json:"driveBytes"`
}

// ErrOffline is what a request answers while the client is offline (§5.7): it was not sent.
var ErrOffline = errors.New("the drive's server cannot be reached")

// FencedError is what every request answers once the instance has been superseded, fenced or its credential revoked
// (§8.2).
type FencedError struct {
	Code    string
	Message string
}

func (e *FencedError) Error() string {
	return fmt.Sprintf("this runner instance may no longer use the drive (%s): %s", e.Code, e.Message)
}

// HTTPError is a refusal the server answered.
type HTTPError struct {
	Method  string
	Route   string
	Status  int
	Code    string
	Message string
	Body    []byte
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s %s: %d %s: %s", e.Method, e.Route, e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("%s %s: %d %s", e.Method, e.Route, e.Status, strings.TrimSpace(string(e.Body)))
}

// TransportError is a request that got no answer: refused, reset, or past its deadline.
type TransportError struct {
	Method string
	Route  string
	Err    error
}

func (e *TransportError) Error() string { return fmt.Sprintf("%s %s: %v", e.Method, e.Route, e.Err) }
func (e *TransportError) Unwrap() error { return e.Err }

// CodeOf is the door's error code of err, or "".
func CodeOf(err error) string {
	var h *HTTPError
	if errors.As(err, &h) {
		return h.Code
	}
	return ""
}

// StatusOf is the HTTP status of a refusal, or 0.
func StatusOf(err error) int {
	var h *HTTPError
	if errors.As(err, &h) {
		return h.Status
	}
	return 0
}

// Transient reports whether err may succeed if sent again: no answer at all, or a 5xx.
func Transient(err error) bool {
	var t *TransportError
	if errors.As(err, &t) {
		return true
	}
	if errors.Is(err, ErrOffline) {
		return true
	}
	var h *HTTPError
	if errors.As(err, &h) {
		return h.Status >= 500 && h.Code != CodeStorageFull
	}
	return false
}

// Config is how a client reaches its door.
type Config struct {
	// BaseURL is the server's root, e.g. https://orbit.example.com; routes go under /api/runner/drive.
	BaseURL string
	// Token is the mount credential (or, for a self-registered runner in tests, a runner credential).
	Token string
	// Generation and PodUID name the managed-runner instance the credential was issued for; empty for none.
	Generation string
	PodUID     string

	MetaTimeout        time.Duration // 9 s; a read sent again after a slow answer gets three
	ChunkTimeout       time.Duration // 60 s
	ChunkHeaderTimeout time.Duration // 9 s
	FailureWindow      time.Duration // 10 s
	FailuresOffline    int           // 3
	ProbeInterval      time.Duration // 5 s
	UserAgent          string
}

func (c *Config) defaults() {
	if c.MetaTimeout == 0 {
		c.MetaTimeout = 9 * time.Second
	}
	if c.ChunkTimeout == 0 {
		c.ChunkTimeout = 60 * time.Second
	}
	if c.ChunkHeaderTimeout == 0 {
		c.ChunkHeaderTimeout = 9 * time.Second
	}
	if c.FailureWindow == 0 {
		c.FailureWindow = 10 * time.Second
	}
	if c.FailuresOffline == 0 {
		c.FailuresOffline = 3
	}
	if c.ProbeInterval == 0 {
		c.ProbeInterval = 5 * time.Second
	}
	if c.UserAgent == "" {
		c.UserAgent = "orbit-drive-mount"
	}
}

// Client is the door of one mount.
type Client struct {
	cfg    Config
	short  *http.Client // metadata and chunks: headers within ChunkHeaderTimeout
	long   *http.Client // the change feed's long poll
	health *Health

	witnessing atomic.Bool // a probe sent for a request that waits is in flight

	fenceMu sync.Mutex
	fenced  *FencedError
	onFence []func(*FencedError)
}

// New makes a client. It sends nothing until asked.
func New(cfg Config) *Client {
	cfg.defaults()
	dial := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := func(headerTimeout time.Duration) *http.Transport {
		return &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           dial.DialContext,
			MaxIdleConns:          64,
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: headerTimeout,
			ExpectContinueTimeout: time.Second,
			ForceAttemptHTTP2:     true,
		}
	}
	c := &Client{
		cfg:    cfg,
		short:  &http.Client{Transport: transport(cfg.ChunkHeaderTimeout)},
		long:   &http.Client{Transport: transport(0)},
		health: newHealth(cfg.FailureWindow, cfg.FailuresOffline),
	}
	return c
}

// Health is the client's reachability.
func (c *Client) Health() *Health { return c.health }

// OnFence registers fn to run once when the instance is fenced.
func (c *Client) OnFence(fn func(*FencedError)) {
	c.fenceMu.Lock()
	defer c.fenceMu.Unlock()
	c.onFence = append(c.onFence, fn)
}

// Fenced is the fencing the client met, or nil.
func (c *Client) Fenced() *FencedError {
	c.fenceMu.Lock()
	defer c.fenceMu.Unlock()
	return c.fenced
}

func (c *Client) fence(code, message string) *FencedError {
	c.fenceMu.Lock()
	if c.fenced != nil {
		f := c.fenced
		c.fenceMu.Unlock()
		return f
	}
	f := &FencedError{Code: code, Message: message}
	c.fenced = f
	listeners := append([]func(*FencedError){}, c.onFence...)
	c.fenceMu.Unlock()
	for _, fn := range listeners {
		fn(f)
	}
	return f
}

type kind int

const (
	kindMeta kind = iota
	kindChunk
	kindLongPoll
	kindProbe
	kindSlowRead // a read sent again after its first deadline passed on a server that answered: no header deadline
)

func (c *Client) url(route string, query url.Values) string {
	u := strings.TrimRight(c.cfg.BaseURL, "/") + "/api/runner/drive" + route
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

func (c *Client) prepare(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	if c.cfg.Generation != "" || c.cfg.PodUID != "" {
		req.Header.Set(instanceCapabilityHeader, instanceCapability)
		req.Header.Set(generationHeader, c.cfg.Generation)
		req.Header.Set(podUIDHeader, c.cfg.PodUID)
	}
}

// send makes one request and answers the response, whose body the caller closes, or the error the response stood for.
func (c *Client) send(ctx context.Context, k kind, method, route string, query url.Values, body io.Reader, contentType string, extra http.Header, timeout time.Duration) (*http.Response, context.CancelFunc, error) {
	if f := c.Fenced(); f != nil {
		return nil, nil, f
	}
	if k != kindProbe && c.health.Offline() {
		return nil, nil, ErrOffline
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(ctx, method, c.url(route, query), body)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	c.prepare(req)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for name, values := range extra {
		for _, v := range values {
			req.Header.Add(name, v)
		}
	}
	client := c.short
	if k == kindLongPoll || k == kindSlowRead {
		client = c.long
	}
	sent := c.health.now()
	stopWitness := func() {}
	if k != kindLongPoll && k != kindProbe {
		wait := timeout
		if client == c.short && c.cfg.ChunkHeaderTimeout < wait {
			wait = c.cfg.ChunkHeaderTimeout
		}
		stopWitness = c.witness(sent, wait/2)
	}
	resp, err := client.Do(req)
	stopWitness()
	if err != nil {
		// The caller giving up (the kernel interrupting the request) is not the server's failure; a refused or reset
		// connection, or one past its deadline, is.
		callerGaveUp := ctx.Err() == context.Canceled
		timedOut := ctx.Err() == context.DeadlineExceeded || isTimeout(err)
		cancel()
		switch {
		case callerGaveUp:
		case timedOut:
			c.health.timedOut(sent)
		default:
			c.health.failure()
		}
		return nil, nil, &TransportError{Method: method, Route: route, Err: err}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, cancel, nil
	}
	defer cancel()
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	herr := &HTTPError{Method: method, Route: route, Status: resp.StatusCode, Body: raw}
	var parsed struct {
		Code    string          `json:"code"`
		Message json.RawMessage `json:"message"`
	}
	if json.Unmarshal(raw, &parsed) == nil {
		herr.Code = parsed.Code
		var text string
		if json.Unmarshal(parsed.Message, &text) == nil {
			herr.Message = text
		} else {
			herr.Message = string(parsed.Message)
		}
	}
	switch {
	case herr.Code == CodeInstanceSuperseded || herr.Code == CodeInstanceFenced || herr.Code == CodeInstanceNotAuth ||
		herr.Code == CodeInstanceRequired || herr.Code == CodeCredentialRefused:
		c.health.success()
		return nil, nil, c.fence(herr.Code, herr.Message)
	case resp.StatusCode >= 500 && herr.Code != CodeStorageFull:
		c.health.failure()
	default:
		c.health.success()
	}
	return nil, nil, herr
}

// json sends a request with a JSON body (or none) and decodes a JSON answer into out (unless out is nil).
func (c *Client) json(ctx context.Context, k kind, method, route string, query url.Values, in, out interface{}) error {
	var body io.Reader
	contentType := ""
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
		contentType = "application/json"
	}
	timeout := c.cfg.MetaTimeout
	if k == kindLongPoll {
		timeout = c.cfg.MetaTimeout + longPollWait(query)
	}
	resp, cancel, err := c.send(ctx, k, method, route, query, body, contentType, nil, timeout)
	if err != nil && k == kindMeta && method == http.MethodGet && c.slowNotGone(ctx, err) {
		// A read is safe to send again, and the server is busy, not gone: waiting longer beats failing the call.
		resp, cancel, err = c.send(ctx, kindSlowRead, method, route, query, nil, "", nil, 3*c.cfg.MetaTimeout)
	}
	if err != nil {
		return err
	}
	defer cancel()
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		c.health.failure()
		return &TransportError{Method: method, Route: route, Err: err}
	}
	c.health.success()
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s %s: the door answered something that is not JSON: %w", method, route, err)
	}
	return nil
}

func longPollWait(query url.Values) time.Duration {
	seconds, _ := strconv.Atoi(query.Get("wait"))
	return time.Duration(seconds) * time.Second
}

// ── routes ────────────────────────────────────────────────────────────────────────────────────────

// StatPath is the live entry at a drive path (`/Proj/r.md`; `/` is the root).
func (c *Client) StatPath(ctx context.Context, path string) (Entry, error) {
	var e Entry
	err := c.json(ctx, kindMeta, http.MethodGet, "/stat", url.Values{"path": {path}}, nil, &e)
	return e, err
}

// StatID is the live entry with id.
func (c *Client) StatID(ctx context.Context, id string) (Entry, error) {
	var e Entry
	err := c.json(ctx, kindMeta, http.MethodGet, "/stat", url.Values{"id": {id}}, nil, &e)
	return e, err
}

// List is one page of a live folder's children, from cursor ("" for the first page).
func (c *Client) List(ctx context.Context, folderID, cursor string, limit int) (Listing, error) {
	q := url.Values{"id": {folderID}}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var l Listing
	err := c.json(ctx, kindMeta, http.MethodGet, "/list", q, nil, &l)
	return l, err
}

// Manifest is a live file's current chunk list.
func (c *Client) Manifest(ctx context.Context, id string) (Manifest, error) {
	var m Manifest
	err := c.json(ctx, kindMeta, http.MethodGet, "/manifest", url.Values{"id": {id}}, nil, &m)
	return m, err
}

// Create makes a new file at path with an empty first version bound to handleID (§3.1).
func (c *Client) Create(ctx context.Context, path, handleID string, w *Writer) (Entry, error) {
	var e Entry
	err := c.json(ctx, kindMeta, http.MethodPost, "/create", nil, map[string]interface{}{"path": path, "handleId": handleID, "writer": w}, &e)
	return e, err
}

// Mkdir makes the folder at path.
func (c *Client) Mkdir(ctx context.Context, path string, w *Writer) (Entry, error) {
	var e Entry
	err := c.json(ctx, kindMeta, http.MethodPost, "/mkdir", nil, map[string]interface{}{"path": path, "parents": false, "writer": w}, &e)
	return e, err
}

// Rename moves the entry id to the path to; onto a live file it replaces it, unless noReplace.
func (c *Client) Rename(ctx context.Context, id, to string, noReplace bool, w *Writer) (Entry, error) {
	var e Entry
	err := c.json(ctx, kindMeta, http.MethodPost, "/rename", nil, map[string]interface{}{"id": id, "to": to, "noReplace": noReplace, "writer": w}, &e)
	return e, err
}

// Delete moves the entry id, a folder with everything in it, to the owner's Trash.
func (c *Client) Delete(ctx context.Context, id string, w *Writer) error {
	return c.json(ctx, kindMeta, http.MethodPost, "/delete", nil, map[string]interface{}{"id": id, "writer": w}, nil)
}

// Utimens sets the entry's mtime.
func (c *Client) Utimens(ctx context.Context, id string, mtime time.Time, w *Writer) (Entry, error) {
	var e Entry
	err := c.json(ctx, kindMeta, http.MethodPost, "/utimens", nil, map[string]interface{}{"id": id, "mtime": mtime.UTC().Format("2006-01-02T15:04:05.000Z"), "writer": w}, &e)
	return e, err
}

// OpenStaging opens the staging one handle's chunks go into.
func (c *Client) OpenStaging(ctx context.Context, entryID string) (string, error) {
	var s struct {
		ID string `json:"id"`
	}
	err := c.json(ctx, kindMeta, http.MethodPost, "/stagings", nil, map[string]interface{}{"entryId": entryID}, &s)
	return s.ID, err
}

// Keepalive moves the staging's touched time, and says whether its handle holds bytes no commit has taken (§8.1).
func (c *Client) Keepalive(ctx context.Context, stagingID string, dirty bool) error {
	return c.json(ctx, kindMeta, http.MethodPost, "/stagings/"+url.PathEscape(stagingID)+"/keepalive", nil, map[string]interface{}{"dirty": dirty}, nil)
}

// PutChunk sends chunk idx of a staging.
func (c *Client) PutChunk(ctx context.Context, stagingID string, idx int, sha256 string, data []byte) error {
	route := fmt.Sprintf("/stagings/%s/chunks/%d", url.PathEscape(stagingID), idx)
	resp, cancel, err := c.send(ctx, kindChunk, http.MethodPut, route, nil, bytes.NewReader(data), "application/octet-stream",
		http.Header{chunkSHA256Header: {sha256}}, c.cfg.ChunkTimeout)
	if err != nil {
		return err
	}
	defer cancel()
	defer resp.Body.Close()
	// Read the acknowledgement, so a dropped answer is a failure rather than a chunk taken for sent.
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		c.health.failure()
		return &TransportError{Method: http.MethodPut, Route: route, Err: err}
	}
	c.health.success()
	return nil
}

// Chunk is the bytes of a chunk this account names.
func (c *Client) Chunk(ctx context.Context, sha256 string, size int64) ([]byte, error) {
	return c.readBlob(ctx, "/chunks/"+url.PathEscape(sha256), size)
}

// StagingChunk is chunk idx of a staging read back: what the spool fetches after evicting it (§5.3).
func (c *Client) StagingChunk(ctx context.Context, stagingID string, idx int, size int64) ([]byte, error) {
	return c.readBlob(ctx, fmt.Sprintf("/stagings/%s/chunks/%d", url.PathEscape(stagingID), idx), size)
}

func (c *Client) readBlob(ctx context.Context, route string, size int64) ([]byte, error) {
	resp, cancel, err := c.send(ctx, kindChunk, http.MethodGet, route, nil, nil, "", nil, c.cfg.ChunkTimeout)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer resp.Body.Close()
	limit := size
	if limit <= 0 || limit > 64<<20 {
		limit = 64 << 20
	}
	buf := bytes.NewBuffer(make([]byte, 0, limit))
	if _, err := io.Copy(buf, io.LimitReader(resp.Body, limit+1)); err != nil {
		c.health.failure()
		return nil, &TransportError{Method: http.MethodGet, Route: route, Err: err}
	}
	c.health.success()
	return buf.Bytes(), nil
}

// Commit applies one commit (§3.1). A 409 DRIVE_TAIL_MOVED answers the version as it is now in tail.
func (c *Client) Commit(ctx context.Context, commit Commit) (CommitResult, *TailMoved, error) {
	var r CommitResult
	err := c.json(ctx, kindMeta, http.MethodPost, "/commit", nil, commit, &r)
	if err != nil {
		var h *HTTPError
		if errors.As(err, &h) && h.Code == CodeTailMoved {
			var moved TailMoved
			if json.Unmarshal(h.Body, &moved) == nil {
				return r, &moved, err
			}
		}
		return r, nil, err
	}
	// Older doors and saved receipts may omit mtime. Use a stat only if it still describes this commit.
	if r.Mtime.IsZero() {
		if e, err := c.StatID(ctx, r.EntryID); err == nil && e.Seq == r.Seq {
			r.Mtime = e.Mtime
		}
	}
	return r, nil, nil
}

// CommitStatus says whether the commit commitID applied, and its answer: what a writer asks after a commit it could
// not confirm (§5.7).
func (c *Client) CommitStatus(ctx context.Context, commitID string) (bool, CommitResult, error) {
	var s struct {
		Applied bool          `json:"applied"`
		Result  *CommitResult `json:"result"`
	}
	err := c.json(ctx, kindMeta, http.MethodGet, "/commits/"+url.PathEscape(commitID), nil, nil, &s)
	if err != nil || !s.Applied || s.Result == nil {
		return false, CommitResult{}, err
	}
	return true, *s.Result, nil
}

// Changes is the change feed after cursor ("" to start from now), held open up to wait (at most 25 s) until something
// changed (§5.4).
func (c *Client) Changes(ctx context.Context, cursor string, wait time.Duration) (Changes, error) {
	q := url.Values{}
	if cursor != "" {
		q.Set("since", cursor)
	}
	k := kindMeta
	if wait > 0 && cursor != "" {
		q.Set("wait", strconv.Itoa(int(wait/time.Second)))
		k = kindLongPoll
	}
	var ch Changes
	err := c.json(ctx, k, http.MethodGet, "/changes", q, nil, &ch)
	return ch, err
}

// Usage is the account's drive bytes (§5.6).
func (c *Client) Usage(ctx context.Context) (Usage, error) {
	var u Usage
	err := c.json(ctx, kindMeta, http.MethodGet, "/usage", nil, nil, &u)
	return u, err
}

// witness probes the door once a request sent at sent has waited after, unless something answered meanwhile, so that
// when the request's deadline passes the health can tell a slow server from one out of reach (§5.7). One such probe
// is in flight at a time. The answer stops the timer, once the request has its answer.
func (c *Client) witness(sent time.Time, after time.Duration) func() {
	t := time.AfterFunc(after, func() {
		if c.health.answeredSince(sent) || !c.witnessing.CompareAndSwap(false, true) {
			return
		}
		defer c.witnessing.Store(false)
		_ = c.Probe(context.Background())
	})
	return func() { t.Stop() }
}

// slowNotGone reports whether err is a request past its deadline that left the client online: the server answered
// something while it waited, so it is slow, not gone.
func (c *Client) slowNotGone(ctx context.Context, err error) bool {
	var t *TransportError
	if !errors.As(err, &t) || ctx.Err() != nil || c.health.Offline() {
		return false
	}
	return errors.Is(t.Err, context.DeadlineExceeded) || isTimeout(t.Err)
}

// Probe asks the door whether it answers, offline or not: the feed's start, the cheapest route there is.
func (c *Client) Probe(ctx context.Context) error {
	var ch Changes
	return c.json(ctx, kindProbe, http.MethodGet, "/changes", nil, nil, &ch)
}

// ── health ────────────────────────────────────────────────────────────────────────────────────────

// Health is whether the server can be reached (§5.7).
type Health struct {
	mu        sync.Mutex
	window    time.Duration
	threshold int
	failures  []time.Time
	offline   bool
	since     time.Time
	answered  time.Time // when the server last answered a request
	changed   []func(online bool, since time.Time)
	now       func() time.Time
}

func newHealth(window time.Duration, threshold int) *Health {
	return &Health{window: window, threshold: threshold, now: time.Now}
}

// Offline reports whether the client is offline.
func (h *Health) Offline() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.offline
}

// Since is when the client went offline, or the zero time.
func (h *Health) Since() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.offline {
		return time.Time{}
	}
	return h.since
}

// OnChange registers fn to run, outside the lock, whenever the client goes offline or comes back.
func (h *Health) OnChange(fn func(online bool, since time.Time)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.changed = append(h.changed, fn)
}

func (h *Health) failure() {
	h.mu.Lock()
	now := h.now()
	kept := h.failures[:0]
	for _, at := range h.failures {
		if now.Sub(at) < h.window {
			kept = append(kept, at)
		}
	}
	h.failures = append(kept, now)
	went := false
	if !h.offline && len(h.failures) >= h.threshold {
		h.offline, h.since, went = true, now, true
	}
	listeners := append([]func(bool, time.Time){}, h.changed...)
	since := h.since
	h.mu.Unlock()
	if went {
		for _, fn := range listeners {
			fn(false, since)
		}
	}
}

// unreachable puts the client offline at once.
func (h *Health) unreachable() {
	for i := 0; i < h.threshold; i++ {
		h.failure()
	}
}

// answeredSince reports whether the server answered a request after t.
func (h *Health) answeredSince(t time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.answered.After(t)
}

// timedOut is a request sent at sent that passed its deadline. If the server answered nothing while it waited (not
// even the probe the request sent halfway, see witness), it is out of reach and the client goes offline at once: held
// unanswered, requests fail a deadline apart and three of them never fall within 10 s (§5.7). If it answered
// meanwhile, it is slow, not gone, and this is one failure among others: one slow answer on a loaded server does not
// fail every operation on the mount.
func (h *Health) timedOut(sent time.Time) {
	if !h.answeredSince(sent) {
		h.unreachable()
		return
	}
	h.failure()
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (h *Health) success() {
	h.mu.Lock()
	h.answered = h.now()
	h.failures = h.failures[:0]
	back := h.offline
	h.offline = false
	since := h.since
	listeners := append([]func(bool, time.Time){}, h.changed...)
	h.mu.Unlock()
	if back {
		for _, fn := range listeners {
			fn(true, since)
		}
	}
}

// RunProbe probes the door every interval while offline, until ctx ends.
func (c *Client) RunProbe(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.ProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if c.Fenced() != nil {
			return
		}
		if c.health.Offline() {
			_ = c.Probe(ctx)
		}
	}
}
