package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Only OSC 8 targets are authoritative: the visible URL wraps at terminal columns.
var antigravityGoogleURLRe = regexp.MustCompile(`\x1b\]8;[^;\x07\x1b]*;(https://accounts\.google\.com/o/oauth2/auth\?[^\x07\x1b\s]+)(?:\x07|\x1b\\)`)

// Observed with a deliberately malformed code on official agy 1.2.16, Linux.
const antigravityGoogleInvalidCodeMarker = `oauth2: "invalid_grant" "Malformed auth code."`

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
				ctx, cancel := context.WithTimeout(run.ctx, 10*time.Second)
				probe := probeAntigravityGoogle(ctx, run.binPath, envWithValue(os.Environ(), antigravityAccountDirVar, run.googleDir))
				cancel()
				if probe.auth == authYes && run.ctx.Err() == nil {
					run.signedIn = true
					report(LoginResultRequest{Status: loginDone})
					return
				}
				// A saved token with a failing independent probe is not a completed login.
				report(LoginResultRequest{Status: loginFailed, Message: "Google sign-in could not be verified by /usage — start it again"})
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
		case <-run.ctx.Done():
		case <-tick.C:
		}
	}
}
