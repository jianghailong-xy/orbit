package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// The machine broker's rendezvous point. root owns it and the mode is 0666 because
	// *any* local user may ask — what a caller is allowed to do is decided from their
	// peer credentials, not from who can open the socket.
	hostdSocketPath = "/run/orbit/host.sock"
	hostdSocketPerm = 0o666
	// sd_listen_fds hands the first passed descriptor over as fd 3.
	hostdListenFDsStart = 3
	// Exit after a quiet spell and let socket activation own the lifetime: systemd keeps
	// the listening socket and re-spawns us on the next connect, so a hostd binary that
	// was replaced on disk takes effect on its own rather than after someone remembers
	// to restart a service.
	hostdIdleTimeout = 30 * time.Second
	// One request in, one response out. A peer that stalls mid-exchange must not pin a
	// handler forever.
	hostdConnTimeout = 10 * time.Second
)

// hostdPeer is the kernel's answer to "who opened this connection". It is the only
// source of identity hostd has, and the only one it will accept.
type hostdPeer struct {
	UID uint32
	PID int32
}

// unitForUid names a user's runner instance. The instance key is the uid, not the
// username: unit names have to escape characters that usernames allow, and
// systemdServiceFor's escaping is lossy — "alice.b" and "alice_b" both map to
// orbit-runner-alice_b, so two real accounts (and real usernames do contain dots)
// would fight over one unit. uids cannot collide, so keying on them removes the whole
// class of problem rather than patching one escape table.
func unitForUid(uid uint32) string {
	return fmt.Sprintf("orbit-runner@%d.service", uid)
}

// hostdConfig is everything the daemon needs from its surroundings, injected so tests
// can drive the very same code against a temporary socket and a hand-made descriptor
// handover. The zero value means "production defaults".
type hostdConfig struct {
	socketPath string // "" → hostdSocketPath
	// 0 → hostdIdleTimeout; negative → never exit on idle (foreground debugging).
	idleTimeout time.Duration
	getenv      func(string) string // nil → os.Getenv
	pid         int                 // 0 → os.Getpid()
	listenFD    int                 // 0 → hostdListenFDsStart
}

func (c hostdConfig) withDefaults() hostdConfig {
	if c.socketPath == "" {
		c.socketPath = hostdSocketPath
	}
	if c.idleTimeout == 0 {
		c.idleTimeout = hostdIdleTimeout
	}
	if c.getenv == nil {
		c.getenv = os.Getenv
	}
	if c.pid == 0 {
		c.pid = os.Getpid()
	}
	if c.listenFD == 0 {
		c.listenFD = hostdListenFDsStart
	}
	return c
}

// cmdHostd is `orbit hostd`, the command orbit-hostd.service's ExecStart names. It is
// composition and nothing else — take the socket systemd handed over (or open one
// ourselves), serve the verb table on it — because each half is tested on its own and
// an entry point that stays thin is one that cannot drift from what it joins up.
//
// sys is a parameter rather than hostdSystemDefaults() called in here, so a test can
// drive this very entry against a recording systemctl instead of the machine's own.
func cmdHostd(cfg hostdConfig, sys hostdSystem, foreground bool, stderr io.Writer) error {
	if runtime.GOOS != "linux" {
		// Not a missing feature to fill in later: hostd brokers systemd units and takes
		// its whole notion of identity from SO_PEERCRED, so on a platform with neither
		// there is no version of this that does anything (see hostd_peercred_other.go).
		return errors.New("hostd brokers systemd units and identifies its callers with SO_PEERCRED, so it runs on Linux only")
	}
	if foreground {
		// Negative rather than zero: withDefaults reads zero as "use the default", and a
		// broker that vanished 30s into a debugging session is the thing this switch
		// exists to prevent.
		cfg.idleTimeout = -1
	}
	l, err := hostdListen(cfg)
	if err != nil {
		return err
	}
	defer l.Close()
	if foreground {
		// Under systemd stderr is the journal and silence is right; run by hand, "which
		// socket did it actually take" is the first question, so answer it unasked.
		fmt.Fprintf(stderr, "orbit-hostd: serving %s in the foreground — idle exit disabled\n", l.Addr())
	}
	// sys.verbs() is the one place the table is built. Spelling the verbs out again here
	// would make this the second place, and the copy that goes stale is always the one
	// the daemon actually serves.
	return hostdServe(l, cfg, sys.verbs())
}

// systemdListenFDs reports how many listening sockets systemd passed in through the
// sd_listen_fds protocol. LISTEN_PID must name this very process: the variables are
// inherited like any other, and a child that mistook its parent's handover for its own
// would adopt an unrelated descriptor as its listener.
func systemdListenFDs(getenv func(string) string, pid int) int {
	if getenv("LISTEN_PID") != strconv.Itoa(pid) {
		return 0
	}
	n, err := strconv.Atoi(getenv("LISTEN_FDS"))
	if err != nil || n < 1 {
		return 0
	}
	return n
}

// hostdListen returns the socket to serve on: the one systemd handed over when we were
// socket-activated, or else one we create at socketPath ourselves (the foreground and
// test path). Only the first passed descriptor is used — hostd serves one socket.
func hostdListen(cfg hostdConfig) (net.Listener, error) {
	cfg = cfg.withDefaults()

	if systemdListenFDs(cfg.getenv, cfg.pid) > 0 {
		f := os.NewFile(uintptr(cfg.listenFD), "orbit-hostd.socket")
		l, err := net.FileListener(f)
		// FileListener dups the descriptor, so ours is surplus either way. Closing it
		// also leaves the socket unlinked-on-close=false, which is what we want: the
		// socket file belongs to systemd, not to this process.
		f.Close()
		if err != nil {
			return nil, fmt.Errorf("cannot adopt the socket systemd passed on fd %d: %w", cfg.listenFD, err)
		}
		return l, nil
	}

	if err := os.MkdirAll(filepath.Dir(cfg.socketPath), 0o755); err != nil {
		return nil, err
	}
	// A crashed hostd leaves its socket file behind and Listen would fail on it even
	// though nobody is listening — but so does a *live* hostd, and unlinking that one
	// would silently steal the machine's broker. Ask before removing.
	if c, err := net.Dial("unix", cfg.socketPath); err == nil {
		c.Close()
		return nil, fmt.Errorf("%s is already served by another hostd", cfg.socketPath)
	}
	_ = os.Remove(cfg.socketPath)
	l, err := net.Listen("unix", cfg.socketPath)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(cfg.socketPath, hostdSocketPerm); err != nil {
		l.Close()
		return nil, fmt.Errorf("cannot open %s to local users: %w", cfg.socketPath, err)
	}
	return l, nil
}

// hostdServe accepts one-shot connections until the listener closes or the machine
// stays quiet for cfg.idleTimeout, whichever comes first. Idle exit returns nil; any
// other accept failure is returned as-is.
func hostdServe(l net.Listener, cfg hostdConfig, verbs map[string]hostdVerb) error {
	cfg = cfg.withDefaults()

	var (
		wg    sync.WaitGroup
		idled atomic.Bool
		timer *time.Timer
	)
	if cfg.idleTimeout > 0 {
		// Closing the listener is how the timer interrupts a blocked Accept.
		timer = time.AfterFunc(cfg.idleTimeout, func() {
			idled.Store(true)
			l.Close()
		})
		defer timer.Stop()
	}

	for {
		conn, err := l.Accept()
		if err != nil {
			// In-flight callers get their answer before the process goes away; a request
			// accepted just as the idle timer fired is still a request we said yes to.
			wg.Wait()
			if idled.Load() {
				return nil
			}
			return err
		}
		if timer != nil {
			timer.Reset(cfg.idleTimeout)
		}
		wg.Add(1)
		// One goroutine per connection: verbs shell out to systemctl, and a peer that
		// connects and then says nothing must not hold the whole machine's broker.
		go func() {
			defer wg.Done()
			hostdServeConn(conn, verbs)
		}()
	}
}

// hostdServeConn runs one exchange: authenticate the peer from the kernel, read one
// request, write one response, close.
func hostdServeConn(conn net.Conn, verbs map[string]hostdVerb) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(hostdConnTimeout))

	var resp hostdResponse
	// Identity first: an unauthenticated peer's request body is not worth parsing.
	peer, err := hostdPeerCredential(conn)
	if err != nil {
		resp = hostdFail("cannot read peer credentials: %v", err)
	} else {
		var raw json.RawMessage
		if err := json.NewDecoder(io.LimitReader(conn, hostdMaxRequestBytes)).Decode(&raw); err != nil {
			resp = hostdFail("malformed request: %v", err)
		} else {
			resp = hostdHandle(raw, peer, verbs)
		}
	}
	_ = json.NewEncoder(conn).Encode(resp)
}
