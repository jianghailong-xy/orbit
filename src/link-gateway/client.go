package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	mrand "math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// clientMain is `link-gateway client`, a test runner for staging and drills: it trades a runner token for a link
// token (POST /api/runner/link-token), connects, says Hello, heartbeats, mirrors what it sends over HTTPS the way
// README.md's shadow comparison asks of a runner, and follows Drain by opening its next connection after the delay
// it was given and closing the old one once the new one is up. It reconnects with exponential backoff and full
// jitter (1 s to 60 s, never sooner than a refusal's Retry-After or a Close's retry_after_ms) and writes a JSON
// summary of what happened when it stops.
func clientMain(args []string) int {
	fs := flag.NewFlagSet("client", flag.ContinueOnError)
	var o clientOptions
	fs.StringVar(&o.api, "api", "", "the Orbit server's origin, such as http://127.0.0.1:18086 (required)")
	fs.StringVar(&o.runnerToken, "runner-token", os.Getenv("LINK_CLIENT_RUNNER_TOKEN"), "the runner token (default $LINK_CLIENT_RUNNER_TOKEN)")
	fs.StringVar(&o.linkURL, "link-url", "", "dial this instead of the linkUrl the token comes with")
	fs.StringVar(&o.caFile, "ca", "", "also trust this PEM CA for the link's TLS")
	fs.StringVar(&o.processID, "process-id", "", "the process identity (leaseOwner) to connect as (default: a new UUID)")
	fs.DurationVar(&o.duration, "duration", 0, "stop after this long (default: run until interrupted)")
	fs.IntVar(&o.untilDrains, "until-drains", 0, "stop after this many Drain → reconnect cycles")
	fs.DurationVar(&o.heartbeat, "heartbeat", 0, "heartbeat interval (default: the one Welcome gives)")
	fs.BoolVar(&o.mirror, "mirror", true, "send every heartbeat as a shadow mirror: the typed frame and the HTTP request it mirrors")
	fs.BoolVar(&o.httpBeats, "http", false, "send each heartbeat to the server over HTTPS first, and mirror only those it accepts")
	fs.IntVar(&o.events, "events", 0, "with each heartbeat, mirror a synthetic event batch of this many events (never sent over HTTPS)")
	fs.IntVar(&o.corruptEvery, "corrupt-every", 0, "alter the typed half of every Nth mirror, to see the gateway count a mismatch")
	fs.DurationVar(&o.refreshBefore, "refresh-before", 5*time.Minute, "open the next connection with a fresh token this long before the token expires")
	fs.StringVar(&o.summaryFile, "summary", "", "write the JSON summary here as well as to standard output")
	fs.StringVar(&o.captureFile, "capture", "", "append every frame sent and received to this file, length-delimited, for link-gateway dump")
	var d drillOptions
	fs.StringVar(&d.name, "drill", "", "run a drill instead: link, cancel, retry, slow, resume, relay, relay-begin or relay-finish against a gateway in MODE_LINK, or switch against one that follows RUNNER_LINK_REQUIRED (client_link.go)")
	fs.StringVar(&d.ownerEmail, "owner-email", "", "drills: the account that owns the runner, which creates and watches sessions")
	fs.StringVar(&d.ownerPasswordFile, "owner-password-file", "", "drills: a file holding that account's password")
	fs.StringVar(&d.natsURL, "nats-url", "", "drills: NATS, to read a session's live subject as the apiserver does")
	fs.StringVar(&d.natsSeedFile, "nats-seed-file", "", "drills: a file holding the apiserver's NATS nkey seed")
	fs.StringVar(&d.reportFile, "report", "", "drills: write the JSON report here as well as to standard output")
	fs.DurationVar(&d.runFor, "for", 40*time.Second, "the retry drill: how long to keep calling")
	fs.DurationVar(&d.cancelAfter, "cancel-after", 2*time.Second, "the cancel drill: how long a claim is left waiting before the connection drops")
	fs.StringVar(&d.workDir, "work-dir", "/srv/link-drill", "drills: the working directory of the workspace sessions are created in")
	fs.StringVar(&d.session, "session", "", "the retry and slow drills: a session this runner holds, as the link drill reports it")
	fs.StringVar(&d.relaySecrets, "relay-secrets", "", "the relay drills: a JSON file {\"code\", \"key\"} naming the Antigravity code and the Cursor key to hand over (client_relay.go)")
	fs.StringVar(&d.relayAttempt, "relay-attempt", "", "the relay-finish drill: the sign-in attempt relay-begin reported")
	fs.BoolVar(&d.relaySlowHolder, "relay-slow-holder", false, "the relay-finish drill: the process holding the code is paused when it starts")
	fs.StringVar(&d.relayHandshake, "relay-handshake", "", "the relay drills: relay-finish creates PATH.ready once connected and waits for PATH.go before its first heartbeat; relay writes the Cursor check's answer to PATH.answer for the script to post")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if o.api == "" || o.runnerToken == "" {
		fmt.Fprintln(os.Stderr, "client needs -api and a runner token (-runner-token or $LINK_CLIENT_RUNNER_TOKEN)")
		return 2
	}
	if o.processID == "" {
		o.processID = newUUID()
	}
	if d.name == "slow" {
		// The slow drill's own socket stays small; what it leaves unread fills the sockets on the way, then waits at
		// the gateway.
		o.readBuffer = 64 << 10
	}
	cl, err := newClient(o, slog.New(slog.NewTextHandler(os.Stderr, nil)).With("process", o.processID))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if o.duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, o.duration)
		defer cancel()
	}
	if d.name != "" {
		return runDrill(ctx, cl, d)
	}
	cl.run(ctx)
	return cl.finish()
}

type clientOptions struct {
	api, runnerToken, linkURL, caFile, processID string
	duration, heartbeat, refreshBefore           time.Duration
	untilDrains, events, corruptEvery            int
	mirror, httpBeats                            bool
	summaryFile, captureFile                     string
	// readBuffer is the link connection's socket receive buffer (SO_RCVBUF); 0 leaves it to the kernel.
	readBuffer int
}

// clientSummary is what the client reports when it stops.
type clientSummary struct {
	ProcessID            string         `json:"processId"`
	Connects             int            `json:"connects"`
	ConnectionIDs        []string       `json:"connectionIds"`
	Refusals             map[string]int `json:"refusals"`
	DialFailures         int            `json:"dialFailures"`
	HeartbeatsSent       int            `json:"heartbeatsSent"`
	HeartbeatAcks        int            `json:"heartbeatAcks"`
	HTTPHeartbeats       map[string]int `json:"httpHeartbeats"`
	MirrorsSent          map[string]int `json:"mirrorsSent"`
	CorruptedMirrors     int            `json:"corruptedMirrors"`
	RPCResults           map[string]int `json:"rpcResults"`
	Drains               int            `json:"drains"`
	DrainReconnectsMs    []int64        `json:"drainReconnectAfterMs"`
	ReconnectsAfterDrain int            `json:"reconnectsAfterDrain"`
	Closes               map[string]int `json:"closes"`
	LostConnections      int            `json:"lostConnections"`
	MaxGapMs             int64          `json:"maxGapMs"`
	Modes                map[string]int `json:"modes"`
}

type client struct {
	o       clientOptions
	log     *slog.Logger
	api     *http.Client
	dial    *http.Client
	capture io.Writer
	capMu   sync.Mutex
	// hello replaces the Hello the client says, and onRaw sees every frame it receives before pieces are joined: both
	// for drills (client_link.go).
	hello *linkpb.Hello
	onRaw func(*linkpb.Frame)
	// readPaused stops the client reading its connection at all, as a runner that is stuck does (the slow drill).
	readPaused atomic.Bool

	token       string
	tokenExpiry time.Time
	linkURL     string

	mirrors int
	seq     uint64
	session string
	sum     clientSummary
}

func newClient(o clientOptions, log *slog.Logger) (*client, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if o.caFile != "" {
		pem, err := os.ReadFile(o.caFile)
		if err != nil {
			return nil, err
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s holds no PEM certificate", o.caFile)
		}
	}
	transport := &http.Transport{
		Proxy:           http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	}
	api := transport.Clone()
	if o.readBuffer > 0 {
		transport.DialContext = (&net.Dialer{Control: setReadBuffer(o.readBuffer)}).DialContext
	}
	cl := &client{
		o: o, log: log,
		api:     &http.Client{Timeout: 30 * time.Second, Transport: api},
		dial:    &http.Client{Transport: transport},
		session: newUUID(),
		sum: clientSummary{
			ProcessID: o.processID, Refusals: map[string]int{}, HTTPHeartbeats: map[string]int{}, MirrorsSent: map[string]int{},
			RPCResults: map[string]int{}, Closes: map[string]int{}, Modes: map[string]int{}, ConnectionIDs: []string{}, DrainReconnectsMs: []int64{},
		},
	}
	if o.captureFile != "" {
		f, err := os.OpenFile(o.captureFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
		cl.capture = f
	}
	return cl, nil
}

// clientConn is one connection of the client.
type clientConn struct {
	ws      *websocket.Conn
	id      string
	welcome *linkpb.Welcome
	frames  chan *linkpb.Frame
	done    chan struct{}
	err     error
	outID   uint64
	closed  *linkpb.Close
	cancel  context.CancelFunc
}

// refusal is an upgrade the gateway answered with an HTTP status rather than a connection.
type refusal struct {
	status     int
	code       string
	retryAfter time.Duration
}

func (r *refusal) Error() string { return fmt.Sprintf("refused %d %s", r.status, r.code) }

func (cl *client) run(ctx context.Context) {
	var cur *clientConn
	attempt := 0
	var lostAt time.Time
	var reconnectAt time.Time // set by Drain, or ahead of the token's expiry
	var beat *time.Ticker
	beatC := func() <-chan time.Time {
		if beat == nil {
			return nil
		}
		return beat.C
	}
	stopBeat := func() {
		if beat != nil {
			beat.Stop()
			beat = nil
		}
	}
	defer func() {
		stopBeat()
		if cur != nil {
			cl.closeConn(cur)
		}
	}()
	adopt := func(cc *clientConn) {
		if cur != nil {
			cl.closeConn(cur)
		}
		cur = cc
		attempt = 0
		if cl.sum.Drains > cl.sum.ReconnectsAfterDrain {
			cl.sum.ReconnectsAfterDrain = cl.sum.Drains
			cl.log.Info("reconnected after Drain", "connection", cc.id, "cycles", cl.sum.ReconnectsAfterDrain)
		}
		reconnectAt = time.Time{}
		if !lostAt.IsZero() {
			if gap := time.Since(lostAt).Milliseconds(); gap > cl.sum.MaxGapMs {
				cl.sum.MaxGapMs = gap
			}
			lostAt = time.Time{}
		}
		stopBeat()
		interval := cl.o.heartbeat
		if interval <= 0 {
			interval = time.Duration(cc.welcome.GetHeartbeatIntervalMs()) * time.Millisecond
		}
		if interval <= 0 {
			interval = 30 * time.Second
		}
		beat = time.NewTicker(interval)
		if !cl.tokenExpiry.IsZero() {
			if at := cl.tokenExpiry.Add(-cl.o.refreshBefore); at.After(time.Now()) {
				reconnectAt = at
			}
		}
	}

	for ctx.Err() == nil {
		if cl.o.untilDrains > 0 && cl.sum.ReconnectsAfterDrain >= cl.o.untilDrains {
			return
		}
		if cur == nil {
			cc, err := cl.connect(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				wait := backoff(attempt)
				var ref *refusal
				if errors.As(err, &ref) && ref.retryAfter > wait {
					wait = ref.retryAfter
				}
				attempt++
				cl.log.Info("not connected; retrying", "err", err, "in", wait.Round(time.Millisecond))
				select {
				case <-ctx.Done():
					return
				case <-time.After(wait):
				}
				continue
			}
			adopt(cc)
			cl.heartbeat(cur)
		}

		var reconnect <-chan time.Time
		if !reconnectAt.IsZero() {
			reconnect = time.After(time.Until(reconnectAt))
		}
		select {
		case <-ctx.Done():
			return
		case <-beatC():
			cl.heartbeat(cur)
		case <-reconnect:
			// Make before break: the old connection keeps working until the new one has been welcomed.
			cc, err := cl.connect(ctx)
			if err != nil {
				cl.log.Info("next connection not open yet; keeping the current one", "err", err)
				reconnectAt = time.Now().Add(backoff(attempt))
				attempt++
				continue
			}
			adopt(cc)
			cl.heartbeat(cur)
		case f := <-cur.frames:
			switch body := f.GetBody().(type) {
			case *linkpb.Frame_HeartbeatAck:
				cl.sum.HeartbeatAcks++
				cl.sum.Modes[body.HeartbeatAck.GetMode().String()]++
			case *linkpb.Frame_RpcResult:
				code := "tunnel"
				if fl := body.RpcResult.GetFailure(); fl != nil {
					code = fl.GetCode()
				}
				cl.sum.RPCResults[code]++
			case *linkpb.Frame_Drain:
				cl.sum.Drains++
				delay := time.Duration(body.Drain.GetReconnectAfterMs()) * time.Millisecond
				cl.sum.DrainReconnectsMs = append(cl.sum.DrainReconnectsMs, delay.Milliseconds())
				reconnectAt = time.Now().Add(delay)
				cl.log.Info("Drain received", "connection", cur.id, "reconnect_after", delay)
			case *linkpb.Frame_Close:
				cl.sum.Closes[body.Close.GetCode().String()]++
				cl.log.Info("Close received", "connection", cur.id, "code", body.Close.GetCode().String(),
					"message", body.Close.GetMessage(), "retry_after_ms", body.Close.GetRetryAfterMs())
			}
		case <-cur.done:
			closed := cur.closed
			cl.log.Info("connection ended", "connection", cur.id, "err", cur.err)
			cur.cancel()
			cur = nil
			stopBeat()
			lostAt = time.Now()
			wait := backoff(attempt)
			attempt++
			if closed != nil {
				switch closed.GetCode() {
				case linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED:
					cl.token = ""
				case linkpb.CloseCode_CLOSE_CODE_SUPERSEDED:
					// Another connection of this process took over; that one carries on.
				}
				if ra := time.Duration(closed.GetRetryAfterMs()) * time.Millisecond; ra > wait {
					wait = ra
				}
			} else {
				cl.sum.LostConnections++
			}
			if !reconnectAt.IsZero() && time.Until(reconnectAt) > wait {
				// A Drain told this process when to come back.
				wait = time.Until(reconnectAt)
			}
			reconnectAt = time.Time{}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}
}

// backoff is the delay before attempt n: exponential from 1 s to 60 s, with full jitter.
func backoff(n int) time.Duration {
	ceiling := time.Second << min(n, 6)
	if ceiling > time.Minute {
		ceiling = time.Minute
	}
	return time.Duration(mrand.Int64N(int64(ceiling))) + time.Millisecond
}

// mintToken trades the runner token for a link token.
func (cl *client) mintToken(ctx context.Context) error {
	body, _ := json.Marshal(map[string]string{"leaseOwner": cl.o.processID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cl.o.api+"/api/runner/link-token", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cl.o.runnerToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := cl.api.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("POST /api/runner/link-token answered %d: %s", resp.StatusCode, bytes.TrimSpace(b))
	}
	var tok struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
		LinkURL   string `json:"linkUrl"`
	}
	if err := json.Unmarshal(b, &tok); err != nil {
		return err
	}
	cl.token = tok.Token
	cl.tokenExpiry, _ = time.Parse(time.RFC3339Nano, tok.ExpiresAt)
	cl.linkURL = tok.LinkURL
	if cl.o.linkURL != "" {
		cl.linkURL = cl.o.linkURL
	}
	return nil
}

// setReadBuffer sets a socket's receive buffer before it connects, so the window the connection opens with is that
// small, and the kernel does not grow it.
func setReadBuffer(n int) func(network, address string, rc syscall.RawConn) error {
	return func(_, _ string, rc syscall.RawConn) error {
		var err error
		if cerr := rc.Control(func(fd uintptr) {
			err = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, n)
		}); cerr != nil {
			return cerr
		}
		return err
	}
}

// connect opens one connection and waits for Welcome.
func (cl *client) connect(ctx context.Context) (*clientConn, error) {
	if cl.token == "" || time.Until(cl.tokenExpiry) < time.Minute {
		if err := cl.mintToken(ctx); err != nil {
			cl.sum.DialFailures++
			return nil, err
		}
	}
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	ws, resp, err := websocket.Dial(dctx, cl.linkURL, &websocket.DialOptions{
		HTTPClient: cl.dial,
		HTTPHeader: http.Header{"Authorization": {"Bearer " + cl.token}},
	})
	cancel()
	if err != nil {
		cl.sum.DialFailures++
		if resp != nil {
			ref := &refusal{status: resp.StatusCode}
			var body struct {
				Code string `json:"code"`
			}
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			_ = json.Unmarshal(b, &body)
			ref.code = body.Code
			if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
				ref.retryAfter = time.Duration(s) * time.Second
			}
			cl.sum.Refusals[strconv.Itoa(resp.StatusCode)]++
			if resp.StatusCode == http.StatusUnauthorized {
				cl.token = ""
			}
			return nil, ref
		}
		return nil, err
	}
	ws.SetReadLimit(maxChunkedFrameBytes)
	cctx, ccancel := context.WithCancel(context.Background())
	cc := &clientConn{ws: ws, frames: make(chan *linkpb.Frame, 64), done: make(chan struct{}), cancel: ccancel}
	hello := cl.hello
	if hello == nil {
		hello = &linkpb.Hello{
			ProcessId: cl.o.processID, RunnerVersion: "link-gateway-client/" + version, Os: runtime.GOOS,
			MinProtocolVersion: 1, MaxProtocolVersion: 1,
		}
	}
	if err := cl.send(cc, &linkpb.Frame{Body: &linkpb.Frame_Hello{Hello: hello}}); err != nil {
		ccancel()
		_ = ws.CloseNow()
		return nil, err
	}
	go cl.readLoop(cctx, cc)
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			cl.closeConn(cc)
			return nil, ctx.Err()
		case <-timer.C:
			cl.closeConn(cc)
			return nil, errors.New("no Welcome within 10s")
		case <-cc.done:
			if cc.closed != nil {
				cl.sum.Closes[cc.closed.GetCode().String()]++
				return nil, &refusal{code: cc.closed.GetCode().String(), retryAfter: time.Duration(cc.closed.GetRetryAfterMs()) * time.Millisecond}
			}
			return nil, fmt.Errorf("closed before Welcome: %v", cc.err)
		case f := <-cc.frames:
			w := f.GetWelcome()
			if w == nil {
				continue
			}
			cc.welcome, cc.id = w, w.GetConnectionId()
			cl.sum.Connects++
			cl.sum.ConnectionIDs = append(cl.sum.ConnectionIDs, cc.id)
			cl.log.Info("connected", "connection", cc.id, "mode", w.GetMode().String(), "heartbeat_ms", w.GetHeartbeatIntervalMs())
			return cc, nil
		}
	}
}

func (cl *client) readLoop(ctx context.Context, cc *clientConn) {
	defer close(cc.done)
	var chunks reassembler
	defer chunks.close()
	for {
		for cl.readPaused.Load() && ctx.Err() == nil {
			time.Sleep(10 * time.Millisecond)
		}
		_, data, err := cc.ws.Read(ctx)
		if err != nil {
			cc.err = err
			return
		}
		f := &linkpb.Frame{}
		if err := proto.Unmarshal(data, f); err != nil {
			cc.err = err
			return
		}
		cl.record(f)
		if cl.onRaw != nil {
			cl.onRaw(f)
		}
		if c := f.GetChunk(); c != nil {
			joined, err := chunks.add(c)
			if err != nil {
				cc.err = err
				return
			}
			if joined == nil {
				continue
			}
			f = joined
		}
		if c := f.GetClose(); c != nil {
			cc.closed = c
		}
		select {
		case cc.frames <- f:
		case <-ctx.Done():
			return
		}
	}
}

func (cl *client) send(cc *clientConn, f *linkpb.Frame) error {
	cc.outID++
	f.Id = cc.outID
	msgs, err := encodeFrame(f, maxFrameBytes, func() uint64 { cc.outID++; return cc.outID })
	if err != nil {
		return err
	}
	for _, b := range msgs {
		ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
		err := cc.ws.Write(ctx, websocket.MessageBinary, b)
		cancel()
		if err != nil {
			return err
		}
	}
	cl.record(f)
	return nil
}

func (cl *client) record(f *linkpb.Frame) {
	if cl.capture == nil {
		return
	}
	cl.capMu.Lock()
	defer cl.capMu.Unlock()
	_, _ = protodelim.MarshalTo(cl.capture, f)
}

func (cl *client) closeConn(cc *clientConn) {
	_ = cc.ws.Close(websocket.StatusNormalClosure, "")
	cc.cancel()
}

// heartbeat sends one beat. With -mirror it is a mirror (README.md): the body an HTTP heartbeat carries, sent over
// HTTPS first with -http, then the typed Heartbeat built from that body and the Rpc carrying the body itself.
func (cl *client) heartbeat(cc *clientConn) {
	body := map[string]any{
		"status": "ONLINE", "idleCapacity": 2, "version": "link-gateway-client/" + version,
		"leaseOwner": cl.o.processID, "supervisedSessionIds": []string{cl.session},
		"runtimeDefaultModels": map[string]string{"claude": "claude-opus-5-5"},
		"commands":             []map[string]any{{"name": "review", "description": "Review <changes> & report"}},
		"reposRoot":            "/srv/repos/é",
	}
	raw, _ := json.Marshal(body)
	if cl.o.httpBeats {
		if err := cl.postHeartbeat(raw); err != nil {
			cl.sum.HTTPHeartbeats["failed"]++
			cl.log.Info("HTTP heartbeat failed; not mirrored", "err", err)
			return
		}
		cl.sum.HTTPHeartbeats["ok"]++
	}
	hb := heartbeatFromBody(raw)
	if !cl.o.mirror {
		if cl.send(cc, &linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}}) == nil {
			cl.sum.HeartbeatsSent++
		}
		return
	}
	cl.mirrors++
	if cl.corrupt() {
		hb.IdleCapacity++
	}
	if cl.sendMirror(cc, &linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}}, "POST", "/runner/heartbeat", raw) {
		cl.sum.HeartbeatsSent++
		cl.sum.MirrorsSent["heartbeat"]++
	}
	if cl.o.events > 0 {
		cl.mirrors++
		eb, rawEvents := cl.syntheticEvents()
		if cl.corrupt() {
			eb.Events[0].Type += "-altered"
		}
		if cl.sendMirror(cc, &linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: eb}}, "POST", "/runner/sessions/"+cl.session+"/events", rawEvents) {
			cl.sum.MirrorsSent["events"]++
		}
	}
}

func (cl *client) corrupt() bool {
	if cl.o.corruptEvery > 0 && cl.mirrors%cl.o.corruptEvery == 0 {
		cl.sum.CorruptedMirrors++
		return true
	}
	return false
}

// sendMirror sends the typed half and then the raw half, whose request_id names the typed frame.
func (cl *client) sendMirror(cc *clientConn, typed *linkpb.Frame, method, path string, body []byte) bool {
	if err := cl.send(cc, typed); err != nil {
		return false
	}
	rpc := &linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{
		RequestId: fmt.Sprintf("%s%s:%d", shadowPrefix, cc.id, typed.GetId()),
		Body:      &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: method, Path: path, JsonBody: body}},
	}}}
	return cl.send(cc, rpc) == nil
}

func (cl *client) postHeartbeat(body []byte) error {
	req, err := http.NewRequest(http.MethodPost, cl.o.api+"/api/runner/heartbeat", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cl.o.runnerToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := cl.api.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("POST /api/runner/heartbeat answered %d", resp.StatusCode)
	}
	return nil
}

// heartbeatFromBody builds the typed Heartbeat a mirror carries from the HTTP heartbeat body, by README.md's rules:
// four members become typed fields, status and version stay with the connection, and every other member becomes a
// Fact carrying its JSON whole.
func heartbeatFromBody(body []byte) *linkpb.Heartbeat {
	var m map[string]json.RawMessage
	_ = json.Unmarshal(body, &m)
	hb := &linkpb.Heartbeat{
		ProcessId: stringMember(m, "leaseOwner"),
	}
	if n, ok := numberMember(m, "idleCapacity"); ok {
		v, _ := strconv.ParseUint(n, 10, 32)
		hb.IdleCapacity = uint32(v)
	}
	hb.Draining, _ = boolMember(m, "draining")
	hb.SessionIds, _ = stringsMember(m, "supervisedSessionIds")
	names := make([]string, 0, len(m))
	for name := range m {
		if !heartbeatTypedMembers[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		sum := sha256.Sum256(m[name])
		hb.Facts = append(hb.Facts, &linkpb.Fact{Kind: name, Sha256: hex.EncodeToString(sum[:]), Json: m[name]})
	}
	return hb
}

// syntheticEvents is one event batch of the HTTP body's shape and the EventBatch mirroring it. The payloads hold
// what encoders treat differently (<, > and &, non-ASCII, whitespace), and the typed payloads are written by
// another encoder than the body, so a comparison that is not by JSON value would count them as different.
func (cl *client) syntheticEvents() (*linkpb.EventBatch, []byte) {
	type httpEvent struct {
		Seq     uint64         `json:"seq"`
		Type    string         `json:"type"`
		TS      string         `json:"ts"`
		TurnID  string         `json:"turnId,omitempty"`
		Payload map[string]any `json:"payload"`
	}
	turn := newUUID()
	var events []httpEvent
	eb := &linkpb.EventBatch{SessionId: cl.session}
	for i := 0; i < cl.o.events; i++ {
		cl.seq++
		now := time.Now().UTC()
		payload := map[string]any{
			"text":   fmt.Sprintf("<b>step %d</b> & \"quotes\" → naïve café 中文", cl.seq),
			"nested": map[string]any{"n": 1.5, "list": []any{1, "two", nil, true}},
		}
		ev := httpEvent{Seq: cl.seq, Type: "assistant", TS: now.Format("2006-01-02T15:04:05.000Z07:00"), TurnID: turn, Payload: payload}
		events = append(events, ev)
		var typed bytes.Buffer
		enc := json.NewEncoder(&typed)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		_ = enc.Encode(payload)
		eb.Events = append(eb.Events, &linkpb.Event{
			Seq: ev.Seq, Type: ev.Type, TsUnixMs: now.Truncate(time.Millisecond).UnixMilli(), TurnId: turn, PayloadJson: typed.Bytes(),
		})
	}
	raw, _ := json.Marshal(map[string]any{"leaseOwner": cl.o.processID, "events": events})
	return eb, raw
}

func (cl *client) finish() int {
	b, _ := json.MarshalIndent(cl.sum, "", "  ")
	fmt.Println(string(b))
	if cl.o.summaryFile != "" {
		_ = os.WriteFile(cl.o.summaryFile, append(b, '\n'), 0o644)
	}
	if c, ok := cl.capture.(io.Closer); ok {
		_ = c.Close()
	}
	if cl.sum.Connects == 0 {
		return 1
	}
	if cl.o.untilDrains > 0 && cl.sum.ReconnectsAfterDrain < cl.o.untilDrains {
		return 1
	}
	return 0
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
