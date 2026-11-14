package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
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

// tuiTurnAnswer is what POST /sessions/:id/turns answers: the turn it made and where the server put
// it — "steer" for a message written into the running turn, "queued" or "accepted" otherwise.
type tuiTurnAnswer struct {
	TurnID    string `json:"turnId"`
	Placement string `json:"placement"`
}

// sendTurn files a message, with the attachments already uploaded for it.
func (c *tuiClient) sendTurn(ctx context.Context, id, clientTurnID, content string, attachmentIDs []string) (tuiTurnAnswer, error) {
	body := map[string]any{"clientTurnId": clientTurnID, "content": content}
	if len(attachmentIDs) > 0 {
		body["attachmentIds"] = attachmentIDs
	}
	var answer tuiTurnAnswer
	data, err := c.do(ctx, http.MethodPost, tuiSessionPath(id, "/turns"), body)
	if err != nil {
		return answer, err
	}
	_ = json.Unmarshal(data, &answer)
	return answer, nil
}

// upload sends one file to POST /attachments?sessionId=, as the apps do (web api.ts uploadAttachment):
// multipart, one field named "file", typed by its content so an image reaches the engine as one.
// sessionID empty uploads it unscoped, for a session about to be created.
func (c *tuiClient) upload(ctx context.Context, sessionID, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = http.DetectContentType(head[:n])
	}
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	part, err := form.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": filepath.Base(path)})},
		"Content-Type":        {contentType},
	})
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, f); err != nil {
		return "", err
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	target := c.server + "/api/attachments"
	if sessionID != "" {
		target += "?sessionId=" + url.QueryEscape(sessionID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "orbit-cli/"+version)
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("POST /attachments: %d %s", res.StatusCode, answerMessage(data))
	}
	var answer struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &answer) != nil || answer.ID == "" {
		return "", fmt.Errorf("POST /attachments answered no id")
	}
	return answer.ID, nil
}

// runners is GET /runners and providers GET /providers: what the engine picker offers.
func (c *tuiClient) runners(ctx context.Context) ([]byte, error) {
	return c.do(ctx, http.MethodGet, "/runners", nil)
}

func (c *tuiClient) providers(ctx context.Context) ([]byte, error) {
	return c.do(ctx, http.MethodGet, "/providers", nil)
}

// createSession is POST /sessions; it answers the new session's id.
func (c *tuiClient) createSession(ctx context.Context, body map[string]any) (string, error) {
	data, err := c.do(ctx, http.MethodPost, "/sessions", body)
	if err != nil {
		return "", err
	}
	var answer struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &answer) != nil || answer.ID == "" {
		return "", fmt.Errorf("POST /sessions answered no id")
	}
	return answer.ID, nil
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
