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
)

// The runner's half of browser_open (browser_tools.go; board docs/mocks/runner-browser/03-agent-tools.html ②): a
// session of the account asked the server to open the Orbit Cloud browser (POST /runner/browser/open), and this
// runner's next heartbeat hands it over as HeartbeatResponse.OpenBrowser.
//
//   - The browser is started as the owner's Open browser starts it (browserSupervisor.Open): without taking the lease.
//   - With a URL the page is opened in the tab shown, through Chrome's DevTools at browserDevToolsHost:
//     browserDevToolsPort, as the paste is inserted (browser_paste.go). Not while another session holds the lease:
//     that session is driving the browser, and its page is not taken from it. The asking session's own lease is fine.
//   - Nothing here logs the URL or anything of the page.

// browserOpenCapabilityV1 declares that this runner honours HeartbeatResponse.OpenBrowser: @orbit/shared's
// BROWSER_OPEN_V1. Declared beside browser-clear/v1, by the runners that have a browser.
const browserOpenCapabilityV1 = "browser-open/v1"

// browserOpenNavigateWait bounds opening one page, from waiting for a Chrome just started to its answer.
const browserOpenNavigateWait = 30 * time.Second

// BrowserOpenCommand mirrors @orbit/shared RunnerHeartbeatResponse.openBrowser.
type BrowserOpenCommand struct {
	SessionID string `json:"sessionId"`
	URL       string `json:"url,omitempty"`
}

// browserNavigate opens url in the Chrome whose DevTools listen at endpoint. A var so a test can stand in for Chrome.
var browserNavigate = navigateBrowserPage

// browserDevToolsReady waits for a Chrome just started to answer on DevTools. A var for the same reason.
var browserDevToolsReady = waitBrowserDevTools

// handleBrowserOpen carries out one OpenBrowser: start the browser, then open the page asked for, if any and if no
// other session holds the browser. What it did is answered by the next heartbeat's browser report (running); a page
// that could not be opened is logged without its address.
func handleBrowserOpen(ctx context.Context, b *browserSupervisor, cmd BrowserOpenCommand) error {
	if err := b.Open(); err != nil {
		logln("browser_open: the browser could not be started:", err)
		return err
	}
	if strings.TrimSpace(cmd.URL) == "" {
		logln("browser_open: browser started for a session")
		return nil
	}
	if holder := b.Holder(); holder != "" && holder != publicID(cmd.SessionID) {
		err := fmt.Errorf("the browser is in use by session %s; the page was not opened", holder)
		logln("browser_open:", err)
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, browserOpenNavigateWait)
	defer cancel()
	endpoint := b.DevToolsEndpoint()
	browserDevToolsReady(endpoint)
	if err := browserNavigate(ctx, endpoint, cmd.URL); err != nil {
		logln("browser_open: the page could not be opened:", err)
		return err
	}
	logln("browser_open: browser started and a page opened for a session")
	return nil
}

// navigateBrowserPage opens target in the tab Chrome shows (the first page target), or in a new tab when it has none.
// The errors never quote target.
func navigateBrowserPage(ctx context.Context, endpoint, target string) error {
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("the page is not an http or https address")
	}
	targets, err := browserTargets(ctx, endpoint)
	if err != nil {
		return err
	}
	for _, t := range targets {
		if t.Type != "page" || t.WebSocketDebuggerURL == "" || strings.HasPrefix(t.URL, "devtools://") {
			continue
		}
		return withDevToolsPage(ctx, t.WebSocketDebuggerURL, func(call devToolsCall) error {
			_ = call("Page.bringToFront", map[string]any{}, nil)
			var res struct {
				ErrorText string `json:"errorText"`
			}
			if err := call("Page.navigate", map[string]any{"url": parsed.String()}, &res); err != nil {
				return err
			}
			if res.ErrorText != "" {
				return fmt.Errorf("the browser could not load the page: %s", res.ErrorText)
			}
			return nil
		})
	}
	// No tab open: open one on the page.
	return openBrowserTab(ctx, endpoint, parsed.String())
}

// openBrowserTab opens target in a new tab of the Chrome whose DevTools listen at endpoint, and brings that tab to the
// front, so the viewer shows it. Chrome's /json/new (PUT, as current Chrome requires) and /json/activate. The errors
// never quote target.
func openBrowserTab(ctx context.Context, endpoint, target string) error {
	_, err := openBrowserTabID(ctx, endpoint, target)
	return err
}

// openBrowserTabID is openBrowserTab answering the new tab's target id ("" when Chrome named none), for a caller that
// closes the tab again (login_runner_browser.go).
func openBrowserTabID(ctx context.Context, endpoint, target string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint+"/json/new?"+url.QueryEscape(target), nil)
	if err != nil {
		return "", errors.New("the page is not an address the browser can open")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", errors.New("The browser's DevTools do not answer")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("The browser's DevTools answered %d to a new tab", resp.StatusCode)
	}
	var tab struct {
		ID string `json:"id"`
	}
	if json.NewDecoder(resp.Body).Decode(&tab) == nil && tab.ID != "" {
		if activate, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/json/activate/"+url.PathEscape(tab.ID), nil); err == nil {
			if r, err := http.DefaultClient.Do(activate); err == nil {
				r.Body.Close()
			}
		}
	}
	return tab.ID, nil
}
