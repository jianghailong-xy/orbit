package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// session_create(wait) and `orbit session create --wait`, backed by a watch (docs/watch-contract.md §13).
//
// The wait used to exist only inside this process: it polled the new session for a bounded time and gave
// up with whatever it had last seen. When that time ran out, the control plane stopped answering, or the
// engine running this process was recycled, the intent to learn when that session settled went with it.
// So before it waits, the wait now records that intent on the server as a watch that wakes the calling
// session when the new session's turn settles. It still waits inline for the same bounded time and still
// answers with the settled session when it can, then releases the watch so the answer arrives once. When
// it cannot answer, it hands the watch back instead of dropping the intent. When the server did not record
// the watch, nothing holds the intent, so an answer that has not settled says that instead.

// sessionWaitWatchKeyPrefix names the watch a wait records for one new session, so a repeated wait on the
// same session reads back the watch already made instead of making another.
const sessionWaitWatchKeyPrefix = "session-create-wait:"

// A wait answered inline releases its watch. A watch that already matched owes a wake the delivery worker
// queues within one of its passes (every 5s), and until the wake is queued the release says to ask again.
var (
	watchReleaseRetryInterval = time.Second
	watchReleaseAttempts      = 15
)

// Recording the watch is asked again when the failure could clear on its own (a 5xx, a timeout, a dropped
// connection). The idempotency key makes that safe: an attempt whose answer was lost reads back as the
// watch it recorded.
var (
	watchRecordRetryInterval = time.Second
	watchRecordAttempts      = 3
)

const sessionWaitUnreleasedNote = "The session settled, and its state is the answer. The watch that recorded this wait " +
	"could not be taken back, so a turn from it saying the same may still arrive in the calling session: treat that turn " +
	"as already handled."

const sessionWaitUnbackedNote = "No server-held watch backs this wait: nothing starts a turn in the calling session when " +
	"the new session settles. Look at it again later, or await it to be woken when it settles."

// sessionWaitWatch is what a caller has to know about the watch behind a wait. It is printed beside the
// session under "watch" whenever the wait did not end cleanly inline.
type sessionWaitWatch struct {
	// Empty when no watch could be recorded; Error says why, and Code is the server's refusal code when it named one.
	ID string `json:"id,omitempty"`
	// Why the call stopped waiting while the watch goes on waiting: TIMEOUT or TRANSPORT_ERROR.
	HandedBack string `json:"handedBack,omitempty"`
	// What releasing the watch came to, when an inline answer could not release it cleanly.
	Release string `json:"release,omitempty"`
	Code    string `json:"code,omitempty"`
	Error   string `json:"error,omitempty"`
	Note    string `json:"note"`
}

// sessionWait is how one wait ended.
type sessionWait struct {
	sessionID string
	// The session as last seen: settled when the wait ended because it settled.
	session json.RawMessage
	settled bool
	budget  time.Duration
	// Set when the caller has to know about the watch: nil after a clean inline answer, and for a caller with
	// no session a watch could wake.
	watch *sessionWaitWatch
}

// waitForSessionDurably waits for a session just created from ctx's session to settle, recording the wait
// as a watch first. A caller with no session of its own (headless) has nothing a watch could wake and waits
// the way it always did. When the watch could not be recorded the call still waits inline, unless the
// control plane refused it: asking again gets the same answer, so the call returns the session as created.
// Either way an answer that has not settled carries under "watch" why nothing backs the wait.
func waitForSessionDurably(t *Transport, ctx cliOrchestrationContext, created json.RawMessage) (sessionWait, error) {
	childID := rawJSONID(created)
	if childID == "" {
		return sessionWait{session: created}, nil
	}
	polls := sessionWaitPolls(spawnDepthFromEnv())
	wait := sessionWait{sessionID: childID, session: created, budget: time.Duration(polls) * sessionWaitInterval}
	if strings.TrimSpace(ctx.sessionID) == "" {
		raw, err := waitForSessionRaw(t, ctx, created)
		wait.session, wait.settled = raw, sessionRawSettled(raw)
		return wait, err
	}
	watchID, err := recordSessionWaitWatch(t, ctx, childID)
	if err != nil {
		if !sessionWaitWatchRefused(err) {
			raw, waitErr := waitForSessionRaw(t, ctx, created)
			if waitErr != nil {
				return wait, waitErr
			}
			wait.session = raw
		}
		if wait.settled = sessionRawSettled(wait.session); !wait.settled {
			reason, code := unbackedSessionWaitReason(err)
			wait.watch = &sessionWaitWatch{Code: code, Error: reason, Note: sessionWaitUnbackedNote}
		}
		return wait, nil
	}
	for i := 0; ; i++ {
		final := i == polls
		if !final {
			time.Sleep(sessionWaitInterval)
		}
		raw, err := t.getSession(ctx.sessionID, ctx.token, childID)
		if err != nil {
			wait.watch = handedBackWatch(watchID, "TRANSPORT_ERROR", err)
			return wait, nil
		}
		wait.session = raw
		if sessionRawSettled(raw) {
			wait.settled = true
			wait.watch = releaseSessionWaitWatch(t, ctx, watchID)
			return wait, nil
		}
		if final {
			wait.watch = handedBackWatch(watchID, "TIMEOUT", nil)
			return wait, nil
		}
	}
}

// sessionWaitWatchBody is the watch a wait records: the line session_create(wait) always waited for, a
// settled turn, waking the calling session.
func sessionWaitWatchBody(sessionID string) map[string]interface{} {
	return map[string]interface{}{
		"predicateVersion": watchPredicateVersion,
		"predicate":        watchAggregate("ALL", "SESSION_TURN_SETTLED"),
		"targets":          []watchTargetRef{{Kind: "SESSION", ID: sessionID}},
		"action":           "RESUME_SESSION",
		"idempotencyKey":   sessionWaitWatchKeyPrefix + sessionID,
	}
}

// recordSessionWaitWatch records the watch behind a wait and returns its id.
func recordSessionWaitWatch(t *Transport, ctx cliOrchestrationContext, sessionID string) (string, error) {
	var raw json.RawMessage
	var err error
	for attempt := 1; ; attempt++ {
		raw, err = t.createWatch(ctx.sessionID, ctx.token, sessionWaitWatchBody(sessionID))
		if err == nil || !isRetryableTransportError(err) || attempt >= watchRecordAttempts {
			break
		}
		time.Sleep(watchRecordRetryInterval)
	}
	if err != nil {
		return "", err
	}
	if id := rawJSONID(raw); id != "" {
		return id, nil
	}
	return "", fmt.Errorf("the server answered without a watch id")
}

func handedBackWatch(watchID, why string, cause error) *sessionWaitWatch {
	watch := &sessionWaitWatch{
		ID:         watchID,
		HandedBack: why,
		Note: "Orbit's server keeps waiting: this watch starts a turn in the calling session when the new session's turn " +
			"settles, or once if the watch expires first. End the turn instead of polling for it.",
	}
	if cause != nil {
		watch.Error = cause.Error()
	}
	return watch
}

// releaseSessionWaitWatch takes back the watch behind a wait answered inline. It returns nil when nothing
// else will arrive, and otherwise what the caller has to know: a wake saying the same may still follow.
func releaseSessionWaitWatch(t *Transport, ctx cliOrchestrationContext, watchID string) *sessionWaitWatch {
	var receipt watchReleaseReceipt
	var err error
	for attempt := 1; ; attempt++ {
		receipt, err = t.releaseWatch(ctx.sessionID, ctx.token, watchID)
		if err != nil || receipt.Outcome != "WAKE_NOT_QUEUED" || attempt >= watchReleaseAttempts {
			break
		}
		time.Sleep(watchReleaseRetryInterval)
	}
	switch {
	case err != nil:
		return &sessionWaitWatch{ID: watchID, Error: err.Error(), Note: sessionWaitUnreleasedNote}
	case receipt.Outcome == "CANCELLED" || receipt.Outcome == "WAKE_WITHDRAWN" || receipt.Outcome == "NOTHING_OWED":
		return nil
	default:
		return &sessionWaitWatch{ID: watchID, Release: receipt.Outcome, Note: sessionWaitUnreleasedNote}
	}
}

// json is what `orbit session create --wait` prints: the session exactly as it always was when the wait
// ended cleanly, and otherwise that session with the watch beside it under "watch".
func (w sessionWait) json() json.RawMessage {
	if w.watch == nil {
		return w.session
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(w.session, &fields); err != nil || len(fields) == 0 {
		fields = map[string]json.RawMessage{"session": w.session}
	}
	encoded, err := json.Marshal(w.watch)
	if err != nil {
		return w.session
	}
	fields["watch"] = encoded
	out, err := json.Marshal(fields)
	if err != nil {
		return w.session
	}
	return out
}

// text is what session_create(wait) answers the model with.
func (w sessionWait) text() string {
	body := prettyJSON(w.json())
	switch {
	case w.watch != nil && w.watch.HandedBack != "":
		why := fmt.Sprintf("the %s wait ran out", w.budget)
		if w.watch.HandedBack == "TRANSPORT_ERROR" {
			why = "the Orbit server stopped answering (" + w.watch.Error + ")"
		}
		return fmt.Sprintf("Stopped waiting before session %s settled: %s. The wait is not lost: watch %s is held by "+
			"Orbit's server and starts a turn in this session when that session's turn settles, or once if the watch "+
			"expires first. End your turn now; do not poll session_get or sleep to wait for it.\n%s",
			w.sessionID, why, w.watch.ID, body)
	case w.unbacked():
		return body + "\n\n" + w.unbackedNote("session_get", "session_await")
	case w.watch != nil:
		return body + "\n\n" + w.watch.Note
	default:
		return body
	}
}

// unbacked reports a wait that ended before the session settled with no watch recorded behind it.
func (w sessionWait) unbacked() bool {
	return w.watch != nil && w.watch.ID == ""
}

// unbackedNote is what an unbacked wait tells its caller, in the words of the surface that waited: get and await
// name that surface's ways to look at the session again and to be woken when it settles.
func (w sessionWait) unbackedNote(get, await string) string {
	return "The session has not settled, and no server-held watch backs this wait (" + w.watch.Error +
		"): look at it again later with " + get + ", or call " + await + " to be woken when it settles."
}

// sessionRawSettled reads a session body's status the way sessionSettled judges it.
func sessionRawSettled(raw json.RawMessage) bool {
	var state struct {
		Status string `json:"status"`
	}
	return json.Unmarshal(raw, &state) == nil && sessionSettled(state.Status)
}

// rawJSONID is a response body's top-level id, or "" when it has none.
func rawJSONID(raw json.RawMessage) string {
	var handle struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &handle) != nil {
		return ""
	}
	return strings.TrimSpace(handle.ID)
}

// sessionWaitWatchRefused reports a control plane that answered the watch with a refusal (a quota, a
// permission), which asking again only repeats. A server without the watch door is not refusing: it
// predates watches, and the wait polls the way it always did.
func sessionWaitWatchRefused(err error) bool {
	return !isRetryableTransportError(err) && !watchDoorMissing(err)
}

// unbackedSessionWaitReason says why no watch backs a wait, on one line as the CLI says it inside one on stderr: a
// refusal gives its code and what it said, without the body repeating both. code is that refusal code, if any.
func unbackedSessionWaitReason(err error) (reason, code string) {
	failure := err.Error()
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) && httpErr.refusal() != "" {
		failure, code = httpErr.refusal(), httpErr.code()
	}
	failure = strings.Join(strings.Fields(failure), " ")
	switch {
	case watchDoorMissing(err):
		return "this Orbit server predates watches", code
	case sessionWaitWatchRefused(err):
		return "Orbit refused to record the watch, so the call did not wait: " + failure, code
	default:
		return "recording the watch failed: " + failure, code
	}
}
