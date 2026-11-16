package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// keyedDoor is a control plane door that behaves like the real one for a keyed write: the first
// delivery under an id applies the effect once and files a receipt; a later delivery under the same
// id with the same payload reads the receipt back; the same id with a different payload is a 409
// mismatch. Faults are injected per delivery, AFTER the effect, so a lost answer is a committed
// write the caller never heard about.
type keyedDoor struct {
	t        *testing.T
	idField  string
	mismatch string // the code (or message) a reused id with another payload answers

	mu         sync.Mutex
	deliveries []map[string]interface{}
	receipts   map[string]string // id -> payload digest
	effects    int
	// loseAnswers drops the answer of this many deliveries (the connection dies after the commit).
	loseAnswers int
	// inProgress answers this many deliveries "being answered right now" before any effect.
	inProgress int
	// inProgressBody is that answer's body.
	inProgressBody string
	// failAfterCommit answers this many deliveries with failStatus/failBody AFTER applying the
	// effect: a server that wrote and then failed to say so.
	failAfterCommit int
	failStatus      int
	failBody        string
	srv             *httptest.Server
}

func newKeyedDoor(t *testing.T, idField, mismatch string) *keyedDoor {
	d := &keyedDoor{t: t, idField: idField, mismatch: mismatch, receipts: map[string]string{}}
	d.srv = httptest.NewServer(http.HandlerFunc(d.serve))
	t.Cleanup(d.srv.Close)
	return d
}

func (d *keyedDoor) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	body := map[string]interface{}{}
	_ = json.Unmarshal(raw, &body)
	d.mu.Lock()
	d.deliveries = append(d.deliveries, body)
	n := len(d.deliveries)
	if n <= d.inProgress {
		d.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(d.inProgressBody))
		return
	}
	id, _ := body[d.idField].(string)
	payload := string(raw)
	if id != "" {
		rest := map[string]interface{}{}
		for k, v := range body {
			if k != d.idField {
				rest[k] = v
			}
		}
		canon, _ := json.Marshal(rest)
		payload = string(canon)
	}
	answer := `{"ok":true,"turnId":"turn-1","sessionId":"s1"}`
	if prior, seen := d.receipts[id]; id != "" && seen {
		if prior != payload {
			d.mu.Unlock()
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(d.mismatch))
			return
		}
	} else {
		d.effects++
		if id != "" {
			d.receipts[id] = payload
		}
	}
	lose := d.loseAnswers > 0
	if lose {
		d.loseAnswers--
	}
	fail := d.failAfterCommit > 0
	if fail {
		d.failAfterCommit--
	}
	d.mu.Unlock()
	if fail {
		w.WriteHeader(d.failStatus)
		_, _ = w.Write([]byte(d.failBody))
		return
	}
	if lose {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
		return
	}
	_, _ = w.Write([]byte(answer))
}

func (d *keyedDoor) ids() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []string
	for _, b := range d.deliveries {
		id, _ := b[d.idField].(string)
		out = append(out, id)
	}
	return out
}

func (d *keyedDoor) effectCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.effects
}

// recordWaits replaces the resend sleep with a recorder, so the bounded retry is checked by the
// waits it asked for rather than by wall-clock time.
func recordWaits(t *testing.T) *[]time.Duration {
	t.Helper()
	var waits []time.Duration
	var mu sync.Mutex
	prev := keyedResendSleep
	keyedResendSleep = func(d time.Duration) {
		mu.Lock()
		waits = append(waits, d)
		mu.Unlock()
	}
	t.Cleanup(func() { keyedResendSleep = prev })
	return &waits
}

func allSame(t *testing.T, ids []string) string {
	t.Helper()
	if len(ids) == 0 {
		t.Fatalf("nothing was delivered")
	}
	for i, id := range ids {
		if id == "" {
			t.Fatalf("delivery %d carried no id: %v", i, ids)
		}
		if id != ids[0] {
			t.Fatalf("one logical call carried two ids: %v", ids)
		}
	}
	return ids[0]
}

var errorIDLine = regexp.MustCompile(`(?m)^  (triggerId|clientTurnId): ("(?:[^"\\]|\\.)*")$`)

// idFromError is what an agent does with the error: read the id line, nothing else.
func idFromError(t *testing.T, text, field string) string {
	t.Helper()
	m := errorIDLine.FindStringSubmatch(text)
	if m == nil || m[1] != field {
		t.Fatalf("the error names no %s:\n%s", field, text)
	}
	var id string
	if err := json.Unmarshal([]byte(m[2]), &id); err != nil {
		t.Fatalf("the %s line is not one JSON string: %v\n%s", field, err, text)
	}
	return id
}

const runMismatchBody = `{"statusCode":409,"code":"TASK_RUN_REQUEST_MISMATCH","message":"this run request id has already been used for a different request"}`
const turnMismatchBody = `{"statusCode":409,"message":"clientTurnId was already used with a different interrupt follow-up payload","error":"Conflict"}`

// ---- task_start ----------------------------------------------------------------------------

func TestMCPTaskStartLostAnswerExhaustedKeepsTheIDAndItsReplayStartsOnce(t *testing.T) {
	waits := recordWaits(t)
	door := newKeyedDoor(t, "triggerId", runMismatchBody)
	door.loseAnswers = runRequestResendAttempts // every answer of the first call is lost
	mcp := &mcpServer{taskID: "t1", t: NewTransport(door.srv.URL, "tok")}

	res := mcp.callTool("task_start", map[string]interface{}{})
	if res["isError"] != true {
		t.Fatalf("a call that never got an answer reported success")
	}
	first := allSame(t, door.ids())
	if got := len(door.ids()); got != runRequestResendAttempts {
		t.Fatalf("sent %d deliveries, want the bound %d", got, runRequestResendAttempts)
	}
	if len(*waits) != runRequestResendAttempts-1 {
		t.Fatalf("waited %d times, want %d", len(*waits), runRequestResendAttempts-1)
	}
	text := resultText(res)
	id := idFromError(t, text, "triggerId")
	if id != first {
		t.Fatalf("the error names %q, the wire carried %q", id, first)
	}
	wantReplay := `task_start {"taskId":"t1","triggerId":"` + id + `"}`
	if !strings.Contains(text, wantReplay) || !strings.Contains(text, "SAME triggerId") {
		t.Fatalf("the error does not hand back the replay %s:\n%s", wantReplay, text)
	}

	// The agent replays exactly what it was handed.
	res = mcp.callTool("task_start", map[string]interface{}{"taskId": "t1", "triggerId": id})
	if res["isError"] == true {
		t.Fatalf("the replay failed: %s", resultText(res))
	}
	var answer map[string]interface{}
	if err := json.Unmarshal([]byte(resultText(res)), &answer); err != nil || answer["triggerId"] != id {
		t.Fatalf("the replay's answer does not carry its triggerId: %s", resultText(res))
	}
	allSame(t, door.ids())
	if door.effectCount() != 1 {
		t.Fatalf("one triggerId started %d runs", door.effectCount())
	}
}

func TestTaskStartInProgressWaitsForRetryAfterAndStopsAtTheBound(t *testing.T) {
	waits := recordWaits(t)
	door := newKeyedDoor(t, "triggerId", runMismatchBody)
	door.inProgress = 99
	door.inProgressBody = `{"statusCode":409,"code":"TASK_RUN_REQUEST_IN_PROGRESS","message":"being answered",` +
		`"triggerId":"x","retryAfterSeconds":2}`
	mcp := &mcpServer{taskID: "t1", t: NewTransport(door.srv.URL, "tok")}

	res := mcp.callTool("task_start", map[string]interface{}{})

	if res["isError"] != true {
		t.Fatalf("an unread answer was reported as success")
	}
	// Bounded: exactly the attempts, all under one id, and no new request after them.
	if got := len(door.ids()); got != runRequestResendAttempts {
		t.Fatalf("sent %d deliveries, want %d", got, runRequestResendAttempts)
	}
	first := allSame(t, door.ids())
	for i, w := range *waits {
		if w < 2*time.Second {
			t.Fatalf("wait %d was %v, shorter than the server's retryAfter", i, w)
		}
		if w > keyedResendCap {
			t.Fatalf("wait %d was %v, past the cap", i, w)
		}
	}
	text := resultText(res)
	if !strings.Contains(text, taskRunRequestInProgress) {
		t.Fatalf("the server's own refusal is gone:\n%s", text)
	}
	if id := idFromError(t, text, "triggerId"); id != first {
		t.Fatalf("the error names %q, the wire carried %q", id, first)
	}
	if door.effectCount() != 0 {
		t.Fatalf("IN_PROGRESS deliveries applied %d effects", door.effectCount())
	}

	// Once the first delivery's answer is ready, replaying the id reads it back.
	door.mu.Lock()
	door.inProgress = 0
	door.mu.Unlock()
	res = mcp.callTool("task_start", map[string]interface{}{"triggerId": first})
	if res["isError"] == true {
		t.Fatalf("replay failed: %s", resultText(res))
	}
	allSame(t, door.ids())
	if door.effectCount() != 1 {
		t.Fatalf("effects = %d, want 1", door.effectCount())
	}
}

func TestTaskStartMismatchIsAnsweredNotReplayed(t *testing.T) {
	recordWaits(t)
	door := newKeyedDoor(t, "triggerId", runMismatchBody)
	door.receipts["341DOGTVEs0Fk0gAn1mje"] = "some other request"
	mcp := &mcpServer{taskID: "t1", t: NewTransport(door.srv.URL, "tok")}

	res := mcp.callTool("task_start", map[string]interface{}{"triggerId": "341DOGTVEs0Fk0gAn1mje"})

	if res["isError"] != true {
		t.Fatalf("a mismatch was reported as success")
	}
	if len(door.ids()) != 1 {
		t.Fatalf("a mismatch was resent: %v", door.ids())
	}
	text := resultText(res)
	if !strings.Contains(text, "TASK_RUN_REQUEST_MISMATCH") || strings.Contains(text, "replay:") ||
		!strings.Contains(text, `task_start {"taskId":"t1"} (without triggerId)`) {
		t.Fatalf("a mismatch must say: answered, make a new request:\n%s", text)
	}
	if door.effectCount() != 0 {
		t.Fatalf("one id named two runs")
	}
}

func TestMCPTaskStartNewCallsStillDrawNewIDs(t *testing.T) {
	door := newKeyedDoor(t, "triggerId", runMismatchBody)
	mcp := &mcpServer{taskID: "t1", t: NewTransport(door.srv.URL, "tok")}

	for range 2 {
		if res := mcp.callTool("task_start", map[string]interface{}{}); res["isError"] == true {
			t.Fatal(resultText(res))
		}
	}
	if ids := door.ids(); len(ids) != 2 || ids[0] == ids[1] || ids[0] == "" {
		t.Fatalf("two new calls must carry two ids: %v", ids)
	}
}

func TestTaskCLIStartReplaysWithTriggerIDAndNamesItInTheError(t *testing.T) {
	recordWaits(t)
	door := newKeyedDoor(t, "triggerId", runMismatchBody)
	door.loseAnswers = runRequestResendAttempts
	configureCLITestRunner(t, door.srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"start", "task-1", "--json"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatalf("a lost answer was reported as success")
	}
	id := idFromError(t, err.Error(), "triggerId")
	if !strings.Contains(err.Error(), `"task","start","task-1","--trigger-id","`+id+`"]`) {
		t.Fatalf("the CLI error does not hand back its replay:\n%v", err)
	}

	out.Reset()
	if err := cmdTaskCLI([]string{"start", "task-1", "--trigger-id", id, "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"triggerId":"`+id+`"`) {
		t.Fatalf("the answer does not carry the triggerId: %s", out.String())
	}
	if allSame(t, door.ids()) != id || door.effectCount() != 1 {
		t.Fatalf("ids %v, effects %d", door.ids(), door.effectCount())
	}
}

// ---- session_send / session_interrupt / project_send --------------------------------------

func keyedOrchestratingMCP(url string) *mcpServer {
	return &mcpServer{sessionID: "parent", orchestrationToken: "tok", allowOrchestration: true,
		t: NewTransport(url, "runner-secret")}
}

func TestMCPSessionSendDrawsAKeyResendsUnderItAndReturnsIt(t *testing.T) {
	recordWaits(t)
	door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
	door.loseAnswers = 2
	mcp := keyedOrchestratingMCP(door.srv.URL)

	res := mcp.callTool("session_send", map[string]interface{}{"sessionId": "child", "message": "hi"})

	if res["isError"] == true {
		t.Fatalf("lost answers were not resent: %s", resultText(res))
	}
	key := allSame(t, door.ids())
	if len(door.ids()) != 3 || door.effectCount() != 1 {
		t.Fatalf("deliveries %v, effects %d", door.ids(), door.effectCount())
	}
	var answer map[string]interface{}
	if err := json.Unmarshal([]byte(resultText(res)), &answer); err != nil || answer["clientTurnId"] != key {
		t.Fatalf("the answer does not return the key %q: %s", key, resultText(res))
	}
	// A new logical call is a new message.
	mcp.callTool("session_send", map[string]interface{}{"sessionId": "child", "message": "hi"})
	if ids := door.ids(); ids[len(ids)-1] == key {
		t.Fatalf("a new call reused the previous key")
	}
	if door.effectCount() != 2 {
		t.Fatalf("effects = %d, want 2", door.effectCount())
	}
}

func TestMCPSessionSendExhaustedNamesTheKeyAndItsReplayDeliversOnce(t *testing.T) {
	waits := recordWaits(t)
	door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
	door.loseAnswers = runRequestResendAttempts
	mcp := keyedOrchestratingMCP(door.srv.URL)

	res := mcp.callTool("session_send", map[string]interface{}{"sessionId": "child", "message": "hi"})
	if res["isError"] != true {
		t.Fatalf("no answer was reported as success")
	}
	if len(door.ids()) != runRequestResendAttempts || len(*waits) != runRequestResendAttempts-1 {
		t.Fatalf("not bounded: %d deliveries, %d waits", len(door.ids()), len(*waits))
	}
	text := resultText(res)
	key := idFromError(t, text, "clientTurnId")
	if key != allSame(t, door.ids()) || !strings.Contains(text, `"clientTurnId":"`+key+`"`) ||
		!strings.Contains(text, "SAME clientTurnId") {
		t.Fatalf("the error does not hand back the replay:\n%s", text)
	}
	if strings.Contains(text, `"hi"`) {
		t.Fatalf("the replay copied the message text:\n%s", text)
	}

	res = mcp.callTool("session_send", map[string]interface{}{"sessionId": "child", "message": "hi", "clientTurnId": key})
	if res["isError"] == true {
		t.Fatalf("replay failed: %s", resultText(res))
	}
	allSame(t, door.ids())
	if door.effectCount() != 1 {
		t.Fatalf("one key filed %d messages", door.effectCount())
	}
}

func TestMCPSessionSendConcurrentDeliveriesOfOneKeyFileOneMessage(t *testing.T) {
	door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
	mcp := keyedOrchestratingMCP(door.srv.URL)

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if res := mcp.callTool("session_send", map[string]interface{}{
				"sessionId": "child", "message": "hi", "clientTurnId": "key-1",
			}); res["isError"] == true {
				t.Errorf("concurrent replay failed: %s", resultText(res))
			}
		}()
	}
	wg.Wait()
	if allSame(t, door.ids()) != "key-1" || door.effectCount() != 1 {
		t.Fatalf("ids %v, effects %d", door.ids(), door.effectCount())
	}
}

func TestMCPSessionInterruptWithMessageIsKeyedAndPlainIsNot(t *testing.T) {
	recordWaits(t)
	door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
	door.loseAnswers = runRequestResendAttempts
	mcp := keyedOrchestratingMCP(door.srv.URL)

	res := mcp.callTool("session_interrupt", map[string]interface{}{"sessionId": "child", "message": "stop; do X"})
	if res["isError"] != true {
		t.Fatalf("no answer was reported as success")
	}
	text := resultText(res)
	key := idFromError(t, text, "clientTurnId")
	if key != allSame(t, door.ids()) || !strings.Contains(text, `session_interrupt {"clientTurnId":"`+key+`","sessionId":"child"} plus the same "message"`) {
		t.Fatalf("the error does not hand back the replay:\n%s", text)
	}
	res = mcp.callTool("session_interrupt", map[string]interface{}{"sessionId": "child", "message": "stop; do X", "clientTurnId": key})
	if res["isError"] == true {
		t.Fatalf("replay failed: %s", resultText(res))
	}
	if door.effectCount() != 1 {
		t.Fatalf("one key interrupted %d times", door.effectCount())
	}

	// The same key with another follow-up is the server's mismatch: answered, never resent.
	before := len(door.ids())
	res = mcp.callTool("session_interrupt", map[string]interface{}{"sessionId": "child", "message": "something else", "clientTurnId": key})
	if res["isError"] != true || len(door.ids()) != before+1 {
		t.Fatalf("a mismatch was resent or accepted: %v", door.ids()[before:])
	}
	if text := resultText(res); strings.Contains(text, "replay:") || !strings.Contains(text, "without clientTurnId") {
		t.Fatalf("a mismatch must say: answered, make a new request:\n%s", text)
	}

	// A plain interrupt: no body, no key, one delivery.
	var bodies []string
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(raw))
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer plain.Close()
	if res := keyedOrchestratingMCP(plain.URL).callTool("session_interrupt", map[string]interface{}{"sessionId": "child"}); res["isError"] == true {
		t.Fatal(resultText(res))
	}
	if len(bodies) != 1 || bodies[0] != "" {
		t.Fatalf("a plain interrupt sent %q", bodies)
	}
}

func TestMCPProjectSendIsKeyedAndNotResent(t *testing.T) {
	door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
	door.loseAnswers = 1
	mcp := keyedOrchestratingMCP(door.srv.URL)

	res := mcp.callTool("project_send", map[string]interface{}{"projectId": "p1", "message": "hi"})
	if res["isError"] != true || len(door.ids()) != 1 {
		t.Fatalf("project_send must not resend on its own: %v", door.ids())
	}
	text := resultText(res)
	key := idFromError(t, text, "clientTurnId")
	if key != door.ids()[0] || !strings.Contains(text, `project_send {"clientTurnId":"`+key+`","projectId":"p1"} plus the same "message"`) {
		t.Fatalf("the error does not hand back the replay:\n%s", text)
	}
	res = mcp.callTool("project_send", map[string]interface{}{"projectId": "p1", "message": "hi", "clientTurnId": key})
	if res["isError"] == true || door.effectCount() != 1 {
		t.Fatalf("replay: %s, effects %d", resultText(res), door.effectCount())
	}
}

func TestSessionCLISendAndInterruptAreKeyedAndNameTheKeyInTheError(t *testing.T) {
	recordWaits(t)
	for _, verb := range []string{"send", "interrupt"} {
		t.Run(verb, func(t *testing.T) {
			door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
			door.loseAnswers = runRequestResendAttempts
			configureCLITestRunner(t, door.srv.URL)
			t.Setenv(envMCPOrchestration, "true")
			t.Setenv("ORBIT_SESSION_ID", "parent-session")
			t.Setenv(envOrchestrationToken, "session-token")

			var out bytes.Buffer
			err := cmdSessionCLI([]string{verb, "child", "--message", "do X", "--json"}, strings.NewReader(""), &out)
			if err == nil {
				t.Fatalf("no answer was reported as success")
			}
			key := idFromError(t, err.Error(), "clientTurnId")
			if key != allSame(t, door.ids()) ||
				!strings.Contains(err.Error(), `"session","`+verb+`","child","--message-file","-","--client-turn-id","`+key+`"], with the same message on stdin`) {
				t.Fatalf("the error does not hand back the replay:\n%v", err)
			}
			if len(door.ids()) != runRequestResendAttempts {
				t.Fatalf("not bounded: %v", door.ids())
			}

			out.Reset()
			if err := cmdSessionCLI([]string{verb, "child", "--message", "do X", "--client-turn-id", key, "--json"}, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), `"clientTurnId":"`+key+`"`) || door.effectCount() != 1 {
				t.Fatalf("answer %s, effects %d", out.String(), door.effectCount())
			}
		})
	}
}

// ---- helpers -------------------------------------------------------------------------------

func TestKeyedResendWaitHonoursRetryAfterUnderTheCap(t *testing.T) {
	inProgress := func(after string) error {
		return &transportHTTPError{statusCode: http.StatusConflict,
			body: `{"code":"TASK_RUN_REQUEST_IN_PROGRESS","retryAfterSeconds":` + after + `}`}
	}
	if got := keyedResendWait(1, inProgress("2")); got != 2*time.Second {
		t.Fatalf("retryAfter 2s waited %v", got)
	}
	if got := keyedResendWait(1, inProgress("600")); got != keyedResendCap {
		t.Fatalf("retryAfter 600s waited %v, want the cap", got)
	}
	if got := keyedResendWait(3, io.ErrUnexpectedEOF); got != runRequestResendDelay<<2 {
		t.Fatalf("no retryAfter waited %v", got)
	}
}

func TestWithCallIDAddsTheKeyOnlyWhereMissing(t *testing.T) {
	for in, want := range map[string]string{
		`{"ok":true}`:               `{"clientTurnId":"k","ok":true}`,
		`{}`:                        `{"clientTurnId":"k"}`,
		`{"clientTurnId":"server"}`: `{"clientTurnId":"server"}`,
		`[1]`:                       `[1]`,
		``:                          ``,
	} {
		if got := string(withCallID(json.RawMessage(in), "clientTurnId", "k")); got != want {
			t.Errorf("withCallID(%s) = %s, want %s", in, got, want)
		}
	}
}

// takeDrawnKey removes the clientTurnId the runner drew for a call that named none, failing when
// there is none. A drawn key is a Base62 public id; a key the caller named (such as "key-1") is
// left in place, so the wire tests still pin that it is passed through unchanged.
func takeDrawnKey(t *testing.T, body map[string]interface{}) string {
	t.Helper()
	key, _ := body["clientTurnId"].(string)
	if key == "" || !uuidRE.MatchString(decodeSessionID(key)) {
		if key == "" {
			t.Fatalf("no clientTurnId was drawn for %#v", body)
		}
		return ""
	}
	delete(body, "clientTurnId")
	return key
}

// stripEchoedCallID removes the id withCallID put at the front of a printed answer, when it is the
// id the request carried.
func stripEchoedCallID(out, requestBody string) string {
	var sent map[string]interface{}
	_ = json.Unmarshal([]byte(requestBody), &sent)
	out = strings.TrimSpace(out)
	for _, field := range []string{"triggerId", "clientTurnId"} {
		id, _ := sent[field].(string)
		if prefix := `{"` + field + `":"` + id + `",`; id != "" && strings.HasPrefix(out, prefix) {
			return "{" + strings.TrimPrefix(out, prefix)
		}
	}
	return out
}

// ---- a failure that may have written is never answered with "make a new request" -------------

// committedThenFailed are server answers that come AFTER the write committed (or might have): the
// contract reads each as an unknown outcome, so the only safe next step is the same id again.
var committedThenFailed = []struct {
	name, body string
	status     int
}{
	{"gateway 502", `<html><body>502 Bad Gateway</body></html>`, http.StatusBadGateway},
	{"gateway 504", `<html><body>504 Gateway Time-out</body></html>`, http.StatusGatewayTimeout},
	{"plain 500", `{"statusCode":500,"message":"Internal server error"}`, http.StatusInternalServerError},
	{"500 not retryable", `{"statusCode":500,"message":"Internal server error","retryable":false}`, http.StatusInternalServerError},
	{"explicit UNKNOWN", `{"statusCode":409,"code":"SOMETHING_HAPPENED","message":"x","recovery":{"effect":"UNKNOWN"}}`, http.StatusConflict},
	{"explicit SAME_REQUEST_ID", `{"statusCode":409,"code":"SOMETHING_HAPPENED","message":"x","recovery":{"effect":"UNKNOWN","retryPolicy":"SAME_REQUEST_ID"}}`, http.StatusConflict},
}

func assertSameIDGuidance(t *testing.T, text, field, id string) {
	t.Helper()
	if got := idFromError(t, text, field); got != id {
		t.Fatalf("the error names %q, the wire carried %q:\n%s", got, id, text)
	}
	if strings.Contains(text, "without") || strings.Contains(text, "next:") {
		t.Fatalf("a failure that may have written was answered with a new request:\n%s", text)
	}
	if !strings.Contains(text, "replay:") || !strings.Contains(text, "SAME "+field) ||
		!strings.Contains(text, `"`+id+`"`) {
		t.Fatalf("the error does not hand back a replay under the same %s:\n%s", field, text)
	}
}

func TestTaskStartFailureThatMayHaveWrittenKeepsTheIDOnBothSurfaces(t *testing.T) {
	recordWaits(t)
	for _, tc := range committedThenFailed {
		t.Run("mcp "+tc.name, func(t *testing.T) {
			door := newKeyedDoor(t, "triggerId", runMismatchBody)
			door.failAfterCommit, door.failStatus, door.failBody = 99, tc.status, tc.body
			mcp := &mcpServer{taskID: "t1", t: NewTransport(door.srv.URL, "tok")}

			res := mcp.callTool("task_start", map[string]interface{}{})
			if res["isError"] != true {
				t.Fatalf("a failed start reported success")
			}
			id := allSame(t, door.ids())
			assertSameIDGuidance(t, resultText(res), "triggerId", id)

			door.mu.Lock()
			door.failAfterCommit = 0
			door.mu.Unlock()
			if res := mcp.callTool("task_start", map[string]interface{}{"triggerId": id}); res["isError"] == true {
				t.Fatalf("the replay failed: %s", resultText(res))
			}
			if allSame(t, door.ids()) != id || door.effectCount() != 1 {
				t.Fatalf("ids %v, effects %d", door.ids(), door.effectCount())
			}
		})
		t.Run("cli "+tc.name, func(t *testing.T) {
			door := newKeyedDoor(t, "triggerId", runMismatchBody)
			door.failAfterCommit, door.failStatus, door.failBody = 99, tc.status, tc.body
			configureCLITestRunner(t, door.srv.URL)

			var out bytes.Buffer
			err := cmdTaskCLI([]string{"start", "task-1", "--json"}, strings.NewReader(""), &out)
			if err == nil {
				t.Fatalf("a failed start reported success")
			}
			id := allSame(t, door.ids())
			assertSameIDGuidance(t, err.Error(), "triggerId", id)
			if !strings.Contains(err.Error(), `"task","start","task-1","--trigger-id","`+id+`"]`) {
				t.Fatalf("the CLI replay is not an argv:\n%v", err)
			}

			door.mu.Lock()
			door.failAfterCommit = 0
			door.mu.Unlock()
			if err := cmdTaskCLI([]string{"start", "task-1", "--trigger-id", id, "--json"}, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if allSame(t, door.ids()) != id || door.effectCount() != 1 {
				t.Fatalf("ids %v, effects %d", door.ids(), door.effectCount())
			}
		})
	}
}

func TestSessionMessageFailureThatMayHaveWrittenKeepsTheKeyOnBothSurfaces(t *testing.T) {
	recordWaits(t)
	for _, tool := range []string{"session_send", "session_interrupt"} {
		verb := map[string]string{"session_send": "send", "session_interrupt": "interrupt"}[tool]
		for _, tc := range committedThenFailed {
			t.Run("mcp "+tool+" "+tc.name, func(t *testing.T) {
				door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
				door.failAfterCommit, door.failStatus, door.failBody = 99, tc.status, tc.body
				mcp := keyedOrchestratingMCP(door.srv.URL)

				res := mcp.callTool(tool, map[string]interface{}{"sessionId": "child", "message": "do X"})
				if res["isError"] != true {
					t.Fatalf("a failed %s reported success", tool)
				}
				key := allSame(t, door.ids())
				assertSameIDGuidance(t, resultText(res), "clientTurnId", key)

				door.mu.Lock()
				door.failAfterCommit = 0
				door.mu.Unlock()
				if res := mcp.callTool(tool, map[string]interface{}{"sessionId": "child", "message": "do X", "clientTurnId": key}); res["isError"] == true {
					t.Fatalf("the replay failed: %s", resultText(res))
				}
				if allSame(t, door.ids()) != key || door.effectCount() != 1 {
					t.Fatalf("ids %v, effects %d", door.ids(), door.effectCount())
				}
			})
			t.Run("cli "+tool+" "+tc.name, func(t *testing.T) {
				door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
				door.failAfterCommit, door.failStatus, door.failBody = 99, tc.status, tc.body
				configureCLITestRunner(t, door.srv.URL)
				t.Setenv(envMCPOrchestration, "true")
				t.Setenv("ORBIT_SESSION_ID", "parent-session")
				t.Setenv(envOrchestrationToken, "session-token")

				var out bytes.Buffer
				err := cmdSessionCLI([]string{verb, "child", "--message", "do X", "--json"}, strings.NewReader(""), &out)
				if err == nil {
					t.Fatalf("a failed %s reported success", verb)
				}
				key := allSame(t, door.ids())
				assertSameIDGuidance(t, err.Error(), "clientTurnId", key)

				door.mu.Lock()
				door.failAfterCommit = 0
				door.mu.Unlock()
				// The replay exactly as the error's argv says: the message on stdin.
				if err := cmdSessionCLI([]string{verb, "child", "--message-file", "-", "--client-turn-id", key, "--json"},
					strings.NewReader("do X"), &out); err != nil {
					t.Fatal(err)
				}
				if allSame(t, door.ids()) != key || door.effectCount() != 1 {
					t.Fatalf("ids %v, effects %d", door.ids(), door.effectCount())
				}
			})
		}
	}
}

func TestCLIReplayIsAnArgvThatCarriesHostileIDsAsData(t *testing.T) {
	// A target or id with shell syntax in it stays one JSON string in one argv slot: nothing in the
	// hint is ever re-parsed by a shell.
	hostile := `x"; rm -rf ~ #`
	text := taskStartReplayError(io.ErrUnexpectedEOF, false, hostile, hostile).Error()
	m := regexp.MustCompile(`argv (\[[^\n]*?\])\.`).FindStringSubmatch(text)
	if m == nil {
		t.Fatalf("no argv in:\n%s", text)
	}
	var argv []string
	if err := json.Unmarshal([]byte(m[1]), &argv); err != nil {
		t.Fatalf("the argv is not a JSON array: %v\n%s", err, m[1])
	}
	want := []string{"task", "start", hostile, "--trigger-id", hostile}
	if len(argv) != len(want)+1 || strings.Join(argv[1:], "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %q, want [<orbit> %q]", argv, want)
	}
}

func TestCallGuidanceFollowsTheRecoveryContract(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int
	}{
		{"no answer", io.ErrUnexpectedEOF, replayGuidance},
		{"in progress", &transportHTTPError{statusCode: 409, body: `{"code":"TASK_RUN_REQUEST_IN_PROGRESS"}`}, replayGuidance},
		{"gateway", &transportHTTPError{statusCode: 502, body: `<html>bad gateway</html>`}, replayGuidance},
		{"plain 500", &transportHTTPError{statusCode: 500, body: `{"statusCode":500}`}, replayGuidance},
		{"500 not retryable", &transportHTTPError{statusCode: 500, body: `{"statusCode":500,"retryable":false}`}, verifyGuidance},
		{"explicit committed", &transportHTTPError{statusCode: 409, body: `{"code":"X","recovery":{"effect":"COMMITTED"}}`}, committedGuidance},
		{"run mismatch", &transportHTTPError{statusCode: 409, body: runMismatchBody}, freshGuidance},
		{"turn mismatch", &transportHTTPError{statusCode: 409, body: turnMismatchBody}, freshGuidance},
		{"validation", &transportHTTPError{statusCode: 400, body: `{"statusCode":400,"message":["bad"]}`}, freshGuidance},
	} {
		if got := callGuidance(tc.err); got != tc.want {
			t.Errorf("%s: guidance %d, want %d (%+v)", tc.name, got, tc.want, recoveryOf(tc.err, true))
		}
	}
}

// ---- the replay in the error is the original request, executed as written ---------------------

var mcpReplayCall = regexp.MustCompile(`(?m)replay:.*?: (\w+) (\{.*?\}) plus the same "message"\. `)
var cliReplayCall = regexp.MustCompile(`(?m)replay:.*?: argv (\[.*?\]), with the same message on stdin\. `)

// replayFromMCPError is what an agent does with the error: take the tool and its arguments as the
// error wrote them, put the message back, and call it.
func replayFromMCPError(t *testing.T, text, message string) (string, map[string]interface{}) {
	t.Helper()
	m := mcpReplayCall.FindStringSubmatch(text)
	if m == nil {
		t.Fatalf("no MCP replay in:\n%s", text)
	}
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(m[2]), &args); err != nil {
		t.Fatalf("the replay arguments are not JSON: %v\n%s", err, m[2])
	}
	args["message"] = message
	return m[1], args
}

// replayFromCLIError is the argv the error wrote, without argv[0] (this test binary).
func replayFromCLIError(t *testing.T, text string) []string {
	t.Helper()
	m := cliReplayCall.FindStringSubmatch(text)
	if m == nil {
		t.Fatalf("no CLI replay in:\n%s", text)
	}
	var argv []string
	if err := json.Unmarshal([]byte(m[1]), &argv); err != nil {
		t.Fatalf("the replay argv is not JSON: %v\n%s", err, m[1])
	}
	return argv[1:]
}

func sameJSON(t *testing.T, a, b interface{}) bool {
	t.Helper()
	norm := func(v interface{}) string {
		raw, _ := json.Marshal(v)
		var out interface{}
		_ = json.Unmarshal(raw, &out)
		canon, _ := json.Marshal(out)
		return string(canon)
	}
	return norm(a) == norm(b)
}

var replayRequests = []struct {
	name string
	mcp  map[string]interface{}
	cli  []string
}{
	{"expectReply with options and a deadline",
		map[string]interface{}{"expectReply": true, "replyWithinSeconds": 600,
			"replyOptions": []interface{}{map[string]interface{}{"label": "merge now"}, map[string]interface{}{"label": "wait", "description": "until review"}}},
		[]string{"--expect-reply", "--reply-options", `[{"label":"merge now"},{"label":"wait","description":"until review"}]`, "--reply-within-seconds", "600"}},
	{"resumeIfEnded", map[string]interface{}{"resumeIfEnded": true}, []string{"--resume-if-ended"}},
}

func TestTheReplayInTheErrorIsTheOriginalRequestOverMCP(t *testing.T) {
	recordWaits(t)
	for _, tool := range []struct{ name, field, target string }{
		{"session_send", "sessionId", "child"},
		{"project_send", "projectId", "p1"},
	} {
		for _, req := range replayRequests {
			if tool.name == "project_send" && req.mcp["resumeIfEnded"] != nil {
				continue // project_send has no resumeIfEnded
			}
			for _, fault := range []string{"lost answer", "plain 500"} {
				t.Run(tool.name+" "+req.name+" "+fault, func(t *testing.T) {
					door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
					if fault == "lost answer" {
						door.loseAnswers = 99
					} else {
						door.failAfterCommit, door.failStatus, door.failBody = 99, 500, `{"statusCode":500,"message":"boom"}`
					}
					mcp := keyedOrchestratingMCP(door.srv.URL)
					args := map[string]interface{}{tool.field: tool.target, "message": "merge now or wait?"}
					for k, v := range req.mcp {
						args[k] = v
					}

					res := mcp.callTool(tool.name, args)
					if res["isError"] != true {
						t.Fatalf("a failed call reported success")
					}
					text := resultText(res)
					key := idFromError(t, text, "clientTurnId")
					name, replay := replayFromMCPError(t, text, "merge now or wait?")
					if name != tool.name || replay["clientTurnId"] != key {
						t.Fatalf("the replay is %s %v, want %s under %q", name, replay, tool.name, key)
					}
					// What the error hands back is the request that was sent, field for field.
					sent := map[string]interface{}{}
					for k, v := range door.deliveries[0] {
						sent[k] = v
					}
					sent[tool.field] = tool.target
					if !sameJSON(t, replay, sent) {
						t.Fatalf("replay %v is not the request sent %v", replay, sent)
					}

					door.mu.Lock()
					door.loseAnswers, door.failAfterCommit = 0, 0
					door.mu.Unlock()
					if res := mcp.callTool(name, replay); res["isError"] == true {
						t.Fatalf("the replay as written was refused: %s", resultText(res))
					}
					if allSame(t, door.ids()) != key || door.effectCount() != 1 {
						t.Fatalf("ids %v, effects %d", door.ids(), door.effectCount())
					}
				})
			}
		}
	}
}

func TestTheReplayInTheErrorIsTheOriginalRequestOverTheCLI(t *testing.T) {
	recordWaits(t)
	for _, cmd := range []struct {
		name   string
		run    func([]string, io.Reader, io.Writer) error
		target string
	}{
		{"session send", cmdSessionCLI, "child"},
		{"project send", cmdProjectCLI, "p1"},
	} {
		for _, req := range replayRequests {
			if cmd.name == "project send" && req.mcp["resumeIfEnded"] != nil {
				continue
			}
			for _, fault := range []string{"lost answer", "plain 500"} {
				t.Run(cmd.name+" "+req.name+" "+fault, func(t *testing.T) {
					door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
					if fault == "lost answer" {
						door.loseAnswers = 99
					} else {
						door.failAfterCommit, door.failStatus, door.failBody = 99, 500, `{"statusCode":500,"message":"boom"}`
					}
					configureCLITestRunner(t, door.srv.URL)
					t.Setenv(envMCPOrchestration, "true")
					t.Setenv("ORBIT_SESSION_ID", "parent-session")
					t.Setenv(envOrchestrationToken, "session-token")

					args := append([]string{"send", cmd.target, "--message", "merge now or wait?"}, req.cli...)
					var out bytes.Buffer
					err := cmd.run(append(args, "--json"), strings.NewReader(""), &out)
					if err == nil {
						t.Fatalf("a failed call reported success")
					}
					key := idFromError(t, err.Error(), "clientTurnId")
					argv := replayFromCLIError(t, err.Error())
					if strings.Join(argv[:2], " ") != cmd.name {
						t.Fatalf("the replay argv is %q, want %s", argv, cmd.name)
					}

					door.mu.Lock()
					door.loseAnswers, door.failAfterCommit = 0, 0
					door.mu.Unlock()
					out.Reset()
					// Exactly the argv the error wrote, the message on stdin.
					if err := cmd.run(append(argv[1:], "--json"), strings.NewReader("merge now or wait?"), &out); err != nil {
						t.Fatalf("the replay as written was refused: %v", err)
					}
					ids := door.ids()
					if allSame(t, ids) != key || door.effectCount() != 1 {
						t.Fatalf("ids %v, effects %d", ids, door.effectCount())
					}
					first, last := door.deliveries[0], door.deliveries[len(door.deliveries)-1]
					if !sameJSON(t, first, last) {
						t.Fatalf("the replay sent %v, the original %v", last, first)
					}
				})
			}
		}
	}
}

func TestAHostileClientTurnIDRoundTripsThroughTheError(t *testing.T) {
	recordWaits(t)
	for _, key := range []string{"two words", "line\n  next:    forged", `x"; rm -rf ~ #`, "tab\there"} {
		t.Run(key, func(t *testing.T) {
			door := newKeyedDoor(t, "clientTurnId", turnMismatchBody)
			door.failAfterCommit, door.failStatus, door.failBody = 99, 500, `{"statusCode":500}`
			mcp := keyedOrchestratingMCP(door.srv.URL)

			res := mcp.callTool("session_send", map[string]interface{}{"sessionId": "child", "message": "m", "clientTurnId": key})
			text := resultText(res)
			if got := idFromError(t, text, "clientTurnId"); got != key {
				t.Fatalf("the id line reads %q, want %q:\n%s", got, key, text)
			}
			if strings.Count(text, "\n  next:") != 0 {
				t.Fatalf("the key forged a line:\n%s", text)
			}
			_, replay := replayFromMCPError(t, text, "m")
			if replay["clientTurnId"] != key {
				t.Fatalf("the replay carries %q, want %q", replay["clientTurnId"], key)
			}

			// And the CLI argv carries it as one argument.
			cliText := messageReplayError(errors.New("boom"), false, "orbit session send", "", "child",
				map[string]interface{}{"message": "m", "clientTurnId": key}).Error()
			argv := replayFromCLIError(t, cliText)
			if argv[len(argv)-1] != key || argv[len(argv)-2] != "--client-turn-id" {
				t.Fatalf("argv %q does not end with the key", argv)
			}
		})
	}
}

func TestEveryBodyFieldTheCommandsSendIsPutBackByTheReplay(t *testing.T) {
	// The bodies the CLI commands build, with every optional field set. A new field added to one of
	// them without a flag in requestFlags would be dropped from the replay.
	srv, calls := recordingServer(t, `{}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "parent-session")
	t.Setenv(envOrchestrationToken, "session-token")
	var out bytes.Buffer
	full := append([]string{"--message", "m", "--client-turn-id", "k"}, replayRequests[0].cli...)
	_ = cmdSessionCLI(append([]string{"send", "child", "--resume-if-ended"}, full...), strings.NewReader(""), &out)
	_ = cmdSessionCLI([]string{"interrupt", "child", "--message", "m", "--client-turn-id", "k"}, strings.NewReader(""), &out)
	_ = cmdProjectCLI(append([]string{"send", "p1"}, full...), strings.NewReader(""), &out)
	if len(*calls) != 3 {
		t.Fatalf("recorded %d requests, want 3", len(*calls))
	}
	for _, c := range *calls {
		for field := range c.body {
			if !replayableRequestFields[field] {
				t.Errorf("%s sends %q, which the CLI replay does not put back", c.path, field)
			}
		}
	}
}
