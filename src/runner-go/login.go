package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// How long a half-finished sign-in may hold its account. The user has to leave the page, approve
// in a browser and paste a code back, so this is generous; past it the CLI is killed and the
// account freed, otherwise one abandoned attempt would block that account's sign-in forever.
const loginRelayTimeout = 10 * time.Minute

// codexAccountLoginCapabilityV1 declares that this runner signs in the account a LoginCommand
// names (Account, AccountName) instead of ignoring it. A runner that ignored it would sign the
// machine's Default account in instead, so the control plane hands such a start only to a process
// that declares this.
const codexAccountLoginCapabilityV1 = "codex-account-login/v1"

// lookLoginEngine is lookEngine, the binary the relay probes. A variable so a test can stand a
// fake CLI in: the service PATH lookEngine searches puts ~/.local/bin first, where a dev machine's
// real codex lives.
var lookLoginEngine = lookEngine

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

// `kimi login` uses RFC 8628 device authorization and writes the browser URL
// and user code to stderr. Anchor both patterns to Kimi's explanatory text so a
// docs URL or build identifier cannot be mistaken for the login challenge.
var (
	kimiDeviceURLRe  = regexp.MustCompile(`(?m)Opening browser for Kimi device login:[ \t]*(https://[^\s\x1b\x07"']+)`)
	kimiDeviceCodeRe = regexp.MustCompile(`(?mi)enter code:[ \t]*([A-Z0-9][A-Z0-9-]{2,}[A-Z0-9])`)
)

func kimiDeviceLogin(s string) (url, code string) {
	if match := kimiDeviceURLRe.FindStringSubmatch(s); len(match) == 2 {
		url = match[1]
	}
	if match := kimiDeviceCodeRe.FindStringSubmatch(s); len(match) == 2 {
		code = match[1]
	}
	return url, code
}

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

// loginFlow is how one engine's sign-in is driven. The engines differ in kind,
// not merely in command spelling:
//
//   - claude prints a URL whose redirect_uri is Anthropic-hosted, then waits on stdin for the
//     code that page hands the user. It is a TUI, so it needs a pty to print anything at all.
//   - codex's `--device-auth` prints a URL *and* a one-time code to enter there, then polls for
//     the approval itself. Nothing is handed back, and it is plain stdout — no pty needed.
//   - kimi's `login` is also a device flow, printed to stderr. Its documented exit 0 is the
//     success signal, so the relay need not start a second ACP process after login completes.
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
	// successOnExit makes a clean CLI exit authoritative. Claude and Codex retain
	// their post-command auth probe because their exit status is not reliable.
	successOnExit bool
}

func (f loginFlow) cmdLine() string { return strings.Join(f.argv, " ") }

func loginFlowFor(engine string) loginFlow {
	switch engine {
	case providerCodex:
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
	case providerKimi:
		return loginFlow{
			engine: providerKimi,
			argv:   []string{providerKimi, "login"},
			progress: func(out string) *LoginResultRequest {
				u, code := kimiDeviceLogin(out)
				if u == "" || code == "" {
					return nil
				}
				return &LoginResultRequest{Status: loginAwaitingApproval, URL: u, UserCode: code}
			},
			successOnExit: true,
		}
	}
	if engine == providerOpenCode {
		// OpenCode authenticates its underlying provider/method, which the current
		// browser relay DTO cannot express. Keep it explicit so it never falls through
		// to (and accidentally launches) Claude's login flow.
		return loginFlow{engine: providerOpenCode}
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

// loginRelay drives engine logins on this machine while the user completes
// their browser authorization through the control plane.
//
// One at a time per account: a CLI writes the credentials of the account it signs in — claude's
// and kimi's the machine's one login, codex's the CODEX_HOME of one account slot — so two
// concurrent sign-ins into the same account would race over them, while sign-ins into different
// Codex slots write different files and run side by side. The heartbeat redelivers a `start`
// until the server sees a status change, so start() must be idempotent while that account's
// sign-in is already running.
type loginRelay struct {
	mu sync.Mutex
	wg sync.WaitGroup
	// The sign-ins running now, by the account each one writes (loginAccountKey).
	runs map[string]*loginRun
	// The slot the latest add-account attempt created, so a redelivery of that start signs into
	// it instead of adding the account a second time — and so the attempt that fails has exactly
	// the slot it created to take away again.
	addedAttempt, addedSlot string
	// That slot has been reclaimed: the attempt ended without a sign-in and its account is gone
	// from this machine. A redelivery of that start is told so rather than adding it back.
	addedReclaimed bool
	// liveSessionIDs names every session this runner is running, so reclaiming a slot the attempt
	// above created leaves one a live session is stuck to alone. Set by the run loop; nil in a
	// runner that has none.
	liveSessionIDs func() []string
}

// loginRun is one sign-in the relay is driving.
type loginRun struct {
	// The account it signs in (loginAccountKey).
	key string
	// Identifies the sign-in, so a redelivered `start` for the SAME attempt is a no-op while a
	// genuinely new one for the same account preempts it. Without this a user who cancelled was
	// locked out until the old CLI timed out ten minutes later: start() saw a relay running and
	// returned.
	attempt string
	stdin   io.WriteCloser
	cancel  context.CancelFunc
	// Everything the CLI has printed. Shared with submitCode so a rejected code — which the CLI
	// signals only by re-prompting — can be spotted.
	out *syncBuffer
	// slot is the Codex account this attempt ADDED, empty when it signs into one the runner already
	// had. It belongs to the run rather than to the relay — several attempts can be in flight at
	// once, each with a slot of its own — so the run that ends without signing in knows exactly
	// which empty account to take away again.
	slot string
}

// loginAccountKey names the account a sign-in writes: the engine's one login, or for codex one
// slot, where no account named is the runner's own CODEX_HOME — Default.
func loginAccountKey(engine, account string) string {
	if engine != providerCodex {
		return engine
	}
	if account == "" {
		account = codexAccountDefaultSlot
	}
	return engine + "/" + account
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

// start launches the sign-in `lr` asks for and reports progress through `report`. It returns
// immediately; the flow continues in a goroutine until the CLI exits or the relay times out.
//
// `lr.Attempt` is the server's identifier for this sign-in (its login_at). The heartbeat
// redelivers `start` until our first status report lands, so repeats of the SAME attempt must be
// ignored — but a DIFFERENT attempt at the same account means the user asked again (typically
// after cancelling), and that has to preempt whatever is still running there, or they wait out
// the old CLI's timeout for nothing.
func (r *loginRelay) start(lr LoginCommand, report func(LoginResultRequest)) {
	attempt := lr.Attempt
	flow := loginFlowFor(lr.Engine)
	if flow.engine == providerOpenCode {
		report(LoginResultRequest{Status: loginFailed, Message: "OpenCode sign-in is provider-specific — run `opencode auth login` on this runner and choose the provider there", Attempt: attempt})
		return
	}
	// Only codex has accounts; every other engine signs in the one login its CLI keeps.
	account, name := "", ""
	if flow.engine == providerCodex {
		account, name = lr.Account, strings.TrimSpace(lr.AccountName)
	}
	createdSlot := ""
	r.mu.Lock()
	if name != "" {
		// A new account is added once per attempt, and every redelivery of its start signs into
		// the slot the first one added.
		if r.addedAttempt == attempt && r.addedReclaimed {
			// That attempt's slot is gone: it ended without signing in, and leaving an empty
			// account behind on every failed attempt is what made "+ Account" accumulate them.
			// Say so rather than adding the account a second time under the same attempt.
			r.mu.Unlock()
			report(LoginResultRequest{
				Status:  loginFailed,
				Message: "the sign-in for this Codex account did not complete — start it again",
				Attempt: attempt,
			})
			return
		}
		if r.addedSlot != "" && r.addedAttempt == attempt {
			account = r.addedSlot
		} else {
			slot, err := createCodexAccountSlot(name)
			if err != nil {
				r.mu.Unlock()
				report(LoginResultRequest{Status: loginFailed, Message: "could not add the Codex account: " + firstLine(err.Error()), Attempt: attempt})
				return
			}
			r.addedAttempt, r.addedSlot, account, r.addedReclaimed = attempt, slot.ID, slot.ID, false
			createdSlot = slot.ID
		}
	}
	key := loginAccountKey(flow.engine, account)
	// Cheap pre-check for the heartbeat's redelivery of a start we are already running: the real
	// decision is made under the lock below, this just keeps the probe that follows from running
	// a subprocess every heartbeat for a sign-in that is already in flight.
	run := r.runs[key]
	redelivered := run != nil && (attempt == "" || attempt == run.attempt)
	r.mu.Unlock()
	if redelivered {
		return
	}
	// Every report names the attempt it is about and the account signing in, so the control plane
	// can tell which account this is and drop what a sign-in it has moved past still says.
	send := report
	report = func(res LoginResultRequest) {
		res.Attempt, res.Account = attempt, account
		send(res)
	}
	// A sign-in that cannot even start still added this attempt's account, and an account nobody
	// signed into and nobody can sign into again — the attempt is over — is not one to leave on the
	// machine. Take it away again before reporting, so a press that fails at once does not add an
	// empty account to the pile.
	giveUp := func(message string) {
		if createdSlot != "" {
			r.dropAddedSlot(createdSlot)
		}
		report(LoginResultRequest{Status: loginFailed, Message: message})
	}
	// Default, or no account named (an older control plane): the CLI runs in this process's own
	// environment, exactly as before accounts. Any other account runs in its slot's CODEX_HOME, and
	// so does every codex process of its sign-in — even printing its help, codex writes into the
	// CODEX_HOME it runs in, and none of that may land in Default.
	var env []string
	if account != "" && account != codexAccountDefaultSlot {
		home, err := codexAccountSlotHome(account)
		if err != nil {
			// Never fall back to Default: that would sign this account in over the machine's own.
			giveUp("this runner has no Codex account " + account + " — add the account again")
			return
		}
		env = envWithValue(os.Environ(), "CODEX_HOME", home)
	}
	// A codex old enough to lack the device flow can't be signed in from here at all, and its
	// error would surface as "couldn't read a sign-in URL" — say what actually has to happen.
	if flow.engine == providerCodex {
		spec, _ := specFor(providerCodex)
		if path, ok := lookLoginEngine(providerCodex); !ok || !supportsLoginFlag(path, spec, env) {
			giveUp("this runner's codex is too old to sign in from the browser — run `codex update` on that machine, or sign in there with `" + loginCommandIn(env, "codex login") + "`")
			return
		}
	}
	r.mu.Lock()
	if prev := r.runs[key]; prev != nil {
		if attempt == "" || attempt == prev.attempt {
			r.mu.Unlock()
			return // same sign-in, redelivered
		}
		// Newer attempt at this account: tear the old one down. Its pump sees the killed process,
		// and its report names an attempt the server has already moved past, which it drops.
		if prev.cancel != nil {
			prev.cancel()
		}
		delete(r.runs, key)
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginRelayTimeout)
	var cmd *exec.Cmd
	if flow.pty {
		cmd = ptyCommand(ctx, flow.argv...)
	} else {
		cmd = exec.CommandContext(ctx, flow.argv[0], flow.argv[1:]...)
	}
	cmd.Env = env
	// Only a flow that takes a pasted code needs a writable stdin; the device flow completes
	// on its own, so there is nothing to hold open.
	var stdin io.WriteCloser
	if flow.takesCode {
		p, err := cmd.StdinPipe()
		if err != nil {
			r.mu.Unlock()
			cancel()
			giveUp("could not open a pipe to the sign-in: " + err.Error())
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
		giveUp(signInStartError(err, flow))
		return
	}
	run = &loginRun{key: key, attempt: attempt, stdin: stdin, cancel: cancel, out: out, slot: createdSlot}
	if r.runs == nil {
		r.runs = map[string]*loginRun{}
	}
	r.runs[key] = run
	r.wg.Add(1)
	r.mu.Unlock()

	go func() {
		defer r.wg.Done()
		r.pump(run, flow, cmd, env, report)
	}()
}

// stop cancels and joins every relay process started by this runner. The caller
// must first stop heartbeat delivery so no new start can race with Wait.
func (r *loginRelay) stop() {
	r.mu.Lock()
	for _, run := range r.runs {
		if run.cancel != nil {
			run.cancel()
		}
	}
	r.mu.Unlock()
	r.wg.Wait()
}

// pump watches the sign-in: publish the URL as soon as it appears, then wait for the CLI to exit
// and report whether this machine ended up signed in. env is the environment the CLI ran in, and
// so the one to ask whether it did.
func (r *loginRelay) pump(run *loginRun, flow loginFlow, cmd *exec.Cmd, env []string, report func(LoginResultRequest)) {
	out := run.out
	// Wait in its own goroutine so the URL poll below can tell "still running" from "already
	// exited" — cmd.ProcessState stays nil until Wait returns, so it can't answer that itself.
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	// Set by the paths that end this sign-in with an account signed in. Every other way out — the
	// CLI failed, the relay timed out, a newer attempt replaced this one — leaves the slot this
	// attempt added empty, and the defer below takes it away again.
	signedIn := false
	defer func() {
		run.cancel()
		if run.stdin != nil {
			_ = run.stdin.Close()
		}
		r.mu.Lock()
		// Only clear if we are still this account's sign-in — a newer start() may already own it.
		if r.runs[run.key] == run {
			delete(r.runs, run.key)
		}
		r.mu.Unlock()
		if !signedIn {
			r.reclaimAddedSlot(run)
		}
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
		if exited && exitErr == nil && flow.successOnExit {
			signedIn = true
			report(LoginResultRequest{Status: loginDone})
			return
		}
		// Either the CLI died immediately, or its output changed enough that the pattern no
		// longer matches. Say so plainly — the card falls back to "run it on that machine".
		if !exited {
			_ = cmd.Process.Kill()
			<-waited
		}
		report(LoginResultRequest{
			Status:  loginFailed,
			Message: "couldn't read a sign-in URL from the CLI — run `" + loginCommandIn(env, flow.cmdLine()) + "` on this machine instead",
		})
		return
	}

	if !exited {
		exitErr = <-waited
	}
	if exitErr == nil && flow.successOnExit {
		signedIn = true
		report(LoginResultRequest{Status: loginDone})
		return
	}
	// The CLI's exit code isn't a reliable success signal, so ask the question `orbit doctor`
	// asks: is this machine actually signed in now?
	if probeAuthNow(flow.engine, env) == authYes {
		signedIn = true
		report(LoginResultRequest{Status: loginDone})
		return
	}
	msg := "sign-in did not complete"
	if exitErr != nil {
		msg += " (" + firstLine(exitErr.Error()) + ")"
	}
	report(LoginResultRequest{Status: loginFailed, Message: msg})
}

// reclaimAddedSlot takes away the slot this attempt added, once the attempt has ended without
// signing in: the CLI failed, the relay timed out, or a newer attempt replaced this one. Such a slot
// is a CODEX_HOME nobody signed into and nobody can sign into again — the attempt it belonged to is
// over — so leaving it behind is what made a retried "+ Account" accumulate empty accounts of the
// same name. The account the user already had is untouched: this only ever removes a slot this
// process created for this attempt.
//
// The record is kept that it is gone (addedReclaimed), so a redelivery of that same start is told
// the sign-in did not complete instead of adding a second slot for an attempt the server has moved
// past.
func (r *loginRelay) reclaimAddedSlot(run *loginRun) {
	slot := run.slot
	if slot == "" || !r.dropAddedSlot(slot) {
		return
	}
	// The relay remembers it only while this was still the attempt the relay is adding for: a
	// redelivery of THAT start is told the sign-in did not complete rather than adding the account
	// again. A newer attempt owns that memory now, and leaves the older one's slot to this call.
	r.mu.Lock()
	if r.addedAttempt == run.attempt && r.addedSlot == slot {
		r.addedReclaimed = true
	}
	r.mu.Unlock()
}

// dropAddedSlot takes added slot id off this machine, and says whether it is gone. It is the one
// way a slot an attempt added stops existing — the reclaim above, and a sign-in that could not
// start at all — so both leave exactly the same thing behind: nothing.
//
// Two slots stay. One that did end up signed in: the sign-in can land between the probe that
// reported failure and this call, and an account with credentials in it is not ours to delete. And
// one a live session is stuck to (codexSessionAccountHomes), which the user can remove from the
// page once that session is over.
func (r *loginRelay) dropAddedSlot(slot string) bool {
	if home, err := codexAccountSlotHome(slot); err != nil || codexAccountSignedIn(home) {
		return false
	}
	var liveHomes map[string]bool
	if r.liveSessionIDs != nil {
		liveHomes = codexSessionAccountHomes(r.liveSessionIDs())
	}
	if err := removeCodexAccountSlot(slot, liveHomes); err != nil {
		logln("codex account", slot, "was not reclaimed:", firstLine(err.Error()))
		return false
	}
	return true
}

// codexAccountSignedIn asks the question `orbit doctor` asks about one Codex account: is the CLI in
// this CODEX_HOME signed in. Unanswered — no CLI to ask — counts as not signed in, since the slot
// this is asked about was created minutes ago and has only ever been signed out.
func codexAccountSignedIn(codexHome string) bool {
	path, ok := lookLoginEngine(providerCodex)
	return ok && codexSlotLoginStatus(path, codexHome) == authYes
}

// submitCode hands the user's pasted authorization code to the waiting CLI, then watches for the
// CLI to reject it. Reports a failure outright only when nothing is waiting for the code — a
// stale paste from a relay that already timed out.
func (r *loginRelay) submitCode(code string, report func(LoginResultRequest)) {
	r.mu.Lock()
	// Only claude's flow takes a pasted code, and claude has the one account.
	run := r.runs[providerClaude]
	r.mu.Unlock()
	if run == nil || run.stdin == nil {
		report(LoginResultRequest{Status: loginFailed, Message: "the sign-in expired before the code arrived — start it again"})
		return
	}
	send := report
	report = func(res LoginResultRequest) {
		res.Attempt = run.attempt
		send(res)
	}
	seen := strings.Count(run.out.String(), loginInvalidCodeMarker)
	if _, err := io.WriteString(run.stdin, strings.TrimSpace(code)+"\n"); err != nil {
		report(LoginResultRequest{Status: loginFailed, Message: "could not hand the code to the CLI: " + err.Error()})
		return
	}
	go r.watchRejected(run, seen, report)
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
func (r *loginRelay) watchRejected(run *loginRun, seen int, report func(LoginResultRequest)) {
	deadline := time.After(2 * time.Minute)
	for {
		select {
		case <-deadline:
			return
		case <-time.After(500 * time.Millisecond):
		}
		r.mu.Lock()
		running := r.runs[run.key] == run
		r.mu.Unlock()
		if !running {
			return // pump already reported the outcome
		}
		s := run.out.String()
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

// probeAuthNow re-runs doctor's sign-in probe against the engine binary on the service PATH, in
// env when the sign-in ran in one Codex account's CODEX_HOME rather than this process's own.
func probeAuthNow(engine string, env []string) authState {
	path, ok := lookLoginEngine(engine)
	if !ok {
		return authUnknown
	}
	if env != nil {
		// Only a sign-in into a Codex account runs in an environment of its own.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return codexLoginStatus(ctx, path, env)
	}
	return probeAuth(engine, path)
}

// loginCommandIn spells a sign-in command the way to run it by hand for the account env signs in:
// run bare, a command meant for one Codex account's CODEX_HOME would sign in Default instead.
func loginCommandIn(env []string, cmdLine string) string {
	if home := envValue(env, "CODEX_HOME"); home != "" {
		return "CODEX_HOME=" + shellQuote(home) + " " + cmdLine
	}
	return cmdLine
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
