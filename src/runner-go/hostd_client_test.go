package main

import (
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What a client puts on the wire is half of the protocol's identity rule: hostd refuses
// any field that names a target, so the client has to have no way of sending one. This
// pins the request to exactly the version and the verb.
func TestHostdCallSendsOneVersionedVerbAndReadsOneResponse(t *testing.T) {
	got := make(chan string, 1)
	path := serveRawHostd(t, func(conn net.Conn) {
		var raw json.RawMessage
		if err := json.NewDecoder(conn).Decode(&raw); err != nil {
			t.Error(err)
			return
		}
		got <- string(raw)
		_ = json.NewEncoder(conn).Encode(hostdOK(map[string]any{"unit": "orbit-runner@1000.service"}))
	})

	resp, err := hostdCall(path, "enable")
	if err != nil {
		t.Fatal(err)
	}
	if sent, want := strings.TrimSpace(<-got), `{"v":1,"verb":"enable"}`; sent != want {
		t.Errorf("request = %s, want %s", sent, want)
	}
	if !resp.OK {
		t.Fatalf("response not ok: %s", resp.Error)
	}
	if got := hostdUnit(resp); got != "orbit-runner@1000.service" {
		t.Errorf("unit = %q, want the one the broker named", got)
	}
}

// A refusal is an answer, not an error: the caller has to be able to tell "the broker
// said no, and here is why" from "there was no broker".
func TestHostdCallSeparatesARefusalFromNoAnswer(t *testing.T) {
	path := serveRawHostd(t, func(conn net.Conn) {
		var raw json.RawMessage
		_ = json.NewDecoder(conn).Decode(&raw)
		_ = json.NewEncoder(conn).Encode(hostdFail("uid 4242 has no account on this machine"))
	})
	resp, err := hostdCall(path, "enable")
	if err != nil {
		t.Fatalf("a refusal must arrive as a response, not an error: %v", err)
	}
	if resp.OK || !strings.Contains(resp.Error, "no account") {
		t.Fatalf("resp = %+v, want a refusal carrying its reason", resp)
	}

	if _, err := hostdCall(filepath.Join(t.TempDir(), "absent.sock"), "enable"); err == nil {
		t.Fatal("dialling a socket that does not exist must be an error")
	}
}

// A broker that accepts the connection and then says nothing must not hold `orbit
// register` open: hostdCall's own deadline ends the exchange and hands the caller an
// error to fall back on. Driven through hostdCall rather than re-performed here, so
// that a deadline dropped from the product is a failure of this test and not of a
// hand-rolled copy of it that still has one.
func TestHostdCallGivesUpOnABrokerThatNeverAnswers(t *testing.T) {
	silent := make(chan struct{})
	defer close(silent)
	path := serveRawHostd(t, func(conn net.Conn) {
		<-silent // accept, read nothing, answer nothing
	})
	shortenHostdTimeout(t)

	answers := make(chan error, 1)
	if !mustGiveUp(t, "hostdCall", func() {
		_, err := hostdCall(path, "enable")
		answers <- err
	}) {
		return
	}
	if err := <-answers; err == nil {
		t.Fatal("a silent broker must eventually fail the read, not answer")
	}
}

// shortenHostdTimeout cuts the product's exchange timeout to test speed. Five seconds
// is the right wait for a real user in front of a wedged broker and the wrong one for a
// suite; that hostdCall bounds the exchange *at all* is what these tests are about.
func shortenHostdTimeout(t *testing.T) {
	t.Helper()
	prev := hostdCallTimeout
	hostdCallTimeout = 200 * time.Millisecond
	t.Cleanup(func() { hostdCallTimeout = prev })
}

// mustGiveUp runs fn on its own goroutine and reports whether it returned well within
// the shortened timeout, failing the test when it did not. A missing deadline does not
// show up as a wrong answer, it shows up as no answer ever — and a test that simply
// waits for one reports that as a package-wide panic ten minutes later instead of as
// this line. Callers take results from fn through a buffered channel and only read them
// when this returns true, so the goroutine left behind by a failure has nowhere to race.
func mustGiveUp(t *testing.T, what string, fn func()) bool {
	t.Helper()
	returned := make(chan struct{})
	go func() { defer close(returned); fn() }()
	select {
	case <-returned:
		return true
	case <-time.After(20 * hostdCallTimeout):
		t.Errorf("%s never gave up on a broker that never answers — the exchange has no deadline", what)
		return false
	}
}

// serveRawHostd answers connections on a temporary socket with handle, one connection
// at a time. Raw rather than hostdServe: these tests are about what the *client* puts
// on the wire and how it reads what comes back, so the server side stays a stand-in
// (and stays portable — hostdServe demands peer credentials, which are Linux-only).
func serveRawHostd(t *testing.T, handle func(net.Conn)) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "host.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			handle(conn)
			conn.Close()
		}
	}()
	return path
}
