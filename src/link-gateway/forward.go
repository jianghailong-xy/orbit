package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// Control requests (docs/runner-link-design.md §5.6, §6.4). An Rpc carries a TunnelRequest: the HTTP request a runner
// makes over HTTPS today, which the gateway sends as it is to the same route on the apiserver's internal listener,
// adding the runner's link token, the request's link fields and what Hello declared (linkState.headers). The route
// decides everything; its answer comes back whole, whatever its status, as a TunnelResponse. A Failure means there is
// no answer to relay: the request was malformed, too many are in flight, or no backend answered.

// requestIDPattern is the apiserver's rule for X-Orbit-Link-Request-Id (runner-link-call.ts).
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// forwardRPC answers rpc from a backend, off the reading goroutine.
func forwardRPC(c *conn, rpc *linkpb.Rpc) {
	l := c.link
	select {
	case l.rpcSlots <- struct{}{}:
	default:
		c.g.metrics.rpcResults.inc("RPC_TOO_MANY_IN_FLIGHT")
		c.send(rpcFailure(rpc, failure("RPC_TOO_MANY_IN_FLIGHT",
			"this connection has as many requests in flight as it may; send it again once one is answered", true, time.Second)), false)
		return
	}
	go func() {
		defer func() { <-l.rpcSlots }()
		result := l.call(rpc)
		if result == nil {
			return // the connection ended: nobody to answer
		}
		c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: result}}, false)
	}()
}

// call forwards one Rpc and builds its RpcResult; nil when the connection ended first.
func (l *linkState) call(rpc *linkpb.Rpc) *linkpb.RpcResult {
	m := l.c.g.metrics
	refuse := func(code, message string) *linkpb.RpcResult {
		m.rpcResults.inc(code)
		return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Failure{Failure: failure(code, message, false, 0)}}
	}
	if !requestIDPattern.MatchString(rpc.GetRequestId()) {
		return refuse("RPC_BAD_REQUEST", "request_id is 1 to 128 letters, digits, dots, colons, underscores or hyphens")
	}
	tunnel := rpc.GetTunnel()
	if tunnel == nil {
		return refuse("RPC_BAD_REQUEST", "the request carries no body this gateway forwards (TunnelRequest)")
	}
	method := tunnel.GetMethod()
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return refuse("RPC_BAD_REQUEST", "the method is not GET, POST, PUT, PATCH or DELETE")
	}
	target, err := tunnelTarget(tunnel.GetPath())
	if err != nil {
		return refuse("RPC_BAD_REQUEST", err.Error())
	}
	header := l.headers()
	header.Set(linkRequestIDHeader, rpc.GetRequestId())
	if rpc.GetSessionId() != "" {
		header.Set(linkSessionIDHeader, rpc.GetSessionId())
	}
	if rpc.GetAfterSeq() > 0 {
		header.Set(linkAfterSeqHeader, strconv.FormatUint(rpc.GetAfterSeq(), 10))
	}
	started := time.Now()
	answer, err := l.c.g.backends.do(l.c.ctx, backendCall{
		kind: "rpc", method: method, path: target, body: tunnel.GetJsonBody(), header: header,
		// A GET is sent again on another backend even when it may have reached the first (backend.go).
		idempotent: method == http.MethodGet,
	})
	route := method + " " + routeLabel(target)
	if err != nil {
		if errors.Is(err, errCallCancelled) {
			m.rpcResults.inc("CANCELLED")
			return nil
		}
		code := err.Error()
		m.rpcResults.inc(code)
		l.logFailure("a request got no answer", "route", route, "failure", code)
		retryable := !errors.Is(err, errAnswerTooLarge)
		return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Failure{
			Failure: failure(code, failureMessage(err), retryable, retryAfterFor(err)),
		}}
	}
	m.rpcResults.inc(statusClass(answer.status))
	m.rpcDuration.observe(time.Since(started))
	return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{
		Status: uint32(answer.status), JsonBody: answer.body, RetryAfterMs: answerRetryAfterMs(answer),
	}}}
}

// tunnelTarget is the internal route a TunnelRequest's path names, under /api. Only a runner route is forwarded, and
// only a path that reads as it is: no dot segments, no doubled slashes, no escapes or backslashes in the path, which a
// router could read differently from this check.
func tunnelTarget(p string) (string, error) {
	if !strings.HasPrefix(p, "/runner/") {
		return "", errors.New("the path is not a runner route (/runner/...)")
	}
	for _, r := range p {
		if r <= ' ' || r == 0x7f {
			return "", errors.New("the path holds a space or a control character")
		}
	}
	route, _, _ := strings.Cut(p, "?")
	if strings.ContainsAny(route, `\%#`) || path.Clean(route) != route {
		return "", errors.New("the path is not in its plain form: no dot segments, doubled or trailing slashes, escapes or backslashes")
	}
	return "/api" + p, nil
}

// answerRetryAfterMs is the delay an answer asks for before the call is sent again: its Retry-After-Ms, else the
// body's retryAfterMs, else its Retry-After in seconds; 0 when it states none.
func answerRetryAfterMs(a *backendAnswer) uint32 {
	if v, err := strconv.ParseUint(strings.TrimSpace(a.header.Get("Retry-After-Ms")), 10, 32); err == nil {
		return uint32(v)
	}
	var body struct {
		RetryAfterMs *float64 `json:"retryAfterMs"`
	}
	if json.Unmarshal(a.body, &body) == nil && body.RetryAfterMs != nil && *body.RetryAfterMs > 0 && *body.RetryAfterMs < 1<<31 {
		return uint32(*body.RetryAfterMs)
	}
	if v, err := strconv.ParseUint(strings.TrimSpace(a.header.Get("Retry-After")), 10, 16); err == nil {
		return uint32(v) * 1000
	}
	return 0
}

// answerCode is an error answer's own code and whether it says sending it again may succeed (the link's error fields,
// common/runner-link-error.filter.ts), read from its body.
func answerCode(a *backendAnswer) (code string, retryable, stated bool) {
	var body struct {
		Code      string `json:"code"`
		Retryable *bool  `json:"retryable"`
	}
	if json.Unmarshal(a.body, &body) == nil && body.Retryable != nil {
		return body.Code, *body.Retryable, true
	}
	return body.Code, false, false
}

func statusClass(status int) string {
	return strconv.Itoa(status/100) + "xx"
}

func rpcFailure(rpc *linkpb.Rpc, f *linkpb.Failure) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{
		RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Failure{Failure: f},
	}}}
}

func failureMessage(err error) string {
	switch {
	case errors.Is(err, errBackendUnavailable):
		return "no apiserver instance could be reached; the request can be sent again"
	case errors.Is(err, errBackendTimeout):
		return "the apiserver did not answer in time; the request can be sent again under the same request_id"
	case errors.Is(err, errBackendCutOff):
		return "the connection to the apiserver was lost before it answered; the request can be sent again under the same request_id"
	case errors.Is(err, errAnswerTooLarge):
		return "the apiserver's answer is larger than one frame may carry"
	}
	return err.Error()
}

func retryAfterFor(err error) time.Duration {
	if errors.Is(err, errBackendUnavailable) {
		return time.Second
	}
	return 0
}
