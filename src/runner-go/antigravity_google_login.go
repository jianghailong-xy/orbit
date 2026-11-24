package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Only OSC 8 targets are authoritative: the visible URL wraps at terminal columns.
var antigravityGoogleURLRe = regexp.MustCompile(`\x1b\]8;[^;\x07\x1b]*;(https://accounts\.google\.com/o/oauth2/auth\?[^\x07\x1b\s]+)(?:\x07|\x1b\\)`)

// Observed with a deliberately malformed code on official agy 1.2.16, Linux.
const antigravityGoogleInvalidCodeMarker = `oauth2: "invalid_grant" "Malformed auth code."`

// agy's TUI asks the terminal who it is (secondary Device Attributes, CSI > c) before it draws, and
// on macOS (agy 1.5.16) draws nothing until a terminal answers: no login menu, no link, an agy that
// waits out the relay's timeout. The relay answers it once, as a VT220-class terminal would
// (contract §16.12).
const (
	antigravityGoogleDA2Query = "\x1b[>c"
	antigravityGoogleDA2Reply = "\x1b[>0;95;0c"
)

// A fresh OAuth flow must not reuse the old token. Preserve it privately so a cancelled or failed
// replacement leaves the previous login intact; commit only after the new token passes /usage. dir is
// the Gemini directory the sign-in writes: Default's, or an added account's.
func preserveAntigravityGoogleLogin(dir string) (func(bool), error) {
	path := antigravityTokenFile(dir)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return func(bool) {}, nil
	} else if err != nil {
		return nil, err
	}
	backup, err := os.CreateTemp(filepath.Dir(path), ".oauth-before-login-")
	if err != nil {
		return nil, err
	}
	_ = backup.Close()
	if err := os.Rename(path, backup.Name()); err != nil {
		_ = os.Remove(backup.Name())
		return nil, err
	}
	return func(success bool) {
		if success {
			_ = os.Remove(backup.Name())
		} else {
			_ = os.Rename(backup.Name(), path)
		}
	}, nil
}

func antigravityGoogleLoginProgress(out string) *LoginResultRequest {
	if !strings.Contains(strings.ToLower(stripANSI(out)), "authorization code") {
		return nil
	}
	urls := antigravityGoogleURLRe.FindAllStringSubmatch(out, -1)
	if len(urls) == 0 {
		return nil
	}
	return &LoginResultRequest{Status: loginAwaitingCode, URL: urls[len(urls)-1][1]}
}

// The PTY writer has no logging path. Once a code is about to be written, even String returns
// nothing. A bounded private tail recognizes fixed UI markers; it is never reported or logged.
type antigravityGoogleLoginOutput struct {
	mu        sync.Mutex
	before    bytes.Buffer
	protected bool
	tail      string
	url       string
	submitted bool
	rejected  bool
	ready     bool
	answered  bool // the terminal identity query (antigravityGoogleDA2Query)
	actions   []string
	seen      map[string]bool
}

func (o *antigravityGoogleLoginOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.protected {
		o.before.Write(p)
		if o.before.Len() > 128*1024 {
			o.before.Next(o.before.Len() - 128*1024)
		}
	}
	o.tail += string(p)
	if !o.answered && strings.Contains(o.tail, antigravityGoogleDA2Query) {
		o.answered = true
		o.actions = append(o.actions, antigravityGoogleDA2Reply)
	}
	text := stripANSI(o.tail)
	if o.protected && strings.Contains(text, "? for shortcuts") {
		o.ready = true
	}
	if o.protected && strings.Contains(text, antigravityGoogleInvalidCodeMarker) {
		o.rejected = true
		o.submitted = false
		o.tail = ""
	}
	// First-run pages can precede OAuth or appear just after it, depending on saved settings.
	if o.seen == nil {
		o.seen = map[string]bool{}
	}
	termsKeys := "\t\t\r"
	if strings.Contains(text, "[x]") {
		termsKeys = "\r" + termsKeys
	}
	for _, page := range []struct{ marker, ready, keys string }{
		{"Choose your color scheme", "[Next]", "\r"},
		{"Terms of Service & Data Use", "[Done]", termsKeys},
		{"Do you trust the contents of this project?", "Yes, I trust this folder", "\r"},
		{"Select login method:", "1. Google OAuth", "\r"},
	} {
		if strings.Contains(text, page.marker) && strings.Contains(text, page.ready) && !o.seen[page.marker] {
			o.seen[page.marker] = true
			o.actions = append(o.actions, page.keys)
		}
	}
	if len(o.tail) > 8192 {
		o.tail = o.tail[len(o.tail)-8192:]
	}
	return len(p), nil
}

func (o *antigravityGoogleLoginOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.protected {
		return ""
	}
	return o.before.String()
}

func (o *antigravityGoogleLoginOutput) protect() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.url == "" || o.submitted {
		return false
	}
	o.protected, o.submitted = true, true
	o.before.Reset()
	o.tail = ""
	o.rejected = false
	o.ready = false
	return true
}

func (r *loginRelay) submitAntigravityGoogleCode(run *loginRun, code string, report func(LoginResultRequest)) {
	if !run.google.protect() {
		return // duplicate delivery, or the OAuth prompt is not ready yet
	}
	if _, err := io.WriteString(run.stdin, strings.TrimSpace(code)+"\r"); err != nil {
		report(LoginResultRequest{Status: loginFailed, Message: "could not hand the code to agy — start the sign-in again"})
	}
}

func (r *loginRelay) pumpAntigravityGoogle(run *loginRun, cmd *exec.Cmd, report func(LoginResultRequest)) {
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	exited := false
	defer func() {
		run.cancel()
		_ = cmd.Cancel()
		_ = run.stdin.Close()
		if !exited {
			<-waited
		}
	}()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		o := run.google
		o.mu.Lock()
		actions := o.actions
		o.actions = nil
		rejected, submitted, ready, url := o.rejected, o.submitted, o.ready, o.url
		o.rejected = false
		o.mu.Unlock()
		for _, keys := range actions {
			_, _ = io.WriteString(run.stdin, keys)
		}
		if url == "" {
			if progress := antigravityGoogleLoginProgress(o.String()); progress != nil {
				o.mu.Lock()
				o.url = progress.URL
				o.mu.Unlock()
				report(*progress)
			}
		}
		if rejected {
			report(LoginResultRequest{Status: loginAwaitingCode, URL: url,
				Message: "That code wasn't accepted — make sure you copied all of it, then try again."})
		}
		if run.ctx.Err() != nil {
			message := "Google sign-in cancelled"
			if run.ctx.Err() == context.DeadlineExceeded {
				message = "Google sign-in timed out — start it again"
			}
			report(LoginResultRequest{Status: loginFailed, Message: message})
			return
		}
		if submitted && ready {
			if stat, err := os.Stat(antigravityTokenFile(run.googleDir)); err == nil && stat.Mode().IsRegular() {
				problem, ok := verifyAntigravityGoogleLogin(run)
				if ok {
					run.signedIn = true
					report(LoginResultRequest{Status: loginDone})
					return
				}
				// A saved token with a failing independent probe is not a completed login.
				message := "Google sign-in could not be verified by /usage — start it again"
				if problem != "" {
					message = "Google sign-in could not be verified — Antigravity answered: " + problem
				}
				report(LoginResultRequest{Status: loginFailed, Message: message})
				return
			}
		}
		if exited {
			report(LoginResultRequest{Status: loginFailed, Message: "Google sign-in did not complete"})
			return
		}
		select {
		case <-waited:
			exited = true
			// agy's exit can be seen before its last output has come through the PTY. Decide on all
			// of it, but don't wait long for a child of agy that still holds the terminal open.
			select {
			case <-run.googleCopied:
			case <-run.ctx.Done():
			case <-time.After(2 * time.Second):
			}
		case <-run.ctx.Done():
		case <-tick.C:
		}
	}
}

// How long a fresh sign-in has to pass /usage, and how long one /usage may take. A single short probe
// made a valid sign-in fail: agy's first start after OAuth, on a busy machine or a slow network, can
// outlast it, and an unclear answer is not a refusal.
var (
	antigravityGoogleVerifyWindow = 60 * time.Second
	antigravityGoogleProbeTimeout = 30 * time.Second
)

// verifyAntigravityGoogleLogin asks /usage until it answers signed in, the window closes or the
// attempt ends. Each answer is logged (never the token) so a failure can be told apart afterwards;
// problem is agy's last error, for the owner.
func verifyAntigravityGoogleLogin(run *loginRun) (problem string, ok bool) {
	deadline := time.Now().Add(antigravityGoogleVerifyWindow)
	env := envWithValue(os.Environ(), antigravityAccountDirVar, run.googleDir)
	for try := 1; ; try++ {
		ctx, cancel := context.WithTimeout(run.ctx, antigravityGoogleProbeTimeout)
		started := time.Now()
		probe := probeAntigravityGoogle(ctx, run.binPath, env)
		cancel()
		if run.ctx.Err() != nil {
			return "", false
		}
		if probe.auth == authYes {
			return "", true
		}
		if probe.problem != "" {
			problem = probe.problem
		}
		logln("login: Antigravity /usage after sign-in answered " + authWord(probe.auth) + " (try " +
			strconv.Itoa(try) + ", " + time.Since(started).Round(100*time.Millisecond).String() + "): " + probe.problem)
		if time.Now().Add(2 * time.Second).After(deadline) {
			return problem, false
		}
		select {
		case <-run.ctx.Done():
			return "", false
		case <-time.After(2 * time.Second):
		}
	}
}
