package main

import (
	"encoding/json"
	"errors"
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
// register` open forever: after hostdCallTimeout it is waited for, saying so, and after
// hostdAnswerWait hostdCall ends the exchange with an answer of its own — the code
// hostdNoAnswer, never an error to fall back on, since the broker may still be carrying
// the request out. Driven through hostdCall rather than re-performed here, so that a
// deadline dropped from the product is a failure of this test and not of a hand-rolled
// copy of it that still has one.
func TestHostdCallGivesUpOnABrokerThatNeverAnswers(t *testing.T) {
	silent := make(chan struct{})
	defer close(silent)
	path := serveRawHostd(t, func(conn net.Conn) {
		<-silent // accept, read nothing, answer nothing
	})
	shortenHostdTimeout(t)

	type answer struct {
		resp hostdResponse
		err  error
	}
	answers := make(chan answer, 1)
	var out string
	gaveUp := false
	out = captureServiceOutput(t, func() {
		gaveUp = mustGiveUp(t, "hostdCall", func() {
			resp, err := hostdCall(path, "enable")
			answers <- answer{resp, err}
		})
	})
	if !gaveUp {
		return
	}
	got := <-answers
	if got.err != nil {
		t.Fatalf("a broker that took the request and went quiet must not be an error to fall back on: %v", got.err)
	}
	if got.resp.OK || got.resp.Code != hostdNoAnswer || !strings.Contains(got.resp.Error, "has not answered within "+hostdAnswerWait.String()) {
		t.Fatalf("resp = %+v, want the %q answer", got.resp, hostdNoAnswer)
	}
	if !strings.Contains(out, `Waiting for the machine broker to finish "enable"`) {
		t.Errorf("hostdCall did not say it was waiting; got:\n%s", out)
	}
}

// shortenHostdTimeout cuts the product's exchange timeouts to test speed. Five seconds
// and a quarter of an hour are the right waits for a real user in front of a busy broker
// and the wrong ones for a suite; that hostdCall bounds the exchange *at all* is what
// these tests are about.
func shortenHostdTimeout(t *testing.T) {
	t.Helper()
	prevCall, prevAnswer := hostdCallTimeout, hostdAnswerWait
	hostdCallTimeout, hostdAnswerWait = 200*time.Millisecond, 400*time.Millisecond
	t.Cleanup(func() { hostdCallTimeout, hostdAnswerWait = prevCall, prevAnswer })
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

// What `orbit register` prints when its service step fails: the first line of the reason and
// the foreground hint — except for the broker's own-copy refusal, which is printed whole, its
// one command included, in place of the hint.
func TestPrintServiceFailure(t *testing.T) {
	var out strings.Builder
	printServiceFailure(&out, errors.New("installing the systemd service needs root: write x\nmore detail"))
	if want := "\n✗ Could not start the background service: installing the systemd service needs root: write x\n" +
		"  Start it in the foreground instead:  orbit run\n"; out.String() != want {
		t.Errorf("printed %q, want %q", out.String(), want)
	}

	out.Reset()
	reason := "refusing to enable orbit-runner@alice.service: it runs alice's own ~/.orbit/bin/orbit, and ...:\n  " + hostdOwnCopyCommand
	printServiceFailure(&out, &hostdRegisterRefusal{code: hostdRefusedOwnCopy, reason: reason})
	if want := "\n✗ Could not start the background service: " + reason + "\n"; out.String() != want {
		t.Errorf("printed %q, want %q", out.String(), want)
	}

	// The older-runner refusal too, every line of it.
	out.Reset()
	reason = "refusing to enable orbit-runner@alice.service: alice's older runner orbit-runner-alice.service could not be stopped: ...\nIt is still alice's runner, so orbit-runner@alice.service was neither enabled nor started. Once it can be stopped, run `orbit register` again."
	printServiceFailure(&out, &hostdRegisterRefusal{code: hostdRefusedOlderRunner, reason: reason})
	if want := "\n✗ Could not start the background service: " + reason + "\n"; out.String() != want {
		t.Errorf("printed %q, want %q", out.String(), want)
	}
}
