package main

import (
	"context"
	"net/url"
	"strings"
	"time"
)

// An engine's sign-in finished in the runner's own browser (docs/runner-browser-engine-sign-in-design.md): the owner
// pressed Use the runner's browser on the sign-in card, and the heartbeat hands this runner a LoginCommand `browser`
// for the attempt that is waiting on its link.
//
//   - The link the attempt published is opened as a new tab of the runner's shared Chrome (Q1 = B), started without the
//     lease as the owner's Open browser starts it, and the browser is reserved for the owner until the attempt ends
//     (browserSupervisor.ReserveForEngineSignIn): no session's browser call is taken meanwhile.
//   - Claude Code's page redirects to its hosted callback with the code in the address. The runner reads Chrome's pages
//     until one is that callback with this attempt's state, and hands `code#state` to the CLI as a pasted code would be
//     (§4, Q2 = A). Antigravity keeps the paste until its callback is confirmed on a live sign-in.
//   - What became of it goes back on the attempt's own waiting report, repeated with Browser set, so the control plane
//     keeps the link and the code it shows. The heartbeat redelivers the command until that report lands; a repeat for
//     an attempt already opened reports again and opens nothing.
//   - The link, the code and the state are never logged.

// loginRunnerBrowserCapabilityV1 declares that this runner honours LoginCommand `browser`: @orbit/shared's
// LOGIN_RUNNER_BROWSER_V1. Declared beside browser-open/v1, by the runners that have a browser.
const loginRunnerBrowserCapabilityV1 = "login-runner-browser/v1"

// LoginResultRequest.Browser values.
const (
	loginBrowserOpened    = "opened"
	loginBrowserFailed    = "failed"
	loginBrowserCodeTaken = "code-taken"
)

// browserOpening is loginRun.browser while the tab is being opened.
const browserOpening = "opening"

// loginBrowserCaptureEvery is how often Chrome's pages are read for the callback.
const loginBrowserCaptureEvery = 500 * time.Millisecond

// loginBrowserTargets reads Chrome's pages. A var so a test can stand in for Chrome.
var loginBrowserTargets = browserTargets

// loginBrowserOpenTab opens a page in a new tab. A var for the same reason.
var loginBrowserOpenTab = openBrowserTab

// loginBrowser is the part of the browser supervisor a sign-in uses.
type loginBrowser interface {
	ReserveForEngineSignIn(attempt string) error
	EndEngineSignIn(attempt string)
	DevToolsEndpoint() string
}

// openInBrowser carries out one LoginCommand `browser`. Runs on its own goroutine: opening the tab waits on Chrome.
func (r *loginRelay) openInBrowser(ctx context.Context, lr LoginCommand, b *browserSupervisor) {
	var browser loginBrowser
	if b != nil {
		browser = b
	}
	r.openInLoginBrowser(ctx, lr, browser)
}

func (r *loginRelay) openInLoginBrowser(ctx context.Context, lr LoginCommand, b loginBrowser) {
	r.mu.Lock()
	run := r.runFor(lr)
	if run == nil || (lr.Attempt != "" && lr.Attempt != run.attempt) || run.published == nil || run.report == nil {
		// No sign-in waiting on a link for this attempt: it ended, or its link has not been reported yet. The
		// control plane learns the first from the attempt's own report, and redelivers for the second.
		r.mu.Unlock()
		return
	}
	published, report, state := *run.published, run.report, run.browser
	if state == "" {
		run.browser = browserOpening
	}
	r.mu.Unlock()
	answer := func(outcome string) {
		res := published
		res.Browser = outcome
		report(res)
	}
	switch state {
	case browserOpening:
		return // the first delivery is opening it
	case loginBrowserOpened:
		answer(loginBrowserOpened) // its report may not have landed
		return
	}
	fail := func(why string) {
		logln("login: the sign-in page could not be opened in the runner's browser:", why)
		r.mu.Lock()
		if run.browser == browserOpening {
			run.browser = ""
		}
		r.mu.Unlock()
		answer(loginBrowserFailed)
	}
	if b == nil {
		fail("this runner has no browser")
		return
	}
	if err := b.ReserveForEngineSignIn(run.attempt); err != nil {
		fail(err.Error())
		return
	}
	go func() {
		<-run.ctx.Done()
		b.EndEngineSignIn(run.attempt)
	}()
	endpoint := b.DevToolsEndpoint()
	openCtx, cancel := context.WithTimeout(ctx, browserOpenNavigateWait)
	defer cancel()
	browserDevToolsReady(endpoint)
	if err := loginBrowserOpenTab(openCtx, endpoint, published.URL); err != nil {
		b.EndEngineSignIn(run.attempt)
		fail(err.Error())
		return
	}
	r.mu.Lock()
	run.browser = loginBrowserOpened
	r.mu.Unlock()
	logln("login: the sign-in page was opened in the runner's browser")
	answer(loginBrowserOpened)
	if callback, state, ok := claudeCodeCallback(lr.Engine, published.URL); ok {
		go r.takeCodeFromBrowser(run, lr, endpoint, callback, state, func() { answer(loginBrowserCodeTaken) })
	}
}

// claudeCodeCallback is where Claude Code's sign-in page sends the browser with the code, and the state it must carry:
// from the authorize URL the attempt published. ok is false for any other engine, and for a URL without both.
func claudeCodeCallback(engine, authorize string) (callback *url.URL, state string, ok bool) {
	if loginFlowFor(engine).engine != providerClaude {
		return nil, "", false
	}
	u, err := url.Parse(authorize)
	if err != nil {
		return nil, "", false
	}
	q := u.Query()
	callback, err = url.Parse(q.Get("redirect_uri"))
	state = q.Get("state")
	if err != nil || callback.Scheme != "https" || callback.Host == "" || state == "" {
		return nil, "", false
	}
	return callback, state, true
}

// callbackCode is the code a page at address carries for this sign-in: address is the callback (scheme, host and path
// equal) and carries this attempt's state. "" for any other address.
func callbackCode(address string, callback *url.URL, state string) string {
	u, err := url.Parse(address)
	if err != nil || u.Scheme != callback.Scheme || !strings.EqualFold(u.Host, callback.Host) || u.Path != callback.Path {
		return ""
	}
	q := u.Query()
	if q.Get("state") != state {
		return ""
	}
	return q.Get("code")
}

// takeCodeFromBrowser reads Chrome's pages until one is the callback for this sign-in, then hands its code to the CLI
// as a paste is handed (submitCode, which also watches for the CLI refusing it). Once per attempt; it stops when the
// attempt ends. A capture that never comes leaves the card's paste field, as before.
func (r *loginRelay) takeCodeFromBrowser(run *loginRun, lr LoginCommand, endpoint string, callback *url.URL, state string, taken func()) {
	tick := time.NewTicker(loginBrowserCaptureEvery)
	defer tick.Stop()
	for {
		select {
		case <-run.ctx.Done():
			return
		case <-tick.C:
		}
		ctx, cancel := context.WithTimeout(run.ctx, 5*time.Second)
		targets, err := loginBrowserTargets(ctx, endpoint)
		cancel()
		if err != nil {
			continue
		}
		for _, t := range targets {
			if t.Type != "page" {
				continue
			}
			if code := callbackCode(t.URL, callback, state); code != "" {
				logln("login: code taken from the runner's browser")
				taken()
				r.submitCode(LoginCommand{Action: "code", Engine: lr.Engine, Account: lr.Account, Attempt: run.attempt, Code: code + "#" + state}, run.report)
				return
			}
		}
	}
}
