package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenItemHandOverMCPDescriptorIsCoordinatorOnlyAndCLIExempt(t *testing.T) {
	for _, descriptors := range [][]map[string]interface{}{
		toolDescriptors(false, false),
		toolDescriptors(true, true),
	} {
		if !hasMCPTool(descriptors, "open_item_hand_over") {
			t.Fatal("open_item_hand_over missing from the tools")
		}
		props := mcpToolProps(descriptors, "open_item_hand_over")
		if len(props) != 3 {
			t.Fatalf("open_item_hand_over properties = %#v", props)
		}
		for _, want := range []string{"projectId", "itemId", "note"} {
			if _, ok := props[want]; !ok {
				t.Fatalf("open_item_hand_over does not take %q: %#v", want, props)
			}
		}
		if got := mcpToolRequired(t, descriptors, "open_item_hand_over"); strings.Join(got, ",") != "projectId,itemId,note" {
			t.Fatalf("open_item_hand_over required = %#v", got)
		}
		description := mcpToolDescription(descriptors, "open_item_hand_over")
		for _, want := range []string{"OWNER", "HANDED_OVER", "2000", "coordinator"} {
			if !strings.Contains(description, want) {
				t.Fatalf("open_item_hand_over description does not mention %q: %q", want, description)
			}
		}
	}
	if reason, ok := cliParityExemptTools["open_item_hand_over"]; !ok || reason == "" {
		t.Fatal("open_item_hand_over must be explicitly CLI/MCP parity-exempt")
	}
}

func TestOpenItemHandOverPostsNoteAsCallingSession(t *testing.T) {
	var method, path, session string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		session = r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"itemId":"34Y7Utvsd47A14DjMzIzD","assignee":"OWNER",` +
			`"assigneeReason":"HANDED_OVER","handoverNote":"the baseline is not mine"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "34Y7Myo7G89Vk0fVpelbt"}
	res := mcp.callTool("open_item_hand_over", map[string]interface{}{
		"projectId": "34Y7My8sqhKLWtmCQYv1l",
		"itemId":    "34Y7Utvsd47A14DjMzIzD",
		"note":      "  the baseline is not mine  ",
	})
	if res["isError"] == true {
		t.Fatalf("open_item_hand_over returned an error: %#v", res["content"])
	}
	if method != http.MethodPost ||
		path != "/api/runner/projects/34Y7My8sqhKLWtmCQYv1l/open-items/34Y7Utvsd47A14DjMzIzD/hand-over" {
		t.Fatalf("open_item_hand_over hit %s %s", method, path)
	}
	if session != "34Y7Myo7G89Vk0fVpelbt" {
		t.Fatalf("open_item_hand_over session header = %q", session)
	}
	if body["note"] != "the baseline is not mine" || len(body) != 1 {
		t.Fatalf("open_item_hand_over sent %#v", body)
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "account owner") || !strings.Contains(text, `"HANDED_OVER"`) {
		t.Fatalf("open_item_hand_over result does not describe the committed hand-over: %q", text)
	}
}

func TestOpenItemHandOverRequiresProjectItemAndNote(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("open_item_hand_over reached the server without required input")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "session"}
	for _, args := range []map[string]interface{}{
		{"itemId": "item", "note": "reason"},
		{"projectId": "project", "note": "reason"},
		{"projectId": "project", "itemId": "item"},
		{"projectId": "project", "itemId": "item", "note": " \n\t "},
	} {
		if res := mcp.callTool("open_item_hand_over", args); res["isError"] != true {
			t.Fatalf("open_item_hand_over accepted %#v", args)
		}
	}
}

func TestOpenItemHandOverPassesServerRefusalThrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"OPEN_ITEM_HAND_OVER_RACE","message":"the item changed",` +
			`"statusCode":409}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "session"}
	res := mcp.callTool("open_item_hand_over", map[string]interface{}{
		"projectId": "project", "itemId": "item", "note": "reason",
	})
	if res["isError"] != true {
		t.Fatalf("a refused hand-over was reported as done: %#v", res["content"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "OPEN_ITEM_HAND_OVER_RACE") || !strings.Contains(text, "409") {
		t.Fatalf("hand-over refusal was hidden: %q", text)
	}
}
