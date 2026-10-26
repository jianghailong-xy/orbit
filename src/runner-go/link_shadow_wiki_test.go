//go:build go1.24

package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Under the shadow's tap, the wiki door still cuts a pool of its own from the transport the client had, with its
// HTTP/2 health check on (wiki_conn.go), and cuts a new one when it retires a pool. The health check is go1.24's,
// and so are these tests, as wiki_conn_test.go's are.
func TestLinkShadowTapLeavesTheWikiDoorItsOwnPool(t *testing.T) {
	for _, inner := range []*http.Transport{nil, {MaxIdleConns: 7}} {
		tr := NewTransport("https://orbit.example", "runner-token")
		if inner != nil {
			tr.client.Transport = inner
		}
		if err := installLinkShadowTap(tr, newLinkShadow(nil, (&linkTestLog{}).log)); err != nil {
			t.Fatal(err)
		}
		check := func(wiki *http.Client) *http.Transport {
			t.Helper()
			wt, ok := wiki.Transport.(*http.Transport)
			if !ok {
				t.Fatalf("over %v, the wiki client's transport is %T, not a pool of its own", inner, wiki.Transport)
			}
			if wt == http.DefaultTransport || (inner != nil && wt == inner) {
				t.Fatalf("over %v, the wiki client shares the daemon's pool", inner)
			}
			if inner != nil && wt.MaxIdleConns != 7 {
				t.Errorf("the wiki pool is not cut from the transport under the tap")
			}
			if wt.HTTP2 == nil || wt.HTTP2.SendPingTimeout != wikiConnHealth.sendPing || wt.HTTP2.PingTimeout != wikiConnHealth.ping {
				t.Errorf("over %v, the wiki pool has no health check: %+v", inner, wt.HTTP2)
			}
			return wt
		}
		first := tr.wikiClient()
		pool := check(first)
		tr.wikiRetire(first)
		if again := check(tr.wikiClient()); again == pool {
			t.Error("a retired pool is handed out again")
		}
	}
}

// 09-29's silent connection again (TestWikiConnHealthFindsASilentConnectionAndSendsAgainOnANewOne), with the
// shadow's tap on the transport: the wiki door finds the connection out and sends again on a new one, as it does
// without the tap.
func TestLinkShadowTapKeepsTheWikiHealthCheck(t *testing.T) {
	sendPing, ping, first := time.Second, 500*time.Millisecond, 100*time.Millisecond
	withWikiConnHealth(t, sendPing, ping)
	lines := withRealClockWikiRetry(t, first, time.Second, time.Minute)
	door := newSilentDoor(t, func(conn, call int) bool { return conn == 1 && call >= 2 })
	tr := door.transport()
	if err := installLinkShadowTap(tr, newLinkShadow(nil, (&linkTestLog{}).log)); err != nil {
		t.Fatal(err)
	}

	if _, err := tr.listWikiVerifications("verifications", "caller-session", "space-1", "", 1); err != nil {
		t.Fatalf("the call before: %v", err)
	}
	began := time.Now()
	_, _, err := tr.registerWikiNote("caller-session", "space-1", map[string]interface{}{"path": "memory/a.md", "text": "a fact"})
	took := time.Since(began)
	if err != nil {
		t.Fatalf("the write on a connection that went silent = %v after %s\n%s", err, took, strings.Join(lines.lines(), "\n"))
	}
	if limit := sendPing + ping + first + wikiConnSlack; took > limit {
		t.Errorf("the write was answered after %s: want it within the health check's time, %s", took, limit)
	}
	want := []silentCall{{"verifications", 1, true}, {"notes", 1, false}, {"notes", 2, true}}
	if got := door.reached(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("the door was reached by %v: want %v — the write again, on a new connection", got, want)
	}
}
