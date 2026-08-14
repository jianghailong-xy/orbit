package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	runnerCapabilitiesHeader         = "X-Orbit-Runner-Capabilities"
	sessionOrchestrationCredentialV1 = "session-orchestration-credential-v1"
	sessionTerminalHandoffV1         = "session-terminal-handoff-v1"
	sessionWorktreeOpsV1             = "session-worktree-ops-v1"
	runnerCapabilitiesV1             = sessionOrchestrationCredentialV1 + "," + sessionTerminalHandoffV1 + "," + sessionWorktreeOpsV1
	orchestrationCredentialMissing   = "ORCHESTRATION_CREDENTIAL_MISSING"
	orchestrationCredentialInvalid   = "ORCHESTRATION_CREDENTIAL_INVALID"
)

type transportHTTPError struct {
	method     string
	path       string
	statusCode int
	body       string
}

func (e *transportHTTPError) Error() string {
	return fmt.Sprintf("%s %s -> %d %s", e.method, e.path, e.statusCode, e.body)
}

// Transport is an outbound-only HTTP client to the control plane.
type Transport struct {
	baseURL    string
	token      string
	client     *http.Client
	leaseOwner string
}

func isTransportHTTPStatus(err error, status int) bool {
	httpErr, ok := err.(*transportHTTPError)
	return ok && httpErr.statusCode == status
}

// Only failures that can plausibly clear without changing the request are retried.
// Retrying authorization/validation failures can wedge startup reclaim forever.
func isRetryableTransportError(err error) bool {
	httpErr, ok := err.(*transportHTTPError)
	if !ok {
		return true // network/timeout failures
	}
	return httpErr.statusCode == http.StatusRequestTimeout ||
		httpErr.statusCode == http.StatusTooManyRequests ||
		httpErr.statusCode >= http.StatusInternalServerError
}

func isLeaseOwnershipError(err error) bool {
	return isTransportHTTPStatus(err, http.StatusConflict) ||
		isTransportHTTPStatus(err, http.StatusForbidden) ||
		isTransportHTTPStatus(err, http.StatusNotFound)
}

// Sent on claim/reclaim from the first release that safely understands OpenCode. The server uses
// this positive capability advertisement instead of trusting a stale heartbeat version during a
// rolling upgrade. Older control planes ignore the header.
const runnerSupportedProviders = "claude,codex,opencode"

func NewTransport(baseURL, token string) *Transport {
	leaseOwner, err := newLeaseGeneration()
	if err != nil {
		panic(fmt.Sprintf("create runner lease owner: %v", err))
	}
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) == 0 {
				return nil
			}
			first := via[0].URL
			if via[0].Header.Get("X-Orbit-Session-Token") != "" &&
				(req.URL.Scheme != first.Scheme || !strings.EqualFold(req.URL.Host, first.Host)) {
				// Go's default redirect policy protects Authorization across hosts, but it
				// copies unknown headers. Refuse the redirect before a session credential
				// in X-Orbit-Session-Token can reach another origin. Calls without that
				// credential retain the transport's historical redirect behavior.
				return fmt.Errorf("refusing cross-origin redirect to %s", req.URL.Redacted())
			}
			return nil
		},
	}
	return &Transport{baseURL: baseURL, token: token, client: client, leaseOwner: leaseOwner}
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
	req.Header.Set(runnerCapabilitiesHeader, runnerCapabilitiesV1)
	req.Header.Set("X-Orbit-Supported-Providers", runnerSupportedProviders)
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
		return &transportHTTPError{method: method, path: path, statusCode: resp.StatusCode, body: string(data)}
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

// reclaim lists every open session assigned to this runner so its lightweight
// supervisor and checkout survive a runner restart. Only entries whose status is
// RUNNING start active; other open states stay cold until a normal claim arrives.
func (t *Transport) reclaim(ctx context.Context) (*ReclaimResponse, error) {
	var r ReclaimResponse
	if err := t.do(ctx, "GET", "/runner/sessions/reclaim", nil, &r, 15*time.Second); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *Transport) postEvents(ctx context.Context, sessionID string, batch RunEventBatch) error {
	batch.LeaseOwner = t.leaseOwner
	return t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/events", batch, nil, 35*time.Second)
}

// finalizeRun finalizes the current run server-side and reports back whether the isolated worktree
// checkout should be kept (resumable end) or removed (the session is Completed/in Trash).
// This runner lifecycle endpoint is intentionally distinct from completeSession below, which is
// the user-facing action that moves a Session to Completed.
// Defaults to keep on any transport error, so an unreachable server never destroys a checkout.
func (t *Transport) finalizeRun(ctx context.Context, sessionID string, b RunFinalizeRequest) (bool, error) {
	var r RunFinalizeResponse
	b.LeaseOwner = t.leaseOwner
	path := "/runner/sessions/" + sessionID + "/finalize"
	if err := t.do(ctx, "POST", path, b, &r, 35*time.Second); err != nil {
		// A newly upgraded runner can overlap an older control-plane replica during a
		// rolling deploy. Only a missing canonical route falls back; every other error
		// remains authoritative and keeps the checkout for safety.
		if !strings.Contains(err.Error(), "POST "+path+" -> 404 ") {
			return true, err
		}
		r = RunFinalizeResponse{}
		legacyPath := "/runner/sessions/" + sessionID + "/complete"
		if legacyErr := t.do(ctx, "POST", legacyPath, b, &r, 35*time.Second); legacyErr != nil {
			return true, legacyErr
		}
	}
	return r.KeepCheckout, nil
}

// worktreesRemovable asks the control plane which of the given session ids (leftover worktree
// checkouts) may be garbage-collected. Ids absent from the reply belong to still-resumable
// sessions and must be kept.
func (t *Transport) worktreesRemovable(ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var r WorktreesRemovableResponse
	if err := t.do(nil, "POST", "/runner/sessions/worktrees-removable",
		map[string][]string{"ids": ids}, &r, 15*time.Second); err != nil {
		return nil, err
	}
	return r.Removable, nil
}

// inbox long-polls for the next user turn of an interactive session; returns nil
// when the server holds then yields nothing (turnId == "").
func (t *Transport) inbox(ctx context.Context, sessionID, leaseGeneration string) (*RunInboxResponse, error) {
	var r RunInboxResponse
	path := "/runner/sessions/" + sessionID + "/inbox"
	if leaseGeneration != "" {
		path += "?leaseGeneration=" + url.QueryEscape(leaseGeneration)
	}
	if err := t.do(ctx, "GET", path, nil, &r, 35*time.Second); err != nil {
		return nil, err
	}
	if r.TurnID == "" {
		return nil, nil
	}
	return &r, nil
}

const (
	idempotentRetryInitialDelay = 100 * time.Millisecond
	idempotentRetryMaxDelay     = 2 * time.Second
)

// retryIdempotent keeps retrying an idempotent control-plane operation until it
// succeeds or its owner goes away. A capped backoff avoids both losing a
// committed response and hammering an unavailable server.
func retryIdempotent(ctx context.Context, op func(context.Context) error) error {
	return retryIdempotentWhile(ctx, op, func(error) bool { return true })
}

func retryIdempotentWhile(
	ctx context.Context,
	op func(context.Context) error,
	shouldRetry func(error) bool,
) error {
	if ctx == nil {
		ctx = context.Background()
	}
	delay := idempotentRetryInitialDelay
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := op(ctx); err == nil {
			return nil
		} else if !shouldRetry(err) {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}

		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return ctx.Err()
		}
		if delay < idempotentRetryMaxDelay {
			delay *= 2
			if delay > idempotentRetryMaxDelay {
				delay = idempotentRetryMaxDelay
			}
		}
	}
}

// takeoverTurnLeases revokes the process identity observed in a claim/reclaim snapshot.
// expectedLeaseOwner is a CAS predecessor; empty means the session has never had a modern owner.
func (t *Transport) takeoverTurnLeases(ctx context.Context, sessionID, expectedLeaseOwner string) (string, error) {
	body := map[string]interface{}{
		"leaseOwner":         t.leaseOwner,
		"expectedLeaseOwner": nil,
	}
	if expectedLeaseOwner != "" {
		body["expectedLeaseOwner"] = expectedLeaseOwner
	}
	var response struct {
		Status string `json:"status"`
	}
	err := t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/takeover-leases", body, &response, 15*time.Second)
	return response.Status, err
}

func retryTakeoverTurnLeases(ctx context.Context, takeover func(context.Context) error) error {
	return retryIdempotentWhile(ctx, takeover, isRetryableTransportError)
}

// takeoverClaimedSession always confirms even a matching snapshot owner with the server.
// A claim/reclaim response can be stale by the time this process handles it, so a local
// equality check cannot substitute for the Session row lock in takeover-leases.
func takeoverClaimedSession(ctx context.Context, t *Transport, job *ClaimedSession) (string, error) {
	var status string
	err := retryTakeoverTurnLeases(ctx, func(attemptCtx context.Context) error {
		var err error
		status, err = t.takeoverTurnLeases(attemptCtx, job.SessionID, job.LeaseOwner)
		return err
	})
	if err == nil {
		job.LeaseOwner = t.leaseOwner
	}
	return status, err
}

func (t *Transport) turnComplete(ctx context.Context, sessionID string, b TurnCompleteRequest) (string, error) {
	var r TurnCompleteResponse
	b.LeaseOwner = t.leaseOwner
	err := retryIdempotentWhile(ctx, func(attemptCtx context.Context) error {
		r = TurnCompleteResponse{}
		return t.do(attemptCtx, "POST", "/runner/sessions/"+sessionID+"/turn-complete", b, &r, 35*time.Second)
	}, isRetryableTransportError)
	if err != nil {
		return "", err
	}
	status := r.Status
	if status == "" {
		status = r.SessionStatus
	}
	if status == "" {
		// Backward compatibility: before active-turn permits the server always
		// parked a successful ack and returned only {ok:true}.
		status = stAwaitingInput
	}
	return status, nil
}

// releaseTurnLeases expires any inbox leases held by an engine that was
// silently recycled. The next cold process may then pull the turn immediately
// instead of waiting for the normal lease deadline.
func (t *Transport) releaseTurnLeases(ctx context.Context, sessionID, leaseGeneration string) error {
	body := map[string]string{"leaseOwner": t.leaseOwner}
	if leaseGeneration != "" {
		body["leaseGeneration"] = leaseGeneration
	}
	return t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/release-leases", body, nil, 15*time.Second)
}

// activateTurnLeases makes a freshly reserved process generation the only inbox consumer.
// The server accepts an idempotent retry for the same generation and rejects a different
// generation until its predecessor has been released.
func (t *Transport) activateTurnLeases(ctx context.Context, sessionID, leaseGeneration string) error {
	body := map[string]string{"leaseGeneration": leaseGeneration, "leaseOwner": t.leaseOwner}
	return t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/activate-leases", body, nil, 15*time.Second)
}

// retryReleaseTurnLeases is kept separate from process spawning so the ordering
// guarantee (reset succeeds before a replacement engine exists) is easy to test.
func retryReleaseTurnLeases(ctx context.Context, release func(context.Context) error) error {
	return retryIdempotentWhile(ctx, release, isRetryableTransportError)
}

func retryActivateTurnLeases(ctx context.Context, activate func(context.Context) error) error {
	return retryIdempotentWhile(ctx, activate, isRetryableTransportError)
}

// mergeResult reports the outcome of a heartbeat-delivered MergeCommand back to the server.
func (t *Transport) mergeResult(sessionID string, b MergeResultRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/merge-result", b, nil, 15*time.Second)
}

// loginResult reports one step of the browser-less sign-in relay: the URL to approve, then
// whether this machine ended up signed in.
func (t *Transport) loginResult(b LoginResultRequest) error {
	return t.do(nil, "POST", "/runner/login-result", b, nil, 15*time.Second)
}

// installResult reports one step of a browser-requested engine install: the command being run,
// then whether it worked.
func (t *Transport) installResult(b InstallResultRequest) error {
	return t.do(nil, "POST", "/runner/install-result", b, nil, 15*time.Second)
}

// repoCleanupResult reports whether a heartbeat-delivered checkout repair worked, and where the
// content it was holding was saved.
func (t *Transport) repoCleanupResult(b RepoCleanupResultRequest) error {
	return t.do(nil, "POST", "/runner/repo-cleanup-result", b, nil, 15*time.Second)
}

// commitResult reports the outcome of a heartbeat-delivered CommitCommand back to the server.
func (t *Transport) commitResult(sessionID string, b CommitResultRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/commit-result", b, nil, 15*time.Second)
}

func (t *Transport) artifactResult(sessionID string, b ArtifactResultRequest) error {
	return t.do(nil, "POST", "/runner/sessions/"+sessionID+"/artifacts/result", b, nil, 15*time.Second)
}

// diffResult pushes a freshly recomputed live worktree diff back to the server in response to
// an inbox 'diff' refresh request (the web opened a file whose stored patch lagged).
func (t *Transport) diffResult(sessionID string, b DiffResultRequest) error {
	return t.diffResultContext(nil, sessionID, b)
}

func (t *Transport) diffResultContext(ctx context.Context, sessionID string, b DiffResultRequest) error {
	return t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/diff", b, nil, 35*time.Second)
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

func (t *Transport) uploadSessionAttachment(ctx context.Context, sessionID, path, mimeType string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escapeMultipartFilename(filepath.Base(path))))
	if mimeType != "" {
		header.Set("Content-Type", mimeType)
	}
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, file); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}

	cctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, "POST", t.baseURL+"/api/runner/sessions/"+sessionID+"/attachments", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", writer.FormDataContentType())
	if t.token != "" {
		req.Header.Set("authorization", "Bearer "+t.token)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("POST attachment %s -> %d %s", filepath.Base(path), resp.StatusCode, string(data))
	}
	var out AttachmentCreateResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("POST attachment %s returned empty id", filepath.Base(path))
	}
	return out.ID, nil
}

func escapeMultipartFilename(name string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(name)
}

// createApproval registers a pending tool-permission request (from the orbit MCP
// permission-prompt tool) and returns its id. Idempotent server-side on toolUseId.
func (t *Transport) createApproval(ctx context.Context, sessionID string, body interface{}) (string, error) {
	var r struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/approvals", body, &r, 20*time.Second); err != nil {
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

// StoredEvent is one persisted run_event as the control plane hands it back for a
// transcript rebuild — payloads untruncated, oldest-first.
type StoredEvent struct {
	Seq     int                    `json:"seq"`
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
	Ts      time.Time              `json:"ts"`
}

type StoredEventsResponse struct {
	Events  []StoredEvent `json:"events"`
	HasMore bool          `json:"hasMore"`
}

// sessionEvents pulls one page of the session's stored transcript (seq > after). Used only by
// the transcript rebuild, so the timeout is generous: pages carry whole tool payloads.
func (t *Transport) sessionEvents(ctx context.Context, sessionID string, after, limit int) (*StoredEventsResponse, error) {
	var out StoredEventsResponse
	path := fmt.Sprintf("/runner/sessions/%s/events?after=%d&limit=%d", sessionID, after, limit)
	if err := t.do(ctx, "GET", path, nil, &out, 60*time.Second); err != nil {
		return nil, err
	}
	return &out, nil
}

// listTasks filters and caps server-side. Fetching every task to filter here means downloading
// the owner's whole task history — descriptions included — on each call, which is slow enough to
// time out mid-body on a large account and lands in an agent's context as tens of megabytes.
func (t *Transport) listTasks(status, listID string, limit int) (json.RawMessage, error) {
	q := url.Values{}
	if status != "" {
		q.Set("status", status)
	}
	if listID != "" {
		q.Set("listId", listID)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/runner/tasks"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out json.RawMessage
	err := t.do(nil, "GET", path, nil, &out, taskOpTimeout)
	return out, err
}

func validatePathSegmentID(id string) error {
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, "/\\?#%\r\n") {
		return fmt.Errorf("id must be a single safe path segment")
	}
	return nil
}

func (t *Transport) getTask(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/tasks/"+url.PathEscape(id), nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) taskDependencyGraph(id string, maxDepth, maxNodes int) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	q := url.Values{}
	if maxDepth > 0 {
		q.Set("maxDepth", strconv.Itoa(maxDepth))
	}
	if maxNodes > 0 {
		q.Set("maxNodes", strconv.Itoa(maxNodes))
	}
	path := "/runner/tasks/" + url.PathEscape(id) + "/dependency-graph"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out json.RawMessage
	err := t.do(nil, "GET", path, nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) addTaskDependency(id, dependsOnTaskID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, fmt.Errorf("task id: %w", err)
	}
	if err := validatePathSegmentID(dependsOnTaskID); err != nil {
		return nil, fmt.Errorf("prerequisite task id: %w", err)
	}
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/tasks/"+url.PathEscape(id)+"/dependencies",
		map[string]string{"dependsOnTaskId": dependsOnTaskID}, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) removeTaskDependency(id, dependsOnTaskID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, fmt.Errorf("task id: %w", err)
	}
	if err := validatePathSegmentID(dependsOnTaskID); err != nil {
		return nil, fmt.Errorf("prerequisite task id: %w", err)
	}
	var out json.RawMessage
	err := t.do(nil, "DELETE", "/runner/tasks/"+url.PathEscape(id)+"/dependencies/"+url.PathEscape(dependsOnTaskID), nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) createTask(agentID, sessionID string, body interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks", body, &out, taskOpTimeout, taskCreateHeaders(agentID, sessionID))
	return out, err
}

// createTasksBatch writes several tasks in one atomic call; body is {"tasks":[...]}.
func (t *Transport) createTasksBatch(agentID, sessionID string, body interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks/batch-create", body, &out, taskOpTimeout, taskCreateHeaders(agentID, sessionID))
	return out, err
}

func (t *Transport) updateTask(id string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "PATCH", "/runner/tasks/"+url.PathEscape(id), body, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) deleteTask(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "DELETE", "/runner/tasks/"+url.PathEscape(id), nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) startTask(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/tasks/"+url.PathEscape(id)+"/execute", nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) commentTask(id, agentID, bodyText string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks/"+url.PathEscape(id)+"/comments",
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

func (t *Transport) getTaskList(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/task-lists/"+url.PathEscape(id), nil, &out, taskOpTimeout)
	return out, err
}

// updateTaskList sends only the fields the caller set, so an agent adjusting one knob cannot
// blank the rest. Attribution rides the same agent/session headers the task writes use.
func (t *Transport) updateTaskList(id, agentID string, body map[string]interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	err := t.doHeaders(nil, "PATCH", "/runner/task-lists/"+url.PathEscape(id), body, &out, taskOpTimeout, agentHeader(agentID))
	return out, err
}

func (t *Transport) deleteTaskList(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "DELETE", "/runner/task-lists/"+url.PathEscape(id), nil, &out, taskOpTimeout)
	return out, err
}

// ── Session orchestration ops for the `orbit mcp` server (L3) ──────────────
// Owner-scoped, runner-token-authenticated. Each call also carries the current session id
// and its signed credential so the server can prove which claimed process made the request.

func (t *Transport) createSession(parentSessionID, orchestrationToken string, body interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doOrchestration("POST", "/runner/sessions", body, &out, parentSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) listSessions(callerSessionID, orchestrationToken, query string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doOrchestration("GET", "/runner/sessions"+query, nil, &out, callerSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) searchSessions(callerSessionID, orchestrationToken, query string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doOrchestration("GET", "/runner/sessions/search"+query, nil, &out, callerSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) getSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration("GET", "/runner/sessions/"+url.PathEscape(id), nil, &out, callerSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) sendSessionMessage(callerSessionID, orchestrationToken, id string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration("POST", "/runner/sessions/"+url.PathEscape(id)+"/turns", body, &out, callerSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) interruptSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration("POST", "/runner/sessions/"+url.PathEscape(id)+"/interrupt", nil, &out, callerSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) mergeSession(callerSessionID, orchestrationToken, id string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration("POST", "/runner/sessions/"+url.PathEscape(id)+"/merge", body, &out, callerSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) endSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration("POST", "/runner/sessions/"+url.PathEscape(id)+"/end", nil, &out, callerSessionID, orchestrationToken)
	return out, err
}

func (t *Transport) completeSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	// /runner/sessions/:id/finalize is reserved for a runner reporting process teardown.
	// The explicit suffix keeps the user-facing Complete action unambiguous.
	path := "/runner/sessions/" + url.PathEscape(id) + "/complete-session"
	err := t.doOrchestration("POST", path, nil, &out, callerSessionID, orchestrationToken)
	if err == nil || !strings.Contains(err.Error(), "POST "+path+" -> 404 ") {
		return out, err
	}
	// New runners can overlap an older API replica that still exposes only /archive.
	out = nil
	legacyPath := "/runner/sessions/" + url.PathEscape(id) + "/archive"
	err = t.doOrchestration("POST", legacyPath, nil, &out, callerSessionID, orchestrationToken)
	return out, err
}

// ── Service tokens for headless processes (`orbit token`) ──────────────────
// Runner-token authenticated on purpose: a service token can never mint another, so a leaked
// bridge credential cannot renew itself or widen its own scope.

func (t *Transport) mintServiceToken(body interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, http.MethodPost, "/runner/service-tokens", body, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) listServiceTokens() (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, http.MethodGet, "/runner/service-tokens", nil, &out, taskOpTimeout)
	return out, err
}

func (t *Transport) revokeServiceToken(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, http.MethodDelete, "/runner/service-tokens/"+url.PathEscape(id), nil, &out, taskOpTimeout)
	return out, err
}

// ── Agent management ops for the `orbit mcp` server (L3 orchestration) ──────
// Owner-scoped via the runner token; gated server-side on the CALLING session's agent
// having orchestration enabled (proved by the session id plus its signed credential).

func orchestratorHeaders(sessionID, orchestrationToken string) map[string]string {
	if sessionID == "" && orchestrationToken == "" {
		return nil
	}
	headers := make(map[string]string, 2)
	if sessionID != "" {
		headers["X-Orbit-Session-Id"] = sessionID
	}
	if orchestrationToken != "" {
		headers["X-Orbit-Session-Token"] = orchestrationToken
	}
	return headers
}

func isRefreshableOrchestrationCredentialError(err error) bool {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.statusCode != http.StatusForbidden {
		return false
	}
	var response struct {
		Code string `json:"code"`
	}
	if json.Unmarshal([]byte(httpErr.body), &response) == nil {
		switch strings.ToUpper(strings.TrimSpace(response.Code)) {
		case orchestrationCredentialMissing, orchestrationCredentialInvalid:
			return true
		}
	}
	// Message fallback keeps a new runner compatible with a server being rolled
	// from the pre-code credential protocol. New servers return the stable code.
	message := strings.ToLower(httpErr.body)
	message = strings.NewReplacer("_", " ", "-", " ").Replace(message)
	return strings.Contains(message, "orchestration") &&
		(strings.Contains(message, "credential") || strings.Contains(message, "token")) &&
		(strings.Contains(message, "missing") || strings.Contains(message, "invalid"))
}

func credentialForOrchestrationRequest(sessionID, fallback string) (string, error) {
	token, err := loadOrchestrationCredential(sessionID)
	if err == nil {
		return token, nil
	}
	if !os.IsNotExist(err) {
		return "", fmt.Errorf("read session orchestration credential: %w", err)
	}
	return strings.TrimSpace(fallback), nil
}

func (t *Transport) refreshOrchestrationCredential(sessionID string) (string, error) {
	if err := validatePathSegmentID(sessionID); err != nil {
		return "", fmt.Errorf("session %w", err)
	}
	var response struct {
		OrchestrationToken string `json:"orchestrationToken"`
	}
	path := "/runner/sessions/" + url.PathEscape(sessionID) + "/orchestration-credential"
	if err := t.do(nil, http.MethodPost, path, nil, &response, taskOpTimeout); err != nil {
		return "", err
	}
	token := strings.TrimSpace(response.OrchestrationToken)
	if token == "" {
		return "", fmt.Errorf("server returned an empty session orchestration credential")
	}
	if err := storeOrchestrationCredential(sessionID, token); err != nil {
		return "", fmt.Errorf("store refreshed session orchestration credential: %w", err)
	}
	return token, nil
}

// doOrchestration reads the credential dynamically, then refreshes and retries
// exactly once only when the server explicitly identifies it as missing/invalid.
func (t *Transport) doOrchestration(method, path string, body, out interface{}, sessionID, fallbackToken string) error {
	// A headless caller (launchd/cron) has no calling session, so there is no session-bound
	// credential to read or refresh: the runner token alone authenticates, and the server
	// narrows the request to this runner's own sessions.
	if strings.TrimSpace(sessionID) == "" {
		return t.doHeaders(nil, method, path, body, out, taskOpTimeout, nil)
	}
	token, err := credentialForOrchestrationRequest(sessionID, fallbackToken)
	if err != nil {
		return err
	}
	err = t.doHeaders(nil, method, path, body, out, taskOpTimeout, orchestratorHeaders(sessionID, token))
	if !isRefreshableOrchestrationCredentialError(err) {
		return err
	}
	token, refreshErr := t.refreshOrchestrationCredential(sessionID)
	if refreshErr != nil {
		return fmt.Errorf("refresh session orchestration credential: %w", refreshErr)
	}
	return t.doHeaders(nil, method, path, body, out, taskOpTimeout, orchestratorHeaders(sessionID, token))
}

func (t *Transport) listAgents(sessionID, orchestrationToken string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doOrchestration("GET", "/runner/agents", nil, &out, sessionID, orchestrationToken)
	return out, err
}

func (t *Transport) createAgent(sessionID, orchestrationToken string, body interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doOrchestration("POST", "/runner/agents", body, &out, sessionID, orchestrationToken)
	return out, err
}

func (t *Transport) updateAgent(sessionID, orchestrationToken, id string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration("PATCH", "/runner/agents/"+url.PathEscape(id), body, &out, sessionID, orchestrationToken)
	return out, err
}
