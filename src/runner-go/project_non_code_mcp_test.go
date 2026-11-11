package main

import (
	"net/http"
	"strings"
	"testing"
)

// The non-code mark goes straight to the server as the boolean it is — set and cleared the same
// way, with the calling session on the request so the server records the coordinator who wrote it —
// and asks nobody first: it is not a merge check.
func TestMCPProjectUpdateForwardsTheNonCodeMark(t *testing.T) {
	for _, value := range []bool{true, false} {
		srv, hits, _, written := mergeCheckServer(t, `{"status":"ALLOWED"}`)
		mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
		res := mcp.callTool("project_update", map[string]interface{}{"projectId": "proj-1", "nonCode": value})
		if res["isError"] == true {
			t.Fatalf("project_update returned an error: %#v", res["content"])
		}
		if got, ok := (*written)["nonCode"].(bool); !ok || got != value || len(*written) != 1 {
			t.Fatalf("written = %#v, want nonCode %v alone", *written, value)
		}
		for _, hit := range *hits {
			if strings.Contains(hit, "/approvals") {
				t.Fatalf("the mark asked the owner: %v", *hits)
			}
		}
		if (*hits)[len(*hits)-1] != http.MethodPatch+" /api/runner/projects/proj-1" {
			t.Fatalf("call order = %v", *hits)
		}
	}
}

func TestMCPProjectUpdateRefusesANonBooleanNonCode(t *testing.T) {
	srv, hits, _, _ := mergeCheckServer(t, `{"status":"ALLOWED"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_update", map[string]interface{}{"projectId": "proj-1", "nonCode": "yes"})
	if res["isError"] != true || updatedProject(*hits) {
		t.Fatalf("a string nonCode was not refused: %#v hits=%v", res, *hits)
	}
}
