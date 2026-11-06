package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const importCLIUUID = "4e453ab7-f37c-494d-8017-bb4e9beffeef"

// writeImportCLITranscript drops a minimal real-shape transcript (cwd on the user row) into the
// CLAUDE_CONFIG_DIR projects tree the CLI globs.
func writeImportCLITranscript(t *testing.T, base, cwd string, withConversation bool) {
	t.Helper()
	dir := filepath.Join(base, "projects", "some-project")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var tr importTestTranscript
	tr.add(map[string]interface{}{"type": "last-prompt", "sessionId": importCLIUUID})
	if withConversation {
		tr.add(importMsgRow("user", cwd, "2026-09-15T10:00:00Z", map[string]interface{}{"type": "text", "text": "hello"}))
		tr.add(importMsgRow("assistant", cwd, "2026-09-15T10:00:01Z", map[string]interface{}{"type": "text", "text": "hi"}))
	}
	tr.write(t, filepath.Join(dir, importCLIUUID+".jsonl"))
}

func TestSessionCLIImportPostsSourceAndWaitsForTheReplay(t *testing.T) {
	shortenSessionWait(t)
	config := t.TempDir()
	writeImportCLITranscript(t, config, "/ws/proj", true)
	t.Setenv("CLAUDE_CONFIG_DIR", config)

	var requests []string
	var posted map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := r.Method + " " + r.URL.Path
		requests = append(requests, request)
		if got := r.Header.Get("Authorization"); got != "Bearer runner-secret" {
			t.Errorf("%s authorization = %q", request, got)
		}
		for _, header := range []string{"X-Orbit-Session-Id", "X-Orbit-Session-Token"} {
			if got := r.Header.Get(header); got != "" {
				t.Errorf("%s carried session context %s", request, header)
			}
		}
		w.Header().Set("content-type", "application/json")
		switch request {
		case "POST /api/runner/sessions/import":
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Errorf("decode body: %v", err)
			}
			_, _ = w.Write([]byte(`{"id":"imported-1","status":"PENDING"}`))
		case "GET /api/runner/sessions/imported-1/events":
			// First poll: the replay has not landed yet. Second: it has.
			if strings.Count(strings.Join(requests, "\n"), "/events") == 1 {
				_, _ = w.Write([]byte(`{"events":[],"hasMore":false}`))
			} else {
				_, _ = w.Write([]byte(`{"events":[{"seq":1,"type":"user","payload":{"text":"hello"},"ts":"2026-09-15T10:00:00Z"}],"hasMore":false}`))
			}
		case "GET /api/runner/sessions/imported-1":
			// The poll also watches the session for a settled failure; still PENDING here.
			_, _ = w.Write([]byte(`{"id":"imported-1","status":"PENDING"}`))
		default:
			t.Errorf("unexpected request %s", request)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envOrchestrationToken, "")
	t.Setenv("ORBIT_AGENT_ID", "")

	var out bytes.Buffer
	if err := cmdSessionCLI([]string{"import", importCLIUUID, "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if want := map[string]interface{}{"claudeSessionId": importCLIUUID, "sourceCwd": "/ws/proj"}; !reflect.DeepEqual(posted, want) {
		t.Errorf("posted body = %#v, want %#v", posted, want)
	}
	want := []string{
		"POST /api/runner/sessions/import",
		"GET /api/runner/sessions/imported-1/events",
		"GET /api/runner/sessions/imported-1",
		"GET /api/runner/sessions/imported-1/events",
	}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests = %#v, want %#v", requests, want)
	}
	if got := out.String(); !strings.Contains(got, `"imported-1"`) {
		t.Errorf("output %q does not carry the new session", got)
	}
}

// The runner settles a failed import as FAILED with the reason; the CLI reports it instead of
// sitting out the poll.
func TestSessionCLIImportReportsTheSessionFailure(t *testing.T) {
	shortenSessionWait(t)
	config := t.TempDir()
	writeImportCLITranscript(t, config, "/ws/proj", true)
	t.Setenv("CLAUDE_CONFIG_DIR", config)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/api/runner/sessions/import":
			_, _ = w.Write([]byte(`{"id":"imported-2","status":"PENDING"}`))
		case "/api/runner/sessions/imported-2/events":
			_, _ = w.Write([]byte(`{"events":[],"hasMore":false}`))
		case "/api/runner/sessions/imported-2":
			_, _ = w.Write([]byte(`{"id":"imported-2","status":"FAILED","error":"the transcript was recorded in /elsewhere, outside the workspace /ws/proj"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envOrchestrationToken, "")
	t.Setenv("ORBIT_AGENT_ID", "")

	err := cmdSessionCLI([]string{"import", importCLIUUID, "--json"}, strings.NewReader(""), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "outside the workspace /ws/proj") {
		t.Fatalf("error = %v, want the session's failure reason", err)
	}
}

// Rejections ①, ④-shape and ⑤ are answered locally, before anything is created.
func TestSessionCLIImportRefusesLocallyWithoutACall(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1") // nothing should ever be dialed
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envOrchestrationToken, "")
	t.Setenv("ORBIT_AGENT_ID", "")

	tests := []struct {
		name     string
		claudeID string
		prepare  func(t *testing.T) (config string)
		wantErr  string
	}{
		{
			name:     "missing transcript",
			claudeID: importCLIUUID,
			prepare: func(t *testing.T) string {
				return t.TempDir()
			},
			wantErr: "no transcript found",
		},
		{
			name:     "transcript without conversation",
			claudeID: importCLIUUID,
			prepare: func(t *testing.T) string {
				config := t.TempDir()
				writeImportCLITranscript(t, config, "/ws/proj", false)
				return config
			},
			wantErr: "holds no conversation",
		},
		{
			name:     "not a uuid",
			claudeID: "not-a-uuid",
			prepare: func(t *testing.T) string {
				return t.TempDir()
			},
			wantErr: "must be a UUID",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLAUDE_CONFIG_DIR", tc.prepare(t))
			err := cmdSessionCLI([]string{"import", tc.claudeID, "--json"}, strings.NewReader(""), &bytes.Buffer{})
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

// An agent asked to bring a conversation into Orbit imports it as its session: the create goes
// through the orchestration gate with the session's id and credential, as session create does,
// and the replay is watched the way a shell watches it. The answer names the workspace it landed in.
func TestSessionCLIImportRunsAsTheCallingSession(t *testing.T) {
	shortenSessionWait(t)
	config := t.TempDir()
	writeImportCLITranscript(t, config, "/ws/proj", true)
	t.Setenv("CLAUDE_CONFIG_DIR", config)

	var importHeaders http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/runner/sessions/import":
			importHeaders = r.Header.Clone()
			_, _ = w.Write([]byte(`{"id":"imported-1","status":"PENDING","workspace":{"id":"ws-1","name":"orbit-prod"}}`))
		case "GET /api/runner/sessions/imported-1/events":
			_, _ = w.Write([]byte(`{"events":[{"seq":1,"type":"user","payload":{"text":"hello"},"ts":"2026-09-15T10:00:00Z"}],"hasMore":false}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv("ORBIT_AGENT_ID", "")

	var out bytes.Buffer
	if err := cmdSessionCLI([]string{"import", importCLIUUID, "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if importHeaders == nil {
		t.Fatal("the import was never posted")
	}
	if got := importHeaders.Get("X-Orbit-Session-Id"); got != "caller-session" {
		t.Errorf("X-Orbit-Session-Id = %q, want the calling session", got)
	}
	if got := importHeaders.Get("X-Orbit-Session-Token"); got != "session-token" {
		t.Errorf("X-Orbit-Session-Token = %q, want the session's credential", got)
	}
	if got := out.String(); !strings.Contains(got, `"orbit-prod"`) {
		t.Errorf("output %q does not name the workspace the import landed in", got)
	}
}

// A session whose account has orchestration off has no session verbs at all, import among them:
// refused locally, before anything is posted.
func TestSessionCLIImportInsideASessionNeedsOrchestration(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv("ORBIT_AGENT_ID", "")
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())

	err := cmdSessionCLI([]string{"import", importCLIUUID, "--json"}, strings.NewReader(""), &bytes.Buffer{})
	if err == nil || err.Error() != orchestrationOffMsg {
		t.Fatalf("error = %v, want the orchestration-off refusal", err)
	}
}

// `capabilities --json` offers `orbit session import` wherever it runs: to a session with the
// orchestration grant, beside create, and headless, with the description the machine's credential
// answers for. A session without the grant is offered no session verb, import included.
func TestSessionImportIsAdvertisedWhereItRuns(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envServiceToken, "")
	t.Setenv("ORBIT_AGENT_ID", "")
	// A whole document is too long to read in a failure; its ids are the part that matters.
	advertisedIDs := func(doc cliCapabilitiesDocument) string {
		ids := make([]string, 0, len(doc.Capabilities))
		for _, capability := range doc.Capabilities {
			ids = append(ids, capability.ID)
		}
		return strings.Join(ids, ", ")
	}

	t.Setenv(envMCPOrchestration, "true")
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	inSession := buildCLICapabilities("/opt/orbit")
	capability := sessionCLICapabilityByID(inSession.Capabilities, "session_import")
	if capability == nil {
		t.Fatalf("a session with the orchestration grant is not offered `orbit session import`. Advertised: %s",
			advertisedIDs(inSession))
	}
	if !strings.Contains(capability.Description, "this machine") {
		t.Errorf("in-session session_import description = %q, want the one that says where the transcript is read", capability.Description)
	}

	t.Setenv(envMCPOrchestration, "")
	withoutGrant := buildCLICapabilities("/opt/orbit")
	if capability := sessionCLICapabilityByID(withoutGrant.Capabilities, "session_import"); capability != nil {
		t.Errorf("a session without the orchestration grant is offered `orbit session import`: %#v", capability)
	}

	// Headless (launchd/cron): the runner credential reaches `import` (runnerCredentialActions), so
	// the document offers it — with the narrower description that credential answers for. The
	// orchestration env flag is deliberately varied: it alone never decides what a headless process
	// may run.
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envOrchestrationToken, "")
	for _, allow := range []string{"", "true"} {
		t.Setenv(envMCPOrchestration, allow)
		headless := buildCLICapabilities("/opt/orbit")
		capability := sessionCLICapabilityByID(headless.Capabilities, "session_import")
		if capability == nil {
			t.Fatalf("`orbit session import` is missing headless (allow=%q). Advertised: %s",
				allow, advertisedIDs(headless))
		}
		if got, want := capability.Description, headlessActionDescription["import"]; got != want {
			t.Errorf("headless session_import description = %q, want %q", got, want)
		}
	}
}
