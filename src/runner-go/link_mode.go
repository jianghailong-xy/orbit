package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"orbit/linkpb"
)

// The runner link's work path (docs/runner-link-design.md §5.6, §7, decision D15). The daemon starts on HTTPS, as every
// runner always has, and moves its work to the link only when the control plane asks for that:
//
//   - an HTTPS call to a daemon route answered UPGRADE_REQUIRED (the server's RUNNER_LINK_REQUIRED switch, task D0); or
//   - a Welcome or HeartbeatAck saying MODE_LINK, on the work connection or on the shadow's (link_shadow.go).
//
// It goes back to HTTPS when one of them says MODE_HTTP. While nothing has asked, the link is not in use: doVia runs
// doHTTP exactly as before, and no work connection is opened. ORBIT_LINK_MODE=off, or "linkMode": "off" in
// config.json, keeps it that way whatever the control plane says.
//
// In link mode every call to a daemon route (linkDaemonRoutes: the routes of the apiserver's RunnerApiController that
// take the runner credential) goes over the work connection (link_work.go), as an Rpc carrying the HTTP request
// (TunnelRequest), and its answer comes back as the HTTP answer would. The heartbeat is the exception: it travels as a
// Heartbeat frame whose parts are sent by digest (link_heartbeat.go). Every other call, the agent tool API, the
// release check and the attachments, stays on HTTPS (D14). Each call has one request_id, which every resend of it
// keeps: after a lost connection or a failure that says the call can be sent again, it is sent again under that id,
// and the control plane answers a repeated claim with the session the first one claimed (task B2).
//
// The long polls do not hang on the server in link mode (§5.6): a claim, an inbox fetch or the wake is asked only
// once a hint says something waits, or the HeartbeatAck's HintState does (link_hints.go).

const (
	// linkModeEnv set to off (or 0, false, no) keeps every daemon call on HTTPS, whatever the control plane says. So
	// does "linkMode": "off" in config.json. Anything else follows the control plane.
	linkModeEnv = "ORBIT_LINK_MODE"
	// linkAfterSeqPending is the control plane's answer to a call whose after_seq is not stored yet
	// (runner-link-call.ts): 503, retryable, with the delay to send it again after.
	linkAfterSeqPending = "RUNNER_LINK_AFTER_SEQ_PENDING"
	// linkMaxRequestBytes is the largest request body a call carries over the link: what one frame may be once its
	// Chunks are joined (8 MiB, the gateway's bound as this binary's), less room for the rest of the Rpc. A larger
	// frame is a protocol error that ends the connection, and the call would end the next one too when it is sent
	// again, so it is refused before it is sent.
	linkMaxRequestBytes = linkMaxJoinedFrameBytes - 4<<10
)

// Variables only so that tests can shorten them.
var (
	// linkLongPoll is how long a long poll waits for its hint in link mode before it answers that nothing came: the
	// window of the HTTP long polls (LONG_POLL_MS in runner-api.controller.ts), so their callers keep their pace.
	linkLongPoll = 25 * time.Second
	// linkApprovalRecheck is how often a pending approval is read again in link mode while no ApprovalHint says it
	// was decided: the heartbeat's interval. The hint comes milliseconds after the decision commits, a lost one is
	// made good by the next HeartbeatAck's HintState, and a new connection asks again; this covers what HintState
	// cannot name (a card with no turn, tool call or job, or past its cap of 1000).
	linkApprovalRecheck = 30 * time.Second
	// linkAfterSeqWait bounds how long a call waits for the events it depends on (after_seq) to be stored. Past it,
	// the call depends only on what the control plane has acknowledged storing: an event batch the session gave up
	// on is never stored, and a turn completion must not wait for it forever.
	linkAfterSeqWait = 30 * time.Second
)

// errLinkModeHTTP is the link refusing a call because the control plane said MODE_HTTP: the call reached no backend,
// and goes over HTTPS.
var errLinkModeHTTP = errors.New("the runner link is in MODE_HTTP: daemon calls go over HTTPS")

// linkModeOff reports whether the link mode is turned off on this machine, and what turned it off.
func linkModeOff(cfg *RunnerConfig) (bool, string) {
	if v, ok := os.LookupEnv(linkModeEnv); ok {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "off", "0", "false", "no":
			return true, linkModeEnv + "=" + v
		}
	}
	if cfg != nil && strings.EqualFold(strings.TrimSpace(cfg.LinkMode), "off") {
		return true, `"linkMode": "off" in ` + configPath()
	}
	return false, ""
}

// startLink makes t the daemon's transport and gives it the runner link: the link mode, unless it is turned off, and
// the shadow (link_shadow.go). The daemon's transport names no caller (runnerCallerHeader). Called once, before
// anything sends on t; the func it returns ends both.
func startLink(cfg *RunnerConfig, t *Transport) func() {
	t.caller = ""
	if off, why := linkModeOff(cfg); off {
		logln("runner link mode: off (" + why + "); daemon calls stay on HTTPS")
	} else {
		t.link = newLinkMode(t, logln)
	}
	stopShadow := startLinkShadow(cfg, t)
	return func() {
		stopShadow()
		if t.link != nil {
			t.link.close()
		}
	}
}

// linkMode is the link mode of the daemon's transport t: where the control plane says its work goes, the work
// connection, the hints its long polls wait on, and what each session's resume needs.
type linkMode struct {
	t      *Transport
	log    func(...any)
	work   *linkWork
	gates  *linkGates
	events *linkEvents // the sessions' durable and live event streams over the link (link_events.go)

	mu sync.Mutex
	// server is the transport the control plane last said the daemon's work goes over, in a Welcome or a HeartbeatAck
	// of the work connection or the shadow's; MODE_UNSPECIFIED until one says.
	server linkpb.Mode
	// refused is set by an HTTPS daemon call answered UPGRADE_REQUIRED and cleared by MODE_HTTP: while it is set, the
	// work waits for the link rather than going back to HTTPS.
	refused bool
	why     string // what put the link in use, for the log
	closed  bool
	// changed is closed, and replaced, whenever whether the link is in use changes: the shadow waits on it.
	changed chan struct{}

	sessions   map[string]*linkSession // by the session id as the daemon names it
	supervised []string                // the sessions the newest heartbeat named
	// selfUpdateOwed is set when the link asks this runner to check its release now: a newly assigned release, or a
	// gateway that speaks no protocol version this binary does. The next heartbeat's answer carries the request.
	selfUpdateOwed atomic.Bool
	requestSeq     atomic.Uint64
}

// linkSession is what the link knows of one session the daemon supervises: what a Hello resumes it from (§5.4) and the
// seq a call depending on its events waits for (after_seq).
type linkSession struct {
	// sent is the highest event seq handed to the control plane for the session, stored or not; stored, the highest
	// it acknowledged storing. sentRow and storedRow are the same of the events it stores as rows (linkRowEvent).
	sent, stored       uint64
	sentRow, storedRow uint64
	// turn is the message or shell turn the inbox handed this process that no turn completion has ended yet.
	turn    string
	touched time.Time
}

func newLinkMode(t *Transport, log func(...any)) *linkMode {
	m := &linkMode{t: t, log: log, gates: newLinkGates(), changed: make(chan struct{}), sessions: map[string]*linkSession{}}
	m.work = newLinkWork(m, newLinkClient(t.baseURL, t.token, t.leaseOwner, m.hello), log)
	m.events = newLinkEvents(m, log)
	return m
}

// inUse reports whether the daemon's work goes over the link now: the control plane asked for it, and nothing has
// sent it back to HTTPS since.
func (m *linkMode) inUse() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.inUseLocked()
}

func (m *linkMode) inUseLocked() bool {
	return !m.closed && (m.server == linkpb.Mode_MODE_LINK || m.refused)
}

// standDown is the shadow's question (link_shadow.go): whether it must hold no connection now, because the work
// connection holds the process's one, and the channel closed when that may change.
func (m *linkMode) standDown() (bool, <-chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.inUseLocked(), m.changed
}

// observe takes a mode the control plane stated, in a Welcome or a HeartbeatAck, and what said it.
func (m *linkMode) observe(mode linkpb.Mode, source string) {
	if mode == linkpb.Mode_MODE_UNSPECIFIED {
		return // not stated: the runner keeps the transport it is using
	}
	m.mu.Lock()
	if m.server == mode && (mode == linkpb.Mode_MODE_LINK || !m.refused) {
		m.mu.Unlock()
		return
	}
	m.server = mode
	if mode == linkpb.Mode_MODE_HTTP {
		m.refused = false
	} else {
		m.why = source + " said MODE_LINK"
	}
	m.updateLocked(source + " said MODE_HTTP")
	m.mu.Unlock()
}

// upgradeRequired takes an HTTPS daemon call answered UPGRADE_REQUIRED: the control plane serves daemon routes only
// over the link now.
func (m *linkMode) upgradeRequired(call string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refused {
		return
	}
	m.refused = true
	m.why = "the control plane answered " + call + " with UPGRADE_REQUIRED"
	m.updateLocked("")
}

// linkUnusable sends the work back to HTTPS because the link cannot carry it, unless the control plane refused HTTPS:
// then the work waits for the link, since nothing else would carry it either.
func (m *linkMode) linkUnusable(why string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refused || m.server != linkpb.Mode_MODE_LINK {
		return
	}
	m.server = linkpb.Mode_MODE_UNSPECIFIED
	m.updateLocked(why)
}

// updateLocked starts or stops the work connection as the link comes into use or goes out of it, and tells whoever
// waits on the change. off says why it goes out of use.
func (m *linkMode) updateLocked(off string) {
	use := m.inUseLocked()
	m.events.setOnLink(use)
	if use == m.work.running() {
		return
	}
	close(m.changed)
	m.changed = make(chan struct{})
	if use {
		m.log("runner link mode: on — " + m.why + "; daemon calls go over the runner link as process " + m.t.leaseOwner)
		m.work.start()
		return
	}
	if m.closed {
		m.log("runner link mode: off — the runner is stopping")
	} else {
		m.log("runner link mode: off — " + off + "; daemon calls go over HTTPS")
	}
	m.work.stop()
	// A release the link assigned is the link's: the release check asks over HTTPS again.
	setLinkAssignedRelease(nil)
}

// close ends the link mode with the runner. What the sessions' event streams still hold is kept in the spool for the
// next process (link_events.go).
func (m *linkMode) close() {
	m.mu.Lock()
	m.closed = true
	m.updateLocked("")
	m.mu.Unlock()
	m.work.wait(5 * time.Second)
	m.events.close()
}

// doVia is a call of the daemon's transport (Transport.doVia). A call to a daemon route goes over the link while the
// link is in use; any other call, and every call while it is not, goes over HTTPS (viaHTTP). An HTTPS daemon call
// answered UPGRADE_REQUIRED puts the link in use and is made again over it, within the same timeout.
func (m *linkMode) doVia(ctx context.Context, method, path string, body, out interface{}, timeout time.Duration,
	headers map[string]string, viaHTTP func(context.Context) error) error {
	route, daemon := linkDaemonRoute(method, path)
	if !daemon {
		return viaHTTP(ctx)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if m.inUse() {
		err := m.call(cctx, route, method, path, body, out, headers)
		if errors.Is(err, errLinkModeHTTP) && !m.inUse() {
			return viaHTTP(cctx)
		}
		return err
	}
	err := viaHTTP(cctx)
	if !linkUpgradeRequired(err) {
		return err
	}
	m.upgradeRequired(method + " " + strings.SplitN(path, "?", 2)[0])
	if !m.inUse() {
		return err
	}
	lerr := m.call(cctx, route, method, path, body, out, headers)
	if !linkUnreachable(lerr) {
		return lerr
	}
	// Neither way is open yet. Said as a failure of the network, not as the 426: a caller retries that, while the 426
	// reads as permanent, and stopping the runner is not the answer to a link that is still coming up.
	return fmt.Errorf("the control plane serves %s %s only over the runner link, which is not connected yet: %w",
		method, strings.SplitN(path, "?", 2)[0], lerr)
}

// linkUpgradeRequired reports whether err is a daemon route refusing HTTPS because the control plane serves it only
// over the link now (task D0): 426, or a body whose code is UPGRADE_REQUIRED.
func linkUpgradeRequired(err error) bool {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.statusCode == http.StatusUpgradeRequired || httpErr.code() == "UPGRADE_REQUIRED"
}

// linkAnswerTooLarge reports whether err is the gateway refusing to relay an answer larger than one frame may be once
// joined (BACKEND_ANSWER_TOO_LARGE): the same call asking for less may be answered.
func linkAnswerTooLarge(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.code() == "BACKEND_ANSWER_TOO_LARGE"
}

// linkUnreachable reports whether err says the link did not carry the call at all: no connection came up in time, or
// it was refused for MODE_HTTP.
func linkUnreachable(err error) bool {
	return errors.Is(err, errLinkModeHTTP) || errors.Is(err, errLinkNotConnected)
}

// call makes one daemon call over the link and reads its answer as doHTTP reads an HTTPS answer: a 2xx body into out,
// any other status as a *transportHTTPError.
func (m *linkMode) call(ctx context.Context, route, method, path string, body, out interface{}, headers map[string]string) error {
	if len(headers) > 0 {
		names := make([]string, 0, len(headers))
		for k := range headers {
			names = append(names, k)
		}
		sort.Strings(names)
		return fmt.Errorf("%s %s carries request headers (%s), which the runner link cannot carry", method, path, strings.Join(names, ", "))
	}
	if route == linkRouteHeartbeat {
		return m.heartbeat(ctx, body, out)
	}
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = b
	}
	if len(payload) > linkMaxRequestBytes {
		refusal, _ := json.Marshal(map[string]any{"code": "RUNNER_LINK_REQUEST_TOO_LARGE", "retryable": false,
			"message": fmt.Sprintf("a %d-byte request is more than the runner link carries in one call (%d bytes)", len(payload), linkMaxRequestBytes)})
		return &transportHTTPError{method: method, path: path, statusCode: http.StatusRequestEntityTooLarge, body: string(refusal)}
	}
	rpc := &linkpb.Rpc{RequestId: m.newRequestID(), Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{
		Method: method, Path: path, JsonBody: payload,
	}}}
	var session string
	if route == linkRouteTurnComplete {
		// A turn completion is handled once the session's events it follows are stored (§5.6): its delivery receipt
		// among them. Whatever of them the session's event stream still holds goes at once.
		session = linkPathSegment(path, 2)
		if after := m.afterSeq(session); after > 0 {
			rpc.SessionId, rpc.AfterSeq = session, after
		}
		m.events.hurry(session)
	}
	var pendingSince time.Time
	lowered := false
	for {
		resp, err := m.work.rpc(ctx, rpc)
		if err != nil {
			return err
		}
		if rpc.GetAfterSeq() > 0 && resp.GetStatus() == http.StatusServiceUnavailable && linkAnswerCode(resp.GetJsonBody()) == linkAfterSeqPending {
			now := time.Now()
			if pendingSince.IsZero() {
				pendingSince = now
			}
			if now.Sub(pendingSince) >= linkAfterSeqWait {
				// First it depends only on the events the control plane acknowledged storing; should even those not
				// satisfy it after another wait, on none.
				after := uint64(0)
				if !lowered {
					after = min(rpc.GetAfterSeq(), m.storedRowSeq(session))
				}
				m.log(fmt.Sprintf("runner link: %s %s waited %s for the session's events through seq %d; it now depends only on those the control plane acknowledged storing, through seq %d",
					method, path, linkAfterSeqWait, rpc.GetAfterSeq(), after))
				rpc.AfterSeq, lowered, pendingSince = after, true, now
				if after == 0 {
					rpc.SessionId = ""
				}
			}
			wait := time.Duration(resp.GetRetryAfterMs()) * time.Millisecond
			if wait <= 0 {
				wait = 250 * time.Millisecond
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
			continue
		}
		status := int(resp.GetStatus())
		if status < 200 || status >= 300 {
			return &transportHTTPError{method: method, path: path, statusCode: status, body: string(resp.GetJsonBody()),
				retryAfter: linkRetryAfterHeader(resp.GetRetryAfterMs())}
		}
		if out != nil && len(resp.GetJsonBody()) > 0 {
			return json.Unmarshal(resp.GetJsonBody(), out)
		}
		return nil
	}
}

// newRequestID is a request_id no other call of this runner has (proto Rpc.request_id): the process, which is unique
// to this runner, and a count.
func (m *linkMode) newRequestID() string {
	return "r:" + m.t.leaseOwner + ":" + strconv.FormatUint(m.requestSeq.Add(1), 10)
}

// linkAnswerCode is an error answer's code, read from its JSON body.
func linkAnswerCode(body []byte) string {
	var b struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &b)
	return b.Code
}

// linkRetryAfterHeader is a TunnelResponse's retry_after_ms as an HTTP Retry-After would carry it, in whole seconds
// rounded up: what transportHTTPError.retryAfter holds for an HTTPS answer.
func linkRetryAfterHeader(ms uint32) string {
	if ms == 0 {
		return ""
	}
	return strconv.FormatUint((uint64(ms)+999)/1000, 10)
}

// ── What the link knows of each session ─────────────────────────────────────────────────────────

// session is the state of id, made when absent.
func (m *linkMode) sessionLocked(id string) *linkSession {
	s := m.sessions[id]
	if s == nil {
		s = &linkSession{}
		m.sessions[id] = s
	}
	s.touched = time.Now()
	return s
}

// sentEvents records events handed to the control plane for a session, before the request goes.
func (m *linkMode) sentEvents(sessionID string, events []RunEvent) {
	if len(events) == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessionLocked(sessionID)
	for _, e := range events {
		if e.Seq > 0 {
			s.sent = max(s.sent, uint64(e.Seq))
			if linkRowEvent(e.Type, e.Payload) {
				s.sentRow = max(s.sentRow, uint64(e.Seq))
			}
		}
	}
}

// storedEvents records events the control plane acknowledged storing.
func (m *linkMode) storedEvents(sessionID string, events []RunEvent) {
	if len(events) == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessionLocked(sessionID)
	for _, e := range events {
		if e.Seq > 0 {
			s.stored = max(s.stored, uint64(e.Seq))
			if linkRowEvent(e.Type, e.Payload) {
				s.storedRow = max(s.storedRow, uint64(e.Seq))
			}
		}
	}
}

// handedTurn records a turn the inbox handed this process: a message or shell turn is what it executes until the
// turn's completion.
func (m *linkMode) handedTurn(sessionID string, r *RunInboxResponse) {
	if r == nil || r.TurnID == "" || (r.Kind != "message" && r.Kind != "shell") {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessionLocked(sessionID).turn = r.TurnID
}

// turnDone records a turn completion the control plane took.
func (m *linkMode) turnDone(sessionID, turnID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[sessionID]; s != nil && (s.turn == turnID || turnID == "") {
		s.turn = ""
	}
}

// supervising records the sessions a heartbeat names: those a Hello resumes. A session no beat names any more is
// forgotten once it has also gone untouched for a while.
func (m *linkMode) supervising(ids []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.supervised = append([]string(nil), ids...)
	named := make(map[string]bool, len(ids))
	for _, id := range ids {
		named[id] = true
	}
	for id, s := range m.sessions {
		if !named[id] && time.Since(s.touched) > 2*time.Minute {
			delete(m.sessions, id)
		}
	}
	m.gates.keepInbox(ids)
}

// afterSeq is what a call depending on a session's events waits for (after_seq): the highest seq handed to the control
// plane, over HTTPS or to its event stream on the link, of an event it stores as a row. The control plane counts a
// call's events stored once a row holds a seq at or past after_seq (assertAfterSeqStored, runner-link-call.ts); a
// live event or a bare ping is stored as nothing, and a call that waited for one would wait for ever. storedRowSeq is
// the highest of those it acknowledged storing.
func (m *linkMode) afterSeq(sessionID string) uint64 {
	handed, _ := m.events.rowSeqs(sessionID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[sessionID]; s != nil {
		return max(s.sentRow, handed)
	}
	return handed
}

func (m *linkMode) storedRowSeq(sessionID string) uint64 {
	_, stored := m.events.rowSeqs(sessionID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[sessionID]; s != nil {
		return max(s.storedRow, stored)
	}
	return stored
}

// resumeStates is Hello.sessions (§5.4): every session the newest heartbeat named, every other one the link holds
// state of, and every one whose event stream holds events, so that the Welcome says how far each is stored. Each comes
// with the last event seq handed over for it and the turn this process is executing in it.
func (m *linkMode) resumeStates() []*linkpb.SessionResume {
	held := m.events.held()
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make(map[string]bool, len(m.supervised)+len(m.sessions)+len(held))
	for _, id := range m.supervised {
		ids[id] = true
	}
	for id := range m.sessions {
		ids[id] = true
	}
	for id := range held {
		ids[id] = true
	}
	out := make([]*linkpb.SessionResume, 0, len(ids))
	for id := range ids {
		r := &linkpb.SessionResume{SessionId: id, LastSeq: held[id]}
		if s := m.sessions[id]; s != nil {
			r.LastSeq, r.TurnId = max(s.sent, held[id]), s.turn
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SessionId < out[j].SessionId })
	return out
}

// hello is the work connection's Hello: the process's, as every HTTPS request declares it, and where each of its
// sessions stands.
func (m *linkMode) hello() *linkpb.Hello {
	h := linkHello(m.t.leaseOwner)
	h.Sessions = m.resumeStates()
	return h
}

// afterHeartbeat adds to a heartbeat's answer what the link owes it: a release check now, when the link assigned a
// release this runner does not run or a gateway speaks no protocol version it does.
func (m *linkMode) afterHeartbeat(resp *HeartbeatResponse) {
	if resp != nil && m.selfUpdateOwed.Swap(false) {
		resp.CheckSelfUpdate = true
	}
}

// assignRelease takes the release a Welcome or HeartbeatAck assigns this runner (§7): the release check installs it,
// from /dl as ever (selfupdate.go), and checks now when it is one this runner does not run.
func (m *linkMode) assignRelease(r *linkpb.AssignedRelease) {
	var a *releaseAssignment
	if r.GetVersion() != "" {
		a = &releaseAssignment{Version: r.GetVersion(), Rollback: r.GetRollback()}
	}
	if !setLinkAssignedRelease(a) || a == nil {
		return
	}
	if a.Version != version && (isNewer(a.Version, version) || a.Rollback) {
		m.log(fmt.Sprintf("runner link: the control plane assigns release %s (rollback %v) to this runner, which runs %s; checking it now",
			a.Version, a.Rollback, version))
		m.selfUpdateOwed.Store(true)
		m.gates.markWake()
	}
}

// ── The daemon routes ───────────────────────────────────────────────────────────────────────────

// The routes whose answers the link reads itself.
const (
	linkRouteHeartbeat    = "POST /runner/heartbeat"
	linkRouteTurnComplete = "POST /runner/sessions/:id/turn-complete"
)

// linkDaemonRoutes are the daemon routes: the routes of the apiserver's RunnerApiController that take the runner
// credential (@UseGuards(RunnerAuthGuard)), which the link gateway forwards and its internal listener serves
// (runner-auth.guard.ts admitLinkCall). TestLinkDaemonRoutesAreTheControllersGuardedRoutes holds this list to the
// controller. Registration and the device flow come before any link, and every other controller under /runner is the
// agent tool API, which stays on HTTPS (D14). The attachments' two routes are listed because the controller serves
// them, but their calls never pass doVia: they are multipart and raw bytes, and stay on HTTPS.
var linkDaemonRoutes = []string{
	"GET /runner/me",
	"POST /runner/deregister",
	linkRouteHeartbeat,
	"POST /runner/integration-jobs/:id/progress",
	"POST /runner/integration-jobs/:id/output",
	"POST /runner/integration-jobs/:id/release",
	"POST /runner/integration-jobs/:id/result",
	"POST /runner/wiki/repo-ops/:id/progress",
	"POST /runner/wiki/repo-ops/:id/fragments",
	"POST /runner/wiki/repo-ops/:id/result",
	"POST /runner/codex-rate-limit-reset-result",
	"POST /runner/repo-cleanup-result",
	"POST /runner/claude-history-result",
	"POST /runner/install-result",
	"POST /runner/codex-account-remove-result",
	"POST /runner/account-remove-result",
	"POST /runner/login-result",
	"GET /runner/sessions/claim",
	"GET /runner/wake",
	"GET /runner/sessions/reclaim",
	"POST /runner/sessions/:id/source/pin",
	"POST /runner/sessions/:id/takeover-leases",
	"POST /runner/sessions/:id/activate-leases",
	"POST /runner/sessions/:id/release-leases",
	"POST /runner/sessions/:id/orchestration-credential",
	"GET /runner/sessions/:id/inbox",
	"GET /runner/sessions/:id/attachments/:id",
	"POST /runner/sessions/:id/attachments",
	"POST /runner/sessions/:id/artifacts/result",
	"POST /runner/sessions/:id/approvals",
	"GET /runner/sessions/:id/approvals/:id",
	"POST /runner/sessions/:id/background-wake",
	"POST /runner/sessions/:id/scheduled-wakeup",
	"POST /runner/sessions/:id/naming",
	"POST /runner/sessions/:id/turns/:id/suggestion",
	linkRouteTurnComplete,
	"POST /runner/sessions/:id/events",
	"POST /runner/sessions/:id/finalize",
	"POST /runner/sessions/:id/complete",
	"POST /runner/sessions/:id/import-result",
	"POST /runner/sessions/worktrees-removable",
	"POST /runner/sessions/:id/merge-result",
	"POST /runner/sessions/:id/commit-result",
	"POST /runner/sessions/:id/diff",
	"GET /runner/sessions/:id/meta",
	"GET /runner/sessions/:id/events",
}

// linkRouteTable is linkDaemonRoutes by method and segment count.
var linkRouteTable = func() map[string][][]string {
	table := map[string][][]string{}
	for _, route := range linkDaemonRoutes {
		method, path, _ := strings.Cut(route, " ")
		segments := strings.Split(strings.TrimPrefix(path, "/"), "/")
		key := method + " " + strconv.Itoa(len(segments))
		table[key] = append(table[key], segments)
	}
	return table
}()

// linkDaemonRoute is the daemon route a call's method and path (with or without its query) name, and whether they name
// one. A literal segment is preferred to a parameter, as the controller's router does (sessions/claim is not a
// session's id).
func linkDaemonRoute(method, path string) (string, bool) {
	path, _, _ = strings.Cut(path, "?")
	segments := strings.Split(strings.TrimPrefix(path, "/"), "/")
	best, bestLiterals := "", -1
	for _, pattern := range linkRouteTable[method+" "+strconv.Itoa(len(segments))] {
		literals, ok := 0, true
		for i, seg := range pattern {
			if seg == ":id" {
				if segments[i] == "" {
					ok = false
					break
				}
				continue
			}
			if seg != segments[i] {
				ok = false
				break
			}
			literals++
		}
		if ok && literals > bestLiterals {
			best, bestLiterals = method+" /"+strings.Join(pattern, "/"), literals
		}
	}
	return best, bestLiterals >= 0
}

// linkPathSegment is segment i of a path, without its query: 2 is the session of /runner/sessions/<id>/....
func linkPathSegment(path string, i int) string {
	path, _, _ = strings.Cut(path, "?")
	segments := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if i < len(segments) {
		return segments[i]
	}
	return ""
}
