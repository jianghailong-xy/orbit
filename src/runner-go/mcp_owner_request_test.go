package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// A plain session is exactly who needs this tool: any session may file a request, so it must not
// ride the orchestration gate.
func TestRequestOwnerActionIsOfferedWithoutOrchestration(t *testing.T) {
	tools := toolDescriptors(false, false)
	if !hasMCPTool(tools, "request_owner_action") {
		t.Fatal("request_owner_action is missing from the ungated tool list")
	}
	props := mcpToolProps(tools, "request_owner_action")
	for _, want := range []string{
		"kind", "title", "why", "blocksTaskIds", "ifUnanswered", "steps", "secretSpec",
		"options", "recommendedOption", "expiresIn", "clientRequestId",
	} {
		if _, ok := props[want]; !ok {
			t.Fatalf("request_owner_action does not take %q: %#v", want, props)
		}
	}
	kind, _ := props["kind"].(map[string]interface{})
	if got := kind["enum"]; !reflect.DeepEqual(got, []string{"DECISION", "SECRET", "MANUAL_STEP", "CONFIRM", "WIKI_CREATE"}) {
		t.Fatalf("request_owner_action kinds = %#v", got)
	}
	// A WIKI_CREATE carries no title (Orbit writes it), so title cannot be required by the schema.
	var schema map[string]interface{}
	for _, tool := range tools {
		if tool["name"] == "request_owner_action" {
			schema, _ = tool["inputSchema"].(map[string]interface{})
		}
	}
	if got := schema["required"]; !reflect.DeepEqual(got, []string{"kind", "why"}) {
		t.Fatalf("request_owner_action requires %#v", got)
	}
	title, _ := props["title"].(map[string]interface{})
	if desc, _ := title["description"].(string); !strings.Contains(desc, "every kind but WIKI_CREATE") {
		t.Fatalf("title's description does not say WIKI_CREATE leaves it out: %q", desc)
	}
}

// WIKI_CREATE is described with its rules (design §3.6): when it applies, that a search never files
// it, and that Orbit fills in the title and repository.
func TestRequestOwnerActionDescribesWikiCreate(t *testing.T) {
	desc := mcpToolDescription(toolDescriptors(false, false), "request_owner_action")
	for _, want := range []string{
		"WIKI_CREATE to ask the owner to create a wiki",
		"only from a workspace whose repository has no wiki",
		"only when the owner asked for one or this session has something worth a wiki",
		"Never file WIKI_CREATE because a wiki_search found no wiki",
		"Orbit fills in the title and the repository, so give only why and ifUnanswered",
	} {
		if !strings.Contains(desc, want) {
			t.Fatalf("request_owner_action's description does not say %q: %q", want, desc)
		}
	}
}

// A WIKI_CREATE filed with only why and ifUnanswered reaches the server as exactly that: no title.
func TestRequestOwnerActionFilesWikiCreateWithoutTitle(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"id":"34ODbP5CnvulADhPzwXNA","state":"PENDING"}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	args := map[string]interface{}{"kind": "WIKI_CREATE", "why": "The owner asked for a wiki here.", "ifUnanswered": "no wiki"}
	if res := mcp.callTool("request_owner_action", args); res["isError"] == true {
		t.Fatalf("request_owner_action refused a WIKI_CREATE: %#v", res["content"])
	}
	if want := (map[string]interface{}{"kind": "WIKI_CREATE", "why": "The owner asked for a wiki here.", "ifUnanswered": "no wiki"}); !reflect.DeepEqual(body, want) {
		t.Fatalf("request_owner_action sent %#v, want %#v", body, want)
	}
}

func TestRequestOwnerActionDescriptionStatesItsRules(t *testing.T) {
	desc := mcpToolDescription(toolDescriptors(false, false), "request_owner_action")
	for _, want := range []string{
		"only the account owner can DO or PROVIDE",
		"Never ask for a secret in chat",
		"prefer kind SECRET for any credential",
		"does NOT block",
		"arrives later as a turn",
	} {
		if !strings.Contains(desc, want) {
			t.Fatalf("request_owner_action's description does not say %q: %q", want, desc)
		}
	}
}

// One filing per kind, each carrying the fields that kind takes plus the ones every kind shares. The
// body is compared whole, so a field dropped, renamed or added by the mapping fails here.
func TestRequestOwnerActionMapsEveryKindOntoTheFilingRoute(t *testing.T) {
	shared := func(kind string) map[string]interface{} {
		return map[string]interface{}{
			"kind":            kind,
			"title":           "A " + kind + " request",
			"why":             "It unblocks the release.",
			"blocksTaskIds":   []interface{}{"task-4", "task-7"},
			"ifUnanswered":    "nothing ships",
			"clientRequestId": "call-" + kind,
		}
	}
	with := func(base, extra map[string]interface{}) map[string]interface{} {
		for key, value := range extra {
			base[key] = value
		}
		return base
	}
	options := []interface{}{
		map[string]interface{}{"label": "Ship", "description": "goes out today"},
		map[string]interface{}{"label": "Hold"},
	}
	steps := []interface{}{
		map[string]interface{}{"text": "Sign in", "link": "https://example.test/login"},
		map[string]interface{}{"text": "Run the installer", "command": "make install"},
	}
	secretSpec := map[string]interface{}{"name": "Deploy key", "envVar": "DEPLOY_KEY"}

	for _, tc := range []struct {
		kind  string
		extra map[string]interface{}
	}{
		{"DECISION", map[string]interface{}{"options": options, "recommendedOption": float64(0)}},
		{"SECRET", map[string]interface{}{"secretSpec": secretSpec}},
		{"MANUAL_STEP", map[string]interface{}{"steps": steps}},
		{"CONFIRM", map[string]interface{}{}},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			var method, path, session string
			var body map[string]interface{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				method, path = r.Method, r.URL.Path
				session = r.Header.Get("X-Orbit-Session-Id")
				_ = json.NewDecoder(r.Body).Decode(&body)
				_, _ = w.Write([]byte(`{"id":"34ODbP5CnvulADhPzwXNA","state":"PENDING"}`))
			}))
			defer srv.Close()

			mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
			res := mcp.callTool("request_owner_action", with(shared(tc.kind), tc.extra))
			if res["isError"] == true {
				t.Fatalf("request_owner_action returned an error: %#v", res["content"])
			}
			if method != http.MethodPost || path != "/api/runner/owner-requests" {
				t.Fatalf("request_owner_action hit %s %s", method, path)
			}
			if session != "343dlzsYWKo5z8l2M8tsB" {
				t.Fatalf("request_owner_action session header = %q", session)
			}
			if want := with(shared(tc.kind), tc.extra); !reflect.DeepEqual(body, want) {
				t.Fatalf("request_owner_action sent %#v, want %#v", body, want)
			}
			content, _ := res["content"].([]map[string]interface{})
			text, _ := content[0]["text"].(string)
			if !strings.Contains(text, "arrive as a turn") {
				t.Fatalf("the result does not say where the outcome arrives: %q", text)
			}
		})
	}
}

// The server takes an absolute deadline; the tool takes a relative one, and sends only the deadline.
func TestOwnerRequestBodyTurnsExpiresInIntoExpiresAt(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60))
	body, err := ownerRequestBody(map[string]interface{}{
		"kind": "CONFIRM", "title": "Go?", "why": "Release.", "expiresIn": float64(3600),
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if body["expiresAt"] != "2026-11-10T01:00:00Z" {
		t.Fatalf("expiresAt = %#v", body["expiresAt"])
	}
	if _, sent := body["expiresIn"]; sent {
		t.Fatalf("expiresIn travelled to a server that does not take it: %#v", body)
	}

	body, err = ownerRequestBody(map[string]interface{}{"kind": "CONFIRM", "title": "Go?", "why": "Release."}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, sent := body["expiresAt"]; sent {
		t.Fatalf("a request with no expiresIn was given a deadline: %#v", body)
	}
}

func TestRequestOwnerActionRefusesAnIncompleteFiling(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("request_owner_action reached the server without what it needs")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	for _, args := range []map[string]interface{}{
		{"title": "t", "why": "w"},
		{"kind": "CONFIRM", "why": "w"},
		{"kind": "CONFIRM", "title": "t"},
		{"kind": "CONFIRM", "title": "   ", "why": "w"},
		{"kind": "CONFIRM", "title": "t", "why": "w", "expiresIn": float64(0)},
		{"kind": "CONFIRM", "title": "t", "why": "w", "expiresIn": float64(maxOwnerRequestExpiresIn + 1)},
	} {
		if res := mcp.callTool("request_owner_action", args); res["isError"] != true {
			t.Fatalf("request_owner_action accepted %#v", args)
		}
	}
}

// notify used to offer itself for "a decision, a credential, an answer". It is for telling the owner
// something happened; a need goes to the tool that keeps a state and brings the outcome back.
func TestNotifyDescriptionSendsCredentialAndActionNeedsToRequestOwnerAction(t *testing.T) {
	tools := toolDescriptors(false, false)
	desc := mcpToolDescription(tools, "notify")
	for _, want := range []string{
		"only for telling",
		"If you need a credential, or anything else only the owner can do or provide, do not call this tool: use request_owner_action",
	} {
		if !strings.Contains(desc, want) {
			t.Fatalf("notify's description does not say %q: %q", want, desc)
		}
	}
	if strings.Contains(desc, "you need something only they can give") {
		t.Fatalf("notify still offers itself for needs: %q", desc)
	}
	message, _ := mcpToolProps(tools, "notify")["message"].(map[string]interface{})
	if text, _ := message["description"].(string); strings.Contains(text, "what you need") {
		t.Fatalf("notify's message still asks for what you need: %q", text)
	}
}
