package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"orbit/linkpb"
)

// The runner link's work path (docs/runner-link-design.md §5.6, §7). The link is the one way the daemon's work goes. It
// is in use from the moment the daemon's transport has it (startLink), whatever a gateway or the control plane says.
//
// Every call to a daemon route (linkDaemonRoutes: the routes of the apiserver's RunnerApiController that take the runner
// credential) goes over the work connection (link_work.go), as an Rpc carrying the HTTP request (TunnelRequest), and its
// answer comes back as the HTTP answer would. The heartbeat is the exception: it travels as a Heartbeat frame whose
// parts are sent by digest (link_heartbeat.go). Every other call, the agent tool API, the release check and the
// attachments, stays on HTTPS (D14). Each call has one request_id, which every resend of it keeps: after a lost
// connection or a failure that says the call can be sent again, it is sent again under that id, and the control plane
// answers a repeated claim with the session the first one claimed (task B2), and a repeated inbox fetch with the turn
// the first one handed out (task B2b). A claim or an inbox fetch that got no answer at all is followed by one under the
// same id, however much later, until one gets an answer (linkRequestIDs).
//
// Nothing hangs on the server (§5.6): a claim, an inbox fetch or the wake is asked only once a hint says something
// waits, or the HeartbeatAck's HintState does (link_hints.go); a session's inbox poller decides when its own fetches go
// (inbox_poller.go). Every inbox fetch says which turn this process is running in the session (runningTurnId).

const (
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
	// linkHintWait is how long a claim, an inbox poller or the wake waits for its hint before it looks again: the claim
	// loop answers that nothing came and goes round, so that it keeps its pace, and the others just go on waiting.
	linkHintWait = 25 * time.Second
	// linkApprovalRecheck is how often a pending approval is read again while no ApprovalHint says it was decided: the
	// heartbeat's interval. The hint comes milliseconds after the decision commits, a lost one is made good by the next
	// HeartbeatAck's HintState, and a new connection asks again; this covers what HintState cannot name (a card with no
	// turn, tool call or job, or past its cap of 1000).
	linkApprovalRecheck = 30 * time.Second
	// linkAfterSeqWait bounds how long a call waits for the events it depends on (after_seq) to be stored. Past it,
	// the call depends only on what the control plane has acknowledged storing: an event batch the session gave up
	// on is never stored, and a turn completion must not wait for it forever.
	linkAfterSeqWait = 30 * time.Second
)

// errLinkGatewayModeHTTP is a gateway that says MODE_HTTP, in a Welcome or a HeartbeatAck: it forwards nothing, because
// its server's RUNNER_LINK_REQUIRED is off, or it has not read that yet. An older server's: this one's always say
// MODE_LINK. Nothing else carries the work, so the runner keeps asking.
var errLinkGatewayModeHTTP = errors.New("the gateway says MODE_HTTP, so it forwards nothing: this runner works only over the runner link, which its server must have switched on")

// startLink makes t the daemon's transport and gives it the runner link, which carries the daemon's work from now on.
// The daemon's transport names no caller (runnerCallerHeader). Called once, before anything sends on t; the func it
// returns ends the link.
func startLink(t *Transport) func() {
	t.caller = ""
	t.link = newLinkMode(t, logln)
	t.link.start()
	return t.link.close
}

// linkCloseWait is how long a stopping runner waits for the link's connection to end, past the stop's envelope.
const linkCloseWait = 5 * time.Second

// linkMode is the link of the daemon's transport t: the work connection, the hints its waits are ended by, and what
// each session's resume needs.
type linkMode struct {
	t      *Transport
	log    func(...any)
	work   *linkWork
	gates  *linkGates
	events *linkEvents // the sessions' durable and live event streams over the link (link_events.go)

	mu         sync.Mutex
	sessions   map[string]*linkSession // by the session id as the daemon names it
	supervised []string                // the sessions the newest heartbeat named
	// selfUpdateOwed is set when the link asks this runner to check its release now: a newly assigned release, or a
	// gateway that speaks no protocol version this binary does. The next heartbeat's answer carries the request.
	selfUpdateOwed atomic.Bool
	requestSeq     atomic.Uint64
}

// linkSession is what the link knows of one session the daemon supervises, beside its event stream: what a Hello resumes
// it with (§5.4).
type linkSession struct {
	// turn is the message or shell turn the inbox handed this process that no turn completion, and no end of the
	// engine generation it was handed to, has ended yet: what a Hello resumes the session with, and what every inbox
	// fetch over the link says this process is running (runningTurnId).
	turn    string
	touched time.Time
}

func newLinkMode(t *Transport, log func(...any)) *linkMode {
	m := &linkMode{t: t, log: log, gates: newLinkGates(), sessions: map[string]*linkSession{}}
	m.work = newLinkWork(m, newLinkClient(t.baseURL, t.token, t.leaseOwner, m.hello), log)
	m.events = newLinkEvents(m, log)
	return m
}

// start opens the work connection.
func (m *linkMode) start() {
	m.log("runner link: daemon calls go over the runner link as process " + m.t.leaseOwner)
	m.work.start()
}

// close ends the link with the runner. What the sessions' event streams still hold is kept in the spool for the next
// process (link_events.go).
func (m *linkMode) close() {
	m.log("runner link: closing: the runner is stopping")
	m.work.stop()
	setLinkAssignedRelease(nil)
	m.work.wait(linkCloseWait)
	m.events.close()
}

// doVia is a call of the daemon's transport (Transport.doVia). A call to a daemon route goes over the link, within
// timeout; any other call goes over HTTPS (viaHTTP).
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
	return m.call(cctx, route, method, path, body, out, headers)
}

// linkAnswerTooLarge reports whether err is the gateway refusing to relay an answer larger than one frame may be once
// joined (BACKEND_ANSWER_TOO_LARGE): the same call asking for less may be answered.
func linkAnswerTooLarge(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.code() == "BACKEND_ANSWER_TOO_LARGE"
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
	if route == linkRouteInbox {
		// The message or shell turn this process runs in the session, "" for none (§5.6): the control plane hands a
		// turn of the fetch's lease generation straight back when the fetch does not name it, a fetch whose answer
		// was lost, rather than when its lease runs out. Every resend of the call says what the first said.
		path = linkWithQuery(path, "runningTurnId", m.runningTurn(linkPathSegment(path, 2)))
	}
	rpc := &linkpb.Rpc{RequestId: m.requestIDFor(ctx), Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{
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

// requestIDFor is the request_id of a call made with ctx: the id its caller keeps (linkRequestIDs.with), or a new one.
func (m *linkMode) requestIDFor(ctx context.Context) string {
	if ids, _ := ctx.Value(linkRequestIDsKey{}).(*linkRequestIDs); ids != nil {
		if ids.id == "" {
			ids.id = m.newRequestID()
		}
		ids.sent = true
		return ids.id
	}
	return m.newRequestID()
}

// linkRequestIDs is the request_id the fetches of one caller go under over the link: an inbox poller's, and the claim
// loop's (task B2b). A fetch that went over the link and got no answer, a transport error, a timeout or the link
// down, is followed by one under the same id, however much later, until a fetch gets an answer: a turn or a session,
// nothing, or a refusal. The one after that goes under a new id. The control plane answers a fetch under the id of
// one that handed out a turn or claimed a session with that turn or session (dequeueTurn, trySessionClaim in the
// apiserver), so what an answer lost on its way handed out comes back however long the link was down, not only
// within the one call's deadline. A fetch over HTTPS carries no request id, and is followed by one under a new id.
// Used by one goroutine at a time: the caller's, which the call it makes runs on.
type linkRequestIDs struct {
	id   string // the id of the last fetch, while it went over the link and got no answer; "" otherwise
	sent bool   // whether the fetch under way went over the link
}

type linkRequestIDsKey struct{}

// with is ctx for the next fetch, which goes over the link under the id the last one kept, or a new one.
func (r *linkRequestIDs) with(ctx context.Context) context.Context {
	if r == nil {
		return ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.sent = false
	return context.WithValue(ctx, linkRequestIDsKey{}, r)
}

// settle takes how the fetch made with with's context ended: its id is kept only when it went over the link and got
// no answer.
func (r *linkRequestIDs) settle(err error) {
	if r == nil {
		return
	}
	if !r.sent || linkAnswered(err) {
		r.id = ""
	}
	r.sent = false
}

// kept reports whether the next fetch goes under the id of the last, which went over the link and got no answer.
func (r *linkRequestIDs) kept() bool { return r != nil && r.id != "" }

// linkAnswered reports whether a call got an answer: any the control plane gave, or a refusal the link gave in its
// place (both a transportHTTPError), as against a transport error, a timeout or the link down, after which the
// question the call asked is still open.
func linkAnswered(err error) bool {
	if err == nil {
		return true
	}
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr)
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

// handedTurn records a turn the inbox handed this process (inboxPoller.handedOver): a message or shell turn is what it
// executes until the turn's completion, or the end of the engine generation it was handed to.
func (m *linkMode) handedTurn(sessionID string, r *RunInboxResponse) {
	if r == nil || r.TurnID == "" || (r.Kind != "message" && r.Kind != "shell") {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessionLocked(sessionID).turn = r.TurnID
}

// turnDone records that this process no longer runs a turn: the control plane took its turn completion, or the engine
// generation it was handed to ended (inboxPoller.close).
func (m *linkMode) turnDone(sessionID, turnID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[sessionID]; s != nil && (s.turn == turnID || turnID == "") {
		s.turn = ""
	}
}

// runningTurn is the message or shell turn this process runs in a session, "" for none.
func (m *linkMode) runningTurn(sessionID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[sessionID]; s != nil {
		return s.turn
	}
	return ""
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
}

// afterSeq is what a call depending on a session's events waits for (after_seq): the highest seq handed to its event
// stream of an event the control plane stores as a row. The control plane counts a call's events stored once a row holds
// a seq at or past after_seq (assertAfterSeqStored, runner-link-call.ts); a live event or a bare ping is stored as
// nothing, and a call that waited for one would wait for ever. storedRowSeq is the highest of those it acknowledged
// storing.
func (m *linkMode) afterSeq(sessionID string) uint64 {
	handed, _ := m.events.rowSeqs(sessionID)
	return handed
}

func (m *linkMode) storedRowSeq(sessionID string) uint64 {
	_, stored := m.events.rowSeqs(sessionID)
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
			r.TurnId = s.turn
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

// The routes whose answers the link reads itself, and the inbox, whose fetches it adds to.
const (
	linkRouteHeartbeat    = "POST /runner/heartbeat"
	linkRouteTurnComplete = "POST /runner/sessions/:id/turn-complete"
	linkRouteInbox        = "GET /runner/sessions/:id/inbox"
)

// linkDaemonRoutes are the daemon routes: the routes of the apiserver's RunnerApiController that take the runner
// credential (@UseGuards(RunnerAuthGuard)), which the link gateway forwards and its internal listener serves
// (runner-auth.guard.ts admitLinkCall). TestLinkDaemonRoutesAreTheControllersGuardedRoutes holds this list to the
// controller. Registration and the device flow come before any link, and every other controller under /runner is the
// agent tool API, which stays on HTTPS (D14). The attachments' two routes and the file upload's are listed because the
// controller serves them, but their calls never pass doVia: they are multipart and raw bytes, and stay on HTTPS. So is the Claude region
// check's: it is one request through the proxy Claude uses, on a transport of its own, and the apiserver answers it
// unknown over the link (docs/claude-region-check-contract.md §3).
var linkDaemonRoutes = []string{
	"GET /runner/me",
	"POST /runner/deregister",
	"GET /runner/region-check",
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
	"POST /runner/dir-probe-result",
	"POST /runner/install-result",
	"POST /runner/codex-account-remove-result",
	"POST /runner/account-remove-result",
	"POST /runner/login-result",
	"POST /runner/cursor-key-check-result",
	"GET /runner/sessions/claim",
	"GET /runner/sessions/reclaim",
	"POST /runner/sessions/:id/source/pin",
	"POST /runner/sessions/:id/takeover-leases",
	"POST /runner/sessions/:id/activate-leases",
	"POST /runner/sessions/:id/release-leases",
	"POST /runner/sessions/:id/orchestration-credential",
	linkRouteInbox,
	"GET /runner/sessions/:id/attachments/:id",
	"POST /runner/sessions/:id/attachments",
	"POST /runner/sessions/:id/files",
	"POST /runner/sessions/:id/artifacts/result",
	"POST /runner/sessions/:id/approvals",
	"GET /runner/sessions/:id/approvals/:id",
	"POST /runner/sessions/:id/background-wake",
	"POST /runner/sessions/:id/notify",
	"POST /runner/sessions/:id/scheduled-wakeup",
	"POST /runner/sessions/:id/naming",
	"POST /runner/sessions/:id/cursor-key-check",
	"POST /runner/sessions/:id/turns/:id/suggestion",
	linkRouteTurnComplete,
	"POST /runner/sessions/:id/events",
	"POST /runner/sessions/:id/finalize",
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

// linkWithQuery is path with name=value added to its query.
func linkWithQuery(path, name, value string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + name + "=" + url.QueryEscape(value)
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
