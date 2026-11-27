package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	mrand "math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The runner link client (docs/runner-link-design.md §5.4, §7): the one WebSocket a runner keeps to its cell's link
// gateway. It trades the runner token for a connection token over HTTPS (POST /api/runner/link-token), dials the
// link over TLS through whatever proxy HTTPS_PROXY names, says Hello and reads Welcome. What a connection carries
// and when the next one is opened belong to whoever drives it: the runner's work (link_work.go), or `orbit doctor`.
//
// Nothing here logs: `orbit doctor` dials with it too, and prints what it found on its own.

const (
	linkProtocolVersion = 1
	// linkDialTimeout bounds the TCP connection, the proxy's tunnel, the TLS handshake and the upgrade, together.
	linkDialTimeout = 15 * time.Second
	// linkWelcomeTimeout is how long after Hello the gateway may take to answer it.
	linkWelcomeTimeout = 10 * time.Second
	// linkTokenTimeout bounds one POST /api/runner/link-token.
	linkTokenTimeout = 30 * time.Second
	// linkRenewBefore is how long before its token expires a connection is replaced. Version 0 of the gateway
	// cannot renew a token inside a connection (no TokenRefresh), and closes the connection when it expires, so the
	// next connection is opened with a fresh token first: make before break.
	linkRenewBefore = 5 * time.Minute
	// The reconnect backoff: exponential from linkBackoffMin to linkBackoffMax, with full jitter (§7).
	linkBackoffMin = time.Second
	linkBackoffMax = time.Minute
	// linkLongWait is how long a runner waits before asking again when asking sooner cannot help: the server has no
	// runner link (POST /api/runner/link-token answers 404), or the gateway speaks no protocol version this binary
	// does (CLOSE_CODE_UPGRADE_REQUIRED, which a self-update ends).
	linkLongWait = 15 * time.Minute
)

// linkToken is a connection token (src/apiserver/src/runner-api/runner-link-token.ts) and where it leads.
type linkToken struct {
	token   string
	linkURL string
	// mintedAt is when this process received the token, by its own clock; lifetime is exp - iat from the token's
	// claims, by the server's. Together they say when the gateway ends a connection the token opened, whatever this
	// machine's clock says the time is.
	mintedAt time.Time
	lifetime time.Duration
}

// renewAt is when a connection opened with this token is to be replaced by one opened with a fresh token:
// linkRenewBefore ahead of its expiry, or halfway through a token that lives less than twice that.
func (k *linkToken) renewAt() time.Time {
	return k.mintedAt.Add(k.lifetime - min(linkRenewBefore, k.lifetime/2))
}

// linkHTTPError is an HTTP answer the link did not want: to the link-token request, or to the upgrade.
type linkHTTPError struct {
	op     string // "POST /api/runner/link-token", or "upgrade"
	status int
	// code is the JSON body's code, when it has one: the gateway names every refusal (src/link-gateway/README.md,
	// Handshake), and the control plane names most.
	code   string
	reason string // the gateway's refusal reason, for 401 UNAUTHENTICATED
	// retryAfter is the longer of the Retry-After header and the body's retryAfterMs.
	retryAfter time.Duration
	// detail is the start of a body that named no code, for the log.
	detail string
}

func (e *linkHTTPError) Error() string {
	msg := fmt.Sprintf("%s answered %d", e.op, e.status)
	if e.code != "" {
		msg += " " + e.code
	}
	if e.reason != "" {
		msg += " (" + e.reason + ")"
	}
	if e.code == "" && e.detail != "" {
		msg += ": " + e.detail
	}
	return msg
}

func newLinkHTTPError(op string, resp *http.Response, body []byte) *linkHTTPError {
	e := &linkHTTPError{op: op, status: resp.StatusCode}
	var refusal struct {
		Code         string `json:"code"`
		Reason       string `json:"reason"`
		RetryAfterMs int64  `json:"retryAfterMs"`
	}
	if json.Unmarshal(body, &refusal) == nil {
		e.code, e.reason = refusal.Code, refusal.Reason
		e.retryAfter = time.Duration(refusal.RetryAfterMs) * time.Millisecond
	}
	if s, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && time.Duration(s)*time.Second > e.retryAfter {
		e.retryAfter = time.Duration(s) * time.Second
	}
	if e.code == "" {
		e.detail = firstLine(strings.TrimSpace(string(body)))
		if len(e.detail) > 200 {
			e.detail = e.detail[:200]
		}
	}
	return e
}

// linkCloseError is a Close the gateway answered Hello with, in place of Welcome.
type linkCloseError struct {
	code       linkpb.CloseCode
	message    string
	retryAfter time.Duration
}

func (e *linkCloseError) Error() string {
	return fmt.Sprintf("the gateway closed the connection before Welcome: %s %s", e.code, e.message)
}

// errLinkNoWelcome wraps the failures between an upgrade that succeeded and Welcome: something let the WebSocket
// open and then did not carry it.
var errLinkNoWelcome = errors.New("the WebSocket opened but no Welcome came back")

// linkNotConfigured reports whether err is the control plane saying it has no runner link: 404 from
// POST /api/runner/link-token, whether RUNNER_LINK_NOT_CONFIGURED or a server older than the route.
func linkNotConfigured(err error) bool {
	var e *linkHTTPError
	return errors.As(err, &e) && e.op == linkTokenRoute && e.status == http.StatusNotFound
}

const linkTokenRoute = "POST /api/runner/link-token"

// linkBackoff is the wait before reconnect attempt n (from 0): exponential from linkBackoffMin to linkBackoffMax,
// with full jitter, so the runners a gateway lost at once do not all come back at once (§10).
func linkBackoff(n int) time.Duration {
	ceiling := linkBackoffMin << min(n, 6)
	if ceiling > linkBackoffMax {
		ceiling = linkBackoffMax
	}
	return time.Duration(mrand.Int64N(int64(ceiling))) + time.Millisecond
}

// linkRetryWait is the wait before reconnect attempt n after err: the backoff, never sooner than a refusal's
// Retry-After or a Close's retry_after_ms, and about linkLongWait when asking sooner cannot help.
func linkRetryWait(err error, n int) time.Duration {
	wait := linkBackoff(n)
	var refused *linkHTTPError
	var closed *linkCloseError
	switch {
	case linkNotConfigured(err):
		return linkLongWaitJittered()
	case errors.As(err, &refused):
		wait = max(wait, refused.retryAfter)
	case errors.As(err, &closed):
		if closed.code == linkpb.CloseCode_CLOSE_CODE_UPGRADE_REQUIRED {
			return linkLongWaitJittered()
		}
		wait = max(wait, closed.retryAfter)
	}
	return wait
}

// linkLongWaitJittered is linkLongWait give or take a quarter, so runners that started together do not keep asking
// together.
func linkLongWaitJittered() time.Duration {
	return linkLongWait*3/4 + time.Duration(mrand.Int64N(int64(linkLongWait/2)))
}

// linkClient opens connections for one process: the runner token it trades, the process identity its tokens and
// Hellos name, and the HTTP clients of its own it does that with. It holds the newest token, reusing it until the
// token is due for renewal.
type linkClient struct {
	serverURL   string
	runnerToken string
	processID   string
	hello       func() *linkpb.Hello
	// api carries the link-token requests and dial the upgrades: pools of their own, never the work path's
	// (Transport.client). See newLinkHTTPTransport.
	api  *http.Client
	dial *http.Client
	now  func() time.Time

	mu  sync.Mutex
	tok *linkToken
	// nextURL, after a Redirect that brought no token, is where the connection opened with the next token goes in
	// place of the link address that token names.
	nextURL string
}

func newLinkClient(serverURL, runnerToken, processID string, hello func() *linkpb.Hello) *linkClient {
	return &linkClient{
		serverURL: strings.TrimRight(serverURL, "/"), runnerToken: runnerToken, processID: processID, hello: hello,
		api:  &http.Client{Transport: newLinkHTTPTransport(http.ProxyFromEnvironment, nil)},
		dial: &http.Client{Transport: newLinkHTTPTransport(http.ProxyFromEnvironment, nil)},
		now:  time.Now,
	}
}

// newLinkHTTPTransport is a transport of the link's own. It goes through the proxy that HTTPS_PROXY, HTTP_PROXY
// and NO_PROXY name (proxy), verifies TLS against the system's roots (which SSL_CERT_FILE replaces where it is
// set) or roots when they are given, and speaks HTTP/1.1 only: a TLSClientConfig of its own turns off net/http's
// automatic HTTP/2, and a WebSocket upgrade is an HTTP/1.1 request.
//
// It keeps no connection idle: each request is dialled for, so a WebSocket opens on the socket dialled for it, which
// is counted (link_socket.go). A request asking to switch protocols goes without "Connection: close". The link-token
// requests come about once an hour, so nothing is lost by it.
func newLinkHTTPTransport(proxy func(*http.Request) (*url.URL, error), tlsConfig *tls.Config) *http.Transport {
	if tlsConfig == nil {
		tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &http.Transport{
		Proxy:                 proxy,
		DialContext:           linkSocketDialer(&net.Dialer{Timeout: linkDialTimeout, KeepAlive: 30 * time.Second}),
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   linkDialTimeout,
		ResponseHeaderTimeout: linkDialTimeout,
		DisableKeepAlives:     true,
	}
}

// token is a token to connect with: the one in hand until it is due for renewal, else a fresh one.
func (c *linkClient) token(ctx context.Context) (*linkToken, error) {
	c.mu.Lock()
	tok := c.tok
	c.mu.Unlock()
	if tok != nil && c.now().Before(tok.renewAt()) {
		return tok, nil
	}
	fresh, err := c.mintToken(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.nextURL != "" {
		fresh.linkURL, c.nextURL = c.nextURL, ""
	}
	c.tok = fresh
	c.mu.Unlock()
	return fresh, nil
}

// forget drops tok, which the gateway refused, so the next connection is opened with a fresh one.
func (c *linkClient) forget(tok *linkToken) {
	c.mu.Lock()
	if c.tok == tok {
		c.tok = nil
	}
	c.mu.Unlock()
}

// mintToken trades the runner token for a connection token naming this process (POST /api/runner/link-token). The
// request carries what the runner authentication guard reads: the credential, and a managed instance's identity.
func (c *linkClient) mintToken(ctx context.Context) (*linkToken, error) {
	ctx, cancel := context.WithTimeout(ctx, linkTokenTimeout)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"leaseOwner": c.processID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.serverURL+"/api/runner/link-token", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set(runnerCLIVersionHeader, version)
	req.Header.Set("authorization", "Bearer "+c.runnerToken)
	setManagedInstanceHeaders(req.Header)
	resp, err := c.api.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", linkTokenRoute, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, fmt.Errorf("%s: reading the answer: %w", linkTokenRoute, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, newLinkHTTPError(linkTokenRoute, resp, data)
	}
	var out struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
		LinkURL   string `json:"linkUrl"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.Token == "" || out.LinkURL == "" {
		return nil, fmt.Errorf("%s: the answer holds no token and link address", linkTokenRoute)
	}
	now := c.now()
	lifetime, ok := linkTokenLifetime(out.Token)
	if !ok {
		// Not a token this binary can read the claims of: take the expiry as this machine's clock reads it.
		expires, err := time.Parse(time.RFC3339Nano, out.ExpiresAt)
		if err != nil || !expires.After(now) {
			return nil, fmt.Errorf("%s: the token's lifetime cannot be read", linkTokenRoute)
		}
		lifetime = expires.Sub(now)
	}
	return &linkToken{token: out.Token, linkURL: out.LinkURL, mintedAt: now, lifetime: lifetime}, nil
}

// linkTokenLifetime is exp - iat from a compact JWS's claims. The signature is not checked here: the token came from
// the control plane over HTTPS, and the gateway is what verifies it.
func linkTokenLifetime(token string) (time.Duration, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, false
	}
	var claims struct {
		Iat int64 `json:"iat"`
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp <= claims.Iat {
		return 0, false
	}
	return time.Duration(claims.Exp-claims.Iat) * time.Second, true
}

// connect opens one connection: a token, the upgrade, Hello and Welcome. onFrame is told every frame the gateway
// sends after Welcome, from the connection's reading goroutine.
func (c *linkClient) connect(ctx context.Context, onFrame func(*linkConn, *linkpb.Frame)) (*linkConn, error) {
	tok, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	conn, err := dialLink(ctx, c.dial, tok.linkURL, tok.token, c.hello(), onFrame)
	var refused *linkHTTPError
	var closed *linkCloseError
	if (errors.As(err, &refused) && refused.status == http.StatusUnauthorized) ||
		(errors.As(err, &closed) && closed.code == linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED) {
		c.forget(tok)
	}
	if err != nil {
		return nil, err
	}
	conn.token = tok
	return conn, nil
}

// linkConn is one open connection: welcomed, with its own goroutine reading it until it ends.
type linkConn struct {
	ws      *websocket.Conn
	id      string // Welcome.connection_id, which the gateway's log lines carry too
	welcome *linkpb.Welcome
	token   *linkToken

	// writeMu is held for each message written, and for every message of a frame but an EventBatch. bulkMu is held
	// for the whole of an EventBatch, which takes writeMu one message at a time, so that the other frames go between
	// its pieces; and by trySend, so that a live frame never does. Taken in that order, bulkMu first.
	writeMu sync.Mutex
	bulkMu  sync.Mutex
	lastID  uint64 // the id of the last message sent, guarded by writeMu

	// sock is the socket the connection was dialled on, counted (link_socket.go). writes is the context every write
	// after Hello goes with, which the watchdog cancels once a write has made no progress for linkWriteStallLimit;
	// stopWrites cancels it.
	sock       *linkSocket
	writes     context.Context
	stopWrites context.CancelFunc
	// failure is why the connection was taken for dead, for a deadline or a write that made no progress (the watchdog,
	// the pinger): the first one recorded wins, and it is recorded before the connection is closed.
	failure atomic.Pointer[string]

	done    chan struct{} // closed when reading stops, which is when the connection has ended
	err     error         // why reading stopped; read it after done
	closed  atomic.Pointer[linkpb.Close]
	onFrame func(*linkConn, *linkpb.Frame)
}

// dialLink opens a connection to linkURL with token, says hello and waits for Welcome. An upgrade refused with an
// HTTP status comes back as a *linkHTTPError, and a Close in place of Welcome as a *linkCloseError.
func dialLink(ctx context.Context, client *http.Client, linkURL, token string, hello *linkpb.Hello,
	onFrame func(*linkConn, *linkpb.Frame)) (*linkConn, error) {
	slot := &linkSocketSlot{}
	dctx, cancel := context.WithTimeout(context.WithValue(ctx, linkSocketSlotKey{}, slot), linkDialTimeout)
	ws, resp, err := websocket.Dial(dctx, linkURL, &websocket.DialOptions{
		HTTPClient:      client,
		HTTPHeader:      http.Header{"Authorization": {"Bearer " + token}},
		CompressionMode: websocket.CompressionDisabled,
	})
	cancel()
	if err != nil {
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			var body []byte
			if resp.Body != nil {
				body, _ = io.ReadAll(io.LimitReader(resp.Body, 4096))
			}
			return nil, newLinkHTTPError("upgrade", resp, body)
		}
		return nil, err
	}
	sock := slot.s.Load()
	if sock == nil {
		// The transport keeps no connection idle (newLinkHTTPTransport), so this is a transport that is not the link's.
		_ = ws.CloseNow()
		return nil, errors.New("the WebSocket did not open on a connection dialled for it")
	}
	ws.SetReadLimit(linkMaxFrameBytes)
	c := &linkConn{ws: ws, sock: sock, done: make(chan struct{}), onFrame: onFrame}
	c.writes, c.stopWrites = context.WithCancel(context.Background())
	// Hello goes before anything reads the connection, so it is bounded as Welcome is.
	wctx, cancel := context.WithTimeout(ctx, linkWelcomeTimeout)
	defer cancel()
	c.writeMu.Lock()
	_, err = c.sendLocked(wctx, &linkpb.Frame{Body: &linkpb.Frame_Hello{Hello: hello}})
	c.writeMu.Unlock()
	if err != nil {
		c.stopWrites()
		_ = ws.CloseNow()
		if wctx.Err() != nil && ctx.Err() == nil {
			return nil, fmt.Errorf("%w: Hello could not be sent within %s", errLinkNoWelcome, linkWelcomeTimeout)
		}
		return nil, fmt.Errorf("%w: sending Hello: %v", errLinkNoWelcome, err)
	}
	var chunks linkReassembler
	for {
		f, err := c.readFrame(wctx, &chunks)
		if err != nil {
			c.stopWrites()
			_ = ws.CloseNow()
			if wctx.Err() != nil && ctx.Err() == nil {
				return nil, fmt.Errorf("%w within %s", errLinkNoWelcome, linkWelcomeTimeout)
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if websocket.CloseStatus(err) != -1 {
				// A WebSocket close: the gateway ended the connection itself, saying why.
				return nil, fmt.Errorf("closed before Welcome: %w", err)
			}
			return nil, fmt.Errorf("%w: %v", errLinkNoWelcome, err)
		}
		if f == nil {
			continue // a piece of a frame
		}
		if cl := f.GetClose(); cl != nil {
			c.stopWrites()
			_ = ws.CloseNow()
			return nil, &linkCloseError{code: cl.GetCode(), message: cl.GetMessage(),
				retryAfter: time.Duration(cl.GetRetryAfterMs()) * time.Millisecond}
		}
		if w := f.GetWelcome(); w != nil {
			c.welcome, c.id = w, w.GetConnectionId()
			go c.readLoop(chunks)
			go c.watch()
			return c, nil
		}
		// Anything else ahead of Welcome is a body this binary does not take there; it is ignored, as the protocol
		// asks of a body the receiver does not know.
	}
}

// readFrame reads one message: the frame it carries, or nil for a piece of a frame still missing others.
func (c *linkConn) readFrame(ctx context.Context, chunks *linkReassembler) (*linkpb.Frame, error) {
	typ, data, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	var f linkpb.Frame
	if typ != websocket.MessageBinary || proto.Unmarshal(data, &f) != nil {
		return nil, errors.New("a message that is not a link frame")
	}
	if piece := f.GetChunk(); piece != nil {
		return chunks.add(piece)
	}
	return &f, nil
}

// readLoop reads the connection until it ends, which also answers the gateway's pings, and hands every frame to
// onFrame. A Close is kept for whoever handles the end: the WebSocket close follows it. A panic ends the connection
// rather than the runner: it is the connection's error.
func (c *linkConn) readLoop(chunks linkReassembler) {
	defer close(c.done)
	defer c.stopWrites()
	defer func() {
		if r := recover(); r != nil {
			c.err = fmt.Errorf("panic reading the connection: %v", r)
			_ = c.ws.CloseNow()
		}
	}()
	for {
		f, err := c.readFrame(context.Background(), &chunks)
		if err != nil {
			c.err = err
			_ = c.ws.CloseNow()
			return
		}
		if f == nil {
			continue
		}
		if cl := f.GetClose(); cl != nil {
			c.closed.Store(cl)
		}
		if c.onFrame != nil {
			c.onFrame(c, f)
		}
	}
}

// send writes f, cut into Chunks of at most linkSendPieceBytes when it is larger, and returns the id it gave f. An
// EventBatch lets every other frame but a live one go between its pieces (sendBulk); any other frame goes in one piece
// after another, nothing between them. A write has no deadline of its own: it ends the connection when it fails, or
// when it has made no progress for linkWriteStallLimit with nothing read meanwhile (watch), however long it takes
// while it moves.
func (c *linkConn) send(f *linkpb.Frame) (uint64, error) {
	if _, bulk := f.GetBody().(*linkpb.Frame_EventBatch); bulk {
		return c.sendBulk(f)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.sendLocked(c.writes, f)
}

// trySend writes f only when nothing else is being written on the connection, an EventBatch between its pieces
// included, and reports whether it did: what a live stream frame takes, so that it never holds up a control frame or a
// call behind it (§5.1). The caller drops or keeps a frame that did not go.
func (c *linkConn) trySend(f *linkpb.Frame) (bool, error) {
	if !c.bulkMu.TryLock() {
		return false, nil
	}
	defer c.bulkMu.Unlock()
	if !c.writeMu.TryLock() {
		return false, nil
	}
	defer c.writeMu.Unlock()
	_, err := c.sendLocked(c.writes, f)
	return err == nil, err
}

// sendLocked writes every message of f, with writeMu held.
func (c *linkConn) sendLocked(ctx context.Context, f *linkpb.Frame) (uint64, error) {
	c.lastID++
	f.Id = c.lastID
	pieces, err := newLinkPieces(f, linkSendPieceBytes)
	if err != nil {
		return 0, err
	}
	for !pieces.done() {
		if err := c.writePiece(ctx, pieces); err != nil {
			return 0, err
		}
	}
	return f.Id, nil
}

// sendBulk writes an EventBatch, holding writeMu for one message at a time: a heartbeat, a call or an answer waiting
// for it goes next, between two pieces. A waiter that has waited over a millisecond is handed writeMu at its next
// unlock (sync.Mutex's starvation mode), so on a slow path it waits for the piece being written and one more at most.
// One EventBatch goes at a time (bulkMu), and every other frame goes whole once begun, so at most two frames are in
// pieces at once on the connection, inside the gateway's bound of four.
func (c *linkConn) sendBulk(f *linkpb.Frame) (uint64, error) {
	c.bulkMu.Lock()
	defer c.bulkMu.Unlock()
	c.writeMu.Lock()
	c.lastID++
	f.Id = c.lastID
	pieces, err := newLinkPieces(f, linkSendPieceBytes)
	for err == nil && !pieces.done() {
		if err = c.writePiece(c.writes, pieces); err != nil || pieces.done() {
			break
		}
		c.writeMu.Unlock()
		c.writeMu.Lock()
	}
	c.writeMu.Unlock()
	if err != nil {
		return 0, err
	}
	return f.Id, nil
}

// writePiece writes the next message of pieces, with writeMu held: encoded now, with the next id, so that the ids of
// the messages on the connection go up one by one whatever goes between the pieces of a frame.
func (c *linkConn) writePiece(ctx context.Context, pieces *linkPieces) error {
	var id uint64
	if !pieces.whole {
		c.lastID++
		id = c.lastID
	}
	b, err := pieces.next(id)
	if err != nil {
		return err
	}
	// Room in the send buffer first, outside the library's write lock, which its pongs need (link_socket.go).
	if err := c.sock.waitRoom(ctx, len(b)); err != nil {
		return err
	}
	return c.ws.Write(ctx, websocket.MessageBinary, b)
}

// watch ends the connection once a write on its socket has made no progress, and nothing has been read from it, for
// linkWriteStallLimit: the path carries nothing either way. It runs until the connection ends. The clock runs only
// while a write is in flight, never on a quiet connection, which the pings watch (linkWork.pinger). Its reason is
// recorded before the write is cancelled, which is what has the WebSocket library close the connection.
func (c *linkConn) watch() {
	tick := time.NewTicker(c.sock.limits.checkEvery)
	defer tick.Stop()
	for {
		select {
		case <-c.done:
			return
		case now := <-tick.C:
			stalled := c.sock.stalledFor(now)
			if stalled < c.sock.limits.stall {
				continue
			}
			c.fail(fmt.Sprintf("a write on the socket made no progress for %s, and nothing was read from the gateway meanwhile",
				stalled.Round(time.Second)))
			c.stopWrites()
			_ = c.ws.CloseNow()
			return
		}
	}
}

// fail records why the connection is taken for dead, unless a reason is recorded already.
func (c *linkConn) fail(why string) {
	c.failure.CompareAndSwap(nil, &why)
}

// endReason is why the connection ended, as this side knows it: a failure recorded (fail), else the WebSocket library
// closing it on a control frame's deadline while a write was blocked, else the error reading stopped with. Read it
// after done.
func (c *linkConn) endReason() string {
	if why := c.failure.Load(); why != nil {
		return *why
	}
	if d := time.Duration(c.sock.closedWriting.Load()); d > 0 && errors.Is(c.err, net.ErrClosed) {
		return fmt.Sprintf("the WebSocket library closed the connection when a ping or a pong could not be written within its 5s: a write on the socket had made no progress for %s",
			d.Round(100*time.Millisecond))
	}
	if c.err != nil {
		return c.err.Error()
	}
	return ""
}

// ping sends a WebSocket ping and waits for its pong, within timeout: the round trip, or an error after which the
// connection has ended.
func (c *linkConn) ping(timeout time.Duration) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	start := time.Now()
	err := c.ws.Ping(ctx)
	return time.Since(start), err
}

// close ends the connection with a WebSocket close handshake, in the background: the handshake waits for the
// gateway's answer, up to the library's own few seconds, and nothing that closes a connection waits for that.
func (c *linkConn) close(status websocket.StatusCode, reason string) {
	go func() { _ = c.ws.Close(status, reason) }()
}

// linkHello is the Hello of a process: who it is and what this binary is, as the headers of every HTTPS request
// say it today (transport.go doVia), so the gateway can forward them once the link carries the work (§5.3).
func linkHello(processID string) *linkpb.Hello {
	header := http.Header{}
	header.Set(runnerCapabilitiesHeader, runnerCapabilitiesV1)
	setManagedInstanceHeaders(header)
	hello := &linkpb.Hello{
		ProcessId:          processID,
		RunnerVersion:      version,
		Os:                 runtime.GOOS,
		MinProtocolVersion: linkProtocolVersion,
		MaxProtocolVersion: linkProtocolVersion,
		Capabilities:       linkList(header.Get(runnerCapabilitiesHeader)),
		SupportedProviders: linkList(supportedProvidersHeader()),
		WriteContract: &linkpb.WriteContract{
			CapabilityRevision: runnerWriteCapabilityRevision,
			SchemaRevision:     runnerWriteSchemaRevision,
			ContractDigest:     runnerWriteContractDigest,
		},
	}
	if instance := currentManagedInstance(); instance != nil {
		hello.ManagedInstance = &linkpb.ManagedInstance{Generation: instance.Generation, PodUid: instance.PodUID}
	}
	// Byte streams to the managed runner browser (link_streams.go): declared only by a managed runner.
	if linkStreamsDeclared() {
		hello.Capabilities = append(hello.Capabilities, linkStreamCapability, linkStreamPasteCapability)
	}
	return hello
}

// linkList is a comma-separated header value as its items.
func linkList(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
