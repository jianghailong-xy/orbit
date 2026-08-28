package main

import (
	"bytes"
	"context"
	"crypto/rand"
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
	runnerCapabilitiesHeader             = "X-Orbit-Runner-Capabilities"
	executableAcceptanceCapabilityHeader = "X-Orbit-Executable-Acceptance-Capability"
	sessionOrchestrationCredentialV1     = "session-orchestration-credential-v1"
	sessionTerminalHandoffV1             = "session-terminal-handoff-v1"
	sessionWorktreeOpsV1                 = "session-worktree-ops-v1"
	// Mid-turn delivery for the codex runtime (`turn/steer`). Declared from the runtime table
	// rather than listed here — see declaredSteerCapabilities — because a runner that names
	// it is telling the control plane to file codex steers for this machine, and one whose
	// loop still refuses them would make every mid-turn message fail instead of queue.
	sessionCodexSteerV1            = "session-codex-steer-v1"
	orchestrationCredentialMissing = "ORCHESTRATION_CREDENTIAL_MISSING"
	orchestrationCredentialInvalid = "ORCHESTRATION_CREDENTIAL_INVALID"
)

// runnerCapabilitiesV1 is what this binary declares on every call it makes: the fixed set of
// runner-wide features, plus one token per runtime it can steer mid-turn. Sent on every
// request rather than only on the heartbeat, so the control plane can answer both questions
// it has to ask — what this machine could do when it last reported (which decides how a
// message is filed) and what the process polling right now can do (which decides whether that
// message is handed over).
//
// Built in init() rather than as a var initializer because the runtime table it reads holds
// the session drivers, and those reach this header back through the transport: written as one
// expression it is a package initialization cycle.
var runnerCapabilitiesV1 string

func init() {
	runnerCapabilitiesV1 = strings.Join(append([]string{
		sessionOrchestrationCredentialV1,
		sessionTerminalHandoffV1,
		sessionWorktreeOpsV1,
	}, declaredSteerCapabilities()...), ",")
}

type transportHTTPError struct {
	method     string
	path       string
	statusCode int
	body       string
}

func (e *transportHTTPError) Error() string {
	// Unit L7: a refusal that carries a stable code and an executable next step says both of them
	// FIRST, on their own lines, and keeps the raw body underneath.
	//
	// The body has always contained them; what a person got was one line of JSON with the two
	// fields that matter buried in the middle of it. The control plane's whole refusal discipline
	// — one frozen code per event, one sentence naming what to do — is worth nothing at a terminal
	// if reading it means parsing JSON by eye. The raw body stays because a code this build has
	// never heard of, and every field neither of these names, is still in there.
	if refusal := e.refusal(); refusal != "" {
		return fmt.Sprintf("%s %s -> %d\n%s%s", e.method, e.path, e.statusCode, refusal, e.body)
	}
	return fmt.Sprintf("%s %s -> %d %s", e.method, e.path, e.statusCode, e.body)
}

// refusal is the "code / what / do" block for a body that carries a code, and "" for one that does
// not — a validation error listing field messages, an upstream 502, an HTML error page. The name is
// historical: an ADVISORY is deliberately labelled as advice, never as a hard refusal.
func (e *transportHTTPError) refusal() string {
	var body struct {
		Code           string `json:"code"`
		Kind           string `json:"kind"`
		Advisory       bool   `json:"advisory"`
		Message        any    `json:"message"`
		RequiredAction string `json:"requiredAction"`
		Owner          string `json:"owner"`
	}
	if err := json.Unmarshal([]byte(e.body), &body); err != nil || body.Code == "" {
		return ""
	}
	label := "refused"
	if body.Advisory || body.Kind == "ADVISORY" {
		label = "advice"
	}
	out := "  " + label + ": " + body.Code + "\n"
	if message, ok := body.Message.(string); ok && message != "" {
		out += "  what:    " + message + "\n"
	}
	if body.Owner != "" {
		out += "  owner:   " + body.Owner + "\n"
	}
	if body.RequiredAction != "" {
		out += "  do:      " + body.RequiredAction + "\n"
	}
	return out
}

// code is the control plane's own machine-readable name for this refusal, when the body carried
// one, and "" otherwise.
//
// Read rather than inferred from the status, because one status means several different things: the
// run door answers 409 for `TASK_RUN_REQUEST_IN_PROGRESS` (ask again with the same id) and 409 for
// `TASK_RUN_REQUEST_MISMATCH` (that id already names something else), and only one of them may ever
// be retried. Branching on the prose instead would break the first time somebody reworded it.
func (e *transportHTTPError) code() string {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(e.body), &body); err != nil {
		return ""
	}
	return body.Code
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
	req.Header.Set(executableAcceptanceCapabilityHeader, executableAcceptanceCapabilityHeaderValue())
	req.Header.Set("X-Orbit-Supported-Providers", runnerSupportedProviders)
	req.Header.Set(runnerWriteCapabilityRevisionHeader, strconv.Itoa(runnerWriteCapabilityRevision))
	req.Header.Set(runnerWriteSchemaRevisionHeader, strconv.Itoa(runnerWriteSchemaRevision))
	req.Header.Set(runnerWriteContractDigestHeader, runnerWriteContractDigest)
	req.Header.Set(runnerCLIVersionHeader, version)
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
	// A read that fails is a TRANSPORT failure, not an empty answer. `Do` returns as soon as the
	// status line and headers arrive, so a connection that dies while the body is still streaming
	// lands HERE — with a 2xx already received and the work behind it very possibly committed.
	// Discarding this error made that case indistinguishable from a legitimately empty 200: the
	// caller was told its request had succeeded, having been handed nothing that says so. Every
	// caller is better served by the truth, and the one that can ACT on it — `startTask`, whose
	// request carries a name — resends under that name rather than guessing.
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("%s %s: reading response body: %w", method, path, err)
	}
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
//
// `acceptsSteer` says this binary knows the `steer` kind — a message written into the turn
// already running. It is a property of the runner, not of the session: every session loop
// here either folds a steer into the running turn (claude) or refuses it where the sender
// can see it (refuseUnsupportedSteer). A runner that predates the kind sends no such flag
// and is handed no steer, so the message waits and becomes an ordinary turn when the
// running one ends, instead of being leased by a poller with no case for it.
func (t *Transport) inbox(ctx context.Context, sessionID, leaseGeneration string) (*RunInboxResponse, error) {
	var r RunInboxResponse
	path := "/runner/sessions/" + sessionID + "/inbox?acceptsSteer=1"
	if leaseGeneration != "" {
		path += "&leaseGeneration=" + url.QueryEscape(leaseGeneration)
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

// startExecutableAcceptance is idempotent on admission id. A lost success is retried until the
// server returns the same attempt row; no command is spawned while this handshake is unresolved.
func (t *Transport) startExecutableAcceptance(
	ctx context.Context,
	sessionID string,
	admissionID string,
) (*ExecutableAttemptStartResponse, error) {
	var response ExecutableAttemptStartResponse
	err := retryIdempotentWhile(ctx, func(attemptCtx context.Context) error {
		response = ExecutableAttemptStartResponse{}
		path := "/runner/sessions/" + sessionID + "/executable-acceptance/" + admissionID + "/start"
		return t.do(attemptCtx, "POST", path, map[string]interface{}{}, &response, 15*time.Second)
	}, isRetryableTransportError)
	if err != nil {
		return nil, err
	}
	return &response, nil
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
// activateTurnLeases makes this engine generation the session's sole inbox consumer, and returns
// what the generation it replaces left behind: mid-turn messages that were leased by a process
// which then died. The control plane cannot answer for those itself — a steer's whole outcome is
// reported on the session's event stream, which only a live runner writes to — so it hands them
// over here, to the one process that has both a stream and a reason to be looking.
func (t *Transport) activateTurnLeases(ctx context.Context, sessionID, leaseGeneration string) (ActivateTurnLeasesResponse, error) {
	body := map[string]string{"leaseGeneration": leaseGeneration, "leaseOwner": t.leaseOwner}
	var out ActivateTurnLeasesResponse
	err := t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/activate-leases", body, &out, 15*time.Second)
	return out, err
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

// cloneResult reports the outcome of a heartbeat-delivered CloneCommand: where the checkout is
// and what the remote's default branch is, or git's own words for why there is no checkout.
func (t *Transport) cloneResult(b CloneResultRequest) error {
	return t.do(nil, "POST", "/runner/clone-result", b, nil, 15*time.Second)
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

func sessionHeader(sessionID string) map[string]string {
	if sessionID == "" {
		return nil
	}
	return map[string]string{"X-Orbit-Session-Id": sessionID}
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
func (t *Transport) listTasks(status, listID, projectID string, labels []string, limit int) (json.RawMessage, error) {
	q := url.Values{}
	if status != "" {
		q.Set("status", status)
	}
	if listID != "" {
		q.Set("listId", listID)
	}
	if projectID != "" {
		q.Set("projectId", projectID)
	}
	// Repeated rather than comma-joined: a label may legitimately contain a comma, and the
	// server accepts both forms.
	for _, label := range labels {
		q.Add("labels", label)
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

// labelSummary returns every label in scope with its own status breakdown, in one call. The
// point of asking the server rather than listing tasks and tallying here is that the tally is
// over every task carrying the label, not over the page the caller could afford to download.
func (t *Transport) labelSummary(listID string) (json.RawMessage, error) {
	q := url.Values{}
	if listID != "" {
		q.Set("listId", listID)
	}
	path := "/runner/tasks/labels"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out json.RawMessage
	err := t.do(nil, "GET", path, nil, &out, taskOpTimeout)
	return out, err
}

// listProviders returns the provider slugs this owner may pass as `provider` — the built-in
// engines plus their configured ones. Plain runner auth, like the task routes whose `provider`
// field it answers for, so it works outside an orchestration-enabled session too.
func (t *Transport) listProviders() (json.RawMessage, error) {
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/providers", nil, &out, taskOpTimeout)
	return out, err
}

// notify pushes one line the agent wrote to its owner's devices. Plain runner auth like the task
// routes: the recipient is the runner's owner either way, so there is nobody else it could reach.
// sessionID (when running inside a session) gives the alert that session's title and makes a tap
// on it open the session; headless it is empty and the runner's name titles the alert instead.
// The response says whether anything was actually delivered — the caller reports it verbatim
// rather than assuming a 200 means somebody's phone rang.
func (t *Transport) notify(sessionID, message string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/notify", map[string]string{"message": message},
		&out, taskOpTimeout, sessionHeader(sessionID))
	return out, err
}

// listTaskPage returns one page of tasks plus the cursor that continues it — an empty cursor
// means this was the last page. listTasks above can only ever answer with the newest `limit`
// rows, so this is what makes walking an entire account possible.
func (t *Transport) listTaskPage(status, listID, projectID string, labels []string, limit int, cursor string) (json.RawMessage, string, error) {
	q := url.Values{}
	if status != "" {
		q.Set("status", status)
	}
	if listID != "" {
		q.Set("listId", listID)
	}
	// Every filter has to ride every page, not just the first: a scope dropped after page one
	// silently widens a walk to the whole account, which reads as "the project has 27k tasks".
	if projectID != "" {
		q.Set("projectId", projectID)
	}
	for _, label := range labels {
		q.Add("labels", label)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	path := "/runner/tasks/page"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out struct {
		Items      json.RawMessage `json:"items"`
		NextCursor *string         `json:"nextCursor"`
	}
	if err := t.do(nil, "GET", path, nil, &out, taskOpTimeout); err != nil {
		return nil, "", err
	}
	next := ""
	if out.NextCursor != nil {
		next = *out.NextCursor
	}
	return out.Items, next, nil
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

// Completion evidence has one transport shape for both native CLI and MCP. The source Session
// and acting workspace are authenticated headers, not caller-editable fields in the evidence.
func (t *Transport) submitTaskEvidence(id, agentID, sessionID string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	if sessionID == "" {
		return nil, fmt.Errorf("source session id is required")
	}
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks/"+url.PathEscape(id)+"/evidence",
		body, &out, taskOpTimeout, taskCreateHeaders(agentID, sessionID))
	return out, err
}

func (t *Transport) listTaskEvidence(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/tasks/"+url.PathEscape(id)+"/evidence", nil, &out, taskOpTimeout)
	return out, err
}

// getProject reads one project's durable context: its goal, acceptance criteria, instructions,
// status, coordinator ids and task tallies. Tallies rather than task rows — the tasks themselves
// are what the task routes above are for.
//
// Ids arrive in whichever spelling the caller holds (base62 short form or raw UUID); the server
// decodes both, and an id belonging to somebody else is its 404, not a check made here.
func (t *Transport) getProject(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/projects/"+url.PathEscape(id), nil, &out, taskOpTimeout)
	return out, err
}

// getTaskAttribution reads unit L7's attribution boundary for one task: the project the work
// counts towards (title, Base62 id, status, acceptance epoch), where it was NOTICED (evidence, and
// labelled as evidence — §3 SC7 is explicit that finding work somewhere grants no authority to
// write there), the acceptance criteria that cite this task and whether each still counts, the
// declared crossing that touches it, and the attribution blocker holding it up.
//
// The read a coordinator most needs before it writes anywhere. Without it, the only way to learn
// where a write lands is to be refused by the gate that decides it, which is after the decision has
// been made.
func (t *Transport) getTaskAttribution(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/tasks/"+url.PathEscape(id)+"/attribution", nil, &out, taskOpTimeout)
	return out, err
}

// getProjectHandoffs reads what has been asked and answered about work crossing into or out of one
// project, in both directions.
//
// Read only, and there is deliberately no companion that answers one: §7 RB2 puts the answer with
// the USER, because an agent signing for another goal is the incident this whole unit exists for
// with one more actor in it. What a coordinator gets is the ability to SEE that it is waiting on a
// person, which is the difference between a blocked project and a silent one.
func (t *Transport) getProjectHandoffs(id, state string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	path := "/runner/projects/" + url.PathEscape(id) + "/handoffs"
	if state != "" {
		path += "?state=" + url.QueryEscape(state)
	}
	var out json.RawMessage
	err := t.do(nil, "GET", path, nil, &out, taskOpTimeout)
	return out, err
}

// getProjectReopenImpact reads what reopening a settled project would cost: the acceptance epoch it
// is in, the one a reopen would start, how many acceptance attempts stop being current, and whether
// its DONE rests on the pre-acceptance compatibility stamp.
//
// Also read only, and for the same reason. A write refused `PROJECT_REOPEN_REQUIRED` is entitled to
// know what asking a person for a reopen would cost them; it is not entitled to perform one.
func (t *Transport) getProjectReopenImpact(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/projects/"+url.PathEscape(id)+"/reopen", nil, &out, taskOpTimeout)
	return out, err
}

// getProjectAcceptance reads a project's acceptance standing (contract §13.4): the stated criteria
// as the server decomposes them, the digest of the facts a DONE would be checked against, every
// evidence version with its projected per-criterion conclusions, the newest merge observation per
// requirement, the append-only audit, and canonical doneGate — the exact current cut, proof graph,
// obligations, structured reasons, owner/actor and next action. Unknown or stale inputs deny
// closure; legacy blocker/signal summaries are not an alternate decision source.
//
// The read to make BEFORE claiming a project is finished. "The tests passed" written in a comment
// is not evidence the server can check; a durable conclusion event in this record is.
func (t *Transport) getProjectAcceptance(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/projects/"+url.PathEscape(id)+"/acceptance", nil, &out, taskOpTimeout)
	return out, err
}

// confirmProjectAcceptanceCriteria records one confirmation for the exact current standard-set
// digest. The transport's session header is attribution, not a body field: the ordinary
// session-aware client forwards it so an attributed judgment Session is refused. An omitted header
// is indistinguishable from the admitted headless-runner path and remains machine-attributed.
func (t *Transport) confirmProjectAcceptanceCriteria(id, sessionID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doHeaders(nil, "POST",
		"/runner/projects/"+url.PathEscape(id)+"/acceptance/criteria-confirmation",
		map[string]interface{}{}, &out, taskOpTimeout, sessionHeader(sessionID))
	return out, err
}

// openProjectAcceptanceRun evaluates the current evidence set. It is idempotent: callers observing
// the same criteria and merge facts receive the same immutable evidence-version row.
//
// Who concluded is the server's to decide from this credential (COORDINATOR_AGENT), not this
// process's to claim.
func (t *Transport) openProjectAcceptanceRun(id string, body map[string]interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/projects/"+url.PathEscape(id)+"/acceptance/runs", body, &out, taskOpTimeout)
	return out, err
}

// finalizeProjectAcceptanceRun appends one conclusion event per stated criterion, with the evidence
// for it. The current verdict is derived from events and cannot be supplied — all PASS is PASS, any
// FAIL is FAIL, anything else is INCONCLUSIVE.
func (t *Transport) finalizeProjectAcceptanceRun(id, runID string, body map[string]interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	if err := validatePathSegmentID(runID); err != nil {
		return nil, fmt.Errorf("run id: %w", err)
	}
	var out json.RawMessage
	err := t.do(nil, "POST",
		"/runner/projects/"+url.PathEscape(id)+"/acceptance/runs/"+url.PathEscape(runID)+"/verdict",
		body, &out, taskOpTimeout)
	return out, err
}

// recordProjectMergeEvidence records what a target branch was observed to CONTAIN (§13.4 AE9-b).
//
// The runner is the side that can actually look — it has the checkout. contentHash is a sha256 of
// the content, never `git branch --contains`: after a squash that answer is a guaranteed false
// negative, which is the lesson the contract carries in clause 6.
func (t *Transport) recordProjectMergeEvidence(id string, body map[string]interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/projects/"+url.PathEscape(id)+"/acceptance/merge-evidence", body, &out, taskOpTimeout)
	return out, err
}

// createProject records a new project under the runner's owner — the same tenant every task write
// here lands in, since the credential names a machine rather than a person.
//
// The body goes as the caller built it. Length bounds, the blank-is-null rule and which fields
// exist at all are the server's CreateProjectDto to decide; a second opinion held here would be
// one that drifts.
//
// sessionID travels in the header rather than the body, exactly as it does for a created task —
// and for a stronger reason: the server reads it to bind the calling session as this project's
// coordinator, along with the workspace that session runs in. A session or workspace in the BODY
// would be this process's claim about which conversation coordinates the project; the header is a
// claim about which session is calling, which the server checks against the session it has. Empty
// (headless) sends no header at all, and the project is created bound to nothing — see
// sessionHeader.
func (t *Transport) createProject(sessionID string, body map[string]interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/projects", body, &out, taskOpTimeout, sessionHeader(sessionID))
	return out, err
}

// updateProject changes a project's title, goal, acceptance criteria, instructions or status.
//
// Only the keys the caller put in `body` are sent, and a key holding nil is sent AS null — that is
// how a field gets cleared, so nothing here may prune it. Deciding locally which fields are worth
// forwarding is the one thing that would turn "clear the goal" into "leave the goal alone".
//
// No session header, unlike createProject: a project's coordinator is settled when the project is
// created, and an update sent from wherever the agent happens to be running now is not a request
// to move it. Moving a coordinator is a decision someone makes on purpose.
func (t *Transport) updateProject(id string, body map[string]interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "PATCH", "/runner/projects/"+url.PathEscape(id), body, &out, taskOpTimeout)
	return out, err
}

// deleteProject permanently removes one empty project. The server owns the destructive guard:
// a project with any tasks is refused atomically rather than having those tasks deleted or
// detached. Keeping the rule there makes the CLI, MCP and user-facing doors identical.
func (t *Transport) deleteProject(id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "DELETE", "/runner/projects/"+url.PathEscape(id), nil, &out, taskOpTimeout)
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

// updateTask carries the acting session, which the server reads for decisions that turn on WHO is
// writing, including independent verification. Direct DONE is refused for every actor; retaining
// the header keeps the refusal attributable and preserves the separate verdict-independence rule.
func (t *Transport) updateTask(sessionID, id string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doHeaders(nil, "PATCH", "/runner/tasks/"+url.PathEscape(id), body, &out, taskOpTimeout,
		sessionHeader(sessionID))
	return out, err
}

// signoffTask carries the acting session for the opposite reason to an ordinary attributed write:
// the absence of a session is the runner owner's human door, while any agent session must be
// refused rather than allowed to impersonate that person in a HUMAN_SIGNOFF event.
func (t *Transport) signoffTask(sessionID, id, requestID, evidenceDigest, evidence string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks/"+url.PathEscape(id)+"/signoff",
		map[string]string{
			"requestId":      requestID,
			"evidenceDigest": evidenceDigest,
			"evidence":       evidence,
		}, &out, taskOpTimeout, sessionHeader(sessionID))
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

// runRequestEntropy is the CSPRNG run-request names are drawn from. A variable only so a test can
// substitute a source that fails — see `newRunRequestToken`, whose whole contract is what happens
// then.
var runRequestEntropy io.Reader = rand.Reader

// newRunRequestToken draws the name of ONE task_start — one MCP tool call, one `orbit task start`.
//
// The server keys that request's receipt on it, so a delivery it has already answered is answered
// from its answer instead of starting a second run. What the server cannot decide for itself is
// which of two identical POSTs is a retry and which is a fresh invocation: the bytes are the same,
// and no property of the database tells them apart. So the identity is CARRIED, and it is drawn
// HERE — at the invocation, above every resend of it — rather than inside `do`, which would give
// each attempt its own name and defeat the whole point.
//
// Base62, the spelling every id above this API line is written in: `@IsPublicId` decodes it to the
// UUID the receipt is keyed on, so this and a raw UUID reach the same row.
//
// FAILS CLOSED. No entropy is an ERROR and the invocation stops, rather than falling back to the
// bodiless POST an older runner sends. The server still accepts that wire and always will — that is
// what keeps deployed runners working — but a binary that CAN name its request and quietly does not
// is a different thing: it silently gives up the idempotency this exists for, at exactly the moment
// something is already wrong with the machine. A refusal the caller can see is the honest answer.
func newRunRequestToken() (string, error) {
	var id [16]byte
	if _, err := io.ReadFull(runRequestEntropy, id[:]); err != nil {
		return "", fmt.Errorf("cannot name this run request (no entropy): %w", err)
	}
	id[6] = (id[6] & 0x0f) | 0x40 // UUID v4
	id[8] = (id[8] & 0x3f) | 0x80 // RFC 4122 variant
	return publicID(fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])), nil
}

// How far a named run request is resent, and how long it waits between attempts: three resends
// after the first delivery, backing off 250ms -> 500ms -> 1s. A bounded ~1.75s in the worst case,
// and then the invocation fails and says exactly why. Bounded because this is for a dropped
// connection and a lease being handed over, not for an outage.
const (
	runRequestResendAttempts = 4
	runRequestResendDelay    = 250 * time.Millisecond
)

// taskRunRequestInProgress is the control plane's name for "somebody is answering this exact
// request right now" — the first delivery still holds the lease. It is the one HTTP answer at this
// door that is not a result: the request was not evaluated a second time and nothing was changed,
// and asking again with the SAME triggerId reads back the first delivery's answer.
const taskRunRequestInProgress = "TASK_RUN_REQUEST_IN_PROGRESS"

// isResendableRunFailure says whether this attempt left the request unanswered.
//
// Two cases and no others. A non-HTTP error means the answer never arrived — the POST may well have
// been delivered and the run committed, which is the whole reason a named request exists. And
// `TASK_RUN_REQUEST_IN_PROGRESS` means the answer exists but is not ready, which is exactly the
// window a resend lands in. Every other refusal — a 400, a 403, a 409 `TASK_RUN_REQUEST_MISMATCH` —
// IS the result, and asking again can only repeat it.
func isResendableRunFailure(err error) bool {
	httpErr, answered := err.(*transportHTTPError)
	if !answered {
		return true
	}
	return httpErr.statusCode == http.StatusConflict && httpErr.code() == taskRunRequestInProgress
}

// startTask runs an owned task now, under the name its caller drew for this invocation.
//
// `triggerID` is threaded in rather than drawn here because "the same request" is a property of the
// INVOCATION, not of the HTTP attempt: a 307 replays this body verbatim (net/http replays a
// *bytes.Reader for us), and every attempt below reuses the token it was handed.
//
// An unnamed start does not leave this runner. The guard is here rather than only at the two call
// sites so the property belongs to the transport: every task_start this binary makes is named.
//
// AND THE NAME IS WHAT LICENSES THE RESEND. The case this exists for is the one a caller cannot
// see: the POST is delivered, the server commits the run, and the ANSWER is lost — a dropped
// connection, a killed proxy, a timeout. Without a resend the invocation fails, and the next
// `orbit task start` draws a NEW name and starts a SECOND run for work that is already running.
// With one, the retry carries the same name and the server answers it from the first delivery's
// receipt. That reasoning applies to this endpoint because it is idempotent UNDER THIS TOKEN, and
// to nothing else here — `do` is deliberately left without a retry of its own.
//
// What is resent, and what is not, is `isResendableRunFailure`: a missing answer, and the one
// refusal that means the answer is not ready yet. Every other refusal — 400, 403, 409
// `TASK_RUN_REQUEST_MISMATCH` — is the result, not a fault to paper over.
func (t *Transport) startTask(id, triggerID string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	if triggerID == "" {
		return nil, fmt.Errorf("refusing to start task %s unnamed: a run request without a triggerId cannot be retried safely", id)
	}
	// Built once, outside the loop, so every attempt is byte-identical by construction rather than
	// by two encoders agreeing.
	body := map[string]string{"triggerId": triggerID}
	path := "/runner/tasks/" + url.PathEscape(id) + "/execute"
	var lastErr error
	for attempt := range runRequestResendAttempts {
		if attempt > 0 {
			time.Sleep(runRequestResendDelay << (attempt - 1))
		}
		var out json.RawMessage
		err := t.do(nil, "POST", path, body, &out, taskOpTimeout)
		if err == nil {
			return out, nil
		}
		lastErr = err
		if !isResendableRunFailure(err) {
			return nil, err
		}
	}
	// The real last answer, not a summary of it: a caller that ran out of attempts while the
	// control plane kept saying "being answered right now" needs to be told that, and a lost
	// connection needs to read as one.
	return nil, lastErr
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
// blank the rest.
//
// Both attribution headers, via taskCreateHeaders: the agent alone is not enough. A policy
// revision records which run made it so a human reading the history months later can open that
// run and see the reasoning; with only the agent id the entry says "wikova changed this" of a
// workspace that has had thousands of sessions.
func (t *Transport) updateTaskList(id, agentID, sessionID string, body map[string]interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	err := t.doHeaders(nil, "PATCH", "/runner/task-lists/"+url.PathEscape(id), body, &out, taskOpTimeout,
		taskCreateHeaders(agentID, sessionID))
	return out, err
}

// batchPreview asks what a batch create would do. Writes nothing; it fills the approval card.
func (t *Transport) batchPreview(agentID, sessionID string, body map[string]interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/tasks/batch-preview", body, &out, taskOpTimeout,
		taskCreateHeaders(agentID, sessionID))
	return out, err
}

// dagPreview asks what a batch of dependency edits would do. Writes nothing; the answer is what
// fills the approval card.
func (t *Transport) dagPreview(id string, body map[string]interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/task-lists/"+url.PathEscape(id)+"/dag-preview", body, &out, taskOpTimeout)
	return out, err
}

// dagApply commits that batch, after a human allowed it. The server re-validates rather than
// trusting the preview: approval happens at human speed and the graph may have moved.
func (t *Transport) dagApply(id string, body map[string]interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/task-lists/"+url.PathEscape(id)+"/dag-apply", body, &out, taskOpTimeout)
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

// interruptSession stops a session's current turn. A non-nil body carrying `message` makes
// it the atomic "stop that and do this instead" the browser sends: one transaction, so the
// follow-up cannot be deleted by the interrupt it travels with. nil is a plain interrupt.
func (t *Transport) interruptSession(callerSessionID, orchestrationToken, id string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration("POST", "/runner/sessions/"+url.PathEscape(id)+"/interrupt", body, &out, callerSessionID, orchestrationToken)
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

// recordMergeReceipt files one merge of a session's branch (§13.7). Plain runner credential, no
// orchestration header: it records work that already happened rather than asking another session's
// runner to do anything, so requiring an orchestration grant would mean the deployments that most
// need the audit are the ones that cannot write it.
func (t *Transport) recordMergeReceipt(id string, body interface{}) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "POST", "/runner/sessions/"+url.PathEscape(id)+"/merge-receipts", body, &out, 20*time.Second)
	return out, err
}

func (t *Transport) listMergeReceipts(id string, limit int) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	path := "/runner/sessions/" + url.PathEscape(id) + "/merge-receipts"
	if limit > 0 {
		path += "?limit=" + strconv.Itoa(limit)
	}
	var out json.RawMessage
	err := t.do(nil, "GET", path, nil, &out, 20*time.Second)
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

func (t *Transport) deleteSession(callerSessionID, orchestrationToken, id string) (json.RawMessage, error) {
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.doOrchestration(http.MethodDelete, "/runner/sessions/"+url.PathEscape(id), nil, &out, callerSessionID, orchestrationToken)
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
