package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// Kimi runs turns of its own: a background task that completes, or one its previous process lost
// (a recycled engine takes its shells with it), is told to the model as a turn Kimi opens by itself
// — on `session/resume` already, for the lost ones. ACP says nothing of such a turn, and a
// `session/prompt` that arrives while it runs is queued behind it and answered `end_turn` at once,
// without running (measured on kimi 2.6.0, 2026-11-13: the prompt runs as the next turn once the
// engine's own one ends, and nothing of that turn is streamed either). A prompt sent then looks like
// one Kimi never ran (kimiNoTurn), and reporting it so ended the session and stopped the engine
// while the prompt still sat in its queue (session 34tldRMFzXMU1CBLQ1GFZ, 2026-11-13).
//
// So a prompt waits until no turn is open on the main agent's wire, and a prompt that lands behind
// one anyway (the engine's turn opened in the moment it was sent) is followed on the wire to its
// own end (readKimiTurnOutcome).

// kimiForeignTurnWait bounds how long a prompt waits on a turn Kimi runs on its own before it is
// sent anyway: a turn left open on the wire by something this reading does not know must not hold
// the session's messages forever.
var kimiForeignTurnWait = 10 * time.Minute

// kimiQueuedTurnWait bounds how long a prompt Kimi answered while a turn was open is followed on
// the wire to its own end (readKimiTurnOutcome): past it, the prompt reads as one Kimi never ran.
const kimiQueuedTurnWait = 30 * time.Minute

// kimiForeignTurnPoll is how often the wire is read while a prompt waits.
const kimiForeignTurnPoll = 100 * time.Millisecond

// kimiTurnLedger follows, on the main agent's wire, which turn is open: one turn.prompt without its
// turn.ended. It reads only what was written while this process runs — a turn a killed process left
// open never ends, and must not read as running.
type kimiTurnLedger struct {
	mu   sync.Mutex
	home string
	id   string
	wire string
	off  int64
	open json.RawMessage
}

// newKimiTurnLedger starts following session id's wire in home from where it ends now. Called
// before the session is resumed, so a turn Kimi opens while resuming is read.
func newKimiTurnLedger(home, id string) *kimiTurnLedger {
	l := &kimiTurnLedger{home: home, id: id}
	l.wire, l.off = kimiTurnWire(home, id)
	return l
}

// setSession names the session once it is known (a new one), keeping the reading of a wire
// already found.
func (l *kimiTurnLedger) setSession(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.wire == "" {
		l.id = id
	}
}

// running reports whether a main-agent turn is open now.
func (l *kimiTurnLedger) running() bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.wire == "" {
		// A wire that did not exist when this process started (a new session's appears with its
		// first turn) holds only what this process wrote: all of it is read.
		if l.wire, _ = kimiTurnWire(l.home, l.id); l.wire == "" {
			return false
		}
		l.off = 0
	}
	f, err := os.Open(l.wire)
	if err != nil {
		return l.open != nil
	}
	defer f.Close()
	data, err := io.ReadAll(io.NewSectionReader(f, l.off, 1<<62))
	if err != nil {
		return l.open != nil
	}
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return l.open != nil
	}
	for _, line := range bytes.Split(data[:end], []byte{'\n'}) {
		if !bytes.Contains(line, []byte(`"turn.prompt"`)) && !bytes.Contains(line, []byte(`"turn.ended"`)) {
			continue
		}
		var rec kimiTurnRecord
		if json.Unmarshal(line, &rec) != nil || rec.AgentID != "main" || len(rec.TurnID) == 0 {
			continue
		}
		switch rec.Type {
		case "turn.prompt":
			l.open = rec.TurnID
		case "turn.ended":
			if bytes.Equal(rec.TurnID, l.open) {
				l.open = nil
			}
		}
	}
	l.off += int64(end) + 1
	return l.open != nil
}

// errKimiPromptUnsent: the prompt was stopped while it waited, before anything was sent.
var errKimiPromptUnsent = errors.New("kimi prompt stopped before it was sent")

// waitKimiOwnTurn waits, up to kimiForeignTurnWait, until no turn is open on the main agent's wire,
// and says how long it waited. errKimiPromptUnsent when unsent closes first (an interrupt); the
// context's error, or the engine's closing, end the wait the way they end a sent prompt's.
func waitKimiOwnTurn(ctx context.Context, done, unsent <-chan struct{}, turns *kimiTurnLedger) (time.Duration, error) {
	began := time.Now()
	for turns.running() && time.Since(began) < kimiForeignTurnWait {
		select {
		case <-unsent:
			return time.Since(began), errKimiPromptUnsent
		case <-done:
			return time.Since(began), fmt.Errorf("kimi acp closed")
		case <-ctx.Done():
			return time.Since(began), ctx.Err()
		case <-time.After(kimiForeignTurnPoll):
		}
	}
	return time.Since(began), nil
}
