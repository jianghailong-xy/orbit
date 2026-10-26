//go:build unix

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// An emitter never waits on the link's event streams. While one session's stream is read from a spool the disk is slow
// to give back (a FIFO here, which blocks its reader until something writes), another session's progress report still
// takes an unsent report's place at once, and another session's stream still opens.
func TestAnEmitterNeverWaitsForAStreamBeingReadFromTheSpool(t *testing.T) {
	m, _ := linkEventsOffline(t)
	home := os.Getenv("ORBIT_HOME")
	m.events.setOnLink(true)
	m.events.creditBlocked.Store(true)
	busy := m.events.open("session-busy")
	defer busy.release()
	gauge := func(used float64) map[string]interface{} {
		return map[string]interface{}{"subtype": "context", "used": used}
	}
	if err := busy.submit([]RunEvent{{Seq: 1, Type: evSystem, TS: nowISO(), TurnID: "turn-1", Payload: gauge(1)}}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "link-spool", spoolNamePart(decodeSessionID("session-slow")))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(dir, linkSpoolSegmentName(1, 1, true))
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	opened := make(chan *linkEventStream, 1)
	go func() { opened <- m.events.open("session-slow") }()
	defer func() {
		// The disk gives the segment back at last: a writer that writes nothing.
		if w, err := os.OpenFile(fifo, os.O_WRONLY, 0); err == nil {
			_ = w.Close()
		}
		select {
		case s := <-opened:
			s.release()
		case <-time.After(5 * time.Second):
			t.Error("the slow stream never opened")
		}
	}()
	time.Sleep(100 * time.Millisecond)
	merged := make(chan bool, 1)
	go func() { merged <- busy.mergeProgress(nil, 1, "turn-1", evSystem, gauge(2)) }()
	select {
	case ok := <-merged:
		if !ok {
			t.Error("the report did not take the unsent one's place")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("an emitter waited for another session's stream to be read from the spool")
	}
	other := make(chan *linkEventStream, 1)
	go func() { other <- m.events.open("session-other") }()
	select {
	case s := <-other:
		s.release()
	case <-time.After(2 * time.Second):
		t.Error("a session's stream waited for another's to be read from the spool")
	}
}
