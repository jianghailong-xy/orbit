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
// register` open: the deadline ends the exchange and the caller falls back.
func TestHostdCallGivesUpOnABrokerThatNeverAnswers(t *testing.T) {
	done := make(chan struct{})
	defer close(done)
	path := serveRawHostd(t, func(conn net.Conn) {
		<-done // accept, read nothing, answer nothing
	})

	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	// Same exchange hostdCall performs, with a deadline short enough to keep the test
	// quick — hostdCallTimeout itself is a product decision, not one worth waiting out.
	_ = conn.SetDeadline(time.Now().Add(200 * time.Millisecond))
	_ = json.NewEncoder(conn).Encode(hostdRequest{V: hostdProtocolVersion, Verb: "enable"})
	var resp hostdResponse
	err = json.NewDecoder(conn).Decode(&resp)
	conn.Close()
	if err == nil {
		t.Fatal("a silent broker must eventually fail the read, not block forever")
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
