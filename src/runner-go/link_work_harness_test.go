package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The doubles of the link mode's tests: a link gateway in MODE_LINK that forwards each Rpc to a backend the test
// writes, answers heartbeats by the rules of src/link-gateway/README.md (facts by digest, want_facts), supersedes a
// process's older connection when its newer one is welcomed, closes a connection whose token expires, and can drop a
// connection, drain it, refresh its token, redirect it or hint it whenever a test says. And a runner whose daemon
// transport has a link mode pointed at it.

// fakeWorkGateway is a link gateway over TLS for the work path's tests.
type fakeWorkGateway struct {
	*httptest.Server
	t *testing.T

	mu sync.Mutex
	// mode is what its Welcomes and HeartbeatAcks state.
	mode linkpb.Mode
	// welcome, when set, adds to each Welcome.
	welcome func(c *fakeWorkConn, w *linkpb.Welcome)
	// backend answers each Rpc, on a goroutine of its own; nil is no answer at all. Unset, every Rpc is answered
	// 200 {}.
	backend func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult
	// reconcile is what a forwarded heartbeat's HeartbeatAck carries as reconcile_json; unset, {}.
	reconcile func(c *fakeWorkConn, body map[string]json.RawMessage) []byte
	// ackHints, when set, is every HeartbeatAck's HintState, and ackRelease the release every forwarded beat's
	// HeartbeatAck assigns.
	ackHints   *linkpb.HintState
	ackRelease *linkpb.AssignedRelease
	// refuse, when it says so, refuses an upgrade with that status, body and Retry-After.
	refuse func(r *http.Request) (status int, body, retryAfter string)
	// ingest, when set, stores the EventBatches and records the LiveBatches its connections carry
	// (link_events_harness_test.go); unset, they go unanswered.
	ingest *fakeIngest

	conns    []*fakeWorkConn
	upgrades []time.Time
	rpcs     []fakeWorkRPC
	beats    []fakeWorkBeat
}

type fakeWorkConn struct {
	g        *fakeWorkGateway
	id       string
	ws       *websocket.Conn
	token    string
	hello    *linkpb.Hello
	welcomed time.Time
	ended    time.Time
	// status is the client's close status, -1 for none; closedWith, the Close this gateway sent, if any.
	status     websocket.StatusCode
	closedWith linkpb.CloseCode
	done       chan struct{}
	writeMu    sync.Mutex
	outID      uint64
	facts      map[string]fakeWorkFact // what a connection's beats sent whole, by kind
}

type fakeWorkFact struct {
	sha  string
	json []byte
}

// fakeWorkRPC is one Rpc the gateway received.
type fakeWorkRPC struct {
	conn      string
	at        time.Time
	requestID string
	sessionID string
	afterSeq  uint64
	method    string
	path      string
	body      []byte
}

// fakeWorkBeat is one Heartbeat the gateway received: the frame, and the body it forwarded (nil when it asked for
// facts instead).
type fakeWorkBeat struct {
	conn      string
	frame     *linkpb.Heartbeat
	forwarded map[string]json.RawMessage
	want      []string
}

func newFakeWorkGateway(t *testing.T) *fakeWorkGateway {
	t.Helper()
	g := &fakeWorkGateway{t: t, mode: linkpb.Mode_MODE_LINK}
	g.Server = httptest.NewUnstartedServer(http.HandlerFunc(g.serve))
	g.StartTLS()
	t.Cleanup(func() {
		g.mu.Lock()
		conns := append([]*fakeWorkConn{}, g.conns...)
		g.mu.Unlock()
		for _, c := range conns {
			_ = c.ws.CloseNow()
		}
		g.Close()
	})
	return g
}

func (g *fakeWorkGateway) linkURL() string { return "wss://" + strings.TrimPrefix(g.URL, "https://") }

func (g *fakeWorkGateway) roots() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(g.Certificate())
	return pool
}

func (g *fakeWorkGateway) setMode(mode linkpb.Mode) {
	g.mu.Lock()
	g.mode = mode
	g.mu.Unlock()
}

func (g *fakeWorkGateway) serve(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	g.upgrades = append(g.upgrades, time.Now())
	refuse := g.refuse
	g.mu.Unlock()
	if refuse != nil {
		if status, body, retryAfter := refuse(r); status != 0 {
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			w.Header().Set("Connection", "close")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
			return
		}
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(16 << 20)
	g.mu.Lock()
	c := &fakeWorkConn{g: g, id: fmt.Sprintf("c-%016x", len(g.conns)+1), ws: ws, status: -1, done: make(chan struct{}),
		token: strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), facts: map[string]fakeWorkFact{}}
	g.conns = append(g.conns, c)
	g.mu.Unlock()
	defer close(c.done)
	var chunks linkReassembler
	read := func() (*linkpb.Frame, error) {
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				return nil, err
			}
			var f linkpb.Frame
			if err := proto.Unmarshal(data, &f); err != nil {
				return nil, err
			}
			if piece := f.GetChunk(); piece != nil {
				joined, err := chunks.add(piece)
				if err != nil {
					return nil, err
				}
				if joined == nil {
					continue
				}
				return joined, nil
			}
			return &f, nil
		}
	}
	first, err := read()
	if err != nil || first.GetHello() == nil {
		_ = ws.Close(websocket.StatusProtocolError, "Hello first")
		return
	}
	if lease := fakeLinkTokenLease("Bearer " + c.token); !strings.EqualFold(lease, first.GetHello().GetProcessId()) {
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED, "Hello.process_id is not the process the link token was issued to", 0)
		return
	}
	g.mu.Lock()
	c.hello, c.welcomed = first.GetHello(), time.Now()
	welcome := &linkpb.Welcome{ProtocolVersion: 1, Mode: g.mode, HeartbeatIntervalMs: 30000,
		Limits: &linkpb.Limits{MaxFrameBytes: linkMaxFrameBytes}, Hints: &linkpb.HintState{}, ConnectionId: c.id}
	if g.ingest != nil {
		g.ingest.welcome(c, welcome)
	}
	if g.welcome != nil {
		g.welcome(c, welcome)
	}
	var older []*fakeWorkConn
	for _, o := range g.conns {
		if o != c && !o.welcomed.IsZero() && o.ended.IsZero() && strings.EqualFold(o.hello.GetProcessId(), c.hello.GetProcessId()) {
			older = append(older, o)
		}
	}
	g.mu.Unlock()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: welcome}})
	// The newest connection of a process takes its traffic; the older one is closed (README, Handshake).
	for _, o := range older {
		o.closeWith(linkpb.CloseCode_CLOSE_CODE_SUPERSEDED, "a newer connection of this process took over", 0)
	}
	// A token that expires ends its connection (README, Connections).
	if exp := fakeLinkTokenExpiry(c.token); !exp.IsZero() {
		time.AfterFunc(time.Until(exp), func() { c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED, "the link token expired", 0) })
	}
	for {
		f, err := read()
		if err != nil {
			g.mu.Lock()
			c.ended, c.status = time.Now(), websocket.CloseStatus(err)
			g.mu.Unlock()
			return
		}
		switch body := f.GetBody().(type) {
		case *linkpb.Frame_Heartbeat:
			g.onBeat(c, body.Heartbeat)
		case *linkpb.Frame_Rpc:
			g.onRpc(c, body.Rpc)
		case *linkpb.Frame_EventBatch:
			g.onEventBatch(c, body.EventBatch)
		case *linkpb.Frame_LiveBatch:
			g.onLiveBatch(c, body.LiveBatch)
		case *linkpb.Frame_TurnPrefixResponse:
			g.onTurnPrefixAnswer(c, body.TurnPrefixResponse)
		}
	}
}

// onBeat answers a beat as the real gateway does (heartbeat.go): a digest it does not hold is asked for, and a beat
// it can fill in is forwarded.
func (g *fakeWorkGateway) onBeat(c *fakeWorkConn, hb *linkpb.Heartbeat) {
	g.mu.Lock()
	mode := g.mode
	members := map[string]json.RawMessage{}
	var want []string
	for _, f := range hb.GetFacts() {
		if len(f.GetJson()) == 0 {
			if cached, ok := c.facts[f.GetKind()]; ok && cached.sha == f.GetSha256() {
				members[f.GetKind()] = cached.json
			} else {
				want = append(want, f.GetKind())
			}
			continue
		}
		sum := sha256.Sum256(f.GetJson())
		if hex.EncodeToString(sum[:]) == f.GetSha256() {
			c.facts[f.GetKind()] = fakeWorkFact{sha: f.GetSha256(), json: append([]byte(nil), f.GetJson()...)}
		}
		members[f.GetKind()] = f.GetJson()
	}
	ack := &linkpb.HeartbeatAck{Mode: mode}
	beat := fakeWorkBeat{conn: c.id, frame: proto.Clone(hb).(*linkpb.Heartbeat), want: want}
	if len(want) > 0 || mode != linkpb.Mode_MODE_LINK {
		ack.WantFacts = want
		g.beats = append(g.beats, beat)
		g.mu.Unlock()
		c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: ack}})
		return
	}
	members["leaseOwner"], _ = json.Marshal(strings.ToLower(hb.GetProcessId()))
	members["idleCapacity"], _ = json.Marshal(hb.GetIdleCapacity())
	if ids := hb.GetSessionIds(); len(ids) > 0 {
		members["supervisedSessionIds"], _ = json.Marshal(ids)
	}
	if hb.GetDraining() {
		members["draining"] = json.RawMessage("true")
	}
	beat.forwarded = members
	g.beats = append(g.beats, beat)
	reconcile, hints, release := g.reconcile, g.ackHints, g.ackRelease
	g.mu.Unlock()
	ack.ReconcileJson = []byte(`{}`)
	if reconcile != nil {
		ack.ReconcileJson = reconcile(c, members)
	}
	ack.Hints, ack.Release = hints, release
	c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: ack}})
}

func (g *fakeWorkGateway) onRpc(c *fakeWorkConn, rpc *linkpb.Rpc) {
	g.mu.Lock()
	t := rpc.GetTunnel()
	g.rpcs = append(g.rpcs, fakeWorkRPC{conn: c.id, at: time.Now(), requestID: rpc.GetRequestId(), sessionID: rpc.GetSessionId(),
		afterSeq: rpc.GetAfterSeq(), method: t.GetMethod(), path: t.GetPath(), body: append([]byte(nil), t.GetJsonBody()...)})
	mode, backend := g.mode, g.backend
	g.mu.Unlock()
	if mode != linkpb.Mode_MODE_LINK {
		c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{RequestId: rpc.GetRequestId(),
			Outcome: &linkpb.RpcResult_Failure{Failure: &linkpb.Failure{Code: "LINK_MODE_HTTP"}}}}})
		return
	}
	go func() {
		var res *linkpb.RpcResult
		if backend == nil {
			res = fakeWorkAnswer(rpc, 200, `{}`)
		} else {
			res = backend(c, rpc)
		}
		if res != nil {
			c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: res}})
		}
	}()
}

// fakeWorkAnswer is a route's answer to rpc.
func fakeWorkAnswer(rpc *linkpb.Rpc, status int, body string) *linkpb.RpcResult {
	return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{
		Status: uint32(status), JsonBody: []byte(body),
	}}}
}

// fakeWorkFailure is the gateway saying no answer could be relayed.
func fakeWorkFailure(rpc *linkpb.Rpc, code string, retryable bool, retryAfterMs uint32) *linkpb.RpcResult {
	return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Failure{Failure: &linkpb.Failure{
		Code: code, Message: "from the test", Retryable: retryable, RetryAfterMs: retryAfterMs,
	}}}
}

func (c *fakeWorkConn) send(f *linkpb.Frame) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.outID++
	f.Id = c.outID
	msgs, err := encodeLinkFrame(f, linkMaxFrameBytes, func() uint64 { c.outID++; return c.outID })
	if err != nil {
		return
	}
	for _, b := range msgs {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := c.ws.Write(ctx, websocket.MessageBinary, b)
		cancel()
		if err != nil {
			return
		}
	}
}

// closeWith sends a Close and closes the WebSocket, as the gateway ends a connection.
func (c *fakeWorkConn) closeWith(code linkpb.CloseCode, message string, retryAfterMs uint32) {
	c.g.mu.Lock()
	c.closedWith = code
	c.g.mu.Unlock()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Close{Close: &linkpb.Close{Code: code, Message: message, RetryAfterMs: retryAfterMs}}})
	_ = c.ws.Close(websocket.StatusPolicyViolation, code.String())
}

// drop cuts the connection with no Close: a network that went away.
func (c *fakeWorkConn) drop() { _ = c.ws.CloseNow() }

// snapshot is what the gateway has seen so far.
func (g *fakeWorkGateway) snapshot() (conns []*fakeWorkConn, rpcs []fakeWorkRPC, beats []fakeWorkBeat) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]*fakeWorkConn{}, g.conns...), append([]fakeWorkRPC{}, g.rpcs...), append([]fakeWorkBeat{}, g.beats...)
}

// welcomed is the gateway's welcomed connections, in order.
func (g *fakeWorkGateway) welcomed() []*fakeWorkConn {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []*fakeWorkConn
	for _, c := range g.conns {
		if !c.welcomed.IsZero() {
			out = append(out, c)
		}
	}
	return out
}

// open is the welcomed connections that have not ended.
func (g *fakeWorkGateway) open() []*fakeWorkConn {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []*fakeWorkConn
	for _, c := range g.conns {
		if !c.welcomed.IsZero() && c.ended.IsZero() {
			out = append(out, c)
		}
	}
	return out
}

// waitWelcomed waits until the gateway has welcomed n connections, and returns the nth.
func (g *fakeWorkGateway) waitWelcomed(t *testing.T, n int) *fakeWorkConn {
	t.Helper()
	var c *fakeWorkConn
	linkWaitFor(t, 15*time.Second, fmt.Sprintf("%d welcomed connections", n), func() bool {
		w := g.welcomed()
		if len(w) >= n {
			c = w[n-1]
			return true
		}
		return false
	})
	return c
}

// rpcsTo is every Rpc for a path, by its route (the path without its query), in order.
func (g *fakeWorkGateway) rpcsTo(path string) []fakeWorkRPC {
	_, rpcs, _ := g.snapshot()
	var out []fakeWorkRPC
	for _, r := range rpcs {
		if strings.SplitN(r.path, "?", 2)[0] == path {
			out = append(out, r)
		}
	}
	return out
}

// fakeLinkTokenExpiry is the exp of a fake link token.
func fakeLinkTokenExpiry(token string) time.Time {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	_ = json.Unmarshal(payload, &claims)
	if claims.Exp == 0 {
		return time.Time{}
	}
	return time.Unix(claims.Exp, 0)
}

// ── The runner side ─────────────────────────────────────────────────────────────────────────────

// linkWorkRig is a daemon transport with a link mode, against a control plane and a gateway.
type linkWorkRig struct {
	cp   *fakeLinkControlPlane
	g    *fakeWorkGateway
	t    *Transport
	m    *linkMode
	logs *linkTestLog
}

// newLinkWorkRig builds the rig. Its link is not in use until something puts it there.
func newLinkWorkRig(t *testing.T) *linkWorkRig {
	t.Helper()
	// What the link mode's event streams still hold when it closes goes to the spool under ORBIT_HOME.
	if os.Getenv("ORBIT_HOME") == "" || !strings.HasPrefix(os.Getenv("ORBIT_HOME"), os.TempDir()) {
		t.Setenv("ORBIT_HOME", t.TempDir())
	}
	g := newFakeWorkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	r := &linkWorkRig{cp: cp, g: g, logs: &linkTestLog{}}
	r.t = NewTransport(cp.URL, "runner-token")
	r.m = newLinkMode(r.t, r.logs.log)
	r.trust(g.roots(), nil)
	r.m.work.pingEvery, r.m.work.pingTimeout = 200*time.Millisecond, 2*time.Second
	r.t.link = r.m
	t.Cleanup(r.m.close)
	return r
}

// trust has the work connection dial through proxy (nil: directly) and trust roots.
func (r *linkWorkRig) trust(roots *x509.CertPool, proxy func(*http.Request) (*url.URL, error)) {
	r.m.work.client.api = &http.Client{Transport: newLinkHTTPTransport(nil, nil)}
	r.m.work.client.dial = &http.Client{Transport: newLinkHTTPTransport(proxy, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12})}
}

// useLink puts the link in use, as a gateway saying MODE_LINK on the shadow's connection does, and waits for the work
// connection.
func (r *linkWorkRig) useLink(t *testing.T) *fakeWorkConn {
	t.Helper()
	r.m.observe(linkpb.Mode_MODE_LINK, "the test")
	c := r.g.waitWelcomed(t, len(r.g.welcomed())+1)
	linkWaitFor(t, 5*time.Second, "the work connection to be adopted", func() bool {
		cur := r.m.work.current()
		return cur != nil && cur.id == c.id
	})
	return c
}

// shortenLinkWaits shortens the link mode's waits for one test.
func shortenLinkWaits(t *testing.T, longPoll, approval, afterSeq time.Duration) {
	t.Helper()
	oldPoll, oldApproval, oldAfter := linkLongPoll, linkApprovalRecheck, linkAfterSeqWait
	linkLongPoll, linkApprovalRecheck, linkAfterSeqWait = longPoll, approval, afterSeq
	t.Cleanup(func() { linkLongPoll, linkApprovalRecheck, linkAfterSeqWait = oldPoll, oldApproval, oldAfter })
}
