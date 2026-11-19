package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIntegrationRequestPromotionSchemaAndDoors(t *testing.T) {
	for _, tools := range [][]map[string]interface{}{toolDescriptors(false, false), toolDescriptors(true, true)} {
		if got := strings.Join(mcpToolRequired(t, tools, "integration_request_promotion"), ","); got != "projectId,reason" {
			t.Fatalf("required = %s", got)
		}
		if got := len(mcpToolProps(tools, "integration_request_promotion")); got != 2 {
			t.Fatalf("properties = %d", got)
		}
	}
	for _, door := range []string{"mcp", "cli"} {
		t.Run(door, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/api/runner/projects/project-1/promotions/request" {
					t.Errorf("route = %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("X-Orbit-Session-Id") != "session-1" {
					t.Errorf("session = %s", r.Header.Get("X-Orbit-Session-Id"))
				}
				var body map[string]interface{}
				_ = json.NewDecoder(r.Body).Decode(&body)
				if len(body) != 1 || body["reason"] != "Ship a baseline repair" {
					t.Errorf("body = %#v", body)
				}
				_, _ = w.Write([]byte(`{"promotionRequestId":"request-1","promotionId":null}`))
			}))
			defer srv.Close()
			if door == "mcp" {
				server := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "session-1"}
				res := server.callTool("integration_request_promotion", map[string]interface{}{"projectId": "project-1", "reason": "  Ship a baseline repair  "})
				if res["isError"] == true {
					t.Fatalf("result = %#v", res)
				}
			} else {
				configureCLITestRunner(t, srv.URL)
				t.Setenv("ORBIT_SESSION_ID", "session-1")
				var out bytes.Buffer
				if err := cmdProjectCLI([]string{"request-promotion", "project-1", "--reason", "  Ship a baseline repair  ", "--json"}, strings.NewReader(""), &out); err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(out.String(), `"promotionRequestId":"request-1"`) {
					t.Fatal(out.String())
				}
			}
		})
	}
}

func TestIntegrationRequestPromotionSurfacesRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"code":"INTEGRATION_REQUEST_PROMOTION_COORDINATOR_ONLY","message":"only the current coordinator may request promotion"}`))
	}))
	defer srv.Close()
	server := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "other"}
	result := server.callTool("integration_request_promotion", map[string]interface{}{"projectId": "project-1", "reason": "Ship it"})
	encoded, _ := json.Marshal(result)
	if result["isError"] != true || !strings.Contains(string(encoded), "INTEGRATION_REQUEST_PROMOTION_COORDINATOR_ONLY") {
		t.Fatalf("result = %#v", result)
	}
}
