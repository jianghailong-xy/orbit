package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The runner wiki door's calls wait out what a deploy or the edge does to them, rather than end the run
// they belong to. On 09-29 a maintenance run failed after 6,602 seconds on one HTTP/2 stream the edge reset
// (POST …/articles/ui-design, PROTOCOL_ERROR), and the next on the 502s of another session's deploy (POST
// …/verifications, then …/maintenance/finish): each time an hour or two of the local model's work was thrown
// away, and the next run read the same dossiers again.
//
// WHAT IS SENT AGAIN. A failure that says nothing about the request itself: the gateway's 502, 503 or 504
// (and the edge's 520 to 524, its own numbers for the same states of the origin); a connection refused,
// reset or cut off (EOF); an HTTP/2 stream or connection the peer gave up on (PROTOCOL_ERROR, REFUSED_STREAM,
// GOAWAY…); a request that timed out. A 429 is sent again only after the Retry-After it carries, and not at
// all without one — the door's own 429s (WIKI_QUOTA, WIKI_REVIEW_QUEUE_FULL) are answers. Every other answer,
// every other 4xx among them, goes back to the caller as it came.
//
// AND ONLY WHAT MAY LAND TWICE. Every read is sent again, and a write only when the server records it at most
// once however many times it lands: a proposal or a plan draft under an idempotency key, or a dry run
// (wikiRecordsOnce), a run's report of success (wikiReportsSuccess), and the writes whose routes say why they
// may. A failed or truncated run's report counts one more failure each time it lands, so it is sent once.
//
// HOW LONG. From about 2 seconds, doubling, each wait jittered and none longer than 30 seconds, until the call
// has gone on for 5 minutes — a deploy's switch is some 20 seconds of 502s. Each send waits for its answer as
// long as its call's timeout says — 20 seconds for the door's light calls; 2 minutes for its heavy ones (a
// dossier page, an article's input or write, an anchor report), which is past the 100 seconds the edge waits
// for the server before it answers 524 itself — and never past the budget's end, and a retry is sent only
// while the budget has time left after its wait: the whole call is over within the 5 minutes. A send that
// failed on its way is sent again on a new connection (wiki_conn.go). Then the last failure goes back to the
// caller exactly as the transport returned it, so what a caller did with a failure before, it still does.
// Each wait is one line on stderr: stdout is `orbit mcp`'s protocol and `--json`'s document.

// wikiRetryPolicy is the backoff a wiki call waits by. wikiRetry is the one every call uses; a test gives it
// a clock of its own.
type wikiRetryPolicy struct {
	first, max, budget time.Duration
	now                func() time.Time
	sleep              func(time.Duration)
	// jitter spreads one wait, so that runners which failed together do not all come back together.
	jitter func(time.Duration) time.Duration
	log    io.Writer
}

var wikiRetry = wikiRetryPolicy{
	first:  2 * time.Second,
	max:    30 * time.Second,
	budget: 5 * time.Minute,
	now:    time.Now,
	sleep:  time.Sleep,
	jitter: wikiRetryJitter,
	log:    os.Stderr,
}

// wikiRetryJitter is 75% to 125% of d.
func wikiRetryJitter(d time.Duration) time.Duration {
	return d*3/4 + time.Duration(rand.Int63n(int64(d/2)+1))
}

// wait is the pause before the nth retry: first, doubled n-1 times, jittered, and never more than max.
func (p wikiRetryPolicy) wait(n int) time.Duration {
	d := p.max
	if n <= 20 && p.first<<(n-1) < p.max {
		d = p.first << (n - 1)
	}
	if d = p.jitter(d); d > p.max {
		d = p.max
	}
	return d
}

// doWiki is one call of the runner wiki door. When resend says the call may land twice, a transient failure
// (wikiTransient) sends it again after the backoff's wait, for as long as the budget lasts; the answer is the
// last send's, and how many sends there were.
func (t *Transport) doWiki(method, path string, body, out interface{}, timeout time.Duration, headers map[string]string, resend bool) (int, error) {
	p := wikiRetry
	began := p.now()
	for sends := 1; ; sends++ {
		client := t.wikiClient()
		err := t.doVia(nil, client, method, path, body, out, min(timeout, p.budget-p.now().Sub(began)), headers)
		if err == nil {
			return sends, nil
		}
		now := p.now()
		why, wait, transient := wikiTransient(err, method, path, now)
		var answer *transportHTTPError
		if transient && !errors.As(err, &answer) {
			// No answer came back, and the connection the send went out on may be dead: whatever is sent next
			// goes out on a new one, this call's retry or the next call.
			t.wikiRetire(client)
		}
		if !resend || !transient {
			return sends, err
		}
		if wait == 0 {
			wait = p.wait(sends)
		}
		left := p.budget - now.Sub(began)
		if wait >= left {
			fmt.Fprintf(p.log, "orbit wiki: %s %s failed (%s) on send %d; the %s retry budget is spent, so the failure stands\n",
				method, path, why, sends, p.budget)
			return sends, err
		}
		fmt.Fprintf(p.log, "orbit wiki: %s %s failed (%s); retry %d in %s, %s of the %s budget left\n",
			method, path, why, sends, wait.Round(100*time.Millisecond), left.Round(time.Second), p.budget)
		p.sleep(wait)
	}
}

// wikiTransient says why a call's failure is worth sending the call again for, in the words its retry's line
// gives it, and, for a 429, how long its Retry-After asks to wait (0 leaves the wait to the backoff).
// transient is false for every other failure: the server's answer to the request itself.
func wikiTransient(err error, method, path string, now time.Time) (why string, wait time.Duration, transient bool) {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) {
		code := httpErr.statusCode
		why = strings.TrimSpace(fmt.Sprintf("%d %s", code, http.StatusText(code)))
		switch {
		case code == http.StatusBadGateway, code == http.StatusServiceUnavailable, code == http.StatusGatewayTimeout,
			code >= 520 && code <= 524:
			return why, 0, true
		case code == http.StatusTooManyRequests:
			wait, ok := wikiRetryAfter(httpErr.retryAfter, now)
			return why + ", Retry-After " + httpErr.retryAfter, wait, ok
		}
		return "", 0, false
	}
	why = wikiRetryCause(err, method, path)
	var netErr net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return "", 0, false
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.ECONNABORTED),
		errors.Is(err, syscall.EPIPE), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF),
		wikiHTTP2GaveUp(why),
		errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return why, 0, true
	}
	return "", 0, false
}

// wikiHTTP2GaveUp reports net/http's own HTTP/2 client saying the peer gave up a stream or its connection: a
// RST_STREAM (PROTOCOL_ERROR, REFUSED_STREAM, INTERNAL_ERROR…), a GOAWAY, a connection lost. net/http keeps
// the types of these errors to itself, so they are known by their words.
func wikiHTTP2GaveUp(cause string) bool {
	for _, words := range []string{"stream error: ", "connection error: ", "server sent GOAWAY", "graceful shutdown GOAWAY",
		"client connection lost"} {
		if strings.Contains(cause, words) {
			return true
		}
	}
	return false
}

// wikiRetryCause is a transport failure without the request it names, which the retry's line names already.
func wikiRetryCause(err error, method, path string) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err.Error()
	}
	return strings.TrimPrefix(err.Error(), method+" "+path+": ")
}

// wikiRetryAfter is the wait a 429's Retry-After asks for, in seconds or as a date; ok is false without one.
// A wait under a second is a second, so a server that says 0 is not asked again at once, over and over.
func wikiRetryAfter(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	var wait time.Duration
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		wait = time.Duration(min(seconds, 24*60*60)) * time.Second
	} else if at, err := http.ParseTime(value); err == nil {
		wait = at.Sub(now)
	} else {
		return 0, false
	}
	return max(wait, time.Second), true
}

// wikiRecordsOnce reports a proposal the server records at most once however many times it lands: one under
// an idempotency key, which a second landing is answered from (UNIQUE (owner_id, idempotency_key), and
// submitChangeset's replay), or a dry run, which records nothing. A plan draft under a key is one too: the
// server answers its second landing with the version the first stored (contract `plan.idempotency`).
func wikiRecordsOnce(body interface{}) bool {
	if draft, ok := body.(wikiPlanDraftRequest); ok {
		return strings.TrimSpace(draft.IdempotencyKey) != ""
	}
	fields, _ := body.(map[string]interface{})
	key, _ := fields["idempotencyKey"].(string)
	dryRun, _ := fields["dryRun"].(bool)
	return strings.TrimSpace(key) != "" || dryRun
}

// wikiReportsSuccess reports a run's report of success, which may land any number of times: a cursor that
// stands at its token already moves nothing, and the run's row says succeeded again. A failed or truncated
// run's report counts one more consecutive failure each time it lands — and the third tells the owner — so
// it is sent once.
func wikiReportsSuccess(body interface{}) bool {
	fields, _ := body.(map[string]interface{})
	outcome, _ := fields["outcome"].(string)
	return outcome == "" || outcome == "succeeded"
}
