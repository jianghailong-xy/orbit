package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// receiptServer is a control plane with create receipts: it keeps what each request id created and answers a
// repeat with it. A create is COMMITTED before its answer goes out; how the answer then fails is the test's.
type receiptServer struct {
	t *testing.T
	// What to do with the answer to the first delivery of each id: "" answers it, "drop" cuts the
	// connection after the commit, "truncate" sends the status line and part of the body and then cuts.
	firstAnswer string
	// Answered instead of creating, when set.
	refusalStatus int
	refusalBody   string

	mu        sync.Mutex
	posts     []string // the request id of every create POST, in order ("" for none)
	created   map[string]string
	nextID    int
	childGets int
	getFails  bool
}

func (s *receiptServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case r.Method == http.MethodPost && (r.URL.Path == "/api/runner/projects" || r.URL.Path == "/api/runner/sessions"):
		id := r.Header.Get(requestIDHeader)
		s.posts = append(s.posts, id)
		if s.refusalStatus != 0 {
			w.WriteHeader(s.refusalStatus)
			_, _ = w.Write([]byte(s.refusalBody))
			return
		}
		if s.created == nil {
			s.created = map[string]string{}
		}
		resource, replayed := s.created[id]
		if !replayed || id == "" {
			s.nextID++
			resource = fmt.Sprintf("created-%d", s.nextID)
			s.created[id] = resource
		}
		body := fmt.Sprintf(`{"id":%q,"status":"PENDING","requestReceipt":{"requestId":%q,"resourceId":%q,"replayed":%t}}`,
			resource, id, resource, replayed)
		if !replayed {
			switch s.firstAnswer {
			case "drop":
				s.hangUp(w)
				return
			case "truncate":
				w.Header().Set("content-length", fmt.Sprint(len(body)+50))
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(body[:10]))
				w.(http.Flusher).Flush()
				s.hangUp(w)
				return
			}
		}
		_, _ = w.Write([]byte(body))
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/runner/sessions/"):
		s.childGets++
		if s.getFails {
			s.hangUp(w)
			return
		}
		_, _ = w.Write([]byte(`{"id":"created-1","status":"RUNNING"}`))
	default:
		s.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *receiptServer) hangUp(w http.ResponseWriter) {
	conn, _, err := w.(http.Hijacker).Hijack()
	if err != nil {
		s.t.Errorf("hijack: %v", err)
		return
	}
	_ = conn.Close()
}

func (s *receiptServer) creates() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.created)
}

func (s *receiptServer) postIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.posts...)
}

// headlessCreateMCP is an orbit mcp talking to srv. project_create runs with no calling session, so no
// approval card is filed; session_create needs one, and runs with Watch off so a wait polls inline.
func headlessCreateMCP(t *testing.T, srv *httptest.Server) *mcpServer {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envWatches, "off")
	return &mcpServer{t: NewTransport(srv.URL, "runner-token"), allowOrchestration: true}
}

// callCreate calls tool the way its door needs: session_create from a calling session.
func callCreate(m *mcpServer, tool string, args map[string]interface{}) map[string]interface{} {
	if tool == "session_create" {
		m.sessionID, m.orchestrationToken = "caller-session", "session-token"
	} else {
		m.sessionID, m.orchestrationToken = "", ""
	}
	return m.callTool(tool, args)
}

// partialReceipt reads the JSON receipt a failed create prints under its first line.
func partialReceipt(t *testing.T, text string) createRequestFailure {
	t.Helper()
	start := strings.LastIndex(text, "\n"+createReceiptLabel+"\n")
	if start < 0 {
		t.Fatalf("no receipt in %q", text)
	}
	var got createRequestFailure
	if err := json.Unmarshal([]byte(text[start+len(createReceiptLabel)+2:]), &got); err != nil {
		t.Fatalf("receipt is not JSON: %v\n%s", err, text)
	}
	return got
}

// A create that committed and whose answer was lost — the connection cut after the commit, or the body cut
// after the status line — is sent ONCE, fails with the request id and RETRY_SAME_REQUEST, and the repeat
// under that id is answered with what the first created: one Project or Session, never two.
func TestACreateWhoseAnswerWasLostIsRepeatedUnderItsRequestIDAndCreatesOnce(t *testing.T) {
	for _, tool := range []string{"project_create", "session_create"} {
		for _, lost := range []string{"drop", "truncate"} {
			t.Run(tool+"/"+lost, func(t *testing.T) {
				server := &receiptServer{t: t, firstAnswer: lost}
				srv := httptest.NewServer(server)
				defer srv.Close()
				mcp := headlessCreateMCP(t, srv)
				args := map[string]interface{}{"title": "Plan", "prompt": "work"}

				first := callCreate(mcp, tool, args)
				text := watchToolText(t, first)
				if first["isError"] != true {
					t.Fatalf("a lost answer must not read as a success: %s", text)
				}
				posts := server.postIDs()
				if len(posts) != 1 || posts[0] == "" {
					t.Fatalf("create POSTs = %q, want exactly one, named: an unknown outcome is never resent on its own", posts)
				}
				receipt := partialReceipt(t, text)
				if receipt.Outcome != "UNKNOWN" || receipt.RequestID != posts[0] ||
					receipt.Recovery.Effect != "UNKNOWN" || receipt.Recovery.Retry.Policy != "SAME_REQUEST_ID" ||
					receipt.Recovery.ActionCode == nil || *receipt.Recovery.ActionCode != "RETRY_SAME_REQUEST" ||
					!strings.Contains(receipt.Next, posts[0]) {
					t.Fatalf("receipt = %#v, want UNKNOWN under %q with RETRY_SAME_REQUEST", receipt, posts[0])
				}

				repeat := map[string]interface{}{"title": "Plan", "prompt": "work", "requestId": receipt.RequestID}
				second := callCreate(mcp, tool, repeat)
				secondText := watchToolText(t, second)
				if second["isError"] == true {
					t.Fatalf("the repeat failed: %s", secondText)
				}
				var answer struct {
					ID      string `json:"id"`
					Receipt struct {
						RequestID string `json:"requestId"`
						Replayed  bool   `json:"replayed"`
					} `json:"requestReceipt"`
				}
				if err := json.Unmarshal([]byte(secondText), &answer); err != nil {
					t.Fatalf("answer is not JSON: %v\n%s", err, secondText)
				}
				if answer.ID != "created-1" || !answer.Receipt.Replayed || answer.Receipt.RequestID != receipt.RequestID {
					t.Fatalf("answer = %#v, want the first create read back", answer)
				}
				if got := server.postIDs(); len(got) != 2 || got[1] != got[0] {
					t.Fatalf("create POSTs = %q, want the repeat under the first id", got)
				}
				if server.creates() != 1 {
					t.Fatalf("%d creates, want one", server.creates())
				}
			})
		}
	}
}

// Every call is its own request: two calls without a requestId are two ids, so two creates.
func TestEachCreateCallIsANewRequest(t *testing.T) {
	server := &receiptServer{t: t}
	srv := httptest.NewServer(server)
	defer srv.Close()
	mcp := headlessCreateMCP(t, srv)
	for i := 0; i < 2; i++ {
		if result := mcp.callTool("project_create", map[string]interface{}{"title": "Plan"}); result["isError"] == true {
			t.Fatal(watchToolText(t, result))
		}
	}
	posts := server.postIDs()
	if len(posts) != 2 || posts[0] == "" || posts[0] == posts[1] || server.creates() != 2 {
		t.Fatalf("posts = %q, creates = %d: want two distinct ids and two creates", posts, server.creates())
	}
}

// What the server's receipt refusals tell the caller, each sent once.
func TestCreateReceiptRefusalsSayWhatToDoNext(t *testing.T) {
	for _, tc := range []struct {
		code, policy, outcome, next string
	}{
		{"CREATE_REQUEST_IN_PROGRESS", "SAME_REQUEST_ID", "UNKNOWN", "with the same arguments and requestId"},
		{"CREATE_REQUEST_OUTCOME_UNKNOWN", "VERIFY_THEN_RETRY", "UNKNOWN", "Look for it first"},
		{"REQUEST_ID_REUSED", "NEVER", "NOT_CREATED", "Nothing was created"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			recovery := map[string]interface{}{
				"CREATE_REQUEST_IN_PROGRESS":     map[string]interface{}{"effect": "UNKNOWN", "retryPolicy": "SAME_REQUEST_ID", "actionCode": "RETRY_SAME_REQUEST"},
				"CREATE_REQUEST_OUTCOME_UNKNOWN": map[string]interface{}{"effect": "UNKNOWN", "retryPolicy": "VERIFY_THEN_RETRY", "actionCode": "VERIFY_STATE"},
				"REQUEST_ID_REUSED":              map[string]interface{}{"effect": "NONE", "retryPolicy": "NEVER", "actionCode": "USE_NEW_REQUEST_ID"},
			}[tc.code]
			body, _ := json.Marshal(map[string]interface{}{"statusCode": 409, "code": tc.code, "message": "m", "recovery": recovery})
			server := &receiptServer{t: t, refusalStatus: http.StatusConflict, refusalBody: string(body)}
			srv := httptest.NewServer(server)
			defer srv.Close()
			result := callCreate(headlessCreateMCP(t, srv), "session_create", map[string]interface{}{"prompt": "work", "requestId": "req-1"})
			text := watchToolText(t, result)
			receipt := partialReceipt(t, text)
			if result["isError"] != true || receipt.Outcome != tc.outcome || receipt.Recovery.Retry.Policy != tc.policy ||
				receipt.RequestID != "req-1" || !strings.Contains(receipt.Next, tc.next) {
				t.Fatalf("receipt = %#v", receipt)
			}
			if posts := server.postIDs(); len(posts) != 1 || posts[0] != "req-1" {
				t.Fatalf("posts = %q, want the one request under the caller's id", posts)
			}
		})
	}
}

// With no id to protect a resend, an unknown outcome only ever says to look first.
func TestAnUnknownOutcomeWithoutARequestIDIsNeverAdvisedAResend(t *testing.T) {
	text := describeCreateFailure("project", "project_create", "the project list", "", fmt.Errorf("POST /runner/projects: reading response body: %w", io.ErrUnexpectedEOF)).Error()
	receipt := partialReceipt(t, text)
	if receipt.Outcome != "UNKNOWN" || receipt.Recovery.Retry.Policy != "VERIFY_THEN_RETRY" ||
		strings.Contains(receipt.Next, "again with the same") {
		t.Fatalf("receipt = %#v, want look-first with no resend", receipt)
	}
	for _, env := range []recoveryEnvelope{recoveryOf(io.ErrUnexpectedEOF, false), recoveryOf(&transportHTTPError{statusCode: 502, body: "bad gateway"}, false)} {
		if env.Retry.Policy == "SAFE" || env.Retry.Policy == "SAME_REQUEST_ID" {
			t.Fatalf("an unknown outcome without an id was advised %s", env.Retry.Policy)
		}
	}
}

// A requestId the server would refuse is refused here, before anything is sent.
func TestAMalformedRequestIDIsRefusedBeforeSending(t *testing.T) {
	server := &receiptServer{t: t}
	srv := httptest.NewServer(server)
	defer srv.Close()
	result := headlessCreateMCP(t, srv).callTool("project_create", map[string]interface{}{"title": "Plan", "requestId": "has spaces"})
	if result["isError"] != true || len(server.postIDs()) != 0 {
		t.Fatalf("result = %#v, posts = %q", result, server.postIDs())
	}
}

type sessionWaitAnswer struct {
	ID   string            `json:"id"`
	Wait sessionWaitReport `json:"wait"`
}

// A wait that fails or runs out after the child exists keeps its id, says how the wait ended, names
// session_get as the next step, and is never an error: nothing reads it as a create to try again.
func TestSessionCreateWaitThatFailsKeepsTheChildAndPointsAtSessionGet(t *testing.T) {
	shortenSessionWait(t)
	t.Setenv(envSpawnDepth, "10")
	for _, tc := range []struct {
		name     string
		getFails bool
		outcome  string
	}{
		{"the read fails", true, waitOutcomeGetFailed},
		{"the wait runs out", false, waitOutcomeTimeout},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := &receiptServer{t: t, getFails: tc.getFails}
			srv := httptest.NewServer(server)
			defer srv.Close()
			result := callCreate(headlessCreateMCP(t, srv), "session_create", map[string]interface{}{"prompt": "work", "wait": true})
			text := watchToolText(t, result)
			if result["isError"] == true {
				t.Fatalf("a failed wait after the create must not be an error: %s", text)
			}
			start := strings.Index(text, "{")
			var got sessionWaitAnswer
			if err := json.Unmarshal([]byte(text[start:]), &got); err != nil {
				// The answer may be followed by a note.
				end := strings.LastIndex(text, "}")
				if err := json.Unmarshal([]byte(text[start:end+1]), &got); err != nil {
					t.Fatalf("answer is not JSON: %v\n%s", err, text)
				}
			}
			if got.ID != "created-1" || got.Wait.Outcome != tc.outcome || got.Wait.SessionID != "created-1" || !got.Wait.Created ||
				got.Wait.Next.Tool != "session_get" || got.Wait.Next.Arguments["sessionId"] != "created-1" ||
				got.Wait.Next.Command != "orbit session get created-1" {
				t.Fatalf("answer = %#v", got)
			}
			if tc.getFails && (got.Wait.Error == "" || !strings.Contains(text, "do not call session_create again")) {
				t.Fatalf("a failed read must say why and that the session exists: %s", text)
			}
			if posts := server.postIDs(); len(posts) != 1 {
				t.Fatalf("create POSTs = %q, want exactly one", posts)
			}
		})
	}
}

// The failure renderer's structured next step agrees with the create's receipt. A create whose answer
// was lost under a request id the caller named is offered again under that same id, over MCP and at the
// CLI; one whose id was drawn for the call is never offered as the same call, because that call would draw
// a new id and could create a second one.
func TestACreateFailureReportOffersOnlyTheSameRequestID(t *testing.T) {
	srv := &receiptServer{t: t, firstAnswer: "drop"}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	m := headlessCreateMCP(t, ts)
	named := decodeMCPReport(t, callCreate(m, "project_create", map[string]interface{}{"title": "P", "requestId": "req-mcp"}))
	if named.Error.Effect != "UNKNOWN" || named.Next.Type != recoveryNextInvoke || named.Next.Tool != "project_create" ||
		named.Next.Input["requestId"] != "req-mcp" {
		t.Fatalf("MCP with a named id: %#v", named)
	}
	drawn := decodeMCPReport(t, callCreate(m, "project_create", map[string]interface{}{"title": "P"}))
	if drawn.Error.Effect != "UNKNOWN" || drawn.Next.Type == recoveryNextInvoke {
		t.Fatalf("MCP with a drawn id is offered as the same call: %#v", drawn)
	}

	recoveryRenderEnv(t, ts.URL)
	cliReport := func(args ...string) recoveryReport {
		t.Helper()
		out, stderr, err := recoveryCLIProcess(t, append([]string{"project", "create", "--title", "P"}, args...))
		if err == nil {
			t.Fatalf("create succeeded: %s", out)
		}
		var report recoveryReport
		if json.Unmarshal([]byte(out), &report) != nil {
			t.Fatalf("stdout is not one report: %q (stderr %q)", out, stderr)
		}
		return report
	}
	cliNamed := cliReport("--request-id", "req-cli", "--json")
	argv := strings.Join(cliNamed.Next.Argv, " ")
	if cliNamed.Error.Effect != "UNKNOWN" || cliNamed.Next.Type != recoveryNextInvoke || !strings.Contains(argv, "--request-id req-cli") {
		t.Fatalf("CLI with a named id: %#v", cliNamed)
	}
	if cliDrawn := cliReport("--json"); cliDrawn.Error.Effect != "UNKNOWN" || cliDrawn.Next.Type == recoveryNextInvoke {
		t.Fatalf("CLI with a drawn id is offered as the same call: %#v", cliDrawn)
	}
	// Each of the four calls was delivered once: nothing was resent on its own.
	if got := srv.postIDs(); len(got) != 4 {
		t.Fatalf("create POSTs = %q, want 4 single deliveries", got)
	}
}
