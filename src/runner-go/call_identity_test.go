package main

import (
	"bytes"
	"encoding/json"
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
	srv            *httptest.Server
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
	d.mu.Unlock()
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

var errorIDLine = regexp.MustCompile(`(?m)^  (triggerId|clientTurnId): (\S+)$`)

// idFromError is what an agent does with the error: read the id line, nothing else.
func idFromError(t *testing.T, text, field string) string {
	t.Helper()
	m := errorIDLine.FindStringSubmatch(text)
	if m == nil || m[1] != field {
		t.Fatalf("the error names no %s:\n%s", field, text)
	}
	return m[2]
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
		!strings.Contains(text, "task_start without triggerId") {
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
	if !strings.Contains(err.Error(), "orbit task start task-1 --trigger-id "+id) {
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
	if key != allSame(t, door.ids()) || !strings.Contains(text, "session_interrupt with the same message") {
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
	if key != door.ids()[0] || !strings.Contains(text, `project_send with the same message, projectId "p1"`) {
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
				!strings.Contains(err.Error(), "orbit session "+verb+" child with the same message and --client-turn-id "+key) {
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
