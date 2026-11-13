package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The request ids a caller has to reuse to replay a write whose answer it never saw: task_start's
// triggerId, and the clientTurnId of session_send, session_interrupt with a message and
// project_send. The server answers a second delivery under the same id from the first one's receipt
// and refuses one id naming two payloads. That only helps a caller that KNOWS the id. So each
// logical call draws one when the caller named none, sends every attempt under it, and hands it
// back in the answer and in the error, together with the call that replays it.

// keyedResendCap is the longest a single wait between two attempts may be, whatever retryAfter
// asks for. Waits are capped and attempts are counted, so a call cannot hang on a long retryAfter.
// Once the attempts are spent the call fails and keeps its id.
const keyedResendCap = 5 * time.Second

// keyedResendSleep is time.Sleep. It is a variable only so tests can record the waits instead of
// sleeping through them.
var keyedResendSleep = time.Sleep

// callIDOrNew is the id the caller named, trimmed, or a freshly drawn one. A new logical call
// with no id always gets a new one, so two deliberate calls are never mistaken for one.
func callIDOrNew(given string) (string, error) {
	if id := strings.TrimSpace(given); id != "" {
		return id, nil
	}
	return newRunRequestToken()
}

// deliverKeyed sends one keyed request until it is answered. It resends only what resendable says
// left the request unanswered, at most runRequestResendAttempts times in all. Each wait is the
// backoff or the server's retryAfter, whichever is longer, capped at keyedResendCap. The id is in
// the request body, which is built once by the caller, so every attempt is the same request.
func deliverKeyed(send func() (json.RawMessage, error), resendable func(error) bool) (json.RawMessage, error) {
	var lastErr error
	for attempt := range runRequestResendAttempts {
		if attempt > 0 {
			keyedResendSleep(keyedResendWait(attempt, lastErr))
		}
		out, err := send()
		if err == nil {
			return out, nil
		}
		lastErr = err
		if !resendable(err) {
			return nil, err
		}
	}
	return nil, lastErr
}

// keyedResendWait is how long to wait before attempt (1-based resend number).
func keyedResendWait(attempt int, lastErr error) time.Duration {
	wait := runRequestResendDelay << (attempt - 1)
	if after := serverRetryAfter(lastErr); after > wait {
		wait = after
	}
	if wait > keyedResendCap {
		wait = keyedResendCap
	}
	return wait
}

// serverRetryAfter is the wait the server asked for (body retryAfterSeconds/retryAfterMs, or the
// Retry-After header), read through the recovery contract's parser, or 0 when it asked for none.
func serverRetryAfter(err error) time.Duration {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return 0
	}
	env := recoveryOf(err, true)
	if env.Retry.AfterSeconds == nil || *env.Retry.AfterSeconds <= 0 {
		return 0
	}
	return time.Duration(*env.Retry.AfterSeconds) * time.Second
}

// isUnansweredSessionWrite says whether a keyed session message got no answer that settles it:
// no HTTP answer at all (the write may have committed), or a gateway or overload status that
// never reached a verdict. Any other answer IS the verdict, and sending it again only repeats it.
func isUnansweredSessionWrite(err error) bool {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return true
	}
	switch httpErr.statusCode {
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// withCallID returns raw with field set to id when raw is a JSON object that does not carry the
// field already. The server's receipts for these doors do not echo the key, and the caller needs it
// to replay. Anything that is not an object comes back unchanged.
func withCallID(raw json.RawMessage, field, id string) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return raw
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(trimmed, &fields) != nil {
		return raw
	}
	if _, present := fields[field]; present {
		return raw
	}
	head := `{` + strconv.Quote(field) + `:` + strconv.Quote(id)
	rest := bytes.TrimSpace(trimmed[1:])
	if len(rest) > 0 && rest[0] != '}' {
		head += ","
	}
	return json.RawMessage(head + string(rest))
}

// replayableCallError is a keyed call that failed. It keeps the error the call got, unchanged and
// first, and adds the id and what to do with it.
type replayableCallError struct {
	err error
	// field is "triggerId" or "clientTurnId", and id its value.
	field, id string
	// unanswered says the outcome is unknown or still being answered, so the call must be replayed
	// under the same id. Otherwise the server answered, and a new attempt is a new call.
	unanswered bool
	// replay is the exact call that replays this one; fresh is how to make a new one.
	replay, fresh string
}

func (e *replayableCallError) Error() string {
	text := e.err.Error() + "\n  " + e.field + ": " + e.id + "\n"
	if e.unanswered {
		return text + "  replay:  the outcome is not known yet. Replay with the SAME " + e.field +
			", never a new one: " + e.replay + ". The server answers a replay from the first " +
			"delivery, so it never acts twice.\n"
	}
	return text + "  next:    the server answered this request, so replaying it returns the same answer. " +
		"Once what it names has changed, make a new request: " + e.fresh + ".\n"
}

func (e *replayableCallError) Unwrap() error { return e.err }

// taskStartReplayError wraps a failed task_start with its triggerId. mcp says which surface the
// replay is written for.
func taskStartReplayError(err error, mcp bool, taskID, triggerID string) error {
	replay := `task_start {"taskId":` + strconv.Quote(taskID) + `,"triggerId":` + strconv.Quote(triggerID) + `}`
	fresh := "task_start without triggerId"
	if !mcp {
		replay = "orbit task start " + taskID + " --trigger-id " + triggerID
		fresh = "orbit task start " + taskID + " without --trigger-id"
	}
	return &replayableCallError{err: err, field: "triggerId", id: triggerID,
		unanswered: isResendableRunFailure(err), replay: replay, fresh: fresh}
}

// messageReplayError wraps a failed keyed message with its clientTurnId. tool is the MCP tool or
// CLI command, and target names the field and value that address it. The message itself is never
// copied into the replay: the caller still has it, and a command line built from user text is
// unsafe.
func messageReplayError(err error, mcp bool, tool, targetField, target, clientTurnID string) error {
	var replay, fresh string
	if mcp {
		replay = tool + ` with the same message, ` + targetField + ` ` + strconv.Quote(target) +
			` and "clientTurnId":` + strconv.Quote(clientTurnID)
		fresh = tool + " without clientTurnId"
	} else {
		replay = tool + " " + target + " with the same message and --client-turn-id " + clientTurnID
		fresh = tool + " without --client-turn-id"
	}
	return &replayableCallError{err: err, field: "clientTurnId", id: clientTurnID,
		unanswered: isUnansweredSessionWrite(err), replay: replay, fresh: fresh}
}
