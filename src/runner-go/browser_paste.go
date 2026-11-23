package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// Paste into the managed runner browser (docs/runner-browser-design.md §5; owner's choice, 2026-11-19): the text the
// owner pastes in a viewer that is in control arrives as a StreamPaste on its stream (link_streams.go), and is
// inserted with Chrome DevTools' Input.insertText into the page that has focus, as if typed. Not through the VNC
// clipboard: RFB's cut text is Latin-1, which would garble CJK text and emoji.
//
// Chrome's own UI (the address bar, the find bar) is not a page, so DevTools cannot reach it: when a page is shown but
// none has the window's focus, the focus is there, and the text goes the way a person's paste does: onto the
// display's X clipboard (xclip, which speaks UTF-8), then Ctrl+V (xdotool). The clipboard is emptied right after.
//
// Inserting neither takes nor waits for the session lease (P3 = B): the owner's input never waits for the agent. The
// text is often a password, so it is never logged, and the errors here never quote it.

const (
	// browserPasteMaxBytes bounds a paste, as the apiserver and the gateway do.
	browserPasteMaxBytes = 64 << 10
	// browserPasteWait bounds one paste, from reading Chrome's targets to its answer.
	browserPasteWait = 10 * time.Second
	// browserUIPasteHold is how long the X clipboard holds the text after Ctrl+V, for Chrome to read it.
	browserUIPasteHold = time.Second
)

// errBrowserPasteNoFocus: no page of the browser has focus or is shown.
var errBrowserPasteNoFocus = errors.New("No page in the browser is open to paste into")

// errBrowserPasteNoField: the page shown has no field focused, so the text would go nowhere.
var errBrowserPasteNoField = errors.New("Click a text field in the browser first")

// errBrowserPasteUI: the paste into Chrome's own UI (its address bar) failed.
var errBrowserPasteUI = errors.New("Could not paste into the browser's address bar")

// browserTarget is one entry of Chrome's /json/list.
type browserTarget struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

// browserFocusProbe scores a page: 4 when a field (or a frame, which may hold one) has focus, plus 2 when the page
// has the window's focus, else 1 when it is the tab shown. Background tabs score 0. A best score of 1 means Chrome's
// own UI has the focus.
const browserFocusProbe = `(() => {
  const a = document.activeElement;
  const field = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT|IFRAME|FRAME)$/.test(a.tagName)) || document.designMode === 'on';
  const shown = document.hasFocus() ? 2 : document.visibilityState === 'visible' ? 1 : 0;
  return shown === 0 ? 0 : shown + (field ? 4 : 0);
})()`

// insertBrowserText inserts text into the focused field of the page that has focus in the Chrome whose DevTools
// listen at endpoint (http://host:port).
func insertBrowserText(ctx context.Context, endpoint, text string) error {
	if len(text) > browserPasteMaxBytes {
		return fmt.Errorf("The text is too long to paste (more than %d KB)", browserPasteMaxBytes>>10)
	}
	ctx, cancel := context.WithTimeout(ctx, browserPasteWait)
	defer cancel()
	targets, err := browserTargets(ctx, endpoint)
	if err != nil {
		return err
	}
	best, bestScore := "", 0
	for _, t := range targets {
		if t.Type != "page" || t.WebSocketDebuggerURL == "" || strings.HasPrefix(t.URL, "devtools://") {
			continue
		}
		var score int
		err := withDevToolsPage(ctx, t.WebSocketDebuggerURL, func(call devToolsCall) error {
			var res struct {
				Result struct {
					Value int `json:"value"`
				} `json:"result"`
			}
			if err := call("Runtime.evaluate", map[string]any{"expression": browserFocusProbe, "returnByValue": true}, &res); err != nil {
				return err
			}
			score = res.Result.Value
			return nil
		})
		if err == nil && score > bestScore {
			best, bestScore = t.WebSocketDebuggerURL, score
		}
	}
	switch {
	case best == "":
		return errBrowserPasteNoFocus
	case bestScore == 1:
		return pasteIntoBrowserUI(ctx, text)
	case bestScore < 4:
		return errBrowserPasteNoField
	}
	return withDevToolsPage(ctx, best, func(call devToolsCall) error {
		return call("Input.insertText", map[string]any{"text": text}, nil)
	})
}

// pasteIntoBrowserUI pastes text where the browser's display has its keyboard focus, through the X clipboard. A
// variable so tests need no display.
var pasteIntoBrowserUI = pasteThroughXClipboard

func pasteThroughXClipboard(ctx context.Context, text string) error {
	env := append(os.Environ(), "DISPLAY="+browserDisplay)
	// -quiet keeps xclip in the foreground, serving the selection until it is stopped, and says so on stderr once it
	// owns it. Stopping it gives up the selection, which empties the clipboard: the text is often a password.
	clip := exec.Command("xclip", "-quiet", "-selection", "clipboard", "-t", "UTF8_STRING")
	clip.Env = env
	clip.Stdin = strings.NewReader(text)
	stderr, err := clip.StderrPipe()
	if err != nil {
		return err
	}
	if err := clip.Start(); err != nil {
		return errBrowserPasteUI
	}
	defer func() {
		_ = clip.Process.Kill()
		_ = clip.Wait()
	}()
	owned := make(chan bool, 1)
	go func() {
		buf := make([]byte, 256)
		var seen []byte
		for {
			n, err := stderr.Read(buf)
			seen = append(seen, buf[:n]...)
			if strings.Contains(string(seen), "Waiting for selection") {
				owned <- true
				_, _ = io.Copy(io.Discard, stderr)
				return
			}
			if err != nil {
				owned <- false
				return
			}
		}
	}()
	select {
	case ok := <-owned:
		if !ok {
			return errBrowserPasteUI
		}
	case <-ctx.Done():
		return errBrowserPasteUI
	}
	// xclip says so just before it flushes its claim on the selection; give the claim time to reach the server.
	time.Sleep(50 * time.Millisecond)
	key := exec.CommandContext(ctx, "xdotool", "key", "--clearmodifiers", "ctrl+v")
	key.Env = env
	if err := key.Run(); err != nil {
		return errBrowserPasteUI
	}
	select {
	case <-time.After(browserUIPasteHold):
	case <-ctx.Done():
	}
	return nil
}

// browserTargets reads Chrome's /json/list.
func browserTargets(ctx context.Context, endpoint string) ([]browserTarget, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/json/list", nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, errors.New("The browser's DevTools do not answer")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("The browser's DevTools answered %d", resp.StatusCode)
	}
	var targets []browserTarget
	if err := json.NewDecoder(resp.Body).Decode(&targets); err != nil {
		return nil, errors.New("The browser's DevTools answered something else")
	}
	return targets, nil
}

// devToolsCall sends one DevTools command and decodes its result into out (nil: discard it).
type devToolsCall func(method string, params any, out any) error

// withDevToolsPage connects to one page's DevTools WebSocket for the length of fn.
func withDevToolsPage(ctx context.Context, url string, fn func(devToolsCall) error) error {
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return errors.New("The browser's page does not answer")
	}
	defer c.CloseNow()
	c.SetReadLimit(4 << 20)
	next := 0
	call := func(method string, params any, out any) error {
		next++
		id := next
		msg, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
		if err != nil {
			return err
		}
		if err := c.Write(ctx, websocket.MessageText, msg); err != nil {
			return errors.New("The browser's page does not answer")
		}
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return errors.New("The browser's page does not answer")
			}
			var resp struct {
				ID     int             `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(data, &resp) != nil || resp.ID != id {
				continue // an event, or another command's answer
			}
			if resp.Error != nil {
				return fmt.Errorf("The browser refused %s: %s", method, resp.Error.Message)
			}
			if out != nil {
				return json.Unmarshal(resp.Result, out)
			}
			return nil
		}
	}
	err = fn(call)
	_ = c.Close(websocket.StatusNormalClosure, "")
	return err
}
