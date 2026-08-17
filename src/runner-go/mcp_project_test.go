package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// project_get rides no gate: reading the goal you are working towards is not an orchestration
// power, and the session that most needs it — a project coordinator — has no session_* tools.
func TestMCPProjectGetIsPartOfTheBaseTools(t *testing.T) {
	tools := toolDescriptors(false, false)
	if !hasMCPTool(tools, "project_get") {
		t.Fatal("project_get missing from the base tools")
	}
	props := mcpToolProps(tools, "project_get")
	projectID, _ := props["projectId"].(map[string]interface{})
	if projectID["type"] != "string" {
		t.Fatalf("project_get projectId schema = %#v", props["projectId"])
	}
	// One input, and it is required: there is no current-project env to default to.
	if len(props) != 1 {
		t.Fatalf("project_get properties = %#v", props)
	}
	for _, tool := range tools {
		if tool["name"] != "project_get" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		if len(required) != 1 || required[0] != "projectId" {
			t.Fatalf("project_get required = %#v", schema["required"])
		}
	}
	// The tool is only useful if the model can tell it from task_list; the description has to say
	// what it returns and what it deliberately does not.
	for _, tool := range tools {
		if tool["name"] != "project_get" {
			continue
		}
		description, _ := tool["description"].(string)
		for _, want := range []string{"acceptanceCriteria", "instructions", "task_list"} {
			if !strings.Contains(description, want) {
				t.Fatalf("project_get description does not mention %q: %q", want, description)
			}
		}
	}
}

func TestMCPProjectGetReadsTheRunnerProjectRoute(t *testing.T) {
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_get", map[string]interface{}{"projectId": "proj-1"})
	if res["isError"] == true {
		t.Fatalf("project_get returned an error: %#v", res["content"])
	}
	if method != http.MethodGet || path != "/api/runner/projects/proj-1" {
		t.Fatalf("project_get hit %s %s", method, path)
	}
	// The payload reaches the model whole — goal, acceptance criteria, instructions and tallies.
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	for _, want := range []string{"Index the corpus", "Every shard reported", "tasksByStatus"} {
		if !strings.Contains(text, want) {
			t.Fatalf("project_get result does not carry %q: %q", want, text)
		}
	}
}

func TestMCPProjectGetRequiresAProjectID(t *testing.T) {
	mcp := &mcpServer{taskID: "task-1", t: NewTransport("http://127.0.0.1:1", "tok")}
	res := mcp.callTool("project_get", map[string]interface{}{})
	if res["isError"] != true {
		t.Fatalf("project_get without an id isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "projectId is required") {
		t.Fatalf("project_get without an id result = %#v", res)
	}
}

func TestMCPProjectGetReportsTheServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"statusCode":404,"message":"project not found"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_get", map[string]interface{}{"projectId": "proj-1"})
	if res["isError"] != true {
		t.Fatalf("a 404 project read isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "get project failed") || !strings.Contains(text, "404") {
		t.Fatalf("project_get 404 result = %q", text)
	}
}

func TestMCPProjectIDCannotEscapeTheProjectRoute(t *testing.T) {
	mcp := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok")}
	for _, id := range []string{"../sessions", "..%2Fsessions", "a/b"} {
		res := mcp.callTool("project_get", map[string]interface{}{"projectId": id})
		if res["isError"] != true {
			t.Fatalf("project_get(%q) isError = %#v", id, res["isError"])
		}
		content, _ := res["content"].([]map[string]interface{})
		if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "single safe path segment") {
			t.Fatalf("project_get(%q) result = %#v", id, res)
		}
	}
}

// The project surface is one read. A write tool here could let a coordinator restate the goal it
// is judged against, so its absence is a property worth failing on.
func TestMCPExposesNoProjectWriteTools(t *testing.T) {
	for _, tools := range [][]map[string]interface{}{
		toolDescriptors(false, false),
		toolDescriptors(true, true),
	} {
		for _, tool := range tools {
			name, _ := tool["name"].(string)
			if strings.HasPrefix(name, "project_") && name != "project_get" {
				t.Fatalf("unexpected project tool exposed: %q", name)
			}
		}
	}
}
