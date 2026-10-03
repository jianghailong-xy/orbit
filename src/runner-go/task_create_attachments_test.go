package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestMCPTaskCreateDeclaresAttachmentIDs(t *testing.T) {
	descriptors := toolDescriptors(false, false)
	batch := mcpToolProps(descriptors, "task_create_batch")
	items := batch["tasks"].(map[string]interface{})["items"].(map[string]interface{})
	for name, props := range map[string]map[string]interface{}{
		"single": mcpToolProps(descriptors, "task_create"),
		"batch":  items["properties"].(map[string]interface{}),
	} {
		prop, ok := props["attachmentIds"].(map[string]interface{})
		if !ok || prop["type"] != "array" {
			t.Fatalf("%s attachmentIds schema = %#v", name, props["attachmentIds"])
		}
		item, _ := prop["items"].(map[string]interface{})
		if item["type"] != "string" {
			t.Fatalf("%s attachment id schema = %#v", name, item)
		}
	}
}

func TestMCPTaskCreateCarriesAttachmentsThroughApproval(t *testing.T) {
	for _, status := range []string{"ALLOWED", "DENIED"} {
		t.Run(status, func(t *testing.T) {
			var approvedInput, createdBody map[string]interface{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/approvals"):
					var body map[string]interface{}
					_ = json.NewDecoder(r.Body).Decode(&body)
					approvedInput, _ = body["input"].(map[string]interface{})
					_, _ = w.Write([]byte(`{"id":"approval-1"}`))
				case strings.Contains(r.URL.Path, "/approvals/"):
					_ = json.NewEncoder(w).Encode(map[string]string{"status": status})
				case r.Method == http.MethodPost && r.URL.Path == "/api/runner/tasks":
					_ = json.NewDecoder(r.Body).Decode(&createdBody)
					_, _ = w.Write([]byte(`{"id":"created-task"}`))
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer srv.Close()
			ids := []interface{}{"attachment-1", "attachment-2"}
			mcp := &mcpServer{agentID: "agent-1", sessionID: "session-1", t: NewTransport(srv.URL, "tok")}
			result := mcp.callTool("task_create", map[string]interface{}{
				"title": "Implement the mock", "attachmentIds": ids,
				"completionCriterion": "EVIDENCE_JUDGMENT",
			})
			if result["isError"] == true {
				t.Fatalf("task_create failed: %#v", result)
			}
			if !reflect.DeepEqual(approvedInput["attachmentIds"], ids) {
				t.Fatalf("approval input = %#v", approvedInput)
			}
			if status == "DENIED" {
				if createdBody != nil {
					t.Fatalf("declined task was created: %#v", createdBody)
				}
			} else if !reflect.DeepEqual(createdBody["attachmentIds"], ids) {
				t.Fatalf("create body = %#v", createdBody)
			}
		})
	}
}

func TestMCPTaskCreateBatchPreservesEachItemsAttachments(t *testing.T) {
	for _, dryRun := range []bool{false, true} {
		t.Run(map[bool]string{false: "create", true: "dry run"}[dryRun], func(t *testing.T) {
			var previewBody, createBody map[string]interface{}
			approvals := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
					_ = json.NewDecoder(r.Body).Decode(&previewBody)
					_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":0}`))
				case strings.Contains(r.URL.Path, "/approvals"):
					approvals++
					_, _ = w.Write([]byte(`{"id":"approval-1","status":"ALLOWED"}`))
				case r.Method == http.MethodPost && r.URL.Path == "/api/runner/tasks/batch-create":
					_ = json.NewDecoder(r.Body).Decode(&createBody)
					_, _ = w.Write([]byte(`[{"id":"task-1"},{"id":"task-2"}]`))
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer srv.Close()
			ids := []interface{}{"attachment-1"}
			mcp := &mcpServer{agentID: "agent-1", sessionID: "session-1", t: NewTransport(srv.URL, "tok")}
			result := mcp.callTool("task_create_batch", map[string]interface{}{
				"dryRun": dryRun,
				"tasks": []interface{}{
					map[string]interface{}{"title": "With inputs", "attachmentIds": ids, "completionCriterion": "EVIDENCE_JUDGMENT"},
					map[string]interface{}{"title": "Without inputs", "completionCriterion": "EVIDENCE_JUDGMENT"},
				},
			})
			if result["isError"] == true {
				t.Fatalf("task_create_batch failed: %#v", result)
			}
			bodies := []map[string]interface{}{createBody}
			if dryRun {
				if createBody["dryRun"] != true || approvals != 0 || previewBody != nil {
					t.Fatalf("dry run lost its flag or requested approval: %#v, approvals=%d", createBody, approvals)
				}
			} else {
				bodies = append(bodies, previewBody)
			}
			for _, body := range bodies {
				items, _ := body["tasks"].([]interface{})
				if len(items) != 2 {
					t.Fatalf("batch body = %#v", body)
				}
				if !reflect.DeepEqual(items[0].(map[string]interface{})["attachmentIds"], ids) {
					t.Fatalf("first item lost attachments: %#v", items[0])
				}
				if _, ok := items[1].(map[string]interface{})["attachmentIds"]; ok {
					t.Fatalf("second item gained attachments: %#v", items[1])
				}
			}
		})
	}
}
