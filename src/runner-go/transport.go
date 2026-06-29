package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Transport is an outbound-only HTTP client to the control plane.
type Transport struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewTransport(baseURL, token string) *Transport {
	return &Transport{baseURL: baseURL, token: token, client: &http.Client{}}
}

func (t *Transport) do(ctx context.Context, method, path string, body, out interface{}, timeout time.Duration) error {
	return t.doHeaders(ctx, method, path, body, out, timeout, nil)
}

func (t *Transport) doHeaders(ctx context.Context, method, path string, body, out interface{}, timeout time.Duration, headers map[string]string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(cctx, method, t.baseURL+"/api"+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if t.token != "" {
		req.Header.Set("authorization", "Bearer "+t.token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s -> %d %s", method, path, resp.StatusCode, string(data))
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (t *Transport) deviceStart(b DeviceStartRequest) (*DeviceStartResponse, error) {
	var r DeviceStartResponse
	if err := t.do(nil, "POST", "/runner/device/start", b, &r, 35*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) devicePoll(deviceCode string) (*DevicePollResponse, error) {
	var r DevicePollResponse
	body := map[string]string{"deviceCode": deviceCode}
	if err := t.do(nil, "POST", "/runner/device/poll", body, &r, 15*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) register(b RegisterRequest) (*RegisterResponse, error) {
	var r RegisterResponse
	if err := t.do(nil, "POST", "/runner/register", b, &r, 35*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) deregister() error {
	return t.do(nil, "POST", "/runner/deregister", nil, nil, 15*time.Second)
}

func (t *Transport) heartbeat(b HeartbeatRequest) (*HeartbeatResponse, error) {
	var r HeartbeatResponse
	if err := t.do(nil, "POST", "/runner/heartbeat", b, &r, 15*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) me() (*MeResponse, error) {
	var r MeResponse
	if err := t.do(nil, "GET", "/runner/me", nil, &r, 10*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

// claimSession long-polls; returns nil when the server holds then yields nothing.
func (t *Transport) claimSession(ctx context.Context) (*ClaimedSession, error) {
	var r ClaimedSession
	if err := t.do(ctx, "GET", "/runner/sessions/claim", nil, &r, 35*time.Second); err != nil {
		return nil, err
	}
	if r.SessionID == "" {
		return nil, nil
	}
	return &r, nil
}

// reclaim lists this runner's still-live sessions so a restarted runner can
// re-attach and --resume them (instead of orphaning them, which would leak their
// AWAITING_INPUT concurrency slots forever).
func (t *Transport) reclaim() (*ReclaimResponse, error) {
	var r ReclaimResponse
	if err := t.do(nil, "GET", "/runner/sessions/reclaim", nil, &r, 15*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) postEvents(sessionID string, batch RunEventBatch) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/events", batch, nil, 35*time.Second)
}

func (t *Transport) complete(sessionID string, b CompleteRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/complete", b, nil, 35*time.Second)
}

// inbox long-polls for the next user turn of an interactive session; returns nil
// when the server holds then yields nothing (turnId == "").
func (t *Transport) inbox(ctx context.Context, sessionID string) (*RunInboxResponse, error) {
	var r RunInboxResponse
	if err := t.do(ctx, "GET", "/runner/sessions/"+sessionID+"/inbox", nil, &r, 35*time.Second); err != nil {
		return nil, err
	}
	if r.TurnID == "" {
		return nil, nil
	}
	return &r, nil
}

func (t *Transport) turnComplete(sessionID string, b TurnCompleteRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/turn-complete", b, nil, 35*time.Second)
}

// mergeResult reports the outcome of a heartbeat-delivered MergeCommand back to the server.
func (t *Transport) mergeResult(sessionID string, b MergeResultRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/merge-result", b, nil, 15*time.Second)
}

// commitResult reports the outcome of a heartbeat-delivered CommitCommand back to the server.
func (t *Transport) commitResult(sessionID string, b CommitResultRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/commit-result", b, nil, 15*time.Second)
}

// diffResult pushes a freshly recomputed live worktree diff back to the server in response to
// an inbox 'diff' refresh request (the web opened a file whose stored patch lagged).
func (t *Transport) diffResult(sessionID string, b DiffResultRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/diff", b, nil, 35*time.Second)
}

// fetchAttachment GETs one image's raw bytes (runner-scoped, by session+attachment id),
// for the inbox poller to base64-encode into a claude `image` content block. Returns the
// raw body — not JSON — so it bypasses `do`.
func (t *Transport) fetchAttachment(ctx context.Context, sessionID, attID string) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	url := t.baseURL + "/api/runner/sessions/" + sessionID + "/attachments/" + attID
	req, err := http.NewRequestWithContext(cctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	if t.token != "" {
		req.Header.Set("authorization", "Bearer "+t.token)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GET attachment %s -> %d %s", attID, resp.StatusCode, string(data))
	}
	return data, nil
}

// createApproval registers a pending tool-permission request (from the orbit MCP
// permission-prompt tool) and returns its id. Idempotent server-side on toolUseId.
func (t *Transport) createApproval(sessionID string, body interface{}) (string, error) {
	var r struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := t.do(nil, "POST", "/runner/sessions/"+sessionID+"/approvals", body, &r, 20*time.Second); err != nil {
		return "", err
	}
	return r.ID, nil
}

// pollApproval long-polls one approval; a "PENDING" status means the server's window
// elapsed undecided and the caller should re-poll.
func (t *Transport) pollApproval(ctx context.Context, sessionID, approvalID string) (*ApprovalDecisionResponse, error) {
	var r ApprovalDecisionResponse
	if err := t.do(ctx, "GET", "/runner/sessions/"+sessionID+"/approvals/"+approvalID, nil, &r, 35*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

// ── Task/TaskList ops for the `orbit mcp` server ───────────────────────────
// These hit the runner-token-authenticated endpoints under /runner; the server
// scopes everything to the runner's owner. Creating work passes X-Orbit-Agent-Id
// so the task/comment is attributed to the acting agent. Each returns the raw
// JSON response so the MCP layer can hand it back verbatim.

const taskOpTimeout = 20 * time.Second

func agentHeader(agentID string) map[string]string {
	if agentID == "" {
		return nil
	}
	return map[string]string{"X-Orbit-Agent-Id": agentID}
}

// taskCreateHeaders attributes a created task to the acting agent and records the
// session it was created from, so the task detail page can link back to that run.
func taskCreateHeaders(agentID, sessionID string) map[string]string {
	h := agentHeader(agentID)
	if sessionID != "" {
		if h == nil {
			h = map[string]string{}
		}
		h["X-Orbit-Session-Id"] = sessionID
	}
	return h
}

type SessionMetaResponse struct {
	Provider         string  `json:"provider,omitempty"`
	SessionUUID      string  `json:"sessionUuid"`
	RuntimeSessionID string  `json:"runtimeSessionId,omitempty"`
	WorkDir          *string `json:"workDir"`
	Title            string  `json:"title"`
}

func (t *Transport) sessionMeta(sessionID string) (*SessionMetaResponse, error) {
	var out SessionMetaResponse
	if err := t.do(nil, "GET", "/runner/sessions/"+sessionID+"/meta", nil, &out, 10*time.Second); err != nil {
		return nil, err
	}
	return &out, nil
}

func (t *Transport) listTasks() (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/tasks", nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) getTask(id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/tasks/"+id, nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) createTask(agentID, sessionID string, body interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks", body, &out, taskOpTimeout, taskCreateHeaders(agentID, sessionID))
	return out, err
}

func (t *Transport) updateTask(id string, body interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, "PATCH", "/runner/tasks/"+id, body, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) commentTask(id, agentID, bodyText string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks/"+id+"/comments",
		map[string]string{"body": bodyText}, &out, taskOpTimeout, agentHeader(agentID))
	return out, err
}

func (t *Transport) listTaskLists() (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/task-lists", nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) createTaskList(title string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/task-lists", map[string]string{"title": title}, &out, taskOpTimeout)
	return out, err
}
