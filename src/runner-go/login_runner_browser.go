package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// An engine's sign-in finished in the runner's own browser (docs/runner-browser-engine-sign-in-design.md): the owner
// pressed Use the runner's browser on the sign-in card, and the heartbeat hands this runner a LoginCommand `browser`
// for the attempt that is waiting on its link.
//
//   - The link the attempt published is opened as a new tab of the runner's shared Chrome (Q1 = B), started without the
//     lease as the owner's Open browser starts it, and the browser is reserved for the owner until the attempt ends
//     (browserSupervisor.ReserveForEngineSignIn): no session's browser call is taken meanwhile.
//   - Claude Code's and Antigravity's pages redirect to a hosted callback with the code in the address. The runner reads
//     Chrome's pages until one is that callback with this attempt's state, and hands the CLI what the page shows, as a
//     pasted code would be (§4, Q2 = A): Claude Code's `code#state`, Antigravity's code alone (seen on a live sign-in
//     2026-11-23: https://antigravity.google/oauth-callback, "Paste this code into your application").
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

// loginBrowserOpenTab opens a page in a new tab and answers its target id. A var for the same reason.
var loginBrowserOpenTab = openBrowserTabID

// loginBrowserCloseTab closes the sign-in's tab once it succeeded. A var for the same reason.
var loginBrowserCloseTab = closeSignInTab

// loginBrowser is the part of the browser supervisor a sign-in uses.
type loginBrowser interface {
	ReserveForEngineSignIn(attempt string) error
	EndEngineSignIn(attempt string)
	DevToolsEndpoint() string
	KeepSignInTab(tab string)
	KeepsSignInTab(tab string) bool
	ReleaseSignInTabs(tabs ...string)
}

// loginKeptTabCheckEvery is how often a kept sign-in tab is looked for among Chrome's pages. A var for tests.
var loginKeptTabCheckEvery = 30 * time.Second

// watchKeptSignInTab lets tab go once the owner has closed it. It ends when the browser no longer keeps the tab
// (stopped, Chrome started again, or a later sign-in succeeded). A DevTools that does not answer is asked again later.
func watchKeptSignInTab(b loginBrowser, endpoint, tab string) {
	for b.KeepsSignInTab(tab) {
		time.Sleep(loginKeptTabCheckEvery)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		targets, err := loginBrowserTargets(ctx, endpoint)
		cancel()
		if err != nil {
			continue
		}
		open := false
		for _, t := range targets {
			open = open || t.ID == tab
		}
		if !open {
			b.ReleaseSignInTabs(tab)
			logln("login: the kept sign-in tab was closed; the browser may stop when idle again")
			return
		}
	}
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
	tabID, err := loginBrowserOpenTab(openCtx, endpoint, published.URL)
	if err != nil {
		b.EndEngineSignIn(run.attempt)
		fail(err.Error())
		return
	}
	// The tab goes once the machine is signed in: the page has nothing more to say, and the owner watching the
	// browser is left on what was there before. A sign-in that failed or was cancelled keeps it, for what it said,
	// and keeps the browser from stopping for idleness until the owner closes it (owner, 2026-11-24): a stopped
	// browser starts again with none of its tabs.
	go func() {
		<-run.ctx.Done()
		r.mu.Lock()
		done := run.reportedDone
		r.mu.Unlock()
		if tabID == "" {
			return
		}
		if !done {
			b.KeepSignInTab(tabID)
			watchKeptSignInTab(b, endpoint, tabID)
			return
		}
		// Signed in now: what an earlier sign-in's page said is settled, so its tab no longer holds the browser.
		b.ReleaseSignInTabs()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := loginBrowserCloseTab(ctx, endpoint, tabID); err != nil {
			logln("login: the sign-in tab could not be closed:", err)
			return
		}
		logln("login: the sign-in tab was closed")
	}()
	r.mu.Lock()
	run.browser = loginBrowserOpened
	r.mu.Unlock()
	logln("login: the sign-in page was opened in the runner's browser")
	answer(loginBrowserOpened)
	if callback, state, paste, ok := codeCallback(lr.Engine, published.URL); ok {
		go r.takeCodeFromBrowser(run, lr, endpoint, tabID, callback, state, paste, func() { answer(loginBrowserCodeTaken) })
	}
}

// closeSignInTab closes the tab with target id in the Chrome whose DevTools listen at endpoint, if it is still open.
// Chrome quits when its last tab closes, so a sign-in tab that is the only one is first given a blank tab beside it.
// Nothing else is closed, and nothing of the page is logged.
func closeSignInTab(ctx context.Context, endpoint, id string) error {
	targets, err := loginBrowserTargets(ctx, endpoint)
	if err != nil {
		return err
	}
	found, pages := false, 0
	for _, t := range targets {
		if t.Type != "page" || strings.HasPrefix(t.URL, "devtools://") {
			continue
		}
		pages++
		if t.ID == id {
			found = true
		}
	}
	if !found {
		return nil // the owner closed it already
	}
	if pages == 1 {
		if _, err := loginBrowserOpenTab(ctx, endpoint, "about:blank"); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/json/close/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return errors.New("The browser's DevTools do not answer")
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("The browser's DevTools answered %d to closing a tab", resp.StatusCode)
	}
	return nil
}

// codeCallback is where an engine's sign-in page sends the browser with the code, the state it must carry, both from
// the authorize URL the attempt published, and what of the code the CLI takes, as the page shows it to paste: Claude
// Code's `code#state` (platform.claude.com/oauth/code/callback), Antigravity's code alone (antigravity.google/
// oauth-callback). ok is false for any other engine, and for a URL without an https callback or a state.
func codeCallback(engine, authorize string) (callback *url.URL, state string, paste func(code string) string, ok bool) {
	switch loginFlowFor(engine).engine {
	case providerClaude:
		paste = func(code string) string { return code + "#" + state }
	case providerAntigravity:
		paste = func(code string) string { return code }
	default:
		return nil, "", nil, false
	}
	u, err := url.Parse(authorize)
	if err != nil {
		return nil, "", nil, false
	}
	q := u.Query()
	callback, err = url.Parse(q.Get("redirect_uri"))
	state = q.Get("state")
	if err != nil || callback.Scheme != "https" || callback.Host == "" || state == "" {
		return nil, "", nil, false
	}
	return callback, state, paste, true
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

// loginBrowserWatchTab follows one tab's navigations (watchTabNavigations). A var so a test can stand in for Chrome.
var loginBrowserWatchTab = watchTabNavigations

// takeCodeFromBrowser waits for the callback that carries this sign-in's code, then hands the code to the CLI as a
// paste is handed (submitCode, which also watches for the CLI refusing it). Once per attempt; it stops when the attempt
// ends. A capture that never comes leaves the card's paste field, as before.
//
// Two ways, whichever sees it first:
//   - the sign-in tab's own navigations, as Chrome reports them over DevTools (Page.frameNavigated). Each carries the
//     address it was loaded at, so a callback page that strips the code from its address once it loads (Antigravity's
//     does: antigravity.google/oauth-callback is all its address bar shows) is seen with the code all the same;
//   - every page's current address, read every loginBrowserCaptureEvery: a callback reached in another tab, or a
//     watch that could not be kept.
func (r *loginRelay) takeCodeFromBrowser(run *loginRun, lr LoginCommand, endpoint, tabID string, callback *url.URL, state string, paste func(string) string, taken func()) {
	ctx, stop := context.WithCancel(run.ctx)
	defer stop()
	found := make(chan string, 1)
	offer := func(address string) {
		if code := callbackCode(address, callback, state); code != "" {
			select {
			case found <- code:
			default:
			}
		}
	}
	if tabID != "" {
		go loginBrowserWatchTab(ctx, endpoint, tabID, offer)
	}
	tick := time.NewTicker(loginBrowserCaptureEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case code := <-found:
			logln("login: code taken from the runner's browser")
			taken()
			r.submitCode(LoginCommand{Action: "code", Engine: lr.Engine, Account: lr.Account, Attempt: run.attempt, Code: paste(code)}, run.report)
			return
		case <-tick.C:
		}
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		targets, err := loginBrowserTargets(readCtx, endpoint)
		cancel()
		if err != nil {
			continue
		}
		for _, t := range targets {
			if t.Type == "page" {
				offer(t.URL)
			}
		}
	}
}

// watchTabNavigations hands seen the address of every main-frame navigation of the tab with target id tabID, as Chrome
// reports it (Page.frameNavigated), until ctx ends. A dropped DevTools connection is made again a second later; the
// tab gone ends the watch. Nothing of an address is logged.
func watchTabNavigations(ctx context.Context, endpoint, tabID string, seen func(address string)) {
	for ctx.Err() == nil {
		ws := ""
		if targets, err := loginBrowserTargets(ctx, endpoint); err == nil {
			for _, t := range targets {
				if t.ID == tabID {
					ws = t.WebSocketDebuggerURL
				}
			}
			if ws == "" {
				return // the tab is closed
			}
		}
		if ws != "" {
			followNavigations(ctx, ws, seen)
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
}

// followNavigations is one DevTools connection to a page: Page.enable, then every Page.frameNavigated of its main frame.
func followNavigations(ctx context.Context, ws string, seen func(address string)) {
	c, _, err := websocket.Dial(ctx, ws, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(4 << 20)
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"id":1,"method":"Page.enable","params":{}}`)); err != nil {
		return
	}
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		var ev struct {
			Method string `json:"method"`
			Params struct {
				Frame struct {
					ParentID string `json:"parentId"`
					URL      string `json:"url"`
				} `json:"frame"`
			} `json:"params"`
		}
		if json.Unmarshal(data, &ev) != nil || ev.Method != "Page.frameNavigated" || ev.Params.Frame.ParentID != "" {
			continue
		}
		seen(ev.Params.Frame.URL)
	}
}
