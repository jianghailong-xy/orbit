package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"time"
)

// The backends: the apiserver's internal listeners for runner link calls (RUNNER_LINK_INTERNAL_PORT,
// src/apiserver/src/runner-api/runner-link-call.ts), one per apiserver instance, named by LINK_INTERNAL_API_URLS.
// Every call the gateway forwards for a runner goes to one of them: its requests, heartbeats and event batches
// (docs/runner-link-design.md §6.1, §6.4).
//
// A call is retried on the next backend when it is safe to send it again (§6.1: idempotent calls are retried across
// backend instances, so a backend's release costs runners nothing):
//   - a call that never reached a backend, whatever it is: the dial failed, or the connection failed before the
//     request was written in full (httptrace's WroteRequest), so no handler ran;
//   - a call that may have reached one, only when it is idempotent: a GET, a heartbeat (reconciled level-triggered),
//     an event batch (stored once per seq).
//
// Any answer the backend gives, whatever its status, is the answer: the gateway relays it and decides nothing on it.

// maxAnswerBytes bounds an answer read from a backend: it travels back as one frame, which a runner joins from its
// pieces up to this size (chunk.go).
const maxAnswerBytes = maxChunkedFrameBytes - 64<<10

// backendPool sends calls to the backends.
type backendPool struct {
	urls    []string
	down    []atomic.Int64 // per backend: until when (Unix nanoseconds) a backend that could not be dialed is passed over
	next    atomic.Uint64
	client  *http.Client
	token   string
	node    string
	timeout time.Duration
	tune    linkTuning
	m       *gatewayMetrics
	log     *slog.Logger
	now     func() time.Time
}

func newBackendPool(cfg config, m *gatewayMetrics, log *slog.Logger) *backendPool {
	transport := &http.Transport{
		// The backends are on the internal network: no proxy stands between them and the gateway.
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        1024,
		MaxIdleConnsPerHost: 256,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	}
	return &backendPool{
		urls:    cfg.InternalAPIURLs,
		down:    make([]atomic.Int64, len(cfg.InternalAPIURLs)),
		client:  &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		token:   cfg.GatewayToken,
		node:    nodeName(),
		timeout: cfg.RPCTimeout,
		tune:    cfg.link,
		m:       m,
		log:     log.With("component", "backends"),
		now:     time.Now,
	}
}

// backendCall is one call: the route under /api, and whether sending it twice is harmless.
type backendCall struct {
	kind       string // what it is for, in metrics: rpc, heartbeat or events
	method     string
	path       string // with its query, from /api on: /api/runner/heartbeat
	body       []byte
	header     http.Header
	idempotent bool
}

// backendAnswer is what a backend answered, whatever the status.
type backendAnswer struct {
	status int
	header http.Header
	body   []byte
}

// Why a call has no answer. Each is a Failure code the runner reads (proto Failure.code).
var (
	// errBackendUnavailable: no backend could be reached, or the call could not be sent again after one failed.
	errBackendUnavailable = errors.New("BACKEND_UNAVAILABLE")
	// errBackendTimeout: no answer within LINK_RPC_TIMEOUT.
	errBackendTimeout = errors.New("BACKEND_TIMEOUT")
	// errBackendCutOff: the call may have reached a backend, which never answered, and it is not one that is sent
	// again on the runner's behalf; the runner sends it again under the same request_id.
	errBackendCutOff = errors.New("BACKEND_CUT_OFF")
	// errAnswerTooLarge: the backend's answer is more than one frame may carry.
	errAnswerTooLarge = errors.New("BACKEND_ANSWER_TOO_LARGE")
	// errCallCancelled: the runner's connection ended while the call was out; nobody is left to answer.
	errCallCancelled = errors.New("CANCELLED")
)

// do sends call and returns the first answer a backend gives. ctx is the runner's connection: when it ends, the call
// is aborted at once, so the route sees its request close, as it sees a runner hang up over HTTPS (§6.4).
func (p *backendPool) do(ctx context.Context, call backendCall) (*backendAnswer, error) {
	return p.doFrom(ctx, call, int(p.next.Add(1)-1))
}

// doFrom is do with its first attempt on backend first, the round robin going on from there: the merged calls choose
// their backend themselves (events_merge.go).
func (p *backendPool) doFrom(ctx context.Context, call backendCall, first int) (*backendAnswer, error) {
	started := p.now()
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	retryUntil := started.Add(p.tune.RetryBudget)
	wait := 100 * time.Millisecond
	for attempt := 0; ; attempt++ {
		i := p.pick(first + attempt)
		answer, delivered, err := p.attempt(ctx, i, call)
		if err == nil {
			p.m.backendCalls.inc(call.kind, "answered")
			p.m.backendDuration.observe(p.now().Sub(started))
			return answer, nil
		}
		if err := p.ended(ctx, call); err != nil {
			return nil, err
		}
		if errors.Is(err, errAnswerTooLarge) {
			p.m.backendCalls.inc(call.kind, "too_large")
			return nil, err
		}
		reason := "not_delivered"
		if delivered {
			reason = "lost"
			if !call.idempotent {
				p.m.backendCalls.inc(call.kind, "cut_off")
				p.log.Warn("a call reached a backend that did not answer; not sent again, the runner sends it again",
					"backend", p.urls[i], "route", call.method+" "+routeLabel(call.path), "err", err)
				return nil, errBackendCutOff
			}
		}
		if p.now().Add(wait).After(retryUntil) {
			p.m.backendCalls.inc(call.kind, "unavailable")
			p.log.Warn("no backend answered a call", "route", call.method+" "+routeLabel(call.path), "attempts", attempt+1, "err", err)
			return nil, errBackendUnavailable
		}
		p.m.backendRetries.inc(call.kind, reason)
		select {
		case <-ctx.Done():
			return nil, p.ended(ctx, call)
		case <-time.After(wait):
		}
		wait = min(2*wait, time.Second)
	}
}

// ended says why a call stopped when its context did: the runner's connection closed, or LINK_RPC_TIMEOUT passed.
// nil while the call may go on.
func (p *backendPool) ended(ctx context.Context, call backendCall) error {
	switch ctx.Err() {
	case nil:
		return nil
	case context.DeadlineExceeded:
		p.m.backendCalls.inc(call.kind, "timeout")
		return errBackendTimeout
	default:
		p.m.backendCalls.inc(call.kind, "cancelled")
		return errCallCancelled
	}
}

// pick is the backend for the nth attempt, round-robin from where the call started, passing over one that could not be
// dialed a moment ago; when every one is passed over, the nth is tried anyway.
func (p *backendPool) pick(n int) int {
	now := p.now().UnixNano()
	for k := 0; k < len(p.urls); k++ {
		i := (n + k) % len(p.urls)
		if p.down[i].Load() <= now {
			return i
		}
	}
	return n % len(p.urls)
}

// passedOver says whether pick passes over backend i: it could not be dialed a moment ago.
func (p *backendPool) passedOver(i int) bool {
	return p.down[i].Load() > p.now().UnixNano()
}

// attempt sends the call to backend i once. delivered says whether the request was written in full, after which a
// handler may have run.
func (p *backendPool) attempt(ctx context.Context, i int, call backendCall) (*backendAnswer, bool, error) {
	var wrote atomic.Bool
	trace := &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			wrote.Store(true)
		}
	}}
	var body io.Reader
	if len(call.body) > 0 {
		body = bytes.NewReader(call.body)
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), call.method, p.urls[i]+call.path, body)
	if err != nil {
		return nil, false, err
	}
	for name, values := range call.header {
		req.Header[name] = values
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set(linkGatewayIDHeader, p.node)
	if len(call.body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.client.Do(req)
	if err != nil {
		var op *net.OpError
		if errors.As(err, &op) && op.Op == "dial" {
			p.down[i].Store(p.now().Add(p.tune.BackendDownFor).UnixNano())
		}
		return nil, wrote.Load(), err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswerBytes+1))
	if err != nil {
		// The status line came: a handler ran. Its answer was cut off on the way.
		return nil, true, err
	}
	if len(data) > maxAnswerBytes {
		return nil, true, errAnswerTooLarge
	}
	return &backendAnswer{status: resp.StatusCode, header: resp.Header, body: data}, true, nil
}

// routeLabel is a route as metrics and logs name it: the path without its query, each id in it replaced by :id, so the
// label set stays small.
func routeLabel(path string) string {
	path, _, _ = strings.Cut(path, "?")
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if looksLikeID(part) {
			parts[i] = ":id"
		}
	}
	return strings.Join(parts, "/")
}

// looksLikeID: a UUID, or a public id (base62, at least 16 characters with a digit in them).
func looksLikeID(s string) bool {
	if len(s) < 16 {
		return false
	}
	digit := false
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			digit = true
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '-', r == '_':
		default:
			return false
		}
	}
	return digit
}

// String names the pool in logs, without the gateway token.
func (p *backendPool) String() string {
	return fmt.Sprintf("%d backend(s): %s", len(p.urls), strings.Join(p.urls, ", "))
}
