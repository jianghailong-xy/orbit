package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

// A drive_put or drive_get call reports how far its bytes have got while it runs, so the chat can draw a
// transfer card with a bar and a speed (docs/mocks/agent-drive-transfer). `orbit mcp` sends each line over the
// session socket (driveProgressOp) and the runner emits it as the call's `tool_output`: the same live-only
// snapshot a foreground shell's output rides, which no server stores and the durable tool_result replaces.
// The line is one readable sentence, "Uploaded 3355443 of 11954323 bytes", so a client that shows any
// tool_output as text reads it as words, and the web parses it (lib/driveTransfer.ts).
const (
	driveProgressOp   = "drive_progress"
	driveProgressPoll = 500 * time.Millisecond
)

// driveProgressLine is the one sentence a snapshot carries. Keep in sync with lib/driveTransfer.ts.
func driveProgressLine(verb string, sent, size int64) string {
	return fmt.Sprintf("%s %d of %d bytes", verb, sent, size)
}

// driveProgress publishes one call's bytes: a changed count every half second, and an unchanged one every five
// seconds so a viewer that opens the session mid-transfer catches up (foregroundShellSnapshotState's policy).
type driveProgress struct {
	verb string
	send func(content string)

	mu         sync.Mutex
	sent, size int64

	stop chan struct{}
	done chan struct{}
}

func startDriveProgress(verb string, send func(content string)) *driveProgress {
	p := &driveProgress{verb: verb, send: send, stop: make(chan struct{}), done: make(chan struct{})}
	go p.run()
	return p
}

// setSize starts the count, once the call knows how big the file is.
func (p *driveProgress) setSize(size int64) {
	p.mu.Lock()
	p.size = size
	p.mu.Unlock()
}

// add counts bytes that have gone up or come down.
func (p *driveProgress) add(n int64) {
	p.mu.Lock()
	p.sent += n
	p.mu.Unlock()
}

func (p *driveProgress) line() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.size <= 0 {
		return ""
	}
	return driveProgressLine(p.verb, p.sent, p.size)
}

func (p *driveProgress) run() {
	defer close(p.done)
	ticker := time.NewTicker(driveProgressPoll)
	defer ticker.Stop()
	var state foregroundShellSnapshotState
	publish := func(now time.Time) {
		if content := p.line(); state.shouldEmit(content, now) {
			p.send(content)
		}
	}
	for {
		select {
		case <-p.stop:
			publish(time.Now())
			return
		case now := <-ticker.C:
			publish(now)
		}
	}
}

// close sends the last count and stops; the call's tool_result follows it.
func (p *driveProgress) close() {
	if p == nil {
		return
	}
	close(p.stop)
	<-p.done
}

// sessionDriveProgress is the reporter for one drive call `orbit mcp` serves, or nil when there is nowhere to
// send it: no tool-use id from the engine (only Claude Code names its calls) or no session socket.
func sessionDriveProgress(name, toolUseID string) *driveProgress {
	verb := map[string]string{"drive_put": "Uploaded", "drive_get": "Downloaded"}[name]
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if verb == "" || strings.TrimSpace(toolUseID) == "" || socket == "" || token == "" {
		return nil
	}
	return startDriveProgress(verb, func(content string) {
		// Best effort: a lost line is a bar that moves later, never a failed call.
		_, _ = bgSocketCall(socket, token, driveProgressOp, map[string]interface{}{"toolUseId": toolUseID, "content": content})
	})
}

// serveDriveProgress emits one progress line as the call's tool_output (bgJobService.handle).
func (s *bgJobService) serveDriveProgress(args map[string]interface{}) bgSocketResponse {
	id, content := getString(args, "toolUseId"), getString(args, "content")
	if id == "" || len(id) > 64 || content == "" || len(content) > foregroundShellOutputCap {
		return bgSocketResponse{Error: "drive_progress needs a toolUseId and a short content line"}
	}
	if s.bg == nil || s.bg.emit == nil {
		return bgSocketResponse{Error: "this session emits no events"}
	}
	s.bg.emit(evToolOutput, map[string]interface{}{"toolUseId": id, "content": content})
	return bgSocketResponse{OK: true}
}

// countingReader counts what an upload's body has handed to the connection.
type countingReader struct {
	r   io.Reader
	add func(int64)
}

func (c countingReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	if n > 0 {
		c.add(int64(n))
	}
	return n, err
}
