package main

import (
	"bytes"
	"context"
	"io"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// How long a half-finished sign-in may hold the runner's single login slot. The user has to
// leave the page, approve in a browser and paste a code back, so this is generous; past it the
// CLI is killed and the slot freed, otherwise one abandoned attempt would block sign-in forever.
const loginRelayTimeout = 10 * time.Minute

// Login relay statuses reported to the control plane. They mirror the `login_status` column, and
// awaitingCode is the only non-terminal one the server acts on (it forwards the pasted code).
const (
	loginAwaitingCode = "awaiting_code"
	loginDone         = "done"
	loginFailed       = "failed"
)

// The sign-in URL claude prints. It is emitted inside an OSC 8 hyperlink and then repeated in
// wrapped fragments, so a match is the escape sequence's target, terminated by BEL. Requiring
// the oauth path keeps a stray docs link from matching.
var loginURLRe = regexp.MustCompile(`https://claude\.com/[^\s\x07"']*oauth/authorize\?[^\s\x07"']+`)

// What the CLI prints when a pasted code is rejected: "Invalid code. Please make sure the full
// code was copied." — written after the existing prompt, on the same line. This is the ONLY
// signal a paste failed. The process does not exit, does not re-prompt, and does not start a
// fresh OAuth exchange: it keeps waiting on the same challenge, so the URL already published
// stays valid and the user just needs to fetch a code from it again.
const loginInvalidCodeMarker = "Invalid code"

// latestLoginURL returns the LAST authorize URL in the output. Within one run the CLI prints the
// same URL twice (the OSC 8 hyperlink target and its visible label), so first and last agree;
// taking the last is simply the safe choice if a future CLI ever does re-issue one.
func latestLoginURL(s string) string {
	m := loginURLRe.FindAllString(s, -1)
	if len(m) == 0 {
		return ""
	}
	return m[len(m)-1]
}

// loginRelay drives one interactive `claude auth login` on this machine while the user approves
// it in their own browser and pastes the resulting code back through the control plane.
//
// One at a time per runner: the CLI writes this machine's single credentials file, so two
// concurrent sign-ins would race over it, and the heartbeat redelivers a `start` until the
// server sees a status change — so start() must be idempotent while one is already running.
type loginRelay struct {
	mu      sync.Mutex
	running bool
	stdin   io.WriteCloser
	cancel  context.CancelFunc
	// Everything the CLI has printed. Shared with submitCode so a rejected code — which the CLI
	// signals only by re-prompting — can be spotted.
	out *syncBuffer
}

// ptyCommand wraps argv in a pseudo-terminal.
//
// A PTY is not optional here: claude's sign-in is an interactive TUI that detects a non-tty and
// prints nothing at all — piping it yields an empty stream and a hung process, so there is no URL
// to scrape. Rather than take this module's first third-party dependency for a pty syscall
// wrapper, or hand-roll the linux and darwin ioctls when only one of them can be tested here, we
// borrow the OS's own pty tool. The runner already shells out to bash, git and the engine CLIs,
// so this is the same kind of dependency it already has. The flag spelling differs: util-linux
// takes `-c "cmd"`, BSD/macOS takes the command as trailing argv.
func ptyCommand(ctx context.Context, argv ...string) *exec.Cmd {
	if runtime.GOOS == "darwin" {
		return exec.CommandContext(ctx, "script", append([]string{"-q", "/dev/null"}, argv...)...)
	}
	return exec.CommandContext(ctx, "script", "-qec", strings.Join(argv, " "), "/dev/null")
}

// start launches the sign-in and reports progress back through `report`. It returns immediately;
// the flow continues in a goroutine until the CLI exits or loginRelayTimeout fires.
//
// Calling it while a sign-in is already running is a no-op — the heartbeat delivers `start`
// repeatedly until the server has seen our first status report.
func (r *loginRelay) start(report func(LoginResultRequest)) {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginRelayTimeout)
	cmd := ptyCommand(ctx, providerClaude, "auth", "login")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		r.mu.Unlock()
		cancel()
		report(LoginResultRequest{Status: loginFailed, Message: "could not open a pipe to the sign-in: " + err.Error()})
		return
	}
	out := &syncBuffer{}
	cmd.Stdout = out
	cmd.Stderr = out
	if err := cmd.Start(); err != nil {
		r.mu.Unlock()
		cancel()
		_ = stdin.Close()
		// `script` missing is the one failure worth naming precisely: everything else the user
		// can act on, but this one means the relay can never work on this machine.
		report(LoginResultRequest{Status: loginFailed, Message: signInStartError(err)})
		return
	}
	r.running, r.stdin, r.cancel, r.out = true, stdin, cancel, out
	r.mu.Unlock()

	go r.pump(cmd, out, cancel, stdin, report)
}

// pump watches the sign-in: publish the URL as soon as it appears, then wait for the CLI to exit
// and report whether this machine ended up signed in.
func (r *loginRelay) pump(cmd *exec.Cmd, out *syncBuffer, cancel context.CancelFunc, stdin io.WriteCloser, report func(LoginResultRequest)) {
	// Wait in its own goroutine so the URL poll below can tell "still running" from "already
	// exited" — cmd.ProcessState stays nil until Wait returns, so it can't answer that itself.
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	defer func() {
		cancel()
		_ = stdin.Close()
		r.mu.Lock()
		r.running, r.stdin, r.cancel, r.out = false, nil, nil, nil
		r.mu.Unlock()
	}()

	// Poll the accumulated output for the URL rather than scanning lines: the TUI redraws with
	// carriage returns and no trailing newline, so a line scanner can sit on a complete URL
	// indefinitely waiting for an EOL that only arrives later.
	urlDeadline := time.After(90 * time.Second)
	var exitErr error
	exited := false
	sent := false
poll:
	for {
		if m := latestLoginURL(out.String()); m != "" {
			report(LoginResultRequest{Status: loginAwaitingCode, URL: m})
			sent = true
			break
		}
		select {
		case exitErr = <-waited:
			exited = true // died before printing anything usable
			break poll
		case <-urlDeadline:
			break poll
		case <-time.After(300 * time.Millisecond):
		}
	}

	if !sent {
		// Either the CLI died immediately, or its output changed enough that the pattern no
		// longer matches. Say so plainly — the card falls back to "run it on that machine".
		if !exited {
			_ = cmd.Process.Kill()
			<-waited
		}
		report(LoginResultRequest{
			Status:  loginFailed,
			Message: "couldn't read a sign-in URL from the CLI — run `claude auth login` on this machine instead",
		})
		return
	}

	if !exited {
		exitErr = <-waited
	}
	// The CLI's exit code isn't a reliable success signal, so ask the question `orbit doctor`
	// asks: is this machine actually signed in now?
	if probeAuthNow() == authYes {
		report(LoginResultRequest{Status: loginDone})
		return
	}
	msg := "sign-in did not complete"
	if exitErr != nil {
		msg += " (" + firstLine(exitErr.Error()) + ")"
	}
	report(LoginResultRequest{Status: loginFailed, Message: msg})
}

// submitCode hands the user's pasted authorization code to the waiting CLI, then watches for the
// CLI to reject it. Reports a failure outright only when nothing is waiting for the code — a
// stale paste from a relay that already timed out.
func (r *loginRelay) submitCode(code string, report func(LoginResultRequest)) {
	r.mu.Lock()
	stdin, out := r.stdin, r.out
	r.mu.Unlock()
	if stdin == nil {
		report(LoginResultRequest{Status: loginFailed, Message: "the sign-in expired before the code arrived — start it again"})
		return
	}
	seen := strings.Count(out.String(), loginInvalidCodeMarker)
	if _, err := io.WriteString(stdin, strings.TrimSpace(code)+"\n"); err != nil {
		report(LoginResultRequest{Status: loginFailed, Message: "could not hand the code to the CLI: " + err.Error()})
		return
	}
	go r.watchRejected(out, seen, report)
}

// watchRejected turns the CLI's "Invalid code" line into a report the user can act on.
//
// A bad code is otherwise invisible: the CLI prints that one line and goes right back to waiting
// on the same prompt — it does not exit, so the pump has nothing to report and the card would sit
// on "waiting" until the relay timed out ten minutes later. Counting occurrences rather than
// testing for presence means a second bad paste is caught too.
//
// The URL is republished unchanged: the challenge is still live, so the user re-approves at the
// same link and copies the code more carefully.
func (r *loginRelay) watchRejected(out *syncBuffer, seen int, report func(LoginResultRequest)) {
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case <-deadline:
			return
		case <-time.After(500 * time.Millisecond):
		}
		r.mu.Lock()
		running := r.running
		r.mu.Unlock()
		if !running {
			return // pump already reported the outcome
		}
		s := out.String()
		if strings.Count(s, loginInvalidCodeMarker) > seen {
			report(LoginResultRequest{
				Status:  loginAwaitingCode,
				URL:     latestLoginURL(s),
				Message: "That code wasn't accepted — make sure you copied all of it, then try again.",
			})
			return
		}
	}
}

// probeAuthNow re-runs doctor's sign-in probe against the claude binary on the service PATH.
func probeAuthNow() authState {
	path, ok := lookPathIn(providerClaude, serviceLoginPath())
	if !ok {
		if p, err := exec.LookPath(providerClaude); err == nil {
			path = p
		} else {
			return authUnknown
		}
	}
	return probeAuth(providerClaude, path)
}

func signInStartError(err error) string {
	if strings.Contains(err.Error(), "executable file not found") {
		return "this machine has no `script` command, which the browser-less sign-in needs — run `claude auth login` on it directly"
	}
	return "could not start the sign-in: " + firstLine(err.Error())
}

// syncBuffer is a bytes.Buffer safe for the writer goroutine and our poller to share.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
