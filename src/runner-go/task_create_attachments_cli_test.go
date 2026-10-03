package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestTaskCLICreateAttachmentsReachApprovalAndWrite(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want []interface{}
	}{
		{"attachments", []string{"--attachment-id", "upload-1, upload-2", "--attachment-id", "upload-2,upload-3"}, []interface{}{"upload-1", "upload-2", "upload-3"}},
		{"omitted", nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var approval, written map[string]interface{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/approvals/ap1") {
					_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
					return
				}
				var body map[string]interface{}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Errorf("decode body: %v", err)
				}
				switch r.URL.Path {
				case "/api/runner/sessions/session-1/approvals":
					approval, _ = body["input"].(map[string]interface{})
					_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
				case "/api/runner/tasks":
					written = body
					_, _ = w.Write([]byte(`{"id":"created-task"}`))
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
			}))
			defer srv.Close()
			configureCLITestRunner(t, srv.URL)
			t.Setenv("ORBIT_AGENT_ID", "agent-1")
			t.Setenv("ORBIT_SESSION_ID", "session-1")

			args := append([]string{"create", "--title", "Review uploads", "--completion-criterion", "EVIDENCE_JUDGMENT", "--json"}, tc.args...)
			if err := cmdTaskCLI(args, strings.NewReader(""), &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			for stage, body := range map[string]map[string]interface{}{"approval": approval, "write": written} {
				if body == nil {
					t.Fatalf("%s request missing", stage)
				}
				got, present := body["attachmentIds"]
				if tc.want == nil {
					if present {
						t.Fatalf("%s sent attachmentIds when omitted: %#v", stage, got)
					}
				} else if !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("%s attachmentIds = %#v, want %#v", stage, got, tc.want)
				}
			}
		})
	}
}

func TestTaskCLICreateBatchAttachmentsReachPreviewApprovalAndWrite(t *testing.T) {
	var requests []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/approvals/ap1") {
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
			return
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		switch r.URL.Path {
		case "/api/runner/tasks/batch-preview":
			requests = append(requests, body)
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":0}`))
		case "/api/runner/sessions/session-1/approvals":
			input, _ := body["input"].(map[string]interface{})
			requests = append(requests, input)
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
		case "/api/runner/tasks/batch-create":
			requests = append(requests, body)
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_SESSION_ID", "session-1")

	stdin := strings.NewReader(`[{"title":"Review uploads","attachmentIds":["upload-1","upload-2"],"completionCriterion":"EVIDENCE_JUDGMENT"},{"title":"Other work","completionCriterion":"EVIDENCE_JUDGMENT"}]`)
	if err := cmdTaskCLI([]string{"create-batch", "--tasks-file", "-", "--json"}, stdin, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 {
		t.Fatalf("requests = %d, want preview, approval, write", len(requests))
	}
	for i, body := range requests {
		tasks, _ := body["tasks"].([]interface{})
		if len(tasks) != 2 {
			t.Fatalf("request %d tasks = %#v", i, body["tasks"])
		}
		first, _ := tasks[0].(map[string]interface{})
		second, _ := tasks[1].(map[string]interface{})
		if got := first["attachmentIds"]; !reflect.DeepEqual(got, []interface{}{"upload-1", "upload-2"}) {
			t.Fatalf("request %d attachmentIds = %#v", i, got)
		}
		if _, present := second["attachmentIds"]; present {
			t.Fatalf("request %d added attachments to another task", i)
		}
	}
}
