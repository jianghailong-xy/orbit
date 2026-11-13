package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
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

// What a failed keyed call tells its caller to do next. The decision is the recovery contract's
// (recoveryOf, normalized with the request id present), never the auto-resend predicate: which
// failures this call resent on its own is one question, what the caller may do after it gave up is
// another, and a failure that might have written must never be answered with "make a new request".
const (
	// replayGuidance: the write may have happened, or the server asked for the same id. Replay under
	// the SAME id; the server answers it from the first delivery.
	replayGuidance = iota
	// verifyGuidance: the outcome is unknown and the contract says verify first. Read the state;
	// if the write is not there, replay under the SAME id.
	verifyGuidance
	// committedGuidance: the write stands. Do not send it again.
	committedGuidance
	// freshGuidance: the server answered and nothing was written (a mismatch, or a refusal that
	// holds until something changes). A later attempt is a new request without the id.
	freshGuidance
)

// callGuidance reads the failure through the recovery contract.
func callGuidance(err error) int {
	env := recoveryOf(err, true)
	switch {
	case env.Effect == "COMMITTED":
		return committedGuidance
	case env.Retry.Policy == "VERIFY_THEN_RETRY":
		return verifyGuidance
	case env.Effect != "NONE", env.Retry.Policy == "SAME_REQUEST_ID", env.Retry.Policy == "SAFE":
		// UNKNOWN (no answer, a gateway page, a plain 5xx, a server that says so), the server's
		// own "ask again with this id", and a refusal that wrote nothing and may simply be sent
		// again: in every case the same logical request, so the same id.
		return replayGuidance
	}
	return freshGuidance
}

// replayableCallError is a keyed call that failed. It keeps the error the call got, unchanged and
// first, and adds the id and what to do with it.
type replayableCallError struct {
	err error
	// field is "triggerId" or "clientTurnId", and id its value.
	field, id string
	guidance  int
	// replay is the exact call that replays this one; fresh is how to make a new one.
	replay, fresh string
}

func (e *replayableCallError) Error() string {
	text := e.err.Error() + "\n  " + e.field + ": " + e.id + "\n"
	switch e.guidance {
	case verifyGuidance:
		return text + "  replay:  the outcome is not known. Check whether it took effect; if it did not, replay with " +
			"the SAME " + e.field + ", never a new one: " + e.replay + ". The server answers a replay from the " +
			"first delivery, so it never acts twice.\n"
	case committedGuidance:
		return text + "  next:    the server recorded this request. Do not send it again.\n"
	case freshGuidance:
		return text + "  next:    the server answered this request and nothing was written, so replaying it returns " +
			"the same answer. Once what it names has changed, make a new request: " + e.fresh + ".\n"
	}
	return text + "  replay:  the outcome is not known yet. Replay with the SAME " + e.field +
		", never a new one: " + e.replay + ". The server answers a replay from the first " +
		"delivery, so it never acts twice.\n"
}

func (e *replayableCallError) Unwrap() error { return e.err }

// jsonText is v as JSON: every value a caller may have supplied is quoted by the encoder, never
// pasted into the text.
func jsonText(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `"<unencodable>"`
	}
	return string(b)
}

// cliArgv is a command line as an argv array in JSON, run as written with no shell: argv[0] is this
// binary's own path, then the words of the command. Nothing in it is ever re-parsed by a shell, so
// an id or a target the caller supplied cannot become a second command.
func cliArgv(words ...string) string {
	exe := "orbit"
	if path, err := os.Executable(); err == nil && path != "" {
		exe = path
	}
	return "argv " + jsonText(append([]string{exe}, words...))
}

// taskStartReplayError wraps a failed task_start with its triggerId. mcp says which surface the
// replay is written for.
func taskStartReplayError(err error, mcp bool, taskID, triggerID string) error {
	replay := "task_start " + jsonText(map[string]string{"taskId": taskID, "triggerId": triggerID})
	fresh := "task_start " + jsonText(map[string]string{"taskId": taskID}) + " (without triggerId)"
	if !mcp {
		replay = cliArgv("task", "start", taskID, "--trigger-id", triggerID)
		fresh = cliArgv("task", "start", taskID) + " (without --trigger-id)"
	}
	return &replayableCallError{err: err, field: "triggerId", id: triggerID,
		guidance: callGuidance(err), replay: replay, fresh: fresh}
}

// messageReplayError wraps a failed keyed message with its clientTurnId. For MCP, tool is the tool
// and targetField names the argument that addresses it; for the CLI, tool is the command ("orbit
// session send"). The message itself is never copied into the replay: the caller still has it, and
// the CLI form reads it from stdin.
func messageReplayError(err error, mcp bool, tool, targetField, target, clientTurnID string) error {
	var replay, fresh string
	if mcp {
		replay = tool + " " + jsonText(map[string]string{targetField: target, "clientTurnId": clientTurnID}) +
			` plus the same "message"`
		fresh = tool + " " + jsonText(map[string]string{targetField: target}) + ` plus the "message" (without clientTurnId)`
	} else {
		words := append(strings.Fields(tool)[1:], target, "--message-file", "-")
		replay = cliArgv(append(words, "--client-turn-id", clientTurnID)...) + ", with the same message on stdin"
		fresh = cliArgv(words...) + ", with the message on stdin (without --client-turn-id)"
	}
	return &replayableCallError{err: err, field: "clientTurnId", id: clientTurnID,
		guidance: callGuidance(err), replay: replay, fresh: fresh}
}
