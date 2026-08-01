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

// Login relay statuses reported to the control plane. They mirror the `login_status` column.
// awaitingCode is the only one the server acts on (it forwards the pasted code); awaitingApproval
// is the device flow's equivalent, where there is nothing to hand back — the user types the code
// into the browser and the CLI polls for it.
const (
	loginAwaitingCode     = "awaiting_code"
	loginAwaitingApproval = "awaiting_approval"
	loginDone             = "done"
	loginFailed           = "failed"
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

// What `codex login --device-auth` prints: a fixed sign-in page, then a one-time code to type
// there. Both arrive coloured, so a match ends at the escape byte that closes the colour.
var (
	codexDeviceURLRe  = regexp.MustCompile(`https://auth\.openai\.com/[^\s\x1b\x07"']*device[^\s\x1b\x07"']*`)
	codexDeviceCodeRe = regexp.MustCompile(`[A-Z0-9]{4,}-[A-Z0-9]{4,}`)
)

// codexDeviceCode pulls the one-time code out of the CLI's output. Anchored to the line that
// announces it ("2. Enter this one-time code") so nothing else that happens to look like a code
// — a build tag, an id in a warning — can be mistaken for one.
func codexDeviceCode(s string) string {
	i := strings.Index(s, "one-time code")
	if i < 0 {
		return ""
	}
	return codexDeviceCodeRe.FindString(s[i:])
}

// loginFlow is how one engine's sign-in is driven. The two differ in kind, not in detail:
//
//   - claude prints a URL whose redirect_uri is Anthropic-hosted, then waits on stdin for the
//     code that page hands the user. It is a TUI, so it needs a pty to print anything at all.
//   - codex's `--device-auth` prints a URL *and* a one-time code to enter there, then polls for
//     the approval itself. Nothing is handed back, and it is plain stdout — no pty needed.
//
// Plain `codex login` is not an option here: it serves its callback on localhost:1455 on the
// runner, which the user's browser can't reach (see engineSpec.loginRemoteFlag).
type loginFlow struct {
	engine string
	argv   []string
	pty    bool
	// progress scrapes the accumulated output for what the user needs next, returning nil
	// until it's all there.
	progress func(out string) *LoginResultRequest
	// takesCode is set for a flow the user pastes a code back into.
	takesCode bool
}

func (f loginFlow) cmdLine() string { return strings.Join(f.argv, " ") }

func loginFlowFor(engine string) loginFlow {
	if engine == providerCodex {
		return loginFlow{
			engine: providerCodex,
			argv:   []string{providerCodex, "login", "--device-auth"},
			progress: func(out string) *LoginResultRequest {
				u, code := codexDeviceURLRe.FindString(out), codexDeviceCode(out)
				if u == "" || code == "" {
					return nil
				}
				return &LoginResultRequest{Status: loginAwaitingApproval, URL: u, UserCode: code}
			},
		}
	}
	// Anything else (including the empty engine an older control plane sends) is claude.
	return loginFlow{
		engine: providerClaude,
		argv:   []string{providerClaude, "auth", "login"},
		pty:    true,
		progress: func(out string) *LoginResultRequest {
			if u := latestLoginURL(out); u != "" {
				return &LoginResultRequest{Status: loginAwaitingCode, URL: u}
			}
			return nil
		},
		takesCode: true,
	}
}

// loginRelay drives one interactive `claude auth login` on this machine while the user approves
// it in their own browser and pastes the resulting code back through the control plane.
//
// One at a time per runner: the CLI writes this machine's single credentials file, so two
// concurrent sign-ins would race over it, and the heartbeat redelivers a `start` until the
// server sees a status change — so start() must be idempotent while one is already running.
type loginRelay struct {
	mu      sync.Mutex
	wg      sync.WaitGroup
	running bool
	stdin   io.WriteCloser
	cancel  context.CancelFunc
	// Identifies the sign-in currently running, so a redelivered `start` for the SAME attempt is
	// a no-op while a genuinely new one preempts it. Without this a user who cancelled was locked
	// out until the old CLI timed out ten minutes later: start() saw a relay running and returned.
	attempt string
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

// start launches the sign-in identified by `attempt` and reports progress through `report`. It
// returns immediately; the flow continues in a goroutine until the CLI exits or the relay times
// out.
//
// `attempt` is the server's identifier for this sign-in (its login_at). The heartbeat redelivers
// `start` until our first status report lands, so repeats of the SAME attempt must be ignored —
// but a DIFFERENT attempt means the user asked again (typically after cancelling), and that has
// to preempt whatever is still running, or they wait out the old CLI's timeout for nothing.
func (r *loginRelay) start(attempt, engine string, report func(LoginResultRequest)) {
	flow := loginFlowFor(engine)
	// Cheap pre-check for the heartbeat's redelivery of a start we are already running: the real
	// decision is made under the lock below, this just keeps the probe that follows from running
	// a subprocess every heartbeat for a sign-in that is already in flight.
	r.mu.Lock()
	redelivered := r.running && (attempt == "" || attempt == r.attempt)
	r.mu.Unlock()
	if redelivered {
		return
	}
	// A codex old enough to lack the device flow can't be signed in from here at all, and its
	// error would surface as "couldn't read a sign-in URL" — say what actually has to happen.
	if flow.engine == providerCodex {
		spec, _ := specFor(providerCodex)
		if path, ok := lookEngine(providerCodex); !ok || !supportsLoginFlag(path, spec) {
			report(LoginResultRequest{Status: loginFailed, Message: "this runner's codex is too old to sign in from the browser — run `codex update` on that machine, or sign in there with `codex login`"})
			return
		}
	}
	r.mu.Lock()
	if r.running {
		if attempt == "" || attempt == r.attempt {
			r.mu.Unlock()
			return // same sign-in, redelivered
		}
		// Newer attempt: tear the old one down. Its pump sees the killed process, but its report
		// is for a sign-in the server has already moved past, so let it fall on the floor.
		if r.cancel != nil {
			r.cancel()
		}
		r.running = false
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginRelayTimeout)
	var cmd *exec.Cmd
	if flow.pty {
		cmd = ptyCommand(ctx, flow.argv...)
	} else {
		cmd = exec.CommandContext(ctx, flow.argv[0], flow.argv[1:]...)
	}
	// Only a flow that takes a pasted code needs a writable stdin; the device flow completes
	// on its own, so there is nothing to hold open.
	var stdin io.WriteCloser
	if flow.takesCode {
		p, err := cmd.StdinPipe()
		if err != nil {
			r.mu.Unlock()
			cancel()
			report(LoginResultRequest{Status: loginFailed, Message: "could not open a pipe to the sign-in: " + err.Error()})
			return
		}
		stdin = p
	}
	out := &syncBuffer{}
	cmd.Stdout = out
	cmd.Stderr = out
	if err := cmd.Start(); err != nil {
		r.mu.Unlock()
		cancel()
		if stdin != nil {
			_ = stdin.Close()
		}
		// `script` missing is the one failure worth naming precisely: everything else the user
		// can act on, but this one means the relay can never work on this machine.
		report(LoginResultRequest{Status: loginFailed, Message: signInStartError(err, flow)})
		return
	}
	r.running, r.stdin, r.cancel, r.out, r.attempt = true, stdin, cancel, out, attempt
	r.wg.Add(1)
	r.mu.Unlock()

	go func() {
		defer r.wg.Done()
		r.pump(attempt, flow, cmd, out, cancel, stdin, report)
	}()
}

// stop cancels and joins every relay process started by this runner. The caller
// must first stop heartbeat delivery so no new start can race with Wait.
func (r *loginRelay) stop() {
	r.mu.Lock()
	if r.cancel != nil {
		r.cancel()
	}
	r.mu.Unlock()
	r.wg.Wait()
}

// pump watches the sign-in: publish the URL as soon as it appears, then wait for the CLI to exit
// and report whether this machine ended up signed in.
func (r *loginRelay) pump(attempt string, flow loginFlow, cmd *exec.Cmd, out *syncBuffer, cancel context.CancelFunc, stdin io.WriteCloser, report func(LoginResultRequest)) {
	// Wait in its own goroutine so the URL poll below can tell "still running" from "already
	// exited" — cmd.ProcessState stays nil until Wait returns, so it can't answer that itself.
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	defer func() {
		cancel()
		if stdin != nil {
			_ = stdin.Close()
		}
		r.mu.Lock()
		// Only clear if we are still the current attempt — a newer start() may already own these.
		if r.attempt == attempt {
			r.running, r.stdin, r.cancel, r.out = false, nil, nil, nil
		}
		r.mu.Unlock()
	}()

	// Poll the accumulated output rather than scanning lines: the TUI redraws with carriage
	// returns and no trailing newline, so a line scanner can sit on a complete URL indefinitely
	// waiting for an EOL that only arrives later.
	urlDeadline := time.After(90 * time.Second)
	var exitErr error
	exited := false
	sent := false
poll:
	for {
		if res := flow.progress(out.String()); res != nil {
			report(*res)
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
			Message: "couldn't read a sign-in URL from the CLI — run `" + flow.cmdLine() + "` on this machine instead",
		})
		return
	}

	if !exited {
		exitErr = <-waited
	}
	// The CLI's exit code isn't a reliable success signal, so ask the question `orbit doctor`
	// asks: is this machine actually signed in now?
	if probeAuthNow(flow.engine) == authYes {
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

// probeAuthNow re-runs doctor's sign-in probe against the engine binary on the service PATH.
func probeAuthNow(engine string) authState {
	path, ok := lookEngine(engine)
	if !ok {
		return authUnknown
	}
	return probeAuth(engine, path)
}

func signInStartError(err error, flow loginFlow) string {
	if flow.pty && strings.Contains(err.Error(), "executable file not found") {
		return "this machine has no `script` command, which the browser-less sign-in needs — run `" + flow.cmdLine() + "` on it directly"
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
