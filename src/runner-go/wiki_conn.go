package main

import (
	"net/http"
	"time"
)

// The runner wiki door's calls go out on connections of their own, and one that dies is found out and put
// down, instead of being kept to take every later call down with it. On 09-29 from 15:23Z, three calls of a
// maintenance run's articles stage — POST …/articles/agent-tooling, GET …/articles/web-client/input, GET
// …/articles/apple-clients/input — each ended at its 2-minute timeout, and not one of them reached the
// gateway: the HTTP/2 connection between the command and the edge had gone silent, and Go's HTTP/2 client,
// which checks a connection only when it is told to, kept sending calls down it.
//
// FOUND OUT. A connection that has read nothing for 30 seconds is pinged, and one that has not answered the
// ping 15 seconds later is closed, which fails every call still waiting on it: a connection that died is
// known dead at most 45 seconds after the last thing it said, busy or idle. A live one answers the ping at
// once whatever its calls are waiting for, so a slow answer is not taken for a dead connection. The check is
// net/http's own (HTTP2Config, go1.24 and later: wiki_conn_go124.go), which every build of this module has —
// go1.24 here, go1.27 in CI and in the image the release binaries are built in.
//
// PUT DOWN. A send that failed on its way — no answer came back: it timed out, its connection was reset or
// lost, the edge gave up its stream — may leave a dead connection in the pool, and net/http hands the next
// send that same connection: go1.24's and go1.27's alike keep a connection whose stream timed out, counting
// the reset stream against its concurrency limit only until the peer answers a ping. Closing the pool's idle
// connections is not enough either: a connection with another call still on it is not idle. So the pool the
// send went out through is put down. The retry, and every call after it, go out through a new pool, which
// dials a new connection; the old pool's idle connections are closed, and its busy ones end with their calls
// — a dead one within the 45 seconds above.

// wikiConnHealth is the HTTP/2 health check on the wiki calls' connections. A test shortens it.
var wikiConnHealth = struct {
	// sendPing is how long a connection may read nothing before it is pinged: long enough that a quiet one
	// costs one ping a half-minute; short enough that, with ping's 15 seconds, a dead one is found well inside
	// the heavy calls' 2-minute timeout and the 5-minute retry budget.
	sendPing time.Duration
	// ping is how long a ping may go unanswered before the connection is closed, net/http's own default: a ping
	// to the edge comes back in well under a second, so 15 seconds without an answer is a connection that is
	// gone, not a slow network.
	ping time.Duration
}{sendPing: 30 * time.Second, ping: 15 * time.Second}

// wikiClient is the client a wiki call goes out on: t.client with a pool of its own, whose HTTP/2
// connections are health-checked.
func (t *Transport) wikiClient() *http.Client {
	t.wikiMu.Lock()
	defer t.wikiMu.Unlock()
	if t.wiki == nil {
		t.wiki = newWikiClient(t.client)
	}
	return t.wiki
}

// wikiRetire puts down the pool of c, a client a send failed on its way through: while c is still the one the
// wiki calls go out on, the next of them goes out on a new one, with a pool, and so a connection, of its own.
// c's idle connections are closed; its busy ones end with their calls.
func (t *Transport) wikiRetire(c *http.Client) {
	t.wikiMu.Lock()
	if t.wiki == c {
		t.wiki = newWikiClient(t.client)
	}
	t.wikiMu.Unlock()
	c.CloseIdleConnections()
}

// newWikiClient is client over a copy of its transport (http.DefaultTransport when it names none) with the
// health check on, which is a pool of its own. A transport that is not an *http.Transport — a test's — is
// kept as it is.
func newWikiClient(client *http.Client) *http.Client {
	c := *client
	base := c.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	if tr, ok := base.(*http.Transport); ok {
		tr = tr.Clone()
		wikiCheckConnHealth(tr)
		c.Transport = tr
	}
	return &c
}
