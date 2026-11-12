package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// tuiClient is what the Orbit TUI (terminal_tui.go) talks to the server with: the same user routes
// the app uses, as the TERMINAL credential (docs/terminal-session-design.md, D2′ = A).
type tuiClient struct {
	server string // normalized base URL, no trailing slash
	token  string
	http   *http.Client // requests that answer at once
	stream *http.Client // the SSE stream, which stays open
}

func newTUIClient(server, token string) *tuiClient {
	return &tuiClient{
		server: strings.TrimRight(server, "/"),
		token:  token,
		http:   &http.Client{Timeout: 30 * time.Second},
		stream: &http.Client{},
	}
}

// tuiEvent is one event of a session's transcript as GET /sessions/:id/events/page and the SSE
// GET /sessions/:id/events carry it.
type tuiEvent struct {
	Seq     int64           `json:"seq"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
	TurnID  string          `json:"turnId,omitempty"`
	Ts      string          `json:"ts,omitempty"`
}

func (c *tuiClient) do(ctx context.Context, method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.server+"/api"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "orbit-cli/"+version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return data, fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, answerMessage(data))
	}
	return data, nil
}

func tuiSessionPath(id string, rest string) string {
	return "/sessions/" + url.PathEscape(id) + rest
}

// session is GET /sessions/:id, decoded by the caller.
func (c *tuiClient) session(ctx context.Context, id string) ([]byte, error) {
	return c.do(ctx, http.MethodGet, tuiSessionPath(id, ""), nil)
}

// eventPage is the newest tail events of the session, oldest first.
func (c *tuiClient) eventPage(ctx context.Context, id string, tail int) ([]tuiEvent, error) {
	data, err := c.do(ctx, http.MethodGet, tuiSessionPath(id, fmt.Sprintf("/events/page?tail=%d", tail)), nil)
	if err != nil {
		return nil, err
	}
	var page struct {
		Events []tuiEvent `json:"events"`
	}
	if err := json.Unmarshal(data, &page); err != nil {
		return nil, fmt.Errorf("reading the session's events: %w", err)
	}
	return page.Events, nil
}

// pendingApprovals is GET /sessions/:id/approvals?status=PENDING: the cards raised before this TUI
// opened, which the live stream will not announce again.
func (c *tuiClient) pendingApprovals(ctx context.Context, id string) ([]json.RawMessage, error) {
	data, err := c.do(ctx, http.MethodGet, tuiSessionPath(id, "/approvals?status=PENDING"), nil)
	if err != nil {
		return nil, err
	}
	var list []json.RawMessage
	if err := json.Unmarshal(data, &list); err != nil {
		var wrapped struct {
			Approvals []json.RawMessage `json:"approvals"`
		}
		if json.Unmarshal(data, &wrapped) != nil {
			return nil, fmt.Errorf("reading the session's approvals: %w", err)
		}
		list = wrapped.Approvals
	}
	return list, nil
}

// sendTurn files a message and answers the turn the server made of it.
func (c *tuiClient) sendTurn(ctx context.Context, id, clientTurnID, content string) (string, error) {
	data, err := c.do(ctx, http.MethodPost, tuiSessionPath(id, "/turns"), map[string]string{"clientTurnId": clientTurnID, "content": content})
	if err != nil {
		return "", err
	}
	var answer struct {
		TurnID string `json:"turnId"`
	}
	_ = json.Unmarshal(data, &answer)
	return answer.TurnID, nil
}

func (c *tuiClient) interrupt(ctx context.Context, id string) error {
	_, err := c.do(ctx, http.MethodPost, tuiSessionPath(id, "/interrupt"), nil)
	return err
}

func (c *tuiClient) decide(ctx context.Context, id, approvalID string, body map[string]any) error {
	_, err := c.do(ctx, http.MethodPost, tuiSessionPath(id, "/approvals/"+url.PathEscape(approvalID)+"/decision"), body)
	return err
}

// follow reads the SSE GET /sessions/:id/events from sinceSeq and hands each event to emit until
// the stream ends or ctx is cancelled. Pings are dropped here.
func (c *tuiClient) follow(ctx context.Context, id string, sinceSeq int64, emit func(tuiEvent)) error {
	path := tuiSessionPath(id, "/events")
	if sinceSeq > 0 {
		path += fmt.Sprintf("?sinceSeq=%d", sinceSeq)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.server+"/api"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", "orbit-cli/"+version)
	res, err := c.stream.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("GET %s: %d %s", path, res.StatusCode, answerMessage(data))
	}
	return readSSE(res.Body, emit)
}

// readSSE splits an SSE body into its data frames and decodes each as a tuiEvent.
func readSSE(body io.Reader, emit func(tuiEvent)) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var data strings.Builder
	flush := func() {
		if data.Len() == 0 {
			return
		}
		var ev tuiEvent
		if json.Unmarshal([]byte(data.String()), &ev) == nil && ev.Type != "" && ev.Type != "ping" {
			emit(ev)
		}
		data.Reset()
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
	return scanner.Err()
}
