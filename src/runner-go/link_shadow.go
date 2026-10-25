package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"runtime/metrics"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The runner link's shadow period (docs/runner-link-design.md §11.2, decision D7). The runner's work stays on HTTPS,
// untouched. Beside it, one goroutine keeps a connection of its own to the link gateway and mirrors to it every
// heartbeat and event batch the HTTP side delivered, so the gateway can compare the frame the link will carry after
// the cutover with the request the control plane accepted. The mirror's format and rules are the gateway's
// (src/link-gateway/README.md, "Shadow comparison"):
//
//   - For each POST /runner/heartbeat and POST /runner/sessions/<id>/events the server answered with 2xx, the runner
//     sends the typed half (a Heartbeat or an EventBatch built from the body that was sent), then the raw half: an Rpc
//     whose request_id is shadow:<connection id>:<typed frame id> and whose TunnelRequest carries the method, the path
//     under /api and the body, byte for byte.
//   - Never before the 2xx, never in the way of the work, never altered, and every mirror counted: the runner reports
//     how many it sent and how many it dropped, since the gateway cannot see a mirror that never reached it.
//
// How the work path is kept out of it:
//   - The mirrors are taken by a RoundTripper wrapped around the daemon transport's (linkShadowTap). After the
//     transport under it has answered, and only for those two routes answered 2xx, it takes the request's body again
//     through GetBody, never consuming the request's own, puts the mirror on a bounded queue without waiting, and
//     returns the response it was given, untouched. A full queue drops the mirror and counts it.
//   - Everything else runs on the shadow's goroutines, which only log: a connection of its own, HTTP clients of their
//     own for its token requests and its dials, and no state the work reads.
//   - Turned off (ORBIT_LINK_SHADOW=0, or "linkShadow": false in the config), nothing is installed at all.
//
// Every linkShadowSummaryEvery, and when it stops, the shadow logs one "link shadow summary" line of JSON: online
// time, connects and reconnects with their gaps, the last error, the RTT of its pings, and the mirrors sent, answered
// and dropped by reason. Phase A6 reads those lines from the runners' logs.

const (
	// linkShadowEnv turns the shadow off when it reads 0, false, off or no.
	linkShadowEnv = "ORBIT_LINK_SHADOW"
	// linkShadowPrefix starts every raw half's request_id: the gateway never forwards such an Rpc.
	linkShadowPrefix = "shadow:"
	// The queue of mirrors waiting to be sent: so many at most, holding so many request bytes together.
	linkShadowQueueLen   = 64
	linkShadowQueueBytes = 16 << 20
	// linkShadowMaxBody is the largest request mirrored. The gateway holds a half waiting for its other half within
	// 4 MiB per connection, so a larger one could only be counted there as unpaired.
	linkShadowMaxBody = 3 << 20
	// linkShadowMaxHalf bounds a typed half's encoded size, for the same reason.
	linkShadowMaxHalf = 3<<20 + 512<<10
	// linkShadowStopWait is the longest a stopping runner waits for the shadow: to send what is queued, hear the
	// gateway take it, and close.
	linkShadowStopWait = 2 * time.Second
	// linkShadowLogQuiet is how long a failure that repeats goes unlogged.
	linkShadowLogQuiet = 10 * time.Minute
	// linkShadowMaxGaps bounds the reconnect gaps one summary lists.
	linkShadowMaxGaps = 64
)

// The two kinds of mirror, as the summary names them.
const (
	linkMirrorHeartbeat = "heartbeat"
	linkMirrorEvents    = "events"
)

// linkDropReason is why a mirror was not sent.
type linkDropReason int

const (
	linkDropQueueFull  linkDropReason = iota // the queue was full: the shadow is behind
	linkDropTooLarge                         // the request is larger than a mirror may be
	linkDropNoBody                           // the request's body cannot be taken again (it has no GetBody)
	linkDropOffline                          // there was no connection to send it on
	linkDropSendFailed                       // the connection failed while it was being sent
	linkDropUnreadable                       // the body did not read as its route's JSON
	linkDropStopped                          // the runner stopped before it was sent
	linkDropReasons
)

var linkDropReasonNames = [linkDropReasons]string{"queue_full", "too_large", "no_body", "offline", "send_failed", "unreadable", "stopped"}

// linkMirrorCounts counts one kind of mirror. Written from the work path, so atomics only.
type linkMirrorCounts struct {
	sent    atomic.Int64
	dropped [linkDropReasons]atomic.Int64
}

// linkMirror is one request to mirror: what the tap took of it.
type linkMirror struct {
	kind      string
	method    string
	path      string // as requested under /api, with its query
	sessionID string // events: the session in the path
	providers string // heartbeat: X-Orbit-Supported-Providers, which the typed half carries
	body      func() (io.ReadCloser, error)
	size      int64
}

// linkShadowEnabled reports whether the shadow runs, and when it does not, what turned it off.
func linkShadowEnabled(cfg *RunnerConfig) (bool, string) {
	if v, ok := os.LookupEnv(linkShadowEnv); ok {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "0", "false", "off", "no":
			return false, linkShadowEnv + "=" + v
		}
	}
	if cfg != nil && cfg.LinkShadow != nil && !*cfg.LinkShadow {
		return false, `"linkShadow": false in ` + configPath()
	}
	return true, ""
}

// startLinkShadow starts the shadow of the runner process whose daemon transport is t, unless the environment or
// cfg turns it off, and returns what stops it. It installs the tap on t's client, so it runs before anything sends
// on t. Whatever goes wrong in the shadow is logged, and the work goes on without it.
func startLinkShadow(cfg *RunnerConfig, t *Transport) func() {
	if on, why := linkShadowEnabled(cfg); !on {
		logln("link shadow: off (" + why + ")")
		return func() {}
	}
	s := newLinkShadow(newLinkClient(t.baseURL, t.token, t.leaseOwner, func() *linkpb.Hello { return linkHello(t.leaseOwner) }), logln)
	if err := installLinkShadowTap(t, s); err != nil {
		logln("link shadow: off (" + err.Error() + ")")
		return func() {}
	}
	logln("link shadow: on — mirroring the heartbeats and event batches this runner delivers over HTTPS to the runner link gateway, which only compares them (" + linkShadowEnv + "=0 turns it off)")
	return s.start()
}

// linkShadowTap is the RoundTripper the daemon transport's client sends through while the shadow runs. It hands
// every request to next, the transport the client had (nil: http.DefaultTransport, as for the client itself), and
// returns what next returned, untouched. For a POST to one of the two mirrored routes that next answered with 2xx,
// it also hands the shadow a mirror, without waiting.
type linkShadowTap struct {
	next   http.RoundTripper
	shadow *linkShadow
	// prefix is the path the control plane's API lives under, as the transport builds its URLs: the server URL's
	// path and /api.
	prefix string
}

// installLinkShadowTap puts a tap for s around t's client's transport.
func installLinkShadowTap(t *Transport, s *linkShadow) error {
	api, err := url.Parse(t.baseURL + "/api")
	if err != nil {
		return fmt.Errorf("the server URL %q does not parse: %w", t.baseURL, err)
	}
	t.client.Transport = &linkShadowTap{next: t.client.Transport, shadow: s, prefix: api.Path}
	return nil
}

func (tap *linkShadowTap) transport() http.RoundTripper {
	if tap.next == nil {
		return http.DefaultTransport
	}
	return tap.next
}

func (tap *linkShadowTap) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := tap.transport().RoundTrip(req)
	if err == nil && resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		tap.observe(req)
	}
	return resp, err
}

// CloseIdleConnections reaches the transport under the tap, as http.Client.CloseIdleConnections reaches its own.
func (tap *linkShadowTap) CloseIdleConnections() {
	if c, ok := tap.transport().(interface{ CloseIdleConnections() }); ok {
		c.CloseIdleConnections()
	}
}

// observe offers the shadow a mirror of req, which the server answered with 2xx, when it is one of the two mirrored
// routes. It reads nothing but the request's method, URL, one header and GetBody, takes no lock and never waits. A
// panic stays here: it is counted, and the work path gets its response.
func (tap *linkShadowTap) observe(req *http.Request) {
	defer func() {
		if r := recover(); r != nil {
			tap.shadow.tapPanics.Add(1)
		}
	}()
	if req.Method != http.MethodPost {
		return
	}
	path, ok := strings.CutPrefix(req.URL.Path, tap.prefix)
	if !ok {
		return
	}
	m := &linkMirror{method: req.Method, path: path}
	if path == "/runner/heartbeat" {
		m.kind, m.providers = linkMirrorHeartbeat, req.Header.Get("X-Orbit-Supported-Providers")
	} else if id, ok := linkEventsSession(path); ok {
		m.kind, m.sessionID = linkMirrorEvents, id
	} else {
		return
	}
	if req.URL.RawQuery != "" {
		m.path += "?" + req.URL.RawQuery
	}
	if req.GetBody == nil {
		tap.shadow.counts[m.kind].dropped[linkDropNoBody].Add(1)
		return
	}
	m.body, m.size = req.GetBody, req.ContentLength
	tap.shadow.offer(m)
}

// linkEventsSession is the session of a /runner/sessions/<id>/events path.
func linkEventsSession(path string) (string, bool) {
	rest, ok := strings.CutPrefix(path, "/runner/sessions/")
	if !ok {
		return "", false
	}
	id, ok := strings.CutSuffix(rest, "/events")
	if !ok || id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

// linkShadow is the shadow of one runner process.
type linkShadow struct {
	client *linkClient
	log    func(...any)
	now    func() time.Time
	// How often it pings, how long a ping may wait, how long the halves sent on a connection may take to be answered
	// before it is replaced, and how often it sums up. Tests shorten them.
	pingEvery, pingTimeout, settleWait, summaryEvery time.Duration

	queue       chan *linkMirror
	queuedBytes atomic.Int64
	counts      map[string]*linkMirrorCounts // by kind; the map itself never changes
	tapPanics   atomic.Int64
	drains      chan linkShadowDrain

	answered   atomic.Int64 // raw halves the gateway answered
	acks       atomic.Int64 // HeartbeatAcks
	modeWarned atomic.Bool

	started time.Time

	mu      sync.Mutex // guards what the pinging and reading goroutines write: rtt, lastErr, lastErrAt
	rtt     linkRTT
	lastErr string
	errAt   time.Time

	// Owned by the run goroutine.
	run linkShadowRun
}

// linkShadowRun is what the run goroutine counts.
type linkShadowRun struct {
	connects, reconnects, renewals, drained, dialFailures int
	onlineFor                                             time.Duration
	onlineSince                                           time.Time // zero while offline
	lostAt                                                time.Time // zero unless a connection was lost and none followed yet
	gaps                                                  []time.Duration
	maxGap                                                time.Duration
	loggedErr                                             string
	loggedErrAt                                           time.Time
	link                                                  string
}

// linkRTT sums the ping round trips since the last summary.
type linkRTT struct {
	n                   int
	sum, min, max, last time.Duration
}

// linkShadowConn is the shadow's own state of one of its connections.
type linkShadowConn struct {
	*linkConn
	// pending counts the raw halves sent on the connection that the gateway has not answered yet. The gateway answers
	// every Rpc, in order, so with none pending it has taken every mirror sent on the connection, both halves.
	pending atomic.Int64
	// pingFailed is why a ping went unanswered, which ended the connection.
	pingFailed atomic.Pointer[string]
}

// linkShadowDrain is a Drain one of the shadow's connections received.
type linkShadowDrain struct {
	conn  *linkShadowConn
	after time.Duration
}

func newLinkShadow(client *linkClient, log func(...any)) *linkShadow {
	return &linkShadow{
		client: client, log: log, now: time.Now,
		pingEvery: 30 * time.Second, pingTimeout: 30 * time.Second, settleWait: 3 * time.Second, summaryEvery: 10 * time.Minute,
		queue:  make(chan *linkMirror, linkShadowQueueLen),
		counts: map[string]*linkMirrorCounts{linkMirrorHeartbeat: {}, linkMirrorEvents: {}},
		drains: make(chan linkShadowDrain, 4),
	}
}

// offer queues m without waiting. A full queue, by count or by bytes, drops it and counts the drop.
func (s *linkShadow) offer(m *linkMirror) {
	counts := s.counts[m.kind]
	if m.size < 0 || m.size > linkShadowMaxBody {
		counts.dropped[linkDropTooLarge].Add(1)
		return
	}
	if s.queuedBytes.Add(m.size) > linkShadowQueueBytes {
		s.queuedBytes.Add(-m.size)
		counts.dropped[linkDropQueueFull].Add(1)
		return
	}
	select {
	case s.queue <- m:
	default:
		s.queuedBytes.Add(-m.size)
		counts.dropped[linkDropQueueFull].Add(1)
	}
}

// start runs the shadow on a goroutine of its own and returns what stops it: that cancels the shadow, which sends
// what is queued, hears the gateway take it and closes, and waits for it no longer than linkShadowStopWait.
func (s *linkShadow) start() func() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.started = s.now()
	go func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				s.log("link shadow: stopped by a panic, the work goes on without it:", r)
			}
		}()
		s.loop(ctx)
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			select {
			case <-done:
			case <-time.After(linkShadowStopWait):
				s.log("link shadow: still stopping after", linkShadowStopWait, "— not waited for")
			}
		})
	}
}

// loop keeps one connection open and sends the mirrors on it. It connects with backoff, opens the next connection
// before the current one's token expires or when a Drain says to (make before break: the old one goes once the new
// one is welcomed), and drops the mirrors that come while it has no connection.
func (s *linkShadow) loop(ctx context.Context) {
	summary := time.NewTicker(s.summaryEvery)
	defer summary.Stop()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	var cur *linkShadowConn
	defer func() { s.finish(cur) }()
	attempt := 0
	var retryAt, renewAt, drainAt time.Time
	for {
		if cur == nil {
			if !s.offlineUntil(ctx, retryAt, summary.C) {
				return
			}
			st, err := s.connect(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				wait := linkRetryWait(err, attempt)
				attempt++
				s.failed(err, wait)
				retryAt = s.now().Add(wait)
				continue
			}
			cur, attempt, drainAt = st, 0, time.Time{}
			renewAt = st.token.renewAt()
			s.adopted(st)
			continue
		}
		timer.Reset(max(time.Until(renewAt), 0))
		select {
		case <-ctx.Done():
			return
		case m := <-s.queue:
			s.send(cur, m)
		case d := <-s.drains:
			if d.conn != cur {
				continue // from a connection the shadow has replaced since
			}
			s.run.drained++
			drainAt = s.now().Add(d.after)
			if drainAt.Before(renewAt) {
				renewAt = drainAt
			}
			s.log(fmt.Sprintf("link shadow: connection %s is draining; the next one opens in %s", cur.id, d.after.Round(time.Millisecond)))
		case <-summary.C:
			s.logSummary(cur, false)
		case <-cur.done:
			wait := s.lost(cur, attempt)
			attempt++
			if until := time.Until(drainAt); until > wait {
				wait = until // a Drain said when to come back
			}
			cur, retryAt = nil, s.now().Add(wait)
		case <-timer.C:
			why := "token renewal"
			if !drainAt.IsZero() {
				why = "drain"
			}
			// Make before break. Nothing is sent on cur from here until it is replaced, and it is replaced only once
			// the gateway has answered what was sent on it: the gateway closes it the moment it welcomes the next.
			s.settle(cur, s.now().Add(s.settleWait))
			st, err := s.connect(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				wait := linkRetryWait(err, attempt)
				attempt++
				s.failed(err, wait)
				renewAt = s.now().Add(wait)
				continue
			}
			old := cur
			cur, attempt, drainAt = st, 0, time.Time{}
			renewAt = st.token.renewAt()
			s.replaced(old, st, why)
		}
	}
}

// connect opens a connection, with a goroutine pinging it.
func (s *linkShadow) connect(ctx context.Context) (*linkShadowConn, error) {
	st := &linkShadowConn{}
	conn, err := s.client.connect(ctx, func(_ *linkConn, f *linkpb.Frame) { s.onFrame(st, f) })
	if err != nil {
		return nil, err
	}
	st.linkConn = conn
	go s.pinger(st)
	return st, nil
}

// onFrame takes a frame from the gateway, on the connection's reading goroutine.
func (s *linkShadow) onFrame(st *linkShadowConn, f *linkpb.Frame) {
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_RpcResult:
		if strings.HasPrefix(body.RpcResult.GetRequestId(), linkShadowPrefix) {
			st.pending.Add(-1)
			s.answered.Add(1)
		}
	case *linkpb.Frame_HeartbeatAck:
		s.acks.Add(1)
		if mode := body.HeartbeatAck.GetMode(); mode != linkpb.Mode_MODE_HTTP && s.modeWarned.CompareAndSwap(false, true) {
			s.log("link shadow: the gateway answers", mode.String(), "— this runner keeps its work on HTTPS and only mirrors")
		}
	case *linkpb.Frame_Drain:
		select {
		case s.drains <- linkShadowDrain{conn: st, after: time.Duration(body.Drain.GetReconnectAfterMs()) * time.Millisecond}:
		default: // a Drain already waits to be taken
		}
	}
}

// pinger pings st until it ends, and keeps the round trips for the summary. A ping that goes unanswered within
// pingTimeout ends the connection, which the shadow then replaces.
func (s *linkShadow) pinger(st *linkShadowConn) {
	defer func() {
		if r := recover(); r != nil {
			s.noteErr(fmt.Errorf("pinging %s: panic: %v", st.id, r))
		}
	}()
	tick := time.NewTicker(s.pingEvery)
	defer tick.Stop()
	for first := true; ; first = false {
		if !first {
			select {
			case <-st.done:
				return
			case <-tick.C:
			}
		}
		rtt, err := st.ping(s.pingTimeout)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				// The library has closed the connection; its end says why.
				why := "no answer to a ping within " + s.pingTimeout.String()
				st.pingFailed.Store(&why)
			}
			return
		}
		s.mu.Lock()
		r := &s.rtt
		if r.n == 0 || rtt < r.min {
			r.min = rtt
		}
		r.max = max(r.max, rtt)
		r.n++
		r.sum += rtt
		r.last = rtt
		s.mu.Unlock()
	}
}

// send sends m on st: the typed half, then the raw half naming it.
func (s *linkShadow) send(st *linkShadowConn, m *linkMirror) {
	defer s.queuedBytes.Add(-m.size)
	counts := s.counts[m.kind]
	body, typed, err := m.build()
	if err != nil {
		counts.dropped[linkDropUnreadable].Add(1)
		s.noteErr(fmt.Errorf("mirror of %s %s: %w", m.method, m.path, err))
		return
	}
	if proto.Size(typed) > linkShadowMaxHalf {
		counts.dropped[linkDropTooLarge].Add(1)
		return
	}
	id, err := st.send(typed)
	if err != nil {
		counts.dropped[linkDropSendFailed].Add(1)
		s.noteErr(fmt.Errorf("sending on %s: %w", st.id, err))
		return
	}
	st.pending.Add(1)
	if _, err := st.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{
		RequestId: linkShadowPrefix + st.id + ":" + strconv.FormatUint(id, 10),
		Body:      &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: m.method, Path: m.path, JsonBody: body}},
	}}}); err != nil {
		st.pending.Add(-1)
		counts.dropped[linkDropSendFailed].Add(1)
		s.noteErr(fmt.Errorf("sending on %s: %w", st.id, err))
		return
	}
	counts.sent.Add(1)
}

// build reads the body that was sent and builds the typed half from it.
func (m *linkMirror) build() ([]byte, *linkpb.Frame, error) {
	rc, err := m.body()
	if err != nil {
		return nil, nil, err
	}
	body, err := io.ReadAll(io.LimitReader(rc, linkShadowMaxBody+1))
	_ = rc.Close()
	if err != nil {
		return nil, nil, err
	}
	if len(body) > linkShadowMaxBody {
		return nil, nil, errors.New("the body is larger than it said")
	}
	switch m.kind {
	case linkMirrorHeartbeat:
		hb, err := linkMirrorOfHeartbeat(body, m.providers)
		if err != nil {
			return nil, nil, err
		}
		return body, &linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}}, nil
	default:
		eb, err := linkMirrorOfEvents(m.sessionID, body)
		if err != nil {
			return nil, nil, err
		}
		return body, &linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: eb}}, nil
	}
}

// linkHeartbeatTyped are the members of the HTTP heartbeat body that are not Facts: four typed fields of Heartbeat,
// and status and version, which the link does not carry (the version travels in Hello).
var linkHeartbeatTyped = map[string]bool{
	"leaseOwner": true, "idleCapacity": true, "draining": true, "supervisedSessionIds": true, "status": true, "version": true,
}

// linkMirrorOfHeartbeat is the typed half of a heartbeat's mirror, built from the body POST /runner/heartbeat
// carried (src/link-gateway/README.md, "What the runner sends"): process_id is leaseOwner, idle_capacity
// idleCapacity, draining draining and session_ids supervisedSessionIds; every other member but status and version is
// one Fact, its kind the member's name, its json the member's bytes as they were sent and its sha256 their digest.
// supported_providers is the request's X-Orbit-Supported-Providers, which the gateway does not compare.
func linkMirrorOfHeartbeat(body []byte, providers string) (*linkpb.Heartbeat, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(body, &members); err != nil || members == nil {
		return nil, errors.New("the heartbeat body is not a JSON object")
	}
	hb := &linkpb.Heartbeat{SupportedProviders: linkList(providers)}
	_ = json.Unmarshal(members["leaseOwner"], &hb.ProcessId)
	_ = json.Unmarshal(members["draining"], &hb.Draining)
	_ = json.Unmarshal(members["supervisedSessionIds"], &hb.SessionIds)
	var idle json.Number
	if json.Unmarshal(members["idleCapacity"], &idle) == nil {
		if n, err := strconv.ParseUint(idle.String(), 10, 32); err == nil {
			hb.IdleCapacity = uint32(n)
		}
	}
	names := make([]string, 0, len(members))
	for name := range members {
		if !linkHeartbeatTyped[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		sum := sha256.Sum256(members[name])
		hb.Facts = append(hb.Facts, &linkpb.Fact{Kind: name, Sha256: hex.EncodeToString(sum[:]), Json: members[name]})
	}
	return hb, nil
}

// linkMirrorOfEvents is the typed half of an event batch's mirror, built from the body POST
// /runner/sessions/<sessionID>/events carried: its events in order, one for one, each with its seq, type, turnId,
// ts in Unix milliseconds, and payload as the bytes that were sent.
func linkMirrorOfEvents(sessionID string, body []byte) (*linkpb.EventBatch, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(body, &members); err != nil || members == nil {
		return nil, errors.New("the event batch is not a JSON object")
	}
	var events []json.RawMessage
	if raw, ok := members["events"]; ok {
		if err := json.Unmarshal(raw, &events); err != nil {
			return nil, errors.New("the batch's events are not an array")
		}
	}
	eb := &linkpb.EventBatch{SessionId: sessionID, Events: make([]*linkpb.Event, 0, len(events))}
	for i, raw := range events {
		var ev map[string]json.RawMessage
		if err := json.Unmarshal(raw, &ev); err != nil || ev == nil {
			return nil, fmt.Errorf("event %d is not a JSON object", i)
		}
		e := &linkpb.Event{}
		var seq json.Number
		if json.Unmarshal(ev["seq"], &seq) == nil {
			e.Seq, _ = strconv.ParseUint(seq.String(), 10, 64)
		}
		_ = json.Unmarshal(ev["type"], &e.Type)
		_ = json.Unmarshal(ev["turnId"], &e.TurnId)
		var ts string
		if json.Unmarshal(ev["ts"], &ts) == nil {
			if at, err := time.Parse(time.RFC3339Nano, ts); err == nil {
				e.TsUnixMs = at.UnixMilli()
			}
		}
		e.PayloadJson = ev["payload"]
		if e.PayloadJson == nil {
			e.PayloadJson = json.RawMessage("null")
		}
		eb.Events = append(eb.Events, e)
	}
	return eb, nil
}

// offlineUntil waits until at with no connection, dropping the mirrors that come meanwhile: there is nothing to send
// them on. It reports false once ctx has ended.
func (s *linkShadow) offlineUntil(ctx context.Context, at time.Time, summary <-chan time.Time) bool {
	timer := time.NewTimer(max(time.Until(at), 0))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return true
		case m := <-s.queue:
			s.queuedBytes.Add(-m.size)
			s.counts[m.kind].dropped[linkDropOffline].Add(1)
		case <-summary:
			s.logSummary(nil, false)
		}
	}
}

// settle waits until the gateway has answered every mirror sent on st, st has ended, or deadline has passed.
func (s *linkShadow) settle(st *linkShadowConn, deadline time.Time) {
	for st.pending.Load() > 0 && s.now().Before(deadline) {
		select {
		case <-st.done:
			return
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// adopted makes st the shadow's connection after a time without one.
func (s *linkShadow) adopted(st *linkShadowConn) {
	now := s.now()
	r := &s.run
	r.connects++
	r.link = st.token.linkURL
	r.onlineSince = now
	r.loggedErr = ""
	msg := fmt.Sprintf("link shadow: connected %s to %s", st.id, st.token.linkURL)
	if !r.lostAt.IsZero() {
		gap := now.Sub(r.lostAt)
		r.reconnects++
		r.maxGap = max(r.maxGap, gap)
		if len(r.gaps) < linkShadowMaxGaps {
			r.gaps = append(r.gaps, gap)
		}
		r.lostAt = time.Time{}
		msg += fmt.Sprintf(" after %s without one", gap.Round(time.Millisecond))
	}
	s.log(msg)
}

// replaced makes st the shadow's connection in place of old, which it closes.
func (s *linkShadow) replaced(old, st *linkShadowConn, why string) {
	s.run.connects++
	s.run.renewals++
	s.run.link = st.token.linkURL
	s.run.loggedErr = ""
	old.close(websocket.StatusNormalClosure, "replaced")
	s.log(fmt.Sprintf("link shadow: connection %s replaced by %s (%s)", old.id, st.id, why))
}

// lost records the end of st, the shadow's connection, and returns the wait before the next attempt (attempt n).
func (s *linkShadow) lost(st *linkShadowConn, n int) time.Duration {
	now := s.now()
	r := &s.run
	if !r.onlineSince.IsZero() {
		r.onlineFor += now.Sub(r.onlineSince)
		r.onlineSince = time.Time{}
	}
	r.lostAt = now
	wait := linkBackoff(n)
	why := "connection lost"
	if p := st.pingFailed.Load(); p != nil {
		why += ": " + *p
	} else if st.err != nil {
		why += ": " + st.err.Error()
	}
	if cl := st.closed.Load(); cl != nil {
		why = fmt.Sprintf("closed by the gateway: %s %q", cl.GetCode(), cl.GetMessage())
		switch cl.GetCode() {
		case linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED:
			s.client.forget(st.token)
		case linkpb.CloseCode_CLOSE_CODE_UPGRADE_REQUIRED:
			wait = linkLongWaitJittered()
		}
		wait = max(wait, time.Duration(cl.GetRetryAfterMs())*time.Millisecond)
	}
	s.noteErr(errors.New(why))
	s.log(fmt.Sprintf("link shadow: connection %s ended (%s); reconnecting in %s", st.id, why, wait.Round(time.Millisecond)))
	return wait
}

// failed records a connection attempt that failed, logging it unless the same failure was logged lately.
func (s *linkShadow) failed(err error, wait time.Duration) {
	s.run.dialFailures++
	s.noteErr(err)
	msg := err.Error()
	now := s.now()
	if msg == s.run.loggedErr && now.Sub(s.run.loggedErrAt) < linkShadowLogQuiet {
		return
	}
	s.run.loggedErr, s.run.loggedErrAt = msg, now
	if linkNotConfigured(err) {
		s.log(fmt.Sprintf("link shadow: the server has no runner link (%s); asking again in %s", msg, wait.Round(time.Second)))
		return
	}
	s.log(fmt.Sprintf("link shadow: cannot connect (%s); next try in %s", msg, wait.Round(time.Millisecond)))
}

func (s *linkShadow) noteErr(err error) {
	s.mu.Lock()
	s.lastErr, s.errAt = err.Error(), s.now()
	s.mu.Unlock()
}

// finish is the shadow's end: within linkShadowStopWait, it sends what is queued on cur, waits for the gateway to
// answer it and closes cur; what is left is dropped as stopped. The summary says the rest.
func (s *linkShadow) finish(cur *linkShadowConn) {
	deadline := s.now().Add(linkShadowStopWait / 2)
	if cur != nil {
	sending:
		for s.now().Before(deadline) {
			select {
			case m := <-s.queue:
				s.send(cur, m)
			case <-cur.done:
				break sending
			default:
				break sending
			}
		}
		s.settle(cur, deadline)
		cur.close(websocket.StatusGoingAway, "runner stopping")
		if !s.run.onlineSince.IsZero() {
			s.run.onlineFor += s.now().Sub(s.run.onlineSince)
			s.run.onlineSince = time.Time{}
		}
	}
	for {
		select {
		case m := <-s.queue:
			s.queuedBytes.Add(-m.size)
			s.counts[m.kind].dropped[linkDropStopped].Add(1)
		default:
			s.logSummary(nil, true)
			return
		}
	}
}

// linkShadowSummary is the "link shadow summary" line. Counts are since the shadow started; rttMs and
// reconnectGapsMs are since the previous summary.
type linkShadowSummary struct {
	Process         string                       `json:"process"`
	Version         string                       `json:"version"`
	State           string                       `json:"state"`
	Connection      string                       `json:"connection,omitempty"`
	Link            string                       `json:"link,omitempty"`
	UptimeS         float64                      `json:"uptimeS"`
	OnlineS         float64                      `json:"onlineS"`
	Connects        int                          `json:"connects"`
	Reconnects      int                          `json:"reconnects"`
	Renewals        int                          `json:"renewals"`
	Drains          int                          `json:"drains"`
	DialFailures    int                          `json:"dialFailures"`
	ReconnectGapsMs []int64                      `json:"reconnectGapsMs"`
	MaxReconnectMs  int64                        `json:"maxReconnectGapMs"`
	RTTMs           *linkShadowRTTSummary        `json:"rttMs,omitempty"`
	Mirrors         map[string]linkMirrorSummary `json:"mirrors"`
	Answered        int64                        `json:"answered"`
	HeartbeatAcks   int64                        `json:"heartbeatAcks"`
	Queued          int                          `json:"queued"`
	QueuedBytes     int64                        `json:"queuedBytes"`
	TapPanics       int64                        `json:"tapPanics,omitempty"`
	LastError       string                       `json:"lastError,omitempty"`
	LastErrorAt     string                       `json:"lastErrorAt,omitempty"`
	Goroutines      int                          `json:"goroutines"`
	HeapBytes       uint64                       `json:"heapBytes"`
	Final           bool                         `json:"final,omitempty"`
}

type linkShadowRTTSummary struct {
	Last    float64 `json:"last"`
	Min     float64 `json:"min"`
	Avg     float64 `json:"avg"`
	Max     float64 `json:"max"`
	Samples int     `json:"samples"`
}

type linkMirrorSummary struct {
	Sent    int64            `json:"sent"`
	Dropped map[string]int64 `json:"dropped"`
}

// summary sums the shadow up, and starts the next summary's RTT and gaps afresh.
func (s *linkShadow) summary(cur *linkShadowConn, final bool) linkShadowSummary {
	now := s.now()
	r := &s.run
	online := r.onlineFor
	if !r.onlineSince.IsZero() {
		online += now.Sub(r.onlineSince)
	}
	out := linkShadowSummary{
		Process: s.client.processID, Version: version, State: "offline", Link: r.link,
		UptimeS: linkSeconds(now.Sub(s.started)), OnlineS: linkSeconds(online),
		Connects: r.connects, Reconnects: r.reconnects, Renewals: r.renewals, Drains: r.drained, DialFailures: r.dialFailures,
		ReconnectGapsMs: []int64{}, MaxReconnectMs: r.maxGap.Milliseconds(),
		Mirrors:  map[string]linkMirrorSummary{},
		Answered: s.answered.Load(), HeartbeatAcks: s.acks.Load(),
		Queued: len(s.queue), QueuedBytes: s.queuedBytes.Load(), TapPanics: s.tapPanics.Load(),
		Goroutines: runtime.NumGoroutine(), HeapBytes: linkHeapBytes(), Final: final,
	}
	if cur != nil {
		out.State, out.Connection = "connected", cur.id
	}
	for _, gap := range r.gaps {
		out.ReconnectGapsMs = append(out.ReconnectGapsMs, gap.Milliseconds())
	}
	r.gaps = nil
	for kind, counts := range s.counts {
		m := linkMirrorSummary{Sent: counts.sent.Load(), Dropped: map[string]int64{}}
		for reason := range linkDropReasons {
			if n := counts.dropped[reason].Load(); n > 0 {
				m.Dropped[linkDropReasonNames[reason]] = n
			}
		}
		out.Mirrors[kind] = m
	}
	s.mu.Lock()
	if rtt := s.rtt; rtt.n > 0 {
		out.RTTMs = &linkShadowRTTSummary{Last: linkMillis(rtt.last), Min: linkMillis(rtt.min), Max: linkMillis(rtt.max),
			Avg: linkMillis(rtt.sum / time.Duration(rtt.n)), Samples: rtt.n}
	}
	s.rtt = linkRTT{}
	out.LastError = s.lastErr
	if !s.errAt.IsZero() {
		out.LastErrorAt = s.errAt.UTC().Format(time.RFC3339)
	}
	s.mu.Unlock()
	return out
}

func (s *linkShadow) logSummary(cur *linkShadowConn, final bool) {
	b, err := json.Marshal(s.summary(cur, final))
	if err != nil {
		return
	}
	s.log("link shadow summary " + string(b))
}

func linkSeconds(d time.Duration) float64 { return float64(d.Milliseconds()) / 1000 }
func linkMillis(d time.Duration) float64  { return float64(d.Microseconds()) / 1000 }

// linkHeapBytes is the bytes of the process's live and unswept heap objects, read without stopping the world.
func linkHeapBytes() uint64 {
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(sample)
	if sample[0].Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return sample[0].Value.Uint64()
}
