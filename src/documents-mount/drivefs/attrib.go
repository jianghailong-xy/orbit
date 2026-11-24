package drivefs

import (
	"bufio"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Attributor tells which session a FUSE caller's pid belongs to (§5.8). The pid is in the pid namespace of the
// process that mounted, so only the privileged parent, which can read /proc of the runner's processes, can answer.
type Attributor interface {
	// Session answers the caller's session id ("" when it cannot tell) and a burst key for its deletes ("" for the
	// door's per-mount window).
	Session(pid uint32) (session, burstKey string)
}

type noAttribution struct{}

func (noAttribution) Session(uint32) (string, string) { return "", "" }

// SocketAttributor asks the privileged parent over a socket it was given: one line `<pid>` out, one line
// `<pid> <starttime> <session or ->` back. Answers are cached for a few seconds by pid; the parent checks the process is the
// runner's and caches by pid and start time. Attribution is best effort: a slow or missing answer attributes nothing.
type SocketAttributor struct {
	conn    net.Conn
	reader  *bufio.Reader
	timeout time.Duration

	mu    sync.Mutex
	cache map[uint32]attribution
}

type attribution struct {
	session, burst string
	at             time.Time
}

// NewSocketAttributor speaks over conn.
func NewSocketAttributor(conn net.Conn) *SocketAttributor {
	return &SocketAttributor{conn: conn, reader: bufio.NewReader(conn), timeout: 300 * time.Millisecond, cache: map[uint32]attribution{}}
}

func (a *SocketAttributor) Session(pid uint32) (string, string) {
	if pid == 0 {
		return "", ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if hit, ok := a.cache[pid]; ok && time.Since(hit.at) < 5*time.Second {
		return hit.session, hit.burst
	}
	if len(a.cache) > 4096 {
		a.cache = map[uint32]attribution{}
	}
	_ = a.conn.SetDeadline(time.Now().Add(a.timeout))
	if _, err := fmt.Fprintf(a.conn, "%d\n", pid); err != nil {
		return "", ""
	}
	var fields []string
	for {
		line, err := a.reader.ReadString('\n')
		if err != nil {
			return "", ""
		}
		// An answer that came too late for an earlier question is skipped.
		fields = strings.Fields(line)
		if len(fields) == 3 && fields[0] == strconv.FormatUint(uint64(pid), 10) {
			break
		}
	}
	start, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return "", ""
	}
	hit := attribution{at: time.Now()}
	if start > 0 {
		hit.burst = fmt.Sprintf("pid:%d:%d", pid, start)
	}
	if fields[2] != "-" {
		hit.session = fields[2]
	}
	a.cache[pid] = hit
	return hit.session, hit.burst
}
