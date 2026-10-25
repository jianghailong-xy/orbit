package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The runner link tests' doubles: a control plane that mints link tokens and takes heartbeats and event batches, a
// link gateway over TLS that greets, answers and compares mirrors by the rules of src/link-gateway/README.md, and a
// proxy that tunnels, refuses or intercepts.

// ── The control plane ───────────────────────────────────────────────────────────────────────────

// fakeLinkControlPlane answers POST /api/runner/link-token with tokens for linkURL, and every other runner route with
// 200, recording what each request carried.
type fakeLinkControlPlane struct {
	*httptest.Server
	mu       sync.Mutex
	linkURL  string
	lifetime time.Duration
	// tokenStatus, when set, is how link-token requests are refused.
	tokenStatus int
	tokens      int
	// status, when it says so, is how a route answers instead of 200.
	status func(path string) int
	// discardBodies keeps the work path's requests without their bodies.
	discardBodies bool
	received      []fakeLinkRequest
}

type fakeLinkRequest struct {
	method, path string
	body         []byte
	leaseOwner   string // a link-token request's
}

func newFakeLinkControlPlane(t *testing.T, linkURL string) *fakeLinkControlPlane {
	t.Helper()
	cp := &fakeLinkControlPlane{linkURL: linkURL, lifetime: time.Hour}
	cp.Server = httptest.NewServer(http.HandlerFunc(cp.serve))
	t.Cleanup(cp.Close)
	return cp
}

func (cp *fakeLinkControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	cp.mu.Lock()
	defer cp.mu.Unlock()
	rec := fakeLinkRequest{method: r.Method, path: r.URL.Path, body: body}
	if r.URL.Path == "/api/runner/link-token" {
		var req struct {
			LeaseOwner string `json:"leaseOwner"`
		}
		_ = json.Unmarshal(body, &req)
		rec.leaseOwner = req.LeaseOwner
		cp.received = append(cp.received, rec)
		if cp.tokenStatus != 0 {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(cp.tokenStatus)
			_, _ = w.Write([]byte(`{"code":"RUNNER_LINK_NOT_CONFIGURED","message":"The runner link is not configured on this server."}`))
			return
		}
		cp.tokens++
		now := time.Now()
		tok := fakeLinkToken(now, cp.lifetime, req.LeaseOwner, cp.tokens)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"token": tok, "expiresAt": now.Add(cp.lifetime).UTC().Format(time.RFC3339Nano), "cellId": "cell-1", "linkUrl": cp.linkURL,
		})
		return
	}
	if cp.discardBodies {
		rec.body = nil
	}
	cp.received = append(cp.received, rec)
	if cp.status != nil {
		if code := cp.status(r.URL.Path); code != 0 {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"code":"REFUSED_FOR_THE_TEST"}`))
			return
		}
	}
	_, _ = w.Write([]byte(`{}`))
}

// requests is what reached path, in order.
func (cp *fakeLinkControlPlane) requests(path string) []fakeLinkRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	var out []fakeLinkRequest
	for _, r := range cp.received {
		if r.path == path {
			out = append(out, r)
		}
	}
	return out
}

// fakeLinkToken is a compact JWS with the claims the runner reads (iat, exp) and the gateway checks; its signature
// is no signature, which the fake gateway does not check.
func fakeLinkToken(now time.Time, lifetime time.Duration, leaseOwner string, n int) string {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"aud": "orbit-runner-link", "iat": now.Unix(), "exp": now.Add(lifetime).Unix(), "leaseOwner": leaseOwner,
		"jti": strconv.Itoa(n),
	})
	return header + "." + enc.EncodeToString(claims) + "." + enc.EncodeToString([]byte("unsigned"))
}

// ── The gateway ─────────────────────────────────────────────────────────────────────────────────

// fakeLinkGateway is a link gateway over TLS for the tests: it checks the token names the Hello's process, greets
// with Welcome in MODE_HTTP, answers every Heartbeat and Rpc, and pairs mirrors and compares them as the real one
// does (compareLinkMirror).
type fakeLinkGateway struct {
	*httptest.Server
	t *testing.T

	mu       sync.Mutex
	conns    []*fakeLinkConn
	upgrades []time.Time
	// refuse, when it says so, refuses an upgrade with that status, body and Retry-After.
	refuse func(r *http.Request) (status int, body, retryAfter string)
	// stall, when set, stops reading a connection once it is welcomed: a gateway that takes no more.
	stall    bool
	pairs    []fakeLinkPair
	unpaired []string
}

type fakeLinkConn struct {
	g        *fakeLinkGateway
	id       string
	ws       *websocket.Conn
	hello    *linkpb.Hello
	writeMu  sync.Mutex
	outID    uint64
	welcomed time.Time
	// ended is when reading it stopped, and status the client's close status (-1: none).
	ended  time.Time
	status websocket.StatusCode
	done   chan struct{}
	typed  map[uint64]*linkpb.Frame
}

// fakeLinkPair is one mirror the gateway compared.
type fakeLinkPair struct {
	conn  string
	kind  string
	diffs []string
	raw   *linkpb.TunnelRequest
	typed *linkpb.Frame
}

func newFakeLinkGateway(t *testing.T) *fakeLinkGateway {
	t.Helper()
	g := &fakeLinkGateway{t: t}
	g.Server = httptest.NewUnstartedServer(http.HandlerFunc(g.serve))
	g.StartTLS()
	t.Cleanup(func() {
		g.mu.Lock()
		conns := append([]*fakeLinkConn{}, g.conns...)
		g.mu.Unlock()
		for _, c := range conns {
			_ = c.ws.CloseNow()
		}
		g.Close()
	})
	return g
}

// linkURL is the gateway's wss:// address.
func (g *fakeLinkGateway) linkURL() string { return "wss://" + strings.TrimPrefix(g.URL, "https://") }

// roots trusts the gateway's certificate.
func (g *fakeLinkGateway) roots() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(g.Certificate())
	return pool
}

func (g *fakeLinkGateway) serve(w http.ResponseWriter, r *http.Request) {
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
	ws.SetReadLimit(1 << 20)
	g.mu.Lock()
	c := &fakeLinkConn{g: g, id: fmt.Sprintf("c-%016x", len(g.conns)+1), ws: ws, status: -1, done: make(chan struct{}),
		typed: map[uint64]*linkpb.Frame{}}
	g.conns = append(g.conns, c)
	stall := g.stall
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
	if lease := fakeLinkTokenLease(r.Header.Get("Authorization")); !strings.EqualFold(lease, first.GetHello().GetProcessId()) {
		c.send(&linkpb.Frame{Body: &linkpb.Frame_Close{Close: &linkpb.Close{Code: linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED,
			Message: "Hello.process_id is not the process the link token was issued to"}}})
		_ = ws.Close(websocket.StatusPolicyViolation, "unauthenticated")
		return
	}
	g.mu.Lock()
	c.hello, c.welcomed = first.GetHello(), time.Now()
	g.mu.Unlock()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: &linkpb.Welcome{ProtocolVersion: 1, Mode: linkpb.Mode_MODE_HTTP,
		HeartbeatIntervalMs: 30000, Limits: &linkpb.Limits{MaxFrameBytes: linkMaxFrameBytes}, ConnectionId: c.id}}})
	if stall {
		<-r.Context().Done()
		return
	}
	for {
		f, err := read()
		if err != nil {
			g.mu.Lock()
			c.ended, c.status = time.Now(), websocket.CloseStatus(err)
			for id := range c.typed {
				g.unpaired = append(g.unpaired, fmt.Sprintf("typed %s:%d closed", c.id, id))
			}
			g.mu.Unlock()
			return
		}
		switch body := f.GetBody().(type) {
		case *linkpb.Frame_Heartbeat:
			c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{Mode: linkpb.Mode_MODE_HTTP}}})
			g.mu.Lock()
			c.typed[f.GetId()] = f
			g.mu.Unlock()
		case *linkpb.Frame_EventBatch:
			g.mu.Lock()
			c.typed[f.GetId()] = f
			g.mu.Unlock()
		case *linkpb.Frame_Rpc:
			g.takeRaw(c, body.Rpc)
			c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{RequestId: body.Rpc.GetRequestId(),
				Outcome: &linkpb.RpcResult_Failure{Failure: &linkpb.Failure{Code: "LINK_MODE_HTTP"}}}}})
		}
	}
}

// takeRaw pairs a raw half with the typed half its request_id names, and compares them.
func (g *fakeLinkGateway) takeRaw(c *fakeLinkConn, rpc *linkpb.Rpc) {
	g.mu.Lock()
	defer g.mu.Unlock()
	rest, ok := strings.CutPrefix(rpc.GetRequestId(), linkShadowPrefix)
	i := strings.LastIndexByte(rest, ':')
	if !ok || i <= 0 || rest[:i] != c.id || rpc.GetTunnel() == nil {
		g.unpaired = append(g.unpaired, "raw "+rpc.GetRequestId())
		return
	}
	id, err := strconv.ParseUint(rest[i+1:], 10, 64)
	typed := c.typed[id]
	if err != nil || typed == nil {
		g.unpaired = append(g.unpaired, "raw "+rpc.GetRequestId()+" names no typed half")
		return
	}
	delete(c.typed, id)
	kind, diffs := compareLinkMirror(typed, rpc.GetTunnel(), c.hello)
	g.pairs = append(g.pairs, fakeLinkPair{conn: c.id, kind: kind, diffs: diffs, raw: rpc.GetTunnel(), typed: typed})
}

// fakeLinkTokenLease is the leaseOwner claim of the bearer token in authorization.
func fakeLinkTokenLease(authorization string) string {
	parts := strings.Split(strings.TrimPrefix(authorization, "Bearer "), ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		LeaseOwner string `json:"leaseOwner"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.LeaseOwner
}

func (c *fakeLinkConn) send(f *linkpb.Frame) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.outID++
	f.Id = c.outID
	b, _ := proto.Marshal(f)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.ws.Write(ctx, websocket.MessageBinary, b)
}

// snapshot is what the gateway has seen so far.
func (g *fakeLinkGateway) snapshot() (conns []*fakeLinkConn, pairs []fakeLinkPair, unpaired []string, upgrades []time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]*fakeLinkConn{}, g.conns...), append([]fakeLinkPair{}, g.pairs...), append([]string{}, g.unpaired...),
		append([]time.Time{}, g.upgrades...)
}

// linkWaitFor polls cond until it holds or d passes.
func linkWaitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", d, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ── The comparison, by src/link-gateway/README.md ──────────────────────────────────────────────

// compareLinkMirror compares a typed half with the raw half naming it, by the rules of the gateway's README
// ("How the gateway compares"), and returns the kind and the fields that differ.
func compareLinkMirror(typed *linkpb.Frame, req *linkpb.TunnelRequest, hello *linkpb.Hello) (string, []string) {
	var diffs []string
	add := func(format string, args ...any) { diffs = append(diffs, fmt.Sprintf(format, args...)) }
	var members map[string]json.RawMessage
	if json.Unmarshal(req.GetJsonBody(), &members) != nil || members == nil {
		return "?", []string{"body: not a JSON object"}
	}
	str := func(m map[string]json.RawMessage, k string) string {
		var s string
		_ = json.Unmarshal(m[k], &s)
		return s
	}
	switch {
	case typed.GetHeartbeat() != nil:
		hb := typed.GetHeartbeat()
		if req.GetMethod() != "POST" || req.GetPath() != "/runner/heartbeat" {
			add("route: %s %s", req.GetMethod(), req.GetPath())
		}
		if !strings.EqualFold(str(members, "leaseOwner"), hb.GetProcessId()) {
			add("leaseOwner")
		}
		if n := strings.TrimSpace(string(members["idleCapacity"])); (n == "" && hb.GetIdleCapacity() != 0) ||
			(n != "" && n != strconv.FormatUint(uint64(hb.GetIdleCapacity()), 10)) {
			add("idleCapacity: HTTP %s, link %d", n, hb.GetIdleCapacity())
		}
		var draining bool
		_ = json.Unmarshal(members["draining"], &draining)
		if draining != hb.GetDraining() {
			add("draining")
		}
		var ids []string
		_ = json.Unmarshal(members["supervisedSessionIds"], &ids)
		a, b := append([]string{}, ids...), append([]string{}, hb.GetSessionIds()...)
		sort.Strings(a)
		sort.Strings(b)
		if strings.Join(a, ",") != strings.Join(b, ",") {
			add("supervisedSessionIds")
		}
		if _, ok := members["version"]; ok && str(members, "version") != hello.GetRunnerVersion() {
			add("version: HTTP %q, Hello %q", str(members, "version"), hello.GetRunnerVersion())
		}
		if _, ok := members["status"]; ok && str(members, "status") != "ONLINE" {
			add("status")
		}
		facts := map[string]*linkpb.Fact{}
		for _, f := range hb.GetFacts() {
			if facts[f.GetKind()] != nil {
				add("fact_duplicate: %s", f.GetKind())
			}
			facts[f.GetKind()] = f
		}
		for name, raw := range members {
			if linkHeartbeatTyped[name] {
				continue
			}
			f := facts[name]
			switch {
			case f == nil:
				add("fact_missing: %s", name)
			case len(f.GetJson()) == 0:
				add("fact_json_missing: %s", name)
			default:
				if sum := sha256.Sum256(f.GetJson()); hex.EncodeToString(sum[:]) != f.GetSha256() {
					add("fact_digest: %s", name)
				}
				if !linkJSONEqual(f.GetJson(), raw) {
					add("fact_value: %s", name)
				}
			}
		}
		for kind := range facts {
			if _, ok := members[kind]; !ok || linkHeartbeatTyped[kind] {
				add("fact_extra: %s", kind)
			}
		}
		sort.Strings(diffs)
		return linkMirrorHeartbeat, diffs
	case typed.GetEventBatch() != nil:
		eb := typed.GetEventBatch()
		if want := "/runner/sessions/" + eb.GetSessionId() + "/events"; req.GetMethod() != "POST" || req.GetPath() != want {
			add("route: %s %s", req.GetMethod(), req.GetPath())
		}
		for name := range members {
			if name != "leaseOwner" && name != "events" {
				add("batch_member: %s", name)
			}
		}
		if lo := str(members, "leaseOwner"); lo != "" && !strings.EqualFold(lo, hello.GetProcessId()) {
			add("leaseOwner")
		}
		var events []map[string]json.RawMessage
		_ = json.Unmarshal(members["events"], &events)
		if len(events) != len(eb.GetEvents()) {
			add("events_length: HTTP %d, link %d", len(events), len(eb.GetEvents()))
		}
		for i := range min(len(events), len(eb.GetEvents())) {
			ev, le := events[i], eb.GetEvents()[i]
			if s := strings.TrimSpace(string(ev["seq"])); s != strconv.FormatUint(le.GetSeq(), 10) {
				add("seq %d", i)
			}
			if str(ev, "type") != le.GetType() {
				add("type %d", i)
			}
			if ts, err := time.Parse(time.RFC3339Nano, str(ev, "ts")); err != nil || ts.UnixMilli() != le.GetTsUnixMs() {
				add("ts %d", i)
			}
			if str(ev, "turnId") != le.GetTurnId() {
				add("turnId %d", i)
			}
			payload, ok := ev["payload"]
			if !ok {
				payload = json.RawMessage("null")
			}
			if !linkJSONEqual(payload, le.GetPayloadJson()) {
				add("payload %d", i)
			}
			for name := range ev {
				switch name {
				case "seq", "type", "ts", "turnId", "payload":
				default:
					add("event_member %d: %s", i, name)
				}
			}
		}
		sort.Strings(diffs)
		return linkMirrorEvents, diffs
	}
	return "?", []string{"typed half is neither a Heartbeat nor an EventBatch"}
}

// linkJSONEqual compares two JSON texts as values: whitespace, member order, escapes and the spelling of a number do
// not count.
func linkJSONEqual(a, b []byte) bool {
	x, errX := linkJSONValue(a)
	y, errY := linkJSONValue(b)
	return errX == nil && errY == nil && linkValueEqual(x, y)
}

func linkJSONValue(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, fmt.Errorf("data after the value")
	}
	return v, nil
}

func linkValueEqual(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		if i, err := strconv.ParseInt(string(x), 10, 64); err == nil {
			j, err := strconv.ParseInt(string(y), 10, 64)
			return err == nil && i == j
		}
		f, errX := strconv.ParseFloat(string(x), 64)
		g, errY := strconv.ParseFloat(string(y), 64)
		return errX == nil && errY == nil && f == g
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !linkValueEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok || !linkValueEqual(v, w) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}

// ── The proxy ───────────────────────────────────────────────────────────────────────────────────

// fakeLinkProxy is an HTTP proxy that answers CONNECT. It tunnels by default; refuse makes it refuse with that
// status; mitm makes it end TLS itself, with mitmCert, and hand the requests inside to mitmHandler (nil: forward
// them to the target over TLS, which mitmRoots verifies).
type fakeLinkProxy struct {
	*httptest.Server
	mu          sync.Mutex
	connects    []string
	refuse      int
	mitmCert    *tls.Certificate
	mitmHandler http.Handler
}

func newFakeLinkProxy(t *testing.T) *fakeLinkProxy {
	t.Helper()
	p := &fakeLinkProxy{}
	p.Server = httptest.NewServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.Close)
	return p
}

// proxyFor is a proxy function that sends what goes to host through p, and everything else directly: NO_PROXY for
// the control plane.
func (p *fakeLinkProxy) proxyFor(host string) func(*http.Request) (*url.URL, error) {
	u, _ := url.Parse(p.URL)
	return func(r *http.Request) (*url.URL, error) {
		if r.URL.Host == host {
			return u, nil
		}
		return nil, nil
	}
}

func (p *fakeLinkProxy) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, "this proxy only tunnels", http.StatusMethodNotAllowed)
		return
	}
	p.mu.Lock()
	p.connects = append(p.connects, r.Host)
	refuse, cert, handler := p.refuse, p.mitmCert, p.mitmHandler
	p.mu.Unlock()
	if refuse != 0 {
		w.WriteHeader(refuse)
		return
	}
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	if cert != nil {
		tconn := tls.Server(&linkBufferedConn{Conn: conn, r: buf.Reader}, &tls.Config{Certificates: []tls.Certificate{*cert}})
		srv := &http.Server{Handler: handler}
		_ = srv.Serve(&linkOneConnListener{conn: tconn})
		return
	}
	target, err := net.Dial("tcp", r.Host)
	if err != nil {
		return
	}
	defer target.Close()
	go func() { _, _ = io.Copy(target, buf); _ = target.(*net.TCPConn).CloseWrite() }()
	_, _ = io.Copy(conn, target)
}

func (p *fakeLinkProxy) connected() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string{}, p.connects...)
}

// linkBufferedConn is a hijacked connection read through the buffer that already holds some of it.
type linkBufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *linkBufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// linkOneConnListener serves one connection, then says it is closed once that connection is.
type linkOneConnListener struct {
	conn net.Conn
	once sync.Once
	done chan struct{}
	mu   sync.Mutex
}

func (l *linkOneConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.done == nil {
		l.done = make(chan struct{})
	}
	done := l.done
	l.mu.Unlock()
	var c net.Conn
	l.once.Do(func() { c = &linkNotifyConn{Conn: l.conn, closed: done} })
	if c != nil {
		return c, nil
	}
	<-done
	return nil, net.ErrClosed
}
func (l *linkOneConnListener) Close() error   { return nil }
func (l *linkOneConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

type linkNotifyConn struct {
	net.Conn
	closed chan struct{}
	once   sync.Once
}

func (c *linkNotifyConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

// linkTestCert is a self-signed certificate for 127.0.0.1 and localhost: one no client trusts unless told to.
func linkTestCert(t *testing.T, name string) (*tls.Certificate, *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"},
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, leaf
}

// linkWebSocketAccept is the Sec-WebSocket-Accept a server answers key with (RFC 6455 §4.2.2).
func linkWebSocketAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// ── The runner side ─────────────────────────────────────────────────────────────────────────────

// linkTestLog collects what the shadow logs.
type linkTestLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *linkTestLog) log(args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, strings.TrimSuffix(fmt.Sprintln(args...), "\n"))
}

func (l *linkTestLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.lines...)
}

// newLinkTestClient is a link client for processID whose dials trust g and go through proxy (nil: none).
func newLinkTestClient(cp *fakeLinkControlPlane, processID string, roots *x509.CertPool, proxy func(*http.Request) (*url.URL, error)) *linkClient {
	c := newLinkClient(cp.URL, "runner-token", processID, func() *linkpb.Hello { return linkHello(processID) })
	c.api = &http.Client{Transport: newLinkHTTPTransport(nil, nil)}
	c.dial = &http.Client{Transport: newLinkHTTPTransport(proxy, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12})}
	return c
}

// linkTestRig is a runner's daemon transport against a control plane, with a shadow mirroring it to a gateway.
type linkTestRig struct {
	cp     *fakeLinkControlPlane
	g      *fakeLinkGateway
	t      *Transport
	shadow *linkShadow
	logs   *linkTestLog
	stop   func()
}

// newLinkTestRig builds the rig; start runs its shadow.
func newLinkTestRig(t *testing.T) *linkTestRig {
	t.Helper()
	g := newFakeLinkGateway(t)
	cp := newFakeLinkControlPlane(t, g.linkURL())
	tr := NewTransport(cp.URL, "runner-token")
	logs := &linkTestLog{}
	s := newLinkShadow(newLinkTestClient(cp, tr.leaseOwner, g.roots(), nil), logs.log)
	s.pingEvery, s.settleWait = 200*time.Millisecond, 2*time.Second
	if err := installLinkShadowTap(tr, s); err != nil {
		t.Fatal(err)
	}
	return &linkTestRig{cp: cp, g: g, t: tr, shadow: s, logs: logs}
}

func (r *linkTestRig) start(t *testing.T) {
	t.Helper()
	r.stop = r.shadow.start()
	t.Cleanup(r.stop)
}

// connected waits until the gateway has welcomed n connections.
func (r *linkTestRig) connected(t *testing.T, n int) {
	t.Helper()
	linkWaitFor(t, 10*time.Second, fmt.Sprintf("%d welcomed connections", n), func() bool {
		conns, _, _, _ := r.g.snapshot()
		welcomed := 0
		for _, c := range conns {
			r.g.mu.Lock()
			if !c.welcomed.IsZero() {
				welcomed++
			}
			r.g.mu.Unlock()
		}
		return welcomed >= n
	})
}
