package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// The runner's create recovery against a REAL control plane: the apiserver's runner doors over HTTP, on a real
// PostgreSQL. It runs only when create-request-recovery-http.pg.spec.ts starts it. That spec stands the server
// up, hands its URL and credentials over in the environment below, runs this with -v and requires its PASS
// line, then checks the report this writes against the database and the public GET routes.
//
// Between the runner and the server sits a proxy that forwards every request and, when told to, loses the
// answer AFTER the server has sent it in full, which is after the create committed. "drop" closes the
// connection without a byte. "truncate" sends the real status line and headers and half the body. It can
// also fail every read of one child session, and it counts every create POST it sees.
const (
	envE2EAPI           = "ORBIT_CREATE_E2E_API"
	envE2ERunnerToken   = "ORBIT_CREATE_E2E_RUNNER_TOKEN"
	envE2EParentSession = "ORBIT_CREATE_E2E_PARENT_SESSION"
	envE2EOrchToken     = "ORBIT_CREATE_E2E_ORCHESTRATION_TOKEN"
	envE2EReport        = "ORBIT_CREATE_E2E_REPORT"
	envE2ETag           = "ORBIT_CREATE_E2E_TAG"
	envE2EAgent         = "ORBIT_CREATE_E2E_AGENT"
)

type faultProxy struct {
	t        *testing.T
	upstream string

	mu sync.Mutex
	// What to do to the answer of the next create POST: "", "drop" or "truncate". Spent by that POST.
	loseNextCreate string
	// While set, every read of a session other than this one (the caller's own) fails: the child's id is not
	// known before the create answers.
	failChildGetsExcept string
	posts               []string // X-Orbit-Request-Id of every create POST
	// The status the server answered the create whose answer was then lost: proof it was created before
	// the runner lost the answer.
	lostStatus int
	failedGets int
}

func (p *faultProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	isCreate := r.Method == http.MethodPost && (r.URL.Path == "/api/runner/projects" || r.URL.Path == "/api/runner/sessions")
	p.mu.Lock()
	lose := ""
	if isCreate {
		p.posts = append(p.posts, r.Header.Get(requestIDHeader))
		lose, p.loseNextCreate = p.loseNextCreate, ""
	}
	failGet := r.Method == http.MethodGet && p.failChildGetsExcept != "" &&
		strings.HasPrefix(r.URL.Path, "/api/runner/sessions/") && r.URL.Path != "/api/runner/sessions/"+p.failChildGetsExcept
	if failGet {
		p.failedGets++
	}
	p.mu.Unlock()
	if failGet {
		p.hangUp(w)
		return
	}

	req, err := http.NewRequest(r.Method, p.upstream+r.URL.RequestURI(), bytes.NewReader(body))
	if err != nil {
		p.t.Errorf("proxy: %v", err)
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	req.Header = r.Header.Clone()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		p.t.Errorf("proxy: upstream %s %s: %v", r.Method, r.URL.Path, err)
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	answer, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		p.t.Errorf("proxy: reading upstream answer: %v", err)
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	// The server has answered in full: whatever it created is committed. Now the answer is lost on the way back.
	if lose != "" {
		p.mu.Lock()
		p.lostStatus = resp.StatusCode
		p.mu.Unlock()
	}
	switch lose {
	case "drop":
		p.hangUp(w)
		return
	case "truncate":
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.Header().Set("Content-Length", fmt.Sprint(len(answer)))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(answer[:len(answer)/2])
		w.(http.Flusher).Flush()
		p.hangUp(w)
		return
	}
	for k, vs := range resp.Header {
		if strings.EqualFold(k, "Content-Length") {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(answer)
}

func (p *faultProxy) hangUp(w http.ResponseWriter) {
	conn, _, err := w.(http.Hijacker).Hijack()
	if err != nil {
		p.t.Errorf("hijack: %v", err)
		return
	}
	_ = conn.Close()
}

func (p *faultProxy) createPosts() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.posts...)
}

// What one lost-answer scenario saw, for the spec to check against the database and the public routes.
type lostAnswerReport struct {
	Tool             string                 `json:"tool"`
	Lost             string                 `json:"lost"`
	Marker           string                 `json:"marker"`
	FirstOutcome     string                 `json:"firstOutcome"`
	FirstRecovery    string                 `json:"firstRecoveryPolicy"`
	RequestID        string                 `json:"requestId"`
	ReplayID         string                 `json:"replayId"`
	ReplayReceipt    map[string]interface{} `json:"replayReceipt"`
	SecondReplayID   string                 `json:"secondReplayId"`
	SecondReceipt    map[string]interface{} `json:"secondReplayReceipt"`
	CreatePostIDs    []string               `json:"createPostRequestIds"`
	CreatePostsCount int                    `json:"createPosts"`
	LostStatus       int                    `json:"lostDeliveryStatus"`
}

// What one session_create(wait) scenario saw.
type waitFailureReport struct {
	Outcome          string `json:"outcome"`
	Marker           string `json:"marker"`
	CreatedID        string `json:"createdId"`
	WaitSessionID    string `json:"waitSessionId"`
	NextTool         string `json:"nextTool"`
	NextSessionID    string `json:"nextSessionId"`
	IsError          bool   `json:"isError"`
	FailedGets       int    `json:"failedGets"`
	SessionGetID     string `json:"sessionGetId"`
	CreatePostsCount int    `json:"createPosts"`
}

type createE2EReport struct {
	LostAnswers  []lostAnswerReport  `json:"lostAnswers"`
	WaitFailures []waitFailureReport `json:"waitFailures"`
}

func TestCreateRecoveryAgainstARealControlPlane(t *testing.T) {
	api := os.Getenv(envE2EAPI)
	if api == "" {
		t.Skip("run by src/apiserver/src/runner-api/create-request-recovery-http.pg.spec.ts, which starts the control plane")
	}
	runnerToken, parent, orchToken := os.Getenv(envE2ERunnerToken), os.Getenv(envE2EParentSession), os.Getenv(envE2EOrchToken)
	tag, agent := os.Getenv(envE2ETag), os.Getenv(envE2EAgent)
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envWatches, "off")
	t.Setenv(envSpawnDepth, "10")
	shortenSessionWait(t)

	var report createE2EReport

	answerOf := func(text string) (string, map[string]interface{}) {
		var answer struct {
			ID      string                 `json:"id"`
			Receipt map[string]interface{} `json:"requestReceipt"`
		}
		start := strings.Index(text, "{")
		if start < 0 || json.Unmarshal([]byte(text[start:]), &answer) != nil {
			t.Fatalf("answer is not JSON: %s", text)
		}
		return answer.ID, answer.Receipt
	}

	for _, tool := range []string{"project_create", "session_create"} {
		for _, lost := range []string{"drop", "truncate"} {
			t.Run(tool+"/"+lost, func(t *testing.T) {
				proxy := &faultProxy{t: t, upstream: api, loseNextCreate: lost}
				srv := httptest.NewServer(proxy)
				defer srv.Close()
				m := &mcpServer{t: NewTransport(srv.URL, runnerToken), allowOrchestration: true, agentID: agent}
				marker := fmt.Sprintf("%s %s %s", tag, tool, lost)
				args := map[string]interface{}{"title": marker}
				if tool == "session_create" {
					m.sessionID, m.orchestrationToken = parent, orchToken
					args = map[string]interface{}{"prompt": marker}
				}

				first := m.callTool(tool, args)
				firstText := watchToolText(t, first)
				if first["isError"] != true {
					t.Fatalf("a lost answer read as a success: %s", firstText)
				}
				receipt := partialReceipt(t, firstText)
				if receipt.Outcome != "UNKNOWN" || receipt.Recovery.Retry.Policy != "SAME_REQUEST_ID" || receipt.RequestID == "" {
					t.Fatalf("partial receipt = %#v", receipt)
				}
				if posts := proxy.createPosts(); len(posts) != 1 {
					t.Fatalf("create POSTs after the lost answer = %q: an unknown outcome must not be resent on its own", posts)
				}
				if proxy.lostStatus < 200 || proxy.lostStatus >= 300 {
					t.Fatalf("the server answered the lost delivery %d: it must have created before the answer was lost", proxy.lostStatus)
				}

				repeat := map[string]interface{}{"requestId": receipt.RequestID}
				for k, v := range args {
					repeat[k] = v
				}
				second := m.callTool(tool, repeat)
				secondText := watchToolText(t, second)
				if second["isError"] == true {
					t.Fatalf("the repeat failed: %s", secondText)
				}
				replayID, replayReceipt := answerOf(secondText)
				third := m.callTool(tool, repeat)
				thirdText := watchToolText(t, third)
				if third["isError"] == true {
					t.Fatalf("the second repeat failed: %s", thirdText)
				}
				secondReplayID, secondReceipt := answerOf(thirdText)
				if replayID == "" || replayID != secondReplayID || replayReceipt["replayed"] != true ||
					replayReceipt["resourceId"] != replayID || secondReceipt["resourceId"] != replayID ||
					replayReceipt["receivedAt"] != secondReceipt["receivedAt"] || replayReceipt["requestId"] != receipt.RequestID {
					t.Fatalf("replays = %s / %#v and %s / %#v", replayID, replayReceipt, secondReplayID, secondReceipt)
				}
				posts := proxy.createPosts()
				for _, id := range posts {
					if id != receipt.RequestID {
						t.Fatalf("create POSTs = %q, want every one under %q", posts, receipt.RequestID)
					}
				}
				report.LostAnswers = append(report.LostAnswers, lostAnswerReport{
					Tool: tool, Lost: lost, Marker: marker, FirstOutcome: receipt.Outcome, FirstRecovery: receipt.Recovery.Retry.Policy,
					RequestID: receipt.RequestID, ReplayID: replayID, ReplayReceipt: replayReceipt,
					SecondReplayID: secondReplayID, SecondReceipt: secondReceipt, CreatePostIDs: posts, CreatePostsCount: len(posts), LostStatus: proxy.lostStatus,
				})
			})
		}
	}

	for _, outcome := range []string{waitOutcomeGetFailed, waitOutcomeTimeout} {
		t.Run("session_create wait/"+outcome, func(t *testing.T) {
			proxy := &faultProxy{t: t, upstream: api}
			srv := httptest.NewServer(proxy)
			defer srv.Close()
			m := &mcpServer{t: NewTransport(srv.URL, runnerToken), allowOrchestration: true, agentID: agent, sessionID: parent, orchestrationToken: orchToken}
			marker := fmt.Sprintf("%s wait %s", tag, outcome)
			if outcome == waitOutcomeGetFailed {
				proxy.failChildGetsExcept = parent
			}

			result := m.callTool("session_create", map[string]interface{}{"prompt": marker, "wait": true})
			text := watchToolText(t, result)
			if result["isError"] == true {
				t.Fatalf("a wait that failed after the create is an error: %s", text)
			}
			var answer struct {
				ID   string            `json:"id"`
				Wait sessionWaitReport `json:"wait"`
			}
			start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
			if start < 0 || json.Unmarshal([]byte(text[start:end+1]), &answer) != nil {
				t.Fatalf("answer is not JSON: %s", text)
			}
			if answer.Wait.Outcome != outcome || answer.Wait.SessionID == "" || answer.Wait.SessionID != answer.ID ||
				answer.Wait.Next.Tool != "session_get" || answer.Wait.Next.Arguments["sessionId"] != answer.Wait.SessionID {
				t.Fatalf("answer = %#v", answer)
			}

			// Recovery is exactly the next step the answer named: the public session_get, with its arguments,
			// through a connection that works again.
			proxy.mu.Lock()
			proxy.failChildGetsExcept = ""
			failedGets := proxy.failedGets
			proxy.mu.Unlock()
			args := map[string]interface{}{}
			for k, v := range answer.Wait.Next.Arguments {
				args[k] = v
			}
			got := m.callTool(answer.Wait.Next.Tool, args)
			gotText := watchToolText(t, got)
			if got["isError"] == true {
				t.Fatalf("session_get failed: %s", gotText)
			}
			var child struct {
				ID string `json:"id"`
			}
			if json.Unmarshal([]byte(gotText), &child) != nil || child.ID != answer.Wait.SessionID {
				t.Fatalf("session_get answered %s, want %s", gotText, answer.Wait.SessionID)
			}
			if outcome == waitOutcomeGetFailed && failedGets == 0 {
				t.Fatal("no read of the child failed")
			}
			posts := proxy.createPosts()
			if len(posts) != 1 {
				t.Fatalf("create POSTs = %q, want exactly one: recovery reads, it never creates", posts)
			}
			report.WaitFailures = append(report.WaitFailures, waitFailureReport{
				Outcome: outcome, Marker: marker, CreatedID: answer.ID, WaitSessionID: answer.Wait.SessionID,
				NextTool: answer.Wait.Next.Tool, NextSessionID: answer.Wait.Next.Arguments["sessionId"], IsError: false,
				FailedGets: failedGets, SessionGetID: child.ID, CreatePostsCount: len(posts),
			})
		})
	}

	if path := os.Getenv(envE2EReport); path != "" {
		encoded, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatalf("write report: %v", err)
		}
	}
}
